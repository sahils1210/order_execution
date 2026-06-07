import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

function optFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

function optBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (!v) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function optList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: optInt('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),

  gatewayApiKey: required('GATEWAY_API_KEY'),

  kite: {
    apiKey: required('KITE_API_KEY'),
    apiSecret: optional('KITE_API_SECRET', ''),
    tokenSource: optional('KITE_TOKEN_SOURCE', 'service') as 'env' | 'service',
    accessToken: optional('KITE_ACCESS_TOKEN', ''),
    tokenServiceUrl: optional('TOKEN_SERVICE_URL', ''),
    tokenRefreshTime: optional('TOKEN_REFRESH_TIME', '08:05'),
    timeoutMs: optInt('KITE_TIMEOUT_MS', 5000),
  },

  db: {
    path: optional('DB_PATH', './data/orders.db'),
  },

  oms: {
    reconcileIntervalMs:         optInt('OMS_RECONCILE_INTERVAL_MS',          30_000),
    reconcileLookbackMs:         optInt('OMS_RECONCILE_LOOKBACK_MS',         30 * 60_000),
    startupReconcileLookbackMs:  optInt('OMS_STARTUP_RECONCILE_LOOKBACK_MS', 24 * 3600_000),
    postTimeoutReconcileDelayMs: optInt('OMS_POST_TIMEOUT_RECONCILE_DELAY_MS', 5_000),
    maxReceivedAgeMs:            optInt('OMS_MAX_RECEIVED_AGE_MS', 60_000),
    abandonAfterMs:              optInt('OMS_ABANDON_AFTER_MS', 10 * 60_000),
    postbackPreferenceMs:        optInt('OMS_POSTBACK_PREFERENCE_MS', 60_000),
  },

  risk: {
    maxQtyPerOrder:                optInt('RISK_MAX_QTY_PER_ORDER',                 100_000),
    maxNotionalPerOrder:           optInt('RISK_MAX_NOTIONAL_PER_ORDER',         50_000_000),
    maxOrdersPerMinuteGlobal:      optInt('RISK_MAX_ORDERS_PER_MIN_GLOBAL',            120),
    maxOrdersPerMinutePerSource:   optInt('RISK_MAX_ORDERS_PER_MIN_PER_SOURCE',         60),
    symbolBlocklist:               optList('RISK_SYMBOL_BLOCKLIST', []),

    circuitBreakerThreshold:   optInt('RISK_CB_THRESHOLD',     5),
    circuitBreakerWindowMs:    optInt('RISK_CB_WINDOW_MS', 60_000),
    circuitBreakerCooldownMs:  optInt('RISK_CB_COOLDOWN_MS', 5 * 60_000),

    autoHaltErrorThreshold:    optInt('RISK_AUTO_HALT_ERROR_THRESHOLD',     20),
    autoHaltWindowMs:          optInt('RISK_AUTO_HALT_WINDOW_MS',       60_000),
  },

  // ── Position Manager / PnL Protection ───────────────────────────────────
  // 0 / unset = limit disabled. Daily loss is a POSITIVE number (compared
  // against |totalPnL| when totalPnL < 0). Daily profit triggers at
  // totalPnL >= maxDailyProfit. Position/exposure are absolute caps.
  positions: {
    enabled:                optBool('POSITIONS_ENABLED', true),
    maxDailyLoss:           optFloat('MAX_DAILY_LOSS',           0),
    maxDailyProfit:         optFloat('MAX_DAILY_PROFIT',         0),
    maxPositionPerSymbol:   optFloat('MAX_POSITION_PER_SYMBOL',  0),
    maxTotalExposure:       optFloat('MAX_TOTAL_EXPOSURE',       0),
    /** Min ms between consecutive risk evaluations per (account,symbol). */
    evalDebounceMs:         optInt('POSITIONS_EVAL_DEBOUNCE_MS', 100),
    /** Auto-halt on breach. If false, only logs+alerts (no kill switch). */
    haltOnBreach:           optBool('POSITIONS_HALT_ON_BREACH',  true),
  },

  // ── Postback / webhook ──────────────────────────────────────────────────
  // Defaults are PRODUCTION-SAFE. Dev environments must override explicitly.
  postback: {
    /** Reject postbacks whose checksum does not match. */
    requireValidChecksum: optBool('POSTBACK_REQUIRE_VALID_CHECKSUM', true),
    /** Engage kill switch when DB terminal differs from postback terminal. */
    haltOnConflict:       optBool('POSTBACK_HALT_ON_CONFLICT',       true),
    /** Reject postbacks that did not arrive over HTTPS (X-Forwarded-Proto). */
    requireHttps:         optBool('POSTBACK_REQUIRE_HTTPS',          true),
    /** Optional IP allowlist. Empty = disabled (URL secrecy + checksum is the gate). */
    allowedIps:           optList('POSTBACK_ALLOWED_IPS', []),
    bodyLimitBytes:       optInt('POSTBACK_BODY_LIMIT_BYTES', 32 * 1024),
  },

  // ── AMO fallback on market-closed rejection ─────────────────────────────
  // When TRUE *and* mode is LIVE (not dry-run): if Kite rejects a regular
  // order with the "markets not open / try AMO" signature, OrderManager
  // transparently retries the same order with variety='amo'. The Kite order
  // then queues for the next session's open.
  //
  // Default FALSE. **Real-money implication**: an AMO order queued on
  // Sunday WILL execute Monday 9:15 IST if its limit price is achievable.
  // Only enable when the operator wants this behaviour and accepts that
  // tradeoff (e.g. for a strategy that explicitly wants post-market
  // exposure when blocked).
  //
  // The detector triggers ONLY on Kite's literal "try placing an AMO order"
  // suggestion (and a couple of safe variants) — see oms/amoFallback.ts.
  // Generic rejections (margin, expiry, permissions) never trigger the
  // fallback.
  amoFallback: {
    onMarketClosed: optBool('AMO_FALLBACK_ON_MARKET_CLOSED', false),
  },

  // ── Dry-run mode ────────────────────────────────────────────────────────
  // When `outsideHours` is true AND NSE is closed (Mon–Fri 09:15–15:30 IST is
  // "open"; everything else is closed including weekends), placeOrder skips
  // the Kite call and returns a synthetic ACCEPTED with `kiteOrderId =
  // "DRYRUN-..."` so strategies can validate their pair-matching logic
  // without placing real orders. Inside market hours: ALWAYS live, regardless
  // of the flag — the time check is the safety gate, not the flag.
  dryRun: {
    outsideHours: optBool('DRY_RUN_OUTSIDE_HOURS', false),
  },

  // ── WebSocket (UI dashboard) ────────────────────────────────────────────
  ws: {
    /** Require X-API-Key (or `auth.apiKey`) on every Socket.IO connection. */
    requireApiKey: optBool('WS_REQUIRE_API_KEY', true),
  },

  // ── Token architecture ──────────────────────────────────────────────────
  /**
   * When TRUE: every non-master account request MUST carry
   * `accountTokens[accountId]` in the body. Missing → HTTP 422
   * `MISSING_ACCOUNT_TOKEN`. The gateway never falls back to its
   * AccountRegistry token for non-master accounts in this mode.
   *
   * When FALSE (legacy): gateway falls back to AccountRegistry-managed
   * tokens when `accountTokens` is absent. `accountTokens` is still
   * honoured if supplied.
   *
   * Default FALSE for first deploy; flip to TRUE after Scalper-side
   * UnifiedTokenSource is verified in soak.
   */
  strictAccountTokens: optBool('STRICT_ACCOUNT_TOKENS', false),

  // ── Alerts ──────────────────────────────────────────────────────────────
  alerts: {
    telegram: {
      botToken: optional('TELEGRAM_BOT_TOKEN', ''),
      chatId:   optional('TELEGRAM_CHAT_ID',   ''),
    },
  },

  corsOrigins: optList('CORS_ORIGINS', ['http://localhost:5173']),
} as const;
