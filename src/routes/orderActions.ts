import { Router, Request, Response } from 'express';
import { kiteClient } from '../kite/KiteClient.js';
import { logger } from '../logger.js';

// =========================================
// DELETE /order/:orderId — Cancel an order
// PATCH  /order/:orderId — Modify an order
// =========================================

export const orderActionsRouter = Router();

// ─── DELETE /order/:orderId ───────────────────────────────────────────────────

orderActionsRouter.delete('/:orderId', async (req: Request, res: Response): Promise<void> => {
  const startMs = Date.now();
  const { orderId } = req.params;
  const variety = (req.query['variety'] as string | undefined) ?? 'regular';

  if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
    res.status(400).json({ success: false, message: 'orderId path param is required', latencyMs: 0 });
    return;
  }

  logger.info('Cancel order request', { orderId, variety });

  try {
    const cancelledId = await kiteClient.cancelOrder(orderId.trim(), variety);
    const latencyMs = Date.now() - startMs;

    logger.info('Order cancelled', { orderId: cancelledId, latencyMs });

    res.status(200).json({ success: true, orderId: cancelledId, latencyMs });
  } catch (err: unknown) {
    const latencyMs = Date.now() - startMs;
    const message = String(err);
    logger.error('Cancel order failed', { orderId, error: message, latencyMs });
    res.status(502).json({ success: false, message, latencyMs });
  }
});

// ─── PATCH /order/:orderId ────────────────────────────────────────────────────

orderActionsRouter.patch('/:orderId', async (req: Request, res: Response): Promise<void> => {
  const startMs = Date.now();
  const { orderId } = req.params;
  const variety = (req.query['variety'] as string | undefined) ?? 'regular';

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

  logger.info('Modify order request', { orderId, variety, price, triggerPrice, quantity, orderType });

  try {
    const modifiedId = await kiteClient.modifyOrder(
      orderId.trim(),
      { price, triggerPrice, quantity, orderType },
      variety
    );
    const latencyMs = Date.now() - startMs;

    logger.info('Order modified', { orderId: modifiedId, latencyMs });

    res.status(200).json({ success: true, orderId: modifiedId, latencyMs });
  } catch (err: unknown) {
    const latencyMs = Date.now() - startMs;
    const message = String(err);
    logger.error('Modify order failed', { orderId, error: message, latencyMs });
    res.status(502).json({ success: false, message, latencyMs });
  }
});
