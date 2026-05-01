import { logger } from '../logger.js';
import { metricsService } from './MetricsService.js';
import { diagnosticsService } from './DiagnosticsService.js';
import { emitMetricsUpdate, emitDiagnosticsUpdate } from '../websocket.js';
import { alertAsync } from '../alerts/Telegram.js';

// =========================================
// Broadcaster — emits metrics:update and diagnostics:update on a fixed cadence
// to all connected Socket.IO clients.
//
// Cadence is conservative (5s) — observability shouldn't compete with order
// flow for event-loop time. Per-fill events (position:update, pnl:update)
// already give the UI sub-second feedback for what matters most; this layer
// is for the "system health pane".
//
// Dedup: each unique alert id is Telegram'd at most once per cooldown window.
// =========================================

const METRICS_INTERVAL_MS     = 5_000;
const DIAGNOSTICS_INTERVAL_MS = 10_000;
const ALERT_COOLDOWN_MS       = 5 * 60_000; // re-alert each id at most every 5m

class ObservabilityBroadcaster {
  private metricsTimer: NodeJS.Timeout | null = null;
  private diagTimer: NodeJS.Timeout | null = null;
  /** alert id → last emitted-to-Telegram timestamp (ms). */
  private lastAlertedAt = new Map<string, number>();

  start(): void {
    if (this.metricsTimer || this.diagTimer) return;

    const metricsTick = (): void => {
      try {
        const snap = metricsService.snapshot();
        emitMetricsUpdate(snap);
        this.maybeAlert(snap.alerts);
      } catch (err) {
        logger.error('Metrics broadcast failed', { error: String(err) });
      } finally {
        this.metricsTimer = setTimeout(metricsTick, METRICS_INTERVAL_MS);
        this.metricsTimer.unref();
      }
    };

    const diagTick = (): void => {
      try {
        const snap = diagnosticsService.snapshot();
        emitDiagnosticsUpdate(snap);
      } catch (err) {
        logger.error('Diagnostics broadcast failed', { error: String(err) });
      } finally {
        this.diagTimer = setTimeout(diagTick, DIAGNOSTICS_INTERVAL_MS);
        this.diagTimer.unref();
      }
    };

    this.metricsTimer = setTimeout(metricsTick, METRICS_INTERVAL_MS);
    this.metricsTimer.unref();
    this.diagTimer = setTimeout(diagTick, DIAGNOSTICS_INTERVAL_MS);
    this.diagTimer.unref();

    logger.info('Observability broadcaster started', {
      metricsIntervalMs:     METRICS_INTERVAL_MS,
      diagnosticsIntervalMs: DIAGNOSTICS_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.metricsTimer) { clearTimeout(this.metricsTimer); this.metricsTimer = null; }
    if (this.diagTimer)    { clearTimeout(this.diagTimer);    this.diagTimer    = null; }
  }

  /**
   * For each alert in the current snapshot, fire a Telegram notification
   * at most once per ALERT_COOLDOWN_MS. The Socket.IO feed always carries
   * the live alert list — Telegram is for "wake the operator" cases only.
   */
  private maybeAlert(alerts: ReturnType<typeof metricsService.snapshot>['alerts']): void {
    const now = Date.now();
    for (const a of alerts) {
      // Only critical alerts pierce to Telegram. Warns stay in the UI feed.
      if (a.level !== 'critical') continue;
      const last = this.lastAlertedAt.get(a.id) ?? 0;
      if (now - last < ALERT_COOLDOWN_MS) continue;
      this.lastAlertedAt.set(a.id, now);
      alertAsync('critical', `[obs] ${a.id}`, `${a.message}${a.hint ? `\n\n${a.hint}` : ''}`);
    }
  }
}

export const observabilityBroadcaster = new ObservabilityBroadcaster();
