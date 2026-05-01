import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { OrderLog, OrderStatus } from '../types.js';

// =========================================
// SQLite — source of truth
// =========================================

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function initDb(): void {
  const dbPath = path.resolve(config.db.path);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations();
  logger.info('Database initialized', { path: dbPath });
}

// ─── Errors ─────────────────────────────────────────────────────────────────
/**
 * Thrown by atomicCheckAndInsert when the same (clientIdempotencyKey, accountId)
 * pair is reused with different order parameters. The caller MUST surface this
 * to the strategy as a 422 — silently returning the cached row would corrupt
 * the strategy's view of position state.
 */
export class IdempotencyKeyReuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyKeyReuseError';
  }
}

// ─── Migrations ─────────────────────────────────────────────────────────────
function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // v1: base order_logs table
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
  `);
  recordVersion(1);

  // v2: state-machine columns
  ensureColumn('order_logs', 'account_id',             "TEXT NOT NULL DEFAULT 'master'");
  ensureColumn('order_logs', 'client_idempotency_key', 'TEXT');
  ensureColumn('order_logs', 'attempts',               'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('order_logs', 'last_attempt_at',        'TEXT');
  db.exec(`UPDATE order_logs SET client_idempotency_key = idempotency_key WHERE client_idempotency_key IS NULL`);
  db.exec(`UPDATE order_logs SET status = 'ACCEPTED' WHERE status = 'SENT'`);
  recordVersion(2);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_source         ON order_logs(source);
    CREATE INDEX IF NOT EXISTS idx_status         ON order_logs(status);
    CREATE INDEX IF NOT EXISTS idx_received_at    ON order_logs(received_at);
    CREATE INDEX IF NOT EXISTS idx_tradingsymbol  ON order_logs(tradingsymbol);
    CREATE INDEX IF NOT EXISTS idx_account_id     ON order_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_tag            ON order_logs(tag);
    CREATE INDEX IF NOT EXISTS idx_client_key     ON order_logs(client_idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_kite_order_id  ON order_logs(kite_order_id);
  `);

  // v3: kill switch
  db.exec(`
    CREATE TABLE IF NOT EXISTS kill_switch (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      halted      INTEGER NOT NULL DEFAULT 0,
      reason      TEXT,
      source      TEXT,
      updated_at  TEXT
    );
  `);
  db.exec(`INSERT OR IGNORE INTO kill_switch (id, halted) VALUES (1, 0);`);
  recordVersion(3);

  // v4: postback layer
  ensureColumn('order_logs', 'postback_confirmed_at', 'TEXT');
  ensureColumn('order_logs', 'conflict_message',      'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS postback_events (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key         TEXT    NOT NULL UNIQUE,
      received_at       TEXT    NOT NULL,
      order_id          TEXT,
      tag               TEXT,
      status            TEXT,
      filled_quantity   INTEGER,
      average_price     REAL,
      order_timestamp   TEXT,
      checksum_valid    INTEGER NOT NULL DEFAULT 0,
      matched_log_id    INTEGER,
      conflict          INTEGER NOT NULL DEFAULT 0,
      conflict_message  TEXT,
      recovery_created  INTEGER NOT NULL DEFAULT 0,
      raw_payload       TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pb_order_id ON postback_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_pb_tag      ON postback_events(tag);
    CREATE INDEX IF NOT EXISTS idx_pb_received ON postback_events(received_at);
  `);
  recordVersion(4);

  // v5: positions / PnL tables
  // ── positions ─────────────────────────────────────────────────────────
  // One row per (account_id, exchange, tradingsymbol, trade_date).
  // trade_date is an ISO date string (YYYY-MM-DD, IST) — positions reset
  // daily so MIS positions don't bleed across days. CNC/NRML "carry" via
  // restart recovery seeding from broker net positions on next startup.
  //
  // net_quantity   = signed: positive = long, negative = short
  // average_price  = cost basis of the OPEN portion only; reset to 0 when flat
  // realized_pnl   = locked-in PnL from closed trades (this trade_date)
  // last_price     = last observed price (from postback fill or external tick)
  // applied_fills_qty / total_buy_qty / total_sell_qty are running totals
  //   for diagnostics + idempotency cross-checks
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id          TEXT    NOT NULL,
      exchange            TEXT    NOT NULL,
      tradingsymbol       TEXT    NOT NULL,
      trade_date          TEXT    NOT NULL,
      net_quantity        INTEGER NOT NULL DEFAULT 0,
      average_price       REAL    NOT NULL DEFAULT 0,
      realized_pnl        REAL    NOT NULL DEFAULT 0,
      last_price          REAL,
      total_buy_qty       INTEGER NOT NULL DEFAULT 0,
      total_sell_qty      INTEGER NOT NULL DEFAULT 0,
      total_buy_value     REAL    NOT NULL DEFAULT 0,
      total_sell_value    REAL    NOT NULL DEFAULT 0,
      updated_at          TEXT    NOT NULL,
      UNIQUE (account_id, exchange, tradingsymbol, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_account ON positions(account_id);
    CREATE INDEX IF NOT EXISTS idx_pos_date    ON positions(trade_date);
    CREATE INDEX IF NOT EXISTS idx_pos_symbol  ON positions(tradingsymbol);
  `);

  // ── position_fills ────────────────────────────────────────────────────
  // Append-only ledger of fills applied to positions. The (postback_event_id,
  // delta_quantity) pair is used to make fill application idempotent — the
  // same postback delivered twice (or replayed via reconcile) must never
  // apply the same delta twice.
  //
  // delta_quantity = the INCREMENT in filled_quantity that this row applied,
  // signed by transaction direction (+ for BUY, - for SELL).
  db.exec(`
    CREATE TABLE IF NOT EXISTS position_fills (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id         INTEGER NOT NULL,
      order_log_id        INTEGER,
      postback_event_id   INTEGER,
      kite_order_id       TEXT,
      transaction_type    TEXT    NOT NULL,
      delta_quantity      INTEGER NOT NULL,
      fill_price          REAL    NOT NULL,
      cumulative_filled   INTEGER NOT NULL,
      realized_delta      REAL    NOT NULL DEFAULT 0,
      applied_at          TEXT    NOT NULL,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pf_position    ON position_fills(position_id);
    CREATE INDEX IF NOT EXISTS idx_pf_order_log   ON position_fills(order_log_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pf_postback_dedup
      ON position_fills(postback_event_id, order_log_id)
      WHERE postback_event_id IS NOT NULL;
  `);
  recordVersion(5);
}

function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info('Schema migration: column added', { table, column });
  }
}

function recordVersion(v: number): void {
  db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
    v,
    new Date().toISOString()
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function makeCompositeKey(clientKey: string, accountId: string): string {
  return `${clientKey}::${accountId}`;
}

// ─── Insert (atomic) ────────────────────────────────────────────────────────
/**
 * INSERT OR IGNORE keyed on (clientIdempotencyKey, accountId).
 *
 * Returns:
 *   - null if the row was freshly inserted (caller must place the order)
 *   - the existing OrderLog if the same key+account is being retried with the
 *     SAME order parameters (caller should return the cached result)
 *
 * Throws:
 *   - IdempotencyKeyReuseError if the same key+account is being retried with
 *     DIFFERENT order parameters. This protects strategies from silently
 *     receiving the wrong orderId for a different logical order.
 */
export function atomicCheckAndInsert(params: {
  clientIdempotencyKey: string;
  accountId: string;
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
  tag: string;
}): OrderLog | null {
  const compositeKey = makeCompositeKey(params.clientIdempotencyKey, params.accountId);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO order_logs (
      idempotency_key, client_idempotency_key, account_id,
      source, exchange, tradingsymbol, transaction_type,
      quantity, product, order_type, variety, price, trigger_price, tag,
      status, attempts, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', 0, ?)
  `);

  const result = insert.run(
    compositeKey,
    params.clientIdempotencyKey,
    params.accountId,
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
  ) as { changes: number };

  if (result.changes === 0) {
    const existing = findByCompositeKey(compositeKey);
    if (existing) {
      // CRITICAL FIX (Bug #2): detect payload divergence on idempotency-key reuse.
      // Tag is excluded — it's deterministically derived from (key, accountId)
      // and will always match. We compare the order-shape fields the strategy
      // explicitly chose.
      const mismatch =
        existing.exchange         !== params.exchange         ||
        existing.tradingsymbol    !== params.tradingsymbol    ||
        existing.transactionType  !== params.transactionType  ||
        existing.quantity         !== params.quantity         ||
        existing.product          !== params.product          ||
        existing.orderType        !== params.orderType        ||
        existing.variety          !== params.variety          ||
        (existing.price        ?? null) !== (params.price        ?? null) ||
        (existing.triggerPrice ?? null) !== (params.triggerPrice ?? null);

      if (mismatch) {
        throw new IdempotencyKeyReuseError(
          `idempotencyKey "${params.clientIdempotencyKey}" was reused with different order parameters on account "${params.accountId}". ` +
          `Original: ${existing.transactionType} ${existing.quantity} ${existing.exchange}:${existing.tradingsymbol} ` +
          `${existing.orderType}${existing.price != null ? ` @${existing.price}` : ''}. ` +
          `New: ${params.transactionType} ${params.quantity} ${params.exchange}:${params.tradingsymbol} ` +
          `${params.orderType}${params.price != null ? ` @${params.price}` : ''}.`
        );
      }
    }
    return existing;
  }
  return null;
}

// ─── State-machine update ───────────────────────────────────────────────────
export interface StatusUpdate {
  status: OrderStatus;
  kiteOrderId?: string | null;
  kiteResponse?: string | null;
  errorMessage?: string | null;
  latencyMs?: number;
  incAttempts?: boolean;
  postbackConfirmed?: boolean;
}

export function updateStatusByCompositeKey(compositeKey: string, update: StatusUpdate): void {
  const sets: string[] = ['status = ?'];
  const values: (string | number | null)[] = [update.status];

  if (update.kiteOrderId  !== undefined) { sets.push('kite_order_id = ?'); values.push(update.kiteOrderId); }
  if (update.kiteResponse !== undefined) { sets.push('kite_response = ?'); values.push(update.kiteResponse); }
  if (update.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(update.errorMessage); }
  if (update.latencyMs    !== undefined) { sets.push('latency_ms    = ?'); values.push(update.latencyMs); }
  if (update.incAttempts) { sets.push('attempts = attempts + 1'); }
  if (update.postbackConfirmed) {
    sets.push('postback_confirmed_at = ?');
    values.push(new Date().toISOString());
  }

  const terminal = update.status === 'COMPLETE'
                || update.status === 'REJECTED'
                || update.status === 'CANCELLED'
                || update.status === 'ERROR';
  if (terminal) {
    sets.push('completed_at = ?');
    values.push(new Date().toISOString());
  }

  sets.push('last_attempt_at = ?');
  values.push(new Date().toISOString());

  values.push(compositeKey);

  db.prepare(`UPDATE order_logs SET ${sets.join(', ')} WHERE idempotency_key = ?`).run(...values);
}

/**
 * Patch only metadata (orderId, latency) without touching status — used when
 * a postback has already moved the row to a terminal state during placement.
 */
export function patchPostCallMetadata(
  compositeKey: string,
  p: { kiteOrderId: string | null; latencyMs: number },
): void {
  db.prepare(`
    UPDATE order_logs
       SET kite_order_id   = COALESCE(kite_order_id, ?),
           latency_ms      = ?,
           last_attempt_at = ?
     WHERE idempotency_key = ?
  `).run(p.kiteOrderId, p.latencyMs, new Date().toISOString(), compositeKey);
}

export function setConflictMessage(compositeKey: string, message: string): void {
  db.prepare('UPDATE order_logs SET conflict_message = ? WHERE idempotency_key = ?')
    .run(message, compositeKey);
}

// ─── Lookups ────────────────────────────────────────────────────────────────
export function findByCompositeKey(compositeKey: string): OrderLog | null {
  const row = db.prepare('SELECT * FROM order_logs WHERE idempotency_key = ?').get(compositeKey) as Record<string, unknown> | undefined;
  return row ? rowToOrderLog(row) : null;
}

export function findByClientKeyAndAccount(clientKey: string, accountId: string): OrderLog | null {
  return findByCompositeKey(makeCompositeKey(clientKey, accountId));
}

export function findByTag(tag: string, accountId: string): OrderLog | null {
  const row = db.prepare('SELECT * FROM order_logs WHERE tag = ? AND account_id = ? ORDER BY id DESC LIMIT 1')
    .get(tag, accountId) as Record<string, unknown> | undefined;
  return row ? rowToOrderLog(row) : null;
}

export function findByTagAnyAccount(tag: string): OrderLog | null {
  const row = db.prepare('SELECT * FROM order_logs WHERE tag = ? ORDER BY id DESC LIMIT 1')
    .get(tag) as Record<string, unknown> | undefined;
  return row ? rowToOrderLog(row) : null;
}

export function findByKiteOrderId(orderId: string): OrderLog | null {
  const row = db.prepare('SELECT * FROM order_logs WHERE kite_order_id = ? ORDER BY id DESC LIMIT 1')
    .get(orderId) as Record<string, unknown> | undefined;
  return row ? rowToOrderLog(row) : null;
}

export function findNonTerminalSince(sinceIso: string, accountId?: string): OrderLog[] {
  const where = accountId
    ? `WHERE status IN ('RECEIVED','SUBMITTING','ACCEPTED','UNKNOWN') AND received_at >= ? AND account_id = ?`
    : `WHERE status IN ('RECEIVED','SUBMITTING','ACCEPTED','UNKNOWN') AND received_at >= ?`;
  const args = accountId ? [sinceIso, accountId] : [sinceIso];
  const rows = db.prepare(`SELECT * FROM order_logs ${where} ORDER BY id ASC`).all(...args) as Record<string, unknown>[];
  return rows.map(rowToOrderLog);
}

export function getOrderLogs(filters: {
  source?: string;
  status?: string;
  accountId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): OrderLog[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.source)    { conditions.push('source = ?');       params.push(filters.source); }
  if (filters.status)    { conditions.push('status = ?');       params.push(filters.status); }
  if (filters.accountId) { conditions.push('account_id = ?');   params.push(filters.accountId); }
  if (filters.from)      { conditions.push('received_at >= ?'); params.push(filters.from); }
  if (filters.to)        { conditions.push('received_at <= ?'); params.push(filters.to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  const rows = db
    .prepare(`SELECT * FROM order_logs ${where} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(rowToOrderLog);
}

// ─── Recovery row (postback for an unmatched order) ─────────────────────────
export function insertRecoveryRow(params: {
  kiteOrderId: string;
  tag: string | null;
  status: OrderStatus;
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
  errorMessage: string | null;
  kiteResponse: string;
  postbackConfirmed: boolean;
}): OrderLog {
  const clientKey = `recovery-${params.kiteOrderId}`;
  const accountId = 'recovery';
  const compositeKey = makeCompositeKey(clientKey, accountId);

  const existing = findByCompositeKey(compositeKey);
  if (existing) return existing;

  const now = new Date().toISOString();
  const completedAt = (params.status === 'COMPLETE' || params.status === 'REJECTED'
                    || params.status === 'CANCELLED' || params.status === 'ERROR') ? now : null;

  db.prepare(`
    INSERT OR IGNORE INTO order_logs (
      idempotency_key, client_idempotency_key, account_id,
      source, exchange, tradingsymbol, transaction_type,
      quantity, product, order_type, variety, price, trigger_price, tag,
      status, kite_order_id, kite_response, error_message,
      attempts, latency_ms, received_at, completed_at,
      postback_confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
  `).run(
    compositeKey, clientKey, accountId,
    params.source, params.exchange, params.tradingsymbol, params.transactionType,
    params.quantity, params.product, params.orderType, params.variety,
    params.price, params.triggerPrice, params.tag,
    params.status, params.kiteOrderId, params.kiteResponse, params.errorMessage,
    now, completedAt,
    params.postbackConfirmed ? now : null,
  );

  const row = findByCompositeKey(compositeKey);
  if (!row) throw new Error('Recovery row insert failed');
  return row;
}

// ─── Postback events ────────────────────────────────────────────────────────
export interface InsertPostbackResult {
  isNew: boolean;
  id: number;
}

export function insertPostbackEvent(params: {
  dedupKey: string;
  orderId: string | null;
  tag: string | null;
  status: string | null;
  filledQuantity: number | null;
  averagePrice: number | null;
  orderTimestamp: string | null;
  checksumValid: boolean;
  rawPayload: string;
}): InsertPostbackResult {
  const result = db.prepare(`
    INSERT OR IGNORE INTO postback_events (
      dedup_key, received_at, order_id, tag, status,
      filled_quantity, average_price, order_timestamp,
      checksum_valid, raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.dedupKey,
    new Date().toISOString(),
    params.orderId,
    params.tag,
    params.status,
    params.filledQuantity,
    params.averagePrice,
    params.orderTimestamp,
    params.checksumValid ? 1 : 0,
    params.rawPayload,
  ) as { changes: number; lastInsertRowid: number | bigint };

  if (result.changes === 0) {
    const existing = db.prepare('SELECT id FROM postback_events WHERE dedup_key = ?')
      .get(params.dedupKey) as { id: number } | undefined;
    return { isNew: false, id: existing?.id ?? 0 };
  }
  return { isNew: true, id: Number(result.lastInsertRowid) };
}

export function updatePostbackProcessing(
  postbackId: number,
  matchedLogId: number | null,
  conflict: boolean,
  conflictMessage: string | null,
  recoveryCreated: boolean,
): void {
  db.prepare(`
    UPDATE postback_events
       SET matched_log_id = ?, conflict = ?, conflict_message = ?, recovery_created = ?
     WHERE id = ?
  `).run(
    matchedLogId,
    conflict ? 1 : 0,
    conflictMessage,
    recoveryCreated ? 1 : 0,
    postbackId,
  );
}

// ─── Metrics aggregations ───────────────────────────────────────────────────
export interface OrderMetricsAggregate {
  total: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  avgLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
  rejectedCount: number;
  unknownCount: number;
  /** UNKNOWN orders older than `staleAgeMs` — these are the dangerous ones. */
  staleUnknownCount: number;
  conflictCount: number;
  /** Number of orders updated by reconciliation (postbackConfirmedAt IS NULL but completed). */
  reconciledCount: number;
}

/**
 * Aggregate order metrics for a time window. `sinceIso` is inclusive lower bound
 * on `received_at`. Includes only "real" orders (excludes recovery rows by default).
 */
export function aggregateOrderMetrics(sinceIso: string, staleUnknownAgeMs: number): OrderMetricsAggregate {
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS c FROM order_logs
     WHERE received_at >= ? AND account_id != 'recovery'
  `).get(sinceIso) as { c: number };

  const statusRows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM order_logs
     WHERE received_at >= ? AND account_id != 'recovery'
     GROUP BY status
  `).all(sinceIso) as Array<{ status: string; c: number }>;

  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) AS c FROM order_logs
     WHERE received_at >= ? AND account_id != 'recovery'
     GROUP BY source
  `).all(sinceIso) as Array<{ source: string; c: number }>;

  // Latency stats only for orders that actually got placed (latency_ms > 0).
  const latencyRow = db.prepare(`
    SELECT AVG(latency_ms) AS avg, MAX(latency_ms) AS max
      FROM order_logs
     WHERE received_at >= ? AND account_id != 'recovery' AND latency_ms > 0
  `).get(sinceIso) as { avg: number | null; max: number | null };

  // p95 via SQLite ordered scan — fine at order_logs scale (<<100k/day).
  const latencies = db.prepare(`
    SELECT latency_ms FROM order_logs
     WHERE received_at >= ? AND account_id != 'recovery' AND latency_ms > 0
     ORDER BY latency_ms ASC
  `).all(sinceIso) as Array<{ latency_ms: number }>;
  let p95 = 0;
  if (latencies.length > 0) {
    const idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
    p95 = latencies[idx]!.latency_ms;
  }

  const staleCutoff = new Date(Date.now() - staleUnknownAgeMs).toISOString();
  const staleUnknown = db.prepare(`
    SELECT COUNT(*) AS c FROM order_logs
     WHERE status = 'UNKNOWN'
       AND received_at < ?
       AND account_id != 'recovery'
  `).get(staleCutoff) as { c: number };

  const conflict = db.prepare(`
    SELECT COUNT(*) AS c FROM order_logs
     WHERE conflict_message IS NOT NULL AND received_at >= ?
  `).get(sinceIso) as { c: number };

  // Reconciled = terminal but no postback confirmation (best-effort proxy).
  const reconciled = db.prepare(`
    SELECT COUNT(*) AS c FROM order_logs
     WHERE received_at >= ?
       AND account_id != 'recovery'
       AND completed_at IS NOT NULL
       AND postback_confirmed_at IS NULL
       AND status IN ('COMPLETE', 'CANCELLED', 'REJECTED', 'ERROR')
  `).get(sinceIso) as { c: number };

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.c;
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.source] = r.c;

  return {
    total: totalRow.c,
    byStatus,
    bySource,
    avgLatencyMs: Math.round(latencyRow.avg ?? 0),
    maxLatencyMs: latencyRow.max ?? 0,
    p95LatencyMs: p95,
    rejectedCount:     byStatus['REJECTED'] ?? 0,
    unknownCount:      byStatus['UNKNOWN']  ?? 0,
    staleUnknownCount: staleUnknown.c,
    conflictCount:     conflict.c,
    reconciledCount:   reconciled.c,
  };
}

export interface PostbackMetricsAggregate {
  totalReceived: number;
  duplicateCount: number;
  conflictCount: number;
  recoveryCount: number;
  invalidChecksumCount: number;
  /** Most recent postback received_at (ISO string) or null. */
  lastReceivedAt: string | null;
  /** Avg ms between order_logs.last_attempt_at and matched postback_events.received_at. */
  avgPostbackDelayMs: number | null;
}

export function aggregatePostbackMetrics(sinceIso: string): PostbackMetricsAggregate {
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM postback_events WHERE received_at >= ?`)
    .get(sinceIso) as { c: number };

  const conflictRow = db.prepare(`
    SELECT COUNT(*) AS c FROM postback_events WHERE received_at >= ? AND conflict = 1
  `).get(sinceIso) as { c: number };

  const recoveryRow = db.prepare(`
    SELECT COUNT(*) AS c FROM postback_events WHERE received_at >= ? AND recovery_created = 1
  `).get(sinceIso) as { c: number };

  const invalidRow = db.prepare(`
    SELECT COUNT(*) AS c FROM postback_events WHERE received_at >= ? AND checksum_valid = 0
  `).get(sinceIso) as { c: number };

  // Duplicates aren't stored; count = approximated as 0 (INSERT OR IGNORE
  // dropped them before they could be inserted). Real signal lives in logs.
  const lastRow = db.prepare(`
    SELECT received_at FROM postback_events ORDER BY id DESC LIMIT 1
  `).get() as { received_at: string } | undefined;

  // Postback delay = postback_events.received_at − order_logs.last_attempt_at
  // for matched rows where both timestamps exist. Cheap because we have indexes.
  const delayRow = db.prepare(`
    SELECT AVG((julianday(p.received_at) - julianday(o.last_attempt_at)) * 86400000.0) AS d
      FROM postback_events p
      JOIN order_logs o ON o.id = p.matched_log_id
     WHERE p.received_at >= ?
       AND p.matched_log_id IS NOT NULL
       AND o.last_attempt_at IS NOT NULL
  `).get(sinceIso) as { d: number | null };

  return {
    totalReceived:        totalRow.c,
    duplicateCount:       0, // not persisted — see comment above
    conflictCount:        conflictRow.c,
    recoveryCount:        recoveryRow.c,
    invalidChecksumCount: invalidRow.c,
    lastReceivedAt:       lastRow?.received_at ?? null,
    avgPostbackDelayMs:   delayRow.d != null && Number.isFinite(delayRow.d)
                            ? Math.round(delayRow.d)
                            : null,
  };
}

/**
 * Boot-time snapshot of postback persistence state. Used by runtimeMetrics
 * to avoid a false NO_POSTBACKS alert on the first /metrics tick after a
 * mid-day restart.
 */
export function getPostbackBootSnapshot(): { lastReceivedAt: string | null; countToday: number } {
  const last = db.prepare(`SELECT received_at FROM postback_events ORDER BY id DESC LIMIT 1`)
    .get() as { received_at: string } | undefined;

  // Today (IST) midnight in UTC ISO — same window logic as MetricsService.
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const tradeDate = istNow.toISOString().slice(0, 10);
  const istMidnight = new Date(`${tradeDate}T00:00:00+05:30`).toISOString();
  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM postback_events WHERE received_at >= ?`)
    .get(istMidnight) as { c: number };

  return {
    lastReceivedAt: last?.received_at ?? null,
    countToday: countRow.c,
  };
}

/** Cheap probe — verifies SQLite is responsive for both reads and writes. */
export function dbHealthProbe(): { readOk: boolean; writeOk: boolean; errorMessage: string | null } {
  try {
    const r = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    if (r?.ok !== 1) return { readOk: false, writeOk: false, errorMessage: 'unexpected SELECT result' };
  } catch (err) {
    return { readOk: false, writeOk: false, errorMessage: String(err) };
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_probe (id INTEGER PRIMARY KEY CHECK (id = 1), ts TEXT NOT NULL);
    `);
    db.prepare(`
      INSERT INTO health_probe (id, ts) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts
    `).run(new Date().toISOString());
    return { readOk: true, writeOk: true, errorMessage: null };
  } catch (err) {
    return { readOk: true, writeOk: false, errorMessage: String(err) };
  }
}

// ─── Daily housekeeping ─────────────────────────────────────────────────────
export function pruneOldOrders(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  const result = db.prepare('DELETE FROM order_logs WHERE received_at < ?').run(cutoff) as { changes: number };
  return result.changes;
}

// ─── Kill switch ────────────────────────────────────────────────────────────
export interface KillSwitchRow {
  halted: boolean;
  reason: string | null;
  source: string | null;
  updatedAt: string | null;
}

export function getKillSwitch(): KillSwitchRow {
  const row = db.prepare('SELECT halted, reason, source, updated_at FROM kill_switch WHERE id = 1').get() as
    | { halted: number; reason: string | null; source: string | null; updated_at: string | null }
    | undefined;
  if (!row) return { halted: false, reason: null, source: null, updatedAt: null };
  return {
    halted: row.halted === 1,
    reason: row.reason,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

export function setKillSwitch(halted: boolean, reason: string | null, source: string | null): void {
  db.prepare(`
    UPDATE kill_switch SET halted = ?, reason = ?, source = ?, updated_at = ? WHERE id = 1
  `).run(halted ? 1 : 0, reason, source, new Date().toISOString());
}

// ─── Positions ──────────────────────────────────────────────────────────────
export interface PositionRow {
  id: number;
  accountId: string;
  exchange: string;
  tradingsymbol: string;
  tradeDate: string;
  netQuantity: number;
  averagePrice: number;
  realizedPnl: number;
  lastPrice: number | null;
  totalBuyQty: number;
  totalSellQty: number;
  totalBuyValue: number;
  totalSellValue: number;
  updatedAt: string;
}

function rowToPosition(row: Record<string, unknown>): PositionRow {
  return {
    id:             row.id              as number,
    accountId:      row.account_id      as string,
    exchange:       row.exchange        as string,
    tradingsymbol:  row.tradingsymbol   as string,
    tradeDate:      row.trade_date      as string,
    netQuantity:    row.net_quantity    as number,
    averagePrice:   row.average_price   as number,
    realizedPnl:    row.realized_pnl    as number,
    lastPrice:      row.last_price      as number | null,
    totalBuyQty:    row.total_buy_qty   as number,
    totalSellQty:   row.total_sell_qty  as number,
    totalBuyValue:  row.total_buy_value as number,
    totalSellValue: row.total_sell_value as number,
    updatedAt:      row.updated_at      as string,
  };
}

/** Find or create a position row for (account, exchange, symbol, date). */
export function upsertPositionRow(
  accountId: string,
  exchange: string,
  tradingsymbol: string,
  tradeDate: string,
): PositionRow {
  const existing = db.prepare(`
    SELECT * FROM positions
     WHERE account_id = ? AND exchange = ? AND tradingsymbol = ? AND trade_date = ?
  `).get(accountId, exchange, tradingsymbol, tradeDate) as Record<string, unknown> | undefined;
  if (existing) return rowToPosition(existing);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO positions (account_id, exchange, tradingsymbol, trade_date, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(accountId, exchange, tradingsymbol, tradeDate, now);

  const fresh = db.prepare(`
    SELECT * FROM positions
     WHERE account_id = ? AND exchange = ? AND tradingsymbol = ? AND trade_date = ?
  `).get(accountId, exchange, tradingsymbol, tradeDate) as Record<string, unknown>;
  return rowToPosition(fresh);
}

export function getPositionById(id: number): PositionRow | null {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPosition(row) : null;
}

export function listPositionsForDate(tradeDate: string): PositionRow[] {
  const rows = db.prepare(`
    SELECT * FROM positions WHERE trade_date = ? ORDER BY account_id, tradingsymbol
  `).all(tradeDate) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

export function updatePositionRow(p: PositionRow): void {
  db.prepare(`
    UPDATE positions
       SET net_quantity     = ?,
           average_price    = ?,
           realized_pnl     = ?,
           last_price       = ?,
           total_buy_qty    = ?,
           total_sell_qty   = ?,
           total_buy_value  = ?,
           total_sell_value = ?,
           updated_at       = ?
     WHERE id = ?
  `).run(
    p.netQuantity,
    p.averagePrice,
    p.realizedPnl,
    p.lastPrice,
    p.totalBuyQty,
    p.totalSellQty,
    p.totalBuyValue,
    p.totalSellValue,
    new Date().toISOString(),
    p.id,
  );
}

export function updateLastPrice(positionId: number, lastPrice: number): void {
  db.prepare('UPDATE positions SET last_price = ?, updated_at = ? WHERE id = ?')
    .run(lastPrice, new Date().toISOString(), positionId);
}

// ─── Position fills ─────────────────────────────────────────────────────────
export interface PositionFillRow {
  id: number;
  positionId: number;
  orderLogId: number | null;
  postbackEventId: number | null;
  kiteOrderId: string | null;
  transactionType: string;
  deltaQuantity: number;
  fillPrice: number;
  cumulativeFilled: number;
  realizedDelta: number;
  appliedAt: string;
}

/** Returns the cumulative_filled most recently applied for a given orderLogId. */
export function getLastCumulativeFilled(orderLogId: number): number {
  const row = db.prepare(`
    SELECT cumulative_filled FROM position_fills
     WHERE order_log_id = ?
     ORDER BY id DESC LIMIT 1
  `).get(orderLogId) as { cumulative_filled: number } | undefined;
  return row?.cumulative_filled ?? 0;
}

/**
 * Returns the cumulative VALUE (sum of |deltaQty| * fillPrice) booked so far
 * for a given orderLogId. Used to derive the MARGINAL fill price from a
 * cumulative postback: marginalPrice = (cumQty*postbackAvg - priorValue) / deltaQty.
 */
export function getCumulativeFillValue(orderLogId: number): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(ABS(delta_quantity) * fill_price), 0) AS value
      FROM position_fills WHERE order_log_id = ?
  `).get(orderLogId) as { value: number } | undefined;
  return row?.value ?? 0;
}

export interface InsertFillResult {
  applied: boolean;
  fillId: number;
}

/**
 * Insert a fill row idempotently. The (postback_event_id, order_log_id)
 * unique index protects against double-application of the same postback.
 *
 * Returns { applied: false } if the fill was already applied.
 */
export function insertPositionFill(p: {
  positionId: number;
  orderLogId: number | null;
  postbackEventId: number | null;
  kiteOrderId: string | null;
  transactionType: string;
  deltaQuantity: number;
  fillPrice: number;
  cumulativeFilled: number;
  realizedDelta: number;
}): InsertFillResult {
  try {
    const result = db.prepare(`
      INSERT INTO position_fills (
        position_id, order_log_id, postback_event_id, kite_order_id,
        transaction_type, delta_quantity, fill_price,
        cumulative_filled, realized_delta, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      p.positionId,
      p.orderLogId,
      p.postbackEventId,
      p.kiteOrderId,
      p.transactionType,
      p.deltaQuantity,
      p.fillPrice,
      p.cumulativeFilled,
      p.realizedDelta,
      new Date().toISOString(),
    ) as { lastInsertRowid: number | bigint };
    return { applied: true, fillId: Number(result.lastInsertRowid) };
  } catch (err) {
    // UNIQUE violation on (postback_event_id, order_log_id) → already applied
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      return { applied: false, fillId: 0 };
    }
    throw err;
  }
}

/** Run callback inside a transaction. Used to make fill+position update atomic. */
export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Row mapper ─────────────────────────────────────────────────────────────
function rowToOrderLog(row: Record<string, unknown>): OrderLog {
  return {
    id: row.id as number,
    idempotencyKey: row.idempotency_key as string,
    clientIdempotencyKey: (row.client_idempotency_key as string) ?? (row.idempotency_key as string),
    accountId: (row.account_id as string) ?? 'master',
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
    attempts: (row.attempts as number) ?? 0,
    latencyMs: row.latency_ms as number,
    receivedAt: row.received_at as string,
    lastAttemptAt: row.last_attempt_at as string | null,
    completedAt: row.completed_at as string | null,
    postbackConfirmedAt: (row.postback_confirmed_at as string | null) ?? null,
    conflictMessage:     (row.conflict_message     as string | null) ?? null,
  };
}
