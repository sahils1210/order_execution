import type { KiteErrorKind } from '../kite/errors.js';

// =========================================
// HTTP status mapping for cancel/modify failures.
//
// Lives in its own file (no transitive imports of database/Kite SDK) so it
// can be unit-tested with vanilla jest, without dragging the Node sqlite
// dependency into the test runner.
//
// Mapping rationale — see orderActions.ts header comment.
// =========================================

export function httpStatusForErrorKind(kind: KiteErrorKind | null | undefined): number {
  switch (kind) {
    case 'TOKEN':           return 401;
    case 'REJECTED':
    case 'INPUT':
    case 'PERMISSION':
    case 'GENERAL':         return 409;
    case 'TIMEOUT':
    case 'CONNECT_FAILED':
    case 'GATEWAY_5XX':
    case 'MIDFLIGHT_RESET': return 502;
    default:                return 502;  // pre-Kite failure (no kind) — conservative
  }
}
