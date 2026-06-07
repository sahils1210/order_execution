// =========================================
// amoFallback — pure pattern detector that recognises Kite's "markets not
// open, try AMO" rejection. Used by OrderManager.placeOrder to decide
// whether a freshly-rejected order should be transparently retried with
// variety='amo'.
//
// Lives in its own dependency-free file so jest can test the matcher
// without dragging the database / Kite SDK / config into the test runner.
//
// We deliberately match on the EXACT operative phrase "try placing an amo
// order" (case-insensitive) — that is the suggestion Kite itself gives, and
// it is the most reliable signal that an AMO retry is the correct action.
// We do NOT trigger on bare "market is closed" or similar, because that
// phrase also appears in unrelated errors (e.g. permission denied for a
// segment) where AMO would not help and might mask the real issue.
// =========================================

const MARKET_CLOSED_PHRASES: ReadonlyArray<string> = [
  'try placing an amo order',
  'try placing amo order',           // tolerate Kite copy variants
  'markets are not open for trading',
];

/**
 * Returns true iff `message` looks like a Kite "regular order rejected because
 * market is closed, try AMO instead" response. Pure, case-insensitive.
 */
export function isMarketClosedRejection(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return MARKET_CLOSED_PHRASES.some((phrase) => lower.includes(phrase));
}
