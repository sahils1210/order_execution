import { config } from '../config.js';
import { logger } from '../logger.js';

// =========================================
// Per-(source,symbol) circuit breaker
//
// If a (source, symbol) pair errors `threshold` times within `windowMs`, that
// pair is blocked for `cooldownMs`. Other pairs are unaffected.
//
// In-memory only — resets on process restart. Acceptable for retail scale.
// =========================================

interface BreakerEntry {
  errors: number[];        // timestamps in ms
  openUntil: number | null;
}

class CircuitBreaker {
  private map: Map<string, BreakerEntry> = new Map();

  constructor(
    private threshold: number,
    private windowMs: number,
    private cooldownMs: number,
  ) {}

  isOpen(source: string, symbol: string): { open: boolean; reason?: string } {
    const key = this.keyOf(source, symbol);
    const entry = this.map.get(key);
    if (!entry?.openUntil) return { open: false };
    if (Date.now() < entry.openUntil) {
      const remainingSec = Math.ceil((entry.openUntil - Date.now()) / 1000);
      return { open: true, reason: `Circuit open for ${source}:${symbol} (${remainingSec}s remaining)` };
    }
    // Cooldown expired — half-open: clear the trip and the error history
    entry.openUntil = null;
    entry.errors = [];
    return { open: false };
  }

  recordError(source: string, symbol: string): void {
    const key = this.keyOf(source, symbol);
    const entry = this.map.get(key) ?? { errors: [], openUntil: null };
    const now = Date.now();
    entry.errors.push(now);
    this.trim(entry, now);
    if (entry.errors.length >= this.threshold && !entry.openUntil) {
      entry.openUntil = now + this.cooldownMs;
      logger.warn('Circuit breaker tripped', {
        source,
        symbol,
        errors: entry.errors.length,
        cooldownMs: this.cooldownMs,
      });
    }
    this.map.set(key, entry);
  }

  recordSuccess(source: string, symbol: string): void {
    // A success in a healthy pair clears its error history.
    const key = this.keyOf(source, symbol);
    const entry = this.map.get(key);
    if (entry && !entry.openUntil) {
      entry.errors = [];
    }
  }

  /** For /admin/risk debugging */
  getStatus(): Record<string, { errors: number; openUntil: string | null }> {
    const out: Record<string, { errors: number; openUntil: string | null }> = {};
    const now = Date.now();
    for (const [key, entry] of this.map) {
      this.trim(entry, now);
      if (!entry.errors.length && !entry.openUntil) continue;
      out[key] = {
        errors: entry.errors.length,
        openUntil: entry.openUntil ? new Date(entry.openUntil).toISOString() : null,
      };
    }
    return out;
  }

  private trim(entry: BreakerEntry, now: number): void {
    const cutoff = now - this.windowMs;
    while (entry.errors.length && entry.errors[0] < cutoff) {
      entry.errors.shift();
    }
  }

  private keyOf(source: string, symbol: string): string {
    return `${source}::${symbol}`;
  }
}

export const circuitBreaker = new CircuitBreaker(
  config.risk.circuitBreakerThreshold,
  config.risk.circuitBreakerWindowMs,
  config.risk.circuitBreakerCooldownMs,
);
