import { Router, Request, Response, NextFunction, json as bodyJson } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { postbackHandler } from '../oms/PostbackHandler.js';
import type { KitePostbackPayload } from '../types.js';

// =========================================
// POST /webhook/kite — Kite Postback Endpoint (PUBLIC).
//
// Defence-in-depth (in this order):
//   1. HTTPS check          (POSTBACK_REQUIRE_HTTPS)
//   2. IP allowlist         (POSTBACK_ALLOWED_IPS, optional)
//   3. SHA-256 checksum     (POSTBACK_REQUIRE_VALID_CHECKSUM)
//   4. dedup_key idempotency
// =========================================

export const webhookRouter = Router();

const rawBodySaver = (req: Request, _res: Response, buf: Buffer): void => {
  if (buf?.length) {
    (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  }
};

function getRemoteIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? '';
}

/** Reject if not arriving over HTTPS (X-Forwarded-Proto from the reverse proxy). */
function httpsGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.postback.requireHttps) { next(); return; }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.toLowerCase();
  if (proto === 'https') { next(); return; }
  // Allow loopback for dev / health-check tooling on the gateway VM itself.
  const ip = getRemoteIp(req);
  if (ip === '127.0.0.1' || ip === '::1') { next(); return; }
  logger.warn('Postback rejected — not HTTPS', { remoteIp: ip, proto });
  res.status(400).json({ ok: false, error: 'HTTPS required' });
}

/** Optional IP allowlist for Kite's outbound IPs. Empty list = disabled. */
function ipAllowlistGuard(req: Request, res: Response, next: NextFunction): void {
  const allowed = config.postback.allowedIps;
  if (allowed.length === 0) { next(); return; }
  const remoteIp = getRemoteIp(req);
  if (allowed.includes(remoteIp)) { next(); return; }
  logger.warn('Postback rejected — IP not in allowlist', { remoteIp, allowedCount: allowed.length });
  res.status(403).json({ ok: false, error: 'forbidden' });
}

webhookRouter.post(
  '/kite',
  httpsGuard,
  ipAllowlistGuard,
  bodyJson({ limit: config.postback.bodyLimitBytes, verify: rawBodySaver }),
  async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const remoteIp = getRemoteIp(req);

    let payload: KitePostbackPayload;
    try {
      payload = (req.body ?? {}) as KitePostbackPayload;
    } catch {
      logger.warn('Postback malformed body', { remoteIp });
      res.status(400).json({ ok: false, error: 'malformed body' });
      return;
    }

    logger.info('Postback received', {
      remoteIp,
      orderId: payload.order_id,
      status: payload.status,
      tag: payload.tag,
      filledQty: payload.filled_quantity,
    });

    try {
      const result = await postbackHandler.handle(payload, rawBody);
      if (!result.ok) {
        res.status(401).json({ ok: false, reason: result.reason });
        return;
      }
      res.status(200).json({
        ok: true,
        matched: result.matched,
        duplicated: result.duplicated,
        conflict: result.conflict,
        recoveryCreated: result.recoveryCreated,
        appliedStatus: result.appliedStatus,
        reason: result.reason,
      });
    } catch (err) {
      logger.error('Postback handler crashed', {
        orderId: payload.order_id,
        error: String(err instanceof Error ? err.stack : err),
      });
      // 200 to Kite so they don't infinitely retry — audit row exists for replay.
      res.status(200).json({ ok: false, error: 'internal error — logged for manual replay' });
    }
  },
);
