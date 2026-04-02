export type OrderStatus = 'RECEIVED' | 'SENT' | 'COMPLETE' | 'REJECTED' | 'ERROR' | 'IN_FLIGHT';

export interface OrderLog {
  id: number;
  idempotencyKey: string;
  source: string;
  exchange: string;
  tradingsymbol: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  product: string;
  orderType: string;
  variety: string;
  price: number | null;
  triggerPrice: number | null;
  tag: string | null;
  status: OrderStatus;
  kiteOrderId: string | null;
  kiteResponse: string | null;
  errorMessage: string | null;
  latencyMs: number;
  receivedAt: string;
  completedAt: string | null;
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

export interface TokenStatus {
  valid: boolean;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  refreshCount: number;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unknown';
  kiteConnected: boolean;
  uptime: number;
  timestamp: string;
  token: TokenStatus;
}

export interface Filters {
  source: string;
  status: string;
  from: string;
  to: string;
}
