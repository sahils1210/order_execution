import { Router, Request, Response } from 'express';
import { metricsService } from '../observability/MetricsService.js';
import { diagnosticsService } from '../observability/DiagnosticsService.js';

// =========================================
// GET /metrics      → aggregated counters + alert signals (today, IST)
// GET /diagnostics  → liveness checks (db, kite, postback, rate-limiters)
// =========================================

export const metricsRouter = Router();

metricsRouter.get('/', (_req: Request, res: Response): void => {
  res.json(metricsService.snapshot());
});

export const diagnosticsRouter = Router();

diagnosticsRouter.get('/', (_req: Request, res: Response): void => {
  res.json(diagnosticsService.snapshot());
});
