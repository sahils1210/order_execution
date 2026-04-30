import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { initDb } from './db/database.js';
import { kiteClient } from './kite/KiteClient.js';
import { accountRegistry, parseAccountDefs } from './kite/AccountRegistry.js';
import { initWebSocket, emitTokenStatus } from './websocket.js';
import { requireApiKey } from './middleware/auth.js';
import { orderRouter } from './routes/order.js';
import { orderActionsRouter } from './routes/orderActions.js';
import { ordersRouter } from './routes/orders.js';
import { healthLiveRouter, healthFullRouter } from './routes/health.js';
import { orderMultiRouter } from './routes/orderMulti.js';
import { adminRouter } from './routes/admin.js';
import { webhookRouter } from './routes/webhook.js';
import { killSwitch } from './risk/KillSwitch.js';
import { reconciler } from './oms/Reconciler.js';
import { alertAsync } from './alerts/Telegram.js';

async function main(): Promise<void> {
  initDb();
  killSwitch.initialize();
  await kiteClient.initialize();

  const accountDefs = parseAccountDefs();
  if (accountDefs.length > 0) {
    await accountRegistry.initialize(accountDefs);
  }

  const app = express();

  // Webhook is mounted FIRST so it bypasses the global JSON parser and auth.
  app.use('/webhook', webhookRouter);

  app.use(express.json({ limit: '16kb' }));
  app.use(cors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
  }));

  // ── Health endpoints ────────────────────────────────────────────────────
  // /health/live is PUBLIC — for load balancers / external monitors.
  // /health/full is PROTECTED — full state, requires X-API-Key.
  app.use('/health/live',                  healthLiveRouter);
  app.use('/health/full', requireApiKey,   healthFullRouter);

  // ── Authenticated API routes ────────────────────────────────────────────
  app.use('/order/multi', requireApiKey, orderMultiRouter);
  app.use('/order',       requireApiKey, orderActionsRouter); // DELETE/PATCH /:id
  app.use('/order',       requireApiKey, orderRouter);        // POST /
  app.use('/orders',      requireApiKey, ordersRouter);
  app.use('/admin',       requireApiKey, adminRouter);

  app.post('/refresh-token', requireApiKey, async (_req, res) => {
    try {
      await kiteClient.refreshToken();
      const status = kiteClient.getTokenStatus();
      res.json({ success: true, message: 'Token refreshed and validated', token: status });
    } catch (err) {
      const status = kiteClient.getTokenStatus();
      res.status(500).json({ success: false, message: String(err), token: status });
    }
  });

  // ── UI dashboard — only return SPA shell for non-API paths ──────────────
  const uiDist = path.join(process.cwd(), 'ui', 'dist');
  app.use(express.static(uiDist));
  const apiPrefixes = ['/order', '/orders', '/admin', '/health', '/refresh-token', '/webhook'];
  app.get('*', (req, res, next) => {
    if (apiPrefixes.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      res.status(404).json({ error: 'Not found', path: req.path });
      return;
    }
    res.sendFile(path.join(uiDist, 'index.html'), (err) => err ? next(err) : undefined);
  });

  // ── HTTP + WebSocket ────────────────────────────────────────────────────
  const server = http.createServer(app);
  server.on('connection', (socket) => { socket.setKeepAlive(true, 30_000); });
  initWebSocket(server);

  kiteClient.emitStatusUpdate = () => {
    emitTokenStatus(kiteClient.getTokenStatus());
  };

  server.listen(config.port, () => {
    logger.info('Order Gateway running', { port: config.port, env: config.nodeEnv });
  });

  // ── Reconciler ──────────────────────────────────────────────────────────
  reconciler.reconcileOnStartup()
    .catch((err) => logger.error('Startup reconcile failed', { error: String(err) }))
    .finally(() => reconciler.start());

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = (sig: string) => {
    logger.info('Shutdown signal received', { sig });
    reconciler.stop();
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    const msg = String(reason);
    logger.error('UNHANDLED REJECTION', { reason: msg });
    alertAsync('critical', 'Unhandled promise rejection', msg);
  });
  process.on('uncaughtException', (err) => {
    const stack = err.stack ?? String(err);
    logger.error('UNCAUGHT EXCEPTION', { error: String(err), stack });
    alertAsync('critical', 'Uncaught exception — process will exit', stack);
    // Let the process exit; PM2 restarts.
    setTimeout(() => process.exit(1), 500).unref();
  });
}

main().catch((err) => {
  const stack = err instanceof Error ? err.stack ?? String(err) : String(err);
  logger.error('Fatal startup error', { error: stack });
  alertAsync('critical', 'Gateway failed to start', stack);
  process.exit(1);
});
