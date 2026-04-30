import { Router, Request, Response } from 'express';
import { killSwitch, autoHaltMonitor } from '../risk/KillSwitch.js';
import { circuitBreaker } from '../risk/CircuitBreaker.js';
import { preTradeCheck } from '../risk/PreTradeCheck.js';
import { logger } from '../logger.js';

// =========================================
// Admin / risk control endpoints.
// All require X-API-Key (mounted under requireApiKey in index.ts).
// =========================================

export const adminRouter = Router();

// ── Kill switch ─────────────────────────────────────────────────────────────
adminRouter.post('/halt', (req: Request, res: Response) => {
  const { reason } = (req.body ?? {}) as { reason?: string };
  const finalReason = (reason && reason.trim()) || 'manual halt (no reason given)';
  killSwitch.halt(finalReason, 'manual');
  logger.warn('Manual kill switch engaged', { reason: finalReason });
  res.json({ ok: true, halted: true, reason: finalReason });
});

adminRouter.post('/resume', (_req: Request, res: Response) => {
  killSwitch.resume('manual');
  logger.info('Manual kill switch disengaged');
  res.json({ ok: true, halted: false });
});

// ── Status ──────────────────────────────────────────────────────────────────
adminRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    killSwitch: killSwitch.getStatus(),
    autoHalt: { recentErrors: autoHaltMonitor.getRecentErrorCount() },
    circuitBreaker: circuitBreaker.getStatus(),
    rateLimits: preTradeCheck.getStatus(),
  });
});
