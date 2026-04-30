import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { logger } from './logger.js';

let io: SocketIOServer | null = null;

export function initWebSocket(server: HttpServer): void {
  io = new SocketIOServer(server, {
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // ── API-key authentication ────────────────────────────────────────────────
  // Clients connect with one of:
  //   const socket = io({ auth: { apiKey: '...' } });
  //   const socket = io({ extraHeaders: { 'X-API-Key': '...' } });   // polling only
  //   const socket = io('?apiKey=...');                              // query param
  //
  // Set WS_REQUIRE_API_KEY=false to disable (development only).
  if (config.ws.requireApiKey) {
    io.use((socket, next) => {
      const handshake = socket.handshake;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const auth = (handshake.auth as Record<string, unknown> | undefined) ?? {};
      const headerKey = handshake.headers['x-api-key'] as string | undefined;
      const queryKey  = handshake.query['apiKey']      as string | undefined;
      const provided  = (auth.apiKey as string | undefined) ?? headerKey ?? queryKey;

      if (!provided || provided !== config.gatewayApiKey) {
        logger.warn('Socket.IO connection rejected — missing/invalid API key', {
          id: socket.id,
          remoteAddress: handshake.address,
        });
        next(new Error('Unauthorized: missing or invalid API key'));
        return;
      }
      next();
    });
  }

  io.on('connection', (socket) => {
    logger.debug('UI client connected', { id: socket.id });
    socket.on('disconnect', () => {
      logger.debug('UI client disconnected', { id: socket.id });
    });
  });

  logger.info('WebSocket server initialized', { authRequired: config.ws.requireApiKey });
}

export interface OrderUpdateEvent {
  idempotencyKey: string;
  source: string;
  tradingsymbol: string;
  transactionType: string;
  quantity: number;
  status: string;
  kiteOrderId: string | null;
  errorMessage: string | null;
  latencyMs: number;
  receivedAt: string;
}

export interface TokenStatusEvent {
  valid: boolean;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  refreshCount: number;
}

export interface OrderConflictEvent {
  idempotencyKey: string;
  kiteOrderId: string | null;
  tag: string | null;
  source: string;
  tradingsymbol: string;
  dbStatus: string;
  postbackStatus: string;
  message: string;
  detectedAt: string;
}

export function emitOrderUpdate(event: OrderUpdateEvent): void {
  if (!io) return;
  io.emit('order:update', event);
}

export function emitTokenStatus(event: TokenStatusEvent): void {
  if (!io) return;
  io.emit('token:status', event);
}

export function emitOrderConflict(event: OrderConflictEvent): void {
  if (!io) return;
  io.emit('order:conflict', event);
}
