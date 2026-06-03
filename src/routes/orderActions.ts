import { Router, Request, Response } from 'express';
import { orderManager } from '../oms/OrderManager.js';
import { logger } from '../logger.js';
import { httpStatusForErrorKind } from './httpStatusMap.js';

// =========================================
// DELETE /order/:orderId        — Cancel order (master account)
// PATCH  /order/:orderId        — Modify order (master account)
//
// Multi-account cancel/modify is intentionally not exposed yet — the broker
// order_id is account-specific and there is no use case in the current callers.
//
// HTTP STATUS MAPPING (cancel/modify failures):
//   The previous version returned a blanket 502 on any failure. That conflates
//   "Kite refused this cancel" (legitimate, client-actionable) with "gateway
//   couldn't reach Kite" (real outage). Callers that retry on 502 would then
//   storm the gateway with cancels Kite has already terminally rejected — which
//   is exactly the dup-cancel pattern observed in 100-ALGO on 2026-06-03.
//
//   The new mapping:
//     409 Conflict       — broker refused (REJECTED, INPUT, PERMISSION, GENERAL)
//                          → "order already cancelled", "not cancellable", etc.
//                          Callers should NOT retry without changing inputs.
//     401 Unauthorized   — TOKEN error
//                          → token expired/invalid. Caller refreshes and retries.
//     502 Bad Gateway    — TIMEOUT / CONNECT_FAILED / GATEWAY_5XX / MIDFLIGHT_RESET
//                          → genuine upstream failure. Caller may retry with same
//                          inputs after a backoff.
//     400 Bad Request    — validation failures (no orderId, missing modify field)
// =========================================

export const orderActionsRouter = Router();

// ─── DELETE /order/:orderId ─────────────────────────────────────────────────
orderActionsRouter.delete('/:orderId', async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;
  const variety = (req.query['variety'] as string | undefined) ?? 'regular';
  const accountId = (req.query['account'] as string | undefined) ?? 'master';

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    res.status(400).json({ success: false, message: 'orderId path param is required', latencyMs: 0 });
    return;
  }

  // Optional per-account token override (same semantics as POST /order).
  const accountTokens = (req.body as { accountTokens?: Record<string, string> } | undefined)?.accountTokens;
  const tokenOverride = accountTokens?.[accountId];

  logger.info('Cancel order request', { orderId, variety, accountId, tokenOverridden: !!tokenOverride });

  const result = await orderManager.cancelOrder(orderId.trim(), variety, accountId, tokenOverride);
  if (result.success) {
    res.status(200).json({
      success: true,
      orderId: result.orderId,
      latencyMs: result.latencyMs,
    });
  } else {
    const status = httpStatusForErrorKind(result.errorKind);
    res.status(status).json({
      success: false,
      message: result.error,
      errorKind: result.errorKind ?? null,
      latencyMs: result.latencyMs,
    });
  }
});

// ─── PATCH /order/:orderId ──────────────────────────────────────────────────
orderActionsRouter.patch('/:orderId', async (req: Request, res: Response): Promise<void> => {
  const { orderId } = req.params;
  const variety = (req.query['variety'] as string | undefined) ?? 'regular';
  const accountId = (req.query['account'] as string | undefined) ?? 'master';

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    res.status(400).json({ success: false, message: 'orderId path param is required', latencyMs: 0 });
    return;
  }

  const { price, triggerPrice, quantity, orderType, accountTokens } = req.body as {
    price?: number;
    triggerPrice?: number;
    quantity?: number;
    orderType?: string;
    accountTokens?: Record<string, string>;
  };
  const tokenOverride = accountTokens?.[accountId];

  if (price == null && triggerPrice == null && quantity == null && orderType == null) {
    res.status(400).json({
      success: false,
      message: 'At least one of price, triggerPrice, quantity, or orderType is required',
      latencyMs: 0,
    });
    return;
  }

  logger.info('Modify order request', { orderId, variety, accountId, price, triggerPrice, quantity, orderType, tokenOverridden: !!tokenOverride });

  const result = await orderManager.modifyOrder(
    orderId.trim(),
    variety,
    { price, triggerPrice, quantity, orderType },
    accountId,
    tokenOverride,
  );

  if (result.success) {
    res.status(200).json({
      success: true,
      orderId: result.orderId,
      latencyMs: result.latencyMs,
    });
  } else {
    const status = httpStatusForErrorKind(result.errorKind);
    res.status(status).json({
      success: false,
      message: result.error,
      errorKind: result.errorKind ?? null,
      latencyMs: result.latencyMs,
    });
  }
});
