# Order Gateway — Deployment Guide

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Machine / Cloud                                            │
│                                                                  │
│  ┌──────────────┐     HTTP POST      ┌─────────────────────┐   │
│  │  100-ALGO    │ ──────────────────► │                     │   │
│  │  (Python)    │                    │   ORDER GATEWAY     │   │
│  └──────────────┘                    │   (Node.js)         │   │
│                                      │   Static IP VPS     │──►  Zerodha
│  ┌──────────────┐     HTTP POST      │                     │    Kite API
│  │ ultra-order  │ ──────────────────► │                     │
│  │ (Node.js)    │                    └─────────────────────┘
│  └──────────────┘
└─────────────────────────────────────────────────────────────────┘
```

## Step 1: Provision VPS (DigitalOcean Droplet)

1. Create a **Basic Droplet**:
   - OS: Ubuntu 22.04 LTS
   - Size: $6/mo (1 vCPU, 1 GB RAM) — sufficient for this gateway
   - Region: **Mumbai** (BOM1) — lowest latency to Zerodha
   - Enable: Monitoring, IPv6

2. Note the **static IP** — you'll whitelist this in Zerodha

3. Add SSH key during creation

## Step 2: Initial Server Setup

```bash
# Connect
ssh root@<your-droplet-ip>

# Update system
apt update && apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install PM2
npm install -g pm2

# Create app user (don't run as root)
useradd -m -s /bin/bash gateway
usermod -aG sudo gateway

# Create app directory
mkdir -p /home/gateway/app
chown gateway:gateway /home/gateway/app
```

## Step 3: Whitelist IP in Zerodha

1. Go to [kite.zerodha.com](https://kite.zerodha.com) → My Apps → Your App → API Settings
2. Add the **Droplet's IP** to allowed IPs
3. Save

## Step 4: Deploy Gateway

```bash
# On your local machine — copy files to server
rsync -avz --exclude node_modules --exclude dist --exclude ui/node_modules \
  "D:/Master/order execution/" \
  gateway@<your-droplet-ip>:/home/gateway/app/

# Or use git (recommended):
# Push to a private GitHub repo, then on server:
# git clone <repo-url> /home/gateway/app
```

```bash
# On the server
cd /home/gateway/app

# Copy and fill .env
cp .env.example .env
nano .env
# Fill in: GATEWAY_API_KEY, KITE_API_KEY, TOKEN_SERVICE_URL, etc.

# Install dependencies
npm install --production

# Build UI
cd ui && npm install && npm run build && cd ..

# Build TypeScript
npm run build

# Create logs directory
mkdir -p logs data

# Test run
node dist/index.js
# Should see: "Order Gateway running port=3000"
# Ctrl+C to stop
```

## Step 5: Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # follow the printed command to enable on reboot

# Monitor
pm2 logs order-gateway
pm2 status
```

## Step 6: Firewall (UFW)

```bash
# Allow SSH + gateway port
ufw allow 22
ufw allow 3000  # or your configured PORT
ufw enable

# Restrict port 3000 to your app servers only (optional but recommended):
ufw delete allow 3000
ufw allow from <100-ALGO-server-ip> to any port 3000
ufw allow from <ultra-order-server-ip> to any port 3000
```

## Step 7: Nginx Reverse Proxy (Optional but Recommended)

For SSL termination and standard port (443):

```bash
apt install -y nginx certbot python3-certbot-nginx

# /etc/nginx/sites-available/gateway
server {
    listen 80;
    server_name your-gateway-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Keep-alive to backend
        proxy_set_header Connection "";
        keepalive_timeout 65;
    }
}

ln -s /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# SSL
certbot --nginx -d your-gateway-domain.com
```

## Step 8: Update Existing Apps

Add to each app's `.env`:
```bash
ORDER_GATEWAY_URL=http://<droplet-ip>:3000
ORDER_GATEWAY_API_KEY=<same-as-GATEWAY_API_KEY-in-gateway-.env>
```

Then follow `clients/INTEGRATION_GUIDE.md`.

## Step 9: Verify

```bash
# From your app server, test the gateway:
curl -s http://<droplet-ip>:3000/health | python3 -m json.tool

# Expected:
# {
#   "status": "ok",
#   "kiteConnected": true,
#   "uptime": 42,
#   ...
# }

# Test order endpoint (dry run with wrong symbol to see validation):
curl -s -X POST http://<droplet-ip>:3000/order \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{"idempotencyKey":"test-1","source":"test","exchange":"NFO","tradingsymbol":"TEST","transactionType":"BUY","quantity":1,"product":"MIS","orderType":"MARKET"}' \
  | python3 -m json.tool
```

## Monitoring & Operations

```bash
# View live logs
pm2 logs order-gateway --lines 100

# View error log
tail -f logs/error.log

# Query orders DB directly
sqlite3 data/orders.db "SELECT * FROM order_logs ORDER BY received_at DESC LIMIT 20;"

# Restart
pm2 restart order-gateway

# Manual token refresh
curl -X POST http://localhost:3000/refresh-token \
  -H "X-API-Key: your-api-key"

# Check uptime/stats
pm2 info order-gateway
```

## Backup

```bash
# Backup order database (run daily via cron)
cp data/orders.db data/orders_$(date +%Y%m%d).db

# Crontab entry:
# 0 16 * * 1-5 cp /home/gateway/app/data/orders.db /home/gateway/backups/orders_$(date +\%Y\%m\%d).db
```

## Performance Notes

| Metric | Expected |
|--------|----------|
| Order round-trip (gateway to Kite) | 50–150ms |
| Gateway overhead (auth + log + idempotency) | 2–5ms |
| Total latency (app → gateway → Kite) | 60–200ms |
| Throughput | 100+ concurrent orders (Node.js async) |
| Memory usage | ~80MB (Node.js + SQLite) |
| Disk (orders.db, 1 year of 500 orders/day) | ~50MB |

The keep-alive connections between apps and gateway, and between gateway and Kite, eliminate TCP handshake overhead on subsequent requests.
