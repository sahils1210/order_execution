import { Router, Request, Response } from 'express';
import { kiteClient } from '../kite/KiteClient.js';

export const healthRouter = Router();
const startTime = Date.now();

healthRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  const kiteOk = await kiteClient.isHealthy();
  const tokenStatus = kiteClient.getTokenStatus();

  const response = {
    status: kiteOk ? 'ok' : 'degraded',
    kiteConnected: kiteOk,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    token: {
      valid: tokenStatus.valid,
      lastRefreshedAt: tokenStatus.lastRefreshedAt,
      nextRefreshAt: tokenStatus.nextRefreshAt,
      lastError: tokenStatus.lastError,
      refreshCount: tokenStatus.refreshCount,
    },
  };

  res.status(kiteOk ? 200 : 503).json(response);
});
