import type { OrderStatus } from '../types.js';

// =========================================
// Kite order status → our OrderStatus mapping.
//
// Single source of truth. Used by:
//   - Reconciler  (kite.getOrders() result rows)
//   - PostbackHandler (postback `status` field)
//
// Kite's status field uses the same vocabulary in both contexts, so one mapping suffices.
// =========================================

export function mapKiteStatus(kiteStatus: string | null | undefined): OrderStatus | null {
  if (!kiteStatus) return null;
  switch (kiteStatus.toUpperCase()) {
    case 'COMPLETE':
      return 'COMPLETE';

    case 'CANCELLED':
    case 'CANCELLED AMO':
      return 'CANCELLED';

    case 'REJECTED':
      return 'REJECTED';

    case 'OPEN':
    case 'TRIGGER PENDING':
    case 'OPEN PENDING':
    case 'AMO REQ RECEIVED':
    case 'PUT ORDER REQ RECEIVED':
    case 'VALIDATION PENDING':
    case 'MODIFY VALIDATION PENDING':
    case 'MODIFY PENDING':
    case 'UPDATE':
      return 'ACCEPTED';

    default:
      return null; // unknown — leave the row alone
  }
}

export function isTerminalStatus(s: OrderStatus): boolean {
  return s === 'COMPLETE' || s === 'REJECTED' || s === 'CANCELLED' || s === 'ERROR';
}
