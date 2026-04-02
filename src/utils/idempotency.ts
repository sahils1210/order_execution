import { config } from '../config.js';

// =========================================
// In-Memory Idempotency Cache
//
// Purpose: Prevent duplicate orders when the same request
// is retried by the client within the TTL window.
//
// Design choices:
// - In-memory Map (no Redis needed for single-process gateway)
// - TTL-based expiry with periodic cleanup
// - findByIdempotencyKey in DB is the durable fallback
//
// Flow:
// 1. Check DB first (durable, survives restarts)
// 2. If DB has a record → return cached response
// 3. If not in DB → check in-memory (in-flight protection)
// 4. If not in memory → proceed with execution
// =========================================

interface CacheEntry {
  orderId: string | null;
  status: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Cleanup expired entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 60_000);

export function setIdempotencyCache(key: string, orderId: string | null, status: string): void {
  cache.set(key, {
    orderId,
    status,
    expiresAt: Date.now() + config.idempotencyTtlMs,
  });
}

export function getIdempotencyCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function deleteIdempotencyCache(key: string): void {
  cache.delete(key);
}
