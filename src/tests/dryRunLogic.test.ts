/**
 * computeIsDryRun — exhaustive truth table.
 *
 * This is the single decision point that controls whether placeOrder calls
 * Kite or returns a synthetic ACCEPTED. Getting it wrong means either:
 *   (a) silent suppression of real orders the operator INTENDED to place
 *       (loss of opportunity / undetected strategy bug), or
 *   (b) accidental real-money calls when the operator THINKS dry-run is on
 *       (loss of capital).
 *
 * Both modes are catastrophic, so every combination of inputs is pinned here.
 */

import { describe, it, expect } from '@jest/globals';
import { computeIsDryRun } from '../risk/dryRunLogic.js';

describe('computeIsDryRun — full truth table (mode × envFlag × marketOpen)', () => {
  // ── Operator-set 'dry-run' always wins (Design B: no auto-revert) ──────
  it('mode=dry-run, env=false, marketOpen=false → true', () => {
    expect(computeIsDryRun('dry-run', false, false)).toBe(true);
  });
  it('mode=dry-run, env=false, marketOpen=true → true (operator override beats time)', () => {
    expect(computeIsDryRun('dry-run', false, true)).toBe(true);
  });
  it('mode=dry-run, env=true, marketOpen=false → true', () => {
    expect(computeIsDryRun('dry-run', true, false)).toBe(true);
  });
  it('mode=dry-run, env=true, marketOpen=true → true', () => {
    expect(computeIsDryRun('dry-run', true, true)).toBe(true);
  });

  // ── mode='live' + env-driven path ─────────────────────────────────────
  it('mode=live, env=false, marketOpen=false → false (no env flag, no dry-run)', () => {
    expect(computeIsDryRun('live', false, false)).toBe(false);
  });
  it('mode=live, env=false, marketOpen=true → false (live during market)', () => {
    expect(computeIsDryRun('live', false, true)).toBe(false);
  });
  it('mode=live, env=true, marketOpen=false → true (legacy env+time path)', () => {
    expect(computeIsDryRun('live', true, false)).toBe(true);
  });
  it('mode=live, env=true, marketOpen=true → false (env path safety: not during market)', () => {
    expect(computeIsDryRun('live', true, true)).toBe(false);
  });

  // ── Regression guards ────────────────────────────────────────────────
  it('NEVER returns true for (live, false, *)', () => {
    expect(computeIsDryRun('live', false, false)).toBe(false);
    expect(computeIsDryRun('live', false, true)).toBe(false);
  });

  it('NEVER returns true for (live, true, true) — protects the live-during-market invariant', () => {
    // This is the single most safety-critical case: env flag accidentally
    // left on during market hours must NOT silently suppress real orders.
    expect(computeIsDryRun('live', true, true)).toBe(false);
  });

  it('ALWAYS returns true when mode=dry-run regardless of other inputs', () => {
    for (const envFlag of [false, true]) {
      for (const marketOpen of [false, true]) {
        expect(computeIsDryRun('dry-run', envFlag, marketOpen)).toBe(true);
      }
    }
  });
});
