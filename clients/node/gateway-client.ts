/**
 * Order Gateway Client — Node.js/TypeScript
 *
 * Drop this file into ultra-order to replace direct Kite API calls.
 * Provides: sendOrder(), with built-in idempotency + retry on gateway failure.
 *
 * Usage:
 *   import { gatewayClient } from './gateway-client';
 *   const result = await gatewayClient.sendOrder({ ... });
 */

import { randomUUID } from 'crypto';

export interface GatewayOrderRequest {
  /** Unique key to prevent duplicate orders. Generate with crypto.randomUUID() */
  idempotencyKey?: string;
  /** Which app is placing this order (shows in dashboard) */
  source: string;
  exchange: 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS';
  tradingsymbol: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  product: 'CNC' | 'MIS' | 'NRML';
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  variety?: 'regular' | 'amo' | 'co' | 'iceberg';
  price?: number;
  triggerPrice?: number;
  tag?: string;
}

export interface GatewayOrderResponse {
  success: boolean;
  orderId?: string;
  message?: string;
  latencyMs: number;
}

export interface GatewayClientOptions {
  /** Gateway base URL e.g. http://gateway-ip:3000 */
  gatewayUrl: string;
  /** API key (GATEWAY_API_KEY in gateway's .env) */
  apiKey: string;
  /** Request timeout in ms. Default: 8000 */
  timeoutMs?: number;
  /** Max retries if gateway is unreachable. Default: 2 */
  maxRetries?: number;
  /** Delay between retries in ms. Default: 300 */
  retryDelayMs?: number;
}

export class GatewayClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(opts: GatewayClientOptions) {
    this.url = opts.gatewayUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 300;
  }

  async sendOrder(req: GatewayOrderRequest): Promise<GatewayOrderResponse> {
    const payload = {
      ...req,
      idempotencyKey: req.idempotencyKey ?? randomUUID(),
      variety: req.variety ?? 'regular',
    };

    return this.postWithRetry('/order', payload, this.maxRetries);
  }

  async health(): Promise<{ status: string; kiteConnected: boolean }> {
    const res = await fetch(`${this.url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.json() as Promise<{ status: string; kiteConnected: boolean }>;
  }

  private async postWithRetry(
    path: string,
    body: unknown,
    retriesLeft: number
  ): Promise<GatewayOrderResponse> {
    try {
      const res = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          Connection: 'keep-alive',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const data = await res.json() as GatewayOrderResponse;

      // Non-5xx failures (validation errors, duplicate key) — don't retry
      if (!res.ok && res.status < 500) {
        return data;
      }

      if (!res.ok && retriesLeft > 0) {
        await sleep(this.retryDelayMs);
        return this.postWithRetry(path, body, retriesLeft - 1);
      }

      return data;
    } catch (err: unknown) {
      // Network / timeout errors — retry
      if (retriesLeft > 0) {
        await sleep(this.retryDelayMs);
        return this.postWithRetry(path, body, retriesLeft - 1);
      }
      return {
        success: false,
        message: `Gateway unreachable: ${String(err)}`,
        latencyMs: 0,
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Singleton factory ────────────────────────────────────────────────────────
// Configure once from environment, use everywhere

let _client: GatewayClient | null = null;

export function createGatewayClient(): GatewayClient {
  if (_client) return _client;

  const gatewayUrl = process.env.ORDER_GATEWAY_URL;
  const apiKey = process.env.ORDER_GATEWAY_API_KEY;

  if (!gatewayUrl) throw new Error('ORDER_GATEWAY_URL environment variable is required');
  if (!apiKey) throw new Error('ORDER_GATEWAY_API_KEY environment variable is required');

  _client = new GatewayClient({ gatewayUrl, apiKey });
  return _client;
}

export const gatewayClient = {
  sendOrder: (req: GatewayOrderRequest) => createGatewayClient().sendOrder(req),
  health: () => createGatewayClient().health(),
};
