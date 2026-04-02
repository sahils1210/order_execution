import { Router, Request, Response } from 'express';
import { kiteClient } from '../kite/KiteClient.js';
import { insertOrderLog, updateOrderLog, findByIdempotencyKey } from '../db/database.js';
import { setIdempotencyCache, getIdempotencyCache } from '../utils/idempotency.js';
import { logger } from '../logger.js';
import { emitOrderUpdate } from '../websocket.js';
import type { OrderRequest, OrderResponse } from '../types.js';

// =========================================
// POST /order — Execute an order
// =========================================

export const orderRouter = Router();

orderRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const startMs = Date.now();
  const body = req.body as OrderRequest;

  // ── 1. Basic validation ──────────────────────────────────────────────────
  const validationError = validateOrderRequest(body);
  if (validationError) {
    res.status(400).json({ success: false, message: validationError, latencyMs: 0 });
    return;
  }

  const { idempotencyKey } = body;

  // ── 2. Idempotency: check DB first (survives restart) ────────────────────
  const existing = findByIdempotencyKey(idempotencyKey);
  if (existing) {
    logger.info('Idempotency: returning cached result from DB', {
      idempotencyKey,
      status: existing.status,
      kiteOrderId: existing.kiteOrderId,
    });
    const response: OrderResponse = {
      success: existing.status === 'COMPLETE' || existing.status === 'SENT',
      orderId: existing.kiteOrderId ?? undefined,
      message: `Duplicate request — status: ${existing.status}`,
      latencyMs: 0,
    };
    res.status(200).json(response);
    return;
  }

  // ── 3. Idempotency: check in-memory (in-flight protection) ───────────────
  const inFlight = getIdempotencyCache(idempotencyKey);
  if (inFlight) {
    logger.warn('Idempotency: request is already in-flight', { idempotencyKey });
    res.status(409).json({
      success: false,
      message: 'Order with this idempotencyKey is currently being processed. Retry in a moment.',
      latencyMs: 0,
    });
    return;
  }

  // ── 4. Insert log record + mark in-flight ────────────────────────────────
  try {
    insertOrderLog({
      idempotencyKey,
      source: body.source,
      exchange: body.exchange,
      tradingsymbol: body.tradingsymbol,
      transactionType: body.transactionType,
      quantity: body.quantity,
      product: body.product,
      orderType: body.orderType,
      variety: body.variety ?? 'regular',
      price: body.price ?? null,
      triggerPrice: body.triggerPrice ?? null,
      tag: body.tag ?? null,
    });
  } catch (err: unknown) {
    // UNIQUE constraint violation = duplicate key arrived simultaneously
    if (String(err).includes('UNIQUE')) {
      logger.warn('Idempotency: concurrent duplicate detected via DB constraint', { idempotencyKey });
      res.status(409).json({
        success: false,
        message: 'Duplicate idempotencyKey — concurrent request detected.',
        latencyMs: 0,
      });
      return;
    }
    throw err;
  }

  // Mark in-flight (prevents duplicate in-process requests)
  setIdempotencyCache(idempotencyKey, null, 'IN_FLIGHT');

  // ── 5. Execute order via Kite ─────────────────────────────────────────────
  let kiteOrderId: string | null = null;
  let status: 'SENT' | 'ERROR' = 'ERROR';
  let errorMessage: string | null = null;
  let kiteResponse: string | null = null;

  try {
    kiteOrderId = await kiteClient.placeOrder(body);
    status = 'SENT';
    kiteResponse = JSON.stringify({ order_id: kiteOrderId });
    logger.info('Order placed', {
      idempotencyKey,
      source: body.source,
      symbol: body.tradingsymbol,
      exchange: body.exchange,
      qty: body.quantity,
      type: body.transactionType,
      kiteOrderId,
    });
  } catch (err: unknown) {
    errorMessage = String(err);
    logger.error('Order placement failed', {
      idempotencyKey,
      source: body.source,
      symbol: body.tradingsymbol,
      error: errorMessage,
    });
  }

  const latencyMs = Date.now() - startMs;

  // ── 6. Update DB log ──────────────────────────────────────────────────────
  updateOrderLog({
    idempotencyKey,
    status,
    kiteOrderId,
    kiteResponse,
    errorMessage,
    latencyMs,
  });

  // Update cache with final status
  setIdempotencyCache(idempotencyKey, kiteOrderId, status);

  // ── 7. Emit real-time update to UI dashboard ──────────────────────────────
  emitOrderUpdate({
    idempotencyKey,
    source: body.source,
    tradingsymbol: body.tradingsymbol,
    transactionType: body.transactionType,
    quantity: body.quantity,
    status,
    kiteOrderId,
    errorMessage,
    latencyMs,
    receivedAt: new Date().toISOString(),
  });

  // ── 8. Respond to client ──────────────────────────────────────────────────
  const response: OrderResponse = {
    success: status === 'SENT',
    orderId: kiteOrderId ?? undefined,
    message: errorMessage ?? undefined,
    latencyMs,
  };

  res.status(status === 'SENT' ? 200 : 502).json(response);
});

// ─── Validation ───────────────────────────────────────────────────────────────

function validateOrderRequest(body: Partial<OrderRequest>): string | null {
  if (!body.idempotencyKey) return 'idempotencyKey is required';
  if (!body.source) return 'source is required';
  if (!body.exchange) return 'exchange is required';
  if (!body.tradingsymbol) return 'tradingsymbol is required';
  if (!body.transactionType) return 'transactionType is required (BUY | SELL)';
  if (!body.quantity || body.quantity <= 0) return 'quantity must be a positive integer';
  if (!body.product) return 'product is required (MIS | CNC | NRML)';
  if (!body.orderType) return 'orderType is required (MARKET | LIMIT | SL | SL-M)';

  const validTxTypes = ['BUY', 'SELL'];
  if (!validTxTypes.includes(body.transactionType!)) {
    return `transactionType must be one of: ${validTxTypes.join(', ')}`;
  }

  const validOrderTypes = ['MARKET', 'LIMIT', 'SL', 'SL-M'];
  if (!validOrderTypes.includes(body.orderType!)) {
    return `orderType must be one of: ${validOrderTypes.join(', ')}`;
  }

  if ((body.orderType === 'LIMIT' || body.orderType === 'SL') && !body.price) {
    return 'price is required for LIMIT and SL orders';
  }

  if ((body.orderType === 'SL' || body.orderType === 'SL-M') && !body.triggerPrice) {
    return 'triggerPrice is required for SL and SL-M orders';
  }

  return null;
}
