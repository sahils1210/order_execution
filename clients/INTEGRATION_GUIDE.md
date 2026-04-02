# Order Gateway — Integration Guide

## Overview

Both existing apps need to:
1. Add `ORDER_GATEWAY_URL` and `ORDER_GATEWAY_API_KEY` to their `.env`
2. Replace direct Kite API order calls with a call to the gateway client
3. Keep all signal generation, risk management, and position tracking unchanged

---

## Project A: 100-ALGO (Python/FastAPI)

### Step 1 — Add env vars to `backend/.env`

```bash
ORDER_GATEWAY_URL=http://<gateway-vps-ip>:3000
ORDER_GATEWAY_API_KEY=your-shared-gateway-api-key
```

### Step 2 — Copy client

Copy `clients/python/gateway_client.py` to:
```
backend/app/services/gateway_client.py
```

### Step 3 — Update `kite_service.py`

The only function that needs changing is `place_order()` in `kite_service.py`.

**Current code** (around line 455):
```python
async def place_order(self, ...):
    order_id = self.kite.place_order(
        variety=KiteConnect.VARIETY_REGULAR,
        exchange=exchange,
        tradingsymbol=tradingsymbol,
        transaction_type=transaction_type,
        quantity=quantity,
        product=product,
        order_type=order_type,
        ...
    )
    return order_id
```

**Replace with:**
```python
from app.services.gateway_client import GatewayClient
from app.core.config import settings

# Create client once (module level or in __init__)
_gateway = GatewayClient(
    gateway_url=settings.ORDER_GATEWAY_URL,
    api_key=settings.ORDER_GATEWAY_API_KEY,
    source="100-ALGO",
)

async def place_order(self, exchange, tradingsymbol, transaction_type,
                      quantity, product, order_type, price=None,
                      trigger_price=None, tag=None, idempotency_key=None):
    result = await _gateway.send_order(
        exchange=exchange,
        tradingsymbol=tradingsymbol,
        transaction_type=transaction_type,
        quantity=quantity,
        product=product,
        order_type=order_type,
        price=price,
        trigger_price=trigger_price,
        tag=tag,
        idempotency_key=idempotency_key,
    )
    if not result.success:
        raise Exception(f"Gateway order failed: {result.message}")
    return result.order_id
```

### Step 4 — Add idempotency keys to `order_executor.py`

In `execute_entry()` and `execute_exit()`, generate an idempotency key before calling `place_order()`:

```python
import uuid

# In execute_entry(), before calling kite_service.place_order():
idempotency_key = str(uuid.uuid4())  # unique per attempt

order_id = await self.kite_service.place_order(
    ...
    idempotency_key=idempotency_key,
)
```

This ensures that if `execute_entry()` retries, the gateway returns the cached result instead of placing a second order.

### Step 5 — Add settings to `core/config.py`

```python
class Settings(BaseSettings):
    ...
    ORDER_GATEWAY_URL: str = ""
    ORDER_GATEWAY_API_KEY: str = ""
```

### Step 6 — Shutdown cleanup

In `app/main.py` lifespan, close the gateway client on shutdown:

```python
async with asynccontextmanager(lifespan):
    yield
    await _gateway.close()  # cleanup persistent HTTP connections
```

### What does NOT change

- All signal detection logic (CHARLIES, TANGO, BBC, etc.)
- Trade arbiter, state manager, risk manager
- Position tracking, P&L, Firebase sync
- WebSocket ticker subscription
- All REST API endpoints and frontend

---

## Project B: ultra-order (Node.js/TypeScript)

### Step 1 — Add env vars to `.env`

```bash
ORDER_GATEWAY_URL=http://<gateway-vps-ip>:3000
ORDER_GATEWAY_API_KEY=your-shared-gateway-api-key
```

### Step 2 — Copy client

Copy `clients/node/gateway-client.ts` to:
```
server/src/services/GatewayClient.ts
```

### Step 3 — Modify `KiteService.ts`

Replace the `placeOrder()` method:

**Current** (`server/src/services/KiteService.ts`, around line 200):
```typescript
async placeOrder(params: PlaceOrderParams): Promise<{ order_id: string }> {
  // ... rate limiter ...
  return await this.masterRateLimiter.execute(async () => {
    return await this.kite.placeOrder(params.variety, params);
  });
}
```

**Replace with:**
```typescript
import { gatewayClient } from './GatewayClient';

async placeOrder(params: PlaceOrderParams): Promise<{ order_id: string }> {
  const result = await gatewayClient.sendOrder({
    source: 'ultra-order',
    exchange: params.exchange as any,
    tradingsymbol: params.tradingsymbol,
    transactionType: params.transaction_type as 'BUY' | 'SELL',
    quantity: params.quantity,
    product: params.product as any,
    orderType: params.order_type as any,
    variety: params.variety as any,
    price: params.price,
    triggerPrice: params.trigger_price,
    tag: params.tag,
  });

  if (!result.success || !result.orderId) {
    throw new Error(`Gateway order failed: ${result.message}`);
  }

  return { order_id: result.orderId };
}
```

### Step 4 — Keep `ClientKiteService.ts` unchanged

The client (follower) account still calls Kite directly — it's already on the same VPS/IP as ultra-order. Only the master account's order flow needs to route through the gateway.

Alternatively, if you want to route both through the gateway, create a second gateway instance with CLIENT Kite credentials.

### Step 5 — Add idempotency keys in `ExecutionEngine.ts`

```typescript
import { randomUUID } from 'crypto';

// In placeOrder(), before calling kiteService.placeOrder():
const idempotencyKey = randomUUID();
// Pass it through your params or use it as a tag
```

Since ultra-order's `ExecutionEngine` already has duplicate detection via `pendingOrders` Set, you mainly need the idempotency key for the gateway's dedup protection across retries.

### What does NOT change

- TradeReplicator, PositionReplicator
- MarketDataEngine, OptionChainManager
- WebSocketGateway (Socket.IO)
- PostbackHandler
- All UI components and stores
- Rate limiter (now enforced at gateway level, but keeping local is fine for safety)

---

## Idempotency Key Strategy

| Scenario | Recommended approach |
|----------|---------------------|
| 100-ALGO entry order | Generate UUID per `execute_entry()` call |
| 100-ALGO exit order | Generate UUID per `execute_exit()` call |
| ultra-order user click | Generate UUID in ExecutionEngine before dispatch |
| Retry after network error | **Reuse the same UUID** — gateway returns cached result |

**Key rule**: Generate one UUID per *intent*, not per *attempt*. On retry, reuse the same key.

---

## Environment Variables Summary

### Both apps need:
```bash
ORDER_GATEWAY_URL=http://165.xxx.xxx.xxx:3000  # gateway VPS static IP
ORDER_GATEWAY_API_KEY=your-long-random-secret
```

### Gateway `.env` needs:
```bash
GATEWAY_API_KEY=your-long-random-secret          # same value
KITE_API_KEY=your_kite_api_key
TOKEN_SERVICE_URL=https://token-xdpxv.ondigitalocean.app/api/fetchToken
```

The gateway holds the only Kite credentials. Remove `KITE_API_KEY` / `KITE_ACCESS_TOKEN` from both existing apps once migration is complete.
