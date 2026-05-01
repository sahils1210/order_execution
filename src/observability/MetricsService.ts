import {
  aggregateOrderMetrics,
  aggregatePostbackMetrics,
  type OrderMetricsAggregate,
  type PostbackMetricsAggregate,
} from '../db/database.js';
import { runtimeMetrics } from './runtimeMetrics.js';
import { positionManager } from '../positions/PositionManager.js';
import { killSwitch, autoHaltMonitor } from '../risk/KillSwitch.js';
import { circuitBreaker } from '../risk/CircuitBreaker.js';
import { preTradeCheck } from '../risk/PreTradeCheck.js';
import { kiteClient } from '../kite/KiteClient.js';

// =========================================
// MetricsService — single aggregator for /metrics and the metrics:update
// Socket.IO event. Combines:
//
//   - SQLite-backed counters (orders, postbacks)        → aggregate*Metrics()
//   - In-process counters (latency ring, last-seen)     → runtimeMetrics
//   - Live risk state (positions, kill switch, breakers)
//   - Derived alert signals (stale UNKNOWN, no postbacks, latency spikes)
//
// IMPORTANT: alert signals are computed from already-aggregated state, not
// re-queried — keeps a /metrics call to ~5 ms even with thousands of orders.
// =========================================

// IST trading session (NSE) — used to gate the "no postbacks for 10m" alert
// so it doesn't fire overnight or on weekends.
const NSE_OPEN_IST_MIN  =  9 * 60 + 15; //  9:15
const NSE_CLOSE_IST_MIN = 15 * 60 + 30; // 15:30

export interface MetricsAlert {
  /** Stable id — UI can dedup repeated emissions. */
  id: 'STALE_UNKNOWN'
    | 'NO_POSTBACKS_DURING_MARKET'
    | 'HIGH_LATENCY'
    | 'REPEATED_ERRORS'
    | 'POSTBACK_CONFLICT'
    | 'POSTBACK_INVALID_CHECKSUM'
    | 'TOKEN_INVALID';
  level: 'info' | 'warn' | 'critical';
  message: string;
  /** Hint for the operator — what to look at next. */
  hint?: string;
  /** The numeric value that triggered the alert (count, ms, etc.). */
  value?: number;
  /** The threshold that was crossed. */
  threshold?: number;
}

export interface MetricsSnapshot {
  asOf: string;
  windowSinceIso: string;
  /** Today's IST trade-date (YYYY-MM-DD). */
  tradeDate: string;
  orders: OrderMetricsAggregate;
  postbacks: PostbackMetricsAggregate;
  runtime: ReturnType<typeof runtimeMetrics.snapshot>;
  risk: {
    killSwitch: { halted: boolean; reason: string | null; source: string | null };
    autoHaltRecentErrors: number;
    circuitBreaker: ReturnType<typeof circuitBreaker.getStatus>;
    rateLimits: ReturnType<typeof preTradeCheck.getStatus>;
    positions: {
      activeCount: number;
      totalRealized: number;
      totalUnrealized: number;
      totalPnl: number;
      totalExposure: number;
    };
  };
  alerts: MetricsAlert[];
}

// ── Tunable thresholds (kept in code rather than env so this layer stays
// dependency-free; these aren't business knobs, they're observability ones). ──
const STALE_UNKNOWN_AGE_MS         = 2 * 60_000;   // UNKNOWN for >2m  → alert
const NO_POSTBACK_THRESHOLD_MS     = 10 * 60_000;  // no postback >10m during market → alert
const HIGH_LATENCY_P95_MS          = 1500;         // p95 placement >1.5s → alert
const HIGH_LATENCY_MAX_MS          = 5000;         // any single >5s → alert
const REPEATED_ERROR_THRESHOLD     = 5;            // ≥5 errors in autoHalt window → alert

class MetricsService {
  /**
   * Today's IST midnight in UTC ISO. Window for "today's metrics" — matches
   * positionManager's trade-date so /metrics and /pnl are aligned.
   */
  todayWindowSince(): string {
    const tradeDate = positionManager.currentTradeDate(); // YYYY-MM-DD (IST)
    // IST midnight = UTC of the previous day 18:30
    const istMidnight = new Date(`${tradeDate}T00:00:00+05:30`);
    return istMidnight.toISOString();
  }

  snapshot(): MetricsSnapshot {
    const since = this.todayWindowSince();
    const orders    = aggregateOrderMetrics(since, STALE_UNKNOWN_AGE_MS);
    const postbacks = aggregatePostbackMetrics(since);
    const runtime   = runtimeMetrics.snapshot();
    const pnl       = positionManager.getPnlSummary();
    const ks        = killSwitch.getStatus();
    const alerts    = this.deriveAlerts(orders, postbacks, runtime);

    return {
      asOf: new Date().toISOString(),
      windowSinceIso: since,
      tradeDate: positionManager.currentTradeDate(),
      orders,
      postbacks,
      runtime,
      risk: {
        killSwitch:           ks,
        autoHaltRecentErrors: autoHaltMonitor.getRecentErrorCount(),
        circuitBreaker:       circuitBreaker.getStatus(),
        rateLimits:           preTradeCheck.getStatus(),
        positions: {
          activeCount:     pnl.perSymbol.filter((p) => p.netQuantity !== 0).length,
          totalRealized:   pnl.totalRealized,
          totalUnrealized: pnl.totalUnrealized,
          totalPnl:        pnl.totalPnl,
          totalExposure:   pnl.totalExposure,
        },
      },
      alerts,
    };
  }

  // ─── Alert signals ────────────────────────────────────────────────────────

  private deriveAlerts(
    orders: OrderMetricsAggregate,
    postbacks: PostbackMetricsAggregate,
    runtime: ReturnType<typeof runtimeMetrics.snapshot>,
  ): MetricsAlert[] {
    const out: MetricsAlert[] = [];

    // 1) UNKNOWN orders > 0 for > 2 min
    if (orders.staleUnknownCount > 0) {
      out.push({
        id: 'STALE_UNKNOWN',
        level: 'critical',
        message: `${orders.staleUnknownCount} order(s) stuck in UNKNOWN for >2m`,
        hint: 'Check Reconciler logs and Kite getOrders() reachability — these orders may have filled at the broker but not yet reconciled here.',
        value: orders.staleUnknownCount,
        threshold: 0,
      });
    }

    // 2) No postbacks for > 10m DURING MARKET HOURS only.
    if (this.isMarketOpenNow()) {
      const ms = runtime.postback.msSinceLastReceived;
      if (ms == null) {
        out.push({
          id: 'NO_POSTBACKS_DURING_MARKET',
          level: 'warn',
          message: 'No postbacks received yet today (market is open)',
          hint: 'Either no orders placed, postback URL misconfigured, or webhook unreachable from Kite.',
        });
      } else if (ms > NO_POSTBACK_THRESHOLD_MS) {
        out.push({
          id: 'NO_POSTBACKS_DURING_MARKET',
          level: 'critical',
          message: `No postbacks received in last ${Math.floor(ms / 60_000)}m (market is open)`,
          hint: 'Possible webhook outage. Reconciler will backstop, but real-time signals are degraded.',
          value: ms,
          threshold: NO_POSTBACK_THRESHOLD_MS,
        });
      }
    }

    // 3) High-latency spikes — measured on Kite RTT (post-rate-limiter), not
    //    wall-clock placement time. Wall-clock includes our own queue wait,
    //    which is by-design at market-open burst and would false-trigger.
    if (runtime.kiteLatency.samples >= 10) {
      if (runtime.kiteLatency.p95 > HIGH_LATENCY_P95_MS) {
        out.push({
          id: 'HIGH_LATENCY',
          level: 'warn',
          message: `Kite RTT p95 ${runtime.kiteLatency.p95}ms over last ${runtime.kiteLatency.samples} calls (threshold ${HIGH_LATENCY_P95_MS}ms)`,
          hint: 'Check Kite API status or network. (This is RTT after our rate-limiter, so it is not a queue-wait artefact.)',
          value: runtime.kiteLatency.p95,
          threshold: HIGH_LATENCY_P95_MS,
        });
      }
      if (runtime.kiteLatency.max > HIGH_LATENCY_MAX_MS) {
        out.push({
          id: 'HIGH_LATENCY',
          level: 'critical',
          message: `At least one Kite call took ${runtime.kiteLatency.max}ms (>${HIGH_LATENCY_MAX_MS}ms)`,
          hint: 'A timeout-class Kite spike — investigate Kite-side or DNS issues.',
          value: runtime.kiteLatency.max,
          threshold: HIGH_LATENCY_MAX_MS,
        });
      }
    }

    // 4) Repeated errors (uses existing AutoHaltMonitor sliding window)
    if (autoHaltMonitor.getRecentErrorCount() >= REPEATED_ERROR_THRESHOLD) {
      out.push({
        id: 'REPEATED_ERRORS',
        level: 'warn',
        message: `${autoHaltMonitor.getRecentErrorCount()} order errors in last ${(60_000 / 1000).toFixed(0)}s window`,
        hint: 'Approaching auto-halt threshold. Inspect /metrics.orders.byStatus and recent failures.',
        value: autoHaltMonitor.getRecentErrorCount(),
        threshold: REPEATED_ERROR_THRESHOLD,
      });
    }

    // 5) Postback conflicts / invalid checksums (data-integrity signals)
    if (postbacks.conflictCount > 0) {
      out.push({
        id: 'POSTBACK_CONFLICT',
        level: 'critical',
        message: `${postbacks.conflictCount} postback conflict(s) today`,
        hint: 'Terminal-vs-terminal mismatch between DB and broker — see order_logs.conflict_message.',
        value: postbacks.conflictCount,
      });
    }
    if (postbacks.invalidChecksumCount > 0) {
      out.push({
        id: 'POSTBACK_INVALID_CHECKSUM',
        level: 'warn',
        message: `${postbacks.invalidChecksumCount} postback(s) with invalid checksum today`,
        hint: 'Either unauthorized hits or KITE_API_SECRET drift. If POSTBACK_REQUIRE_VALID_CHECKSUM=true, these were rejected.',
        value: postbacks.invalidChecksumCount,
      });
    }

    // 6) Token health — direct, dedicated signal. Generic REPEATED_ERRORS
    //    isn't enough during a token incident: operators need a hint that
    //    points to the fix (re-login or hit /refresh-token).
    const token = kiteClient.getTokenStatus();
    if (!token.valid) {
      out.push({
        id: 'TOKEN_INVALID',
        level: 'critical',
        message: 'Kite access token is invalid or stale',
        hint: token.lastError
          ? `Last error: ${token.lastError}. Re-login at Kite, push token via TOKEN_SERVICE_URL, or POST /refresh-token.`
          : 'Re-login at Kite, push token via TOKEN_SERVICE_URL, or POST /refresh-token.',
      });
    }

    return out;
  }

  /** True iff current IST time is within the NSE 9:15–15:30 window on a weekday. */
  isMarketOpenNow(now: Date = new Date()): boolean {
    // IST = UTC+5:30
    const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
    // getUTC* on the shifted date is effectively "in IST".
    const dow = ist.getUTCDay();           // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return false;
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return minutes >= NSE_OPEN_IST_MIN && minutes <= NSE_CLOSE_IST_MIN;
  }
}

export const metricsService = new MetricsService();
