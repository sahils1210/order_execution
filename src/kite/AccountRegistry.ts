// eslint-disable-next-line @typescript-eslint/no-require-imports
const { KiteConnect } = require('kiteconnect') as { KiteConnect: new (p: { api_key: string }) => import('kiteconnect').Connect };
import { logger } from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// AccountRegistry — manages multiple Kite sessions for multi-account execution.
//
// Accounts are defined via ACCOUNTS_JSON env var:
//   [
//     { "id": "master",  "apiKey": "...", "tokenServiceUrl": "..." },
//     { "id": "huf",     "apiKey": "...", "tokenServiceUrl": "..." }
//   ]
//
// Token lifecycle mirrors KiteClient: fetched at startup, refreshed at 08:05 IST.
// Each account is independent — one failure does not affect others.
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountTokenStatus {
  id: string;
  valid: boolean;
  lastRefreshedAt: string | null;
  lastError: string | null;
}

interface AccountDef {
  id: string;
  apiKey: string;
  tokenServiceUrl: string;
}

interface AccountEntry {
  def: AccountDef;
  kite: import('kiteconnect').Connect;
  valid: boolean;
  lastRefreshedAt: string | null;
  lastError: string | null;
  refreshTimer: NodeJS.Timeout | null;
}

class AccountRegistry {
  private accounts: Map<string, AccountEntry> = new Map();

  // ─── Boot ───────────────────────────────────────────────────────────────────

  async initialize(defs: AccountDef[]): Promise<void> {
    for (const def of defs) {
      const kite = new KiteConnect({ api_key: def.apiKey });
      const entry: AccountEntry = {
        def,
        kite,
        valid: false,
        lastRefreshedAt: null,
        lastError: null,
        refreshTimer: null,
      };
      this.accounts.set(def.id, entry);

      try {
        await this.fetchAndSetToken(entry);
        this.scheduleRefresh(entry);
        logger.info('AccountRegistry: account initialized', { id: def.id });
      } catch (err) {
        logger.error('AccountRegistry: startup token fetch failed', { id: def.id, error: String(err) });
        // Non-fatal — account marked invalid, retry at next scheduled refresh
        this.scheduleRefresh(entry);
      }
    }

    logger.info('AccountRegistry: initialized', { accounts: defs.map((d) => d.id) });
  }

  // ─── Order placement ────────────────────────────────────────────────────────

  getKite(accountId: string): import('kiteconnect').Connect | null {
    return this.accounts.get(accountId)?.kite ?? null;
  }

  isValid(accountId: string): boolean {
    return this.accounts.get(accountId)?.valid ?? false;
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  getAllStatus(): AccountTokenStatus[] {
    return Array.from(this.accounts.values()).map((e) => ({
      id: e.def.id,
      valid: e.valid,
      lastRefreshedAt: e.lastRefreshedAt,
      lastError: e.lastError,
    }));
  }

  // ─── Token fetch ────────────────────────────────────────────────────────────

  private async fetchAndSetToken(entry: AccountEntry): Promise<void> {
    const { id, tokenServiceUrl } = entry.def;

    const res = await fetch(tokenServiceUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Token service returned HTTP ${res.status}`);

    const body = await res.json() as {
      access_token?: string;
      token?: string;
      data?: { access_token?: string };
    };

    const token = body.access_token || body.token || body.data?.access_token;
    if (!token) throw new Error('Token service response missing token field');

    entry.kite.setAccessToken(token);
    await entry.kite.getProfile(); // validate token is accepted by Kite

    entry.valid = true;
    entry.lastRefreshedAt = new Date().toISOString();
    entry.lastError = null;

    logger.info('AccountRegistry: token refreshed', { id });
  }

  async refreshAccount(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) throw new Error(`Account not found: ${accountId}`);
    await this.fetchAndSetToken(entry);
  }

  // ─── Scheduled refresh at 08:05 IST ─────────────────────────────────────────

  private scheduleRefresh(entry: AccountEntry): void {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer);

    const msUntil = this.msUntilNextIST(8, 5);

    entry.refreshTimer = setTimeout(async () => {
      try {
        await this.fetchAndSetToken(entry);
      } catch (err) {
        entry.valid = false;
        entry.lastError = String(err);
        logger.error('AccountRegistry: scheduled refresh failed', { id: entry.def.id, error: String(err) });
      }
      this.scheduleRefresh(entry); // reschedule for next day
    }, msUntil);
  }

  private msUntilNextIST(hh: number, mm: number): number {
    const now = new Date();
    const nowIst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const target = new Date(nowIst);
    target.setHours(hh, mm, 0, 0);
    if (target <= nowIst) target.setDate(target.getDate() + 1);
    return target.getTime() - nowIst.getTime();
  }
}

export const accountRegistry = new AccountRegistry();

// ─── Parse ACCOUNTS_JSON env var ─────────────────────────────────────────────

export function parseAccountDefs(): AccountDef[] {
  const raw = process.env.ACCOUNTS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AccountDef[];
    if (!Array.isArray(parsed)) throw new Error('ACCOUNTS_JSON must be an array');
    for (const a of parsed) {
      if (!a.id || !a.apiKey || !a.tokenServiceUrl) {
        throw new Error(`Account entry missing id/apiKey/tokenServiceUrl: ${JSON.stringify(a)}`);
      }
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid ACCOUNTS_JSON: ${String(err)}`);
  }
}
