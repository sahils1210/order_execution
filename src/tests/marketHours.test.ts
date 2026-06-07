/**
 * marketHours — boundary tests for the IST NSE session check.
 *
 * The dry-run feature uses this function as its safety gate: dry-run mode is
 * impossible while the market is open. A bug here would allow real Kite calls
 * to be silently swallowed (think "test orders" that never reach Kite during
 * what was actually a live session). So these tests pin every boundary.
 *
 * All dates are built with `+05:30` offset (explicit IST) so the test is
 * deterministic regardless of the host machine's timezone.
 */

import { describe, it, expect } from '@jest/globals';
import { isMarketOpenIST } from '../utils/marketHours.js';

const ist = (iso: string): Date => new Date(`${iso}+05:30`);

describe('isMarketOpenIST', () => {
  // ── Weekday boundaries (Wednesday 2026-06-03) ────────────────────────────
  it('returns false at 09:14:59 IST (one second before open)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T09:14:59'))).toBe(false);
  });

  it('returns true at 09:15:00 IST (open bell, inclusive)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T09:15:00'))).toBe(true);
  });

  it('returns true at 12:30:00 IST (mid-session)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T12:30:00'))).toBe(true);
  });

  it('returns true at 15:30:00 IST (close bell, inclusive)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T15:30:00'))).toBe(true);
  });

  it('returns false at 15:31:00 IST (one minute after close)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T15:31:00'))).toBe(false);
  });

  it('returns false at 00:00:00 IST (overnight)', () => {
    expect(isMarketOpenIST(ist('2026-06-03T00:00:00'))).toBe(false);
  });

  // ── Weekend ──────────────────────────────────────────────────────────────
  it('returns false on Saturday during session hours', () => {
    expect(isMarketOpenIST(ist('2026-06-06T12:00:00'))).toBe(false);
  });

  it('returns false on Sunday during session hours', () => {
    expect(isMarketOpenIST(ist('2026-06-07T12:00:00'))).toBe(false);
  });

  // ── Day-of-week boundary (Friday → Saturday) ─────────────────────────────
  it('returns true Friday 15:30:00 IST', () => {
    expect(isMarketOpenIST(ist('2026-06-05T15:30:00'))).toBe(true);
  });

  it('returns false Friday 15:30:01 IST (post-close)', () => {
    expect(isMarketOpenIST(ist('2026-06-05T15:30:01'))).toBe(false);
  });

  it('returns false Saturday 09:15:00 IST (weekend even if "open time")', () => {
    expect(isMarketOpenIST(ist('2026-06-06T09:15:00'))).toBe(false);
  });

  // ── UTC-vs-IST handling: a 04:00 UTC value is 09:30 IST (open) ──────────
  it('correctly classifies UTC inputs by shifting to IST', () => {
    // 2026-06-03 04:00 UTC = 09:30 IST (Wednesday, market open)
    expect(isMarketOpenIST(new Date('2026-06-03T04:00:00Z'))).toBe(true);
    // 2026-06-03 10:30 UTC = 16:00 IST (Wednesday, market closed)
    expect(isMarketOpenIST(new Date('2026-06-03T10:30:00Z'))).toBe(false);
    // 2026-06-03 03:00 UTC = 08:30 IST (Wednesday, pre-open)
    expect(isMarketOpenIST(new Date('2026-06-03T03:00:00Z'))).toBe(false);
  });

  // ── Defensive: no-arg call returns a boolean ─────────────────────────────
  it('returns a boolean when called with no argument (uses current time)', () => {
    expect(typeof isMarketOpenIST()).toBe('boolean');
  });
});
