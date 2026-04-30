import { Router, Request, Response } from 'express';
import { kiteClient } from '../kite/KiteClient.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { killSwitch, autoHaltMonitor } from '../risk/KillSwitch.js';
import { circuitBreaker } from '../risk/CircuitBreaker.js';
import { preTradeCheck } from '../risk/PreTradeCheck.js';

// =========================================
// Two health endpoints:
//
//   GET /health/live  → PUBLIC. Just confirms the process is alive.
//                       Mounted without requireApiKey in index.ts.
//                       Use this for load-balancer / external monitors.
//
//   GET /health/full  → PROTECTED. Full system state — token, accounts,
//                       kill switch, circuit breakers, rate-limit usage.
//                       Mounted with requireApiKey in index.ts.
// =========================================

const startTime = Date.now();

// ── /health/live ────────────────────────────────────────────────────────────
export const healthLiveRouter = Router();

healthLiveRouter.get('/', (_req: Request, res: Response): void => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// ── /health/full ────────────────────────────────────────────────────────────
export const healthFullRouter = Router();

healthFullRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  const kiteOk = await kiteClient.isHealthy();
  const tokenStatus = kiteClient.getTokenStatus();
  const ks = killSwitch.getStatus();

  const ok = kiteOk && !ks.halted;

  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    kiteConnected: kiteOk,
    halted: ks.halted,
    haltReason: ks.reason,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    token: {
      valid: tokenStatus.valid,
      lastRefreshedAt: tokenStatus.lastRefreshedAt,
      nextRefreshAt: tokenStatus.nextRefreshAt,
      lastError: tokenStatus.lastError,
      refreshCount: tokenStatus.refreshCount,
    },
    accounts: accountRegistry.getAllStatus(),
    risk: {
      autoHaltErrorsLastWindow: autoHaltMonitor.getRecentErrorCount(),
      circuitBreaker: circuitBreaker.getStatus(),
      rateLimits: preTradeCheck.getStatus(),
    },
  });
});
