import { Router, Request, Response } from 'express';
import { orderManager } from '../oms/OrderManager.js';
import { logger } from '../logger.js';

// =========================================
// DELETE /order/:orderId        — Cancel order (master account)
// PATCH  /order/:orderId        — Modify order (master account)
//
// Multi-account cancel/modify is intentionally not exposed yet — the broker
// order_id is account-specific and there is no use case in the current callers.
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

  logger.info('Cancel order request', { orderId, variety, accountId });

  const result = await orderManager.cancelOrder(orderId.trim(), variety, accountId);
  if (result.success) {
    res.status(200).json({
      success: true,
      orderId: result.orderId,
      latencyMs: result.latencyMs,
    });
  } else {
    res.status(502).json({
      success: false,
      message: result.error,
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

  const { price, triggerPrice, quantity, orderType } = req.body as {
    price?: number;
    triggerPrice?: number;
    quantity?: number;
    orderType?: string;
  };

  if (price == null && triggerPrice == null && quantity == null && orderType == null) {
    res.status(400).json({
      success: false,
      message: 'At least one of price, triggerPrice, quantity, or orderType is required',
      latencyMs: 0,
    });
    return;
  }

  logger.info('Modify order request', { orderId, variety, accountId, price, triggerPrice, quantity, orderType });

  const result = await orderManager.modifyOrder(
    orderId.trim(),
    variety,
    { price, triggerPrice, quantity, orderType },
    accountId,
  );

  if (result.success) {
    res.status(200).json({
      success: true,
      orderId: result.orderId,
      latencyMs: result.latencyMs,
    });
  } else {
    res.status(502).json({
      success: false,
      message: result.error,
      latencyMs: result.latencyMs,
    });
  }
});
