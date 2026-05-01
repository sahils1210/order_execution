import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  upsertPositionRow,
  updatePositionRow,
  updateLastPrice,
  getPositionById,
  listPositionsForDate,
  insertPositionFill,
  getLastCumulativeFilled,
  getCumulativeFillValue,
  withTransaction,
  type PositionRow,
} from '../db/database.js';
import { emitPositionUpdate, emitPnlUpdate } from '../websocket.js';
import { killSwitch } from '../risk/KillSwitch.js';
import { alertAsync } from '../alerts/Telegram.js';
import type { OrderLog } from '../types.js';

// =========================================
// PositionManager — single-process, in-memory state mirrored to SQLite.
//
// Responsibilities:
//   1. Apply fills idempotently from postbacks (and reconciliation).
//   2. Maintain per-(account, exchange, symbol, date) position state.
//   3. Compute realized + unrealized PnL.
//   4. Enforce risk limits → trigger kill switch on breach.
//   5. Emit Socket.IO events on every change.
//   6. Recover from SQLite on restart.
//
// PnL math (signed-quantity model):
//   Let net = signed netQuantity (long > 0, short < 0)
//   Let avg = average cost basis of the OPEN portion
//   Incoming fill: signed delta `d` (BUY=+, SELL=−), price `p`
//
//   If sign(d) == sign(net) OR net == 0:
//       — extending the position; recompute weighted avg
//       newQty = net + d
//       newAvg = (|net|*avg + |d|*p) / |newQty|
//
//   If sign(d) != sign(net):
//       — closing all or part of position; realise PnL on the closed portion
//       closedQty = min(|d|, |net|)
//       realizedDelta = (p - avg) * closedQty * (sign(net))
//                       — positive when we sold higher than bought (long)
//                         or bought lower than sold (short)
//       remainingQty = net + d
//       If sign(remainingQty) != sign(net): position flipped → reset avg=p
//       Else: avg stays the same (still on residual long/short cost basis)
//       If remainingQty == 0: avg=0
//
// Unrealized PnL:
//   = (lastPrice - avg) * netQuantity     (signed; positive if profitable)
//   = 0 when net == 0 or lastPrice null
// =========================================

export interface PositionView {
  accountId: string;
  exchange: string;
  tradingsymbol: string;
  tradeDate: string;
  netQuantity: number;
  averagePrice: number;
  lastPrice: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalBuyQty: number;
  totalSellQty: number;
  updatedAt: string;
}

export interface PnlSummary {
  asOf: string;
  tradeDate: string;
  totalRealized: number;
  totalUnrealized: number;
  totalPnl: number;
  totalExposure: number;
  perSymbol: PositionView[];
  limits: {
    maxDailyLoss: number;
    maxDailyProfit: number;
    maxPositionPerSymbol: number;
    maxTotalExposure: number;
  };
}

export interface ApplyFillInput {
  /** OrderLog row whose fill we are applying. */
  orderLog: OrderLog;
  /** filled_quantity from postback (cumulative for this order). */
  filledQuantity: number;
  /** average_price from postback (avg fill price for this order). */
  averagePrice: number;
  /** Source postback row id, for idempotency. */
  postbackEventId: number | null;
}

class PositionManager {
  /** Last risk-eval timestamp per (accountId|symbol). Throttles re-checks. */
  private lastEval = new Map<string, number>();
  /** Cached IST trade-date (YYYY-MM-DD) for the current process. Recomputed lazily. */
  private cachedTradeDate: string | null = null;
  private cachedTradeDateMs = 0;

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Returns the current IST trade-date (YYYY-MM-DD). */
  currentTradeDate(): string {
    const now = Date.now();
    if (this.cachedTradeDate && now - this.cachedTradeDateMs < 60_000) {
      return this.cachedTradeDate;
    }
    // IST is UTC+5:30 — shift then take ISO date portion.
    const ist = new Date(now + 5.5 * 3600 * 1000);
    const iso = ist.toISOString();
    this.cachedTradeDate = iso.slice(0, 10);
    this.cachedTradeDateMs = now;
    return this.cachedTradeDate;
  }

  /**
   * Apply a fill from a postback. Idempotent on (postbackEventId, orderLogId).
   *
   * Strategy:
   *   - Compute the *delta* between this postback's filled_quantity and the
   *     cumulative we have already booked for this orderLogId.
   *   - If delta == 0 → no-op.
   *   - Else: open a tx, apply position math, insert fill row, commit.
   *   - Emit position:update + pnl:update.
   *   - Run risk check (may engage kill switch).
   */
  applyFill(input: ApplyFillInput): void {
    if (!config.positions.enabled) return;

    const { orderLog, filledQuantity, averagePrice, postbackEventId } = input;

    if (filledQuantity <= 0 || !Number.isFinite(filledQuantity)) return;
    if (!Number.isFinite(averagePrice) || averagePrice <= 0) {
      logger.warn('Position fill ignored: invalid average_price', {
        orderLogId: orderLog.id, averagePrice, filledQuantity,
      });
      return;
    }

    const previousCumulative = getLastCumulativeFilled(orderLog.id);
    const deltaQty = filledQuantity - previousCumulative;
    if (deltaQty <= 0) {
      // Already applied or out-of-order postback for the same order. Safe no-op.
      return;
    }

    if (deltaQty > orderLog.quantity) {
      logger.error('Position fill rejected: delta exceeds order quantity', {
        orderLogId: orderLog.id, deltaQty, orderQuantity: orderLog.quantity,
      });
      return;
    }

    // CRITICAL: Kite's `average_price` is the avg of the WHOLE order so far,
    // not the avg of this increment. Derive the marginal fill price from the
    // delta in cumulative value, otherwise weighted-avg cost basis drifts on
    // multi-fill orders and PnL is silently wrong.
    const priorValue   = getCumulativeFillValue(orderLog.id);
    const newCumValue  = filledQuantity * averagePrice;
    const marginalValue = newCumValue - priorValue;
    let marginalPrice  = marginalValue / deltaQty;
    if (!Number.isFinite(marginalPrice) || marginalPrice <= 0) {
      // Defensive fallback — if the broker sends inconsistent cumulative values
      // (rare; can happen with PARTIAL → CANCELLED + new order_id), fall back
      // to the cumulative average. Better a small drift than rejecting the fill.
      logger.warn('Marginal price derivation produced non-positive — falling back to cumulative avg', {
        orderLogId: orderLog.id, priorValue, newCumValue, deltaQty, marginalPrice,
      });
      marginalPrice = averagePrice;
    }

    const tradeDate = this.currentTradeDate();
    const accountId = orderLog.accountId;
    const signedDelta = orderLog.transactionType === 'BUY' ? deltaQty : -deltaQty;

    let updatedView: PositionView | null = null as PositionView | null;

    try {
      withTransaction(() => {
        const pos = upsertPositionRow(
          accountId,
          orderLog.exchange,
          orderLog.tradingsymbol,
          tradeDate,
        );

        const { newPosition, realizedDelta } = applyDelta(pos, signedDelta, marginalPrice);

        const ins = insertPositionFill({
          positionId: pos.id,
          orderLogId: orderLog.id,
          postbackEventId,
          kiteOrderId: orderLog.kiteOrderId,
          transactionType: orderLog.transactionType,
          deltaQuantity: signedDelta,
          fillPrice: marginalPrice,
          cumulativeFilled: filledQuantity,
          realizedDelta,
        });

        if (!ins.applied) {
          // Concurrent duplicate — bail without writing the position update.
          logger.debug('Position fill dedup hit — skipping update', {
            orderLogId: orderLog.id, postbackEventId,
          });
          return;
        }

        updatePositionRow(newPosition);
        updatedView = toView(newPosition);
      });
    } catch (err) {
      logger.error('Position fill apply failed', {
        orderLogId: orderLog.id,
        symbol: orderLog.tradingsymbol,
        error: String(err instanceof Error ? err.stack : err),
      });
      return;
    }

    if (!updatedView) return;

    logger.info('Position updated', {
      account: updatedView.accountId,
      symbol: updatedView.tradingsymbol,
      net: updatedView.netQuantity,
      avg: round(updatedView.averagePrice),
      realized: round(updatedView.realizedPnl),
      unrealized: round(updatedView.unrealizedPnl),
    });

    // Emit + risk-check after the transaction commits.
    emitPositionUpdate(updatedView);
    this.emitPnlSummary();
    this.evaluateRisk(updatedView);
  }

  /**
   * Update the last traded price for a symbol on the current trade-date.
   * Recomputes unrealized PnL and may engage kill switch.
   */
  updateLastTradedPrice(
    accountId: string,
    exchange: string,
    tradingsymbol: string,
    lastPrice: number,
  ): void {
    if (!config.positions.enabled) return;
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;

    const tradeDate = this.currentTradeDate();
    const pos = upsertPositionRow(accountId, exchange, tradingsymbol, tradeDate);

    if (pos.netQuantity === 0 && pos.lastPrice === lastPrice) return;
    if (pos.lastPrice === lastPrice) return;

    updateLastPrice(pos.id, lastPrice);
    const refreshed = getPositionById(pos.id);
    if (!refreshed) return;
    const view = toView(refreshed);

    emitPositionUpdate(view);
    // PnL summary changes when net != 0; otherwise skip the broadcast.
    if (refreshed.netQuantity !== 0) {
      this.emitPnlSummary();
      this.evaluateRisk(view);
    }
  }

  getPositions(tradeDate?: string): PositionView[] {
    const date = tradeDate ?? this.currentTradeDate();
    return listPositionsForDate(date).map(toView);
  }

  getPnlSummary(tradeDate?: string): PnlSummary {
    const date = tradeDate ?? this.currentTradeDate();
    const views = listPositionsForDate(date).map(toView);

    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalExposure = 0;

    for (const v of views) {
      totalRealized   += v.realizedPnl;
      totalUnrealized += v.unrealizedPnl;
      const px = v.lastPrice ?? v.averagePrice ?? 0;
      totalExposure += Math.abs(v.netQuantity) * (px || 0);
    }

    return {
      asOf: new Date().toISOString(),
      tradeDate: date,
      totalRealized: round(totalRealized),
      totalUnrealized: round(totalUnrealized),
      totalPnl: round(totalRealized + totalUnrealized),
      totalExposure: round(totalExposure),
      perSymbol: views,
      limits: {
        maxDailyLoss:         config.positions.maxDailyLoss,
        maxDailyProfit:       config.positions.maxDailyProfit,
        maxPositionPerSymbol: config.positions.maxPositionPerSymbol,
        maxTotalExposure:     config.positions.maxTotalExposure,
      },
    };
  }

  /** Re-emit the full PnL summary on the wire. */
  emitPnlSummary(): void {
    emitPnlUpdate(this.getPnlSummary());
  }

  // ─── Risk evaluation ──────────────────────────────────────────────────────

  /**
   * Check the current PnL / position against configured limits. Engages the
   * kill switch on breach (if POSITIONS_HALT_ON_BREACH=true). Idempotent —
   * killSwitch.halt() short-circuits if already engaged.
   *
   * Throttled per (account, symbol) by POSITIONS_EVAL_DEBOUNCE_MS.
   */
  evaluateRisk(touched: PositionView): void {
    if (!config.positions.enabled) return;

    const key = `${touched.accountId}|${touched.tradingsymbol}`;
    const now = Date.now();
    const last = this.lastEval.get(key) ?? 0;
    if (now - last < config.positions.evalDebounceMs) return;
    this.lastEval.set(key, now);

    const summary = this.getPnlSummary(touched.tradeDate);
    const breaches: string[] = [];

    // ── Per-symbol position cap (absolute lots/units)
    const cap = config.positions.maxPositionPerSymbol;
    if (cap > 0) {
      for (const v of summary.perSymbol) {
        if (Math.abs(v.netQuantity) > cap) {
          breaches.push(
            `MAX_POSITION_PER_SYMBOL exceeded — ${v.tradingsymbol} net=${v.netQuantity} (cap=${cap})`,
          );
        }
      }
    }

    // ── Total exposure cap (notional)
    if (config.positions.maxTotalExposure > 0
        && summary.totalExposure > config.positions.maxTotalExposure) {
      breaches.push(
        `MAX_TOTAL_EXPOSURE exceeded — exposure=${summary.totalExposure.toFixed(2)} (cap=${config.positions.maxTotalExposure})`,
      );
    }

    // ── Daily loss (totalPnl < 0, magnitude vs cap)
    if (config.positions.maxDailyLoss > 0
        && summary.totalPnl <= -Math.abs(config.positions.maxDailyLoss)) {
      breaches.push(
        `MAX_DAILY_LOSS hit — totalPnl=${summary.totalPnl.toFixed(2)} (loss cap=${config.positions.maxDailyLoss})`,
      );
    }

    // ── Daily profit cap (lock-in target)
    if (config.positions.maxDailyProfit > 0
        && summary.totalPnl >= config.positions.maxDailyProfit) {
      breaches.push(
        `MAX_DAILY_PROFIT hit — totalPnl=${summary.totalPnl.toFixed(2)} (profit target=${config.positions.maxDailyProfit})`,
      );
    }

    if (breaches.length === 0) return;

    const reason = breaches.join(' | ');
    logger.error('🛑 Risk limit breached', {
      reason,
      totalPnl: summary.totalPnl,
      totalExposure: summary.totalExposure,
    });

    if (config.positions.haltOnBreach && !killSwitch.isHalted()) {
      killSwitch.halt(reason, 'position-risk');
    } else {
      // Halt disabled OR already halted — still alert so operators know
      // the breach happened (it might be a NEW breach against an existing halt).
      alertAsync(
        'critical',
        'Position risk limit breached',
        `${reason}\n\nTotal PnL: ${summary.totalPnl.toFixed(2)}\nTotal Exposure: ${summary.totalExposure.toFixed(2)}`,
      );
    }
  }

  // ─── Restart recovery ─────────────────────────────────────────────────────

  /**
   * Called once on startup. Logs current state and re-emits a PnL snapshot
   * so any UI that's already connected sees the post-restart values.
   *
   * The actual position state survives restart because positions/position_fills
   * are persisted in SQLite — there's no rebuild step required, only a status
   * line and a fresh broadcast.
   */
  recoverOnStartup(): void {
    if (!config.positions.enabled) {
      logger.info('Position manager disabled (POSITIONS_ENABLED=false)');
      return;
    }
    const summary = this.getPnlSummary();
    const openCount = summary.perSymbol.filter((p) => p.netQuantity !== 0).length;
    logger.info('Position manager initialized', {
      tradeDate: summary.tradeDate,
      symbolsTracked: summary.perSymbol.length,
      openPositions: openCount,
      totalRealized: summary.totalRealized,
      totalUnrealized: summary.totalUnrealized,
      totalPnl: summary.totalPnl,
    });

    // Re-evaluate risk on restart — if we crashed mid-breach, the kill
    // switch is already engaged via DB; this catches the case where limits
    // were tightened across the restart and now apply to existing state.
    if (summary.perSymbol.length > 0) {
      this.evaluateRisk(summary.perSymbol[0]!);
    }
  }
}

// ─── Pure math (testable) ───────────────────────────────────────────────────
/**
 * Apply a signed-quantity fill delta to a position row.
 * Returns the new position row + the realized PnL delta from this fill.
 *
 * NOTE: this is a pure function — no DB writes, no side effects.
 */
export function applyDelta(
  pos: PositionRow,
  signedDelta: number,
  fillPrice: number,
): { newPosition: PositionRow; realizedDelta: number } {
  const oldNet = pos.netQuantity;
  const oldAvg = pos.averagePrice;

  let newNet: number;
  let newAvg: number;
  let realizedDelta = 0;

  const sameDir = (oldNet === 0) || Math.sign(oldNet) === Math.sign(signedDelta);

  if (sameDir) {
    // Extending the position — weighted average cost basis update.
    newNet = oldNet + signedDelta;
    if (newNet === 0) {
      newAvg = 0; // shouldn't happen with same-dir, but guard anyway
    } else {
      newAvg = (Math.abs(oldNet) * oldAvg + Math.abs(signedDelta) * fillPrice)
             / Math.abs(newNet);
    }
  } else {
    // Reducing or flipping. Realise PnL on the closed portion.
    const closedQty = Math.min(Math.abs(signedDelta), Math.abs(oldNet));
    // Sign of realized: long & sell → (sellPrice - avg) * qty
    //                   short & buy → (avg - buyPrice) * qty
    realizedDelta = (fillPrice - oldAvg) * closedQty * Math.sign(oldNet);

    newNet = oldNet + signedDelta;
    if (newNet === 0) {
      newAvg = 0;
    } else if (Math.sign(newNet) !== Math.sign(oldNet)) {
      // Position flipped — residual is at fill price (new direction).
      newAvg = fillPrice;
    } else {
      // Partial close — residual stays on original cost basis.
      newAvg = oldAvg;
    }
  }

  // Update buy/sell totals (for diagnostics)
  const absDelta = Math.abs(signedDelta);
  const fillValue = absDelta * fillPrice;
  const buyQty   = signedDelta > 0 ? pos.totalBuyQty   + absDelta : pos.totalBuyQty;
  const sellQty  = signedDelta < 0 ? pos.totalSellQty  + absDelta : pos.totalSellQty;
  const buyVal   = signedDelta > 0 ? pos.totalBuyValue + fillValue : pos.totalBuyValue;
  const sellVal  = signedDelta < 0 ? pos.totalSellValue + fillValue : pos.totalSellValue;

  return {
    newPosition: {
      ...pos,
      netQuantity:    newNet,
      averagePrice:   newAvg,
      realizedPnl:    pos.realizedPnl + realizedDelta,
      lastPrice:      fillPrice, // a fill is itself a tick
      totalBuyQty:    buyQty,
      totalSellQty:   sellQty,
      totalBuyValue:  buyVal,
      totalSellValue: sellVal,
      updatedAt:      new Date().toISOString(),
    },
    realizedDelta,
  };
}

function toView(pos: PositionRow): PositionView {
  const unrealized = (pos.netQuantity !== 0 && pos.lastPrice != null)
    ? (pos.lastPrice - pos.averagePrice) * pos.netQuantity
    : 0;
  return {
    accountId:     pos.accountId,
    exchange:      pos.exchange,
    tradingsymbol: pos.tradingsymbol,
    tradeDate:     pos.tradeDate,
    netQuantity:   pos.netQuantity,
    averagePrice:  round(pos.averagePrice),
    lastPrice:     pos.lastPrice,
    realizedPnl:   round(pos.realizedPnl),
    unrealizedPnl: round(unrealized),
    totalPnl:      round(pos.realizedPnl + unrealized),
    totalBuyQty:   pos.totalBuyQty,
    totalSellQty:  pos.totalSellQty,
    updatedAt:     pos.updatedAt,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export const positionManager = new PositionManager();
