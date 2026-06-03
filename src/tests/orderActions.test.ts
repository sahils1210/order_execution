/**
 * orderActions route — HTTP status mapping tests.
 *
 * Background: prior to 2026-06-03, the DELETE /order/:id and PATCH /order/:id
 * routes returned HTTP 502 for ANY failure result. This conflated three very
 * different failure modes:
 *
 *   1. Broker refused the cancel/modify (e.g. "order already cancelled") —
 *      should be 4xx (client should NOT retry without changing inputs).
 *   2. Token expired during the call — should be 401 (caller refreshes).
 *   3. Gateway couldn't reach Kite (timeout, connect-failed) — should be 502
 *      (caller may retry with backoff).
 *
 * Conflating these caused 100-ALGO's `kite_service` to log every legitimate
 * Kite-side refusal as "Gateway cancel order failed" and (per its retry policy)
 * fire duplicate cancel attempts at the gateway, which got rejected again, etc.
 *
 * These tests pin the new mapping so a future refactor can't silently regress
 * the contract. They cover the pure `httpStatusForErrorKind` function — the
 * route handler integration is exercised in the end-to-end suite.
 */

import { describe, it, expect } from '@jest/globals';
import { httpStatusForErrorKind } from '../routes/httpStatusMap.js';

describe('httpStatusForErrorKind', () => {
  // ── 401: token problems ────────────────────────────────────────────────
  it('maps TOKEN → 401 (token expired/invalid)', () => {
    expect(httpStatusForErrorKind('TOKEN')).toBe(401);
  });

  // ── 409: broker refused (client should not retry without changes) ─────
  it('maps REJECTED → 409 (Kite OrderException, e.g. order already cancelled)', () => {
    expect(httpStatusForErrorKind('REJECTED')).toBe(409);
  });

  it('maps INPUT → 409 (Kite InputException, e.g. bad parameters)', () => {
    expect(httpStatusForErrorKind('INPUT')).toBe(409);
  });

  it('maps PERMISSION → 409 (Kite PermissionException, user not allowed)', () => {
    expect(httpStatusForErrorKind('PERMISSION')).toBe(409);
  });

  it('maps GENERAL → 409 (Kite GeneralException, unknown Kite-side problem)', () => {
    expect(httpStatusForErrorKind('GENERAL')).toBe(409);
  });

  // ── 502: genuine upstream failure (caller may retry) ──────────────────
  it('maps TIMEOUT → 502 (gateway-side timeout race)', () => {
    expect(httpStatusForErrorKind('TIMEOUT')).toBe(502);
  });

  it('maps CONNECT_FAILED → 502 (DNS/refused before Kite)', () => {
    expect(httpStatusForErrorKind('CONNECT_FAILED')).toBe(502);
  });

  it('maps GATEWAY_5XX → 502 (Kite returned 5xx)', () => {
    expect(httpStatusForErrorKind('GATEWAY_5XX')).toBe(502);
  });

  it('maps MIDFLIGHT_RESET → 502 (connection lost mid-flight)', () => {
    expect(httpStatusForErrorKind('MIDFLIGHT_RESET')).toBe(502);
  });

  // ── 502: defensive default for pre-Kite failures ──────────────────────
  it('maps null → 502 (pre-Kite failure, e.g. unknown account)', () => {
    expect(httpStatusForErrorKind(null)).toBe(502);
  });

  it('maps undefined → 502 (errorKind field absent on legacy results)', () => {
    expect(httpStatusForErrorKind(undefined)).toBe(502);
  });

  // ── Regression: ensure no kind returns the old blanket 502 by accident
  // for a client-actionable error. If this test starts failing because a new
  // kind was added, decide explicitly whether it's broker-refusal (→ 409) or
  // upstream-outage (→ 502) and update the test alongside the mapping.
  it('every broker-refusal kind returns 4xx (not 502)', () => {
    const brokerRefusalKinds = ['REJECTED', 'INPUT', 'PERMISSION', 'GENERAL', 'TOKEN'] as const;
    for (const k of brokerRefusalKinds) {
      const status = httpStatusForErrorKind(k);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  it('every upstream-failure kind returns 5xx', () => {
    const upstreamKinds = ['TIMEOUT', 'CONNECT_FAILED', 'GATEWAY_5XX', 'MIDFLIGHT_RESET'] as const;
    for (const k of upstreamKinds) {
      expect(httpStatusForErrorKind(k)).toBe(502);
    }
  });
});
