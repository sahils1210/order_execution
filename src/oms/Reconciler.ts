import type { Connect } from 'kiteconnect';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { kiteClient } from '../kite/KiteClient.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import {
  findByCompositeKey,
  findNonTerminalSince,
  updateStatusByCompositeKey,
} from '../db/database.js';
import { mapKiteStatus, isTerminalStatus } from '../kite/statusMap.js';
import { emitOrderUpdate } from '../websocket.js';
import type { KiteOrderRow, OrderLog } from '../types.js';

// =========================================
// Reconciler — closes the loop on UNKNOWN / SUBMITTING / RECEIVED orders.
//
// Postback layer is the FIRST line of defence (real-time, push). The reconciler
// is the BACKSTOP for orders missed by the postback (URL outage, network loss,
// app_id misconfig). It also handles RECEIVED rows from crashes.
//
// Race safety: every write re-reads the row immediately before updating,
// because `await fetchKiteOrders()` yields the event loop and a postback may
// have written a terminal status during that window. We never reverse a
// terminal state, and we defer to a recently postback-confirmed row.
// =========================================

class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.inFlight) {
        this.timer = setTimeout(tick, config.oms.reconcileIntervalMs);
        return;
      }
      this.inFlight = true;
      try {
        await this.reconcileWindow(config.oms.reconcileLookbackMs);
      } catch (err) {
        logger.error('Reconcile tick failed', { error: String(err) });
      } finally {
        this.inFlight = false;
      }
      this.timer = setTimeout(tick, config.oms.reconcileIntervalMs);
    };
    this.timer = setTimeout(tick, config.oms.reconcileIntervalMs);
    logger.info('Reconciler started', { intervalMs: config.oms.reconcileIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async reconcileOnStartup(): Promise<void> {
    logger.info('Startup reconciliation: scanning non-terminal rows', {
      lookbackHours: (config.oms.startupReconcileLookbackMs / 3600000).toFixed(1),
    });
    await this.reconcileWindow(config.oms.startupReconcileLookbackMs);
  }

  /** One-shot reconcile triggered immediately after a placement timeout. */
  async reconcileOne(compositeKey: string, accountId: string, tag: string): Promise<void> {
    const row = findByCompositeKey(compositeKey);
    if (!row) return;
    if (isTerminalStatus(row.status)) return;
    if (this.recentlyConfirmedByPostback(row)) return;

    const orders = await this.fetchKiteOrders(accountId);
    if (!orders) return;

    const match = orders.find((o) => o.tag === tag);
    if (match) {
      // applyKiteRowToDbRow re-reads internally — safe even though the await
      // above may have allowed a postback to run.
      this.applyKiteRowToDbRow(row, match);
      return;
    }

    if (this.shouldAbandon(row)) {
      // CRITICAL FIX (Bug #1): re-read before abandoning. If a postback
      // resolved this row during fetchKiteOrders, do not stomp on it.
      const fresh = findByCompositeKey(compositeKey);
      if (fresh && !isTerminalStatus(fresh.status) && !fresh.postbackConfirmedAt) {
        this.abandon(fresh, 'one-shot reconcile found no match within abandon window');
      }
    }
  }

  // ─── Sweep ────────────────────────────────────────────────────────────────
  private async reconcileWindow(lookbackMs: number): Promise<void> {
    const since = new Date(Date.now() - lookbackMs).toISOString();
    const allRows = findNonTerminalSince(since);
    if (allRows.length === 0) return;

    const pendingRows = allRows.filter((r) => !this.recentlyConfirmedByPostback(r));
    if (pendingRows.length === 0) return;

    const byAccount = new Map<string, OrderLog[]>();
    for (const r of pendingRows) {
      if (r.accountId === 'recovery') continue;
      const arr = byAccount.get(r.accountId) ?? [];
      arr.push(r);
      byAccount.set(r.accountId, arr);
    }

    let touched = 0;
    let abandoned = 0;

    for (const [accountId, rows] of byAccount) {
      const orders = await this.fetchKiteOrders(accountId);
      if (!orders) continue;
      const byTag = new Map<string, KiteOrderRow>();
      for (const o of orders) {
        if (o.tag) byTag.set(o.tag, o);
      }

      for (const row of rows) {
        if (!row.tag) continue;
        const match = byTag.get(row.tag);
        if (match) {
          this.applyKiteRowToDbRow(row, match);
          touched++;
        } else if (this.shouldAbandon(row)) {
          // CRITICAL FIX (Bug #1): re-read before abandoning.
          const fresh = findByCompositeKey(row.idempotencyKey);
          if (fresh && !isTerminalStatus(fresh.status) && !fresh.postbackConfirmedAt) {
            this.abandon(fresh, 'periodic reconcile found no match within abandon window');
            abandoned++;
          }
        }
      }
    }

    if (touched + abandoned > 0) {
      logger.info('Reconcile sweep complete', {
        rowsScanned: allRows.length,
        rowsConsidered: pendingRows.length,
        updated: touched,
        abandoned,
      });
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private recentlyConfirmedByPostback(row: OrderLog): boolean {
    if (!row.postbackConfirmedAt) return false;
    const ageMs = Date.now() - new Date(row.postbackConfirmedAt).getTime();
    return ageMs >= 0 && ageMs < config.oms.postbackPreferenceMs;
  }

  private async fetchKiteOrders(accountId: string): Promise<KiteOrderRow[] | null> {
    let kite: Connect | null = null;
    if (accountId === 'master') {
      if (!kiteClient.isConnected()) return null;
      kite = kiteClient.getRawKite();
    } else {
      kite = accountRegistry.getKite(accountId);
      if (!kite || !accountRegistry.isValid(accountId)) return null;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = await Promise.race([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (kite as any).getOrders(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reconcile getOrders timeout')), 8000)),
      ]) as KiteOrderRow[];
      return Array.isArray(orders) ? orders : null;
    } catch (err) {
      logger.warn('Reconcile getOrders failed', { accountId, error: String(err) });
      return null;
    }
  }

  /**
   * Apply a Kite getOrders row to our DB row.
   *
   * CRITICAL FIX (Bug #1): the `row` argument is a STALE snapshot taken before
   * the sweep awaited fetchKiteOrders(). A postback may have written a
   * terminal status during that yield. Re-read the DB before any write.
   */
  private applyKiteRowToDbRow(row: OrderLog, kiteOrder: KiteOrderRow): void {
    const newStatus = mapKiteStatus(kiteOrder.status);
    if (!newStatus) return;

    const fresh = findByCompositeKey(row.idempotencyKey);
    if (!fresh) return;

    // Never reverse a terminal state — postback / earlier reconcile already finalised it.
    if (isTerminalStatus(fresh.status)) return;

    // Postback wins within the preference window — getOrders is a polled
    // snapshot which can lag the postback push by 100ms-2s.
    if (fresh.postbackConfirmedAt) {
      const ageMs = Date.now() - new Date(fresh.postbackConfirmedAt).getTime();
      if (ageMs >= 0 && ageMs < config.oms.postbackPreferenceMs) return;
    }

    if (newStatus === fresh.status && fresh.kiteOrderId === kiteOrder.order_id) return;

    updateStatusByCompositeKey(fresh.idempotencyKey, {
      status: newStatus,
      kiteOrderId: kiteOrder.order_id,
      kiteResponse: JSON.stringify(kiteOrder),
      errorMessage: kiteOrder.status_message ?? fresh.errorMessage,
    });

    logger.info('Reconciled order', {
      compositeKey: fresh.idempotencyKey,
      tag: fresh.tag,
      previous: fresh.status,
      next: newStatus,
      kiteOrderId: kiteOrder.order_id,
    });

    emitOrderUpdate({
      idempotencyKey: fresh.clientIdempotencyKey,
      source: fresh.source,
      tradingsymbol: fresh.tradingsymbol,
      transactionType: fresh.transactionType,
      quantity: fresh.quantity,
      status: newStatus,
      kiteOrderId: kiteOrder.order_id,
      errorMessage: kiteOrder.status_message ?? null,
      latencyMs: fresh.latencyMs,
      receivedAt: fresh.receivedAt,
    });
  }

  private shouldAbandon(row: OrderLog): boolean {
    const ageMs = Date.now() - new Date(row.receivedAt).getTime();
    if (row.status === 'RECEIVED' && ageMs > config.oms.maxReceivedAgeMs) return true;
    if ((row.status === 'SUBMITTING' || row.status === 'UNKNOWN') && ageMs > config.oms.abandonAfterMs) return true;
    return false;
  }

  private abandon(row: OrderLog, reason: string): void {
    updateStatusByCompositeKey(row.idempotencyKey, {
      status: 'ERROR',
      errorMessage: row.errorMessage ? `${row.errorMessage}; ${reason}` : `Abandoned by reconciler: ${reason}`,
    });
    logger.warn('Order abandoned by reconciler', {
      compositeKey: row.idempotencyKey,
      tag: row.tag,
      previousStatus: row.status,
      reason,
    });
  }
}

export const reconciler = new Reconciler();
