// eslint-disable-next-line @typescript-eslint/no-require-imports
const { KiteConnect } = require('kiteconnect') as { KiteConnect: new (p: { api_key: string }) => import('kiteconnect').Connect };
import type { Connect } from 'kiteconnect';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { alertAsync } from '../alerts/Telegram.js';

// =========================================
// KiteClient — PURE Kite API wrapper for the master account.
// =========================================

export interface TokenStatus {
  valid: boolean;
  lastRefreshedAt: string | null;
  nextRefreshAt: string | null;
  lastError: string | null;
  refreshCount: number;
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

  async initialize(): Promise<void> {
    await this.fetchAndSetToken('startup');
    this.connected = true;
    this.scheduleDailyRefresh();
    this.scheduleDailyVerify();
    logger.info('KiteClient initialized');
  }

  getRawKite(): Connect { return this.kite; }
  isConnected(): boolean { return this.connected; }
  getTokenStatus(): TokenStatus { return { ...this.tokenStatus }; }

  async isHealthy(): Promise<boolean> {
    try {
      await Promise.race([
        this.kite.getProfile(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async placeOrderRaw(variety: string, params: Record<string, unknown>): Promise<{ order_id: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.kite as any).placeOrder(variety, params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async cancelOrderRaw(variety: string, orderId: string): Promise<{ order_id: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.kite as any).cancelOrder(variety, orderId);
  }

  async modifyOrderRaw(
    variety: string,
    orderId: string,
    params: Record<string, unknown>,
  ): Promise<{ order_id: string }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.kite as any).modifyOrder(variety, orderId, params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOrders(): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.kite as any).getOrders();
  }

  async refreshToken(): Promise<void> {
    await this.fetchAndSetToken('manual');
    this.emitStatusUpdate();
  }

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
      await this.kite.getProfile();

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
      alertAsync('critical', 'Kite token refresh FAILED', `Reason: ${reason}\nError: ${errMsg}`);
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

  private scheduleDailyRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const [hh, mm] = config.kite.tokenRefreshTime.split(':').map(Number);
    const msUntil = msUntilNextIST(hh, mm);

    this.tokenStatus.nextRefreshAt = new Date(Date.now() + msUntil).toISOString();

    this.refreshTimer = setTimeout(async () => {
      try { await this.fetchAndSetToken('daily-08:05'); } catch { /* logged + alerted */ }
      this.emitStatusUpdate();
      this.scheduleDailyRefresh();
    }, msUntil);

    logger.info('Daily token refresh scheduled', {
      atIST: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      inHours: +(msUntil / 3600000).toFixed(1),
    });
  }

  private scheduleDailyVerify(): void {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    const msUntil = msUntilNextIST(9, 0);

    this.verifyTimer = setTimeout(async () => {
      logger.info('Running 09:00 IST token verification');
      const healthy = await this.isHealthy();
      if (!healthy) {
        logger.warn('09:00 verification failed — attempting re-fetch');
        try { await this.fetchAndSetToken('daily-09:00-recovery'); } catch { /* logged + alerted */ }
      } else {
        logger.info('09:00 token verification passed');
        this.tokenStatus.valid = true;
      }
      this.emitStatusUpdate();
      this.scheduleDailyVerify();
    }, msUntil);

    logger.info('Daily token verification scheduled', {
      atIST: '09:00',
      inHours: +(msUntil / 3600000).toFixed(1),
    });
  }

  emitStatusUpdate: () => void = () => {};
}

function msUntilNextIST(hh: number, mm: number): number {
  const now = new Date();
  const nowIst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const target = new Date(nowIst);
  target.setHours(hh, mm, 0, 0);
  if (target <= nowIst) target.setDate(target.getDate() + 1);
  return target.getTime() - nowIst.getTime();
}

export const kiteClient = new KiteClient();
