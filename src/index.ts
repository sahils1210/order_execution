import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';
import { initDb, clearPreviousDayOrders } from './db/database.js';
import { kiteClient } from './kite/KiteClient.js';
import { accountRegistry, parseAccountDefs } from './kite/AccountRegistry.js';
import { initWebSocket, emitTokenStatus } from './websocket.js';
import { requireApiKey } from './middleware/auth.js';
import { orderRouter } from './routes/order.js';
import { orderActionsRouter } from './routes/orderActions.js';
import { ordersRouter } from './routes/orders.js';
import { healthRouter } from './routes/health.js';
import { orderMultiRouter } from './routes/orderMulti.js';

async function main(): Promise<void> {
  // ── 1. Database ──────────────────────────────────────────────────────────
  initDb();

  // ── 2. Kite Client ───────────────────────────────────────────────────────
  await kiteClient.initialize();

  // ── 2b. Multi-account registry (optional — skipped if ACCOUNTS_JSON not set)
  const accountDefs = parseAccountDefs();
  if (accountDefs.length > 0) {
    await accountRegistry.initialize(accountDefs);
  }

  // ── 3. Express App ───────────────────────────────────────────────────────
  const app = express();

  app.use(express.json({ limit: '16kb' }));
  app.use(cors({
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'X-API-Key'],
  }));
  app.use((_req, res, next) => {
    res.setHeader('Connection', 'keep-alive');
    next();
  });

  // ── 4. API Routes ────────────────────────────────────────────────────────
  app.use('/order/multi', requireApiKey, orderMultiRouter);
  app.use('/order', requireApiKey, orderActionsRouter); // DELETE /:id, PATCH /:id
  app.use('/order', requireApiKey, orderRouter);        // POST /
  app.use('/orders', requireApiKey, ordersRouter);
  app.use('/health', healthRouter);

  // Token refresh endpoint — callable from UI button or curl
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

  // ── 5. UI Dashboard static files ─────────────────────────────────────────
  const uiDist = path.join(process.cwd(), 'ui', 'dist');
  app.use(express.static(uiDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(uiDist, 'index.html'));
  });

  // ── 6. HTTP Server + WebSocket ───────────────────────────────────────────
  const server = http.createServer(app);
  server.on('connection', (socket) => { socket.setKeepAlive(true, 30_000); });

  initWebSocket(server);

  // Wire KiteClient to emit token status changes to UI in real-time
  kiteClient.emitStatusUpdate = () => {
    emitTokenStatus(kiteClient.getTokenStatus());
  };

  server.listen(config.port, () => {
    logger.info('Order Gateway running', { port: config.port, env: config.nodeEnv });
  });

  // ── 7. Daily order log cleanup at 09:00 IST ─────────────────────────────
  scheduleDailyCleanup();

  // ── 8. Graceful shutdown ─────────────────────────────────────────────────
  process.on('SIGTERM', () => shutdown(server));
  process.on('SIGINT', () => shutdown(server));
}

function scheduleDailyCleanup(): void {
  const schedule = () => {
    const now = new Date();
    // 09:00 IST = 03:30 UTC
    const target = new Date(now);
    target.setUTCHours(3, 30, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);

    const ms = target.getTime() - now.getTime();
    setTimeout(() => {
      const deleted = clearPreviousDayOrders();
      logger.info('Daily order log cleanup', { deletedRows: deleted });
      schedule(); // schedule next day
    }, ms);

    logger.info('Daily order cleanup scheduled', { atIST: '09:00', inHours: +(ms / 3600000).toFixed(1) });
  };
  schedule();
}

function shutdown(server: http.Server): void {
  logger.info('Shutting down...');
  server.close(() => { logger.info('Server closed'); process.exit(0); });
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: String(err) });
  process.exit(1);
});
