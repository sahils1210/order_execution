// =========================================
// Order Gateway — Shared Types
// =========================================

export type OrderSource = string;

/**
 * Order state machine.
 *
 *   RECEIVED   — row inserted, no Kite attempt yet
 *   SUBMITTING — actively calling Kite placeOrder()
 *   ACCEPTED   — Kite returned an order_id (order is in Kite's books)
 *   COMPLETE   — filled (from postback / reconciliation)
 *   REJECTED   — Kite rejected the order (real reject — bad symbol, RMS, lot size)
 *   CANCELLED  — cancelled via API or by user
 *   UNKNOWN    — outcome unknown (timeout / mid-flight reset) — must be reconciled
 *   ERROR      — never reached Kite (input invalid, connection refused before send)
 *
 * Allowed transitions:
 *   RECEIVED   → SUBMITTING | ERROR
 *   SUBMITTING → ACCEPTED | REJECTED | UNKNOWN | ERROR
 *   ACCEPTED   → COMPLETE | CANCELLED | REJECTED
 *   UNKNOWN    → ACCEPTED | COMPLETE | REJECTED | CANCELLED | ERROR
 *   COMPLETE / REJECTED / CANCELLED / ERROR are terminal
 */
export type OrderStatus =
  | 'RECEIVED'
  | 'SUBMITTING'
  | 'ACCEPTED'
  | 'COMPLETE'
  | 'REJECTED'
  | 'CANCELLED'
  | 'UNKNOWN'
  | 'ERROR';

export type TransactionType = 'BUY' | 'SELL';
export type Exchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS';
export type Product = 'CNC' | 'MIS' | 'NRML';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type Variety = 'regular' | 'amo' | 'co' | 'iceberg';

// ── Incoming request from a strategy / UI ───────────────────────────────────
export interface OrderRequest {
  idempotencyKey: string;          // client-generated UUID; same key for retries
  source: OrderSource;             // "100-ALGO" | "ultra-order" | etc.
  exchange: Exchange;
  tradingsymbol: string;
  transactionType: TransactionType;
  quantity: number;
  product: Product;
  orderType: OrderType;
  variety?: Variety;
  price?: number;
  triggerPrice?: number;
  // NOTE: client-supplied `tag` is intentionally ignored — gateway owns the tag for reconciliation.
}

// ── Response to client ──────────────────────────────────────────────────────
export interface OrderResponse {
  success: boolean;
  status?: OrderStatus;
  orderId?: string;
  message?: string;
  latencyMs: number;
}

// ── DB row shape ────────────────────────────────────────────────────────────
export interface OrderLog {
  id: number;
  idempotencyKey: string;          // internal composite key (`${client}::${account}`)
  clientIdempotencyKey: string;    // original key supplied by the strategy
  accountId: string;               // 'master' | 'huf' | 'recovery' (for orphan postbacks)
  source: OrderSource;
  exchange: Exchange;
  tradingsymbol: string;
  transactionType: TransactionType;
  quantity: number;
  product: Product;
  orderType: OrderType;
  variety: Variety;
  price: number | null;
  triggerPrice: number | null;
  tag: string | null;              // 16-char hex tag pushed to Kite (`og` + 14 hex)
  status: OrderStatus;
  kiteOrderId: string | null;
  kiteResponse: string | null;
  errorMessage: string | null;
  attempts: number;
  latencyMs: number;
  receivedAt: string;
  lastAttemptAt: string | null;
  completedAt: string | null;
  postbackConfirmedAt: string | null; // set when a postback applied a status to this row
  conflictMessage: string | null;     // set when a postback disagreed with our terminal state
}

// ── Kite getOrders() response (subset we use) ───────────────────────────────
export interface KiteOrderRow {
  order_id: string;
  status: string;
  status_message: string | null;
  tag: string | null;
  tradingsymbol: string;
  exchange: string;
  transaction_type: string;
  quantity: number;
  filled_quantity: number;
  price: number;
  trigger_price: number;
  order_timestamp: string;
}

// ── Kite postback payload ───────────────────────────────────────────────────
export interface KitePostbackPayload {
  user_id?: string;
  unix_timestamp?: number;
  app_id?: number;
  status?: string;
  order_id?: string;
  exchange_order_id?: string;
  placed_by?: string;
  tradingsymbol?: string;
  exchange?: string;
  transaction_type?: string;
  product?: string;
  order_type?: string;
  variety?: string;
  quantity?: number;
  filled_quantity?: number;
  pending_quantity?: number;
  price?: number;
  average_price?: number;
  trigger_price?: number;
  status_message?: string | null;
  order_timestamp?: string;
  exchange_timestamp?: string;
  tag?: string | null;
  checksum?: string;
  [key: string]: unknown;          // accept any extra fields Kite adds
}

export interface PostbackProcessResult {
  ok: boolean;
  duplicated: boolean;
  matched: boolean;
  conflict: boolean;
  recoveryCreated: boolean;
  appliedStatus: OrderStatus | null;
  reason: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  kiteConnected: boolean;
  uptime: number;
  timestamp: string;
  version: string;
}
