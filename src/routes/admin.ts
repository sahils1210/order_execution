import { Router, Request, Response } from 'express';
import { killSwitch, autoHaltMonitor } from '../risk/KillSwitch.js';
import { circuitBreaker } from '../risk/CircuitBreaker.js';
import { preTradeCheck } from '../risk/PreTradeCheck.js';
import { tradingMode } from '../risk/TradingMode.js';
import { logger } from '../logger.js';
import type { TradingMode as TradingModeT } from '../db/database.js';

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
    tradingMode: tradingMode.getStatus(),
  });
});

// ── Trading mode (Design B binary toggle) ──────────────────────────────────
adminRouter.get('/mode', (_req: Request, res: Response) => {
  res.json(tradingMode.getStatus());
});

adminRouter.post('/mode', (req: Request, res: Response) => {
  const { mode, reason } = (req.body ?? {}) as { mode?: string; reason?: string };
  if (mode !== 'live' && mode !== 'dry-run') {
    res.status(400).json({
      ok: false,
      message: 'body.mode must be "live" or "dry-run"',
    });
    return;
  }
  const finalReason = (reason && reason.trim()) || `manual switch (no reason given)`;
  const result = tradingMode.setMode(mode as TradingModeT, finalReason, 'admin-api');
  logger.warn('Trading mode change via /admin/mode', { from: result.from, to: result.to, reason: finalReason });
  res.json({
    ok: true,
    changed: result.changed,
    from: result.from,
    to: result.to,
    status: tradingMode.getStatus(),
  });
});
