// =========================================
// NSE market-hours check (IST, weekdays 09:15–15:30).
//
// Pure, dependency-free, so it can be imported by OrderManager AND
// MetricsService without creating cycles, and tested without pulling in
// node:sqlite via the database module.
//
// Holiday awareness: this function does NOT know about NSE holidays
// (Diwali on a Wednesday, Republic Day, etc.). On a holiday weekday during
// 09:15–15:30 IST it returns `true` (market "open"). Holiday handling is a
// separate concern — adding it requires a maintained calendar source which
// we don't have. For the dry-run feature specifically, the safety cost of
// "lives Kite on a holiday" is at worst an [INPUT] reject from Kite for any
// order placed, not real-money risk.
// =========================================

// Use seconds-of-day precision (not minutes) so 15:30:00 is open but 15:30:01
// is closed — matches the standard interpretation of "close at 15:30".
const NSE_OPEN_IST_SEC  =  9 * 3600 + 15 * 60; // 33_300  (09:15:00)
const NSE_CLOSE_IST_SEC = 15 * 3600 + 30 * 60; // 55_800  (15:30:00)
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * Returns true iff `now` is within the NSE session (Mon–Fri, 09:15–15:30 IST).
 *
 * @param now defaults to `new Date()`. Accept a Date for deterministic tests.
 */
export function isMarketOpenIST(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  // Use UTC getters on the shifted Date — that gives us IST wall-clock fields.
  const dow = ist.getUTCDay();           // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  const sec = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  return sec >= NSE_OPEN_IST_SEC && sec <= NSE_CLOSE_IST_SEC;
}
