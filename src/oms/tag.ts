import { createHash } from 'crypto';

// =========================================
// Order tag — stable, 16-char identifier embedded in every Kite order
//
// Kite's `tag` field is capped at 20 chars. We use exactly 16 chars: 'og' + 14 hex.
// Tag = sha1(`${clientIdempotencyKey}::${accountId}`) → first 14 hex chars, prefixed.
//
// The tag is the bridge between our DB row and Kite's order book during
// reconciliation. Same input always produces the same tag, so a retry that
// races with a real fill can be matched back to its DB row.
// =========================================

export function makeTag(clientIdempotencyKey: string, accountId: string): string {
  const hash = createHash('sha1')
    .update(clientIdempotencyKey)
    .update('::')
    .update(accountId)
    .digest('hex');
  return `og${hash.substring(0, 14)}`; // total 16 chars
}
