import { config } from '../config.js';
import { logger } from '../logger.js';

// =========================================
// Telegram alerts — minimal, fire-and-forget.
//
// No-op if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not configured (dev / CI).
// Never throws — alert delivery failure must never affect order flow.
// =========================================

export type AlertLevel = 'info' | 'warn' | 'critical';

const EMOJI: Record<AlertLevel, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🚨',
};

/**
 * Send a Telegram alert. Always resolves; errors are logged and swallowed.
 */
export async function sendAlert(level: AlertLevel, title: string, body: string): Promise<void> {
  const { botToken, chatId } = config.alerts.telegram;
  if (!botToken || !chatId) return;

  const text = `${EMOJI[level]} *${escape(title)}*\n\n${escape(body)}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.warn('Telegram alert HTTP non-OK', { status: res.status, level, title });
    }
  } catch (err) {
    logger.warn('Telegram alert error', { error: String(err), level, title });
  }
}

/**
 * Fire-and-forget — for synchronous call sites (e.g., kill switch).
 */
export function alertAsync(level: AlertLevel, title: string, body: string): void {
  void sendAlert(level, title, body).catch(() => { /* already logged */ });
}

function escape(s: string): string {
  // Basic Markdown V1 escapes — safe for arbitrary user-supplied text.
  return s.replace(/[*_`[\]]/g, (m) => `\\${m}`);
}
