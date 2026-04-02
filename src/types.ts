// =========================================
// Order Gateway - Shared Types
// =========================================

export type OrderSource = '100-ALGO' | 'ultra-order' | string;
export type OrderStatus = 'RECEIVED' | 'SENT' | 'COMPLETE' | 'REJECTED' | 'ERROR';
export type TransactionType = 'BUY' | 'SELL';
export type Exchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS';
export type Product = 'CNC' | 'MIS' | 'NRML';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type Variety = 'regular' | 'amo' | 'co' | 'iceberg';

// Incoming order request from client apps
export interface OrderRequest {
  // Idempotency key — client must generate and pass this to avoid duplicates
  idempotencyKey: string;

  // Which app is placing the order
  source: OrderSource;

  // Order details (mirrors Kite API params)
  exchange: Exchange;
  tradingsymbol: string;
  transactionType: TransactionType;
  quantity: number;
  product: Product;
  orderType: OrderType;
  variety?: Variety;

  // Required for LIMIT / SL
  price?: number;
  // Required for SL / SL-M
  triggerPrice?: number;

  // Optional tag for identifying orders on Kite
  tag?: string;
}

// Response returned to client apps
export interface OrderResponse {
  success: boolean;
  orderId?: string;
  message?: string;
  latencyMs: number;
}

// Internal log record stored in SQLite
export interface OrderLog {
  id: number;
  idempotencyKey: string;
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
  tag: string | null;
  status: OrderStatus;
  kiteOrderId: string | null;
  kiteResponse: string | null; // JSON string
  errorMessage: string | null;
  latencyMs: number;
  receivedAt: string; // ISO timestamp
  completedAt: string | null;
}

// Health check response
export interface HealthResponse {
  status: 'ok' | 'degraded';
  kiteConnected: boolean;
  uptime: number;
  timestamp: string;
  version: string;
}
