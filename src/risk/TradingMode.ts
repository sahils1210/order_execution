import {
  getTradingMode,
  setTradingMode,
  type TradingMode,
} from '../db/database.js';
import { logger } from '../logger.js';
import { alertAsync } from '../alerts/Telegram.js';
import { config } from '../config.js';
import { isMarketOpenIST } from '../utils/marketHours.js';
import { computeIsDryRun } from './dryRunLogic.js';

// =========================================
// TradingMode (Design B) — DB-backed operator-controlled toggle that switches
// the gateway between LIVE (real Kite calls) and DRY-RUN (synthetic responses,
// no Kite calls). Pattern mirrors KillSwitch:
//
//   * State persists in SQLite (table `trading_mode`, single row id=1)
//   * Default 'live' on first DB init
//   * Survives restart — operator MUST flip it back to 'live' after testing
//   * Telegram alert on every transition (audit trail)
//
// IMPORTANT (Design B semantics — see runbook addendum):
//   - There is NO auto-revert at market open. If you switch to 'dry-run' on
//     Sunday and forget to switch back, your strategy will keep firing
//     synthetic orders Monday during market hours. The UI shows a prominent
//     banner whenever mode == 'dry-run' so the operator can't miss it.
//   - Switching TO 'live' takes effect IMMEDIATELY for the next placeOrder
//     call. There is no quiescing or draining — any DRY-RUN orders already
//     accepted stay synthetic forever (they were never at the broker).
//
// Effective mode (used by OrderManager.placeOrder):
//   effectiveMode = controller.getMode() === 'dry-run'  → dry-run
//                || (config.dryRun.outsideHours && market closed) → dry-run
//                || otherwise → live
//
// The env-based legacy path is kept so existing deployments keep working
// even if the DB row hasn't been touched.
// =========================================

class TradingModeController {
  private mode: TradingMode = 'live';
  private reason: string | null = null;
  private source: string | null = null;
  private updatedAt: string | null = null;
  /**
   * Callback registered by `index.ts` after WebSocket init so transitions
   * push to the UI in real-time without coupling this module to socket.io.
   */
  emitStatusUpdate: () => void = () => {};

  initialize(): void {
    const row = getTradingMode();
    this.mode = row.mode;
    this.reason = row.reason;
    this.source = row.source;
    this.updatedAt = row.updatedAt;
    if (this.mode === 'dry-run') {
      logger.warn('Trading mode is DRY-RUN on startup', { reason: this.reason, source: this.source });
      alertAsync(
        'warn',
        'Trading mode: DRY-RUN on startup',
        `Reason: ${this.reason ?? 'unknown'}\nSource: ${this.source ?? 'unknown'}\n\nOrders will be SIMULATED, not sent to Kite. Switch via /admin/mode or the UI.`,
      );
    }
  }

  /** Raw operator-set mode (not influenced by env flag or market hours). */
  getMode(): TradingMode {
    return this.mode;
  }

  /** Status block for /admin/mode and the UI panel. */
  getStatus(): {
    mode: TradingMode;
    effectiveActive: boolean;     // true iff orders will be DRY-RUN right now
    envFlag: boolean;
    marketOpen: boolean;
    reason: string | null;
    source: string | null;
    updatedAt: string | null;
  } {
    const marketOpen = isMarketOpenIST();
    return {
      mode: this.mode,
      effectiveActive: computeIsDryRun(this.mode, config.dryRun.outsideHours, marketOpen),
      envFlag: config.dryRun.outsideHours,
      marketOpen,
      reason: this.reason,
      source: this.source,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Effective dry-run decision used by OrderManager.placeOrder. Combines
   * operator toggle (Design B) with the legacy env-driven path so both
   * code paths converge into a single boolean.
   */
  isDryRunActive(): boolean {
    return computeIsDryRun(this.mode, config.dryRun.outsideHours, isMarketOpenIST());
  }

  /**
   * Operator action: switch mode. Persists to DB FIRST (KillSwitch pattern),
   * then updates in-memory state. If DB write fails, we crash the process so
   * the next boot reads canonical DB state — never trust an in-memory diverge.
   */
  setMode(next: TradingMode, reason: string, source: string): { changed: boolean; from: TradingMode; to: TradingMode } {
    const prev = this.mode;
    if (prev === next) {
      logger.info('Trading mode toggle requested but already in that mode', { mode: next, reason, source });
      return { changed: false, from: prev, to: next };
    }

    try {
      setTradingMode(next, reason, source);
    } catch (err) {
      const errStr = String(err instanceof Error ? err.stack : err);
      logger.error('FATAL: trading_mode DB write failed — halting process to force restart', {
        from: prev, to: next, source, error: errStr,
      });
      alertAsync(
        'critical',
        'Trading mode persistence FAILED',
        `DB write threw: ${errStr}\nFrom: ${prev}\nTo: ${next}\nSource: ${source}`,
      );
      process.exit(1);
    }

    this.mode = next;
    this.reason = reason;
    this.source = source;
    this.updatedAt = new Date().toISOString();

    const transitionLabel = next === 'dry-run' ? 'LIVE → DRY-RUN' : 'DRY-RUN → LIVE';
    const icon = next === 'dry-run' ? '🧪' : '🔴';
    logger.warn(`${icon} Trading mode switched: ${transitionLabel}`, { reason, source });
    alertAsync(
      next === 'live' ? 'critical' : 'warn',
      `Trading mode → ${next.toUpperCase()}`,
      `${transitionLabel}\nReason: ${reason}\nBy: ${source}\n\n${
        next === 'live'
          ? 'Orders are now REAL — they will be sent to Kite.'
          : 'Orders are SIMULATED — no Kite calls until switched back.'
      }`,
    );

    this.emitStatusUpdate();

    return { changed: true, from: prev, to: next };
  }
}

export const tradingMode = new TradingModeController();
