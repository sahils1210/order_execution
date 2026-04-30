import { Router, Request, Response } from 'express';
import { orderManager } from '../oms/OrderManager.js';
import type { OrderRequest, OrderResponse } from '../types.js';

// =========================================
// POST /order — Place a single order on the master account.
// =========================================

export const orderRouter = Router();

orderRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as OrderRequest;

  const validationError = validateOrderRequest(body);
  if (validationError) {
    res.status(400).json({ success: false, message: validationError, latencyMs: 0 });
    return;
  }

  const result = await orderManager.placeOrder(body, 'master');

  const response: OrderResponse = {
    success: result.success,
    status: result.status,
    orderId: result.orderId ?? undefined,
    message: result.error ?? undefined,
    latencyMs: result.latencyMs,
  };

  // HTTP semantics:
  //   200 → ACCEPTED / COMPLETE (or cached duplicate that succeeded)
  //   202 → UNKNOWN (timeout — outcome will resolve via reconciliation)
  //   409 → in-flight duplicate (RECEIVED/SUBMITTING in DB, cached returned non-success)
  //   422 → REJECTED by Kite, OR idempotencyKey reused with different params (KEY_REUSE)
  //   502 → ERROR (never reached Kite, or unclassified)
  let statusCode = 502;
  if (result.success) {
    statusCode = 200;
  } else if (result.errorCode === 'KEY_REUSE') {
    // CRITICAL FIX (Bug #2): same key with different payload → 422.
    statusCode = 422;
  } else if (result.status === 'UNKNOWN') {
    statusCode = 202;
  } else if (result.cached && (result.status === 'RECEIVED' || result.status === 'SUBMITTING')) {
    statusCode = 409;
  } else if (result.status === 'REJECTED') {
    statusCode = 422;
  } else {
    statusCode = 502;
  }

  res.status(statusCode).json(response);
});

// ─── Validation ─────────────────────────────────────────────────────────────
function validateOrderRequest(body: Partial<OrderRequest>): string | null {
  if (!body.idempotencyKey) return 'idempotencyKey is required';
  if (!body.source)         return 'source is required';
  if (!body.exchange)       return 'exchange is required';
  if (!body.tradingsymbol)  return 'tradingsymbol is required';
  if (!body.transactionType) return 'transactionType is required (BUY | SELL)';
  if (!body.quantity || body.quantity <= 0) return 'quantity must be a positive integer';
  if (!body.product)        return 'product is required (MIS | CNC | NRML)';
  if (!body.orderType)      return 'orderType is required (MARKET | LIMIT | SL | SL-M)';

  if (!['BUY', 'SELL'].includes(body.transactionType)) {
    return `transactionType must be BUY or SELL`;
  }
  if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(body.orderType)) {
    return `orderType must be MARKET | LIMIT | SL | SL-M`;
  }
  if ((body.orderType === 'LIMIT' || body.orderType === 'SL') && !body.price) {
    return 'price is required for LIMIT and SL orders';
  }
  if ((body.orderType === 'SL' || body.orderType === 'SL-M') && !body.triggerPrice) {
    return 'triggerPrice is required for SL and SL-M orders';
  }
  return null;
}
