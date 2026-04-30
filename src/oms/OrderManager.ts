import type { Connect } from 'kiteconnect';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { kiteClient } from '../kite/KiteClient.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { classifyKiteError, KiteTimeoutError } from '../kite/errors.js';
import { bucketFor } from '../kite/RateLimiter.js';
import {
  atomicCheckAndInsert,
  findByCompositeKey,
  updateStatusByCompositeKey,
  patchPostCallMetadata,
  IdempotencyKeyReuseError,
} from '../db/database.js';
import { makeTag } from './tag.js';
import { killSwitch, autoHaltMonitor } from '../risk/KillSwitch.js';
import { circuitBreaker } from '../risk/CircuitBreaker.js';
import { preTradeCheck } from '../risk/PreTradeCheck.js';
import { emitOrderUpdate } from '../websocket.js';
import type { OrderRequest, OrderStatus } from '../types.js';

// =========================================
// OrderManager — single entry point for placing/cancelling/modifying orders.
//
// IMPORTANT: kill switch ONLY blocks NEW order placement.
// Cancel and modify are ALWAYS allowed — when the system is halted, the
// operator's first need is to reduce exposure, not be locked out of it.
// =========================================

export interface PlacementResult {
  success: boolean;
  status: OrderStatus;
  orderId: string | null;
  error: string | null;
  latencyMs: number;
  cached: boolean;
  errorCode?: 'KEY_REUSE';
}

export interface CancellationResult {
  success: boolean;
  orderId: string | null;
  error: string | null;
  latencyMs: number;
}

const COMPOSITE_SEPARATOR = '::';
const compositeOf = (k: string, a: string) => `${k}${COMPOSITE_SEPARATOR}${a}`;

class OrderManager {
  // ─── Place ────────────────────────────────────────────────────────────────
  async placeOrder(req: OrderRequest, accountId: string): Promise<PlacementResult> {
    const startMs = Date.now();
    const compositeKey = compositeOf(req.idempotencyKey, accountId);

    // 1. Kill switch — ONLY for new orders.
    if (killSwitch.isHalted()) {
      return fail('ERROR', `Trading halted: ${killSwitch.getStatus().reason ?? 'no reason given'}`, startMs);
    }

    // 2. Circuit breaker
    const cb = circuitBreaker.isOpen(req.source, req.tradingsymbol);
    if (cb.open) {
      return fail('ERROR', cb.reason ?? 'Circuit breaker open', startMs);
    }

    // 3. Pre-trade
    const pre = preTradeCheck.validate(req, accountId);
    if (!pre.ok) {
      return fail('ERROR', pre.reason ?? 'Pre-trade check failed', startMs);
    }

    // 4. Resolve account
    let kite: Connect;
    try {
      kite = this.kiteFor(accountId);
    } catch (err) {
      return fail('ERROR', String(err instanceof Error ? err.message : err), startMs);
    }

    // 5. Atomic insert (with payload-divergence check)
    const tag = makeTag(req.idempotencyKey, accountId);
    const variety = req.variety ?? 'regular';

    let existing;
    try {
      existing = atomicCheckAndInsert({
        clientIdempotencyKey: req.idempotencyKey,
        accountId,
        source: req.source,
        exchange: req.exchange,
        tradingsymbol: req.tradingsymbol,
        transactionType: req.transactionType,
        quantity: req.quantity,
        product: req.product,
        orderType: req.orderType,
        variety,
        price: req.price ?? null,
        triggerPrice: req.triggerPrice ?? null,
        tag,
      });
    } catch (err) {
      if (err instanceof IdempotencyKeyReuseError) {
        logger.error('IdempotencyKey reuse with different payload — rejecting', {
          accountId,
          idempotencyKey: req.idempotencyKey,
          symbol: req.tradingsymbol,
          message: err.message,
        });
        return fail('ERROR', err.message, startMs, 'KEY_REUSE');
      }
      throw err;
    }

    if (existing) {
      return existingToResult(existing.status, existing.kiteOrderId, existing.errorMessage, startMs);
    }

    preTradeCheck.recordAdmitted(req.source);
    updateStatusByCompositeKey(compositeKey, { status: 'SUBMITTING', incAttempts: true });

    const params = buildKiteParams(req, tag);
    let orderId: string | null = null;
    let finalStatus: OrderStatus = 'ERROR';
    let errorMessage: string | null = null;

    try {
      orderId = await this.placeWithPolicy(kite, accountId, variety, params, tag, compositeKey);
      finalStatus = 'ACCEPTED';
      circuitBreaker.recordSuccess(req.source, req.tradingsymbol);
      autoHaltMonitor.recordSuccess();
    } catch (err) {
      const c = classifyKiteError(err);
      errorMessage = `[${c.kind}] ${c.message}`;

      if (c.kind === 'TIMEOUT' || c.kind === 'MIDFLIGHT_RESET') {
        finalStatus = 'UNKNOWN';
        scheduleOneShotReconcile(compositeKey, accountId, tag);
      } else if (c.kind === 'REJECTED' || c.kind === 'PERMISSION') {
        finalStatus = 'REJECTED';
        circuitBreaker.recordError(req.source, req.tradingsymbol);
        autoHaltMonitor.recordError();
      } else if (c.kind === 'INPUT') {
        finalStatus = 'ERROR';
      } else {
        finalStatus = 'ERROR';
        circuitBreaker.recordError(req.source, req.tradingsymbol);
        autoHaltMonitor.recordError();
      }
    }

    const latencyMs = Date.now() - startMs;

    // Postback-race guard
    const current = findByCompositeKey(compositeKey);
    const postbackTookOver = !!(
      current &&
      current.postbackConfirmedAt &&
      (current.status === 'COMPLETE' || current.status === 'REJECTED' || current.status === 'CANCELLED')
    );

    if (postbackTookOver && current) {
      patchPostCallMetadata(compositeKey, {
        kiteOrderId: orderId ?? current.kiteOrderId,
        latencyMs,
      });
      finalStatus  = current.status;
      orderId      = current.kiteOrderId ?? orderId;
      errorMessage = current.errorMessage;
      logger.info('Postback raced ahead of placement response — preserving postback state', {
        compositeKey,
        accountId,
        tag,
        postbackStatus: current.status,
        kiteOrderId: orderId,
      });
    } else {
      updateStatusByCompositeKey(compositeKey, {
        status: finalStatus,
        kiteOrderId: orderId,
        kiteResponse: orderId ? JSON.stringify({ order_id: orderId }) : null,
        errorMessage,
        latencyMs,
      });
      emitOrderUpdate({
        idempotencyKey: req.idempotencyKey,
        source: req.source,
        tradingsymbol: req.tradingsymbol,
        transactionType: req.transactionType,
        quantity: req.quantity,
        status: finalStatus,
        kiteOrderId: orderId,
        errorMessage,
        latencyMs,
        receivedAt: new Date().toISOString(),
      });
    }

    if (finalStatus === 'ACCEPTED' || finalStatus === 'COMPLETE') {
      logger.info('Order finalised', { compositeKey, accountId, tag, status: finalStatus, orderId, latencyMs });
    } else if (finalStatus === 'UNKNOWN') {
      logger.warn('Order UNKNOWN — reconciliation scheduled', { compositeKey, accountId, tag, latencyMs });
    } else {
      logger.error('Order failed', { compositeKey, accountId, tag, status: finalStatus, errorMessage, latencyMs });
    }

    const success = finalStatus === 'ACCEPTED' || finalStatus === 'COMPLETE';
    return {
      success,
      status: finalStatus,
      orderId,
      error: success ? null : errorMessage,
      latencyMs,
      cached: false,
    };
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────
  // CRITICAL: cancellation is ALWAYS allowed, even when the kill switch is
  // engaged. Halting must never lock the operator out of reducing exposure.
  async cancelOrder(orderId: string, variety: string, accountId: string): Promise<CancellationResult> {
    const startMs = Date.now();

    let kite: Connect;
    try {
      kite = this.kiteFor(accountId);
    } catch (err) {
      return cancelFail(String(err instanceof Error ? err.message : err), startMs);
    }

    try {
      const cancelledId = await this.callWithPolicy(
        accountId,
        () => callRaw(kite, 'cancelOrder', variety, orderId),
        config.kite.timeoutMs,
      );
      return { success: true, orderId: cancelledId, error: null, latencyMs: Date.now() - startMs };
    } catch (err) {
      const c = classifyKiteError(err);
      return cancelFail(`[${c.kind}] ${c.message}`, startMs);
    }
  }

  // ─── Modify ───────────────────────────────────────────────────────────────
  // CRITICAL: modification is ALWAYS allowed (same reasoning as cancel — the
  // operator may need to lower qty / move price under halt to reduce exposure).
  async modifyOrder(
    orderId: string,
    variety: string,
    params: { price?: number; triggerPrice?: number; quantity?: number; orderType?: string },
    accountId: string,
  ): Promise<CancellationResult> {
    const startMs = Date.now();

    let kite: Connect;
    try {
      kite = this.kiteFor(accountId);
    } catch (err) {
      return cancelFail(String(err instanceof Error ? err.message : err), startMs);
    }

    const modifyParams: Record<string, unknown> = {};
    if (params.price       != null) modifyParams.price         = params.price;
    if (params.triggerPrice!= null) modifyParams.trigger_price = params.triggerPrice;
    if (params.quantity    != null) modifyParams.quantity      = params.quantity;
    if (params.orderType   != null) modifyParams.order_type    = params.orderType;

    try {
      const modifiedId = await this.callWithPolicy(
        accountId,
        () => callRaw(kite, 'modifyOrder', variety, orderId, modifyParams),
        config.kite.timeoutMs,
      );
      return { success: true, orderId: modifiedId, error: null, latencyMs: Date.now() - startMs };
    } catch (err) {
      const c = classifyKiteError(err);
      return cancelFail(`[${c.kind}] ${c.message}`, startMs);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private kiteFor(accountId: string): Connect {
    if (accountId === 'master') {
      if (!kiteClient.isConnected()) throw new Error('Master Kite client not connected');
      return kiteClient.getRawKite();
    }
    const k = accountRegistry.getKite(accountId);
    if (!k) throw new Error(`Unknown account: ${accountId}`);
    if (!accountRegistry.isValid(accountId)) {
      throw new Error(`Account ${accountId} has invalid token`);
    }
    return k;
  }

  private async refreshAccount(accountId: string): Promise<void> {
    if (accountId === 'master') {
      await kiteClient.refreshToken();
    } else {
      await accountRegistry.refreshAccount(accountId);
    }
  }

  private async placeWithPolicy(
    kite: Connect,
    accountId: string,
    variety: string,
    params: Record<string, unknown>,
    tag: string,
    compositeKey: string,
  ): Promise<string> {
    const attempt = async (): Promise<string> => {
      await bucketFor(accountId).acquire();
      return this.callWithTimeout(
        () => callRaw(kite, 'placeOrder', variety, params),
        config.kite.timeoutMs,
        tag,
        compositeKey,
      );
    };

    try {
      return await attempt();
    } catch (err) {
      const c = classifyKiteError(err);

      if (c.kind === 'TOKEN') {
        logger.warn('Token error during placeOrder — refreshing and retrying once', { accountId, tag });
        try {
          await this.refreshAccount(accountId);
        } catch (refreshErr) {
          logger.error('Token refresh failed during placeOrder retry', { accountId, error: String(refreshErr) });
          throw err;
        }
        updateStatusByCompositeKey(compositeKey, { status: 'SUBMITTING', incAttempts: true });
        return await attempt();
      }

      if (c.kind === 'CONNECT_FAILED' || c.kind === 'GATEWAY_5XX') {
        logger.warn('Safe retry on connect/5xx', { accountId, tag, kind: c.kind });
        await sleep(200);
        updateStatusByCompositeKey(compositeKey, { status: 'SUBMITTING', incAttempts: true });
        return await attempt();
      }

      throw err;
    }
  }

  private async callWithPolicy<T extends { order_id: string }>(
    accountId: string,
    fn: () => Promise<T>,
    timeoutMs: number,
  ): Promise<string> {
    const wrap = async (): Promise<string> => {
      await bucketFor(accountId).acquire();
      return withTimeout(fn(), timeoutMs).then((r) => r.order_id);
    };
    try {
      return await wrap();
    } catch (err) {
      const c = classifyKiteError(err);
      if (c.kind === 'TOKEN') {
        try { await this.refreshAccount(accountId); }
        catch (refreshErr) {
          logger.error('Token refresh failed during cancel/modify retry', { accountId, error: String(refreshErr) });
          throw err;
        }
        return await wrap();
      }
      if (c.kind === 'CONNECT_FAILED' || c.kind === 'GATEWAY_5XX') {
        await sleep(200);
        return await wrap();
      }
      throw err;
    }
  }

  private async callWithTimeout(
    call: () => Promise<{ order_id: string }>,
    timeoutMs: number,
    tag: string,
    compositeKey: string,
  ): Promise<string> {
    const inflight = call();

    inflight.then(
      (r) => {
        const row = findByCompositeKey(compositeKey);
        if (row && row.status === 'UNKNOWN') {
          updateStatusByCompositeKey(compositeKey, {
            status: 'ACCEPTED',
            kiteOrderId: r.order_id,
            kiteResponse: JSON.stringify({ order_id: r.order_id }),
            errorMessage: null,
          });
          logger.warn('Post-timeout resolution: UNKNOWN → ACCEPTED', { tag, orderId: r.order_id });
          emitOrderUpdate({
            idempotencyKey: row.clientIdempotencyKey,
            source: row.source,
            tradingsymbol: row.tradingsymbol,
            transactionType: row.transactionType,
            quantity: row.quantity,
            status: 'ACCEPTED',
            kiteOrderId: r.order_id,
            errorMessage: null,
            latencyMs: row.latencyMs,
            receivedAt: row.receivedAt,
          });
        }
      },
      (e) => {
        const row = findByCompositeKey(compositeKey);
        if (row && row.status === 'UNKNOWN') {
          const c = classifyKiteError(e);
          if (c.kind === 'REJECTED' || c.kind === 'INPUT' || c.kind === 'PERMISSION') {
            updateStatusByCompositeKey(compositeKey, {
              status: 'REJECTED',
              errorMessage: `[${c.kind}] ${c.message}`,
            });
            logger.warn('Post-timeout resolution: UNKNOWN → REJECTED', { tag, error: c.message });
            emitOrderUpdate({
              idempotencyKey: row.clientIdempotencyKey,
              source: row.source,
              tradingsymbol: row.tradingsymbol,
              transactionType: row.transactionType,
              quantity: row.quantity,
              status: 'REJECTED',
              kiteOrderId: row.kiteOrderId,
              errorMessage: c.message,
              latencyMs: row.latencyMs,
              receivedAt: row.receivedAt,
            });
          }
        }
      },
    );

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new KiteTimeoutError(timeoutMs)), timeoutMs),
    );

    const result = await Promise.race([inflight, timeout]);
    return result.order_id;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildKiteParams(req: OrderRequest, tag: string): Record<string, unknown> {
  return {
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    transaction_type: req.transactionType,
    quantity: req.quantity,
    product: req.product,
    order_type: req.orderType,
    ...(req.price        != null && { price:         req.price }),
    ...(req.triggerPrice != null && { trigger_price: req.triggerPrice }),
    tag,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callRaw(kite: Connect, method: string, ...args: any[]): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (kite as any)[method](...args);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new KiteTimeoutError(ms)), ms)),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(
  status: OrderStatus,
  message: string,
  startMs: number,
  errorCode?: PlacementResult['errorCode'],
): PlacementResult {
  return {
    success: false,
    status,
    orderId: null,
    error: message,
    latencyMs: Date.now() - startMs,
    cached: false,
    errorCode,
  };
}

function cancelFail(message: string, startMs: number): CancellationResult {
  return { success: false, orderId: null, error: message, latencyMs: Date.now() - startMs };
}

function existingToResult(
  status: OrderStatus,
  orderId: string | null,
  errorMessage: string | null,
  startMs: number,
): PlacementResult {
  const succeeded = status === 'ACCEPTED' || status === 'COMPLETE';
  return {
    success: succeeded,
    status,
    orderId,
    error: succeeded ? null : (errorMessage ?? `Duplicate request — prior status: ${status}`),
    latencyMs: Date.now() - startMs,
    cached: true,
  };
}

function scheduleOneShotReconcile(compositeKey: string, accountId: string, tag: string): void {
  setTimeout(async () => {
    try {
      const mod = await import('./Reconciler.js');
      await mod.reconciler.reconcileOne(compositeKey, accountId, tag);
    } catch (err) {
      logger.error('Post-timeout reconcile failed', { compositeKey, error: String(err) });
    }
  }, config.oms.postTimeoutReconcileDelayMs);
}

export const orderManager = new OrderManager();
