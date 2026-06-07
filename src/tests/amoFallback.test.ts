/**
 * isMarketClosedRejection — pattern matcher truth table.
 *
 * This decides whether the gateway should transparently retry a rejected
 * order as AMO. False positives = we silently convert real rejections
 * (e.g. permission denied) into AMO retries, masking the real cause.
 * False negatives = the operator opted in but the fallback never fires,
 * which is loud and recoverable.
 *
 * Strong bias toward precision: only Kite's exact "try placing an AMO
 * order" suggestion triggers the match. Other variants are tolerated only
 * when they are specifically the market-closed signature.
 */

import { describe, it, expect } from '@jest/globals';
import { isMarketClosedRejection } from '../oms/amoFallback.js';

describe('isMarketClosedRejection — Kite "markets closed, try AMO" detector', () => {
  // ── Real strings observed from Kite ────────────────────────────────────
  it('matches the exact phrase observed on 2026-06-07 manual test', () => {
    expect(isMarketClosedRejection(
      'MIS (intraday) are blocked as the markets are not open for trading today. Try placing an AMO order.',
    )).toBe(true);
  });

  it('matches the [INPUT]-prefixed form returned by OrderManager', () => {
    expect(isMarketClosedRejection(
      '[INPUT] MIS (intraday) are blocked as the markets are not open for trading today. Try placing an AMO order.',
    )).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMarketClosedRejection('TRY PLACING AN AMO ORDER')).toBe(true);
    expect(isMarketClosedRejection('Try Placing An Amo Order')).toBe(true);
  });

  it('matches markets-are-not-open-for-trading on its own', () => {
    // Defensive: future Kite copy might drop the "Try placing an AMO order"
    // suffix on some error variants. The "markets are not open for trading"
    // signature is still specific enough.
    expect(isMarketClosedRejection('CNC orders are blocked — markets are not open for trading')).toBe(true);
  });

  it('matches a slight Kite copy variant ("Try placing AMO order" — no "an")', () => {
    expect(isMarketClosedRejection('Try placing AMO order')).toBe(true);
  });

  // ── Negative cases — must NOT trigger ─────────────────────────────────
  it('does NOT match generic "market is closed" without the AMO suggestion', () => {
    // This phrase appears in unrelated Kite errors (e.g. holiday or
    // segment-specific blocks where AMO would not help). Matching here
    // would silently convert real rejections into AMO retries.
    expect(isMarketClosedRejection('Market is closed')).toBe(false);
    expect(isMarketClosedRejection('The market is closed for this contract')).toBe(false);
  });

  it('does NOT match insufficient margin', () => {
    expect(isMarketClosedRejection(
      'RMS: Insufficient funds. Required margin is 2310620.17 but available is 5000.00',
    )).toBe(false);
  });

  it('does NOT match expired contract', () => {
    expect(isMarketClosedRejection(
      'The instrument you are placing an order for has already expired.',
    )).toBe(false);
  });

  it('does NOT match token / permission errors', () => {
    expect(isMarketClosedRejection('Incorrect `api_key` or `access_token`.')).toBe(false);
    expect(isMarketClosedRejection('Permission denied for this user.')).toBe(false);
  });

  it('does NOT match SL-M F&O blocked (a different INPUT error type)', () => {
    expect(isMarketClosedRejection(
      'Stoploss Market orders (SL-M) are blocked for F&O contracts as they have been discontinued by the exchange.',
    )).toBe(false);
  });

  // ── Edge cases ────────────────────────────────────────────────────────
  it('returns false for null', () => {
    expect(isMarketClosedRejection(null)).toBe(false);
  });
  it('returns false for undefined', () => {
    expect(isMarketClosedRejection(undefined)).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isMarketClosedRejection('')).toBe(false);
  });
  it('returns false for whitespace-only string', () => {
    expect(isMarketClosedRejection('   ')).toBe(false);
  });
});
