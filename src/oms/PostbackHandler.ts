import { createHash } from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  findByTagAnyAccount,
  findByKiteOrderId,
  insertPostbackEvent,
  updatePostbackProcessing,
  updateStatusByCompositeKey,
  setConflictMessage,
  insertRecoveryRow,
} from '../db/database.js';
import { mapKiteStatus, isTerminalStatus } from '../kite/statusMap.js';
import { killSwitch } from '../risk/KillSwitch.js';
import { emitOrderUpdate, emitOrderConflict } from '../websocket.js';
import { alertAsync } from '../alerts/Telegram.js';
import type {
  KitePostbackPayload,
  OrderLog,
  OrderStatus,
  PostbackProcessResult,
  Exchange,
  Product,
  OrderType,
  Variety,
  TransactionType,
} from '../types.js';

// =========================================
// PostbackHandler — turns a Kite postback into deterministic state changes.
// =========================================

export class PostbackHandler {
  verifyChecksum(payload: KitePostbackPayload): boolean {
    const secret = config.kite.apiSecret;
    if (!secret) return false;
    if (!payload.order_id || !payload.order_timestamp || !payload.checksum) return false;

    const computed = createHash('sha256')
      .update(String(payload.order_id))
      .update(String(payload.order_timestamp))
      .update(secret)
      .digest('hex');
    return computed === payload.checksum;
  }

  computeDedupKey(payload: KitePostbackPayload): string {
    const parts = [
      payload.order_id ?? '',
      payload.status ?? '',
      payload.filled_quantity ?? '',
      payload.order_timestamp ?? '',
      payload.average_price ?? '',
      payload.exchange_timestamp ?? '',
    ].map(String).join('|');
    return createHash('sha256').update(parts).digest('hex');
  }

  async handle(payload: KitePostbackPayload, rawBody: string): Promise<PostbackProcessResult> {
    const checksumValid = this.verifyChecksum(payload);
    if (!checksumValid) {
      logger.warn('Postback received with invalid/missing checksum', {
        orderId: payload.order_id,
        tag: payload.tag,
        hasSecret: !!config.kite.apiSecret,
        hasChecksum: !!payload.checksum,
      });
      if (config.postback.requireValidChecksum) {
        return reject('checksum invalid and POSTBACK_REQUIRE_VALID_CHECKSUM is on');
      }
    }

    const dedupKey = this.computeDedupKey(payload);
    const ins = insertPostbackEvent({
      dedupKey,
      orderId: payload.order_id ?? null,
      tag: payload.tag ?? null,
      status: payload.status ?? null,
      filledQuantity: payload.filled_quantity ?? null,
      averagePrice: payload.average_price ?? null,
      orderTimestamp: payload.order_timestamp ?? null,
      checksumValid,
      rawPayload: rawBody,
    });

    if (!ins.isNew) {
      logger.debug('Postback duplicate dropped', { dedupKey, orderId: payload.order_id });
      return {
        ok: true, duplicated: true, matched: false, conflict: false,
        recoveryCreated: false, appliedStatus: null, reason: 'duplicate (dedup_key match)',
      };
    }

    const newStatus = mapKiteStatus(payload.status ?? null);
    if (!newStatus) {
      logger.warn('Postback with unrecognised status', { status: payload.status, orderId: payload.order_id });
      updatePostbackProcessing(ins.id, null, false, 'unknown status', false);
      return {
        ok: true, duplicated: false, matched: false, conflict: false,
        recoveryCreated: false, appliedStatus: null, reason: 'unmapped Kite status',
      };
    }

    let row: OrderLog | null = null;
    let matchedBy: 'tag' | 'order_id' | null = null;

    if (payload.tag) {
      row = findByTagAnyAccount(payload.tag);
      if (row) matchedBy = 'tag';
    }
    if (!row && payload.order_id) {
      row = findByKiteOrderId(payload.order_id);
      if (row) matchedBy = 'order_id';
    }

    if (!row) {
      const recovered = this.createRecoveryRow(payload, newStatus);
      updatePostbackProcessing(ins.id, recovered.id, false, null, true);
      logger.warn('Postback for unknown order — recovery row created', {
        orderId: payload.order_id,
        tag: payload.tag,
        status: newStatus,
      });
      alertAsync('warn', 'Postback recovery row created', `Unknown order_id: ${payload.order_id}\nStatus: ${newStatus}\nTag: ${payload.tag ?? '-'}`);
      emitOrderUpdate({
        idempotencyKey: recovered.clientIdempotencyKey,
        source: recovered.source,
        tradingsymbol: recovered.tradingsymbol,
        transactionType: recovered.transactionType,
        quantity: recovered.quantity,
        status: newStatus,
        kiteOrderId: recovered.kiteOrderId,
        errorMessage: recovered.errorMessage,
        latencyMs: 0,
        receivedAt: recovered.receivedAt,
      });
      return {
        ok: true, duplicated: false, matched: false, conflict: false,
        recoveryCreated: true, appliedStatus: newStatus, reason: 'recovery row created',
      };
    }

    return this.applyToExistingRow(row, payload, newStatus, ins.id, matchedBy!);
  }

  private applyToExistingRow(
    row: OrderLog,
    payload: KitePostbackPayload,
    newStatus: OrderStatus,
    postbackId: number,
    matchedBy: 'tag' | 'order_id',
  ): PostbackProcessResult {
    const dbWasTerminal = isTerminalStatus(row.status);

    if (dbWasTerminal && row.status === newStatus) {
      updatePostbackProcessing(postbackId, row.id, false, null, false);
      return {
        ok: true, duplicated: false, matched: true, conflict: false,
        recoveryCreated: false, appliedStatus: newStatus, reason: 'matches existing terminal state',
      };
    }

    if (dbWasTerminal && newStatus !== row.status && isTerminalStatus(newStatus)) {
      const message = `CRITICAL: DB terminal=${row.status} vs postback terminal=${newStatus} for order ${payload.order_id}`;
      logger.error('Postback CRITICAL conflict — DB terminal differs from postback terminal', {
        compositeKey: row.idempotencyKey,
        kiteOrderId: payload.order_id,
        tag: row.tag,
        dbStatus: row.status,
        postbackStatus: newStatus,
        matchedBy,
      });

      setConflictMessage(row.idempotencyKey, message);
      updatePostbackProcessing(postbackId, row.id, true, message, false);

      emitOrderConflict({
        idempotencyKey: row.clientIdempotencyKey,
        kiteOrderId: payload.order_id ?? row.kiteOrderId,
        tag: row.tag,
        source: row.source,
        tradingsymbol: row.tradingsymbol,
        dbStatus: row.status,
        postbackStatus: newStatus,
        message,
        detectedAt: new Date().toISOString(),
      });

      // Always alert on terminal-vs-terminal conflicts — this should be rare
      // and indicates either a Kite oddity, our state-machine bug, or tag collision.
      alertAsync('critical', 'Postback CRITICAL conflict', message);

      if (config.postback.haltOnConflict) {
        killSwitch.halt(`Postback conflict on order ${payload.order_id}: ${row.status} vs ${newStatus}`, 'postback-conflict');
      }

      return {
        ok: true, duplicated: false, matched: true, conflict: true,
        recoveryCreated: false, appliedStatus: null, reason: 'terminal-vs-terminal conflict',
      };
    }

    if (dbWasTerminal && !isTerminalStatus(newStatus)) {
      logger.warn('Postback would reverse terminal state — ignored', {
        compositeKey: row.idempotencyKey,
        dbStatus: row.status,
        postbackStatus: newStatus,
      });
      updatePostbackProcessing(postbackId, row.id, false, 'reverse transition ignored', false);
      return {
        ok: true, duplicated: false, matched: true, conflict: false,
        recoveryCreated: false, appliedStatus: null, reason: 'reverse transition ignored',
      };
    }

    const errorMessage = newStatus === 'REJECTED'
      ? (payload.status_message ?? row.errorMessage ?? 'rejected by exchange')
      : null;

    updateStatusByCompositeKey(row.idempotencyKey, {
      status: newStatus,
      kiteOrderId: payload.order_id ?? row.kiteOrderId,
      kiteResponse: JSON.stringify(payload),
      errorMessage,
      postbackConfirmed: true,
    });

    updatePostbackProcessing(postbackId, row.id, false, null, false);

    logger.info('Postback applied', {
      compositeKey: row.idempotencyKey,
      tag: row.tag,
      kiteOrderId: payload.order_id,
      previous: row.status,
      next: newStatus,
      matchedBy,
    });

    emitOrderUpdate({
      idempotencyKey: row.clientIdempotencyKey,
      source: row.source,
      tradingsymbol: row.tradingsymbol,
      transactionType: row.transactionType,
      quantity: row.quantity,
      status: newStatus,
      kiteOrderId: payload.order_id ?? row.kiteOrderId,
      errorMessage,
      latencyMs: row.latencyMs,
      receivedAt: row.receivedAt,
    });

    return {
      ok: true, duplicated: false, matched: true, conflict: false,
      recoveryCreated: false, appliedStatus: newStatus, reason: `applied (${row.status} → ${newStatus})`,
    };
  }

  private createRecoveryRow(payload: KitePostbackPayload, status: OrderStatus): OrderLog {
    const orderId = payload.order_id ?? `unknown-${Date.now()}`;
    return insertRecoveryRow({
      kiteOrderId: orderId,
      tag: payload.tag ?? null,
      status,
      source: 'postback-recovery',
      exchange: (payload.exchange as Exchange) ?? 'NSE',
      tradingsymbol: payload.tradingsymbol ?? 'UNKNOWN',
      transactionType: (payload.transaction_type as TransactionType) ?? 'BUY',
      quantity: payload.quantity ?? 0,
      product: (payload.product as Product) ?? 'MIS',
      orderType: (payload.order_type as OrderType) ?? 'MARKET',
      variety: (payload.variety as Variety) ?? 'regular',
      price: payload.price ?? null,
      triggerPrice: payload.trigger_price ?? null,
      errorMessage: status === 'REJECTED' ? (payload.status_message ?? 'rejected') : null,
      kiteResponse: JSON.stringify(payload),
      postbackConfirmed: true,
    });
  }
}

function reject(reason: string): PostbackProcessResult {
  return {
    ok: false, duplicated: false, matched: false, conflict: false,
    recoveryCreated: false, appliedStatus: null, reason,
  };
}

export const postbackHandler = new PostbackHandler();
