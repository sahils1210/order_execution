import { kiteClient } from '../kite/KiteClient.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { runtimeMetrics } from './runtimeMetrics.js';
import { dbHealthProbe } from '../db/database.js';
import { getAllBucketStats } from '../kite/RateLimiter.js';

// =========================================
// DiagnosticsService — answers "is the gateway healthy RIGHT NOW?"
//
// Distinct from /metrics:
//   /metrics     → aggregated counts + alert SIGNALS (what's happening today)
//   /diagnostics → liveness signals (what's working/broken right now)
//
// Designed to be safe to poll at 1Hz. The heaviest call is dbHealthProbe()
// which is a single insert into a 1-row table — sub-millisecond on WAL.
// =========================================

export interface DiagnosticsSnapshot {
  asOf: string;
  uptimeSeconds: number;

  postback: {
    lastReceivedAt: string | null;
    secondsSinceLast: number | null;
    totalCount: number;
  };

  kite: {
    connected: boolean;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    successCount: number;
    errorCount: number;
    secondsSinceLastSuccess: number | null;
  };

  token: ReturnType<typeof kiteClient.getTokenStatus>;

  accounts: ReturnType<typeof accountRegistry.getAllStatus>;

  db: {
    readOk: boolean;
    writeOk: boolean;
    errorMessage: string | null;
  };

  rateLimiters: Array<{ accountId: string; tokensAvailable: number; queueDepth: number }>;

  /** Process-level runtime info — useful when the operator is comparing two replicas. */
  process: {
    nodeVersion: string;
    pid: number;
    memoryRssMb: number;
    memoryHeapUsedMb: number;
  };
}

class DiagnosticsService {
  snapshot(): DiagnosticsSnapshot {
    const now = Date.now();
    const runtime = runtimeMetrics.snapshot();
    const dbProbe = dbHealthProbe();
    const buckets = getAllBucketStats();
    const mem = process.memoryUsage();

    const secondsSinceLastPostback =
      runtime.postback.msSinceLastReceived != null
        ? Math.floor(runtime.postback.msSinceLastReceived / 1000)
        : null;

    const secondsSinceLastKiteSuccess = runtime.kite.lastSuccessAt
      ? Math.floor((now - new Date(runtime.kite.lastSuccessAt).getTime()) / 1000)
      : null;

    return {
      asOf: new Date().toISOString(),
      uptimeSeconds: Math.floor(runtime.uptimeMs / 1000),

      postback: {
        lastReceivedAt:    runtime.postback.lastReceivedAt,
        secondsSinceLast:  secondsSinceLastPostback,
        totalCount:        runtime.postback.count,
      },

      kite: {
        connected:               kiteClient.isConnected(),
        lastSuccessAt:           runtime.kite.lastSuccessAt,
        lastErrorAt:             runtime.kite.lastErrorAt,
        lastErrorMessage:        runtime.kite.lastErrorMessage,
        successCount:            runtime.kite.successCount,
        errorCount:              runtime.kite.errorCount,
        secondsSinceLastSuccess: secondsSinceLastKiteSuccess,
      },

      token: kiteClient.getTokenStatus(),

      accounts: accountRegistry.getAllStatus(),

      db: dbProbe,

      rateLimiters: buckets.map((b) => ({
        accountId:       b.label,
        tokensAvailable: b.tokens,
        queueDepth:      b.queued,
      })),

      process: {
        nodeVersion:      process.version,
        pid:              process.pid,
        memoryRssMb:      Math.round(mem.rss / 1024 / 1024),
        memoryHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
    };
  }
}

export const diagnosticsService = new DiagnosticsService();
