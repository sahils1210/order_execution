import { getKillSwitch, setKillSwitch } from '../db/database.js';
import { logger } from '../logger.js';
import { alertAsync } from '../alerts/Telegram.js';

// =========================================
// Kill Switch — DB-backed, crash-safe.
//
// Persistence ordering: WRITE DB FIRST, then update in-memory cache.
// If the DB write fails (disk full, locked, corruption), we cannot guarantee
// the halt survives a restart, so we crash the process loud (process.exit(1)).
// PM2 restarts; killSwitch.initialize() then reads the durable DB state.
// =========================================

class KillSwitch {
  private halted: boolean = false;
  private reason: string | null = null;
  private source: string | null = null;

  initialize(): void {
    const row = getKillSwitch();
    this.halted = row.halted;
    this.reason = row.reason;
    this.source = row.source;
    if (this.halted) {
      logger.warn('Kill switch is ENGAGED on startup', { reason: this.reason, source: this.source });
      alertAsync('warn', 'Kill switch ENGAGED on startup', `Reason: ${this.reason ?? 'unknown'}\nSource: ${this.source ?? 'unknown'}`);
    }
  }

  isHalted(): boolean {
    return this.halted;
  }

  getStatus(): { halted: boolean; reason: string | null; source: string | null } {
    return { halted: this.halted, reason: this.reason, source: this.source };
  }

  halt(reason: string, source: string): void {
    if (this.halted) {
      logger.info('Kill switch halt requested but already halted', { reason, source });
      return;
    }

    // CRITICAL FIX: persist to DB FIRST. If the write fails, we cannot guarantee
    // the halt will survive a restart — fail loud rather than silently lose state.
    try {
      setKillSwitch(true, reason, source);
    } catch (err) {
      const errStr = String(err instanceof Error ? err.stack : err);
      logger.error('FATAL: kill switch DB write failed — halting process to force restart', {
        reason,
        source,
        error: errStr,
      });
      alertAsync('critical', 'Kill switch persistence FAILED', `DB write threw: ${errStr}\nReason: ${reason}\nSource: ${source}`);
      process.exit(1);
    }

    this.halted = true;
    this.reason = reason;
    this.source = source;
    logger.warn('🛑 KILL SWITCH ENGAGED', { reason, source });
    alertAsync('critical', 'Kill switch ENGAGED', `Reason: ${reason}\nSource: ${source}`);
  }

  resume(source: string): void {
    if (!this.halted) return;

    try {
      setKillSwitch(false, null, source);
    } catch (err) {
      const errStr = String(err instanceof Error ? err.stack : err);
      logger.error('FATAL: kill switch DB write failed during resume — halting process', {
        source,
        error: errStr,
      });
      alertAsync('critical', 'Kill switch resume FAILED', `DB write threw: ${errStr}\nSource: ${source}`);
      process.exit(1);
    }

    this.halted = false;
    const previousReason = this.reason;
    this.reason = null;
    this.source = null;
    logger.info('▶️ KILL SWITCH DISENGAGED', { source, previousReason });
    alertAsync('info', 'Kill switch DISENGAGED', `By: ${source}\nPrevious reason: ${previousReason ?? 'n/a'}`);
  }
}

export const killSwitch = new KillSwitch();

// =========================================
// AutoHaltMonitor — trips kill switch when global error rate exceeds threshold
// =========================================
class AutoHaltMonitor {
  private errorTimestamps: number[] = [];

  constructor(private threshold: number, private windowMs: number) {}

  recordError(): void {
    const now = Date.now();
    this.errorTimestamps.push(now);
    this.trim(now);
    if (this.errorTimestamps.length >= this.threshold && !killSwitch.isHalted()) {
      killSwitch.halt(
        `Auto-halt: ${this.errorTimestamps.length} order errors in last ${(this.windowMs / 1000).toFixed(0)}s`,
        'auto'
      );
    }
  }

  recordSuccess(): void { /* time-only window */ }

  getRecentErrorCount(): number {
    this.trim(Date.now());
    return this.errorTimestamps.length;
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.errorTimestamps.length && this.errorTimestamps[0] < cutoff) {
      this.errorTimestamps.shift();
    }
  }
}

import { config } from '../config.js';
export const autoHaltMonitor = new AutoHaltMonitor(
  config.risk.autoHaltErrorThreshold,
  config.risk.autoHaltWindowMs,
);
