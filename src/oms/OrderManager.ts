import type { Connect } from 'kiteconnect';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { kiteClient } from '../kite/KiteClient.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { classifyKiteError, KiteTimeoutError, MissingAccountTokenError, TokenInvalidForNonMasterError } from '../kite/errors.js';
import { makePerRequestKite } from '../kite/perRequestKite.js';
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
import { tradingMode } from '../risk/TradingMode.js';
import { emitOrderUpdate } from '../websocket.js';
import { runtimeMetrics } from '../observability/runtimeMetrics.js';
import { randomBytes } from 'crypto';
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
  errorCode?: 'KEY_REUSE' | 'MISSING_ACCOUNT_TOKEN' | 'TOKEN_INVALID';
  /**
   * True when the order was simulated (DRY_RUN_OUTSIDE_HOURS active +
   * market closed). No Kite call was made; `orderId` is "DRYRUN-...".
   * Strategies should observe this flag and treat the order as test-only.
   */
  dryRun?: boolean;
}

export interface CancellationResult {
  success: boolean;
  orderId: string | null;
  error: string | null;
  latencyMs: number;
  /**
   * When success=false, the classified error kind (e.g. 'REJECTED', 'TIMEOUT').
   * Drives HTTP status mapping at the route layer: broker-rejected → 4xx,
   * gateway-couldn't-reach-broker → 5xx. Null on success or pre-Kite failures
   * (where we couldn't even call Kite — e.g. unknown account).
   */
  errorKind?: import('../kite/errors.js').KiteErrorKind | null;
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

    // 3.5. DRY-RUN short-circuit.
    //   Active when EITHER:
    //     (a) operator set tradingMode to 'dry-run' via /admin/mode (Design B
    //         binary toggle — persists across restart, no auto-revert), OR
    //     (b) DRY_RUN_OUTSIDE_HOURS=true is set AND NSE is currently closed
    //         (legacy env-driven path with time gate)
    //   Skips Kite entirely; writes a synthetic ACCEPTED row so the strategy
    //   can verify pair-matching logic without placing real orders. Goes
    //   through atomicCheckAndInsert so idempotency still works in test mode.
    if (tradingMode.isDryRunActive()) {
      return this.placeDryRun(req, accountId, compositeKey, startMs);
    }

    // 4. Resolve account (per-request token override if supplied)
    const tokenOverride = req.accountTokens?.[accountId];
    let kite: Connect;
    try {
      kite = this.kiteFor(accountId, tokenOverride);
    } catch (err) {
      if (err instanceof MissingAccountTokenError) {
        return fail('REJECTED', err.message, startMs, 'MISSING_ACCOUNT_TOKEN');
      }
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
    let nonMasterTokenInvalid = false;

    try {
      orderId = await this.placeWithPolicy(kite, accountId, variety, params, tag, compositeKey);
      finalStatus = 'ACCEPTED';
      circuitBreaker.recordSuccess(req.source, req.tradingsymbol);
      autoHaltMonitor.recordSuccess();
      runtimeMetrics.recordKiteCallSuccess();
    } catch (err) {
      // Non-master TOKEN error → surface TOKEN_INVALID, no internal refresh.
      if (err instanceof TokenInvalidForNonMasterError) {
        finalStatus = 'REJECTED';
        errorMessage = 'Provided account token rejected by Kite';
        nonMasterTokenInvalid = true;
        runtimeMetrics.recordKiteCallError(`TOKEN_INVALID: ${err.originalMessage}`);
      } else {
        const c = classifyKiteError(err);
        errorMessage = `[${c.kind}] ${c.message}`;
        runtimeMetrics.recordKiteCallError(`${c.kind}: ${c.message}`);

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
    }

    const latencyMs = Date.now() - startMs;
    runtimeMetrics.recordPlaceLatency(latencyMs);

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
      ...(nonMasterTokenInvalid ? { errorCode: 'TOKEN_INVALID' as const } : {}),
    };
  }

  // ─── Dry-run placement (no Kite call) ─────────────────────────────────────
  /**
   * Simulate an order placement WITHOUT calling Kite. Used by the dry-run
   * mode gate in placeOrder(). Goes through the same atomic-insert path so
   * idempotency still protects against duplicate test orders, then writes a
   * synthetic ACCEPTED row with kiteOrderId="DRYRUN-<14 hex>".
   *
   * The strategy receives `dryRun: true` in the response and can use the
   * returned orderId for subsequent cancel/modify calls (cancelOrder /
   * modifyOrder recognise the "DRYRUN-" prefix and short-circuit).
   *
   * No Kite calls. No PositionManager updates (a real postback never
   * arrives, so applyFill is never triggered — positions stay clean).
   */
  private async placeDryRun(
    req: OrderRequest,
    accountId: string,
    compositeKey: string,
    startMs: number,
  ): Promise<PlacementResult> {
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
        logger.error('Dry-run rejected: idempotencyKey reuse with different payload', {
          accountId, idempotencyKey: req.idempotencyKey, symbol: req.tradingsymbol,
        });
        return fail('ERROR', err.message, startMs, 'KEY_REUSE');
      }
      throw err;
    }

    if (existing) {
      // Cached dry-run retry — return same synthetic orderId.
      const r = existingToResult(existing.status, existing.kiteOrderId, existing.errorMessage, startMs);
      if (existing.kiteOrderId?.startsWith('DRYRUN-')) r.dryRun = true;
      return r;
    }

    preTradeCheck.recordAdmitted(req.source);

    const dryRunOrderId = `DRYRUN-${randomBytes(7).toString('hex')}`;
    const latencyMs = Date.now() - startMs;

    updateStatusByCompositeKey(compositeKey, {
      status: 'ACCEPTED',
      kiteOrderId: dryRunOrderId,
      kiteResponse: JSON.stringify({ dryRun: true, simulatedAt: new Date().toISOString() }),
      latencyMs,
    });

    logger.warn('Dry-run order accepted (gateway did NOT call Kite)', {
      compositeKey, accountId, tag, dryRunOrderId,
      symbol: req.tradingsymbol, side: req.transactionType, qty: req.quantity, source: req.source,
    });

    emitOrderUpdate({
      idempotencyKey: req.idempotencyKey,
      source: req.source,
      tradingsymbol: req.tradingsymbol,
      transactionType: req.transactionType,
      quantity: req.quantity,
      status: 'ACCEPTED',
      kiteOrderId: dryRunOrderId,
      errorMessage: null,
      latencyMs,
      receivedAt: new Date().toISOString(),
    });

    return {
      success: true,
      status: 'ACCEPTED',
      orderId: dryRunOrderId,
      error: null,
      latencyMs,
      cached: false,
      dryRun: true,
    };
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────
  // CRITICAL: cancellation is ALWAYS allowed, even when the kill switch is
  // engaged. Halting must never lock the operator out of reducing exposure.
  async cancelOrder(orderId: string, variety: string, accountId: string, tokenOverride?: string): Promise<CancellationResult> {
    const startMs = Date.now();

    // Dry-run short-circuit: synthetic orderIds never reach Kite. This lets
    // strategies cancel their own dry-run orders cleanly.
    if (orderId.startsWith('DRYRUN-')) {
      logger.warn('Dry-run cancel (no Kite call)', { orderId });
      return { success: true, orderId, error: null, latencyMs: Date.now() - startMs, errorKind: null };
    }

    let kite: Connect;
    try {
      kite = this.kiteFor(accountId, tokenOverride);
    } catch (err) {
      return cancelFail(String(err instanceof Error ? err.message : err), startMs);
    }

    try {
      const cancelledId = await this.callWithPolicy(
        accountId,
        () => callRaw(kite, 'cancelOrder', variety, orderId),
        config.kite.timeoutMs,
      );
      return { success: true, orderId: cancelledId, error: null, latencyMs: Date.now() - startMs, errorKind: null };
    } catch (err) {
      const c = classifyKiteError(err);
      return cancelFail(`[${c.kind}] ${c.message}`, startMs, c.kind);
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
    tokenOverride?: string,
  ): Promise<CancellationResult> {
    const startMs = Date.now();

    // Dry-run short-circuit: synthetic orderIds never reach Kite.
    if (orderId.startsWith('DRYRUN-')) {
      logger.warn('Dry-run modify (no Kite call)', { orderId, params });
      return { success: true, orderId, error: null, latencyMs: Date.now() - startMs, errorKind: null };
    }

    let kite: Connect;
    try {
      kite = this.kiteFor(accountId, tokenOverride);
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
      return { success: true, orderId: modifiedId, error: null, latencyMs: Date.now() - startMs, errorKind: null };
    } catch (err) {
      const c = classifyKiteError(err);
      return cancelFail(`[${c.kind}] ${c.message}`, startMs, c.kind);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private kiteFor(accountId: string, tokenOverride?: string): Connect {
    // Per-request token override (preferred path under STRICT_ACCOUNT_TOKENS).
    // Always honoured when supplied, regardless of the strict flag — the
    // caller has explicitly named the token they want this request to use.
    if (tokenOverride) {
      const apiKey = this.resolveApiKey(accountId);
      if (!apiKey) {
        throw new Error(`No apiKey configured for account '${accountId}' — cannot build per-request KiteConnect`);
      }
      return makePerRequestKite(apiKey, tokenOverride);
    }

    if (accountId === 'master') {
      if (!kiteClient.isConnected()) throw new Error('Master Kite client not connected');
      return kiteClient.getRawKite();
    }

    // Non-master, no override:
    //   STRICT=true  → REJECT (caller is required to supply accountTokens).
    //   STRICT=false → fall back to AccountRegistry-managed token (legacy).
    if (config.strictAccountTokens) {
      throw new MissingAccountTokenError(accountId);
    }
    const k = accountRegistry.getKite(accountId);
    if (!k) throw new Error(`Unknown account: ${accountId}`);
    if (!accountRegistry.isValid(accountId)) {
      throw new Error(`Account ${accountId} has invalid token`);
    }
    return k;
  }

  private resolveApiKey(accountId: string): string | null {
    if (accountId === 'master') return config.kite.apiKey;
    return accountRegistry.getApiKey(accountId);
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
      const queueStart = Date.now();
      await bucketFor(accountId).acquire();
      runtimeMetrics.recordQueueWait(Date.now() - queueStart);
      const kiteStart = Date.now();
      try {
        const id = await this.callWithTimeout(
          () => callRaw(kite, 'placeOrder', variety, params),
          config.kite.timeoutMs,
          tag,
          compositeKey,
        );
        runtimeMetrics.recordKiteLatency(Date.now() - kiteStart);
        return id;
      } catch (err) {
        runtimeMetrics.recordKiteLatency(Date.now() - kiteStart);
        throw err;
      }
    };

    try {
      return await attempt();
    } catch (err) {
      const c = classifyKiteError(err);

      if (c.kind === 'TOKEN') {
        // Non-master accounts: Scalper is the token authority. Do NOT refresh
        // server-side. Surface TOKEN_INVALID so the caller can force-refresh
        // its own TokenManager and retry with a fresh idempotency key.
        if (accountId !== 'master') {
          logger.warn('Token rejected for non-master account — surfacing TOKEN_INVALID', { accountId, tag });
          throw new TokenInvalidForNonMasterError(accountId, c.message);
        }

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

function cancelFail(
  message: string,
  startMs: number,
  errorKind: import('../kite/errors.js').KiteErrorKind | null = null,
): CancellationResult {
  return { success: false, orderId: null, error: message, latencyMs: Date.now() - startMs, errorKind };
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
