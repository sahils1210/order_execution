# Order Gateway — Production Deployment Guide

This is the runbook for taking the gateway from a clean VPS to live trading.

---

## Architecture

```
                                     ┌──── Telegram (alerts)
                                     │
   ┌──────────┐  HTTPS  ┌─────────┐  │  HTTPS  ┌──────────────┐
   │ 100-ALGO │────────▶│         │──┴────────▶│  Zerodha     │
   └──────────┘         │  nginx  │            │  Kite API    │
   ┌──────────┐  HTTPS  │  + SSL  │  HTTPS     └──────────────┘
   │ ultra-or │────────▶│         │◀─── postback ───┘
   └──────────┘         └────┬────┘
                             │ proxy_pass localhost:3000
                             ▼
                   ┌────────────────────┐
                   │ Order Gateway      │
                   │ (Node, PM2)        │
                   │ + SQLite (data/)   │
                   └────────────────────┘

   Second VM (monitor) ──────► curl /health/live ──▶ Telegram on alert
```

---

## 1. VPS Setup

```bash
# DigitalOcean → Create Droplet
#   - OS: Ubuntu 22.04 LTS
#   - Size: $12/mo (1 vCPU, 2 GB RAM, 50 GB SSD)
#   - Region: BLR1 (Bangalore — closest to Zerodha)
#   - Monitoring + IPv6 enabled
#   - Add SSH key
# Note the static IPv4 — you will whitelist it with Zerodha.
```

```bash
ssh root@<droplet-ip>
apt update && apt upgrade -y
apt install -y curl ufw fail2ban nginx certbot python3-certbot-nginx sqlite3 chrony

# Indian time + NTP
timedatectl set-timezone Asia/Kolkata
systemctl enable --now chrony

# Node.js 20 + PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# App user (do NOT run as root)
useradd -m -s /bin/bash gateway
mkdir -p /home/gateway/app /home/gateway/backups
chown -R gateway:gateway /home/gateway
```

---

## 2. Whitelist IP with Zerodha

1. https://kite.zerodha.com → My Apps → your app → API Settings
2. Add the **droplet's static IPv4** to allowed IPs
3. Save

---

## 3. Deploy Code

```bash
# From your machine — push to a private repo, then on the server:
sudo -iu gateway
cd /home/gateway/app
git clone <repo-url> .

npm install --production
cd ui && npm install && npm run build && cd ..
npm run build

mkdir -p logs data
```

---

## 4. SSL — nginx + Let's Encrypt

> **HTTPS is REQUIRED.** The gateway rejects postbacks that arrive without `X-Forwarded-Proto: https` (POSTBACK_REQUIRE_HTTPS=true).

Point a DNS A-record (e.g. `gateway.example.com`) to the droplet IP, wait for propagation, then:

```bash
# /etc/nginx/sites-available/gateway
server {
    listen 80;
    server_name gateway.example.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;          # critical for postback HTTPS check
        proxy_set_header   Upgrade           $http_upgrade;    # Socket.IO
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 75s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d gateway.example.com   # auto-installs HTTPS server block + auto-renew
```

Verify:
```bash
curl -i https://gateway.example.com/health/live   # → 200 ok
```

---

## 5. Firewall (UFW)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from <your-office-ip> to any port 22 proto tcp     # SSH — restrict to your IP
ufw allow 80/tcp                                              # http (cert renewal)
ufw allow 443/tcp                                             # https (postback + UI)
# DO NOT open 3000 publicly — nginx proxies to localhost.
ufw enable
ufw status verbose
```

If 100-ALGO and ultra-order are on different VMs, allow their IPs to hit 443:
```bash
ufw allow from <100-ALGO-server-ip> to any port 443 proto tcp
ufw allow from <ultra-order-server-ip> to any port 443 proto tcp
```

---

## 6. Telegram Bot (alerts)

```bash
# 1. On Telegram, message @BotFather
#    /newbot → choose name + username → save the token shown.
# 2. Add the bot to a chat (private chat is fine), send any message.
# 3. Get the chat ID:
curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | python3 -m json.tool
#    → look for "chat":{"id": <CHAT_ID>}
```

You will paste these into `.env` (next step).

---

## 7. Environment Variables

```bash
sudo -u gateway nano /home/gateway/app/.env
```

Production-ready `.env`:

```bash
# ── Server ──────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000
DB_PATH=/home/gateway/app/data/orders.db

# ── Auth ────────────────────────────────────────────────────────────────
GATEWAY_API_KEY=<generate-with: openssl rand -hex 32>

# ── Kite ────────────────────────────────────────────────────────────────
KITE_API_KEY=<from kite.zerodha.com app>
KITE_API_SECRET=<from kite.zerodha.com app>          # REQUIRED for postback checksum
KITE_TOKEN_SOURCE=service                             # or 'env' as fallback
TOKEN_SERVICE_URL=https://your-token-service.example.com/api/fetchToken
TOKEN_REFRESH_TIME=08:05
KITE_TIMEOUT_MS=5000

# ── Postback (HARDENED defaults) ────────────────────────────────────────
POSTBACK_REQUIRE_VALID_CHECKSUM=true
POSTBACK_HALT_ON_CONFLICT=true
POSTBACK_REQUIRE_HTTPS=true
POSTBACK_ALLOWED_IPS=                                 # optional, comma-separated

# ── Risk caps ───────────────────────────────────────────────────────────
RISK_MAX_QTY_PER_ORDER=10000
RISK_MAX_NOTIONAL_PER_ORDER=10000000
RISK_MAX_ORDERS_PER_MIN_GLOBAL=120
RISK_MAX_ORDERS_PER_MIN_PER_SOURCE=60
RISK_AUTO_HALT_ERROR_THRESHOLD=20
RISK_AUTO_HALT_WINDOW_MS=60000

# ── WebSocket ───────────────────────────────────────────────────────────
WS_REQUIRE_API_KEY=true

# ── Alerts ──────────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_CHAT_ID=<from getUpdates>

# ── CORS ────────────────────────────────────────────────────────────────
CORS_ORIGINS=https://gateway.example.com

# ── Multi-account (optional) ────────────────────────────────────────────
# ACCOUNTS_JSON=[{"id":"huf","apiKey":"...","tokenServiceUrl":"..."}]
```

```bash
chmod 600 /home/gateway/app/.env       # secrets
chown gateway:gateway /home/gateway/app/.env
```

> **UI dashboard note:** Because `WS_REQUIRE_API_KEY=true`, the React UI must pass the API key when connecting. In `ui/src/.../socket.ts`:
> ```ts
> const socket = io({ auth: { apiKey: import.meta.env.VITE_API_KEY } });
> ```
> Set `VITE_API_KEY` in `ui/.env` and rebuild the UI.

---

## 8. Configure Kite Postback URL

1. https://kite.zerodha.com → My Apps → your app → "Postback URL"
2. Set to: `https://gateway.example.com/webhook/kite`
3. Save.

---

## 9. Start with PM2

```bash
sudo -iu gateway
cd /home/gateway/app
pm2 start ecosystem.config.js
pm2 save
exit                                  # back to root for the startup hook
pm2 startup systemd -u gateway --hp /home/gateway
# → run the printed `systemctl enable` command
```

Verify:
```bash
sudo -u gateway pm2 status
sudo -u gateway pm2 logs order-gateway --lines 50
curl -i https://gateway.example.com/health/live
curl -i -H "X-API-Key: $GATEWAY_API_KEY" https://gateway.example.com/health/full
```

---

## 10. Backup Cron (gateway VM)

```bash
sudo -iu gateway crontab -e
```

```cron
# Snapshot SQLite + WAL checkpoint daily at 16:30 IST (after market close)
30 16 * * 1-5 sqlite3 /home/gateway/app/data/orders.db "PRAGMA wal_checkpoint(TRUNCATE);" && cp /home/gateway/app/data/orders.db /home/gateway/backups/orders_$(date +\%Y\%m\%d).db

# Prune local backups older than 90 days
0 17 * * * find /home/gateway/backups -name 'orders_*.db' -mtime +90 -delete
```

For off-site retention (recommended), additionally rsync to DO Spaces or another droplet:
```cron
45 16 * * 1-5 rsync -az /home/gateway/backups/ user@backup-host:/path/to/gateway-backups/
```

---

## 11. Monitor (Second VM)

Spin up a second tiny droplet ($4/mo, any region — does NOT need to be BLR1). It runs only the watchdog so it survives the gateway VM going down.

```bash
# On monitor VM
apt install -y curl jq

cat > /usr/local/bin/gateway-monitor.sh <<'EOF'
#!/usr/bin/env bash
set -u

GATEWAY_URL="${GATEWAY_URL:-https://gateway.example.com}"
API_KEY="${GATEWAY_API_KEY:?missing}"
TG_TOKEN="${TELEGRAM_BOT_TOKEN:?missing}"
TG_CHAT="${TELEGRAM_CHAT_ID:?missing}"
STATE_FILE="/var/run/gateway-monitor.state"
mkdir -p "$(dirname "$STATE_FILE")"

alert() {
  curl -sS --max-time 5 -X POST \
    "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d "chat_id=${TG_CHAT}" \
    -d "text=$1" >/dev/null || true
}

# 1. Liveness
LIVE=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/health/live" || echo 000)
if [[ "$LIVE" != "200" ]]; then
  alert "🚨 Gateway DOWN — /health/live returned ${LIVE}"
  exit 0
fi

# 2. Full health (tokens, halt, etc.)
FULL=$(curl -sS --max-time 5 -H "X-API-Key: ${API_KEY}" "${GATEWAY_URL}/health/full" || echo '{}')
HALTED=$(echo "$FULL" | jq -r '.halted // false')
TOKEN_VALID=$(echo "$FULL" | jq -r '.token.valid // false')
KITE_OK=$(echo "$FULL" | jq -r '.kiteConnected // false')

LAST_HALTED=$(cat "$STATE_FILE" 2>/dev/null || echo "false")
if [[ "$HALTED" == "true" && "$LAST_HALTED" != "true" ]]; then
  REASON=$(echo "$FULL" | jq -r '.haltReason // "unknown"')
  alert "🛑 Gateway HALTED — reason: ${REASON}"
fi
echo "$HALTED" > "$STATE_FILE"

if [[ "$TOKEN_VALID" != "true" ]]; then
  alert "⚠️ Kite token INVALID"
fi
if [[ "$KITE_OK" != "true" ]]; then
  alert "⚠️ Kite API unreachable from gateway"
fi
EOF

chmod +x /usr/local/bin/gateway-monitor.sh

cat > /etc/cron.d/gateway-monitor <<'EOF'
GATEWAY_URL=https://gateway.example.com
GATEWAY_API_KEY=<paste-your-key>
TELEGRAM_BOT_TOKEN=<paste>
TELEGRAM_CHAT_ID=<paste>

* * * * * root /usr/local/bin/gateway-monitor.sh
EOF
```

Test once: `bash /usr/local/bin/gateway-monitor.sh` (set env vars in shell first).

---

## 12. Update Strategy Apps

In each strategy app's `.env`:
```bash
ORDER_GATEWAY_URL=https://gateway.example.com
ORDER_GATEWAY_API_KEY=<same as GATEWAY_API_KEY>
```

> **CRITICAL CONTRACT:** strategies MUST reuse the same `idempotencyKey` for retries of the same logical order. Generating a new UUID on each retry will cause double placement. The gateway returns:
> - `200` ACCEPTED/COMPLETE — order placed
> - `202` UNKNOWN — outcome pending; do NOT retry, poll `/orders` instead
> - `409` in-flight duplicate — wait briefly, retry SAME key
> - `422` REJECTED or KEY_REUSE — do not retry
> - `502` ERROR — never reached Kite; safe to retry SAME key

---

## 13. Pre-Flight Smoke Tests

```bash
# Replace gateway.example.com / KEY as appropriate.
GW=https://gateway.example.com
KEY=$GATEWAY_API_KEY

# 1. Live + full health
curl -i $GW/health/live
curl -i -H "X-API-Key: $KEY" $GW/health/full

# 2. Kill switch round-trip (during a non-trading hour)
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"reason":"smoke test"}' $GW/admin/halt
curl -X POST -H "X-API-Key: $KEY" $GW/admin/resume
# → expect Telegram alerts for both events

# 3. Place + cancel a far-from-market LIMIT order
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{
       "idempotencyKey":"smoke-1","source":"smoke","exchange":"NSE","tradingsymbol":"SBIN",
       "transactionType":"BUY","quantity":1,"product":"CNC","orderType":"LIMIT","price":1
     }' $GW/order
# → 200 ACCEPTED, note the orderId

curl -X DELETE -H "X-API-Key: $KEY" "$GW/order/<order-id>"
# → 200 cancelled

# 4. Verify postback arrived
sqlite3 /home/gateway/app/data/orders.db \
  "SELECT id, status, tag, checksum_valid FROM postback_events ORDER BY id DESC LIMIT 5;"
# → recent rows, checksum_valid=1
```

---

## ✅ Go-Live Checklist

- [ ] Droplet in BLR1, static IP whitelisted with Zerodha
- [ ] DNS A-record points to droplet
- [ ] HTTPS via Let's Encrypt working (`curl -i https://...` shows valid cert)
- [ ] `nginx` config sets `X-Forwarded-Proto $scheme`
- [ ] UFW: 22 (your IP only), 80, 443 — port 3000 NOT exposed
- [ ] PM2 running, `pm2 startup` configured for boot
- [ ] `.env` file mode 600, owned by `gateway` user
- [ ] `POSTBACK_REQUIRE_VALID_CHECKSUM=true`
- [ ] `POSTBACK_HALT_ON_CONFLICT=true`
- [ ] `POSTBACK_REQUIRE_HTTPS=true`
- [ ] `WS_REQUIRE_API_KEY=true`
- [ ] `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` set
- [ ] Backup cron scheduled (16:30 IST)
- [ ] Off-site backup destination configured
- [ ] Monitor VM running, Telegram alerts firing on test halt
- [ ] Both strategy apps updated with `ORDER_GATEWAY_URL` + key
- [ ] UI rebuilt with `VITE_API_KEY` so Socket.IO connects
- [ ] Postback URL in Kite developer console points to `https://.../webhook/kite`
- [ ] Smoke tests above all pass during a non-trading hour
- [ ] Kill switch tested: halt → blocks new orders, allows cancel
- [ ] Operations runbook printed / saved (token failure, kill switch, restart)

---

## Rollout Plan (real money)

| Phase | Days | Scale | Watch |
|---|---|---|---|
| Soak | 1–3 | Far-from-market LIMITs at qty=1 during market | Lifecycle: ACCEPTED → CANCELLED. Inspect every log line + Telegram event. |
| Single | 4–7 | One strategy, one symbol, position cap = 1 lot, max 5 trades/day | Postback delivery, tag matching, reconcile sweeps |
| Small | 8–14 | Two strategies, position cap = 5 lots | Conflict count, error rate, queue depth |
| Scale | 15–30 | Full strategies, 50% of normal caps | Weekly review of `postback_events.conflict=1`, abandoned orders |
| Full | 30+ | Full caps | Weekly review |

Rollback: each strategy has a `USE_GATEWAY=false` flag. Flip + restart strategy → reverts to direct-Kite path.

---

## Operations Runbook

### Token expired / refresh failed
```bash
# Manual refresh (after fixing token service or pasting fresh token to env)
curl -X POST -H "X-API-Key: $KEY" https://gateway.example.com/refresh-token
```
Fallback: set `KITE_TOKEN_SOURCE=env`, paste today's token in `KITE_ACCESS_TOKEN`, `pm2 restart order-gateway`.

### Engage kill switch
```bash
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"reason":"manual halt"}' https://gateway.example.com/admin/halt
```

### Resume after halt
```bash
curl -X POST -H "X-API-Key: $KEY" https://gateway.example.com/admin/resume
```

### Investigate a conflict
```bash
sqlite3 /home/gateway/app/data/orders.db <<'SQL'
SELECT id, idempotency_key, status, conflict_message, kite_order_id
  FROM order_logs WHERE conflict_message IS NOT NULL ORDER BY id DESC LIMIT 20;

SELECT id, order_id, tag, status, conflict, conflict_message, raw_payload
  FROM postback_events WHERE conflict = 1 ORDER BY id DESC LIMIT 20;
SQL
```

### Reconcile by hand (rare)
```bash
# Force a sweep — restart triggers reconcileOnStartup
sudo -u gateway pm2 restart order-gateway
sudo -u gateway pm2 logs order-gateway --lines 200
```

### View all activity for one order
```bash
sqlite3 /home/gateway/app/data/orders.db \
  "SELECT * FROM order_logs WHERE client_idempotency_key = '<key>';"
sqlite3 /home/gateway/app/data/orders.db \
  "SELECT * FROM postback_events WHERE order_id = '<kite-order-id>';"
```

### Restore from backup
```bash
sudo -u gateway pm2 stop order-gateway
sudo -u gateway cp /home/gateway/backups/orders_YYYYMMDD.db /home/gateway/app/data/orders.db
sudo -u gateway pm2 start order-gateway
```
