// =========================================
// orderStatusMap — pure transform from a gateway OrderLog row to a
// Kite-orderHistory-shaped response. Used by GET /order/:orderId so:
//
//   1. DRYRUN-* IDs: returns synthetic "COMPLETE" fill (no Kite call). This
//      unblocks strategies that, after place_order returns "DRYRUN-...",
//      poll get_order_status to verify the fill — currently they hit Kite
//      directly and get "Invalid order_id" because Kite has no record.
//
//   2. Real Kite IDs known to the gateway: returns whatever the gateway's DB
//      believes (terminal state, kite_order_id, tag, prices, fills). Callers
//      can still go to Kite directly for full trade-tick history; this is
//      the cheap "what does gateway think" path.
//
// Shape mirrors Kite's `orderHistory(order_id)` return — an array where each
// element is a status snapshot. We always return a single-element array (we
// don't track historical transitions). The extra `dryRun` field on the
// payload lets consumers distinguish synthetic from real without parsing the
// order_id prefix.
//
// Lives in its own dependency-free file so jest can test the synthesis truth
// table without dragging node:sqlite into the test runner.
// =========================================

import type { OrderLog, OrderStatus } from '../types.js';

/** A single status snapshot, shaped like an entry in Kite's `orderHistory`. */
export interface KiteShapedStatus {
  order_id: string;
  exchange_order_id: string | null;
  status: string;
  status_message: string | null;
  order_timestamp: string;
  exchange_timestamp: string | null;
  variety: string;
  exchange: string;
  tradingsymbol: string;
  order_type: string;
  transaction_type: string;
  validity: string;
  product: string;
  quantity: number;
  disclosed_quantity: number;
  price: number;
  trigger_price: number;
  average_price: number;
  filled_quantity: number;
  pending_quantity: number;
  cancelled_quantity: number;
  tag: string | null;
  /** True iff the gateway simulated this order (DRYRUN-* id). */
  dryRun: boolean;
}

/**
 * Build a Kite-shaped status response from a gateway order_logs row.
 *
 * DRYRUN-* IDs are always synthesized as COMPLETE with filled_quantity ==
 * quantity, average_price == requested price (or 0 if market). This matches
 * the "trust the placement response" contract of dry-run mode.
 *
 * Real IDs are mapped from internal OrderStatus → Kite status string:
 *
 *   RECEIVED, SUBMITTING → 'TRIGGER PENDING'  (not yet at exchange)
 *   ACCEPTED             → 'OPEN'             (working at exchange)
 *   UNKNOWN              → 'OPEN'             (best guess pre-reconcile)
 *   COMPLETE             → 'COMPLETE'
 *   CANCELLED            → 'CANCELLED'
 *   REJECTED, ERROR      → 'REJECTED'
 */
export function buildStatusResponse(row: OrderLog): KiteShapedStatus[] {
  const isDryRun = (row.kiteOrderId ?? '').startsWith('DRYRUN-');

  if (isDryRun) {
    // Synthesize COMPLETE — strategy can proceed as if the fill happened.
    // Use the requested price as the average_price (best deterministic
    // approximation; we don't have a real fill price).
    const fillPrice = row.price ?? 0;
    return [{
      order_id: row.kiteOrderId ?? '',
      exchange_order_id: null,
      status: 'COMPLETE',
      status_message: null,
      order_timestamp: row.receivedAt,
      exchange_timestamp: row.completedAt ?? row.receivedAt,
      variety: row.variety,
      exchange: row.exchange,
      tradingsymbol: row.tradingsymbol,
      order_type: row.orderType,
      transaction_type: row.transactionType,
      validity: 'DAY',
      product: row.product,
      quantity: row.quantity,
      disclosed_quantity: 0,
      price: row.price ?? 0,
      trigger_price: row.triggerPrice ?? 0,
      average_price: fillPrice,
      filled_quantity: row.quantity,
      pending_quantity: 0,
      cancelled_quantity: 0,
      tag: row.tag,
      dryRun: true,
    }];
  }

  // Real Kite order — map internal status to Kite-style string
  return [{
    order_id: row.kiteOrderId ?? '',
    exchange_order_id: null,
    status: mapToKiteStatus(row.status),
    status_message: row.errorMessage,
    order_timestamp: row.receivedAt,
    exchange_timestamp: row.completedAt,
    variety: row.variety,
    exchange: row.exchange,
    tradingsymbol: row.tradingsymbol,
    order_type: row.orderType,
    transaction_type: row.transactionType,
    validity: 'DAY',
    product: row.product,
    quantity: row.quantity,
    disclosed_quantity: 0,
    price: row.price ?? 0,
    trigger_price: row.triggerPrice ?? 0,
    // For real orders we don't track avg_price / fills server-side
    // (PositionManager has it, but it lives in a different table). Callers
    // who need exact fill data should still go to Kite directly.
    average_price: 0,
    filled_quantity: row.status === 'COMPLETE' ? row.quantity : 0,
    pending_quantity: row.status === 'COMPLETE' ? 0 : row.quantity,
    cancelled_quantity: row.status === 'CANCELLED' ? row.quantity : 0,
    tag: row.tag,
    dryRun: false,
  }];
}

export function mapToKiteStatus(status: OrderStatus): string {
  switch (status) {
    case 'RECEIVED':
    case 'SUBMITTING': return 'TRIGGER PENDING';
    case 'ACCEPTED':
    case 'UNKNOWN':    return 'OPEN';
    case 'COMPLETE':   return 'COMPLETE';
    case 'CANCELLED':  return 'CANCELLED';
    case 'REJECTED':
    case 'ERROR':      return 'REJECTED';
    default:           return 'OPEN';
  }
}
