import { logger } from '../logger.js';

// =========================================
// Token-bucket rate limiter — one bucket per Kite account.
//
// Kite's hard limit is ~10 requests/sec per user-key. We throttle to 7/sec
// (3-token headroom for getOrders / getProfile / postback verification calls).
//
// Behaviour:
//   - Bucket starts full at `maxTokens` so a small burst is admitted instantly.
//   - Refills at `tokensPerSec`, capped at `maxTokens`.
//   - acquire() never rejects — callers wait FIFO until a token is available.
//   - Single-threaded JS guarantees the queue is processed in arrival order.
// =========================================

class TokenBucket {
  private tokens: number;
  private lastRefill: number = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly maxTokens: number,
    private readonly tokensPerSec: number,
    private readonly label: string,
  ) {
    this.tokens = maxTokens;
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  /** Diagnostic snapshot. */
  stats(): { tokens: number; queued: number; label: string } {
    this.refill();
    return { tokens: Math.floor(this.tokens), queued: this.queue.length, label: this.label };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.tokensPerSec);
      this.lastRefill = now;
    }
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const next = this.queue.shift()!;
      next();
    }
    if (this.queue.length > 0 && !this.timer) {
      const need = 1 - this.tokens;
      const waitMs = Math.max(5, Math.ceil((need / this.tokensPerSec) * 1000));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
      // Don't keep the process alive solely for a refill timer.
      this.timer.unref();
    }
  }
}

// ── Per-account buckets (Kite limit applies per user-key) ──────────────────
const KITE_REQUESTS_PER_SEC = 7;
const KITE_BURST_TOKENS     = 7;

const buckets = new Map<string, TokenBucket>();

export function bucketFor(accountId: string): TokenBucket {
  let b = buckets.get(accountId);
  if (!b) {
    b = new TokenBucket(KITE_BURST_TOKENS, KITE_REQUESTS_PER_SEC, accountId);
    buckets.set(accountId, b);
    logger.info('Kite token bucket created', {
      accountId,
      burst: KITE_BURST_TOKENS,
      perSec: KITE_REQUESTS_PER_SEC,
    });
  }
  return b;
}

export function getAllBucketStats(): Array<{ tokens: number; queued: number; label: string }> {
  return Array.from(buckets.values()).map((b) => b.stats());
}

export type { TokenBucket };
