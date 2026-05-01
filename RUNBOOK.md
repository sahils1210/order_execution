# Order Gateway — Operator Runbook

**Audience:** trading operations lead on call.
**Assumption:** market is open, you have an alert in your face, you have ~60 seconds.

This document is **prescriptive**. Don't read top-to-bottom — search for the alert id and follow the steps.

---

## 0. Setup — paste these in your terminal once

```bash
# Replace with your actual values
export GW="https://gateway.your-domain.com"
export KEY="<GATEWAY_API_KEY>"

# One-shot helpers
alias gw='curl -s -H "X-API-Key: $KEY"'
alias gw-status='gw $GW/admin/status | jq'
alias gw-metrics='gw $GW/metrics | jq'
alias gw-diag='gw $GW/diagnostics | jq'
alias gw-pnl='gw $GW/pnl | jq'
alias gw-pos='gw $GW/positions | jq'
alias gw-halt='curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" -X POST $GW/admin/halt -d'
alias gw-resume='curl -s -H "X-API-Key: $KEY" -X POST $GW/admin/resume'
```

Then any time:

```bash
gw-status                       # quick risk dashboard
gw-metrics | jq '.alerts'       # current active alerts
gw-diag | jq '.kite, .postback' # liveness signals
gw-halt '{"reason":"manual: investigating X"}'
gw-resume
```

---

## 1. UNKNOWN orders spike  → `STALE_UNKNOWN`

### What happened
One or more orders are stuck in `UNKNOWN` state for >2 min. Either:
- Kite API timed out during placement and the reconciler hasn't resolved it, OR
- Reconciler is failing (`getOrders()` errors, token issue, network).

These orders **may or may not exist at the broker**. That's the danger.

### Risk: **MEDIUM** (CRITICAL if >5 stuck or >5 min old)

### Within 1 minute
```bash
gw-metrics | jq '.orders.staleUnknownCount, .orders.byStatus'
gw-diag    | jq '.kite, .accounts'
```

If `kite.connected = false` OR any account `valid = false` → jump to **TOKEN_INVALID** (§4) first.

### Investigation
```bash
# Find the actual stuck rows
gw "$GW/orders?status=UNKNOWN&limit=50" | jq '.orders[] | {tradingsymbol, transactionType, quantity, kiteOrderId, receivedAt, attempts}'
```

Now log into **Kite web** (kite.zerodha.com) → Orders tab. For each UNKNOWN row:
- **Has a `kite_order_id` AND visible at broker** → it's real. Reconciler will catch up; wait one tick (30s).
- **Has a `kite_order_id` but NOT at broker** → broker rejected it after returning the id; reconciler will mark REJECTED.
- **No `kite_order_id`** → never reached broker. Reconciler will abandon it after `OMS_ABANDON_AFTER_MS` (default 10 min).

### When to halt
Halt **immediately** if any of:
- ≥3 stuck UNKNOWNs each holding notional > ₹2L (real money you can't see)
- Reconciler hasn't logged in >2 min (check PM2 logs)
- Kite web shows orders our DB doesn't know about

```bash
gw-halt '{"reason":"UNKNOWN orders unreconciled, manual review"}'
```

### Recovery
1. Confirm each UNKNOWN's true state at the broker (Kite web).
2. Don't manually edit the DB. Let the reconciler tick OR force a sweep:
   ```bash
   pm2 restart order-gateway   # forces startup reconcile (24h lookback)
   ```
3. After all UNKNOWNs reach a terminal state, `gw-resume`.

### When to resume
- `staleUnknownCount = 0`
- `gw-pos` matches Kite web positions exactly

---

## 2. NO_POSTBACKS_DURING_MARKET

### What happened
No postback received for >10 min while NSE is open. Either:
- Webhook URL is misconfigured at Kite developer console
- Public DNS / nginx / SSL is down
- Kite postback service is delayed (rare, system-wide)

The **reconciler still works** — orders will fill correctly, just with 30s polling delay instead of <1s push. PnL/positions update via the reconciler path. So this is **degraded mode, not broken**.

### Risk: **MEDIUM** (HIGH if also have stuck UNKNOWNs)

### Within 1 minute
```bash
gw-diag | jq '.postback, .kite'
```

- `postback.secondsSinceLast` — how long since last one
- `postback.totalCount` — was anything received today at all?

### Investigation
External reachability test (from your laptop, NOT the server):
```bash
curl -I https://gateway.your-domain.com/webhook/kite
# Expect: 405 Method Not Allowed (POST-only) or similar 4xx
# If: timeout, 502, 503, ssl error → public reach is broken
```

Then on the server:
```bash
pm2 logs order-gateway --lines 100 | grep -i postback
sudo journalctl -u nginx --since '15 minutes ago' | tail -50
```

Check Kite developer console → Postback URL → matches `$GW/webhook/kite` exactly.

### When to fall back to reconciler-only mode
- Public webhook reach is broken AND nginx logs show 5xx → keep trading; reconciler is your safety net
- Reconciler is also failing → **halt immediately**, this is no longer degraded mode

### Recovery
- If nginx/DNS/SSL: fix infra, postbacks will resume automatically (Kite re-delivers).
- If Kite-side: nothing to do; wait. Reconciler covers you.
- If postback URL was changed: update Kite developer console.

### When to resume
N/A — you don't need to halt for this alone. Confirm `postback.secondsSinceLast` drops once fixed.

---

## 3. HIGH_LATENCY  → Kite RTT spike

### What happened
Kite API round-trip (post-rate-limiter) p95 > 1500ms or any single call > 5000ms.

This is **Kite RTT only** — does NOT include our internal queue wait. So this is a real broker/network problem, not a market-open queueing artefact.

### Risk: **MEDIUM** (CRITICAL during market open / volatile windows)

### Distinguish: network vs broker

```bash
# From the gateway server:
ping -c 5 api.kite.trade
curl -w '@-' -o /dev/null -s https://api.kite.trade <<'EOF'
time_namelookup: %{time_namelookup}\ntime_connect: %{time_connect}\ntime_starttransfer: %{time_starttransfer}\ntime_total: %{time_total}\n
EOF
```

- `time_total` < 200ms but our `kiteLatency.p95` > 1500ms → **broker-side** (Kite under load). Reduce trading rate, expect timeouts.
- `time_total` > 1000ms → **network-side**. Check VPS provider status, switch nginx upstream if you have a backup region.
- DNS time > 100ms → DNS issue. Switch resolvers (`/etc/resolv.conf`).

### When to reduce trading
- `kiteLatency.p95` > 2000ms sustained → ask strategy operators to throttle to <30 orders/min.
- Any `kiteLatency.max` > timeout (5000ms) → expect UNKNOWNs; monitor `staleUnknownCount`.

### When to halt
- `kiteLatency.p95` > 3000ms AND `unknownCount` rising → halt; trading blind is worse than not trading.

### Recovery
Latency spikes resolve on their own. After the alert clears (samples roll out of the 200-sample ring within ~10 min of normal traffic), `gw-resume`.

---

## 4. TOKEN_INVALID

### What happened
Kite access token is rejected by the API. Causes:
- Token expired (Kite expires daily ~7:30 AM IST; auto-refresh runs at `TOKEN_REFRESH_TIME` env, default 08:05)
- Auto-refresh failed (TOKEN_SERVICE_URL down)
- Token was manually invalidated (re-login from another machine)

**Order placement is blocked**. Cancel/modify still work (existing kill switch logic preserves operator's ability to reduce exposure).

### Risk: **CRITICAL** if market is open and you have open positions

### Step-by-step recovery

```bash
# 1) Confirm token state
gw-diag | jq '.token, .accounts'

# 2) Try the gateway's auto-refresh first
curl -s -H "X-API-Key: $KEY" -X POST $GW/refresh-token | jq

# If that succeeds → done. Recheck:
gw-diag | jq '.token.valid'   # should be true
```

If auto-refresh fails:

```bash
# 3) Manual re-login flow (Kite Connect)
#    a. In a browser, hit:
#       https://kite.zerodha.com/connect/login?api_key=<YOUR_API_KEY>&v=3
#    b. Login, copy the request_token from the redirect URL
#    c. Push to your token service or directly to .env:
#         TOKEN_SOURCE=env  → edit .env, set KITE_ACCESS_TOKEN=<new token>, then:
#         pm2 restart order-gateway
#         TOKEN_SOURCE=service → POST the request_token to your TOKEN_SERVICE_URL
```

For multi-account setups, repeat for each account that shows `valid: false` in `gw-diag.accounts`.

### Manual fallback (if Kite token system is down for hours)
1. `gw-halt '{"reason":"token system outage — manual position management"}'`.
2. Cancel/modify operations still work via `DELETE/PATCH /order/:orderId`.
3. Use Kite web UI directly for any new placements until tokens are recovered.
4. After the gateway gets a valid token: `pm2 restart order-gateway` to re-sync, then `gw-resume`.

### When to resume
- `gw-diag | jq '.token.valid'` → `true`
- A test placement (1-lot) returns ACCEPTED
- All accounts `valid: true`

---

## 5. POSTBACK_CONFLICT

### What happened
A postback's terminal status disagrees with our DB's terminal status for the same order. Example: DB says `COMPLETE`, postback says `REJECTED`. This means **either our state or the broker's state is wrong**, and we cannot tell which without manual verification.

If `POSTBACK_HALT_ON_CONFLICT=true` (recommended production default), the kill switch was already engaged automatically.

### Risk: **CRITICAL** — do not resume blindly

### Within 1 minute
```bash
gw-status | jq '.killSwitch'    # confirm halt is engaged
gw-metrics | jq '.postbacks.conflictCount'

# Find the conflicting orders
gw "$GW/orders?limit=50" | jq '.orders[] | select(.conflictMessage != null) | {id, kiteOrderId, tradingsymbol, status, conflictMessage}'
```

### Exact recovery sequence
1. **Halt is already on** (verify via `gw-status`). If not: `gw-halt '{"reason":"postback conflict, manual verify"}'`
2. **Verify at broker**: Open Kite web → Orders → search by the conflicting `kiteOrderId`. Note the **broker's authoritative state**.
3. **Decide source of truth**:
   - If broker shows `COMPLETE` and we have `REJECTED` → broker won. Manually verify the fill exists at the exchange (Kite reports tab).
   - If broker shows `REJECTED` and we have `COMPLETE` → our state is wrong. Worse case: we may have placed a duplicate hedge.
4. **Reconcile positions manually**:
   ```bash
   gw-pos | jq                 # what we think
   # Compare line-by-line to Kite web Positions tab
   ```
   Any mismatch is the actual exposure to fix at the broker via Kite web.
5. **Document** the incident — copy `conflictMessage` and the broker's reading into your incident log.
6. **Only then** `gw-resume`.

### When to resume
- Broker positions match `gw-pos` exactly
- All conflicting `kiteOrderId`s have a verified terminal state
- Operator has documented which side was authoritative

---

## 5b. Postback Quantity Mismatch (Partial Fill Conflict)

### What happened
DB and broker agree on terminal status (both `COMPLETE`) but disagree on **filled_quantity** or **average_price** for the same `kite_order_id`. Examples:
- DB booked `filled_quantity=200`, postback says `150` — DB **overstated** the fill (50 phantom shares in our position).
- DB booked `filled_quantity=150`, postback says `200` — DB **understated** (50 shares missing from our position).
- Same quantity, different `average_price` → cost basis is wrong, PnL distorted.

This is **NOT** what §5 covers. §5 is for terminal-status mismatches (`COMPLETE` vs `REJECTED` etc.). Quantity-level mismatches do NOT auto-engage the kill switch — the system thinks both sides agree the order is done. **You must catch this manually** via the partial-fill conflict alert or by routine position reconciliation.

#### Causes
- **Out-of-order postback regression**: a stale postback with old `filled_quantity` arrived after a newer one (the marginal-price idempotency only protects forward — `delta>0`; a regression `200→150` is silently dropped on the order_log row but may have been mis-applied previously).
- **Duplicate postback applied through different path**: e.g. webhook + reconciler both booked the same fill via different `postback_event_id` references.
- **Reconciliation drift**: reconciler patched `filled_quantity` from `getOrders()` but the broker's snapshot was mid-update.
- **Manual order placed via Kite web during gateway downtime**: recovery row created with wrong quantity.

#### Why this is dangerous
- **Phantom long/short**: strategy believes it has exposure that the broker doesn't have (or vice versa). Hedges fire against wrong baseline. Stop-losses placed for shares we don't actually own.
- **PnL distortion**: realized PnL booked on a fill that didn't happen — daily PnL log is wrong; risk limits trigger on fictional numbers.
- **Compounding error**: if the strategy places a fresh order based on the wrong baseline, the gateway double-positions or under-hedges at the broker.

### Risk
- **HIGH** if mismatch > 1 lot or affects an actively traded symbol
- **CRITICAL** if the mismatch sits on an open position and strategy is still firing on that symbol

### Within 1 minute
```bash
# 1) Halt explicitly — auto-halt does NOT fire on quantity mismatch.
gw-halt '{"reason":"quantity mismatch on order <kiteOrderId> — investigating"}'

# 2) Open Kite web (MANDATORY)
xdg-open "https://kite.zerodha.com/orders"
# Search for the kite_order_id from the alert / your detection.
# Record from broker: filled_quantity, average_price, status, timestamp.

# 3) Pull the gateway's view of that order
gw "$GW/orders?limit=50" | jq '.orders[] | select(.kiteOrderId=="<KITE_ORDER_ID>") | {id, tradingsymbol, transactionType, quantity, status, kiteResponse, conflictMessage}'

# 4) Pull current position for that symbol
gw-pos | jq '.positions[] | select(.tradingsymbol=="<SYMBOL>") | {netQuantity, averagePrice, totalBuyQty, totalSellQty, totalPnl}'
```

### Investigation

**Step 1 — Establish broker truth (Kite web is authoritative)**
- Kite web → Orders → search `kite_order_id`
- Record: `filled_quantity`, `average_price`, `status`, `order_timestamp`
- Kite web → Reports → Trades → filter by symbol → confirm individual trade-tick fills add up to the broker's `filled_quantity`

**Step 2 — Compare to gateway state**
```bash
# Compare quantity:
#   broker filled_quantity  vs  our kiteResponse.filled_quantity (in order_logs.kite_response JSON)
#   broker filled_quantity  vs  position.totalBuyQty / totalSellQty for this symbol/order

# Compare avg price:
#   broker average_price   vs  our position.averagePrice for the symbol
#   (only matters if this order was the dominant or sole contributor)
```

**Step 3 — Compare positions line-by-line**
```bash
# Print every non-zero position
gw-pos | jq '.positions[] | select(.netQuantity != 0) | {tradingsymbol, netQuantity, averagePrice, totalPnl}'
# Open Kite web → Positions tab → compare every line
```

**Step 4 — Classify the gap**

| Observation | Classification |
|---|---|
| Broker `filled_quantity` < DB-booked qty (broker says fewer shares) | DB **overstated** → phantom shares in our position |
| Broker `filled_quantity` > DB-booked qty (broker says more shares) | DB **understated** → real shares missing from our position |
| Quantities match, prices differ | Cost-basis drift only → PnL is wrong but exposure is correct |

### Decision tree

**Case A — Broker correct, DB wrong (most common)**
- Source of truth: broker.
- Identify the phantom or missing quantity precisely.
- Recovery: bring **broker** to match DB OR bring **DB** to match broker — see §5b Recovery below.

**Case B — DB correct, postback was glitched**
- Verify via Kite web → Reports → Trades. Sum individual trade ticks for this symbol on this order. If they total the DB-booked quantity, the postback that triggered the alert was a stale or partial broadcast.
- Recovery: no broker action needed. Mark the postback row as ignored in your incident log.

**Case C — Uncertain (broker view ambiguous, e.g. order partially filled and live)**
- **Stay halted.** Wait for the order to reach a final terminal state at broker (cancel it via `DELETE /order/:id` if it has been working too long).
- Re-verify after the order is fully terminal at broker.

### Recovery

**Hard rule: do NOT edit `data/orders.db` directly during market hours.** SQLite WAL writes are concurrent with the running process; manual edits race with the live process and corrupt state worse than the original mismatch.

#### Recovery path 1 — Bring broker to match DB (preferred when feasible)
Use this when the gap is small (≤ a few lots) and a same-day square-off is acceptable.
1. Calculate the delta: `delta = DB_qty − broker_qty`.
2. **Place an offsetting order at the broker via Kite web** (NOT via the gateway, which would re-enter the conflict loop):
   - DB overstated by 50 long → place SELL 50 at market via Kite web.
   - DB understated by 50 long → place BUY 50 at market via Kite web.
3. Verify on Kite web Positions tab that the broker now matches the gateway's view.
4. The next reconciliation tick will pull the new fills and align everything.

**Caveat**: this changes your real-money exposure. Only use when the delta is small and you accept the slippage cost.

#### Recovery path 2 — Bring DB to match broker (preferred when delta is large or expensive to square)
Use this when the broker is correct and reconciling DB is cheaper than placing offsetting trades.
1. Halt the gateway (already done).
2. **Stop the strategies** that trade this symbol — they cannot keep firing while DB is being repaired.
3. Make a backup: `cp data/orders.db data/orders.db.before-fix-$(date +%s)`.
4. Apply DB corrections **off-process** (gateway stopped):
   ```bash
   pm2 stop order-gateway
   sqlite3 data/orders.db
   # Adjust positions row to match broker
   #   UPDATE positions SET net_quantity=?, average_price=?, ... WHERE id=?;
   # OR insert a corrective position_fill row to bring totals in line
   #   INSERT INTO position_fills(...) VALUES(...);
   # See PositionManager.applyDelta() math before editing.
   ```
5. `pm2 restart order-gateway`. Startup recovery + reconciler verifies state.
6. Confirm `gw-pos` matches Kite web exactly.

**Caveat**: requires SQL fluency and a clear understanding of the position-fill ledger. If unsure → use Recovery path 1.

#### Recovery path 3 — Restart and let reconciler resync (last resort)
Only if the DB row appears corrupt and you don't trust either side:
1. Stop strategies for the affected symbol.
2. `pm2 restart order-gateway` — startup reconcile pulls 24h of broker state.
3. Verify `gw-pos` matches Kite web. If not → fall back to path 1 or 2.

### Document
Every quantity mismatch incident must be logged with:
- Timestamp
- `kite_order_id`
- DB state (qty, avg) BEFORE the fix
- Broker state from Kite web (qty, avg, trade ticks)
- Recovery path chosen
- Final state AFTER the fix
- Suspected root cause (out-of-order postback, reconciler drift, etc.)

This log is your evidence trail if a strategy or auditor questions the day's PnL.

### When to resume
**You may NOT skip any item.**

1. `gw-pos` matches Kite web Positions **exactly** — every symbol, every quantity, every avg-price within ₹0.05.
2. No `staleUnknownCount` and no other conflicts:
   ```bash
   gw-metrics | jq '.orders.staleUnknownCount, .postbacks.conflictCount'
   ```
3. No remaining quantity mismatches on any open position.
4. The strategy that placed the conflicting order is paused or has been informed and re-baselined.
5. Operator confident in current exposure (verbalize the open position to yourself before resuming).
6. Incident logged.
7. Then:
   ```bash
   gw-resume
   ```
8. Place a 1-lot probe on a low-volatility symbol and verify it flows ACCEPTED → COMPLETE → reflected in `gw-pos` correctly.

### Hard rules
- **Broker is always authoritative.** When DB and broker disagree, broker wins by default.
- **Never trust DB in a mismatch.** The gateway is the suspect during conflicts; its word is not authoritative.
- **Always verify `filled_quantity` explicitly** — don't infer from status flags. A `COMPLETE` row tells you nothing about how many shares actually moved.
- **No live DB edits.** Always stop the gateway before touching `data/orders.db`.
- **No silent recovery.** Every quantity-mismatch incident gets logged, even if the gap was 1 share.

---

## 6. Kill switch triggered

### What happened
Trading is halted. Cause is in `gw-status`:

| `source` | meaning |
|---|---|
| `manual` | operator pressed the button |
| `auto` | `RISK_AUTO_HALT_ERROR_THRESHOLD` errors in window |
| `position-risk` | `MAX_DAILY_LOSS` / `MAX_DAILY_PROFIT` / `MAX_POSITION_PER_SYMBOL` / `MAX_TOTAL_EXPOSURE` breached |
| `postback-conflict` | see §5 |

### Risk depends on source
- `position-risk` MAX_DAILY_LOSS: **CRITICAL** — you're at the loss cap; this is the system saving you
- `auto`: **HIGH** — broker or token problem
- `manual`: whatever you halted for
- `postback-conflict`: see §5 — never auto-resume

### Inspect cause
```bash
gw-status | jq
gw-metrics | jq '.alerts, .risk'
```

Then look at the recent log line:
```bash
pm2 logs order-gateway --lines 200 | grep -E 'KILL SWITCH|halt|breach' | tail -20
```

### Safely resume — checklist
**You may NOT skip any item.**

1. **Cause is identified and addressed**:
   - Position breach: positions reduced or limit raised intentionally
   - Auto-halt: errors stopped, root cause known
   - Token: §4 followed
   - Conflict: §5 followed
2. **No pending exposure that surprised you**:
   ```bash
   gw-pos | jq '.positions[] | {tradingsymbol, netQuantity, averagePrice, lastPrice, totalPnl}'
   ```
   Compare to Kite web Positions tab. They MUST match.
3. **No orders stuck**:
   ```bash
   gw-metrics | jq '.orders.staleUnknownCount, .orders.byStatus'
   ```
   `staleUnknownCount` must be `0`.
4. **Risk room remaining**: if MAX_DAILY_LOSS was hit, do you still have the same cap? If you intentionally raised it via env change, you must `pm2 restart order-gateway` for it to take effect.
5. **Resume**:
   ```bash
   gw-resume
   gw-status | jq '.killSwitch.halted'   # → false
   ```

### Ensure no pending exposure
A halt blocks **new placements only**. In-flight orders may still complete via postback. Before resuming, check:
```bash
gw "$GW/orders?status=ACCEPTED&limit=20" | jq '.orders | length'
```
Anything in ACCEPTED is a working order at the broker. Decide: cancel them (`DELETE /order/:orderId`) or let them fill — both are valid; just be deliberate.

---

## 7. System crash / restart

### What happened
Process exited (OOM, SIGKILL, panic) and PM2 restarted it.

### Post-restart checklist (in order)

```bash
# 1) Process is up
pm2 status | grep order-gateway   # → online

# 2) Public liveness
curl -s $GW/health/live           # → {"status":"ok"...}

# 3) Full health (auth required)
gw $GW/health/full | jq

# 4) Token is valid
gw-diag | jq '.token.valid, .accounts'

# 5) Kill switch state — DB-persisted, survives restart
gw-status | jq '.killSwitch'
# If halted=true → that's persistent state. Do NOT resume until you confirm
# why (see §6).

# 6) Position state restored from SQLite
gw-pos | jq '.count, .positions[].netQuantity'
# Compare to Kite web Positions. MUST match.

# 7) Reconciler completed startup sweep
pm2 logs order-gateway --lines 100 | grep -E 'Startup|Reconcile|Position manager'
# Look for: "Position manager initialized", "Reconcile sweep complete"

# 8) No stuck orders from before the crash
gw-metrics | jq '.orders.staleUnknownCount, .orders.byStatus.UNKNOWN'

# 9) Postback flow alive (only if market open)
gw-diag | jq '.postback.secondsSinceLast'
# After ~30s of normal traffic this should be small.
```

### Verify before resuming trading
- All 9 checks above pass
- A 1-lot test order on a low-vol symbol completes ACCEPTED → COMPLETE through the full path
- Strategies have NOT been double-fired (check their dedup; idempotencyKey reuse is the safety net)

### What if crash was during a fill?
Position state is journal'd at every fill via SQLite transaction. Worst case: a fill that arrived *during* the kill ms-window is replayed by Kite postback after restart, and the `(postback_event_id, order_log_id)` UNIQUE index drops it. Verified by audit. If `gw-pos` matches Kite web → you're fine.

---

## 8. Telegram alert flood

### Triage rules — what to act on, what to ignore

| Alert text contains | Action |
|---|---|
| `Postback CRITICAL conflict` | **STOP. §5 immediately.** |
| `Kill switch ENGAGED` (manual/auto) | §6 — read the reason in the message body |
| `[obs] STALE_UNKNOWN` | §1 |
| `[obs] TOKEN_INVALID` | §4 |
| `[obs] NO_POSTBACKS_DURING_MARKET` | §2 — usually webhook/nginx; check before halting |
| `[obs] HIGH_LATENCY` | §3 — only act if RTT (not queue) is the cause; alert already filters |
| `Postback recovery row created` | INFO. Means an orphan postback came in (manual order via Kite UI?). Check `gw-pos` matches |
| `Auto-halt: N order errors` | §6 source=auto |
| `Unhandled promise rejection` / `Uncaught exception` | Process likely restarted; do §7 |

### Dedup behavior — what to expect
- Critical observability alerts dedup **once per id per 5 minutes**. So a single ongoing issue produces 1 ping every 5 min, not a flood.
- Kill-switch alerts fire **once per engagement** (re-engage attempts are no-ops).
- Postback conflict critical fires immediately AND from observability — you may see two messages for one event. Don't take that as two events.

### When you're getting >5 alerts in 1 min
That itself is a red flag. Run:
```bash
gw-metrics | jq '.alerts | length'
```
- 1–2 active alerts: normal during incident
- 3–4: complex incident or cascading (e.g. token invalid → orders fail → repeated errors)
- 5+: something is fundamentally wrong; **halt and investigate** before any more activity

### Real vs noisy — quick test
A real signal updates `lastErrorMessage` or counters in `/diagnostics`. A stale repeat doesn't. If `gw-diag` looks clean and `gw-metrics.alerts` is empty but Telegram still pings, it's an old message in the cooldown window — ignore.

---

## 📋 Daily Operating Checklist

### Before market open (08:30 IST → 09:14 IST)

```bash
# 08:30 — token refresh window
gw-diag | jq '.token, .accounts'
# Expect: token.valid=true, lastRefreshedAt within last 30 min
# If not: §4 NOW (you have ~45 min)

# 08:45 — process & resources
pm2 status | grep order-gateway       # online, low memory
df -h /                                # disk > 20% free
gw $GW/health/full | jq

# 09:00 — risk state
gw-status | jq
# Expect: halted=false, no open circuit breakers, autoHalt errors=0

# 09:05 — yesterday's leftover positions
gw-pos | jq '.count, .positions[].netQuantity'
# Compare to Kite web — should match. If not, investigate before market open.

# 09:10 — webhook reachability (from your laptop, not the server)
curl -I https://gateway.your-domain.com/webhook/kite
# Expect: 4xx (405/404 fine — means it's reachable). Timeout/5xx = §2.

# 09:14 — clear yesterday's stale alerts cache (informational only)
# Telegram alert dedup memory is in-process; restart clears it. Don't restart
# unless you must — fresh dedup is not worth the disruption.
```

### During market (09:15 IST → 15:30 IST)

Every 30 minutes glance at these (or have the Socket.IO UI open):

```bash
gw-metrics | jq '{alerts: .alerts, status: .orders.byStatus, pnl: .risk.positions, kite: .runtime.kiteLatency}'
```

Watch for:
- `alerts` length > 0 → triage per §8
- `orders.byStatus.UNKNOWN > 0` for >2 min → §1
- `runtime.kiteLatency.p95 > 1500` → §3
- `risk.positions.totalPnl` approaching `MAX_DAILY_LOSS` → reduce risk preemptively
- `risk.killSwitch.halted = true` → §6

Spot-check positions vs broker once mid-day (12:30 IST is good):

```bash
gw-pos | jq '.positions[] | {tradingsymbol, netQuantity, totalPnl}'
# vs Kite web Positions
```

### After market close (15:30 IST → end of day)

```bash
# 15:31 — final reconcile sweep happens automatically; wait 1 min then verify
gw-metrics | jq '.orders.byStatus, .orders.staleUnknownCount'
# Expect: staleUnknownCount=0; no rows still in ACCEPTED/SUBMITTING/UNKNOWN

# 15:35 — daily PnL snapshot (save this)
gw-pnl > "logs/pnl-$(date +%F).json"
gw $GW/orders | jq > "logs/orders-$(date +%F).json"

# 15:45 — final position check
gw-pos | jq '.positions[] | select(.netQuantity != 0)'
# MIS should be auto-squared. Anything left = NRML/CNC carry-forward — confirm intentional.

# 16:00 — system health
pm2 status
df -h /
du -sh data/orders.db   # should be growing slowly; <500 MB at retail scale

# 16:00 — pruning (if configured)
# Old order_logs prune via pruneOldOrders() if scheduled; otherwise manual:
# Don't delete data/orders.db. Don't VACUUM during market hours.

# End of day — postback / metrics summary into your log
gw-metrics | jq '{date: .tradeDate, orders: .orders, postbacks: .postbacks, alerts: .alerts}' \
  >> "logs/daily-$(date +%F).log"
```

### Weekend tasks (Saturday or Sunday)
- Review the week's incident log
- Verify backups: `ls -la data/orders.db*` (WAL + main file)
- Confirm `KITE_API_SECRET` and `GATEWAY_API_KEY` rotation if due (quarterly)
- Check VPS provider status page for scheduled maintenance
- Review thresholds: `MAX_DAILY_LOSS`, rate limits — adjust based on the week's traffic

---

## Appendix — Quick reference

### All endpoints (auth: `X-API-Key: $KEY`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/health/live` | GET | Public liveness, no auth |
| `/health/full` | GET | Full system state |
| `/admin/status` | GET | Risk dashboard |
| `/admin/halt` | POST | Engage kill switch (body: `{"reason":"..."}`) |
| `/admin/resume` | POST | Disengage kill switch |
| `/orders` | GET | Order log (filters: `?status=&from=&to=&limit=`) |
| `/positions` | GET | Today's positions |
| `/pnl` | GET | Realized + unrealized PnL summary |
| `/metrics` | GET | Aggregated counters + alerts |
| `/diagnostics` | GET | Liveness probes |
| `/refresh-token` | POST | Force token refresh |
| `/order/:id` | DELETE/PATCH | Cancel / modify a working order |

### Critical env vars
| Var | Default | Notes |
|---|---|---|
| `MAX_DAILY_LOSS` | 0 (disabled) | Set to your real cap |
| `MAX_DAILY_PROFIT` | 0 (disabled) | Lock-in target |
| `MAX_POSITION_PER_SYMBOL` | 0 (disabled) | Absolute qty cap |
| `MAX_TOTAL_EXPOSURE` | 0 (disabled) | Sum of `\|net\|·price` across symbols |
| `POSTBACK_HALT_ON_CONFLICT` | true | KEEP TRUE in production |
| `POSTBACK_REQUIRE_VALID_CHECKSUM` | true | KEEP TRUE in production |
| `RISK_AUTO_HALT_ERROR_THRESHOLD` | 20 | Errors per 60s before kill switch |
| `OMS_RECONCILE_INTERVAL_MS` | 30000 | Reconciler tick |
| `KITE_TIMEOUT_MS` | 5000 | Per-call Kite timeout |

### Log locations
- `pm2 logs order-gateway` — application logs
- `/var/log/nginx/access.log`, `/var/log/nginx/error.log` — webhook reachability
- `data/orders.db` — SQLite, source of truth (don't edit live)

### When you don't know what to do
1. `gw-halt '{"reason":"investigating: <one-line description>"}'`
2. Open Kite web in another tab.
3. Read this runbook section that matches the alert.
4. If still unclear: halt is the safe state. Trading nothing < trading wrong.
