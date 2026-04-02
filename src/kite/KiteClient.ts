// eslint-disable-next-line @typescript-eslint/no-require-imports
const { KiteConnect } = require('kiteconnect') as { KiteConnect: new (p: { api_key: string }) => import('kiteconnect').Connect };
import type { Connect } from 'kiteconnect';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { OrderRequest } from '../types.js';

// =========================================
// KiteClient — Zerodha Kite API Integration
//
// Token lifecycle:
//   08:05 IST — fetch fresh token from token service
//   09:00 IST — verify token is still valid (safety check before market open)
//   On any 401/403 during order — auto-refresh + 1 retry
// =========================================

export interface TokenStatus {
  valid: boolean;
  lastRefreshedAt: string | null;   // ISO timestamp of last successful refresh
  nextRefreshAt: string | null;      // ISO timestamp of next scheduled refresh
  lastError: string | null;          // Last refresh error, cleared on success
  refreshCount: number;              // Total successful refreshes this session
}

class KiteClient {
  private kite: Connect;
  private connected = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;

  private tokenStatus: TokenStatus = {
    valid: false,
    lastRefreshedAt: null,
    nextRefreshAt: null,
    lastError: null,
    refreshCount: 0,
  };

  constructor() {
    this.kite = new KiteConnect({ api_key: config.kite.apiKey });
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.fetchAndSetToken('startup');
    this.connected = true;
    this.scheduleDailyRefresh();
    this.scheduleDailyVerify();
    logger.info('KiteClient initialized');
  }

  // ─── Token Fetch & Validate ────────────────────────────────────────────────

  private async fetchAndSetToken(reason: string): Promise<void> {
    let token: string;

    try {
      if (config.kite.tokenSource === 'env') {
        token = config.kite.accessToken;
        if (!token) throw new Error('KITE_ACCESS_TOKEN is empty');
      } else {
        token = await this.fetchTokenFromService();
      }

      this.kite.setAccessToken(token);
      await this.kite.getProfile(); // validates the token is accepted by Kite

      this.tokenStatus.valid = true;
      this.tokenStatus.lastRefreshedAt = new Date().toISOString();
      this.tokenStatus.lastError = null;
      this.tokenStatus.refreshCount += 1;

      logger.info('Kite token refreshed and validated', { reason });

    } catch (err: unknown) {
      const errMsg = String(err);
      this.tokenStatus.valid = false;
      this.tokenStatus.lastError = errMsg;
      logger.error('Kite token refresh failed', { reason, error: errMsg });
      throw err;
    }
  }

  private async fetchTokenFromService(): Promise<string> {
    const url = config.kite.tokenServiceUrl;
    if (!url) throw new Error('TOKEN_SERVICE_URL is not configured');

    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Token service returned HTTP ${res.status}`);

    const body = await res.json() as {
      access_token?: string;
      token?: string;
      data?: { access_token?: string };
    };

    const token = body.access_token || body.token || body.data?.access_token;
    if (!token) throw new Error('Token service response missing access_token field');
    return token;
  }

  // ─── Scheduled Refresh: 08:05 IST daily ───────────────────────────────────

  private scheduleDailyRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const [hh, mm] = config.kite.tokenRefreshTime.split(':').map(Number);
    const msUntil = this.msUntilNextIST(hh, mm);

    this.tokenStatus.nextRefreshAt = new Date(Date.now() + msUntil).toISOString();

    this.refreshTimer = setTimeout(async () => {
      try {
        await this.fetchAndSetToken('daily-08:05');
        this.emitStatusUpdate();
      } catch {
        this.emitStatusUpdate();
      }
      this.scheduleDailyRefresh();
    }, msUntil);

    logger.info('Daily token refresh scheduled', {
      atIST: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      inHours: +(msUntil / 3600000).toFixed(1),
    });
  }

  // ─── Scheduled Verify: 09:00 IST daily ────────────────────────────────────
  // Safety check right before market opens — confirms token is still valid

  private scheduleDailyVerify(): void {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);

    const msUntil = this.msUntilNextIST(9, 0);

    this.verifyTimer = setTimeout(async () => {
      logger.info('Running 09:00 IST token verification');
      const healthy = await this.isHealthy();
      if (!healthy) {
        logger.warn('09:00 verification failed — attempting re-fetch');
        try {
          await this.fetchAndSetToken('daily-09:00-recovery');
          this.emitStatusUpdate();
        } catch {
          this.emitStatusUpdate();
        }
      } else {
        logger.info('09:00 token verification passed');
        this.tokenStatus.valid = true;
        this.emitStatusUpdate();
      }
      this.scheduleDailyVerify();
    }, msUntil);

    logger.info('Daily token verification scheduled', {
      atIST: '09:00',
      inHours: +(msUntil / 3600000).toFixed(1),
    });
  }

  // ─── Manual Refresh (called from API endpoint) ────────────────────────────

  async refreshToken(): Promise<void> {
    await this.fetchAndSetToken('manual');
    this.emitStatusUpdate();
    logger.info('Token manually refreshed');
  }

  // ─── Order Placement ───────────────────────────────────────────────────────

  async placeOrder(req: OrderRequest): Promise<string> {
    const variety = req.variety ?? 'regular';
    const params = {
      exchange: req.exchange,
      tradingsymbol: req.tradingsymbol,
      transaction_type: req.transactionType,
      quantity: req.quantity,
      product: req.product,
      order_type: req.orderType,
      ...(req.price != null && { price: req.price }),
      ...(req.triggerPrice != null && { trigger_price: req.triggerPrice }),
      ...(req.tag && { tag: req.tag }),
    };
    return this.placeWithRetry(variety as import('kiteconnect').Variety, params, config.maxRetries);
  }

  private async placeWithRetry(
    variety: import('kiteconnect').Variety,
    params: Record<string, unknown>,
    retriesLeft: number
  ): Promise<string> {
    try {
      const result = await Promise.race([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.kite as any).placeOrder(variety, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Kite API timeout')), config.kite.timeoutMs)
        ),
      ]);
      return (result as { order_id: string }).order_id;
    } catch (err: unknown) {
      const errStr = String(err);

      if (this.isTokenError(errStr) && retriesLeft > 0) {
        logger.warn('Token error during placeOrder — refreshing and retrying');
        try {
          await this.fetchAndSetToken('order-token-error');
          this.emitStatusUpdate();
        } catch { /* will throw below */ }
        return this.placeWithRetry(variety, params, retriesLeft - 1);
      }

      if (this.isTransientError(errStr) && retriesLeft > 0) {
        logger.warn('Transient error — retrying once', { error: errStr });
        await sleep(200);
        return this.placeWithRetry(variety, params, retriesLeft - 1);
      }

      throw err;
    }
  }

  // ─── Health & Status ───────────────────────────────────────────────────────

  async isHealthy(): Promise<boolean> {
    try {
      await Promise.race([
        this.kite.getProfile(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 3000)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getTokenStatus(): TokenStatus {
    return { ...this.tokenStatus };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Milliseconds until the next occurrence of hh:mm IST */
  private msUntilNextIST(hh: number, mm: number): number {
    const now = new Date();
    const nowIst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const target = new Date(nowIst);
    target.setHours(hh, mm, 0, 0);
    if (target <= nowIst) target.setDate(target.getDate() + 1);
    return target.getTime() - nowIst.getTime();
  }

  private isTokenError(err: string): boolean {
    return (
      err.includes('TokenException') ||
      err.includes('401') ||
      err.includes('403') ||
      err.toLowerCase().includes('token')
    );
  }

  private isTransientError(err: string): boolean {
    return (
      err.includes('NetworkException') ||
      err.includes('ECONNRESET') ||
      err.includes('ETIMEDOUT') ||
      err.includes('ENOTFOUND') ||
      err.includes('timeout')
    );
  }

  // Emits real-time token status to UI via WebSocket (set externally)
  emitStatusUpdate: () => void = () => {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const kiteClient = new KiteClient();
