import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { OrderLog, OrderStatus } from '../types.js';

// =========================================
// SQLite Database — Order Log Storage
//
// Uses Node.js 22 built-in node:sqlite (no npm deps, no compilation).
//
// Why SQLite:
// - Zero external dependencies
// - Single file, trivial backup
// - ACID compliant — no data loss on crash
// - Sufficient for trading day volumes (1000s of orders)
// =========================================

let db: DatabaseSync;

export function initDb(): void {
  const dbPath = path.resolve(config.db.path);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);

  // WAL mode: concurrent reads without blocking writes
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations();
  logger.info('Database initialized', { path: dbPath });
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key  TEXT    NOT NULL UNIQUE,
      source           TEXT    NOT NULL,
      exchange         TEXT    NOT NULL,
      tradingsymbol    TEXT    NOT NULL,
      transaction_type TEXT    NOT NULL,
      quantity         INTEGER NOT NULL,
      product          TEXT    NOT NULL,
      order_type       TEXT    NOT NULL,
      variety          TEXT    NOT NULL DEFAULT 'regular',
      price            REAL,
      trigger_price    REAL,
      tag              TEXT,
      status           TEXT    NOT NULL DEFAULT 'RECEIVED',
      kite_order_id    TEXT,
      kite_response    TEXT,
      error_message    TEXT,
      latency_ms       INTEGER NOT NULL DEFAULT 0,
      received_at      TEXT    NOT NULL,
      completed_at     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_source        ON order_logs(source);
    CREATE INDEX IF NOT EXISTS idx_status        ON order_logs(status);
    CREATE INDEX IF NOT EXISTS idx_received_at   ON order_logs(received_at);
    CREATE INDEX IF NOT EXISTS idx_tradingsymbol ON order_logs(tradingsymbol);
  `);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function insertOrderLog(params: {
  idempotencyKey: string;
  source: string;
  exchange: string;
  tradingsymbol: string;
  transactionType: string;
  quantity: number;
  product: string;
  orderType: string;
  variety: string;
  price: number | null;
  triggerPrice: number | null;
  tag: string | null;
}): void {
  const stmt = db.prepare(`
    INSERT INTO order_logs (
      idempotency_key, source, exchange, tradingsymbol, transaction_type,
      quantity, product, order_type, variety, price, trigger_price, tag,
      status, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?)
  `);

  stmt.run(
    params.idempotencyKey,
    params.source,
    params.exchange,
    params.tradingsymbol,
    params.transactionType,
    params.quantity,
    params.product,
    params.orderType,
    params.variety,
    params.price,
    params.triggerPrice,
    params.tag,
    new Date().toISOString()
  );
}

export function updateOrderLog(params: {
  idempotencyKey: string;
  status: OrderStatus;
  kiteOrderId: string | null;
  kiteResponse: string | null;
  errorMessage: string | null;
  latencyMs: number;
}): void {
  const stmt = db.prepare(`
    UPDATE order_logs SET
      status        = ?,
      kite_order_id = ?,
      kite_response = ?,
      error_message = ?,
      latency_ms    = ?,
      completed_at  = ?
    WHERE idempotency_key = ?
  `);

  stmt.run(
    params.status,
    params.kiteOrderId,
    params.kiteResponse,
    params.errorMessage,
    params.latencyMs,
    new Date().toISOString(),
    params.idempotencyKey
  );
}

export function getOrderLogs(filters: {
  source?: string;
  status?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): OrderLog[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.source) { conditions.push('source = ?'); params.push(filters.source); }
  if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters.from)   { conditions.push('received_at >= ?'); params.push(filters.from); }
  if (filters.to)     { conditions.push('received_at <= ?'); params.push(filters.to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  params.push(limit, offset);

  const rows = db
    .prepare(`SELECT * FROM order_logs ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(rowToOrderLog);
}

export function findByIdempotencyKey(key: string): OrderLog | null {
  const row = db
    .prepare('SELECT * FROM order_logs WHERE idempotency_key = ?')
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToOrderLog(row) : null;
}

function rowToOrderLog(row: Record<string, unknown>): OrderLog {
  return {
    id: row.id as number,
    idempotencyKey: row.idempotency_key as string,
    source: row.source as string,
    exchange: row.exchange as OrderLog['exchange'],
    tradingsymbol: row.tradingsymbol as string,
    transactionType: row.transaction_type as OrderLog['transactionType'],
    quantity: row.quantity as number,
    product: row.product as OrderLog['product'],
    orderType: row.order_type as OrderLog['orderType'],
    variety: row.variety as OrderLog['variety'],
    price: row.price as number | null,
    triggerPrice: row.trigger_price as number | null,
    tag: row.tag as string | null,
    status: row.status as OrderLog['status'],
    kiteOrderId: row.kite_order_id as string | null,
    kiteResponse: row.kite_response as string | null,
    errorMessage: row.error_message as string | null,
    latencyMs: row.latency_ms as number,
    receivedAt: row.received_at as string,
    completedAt: row.completed_at as string | null,
  };
}
