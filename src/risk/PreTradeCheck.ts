import { config } from '../config.js';
import type { OrderRequest } from '../types.js';

// =========================================
// Pre-trade risk checks
//
// Runs BEFORE the DB insert. Cheap, deterministic, in-memory.
// All limits read from config (env-tunable) — no DB hit on hot path.
// =========================================

export interface PreTradeResult {
  ok: boolean;
  reason?: string;
}

class PreTradeCheck {
  private globalBucket: number[] = [];
  private perSourceBucket: Map<string, number[]> = new Map();

  validate(req: OrderRequest, _accountId: string): PreTradeResult {
    // ── Quantity ────────────────────────────────────────────────────────────
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      return { ok: false, reason: `Invalid quantity: ${req.quantity}` };
    }
    if (req.quantity > config.risk.maxQtyPerOrder) {
      return { ok: false, reason: `Quantity ${req.quantity} exceeds max ${config.risk.maxQtyPerOrder}` };
    }

    // ── Notional (approximate; uses limit price when available) ─────────────
    if (req.price != null && req.price > 0) {
      const notional = req.price * req.quantity;
      if (notional > config.risk.maxNotionalPerOrder) {
        return { ok: false, reason: `Notional ${notional.toFixed(0)} exceeds max ${config.risk.maxNotionalPerOrder}` };
      }
    }

    // ── Symbol blocklist ────────────────────────────────────────────────────
    if (config.risk.symbolBlocklist.length > 0
        && config.risk.symbolBlocklist.includes(req.tradingsymbol)) {
      return { ok: false, reason: `Symbol ${req.tradingsymbol} is blocklisted` };
    }

    // ── Rate limits ─────────────────────────────────────────────────────────
    const now = Date.now();
    const oneMinAgo = now - 60_000;

    // Global
    while (this.globalBucket.length && this.globalBucket[0] < oneMinAgo) {
      this.globalBucket.shift();
    }
    if (this.globalBucket.length >= config.risk.maxOrdersPerMinuteGlobal) {
      return { ok: false, reason: `Global rate limit: ${config.risk.maxOrdersPerMinuteGlobal} orders/min reached` };
    }

    // Per source
    const arr = this.perSourceBucket.get(req.source) ?? [];
    while (arr.length && arr[0] < oneMinAgo) arr.shift();
    if (arr.length >= config.risk.maxOrdersPerMinutePerSource) {
      return { ok: false, reason: `Source rate limit: ${config.risk.maxOrdersPerMinutePerSource} orders/min for ${req.source}` };
    }

    return { ok: true };
  }

  /** Call only AFTER pre-trade has passed AND the order is about to be sent. */
  recordAdmitted(source: string): void {
    const now = Date.now();
    this.globalBucket.push(now);
    const arr = this.perSourceBucket.get(source) ?? [];
    arr.push(now);
    this.perSourceBucket.set(source, arr);
  }

  getStatus(): { globalLastMin: number; perSource: Record<string, number> } {
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const perSource: Record<string, number> = {};
    for (const [src, arr] of this.perSourceBucket) {
      perSource[src] = arr.filter((t) => t >= oneMinAgo).length;
    }
    return {
      globalLastMin: this.globalBucket.filter((t) => t >= oneMinAgo).length,
      perSource,
    };
  }
}

export const preTradeCheck = new PreTradeCheck();
