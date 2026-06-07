// =========================================
// dryRunLogic — the pure decision function that maps
//   (operator mode, env flag, market-open) → boolean "dry-run active?"
//
// Lives in its own dependency-free file so jest can test the safety-critical
// truth table without importing the SQLite-backed database module via
// TradingMode.ts. Same pattern as routes/httpStatusMap.ts.
// =========================================

export type TradingMode = 'live' | 'dry-run';

/**
 * Returns true iff orders should be DRY-RUN (no Kite call) right now.
 *
 * Truth table:
 *   mode='dry-run'                       → true    (operator override wins)
 *   mode='live' + envFlag=true + closed  → true    (legacy env+time path)
 *   mode='live' + envFlag=true + open    → false   (safety: not while open)
 *   mode='live' + envFlag=false          → false   (live)
 *
 * IMPORTANT: there is no path where `mode='dry-run'` is ignored. Once the
 * operator flips to 'dry-run' via the UI or POST /admin/mode, every order is
 * simulated until they explicitly flip back. There is NO auto-revert at
 * market open (this is Design B semantics, intentional).
 */
export function computeIsDryRun(mode: TradingMode, envFlag: boolean, marketOpen: boolean): boolean {
  if (mode === 'dry-run') return true;
  return envFlag && !marketOpen;
}
