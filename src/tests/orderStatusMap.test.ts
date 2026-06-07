/**
 * orderStatusMap — synthesis truth table.
 *
 * The dry-run synthesis case is the safety-critical one. If a real Kite order
 * (real `260603...` ID) accidentally went through the synthetic branch, a
 * strategy polling for status would see "COMPLETE filled at requested price"
 * regardless of what actually happened at the broker — that's silent fill
 * fabrication, the worst kind of bug.
 *
 * The branch discriminator is purely the `kite_order_id` prefix. These tests
 * pin the prefix check and the field-level synthesis explicitly.
 */

import { describe, it, expect } from '@jest/globals';
import { buildStatusResponse, mapToKiteStatus } from '../routes/orderStatusMap.js';
import type { OrderLog } from '../types.js';

function baseRow(over: Partial<OrderLog> = {}): OrderLog {
  return {
    id: 1,
    idempotencyKey: 'key::master',
    clientIdempotencyKey: 'key',
    accountId: 'master',
    source: 'test',
    exchange: 'NFO',
    tradingsymbol: 'NIFTY2661623350CE',
    transactionType: 'BUY',
    quantity: 65,
    product: 'MIS',
    orderType: 'LIMIT',
    variety: 'regular',
    price: 148.20,
    triggerPrice: null,
    tag: 'og1c41fc39413b63',
    status: 'ACCEPTED',
    kiteOrderId: 'DRYRUN-fe5d17e2f28925',
    kiteResponse: '{"dryRun":true}',
    errorMessage: null,
    attempts: 1,
    latencyMs: 4,
    receivedAt: '2026-06-07T13:42:19.581Z',
    lastAttemptAt: '2026-06-07T13:42:19.581Z',
    completedAt: null,
    postbackConfirmedAt: null,
    conflictMessage: null,
    ...over,
  };
}

describe('buildStatusResponse — DRYRUN synthesis', () => {
  it('returns a single-element array (matching Kite orderHistory shape)', () => {
    const result = buildStatusResponse(baseRow());
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
  });

  it('sets status=COMPLETE for any DRYRUN- order regardless of DB status', () => {
    for (const status of ['RECEIVED', 'SUBMITTING', 'ACCEPTED', 'UNKNOWN'] as const) {
      const [el] = buildStatusResponse(baseRow({ status }));
      expect(el.status).toBe('COMPLETE');
    }
  });

  it('sets dryRun=true on every element of a DRYRUN- order', () => {
    const [el] = buildStatusResponse(baseRow());
    expect(el.dryRun).toBe(true);
  });

  it('synthesises filled_quantity == quantity and pending_quantity == 0', () => {
    const [el] = buildStatusResponse(baseRow({ quantity: 130 }));
    expect(el.filled_quantity).toBe(130);
    expect(el.pending_quantity).toBe(0);
    expect(el.cancelled_quantity).toBe(0);
  });

  it('uses requested price as average_price for LIMIT dry-run orders', () => {
    const [el] = buildStatusResponse(baseRow({ price: 148.20 }));
    expect(el.average_price).toBe(148.20);
  });

  it('falls back to 0 average_price when no requested price (market order in dry-run)', () => {
    const [el] = buildStatusResponse(baseRow({ price: null, orderType: 'MARKET' }));
    expect(el.average_price).toBe(0);
  });

  it('preserves order metadata (symbol, side, qty, tag) verbatim', () => {
    const [el] = buildStatusResponse(baseRow({
      tradingsymbol: 'NIFTY2660923400CE',
      transactionType: 'SELL',
      quantity: 100,
      tag: 'og8964ecb7f6607f',
    }));
    expect(el.tradingsymbol).toBe('NIFTY2660923400CE');
    expect(el.transaction_type).toBe('SELL');
    expect(el.quantity).toBe(100);
    expect(el.tag).toBe('og8964ecb7f6607f');
  });
});

describe('buildStatusResponse — real Kite order (no synthesis)', () => {
  function realRow(over: Partial<OrderLog> = {}): OrderLog {
    return baseRow({ kiteOrderId: '260603151146421', ...over });
  }

  it('sets dryRun=false for non-DRYRUN- order_id', () => {
    const [el] = buildStatusResponse(realRow());
    expect(el.dryRun).toBe(false);
  });

  it('does NOT synthesise filled_quantity from quantity when status != COMPLETE', () => {
    const [el] = buildStatusResponse(realRow({ status: 'ACCEPTED', quantity: 65 }));
    expect(el.filled_quantity).toBe(0);
    expect(el.pending_quantity).toBe(65);
  });

  it('reports filled_quantity = quantity when status = COMPLETE', () => {
    const [el] = buildStatusResponse(realRow({ status: 'COMPLETE', quantity: 65 }));
    expect(el.filled_quantity).toBe(65);
    expect(el.pending_quantity).toBe(0);
  });

  it('reports cancelled_quantity = quantity when status = CANCELLED', () => {
    const [el] = buildStatusResponse(realRow({ status: 'CANCELLED', quantity: 65 }));
    expect(el.cancelled_quantity).toBe(65);
    expect(el.filled_quantity).toBe(0);
  });

  it('passes through errorMessage as status_message', () => {
    const [el] = buildStatusResponse(realRow({
      status: 'REJECTED',
      errorMessage: '[INPUT] RMS: Margin Exceeds',
    }));
    expect(el.status_message).toBe('[INPUT] RMS: Margin Exceeds');
  });

  it('never sets dryRun=true unless order_id starts with DRYRUN-', () => {
    // Defensive: exotic order_id formats should not accidentally trigger
    // synthesis. Only the literal "DRYRUN-" prefix matters.
    for (const id of ['DRY-RUN-abc', 'dryrun-abc', '260603DRYRUN', '']) {
      const [el] = buildStatusResponse(baseRow({ kiteOrderId: id }));
      expect(el.dryRun).toBe(false);
    }
  });
});

describe('mapToKiteStatus — internal → Kite vocabulary', () => {
  it('RECEIVED → TRIGGER PENDING', () => {
    expect(mapToKiteStatus('RECEIVED')).toBe('TRIGGER PENDING');
  });
  it('SUBMITTING → TRIGGER PENDING', () => {
    expect(mapToKiteStatus('SUBMITTING')).toBe('TRIGGER PENDING');
  });
  it('ACCEPTED → OPEN', () => {
    expect(mapToKiteStatus('ACCEPTED')).toBe('OPEN');
  });
  it('UNKNOWN → OPEN (best guess pre-reconcile)', () => {
    expect(mapToKiteStatus('UNKNOWN')).toBe('OPEN');
  });
  it('COMPLETE → COMPLETE', () => {
    expect(mapToKiteStatus('COMPLETE')).toBe('COMPLETE');
  });
  it('CANCELLED → CANCELLED', () => {
    expect(mapToKiteStatus('CANCELLED')).toBe('CANCELLED');
  });
  it('REJECTED → REJECTED', () => {
    expect(mapToKiteStatus('REJECTED')).toBe('REJECTED');
  });
  it('ERROR → REJECTED (caller treats as broker-side fail)', () => {
    expect(mapToKiteStatus('ERROR')).toBe('REJECTED');
  });
});
