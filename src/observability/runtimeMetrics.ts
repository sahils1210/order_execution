// =========================================
// Runtime metrics — in-process counters and timestamps that can't be derived
// from SQLite alone. Instrumented at the call sites that emit the signal:
//   - PostbackHandler  → recordPostbackReceived()
//   - KiteClient       → recordKiteCallSuccess() / recordKiteCallError()
//   - OrderManager     → recordPlaceLatency()
//
// Everything here is single-process, lock-free, O(1). No external deps.
// =========================================

const MAX_LATENCY_SAMPLES = 200; // ring buffer for recent placement latencies

class RingBuffer {
  private buf: number[] = [];
  private idx = 0;
  constructor(private capacity: number) {}

  push(v: number): void {
    if (this.buf.length < this.capacity) {
      this.buf.push(v);
    } else {
      this.buf[this.idx] = v;
      this.idx = (this.idx + 1) % this.capacity;
    }
  }

  toArraySorted(): number[] {
    return [...this.buf].sort((a, b) => a - b);
  }

  size(): number { return this.buf.length; }
}

class RuntimeMetrics {
  // ── Postback signals ──
  private lastPostbackReceivedAtMs: number | null = null;
  private postbackCount = 0;

  // ── Kite call signals ──
  private lastKiteSuccessAtMs: number | null = null;
  private lastKiteErrorAtMs: number | null = null;
  private lastKiteErrorMessage: string | null = null;
  private kiteSuccessCount = 0;
  private kiteErrorCount = 0;

  // ── Placement latency rings (recent window — exposed as p50/p95/p99/max) ──
  // We separate "wall" (start to finish, includes queue wait) from "kite"
  // (rate-limiter acquire to response). Kite RTT is the Kite-health signal;
  // wall is the order-flow-end-to-end signal. Alerts use Kite RTT to avoid
  // false positives when our rate-limiter is correctly throttling.
  private latencyRing = new RingBuffer(MAX_LATENCY_SAMPLES);
  private kiteLatencyRing = new RingBuffer(MAX_LATENCY_SAMPLES);
  private queueWaitRing = new RingBuffer(MAX_LATENCY_SAMPLES);

  // ── Process lifecycle ──
  private readonly startedAtMs = Date.now();

  // ── Recorders ──
  recordPostbackReceived(): void {
    this.lastPostbackReceivedAtMs = Date.now();
    this.postbackCount++;
  }

  recordKiteCallSuccess(): void {
    this.lastKiteSuccessAtMs = Date.now();
    this.kiteSuccessCount++;
  }

  recordKiteCallError(message: string): void {
    this.lastKiteErrorAtMs = Date.now();
    this.lastKiteErrorMessage = message.slice(0, 500);
    this.kiteErrorCount++;
  }

  recordPlaceLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencyRing.push(ms);
  }

  /** Time spent waiting for the rate-limiter token bucket (ms). */
  recordQueueWait(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.queueWaitRing.push(ms);
  }

  /** Time spent inside Kite (rate-limiter exit to response/error, ms). */
  recordKiteLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.kiteLatencyRing.push(ms);
  }

  /** Seed the postback last-received timestamp from persisted state on boot. */
  seedPostback(lastReceivedIso: string | null, count: number): void {
    if (lastReceivedIso) {
      const t = new Date(lastReceivedIso).getTime();
      if (Number.isFinite(t)) this.lastPostbackReceivedAtMs = t;
    }
    if (count > 0) this.postbackCount = count;
  }

  // ── Snapshots ──
  snapshot(): {
    startedAt: string;
    uptimeMs: number;
    postback: {
      lastReceivedAt: string | null;
      msSinceLastReceived: number | null;
      count: number;
    };
    kite: {
      lastSuccessAt: string | null;
      lastErrorAt: string | null;
      lastErrorMessage: string | null;
      successCount: number;
      errorCount: number;
    };
    placeLatency: LatencyStats;
    kiteLatency:  LatencyStats;
    queueWait:    LatencyStats;
  } {
    const now = Date.now();
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: now - this.startedAtMs,
      postback: {
        lastReceivedAt:      this.lastPostbackReceivedAtMs != null
                                ? new Date(this.lastPostbackReceivedAtMs).toISOString()
                                : null,
        msSinceLastReceived: this.lastPostbackReceivedAtMs != null
                                ? now - this.lastPostbackReceivedAtMs
                                : null,
        count:               this.postbackCount,
      },
      kite: {
        lastSuccessAt:    this.lastKiteSuccessAtMs != null ? new Date(this.lastKiteSuccessAtMs).toISOString() : null,
        lastErrorAt:      this.lastKiteErrorAtMs   != null ? new Date(this.lastKiteErrorAtMs).toISOString()   : null,
        lastErrorMessage: this.lastKiteErrorMessage,
        successCount:     this.kiteSuccessCount,
        errorCount:       this.kiteErrorCount,
      },
      placeLatency: ringStats(this.latencyRing),
      kiteLatency:  ringStats(this.kiteLatencyRing),
      queueWait:    ringStats(this.queueWaitRing),
    };
  }
}

export interface LatencyStats {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function ringStats(ring: RingBuffer): LatencyStats {
  const sorted = ring.toArraySorted();
  const pct = (q: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[idx]!;
  };
  return {
    samples: sorted.length,
    p50:     pct(0.50),
    p95:     pct(0.95),
    p99:     pct(0.99),
    max:     sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
  };
}

export const runtimeMetrics = new RuntimeMetrics();
