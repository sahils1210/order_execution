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

  io.on('connection', (socket) => {
    logger.debug('UI client connected', { id: socket.id });
    socket.on('disconnect', () => {
      logger.debug('UI client disconnected', { id: socket.id });
    });
  });

  logger.info('WebSocket server initialized');
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

export function emitOrderUpdate(event: OrderUpdateEvent): void {
  if (!io) return;
  io.emit('order:update', event);
}

export function emitTokenStatus(event: TokenStatusEvent): void {
  if (!io) return;
  io.emit('token:status', event);
}
