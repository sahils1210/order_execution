"""
Order Gateway Client — Python (async)

Drop this into 100-ALGO to replace direct Kite API calls.
Provides: send_order(), with idempotency key + retry on gateway failure.

Usage:
    from gateway_client import GatewayClient

    client = GatewayClient(
        gateway_url=settings.ORDER_GATEWAY_URL,
        api_key=settings.ORDER_GATEWAY_API_KEY,
    )
    result = await client.send_order(
        exchange="NFO",
        tradingsymbol="NIFTY24MAR24100CE",
        transaction_type="SELL",
        quantity=50,
        product="MIS",
        order_type="MARKET",
        source="100-ALGO",
    )
"""

import asyncio
import uuid
import logging
from dataclasses import dataclass, field
from typing import Optional, Literal
import httpx

logger = logging.getLogger(__name__)

Exchange = Literal["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"]
TransactionType = Literal["BUY", "SELL"]
Product = Literal["CNC", "MIS", "NRML"]
OrderType = Literal["MARKET", "LIMIT", "SL", "SL-M"]
Variety = Literal["regular", "amo", "co", "iceberg"]


@dataclass
class OrderResult:
    success: bool
    order_id: Optional[str] = None
    message: Optional[str] = None
    latency_ms: int = 0


@dataclass
class GatewayClient:
    """
    Async HTTP client for the Order Gateway.

    Creates a persistent httpx.AsyncClient with keep-alive connections
    for minimal overhead on repeated calls.
    """

    gateway_url: str
    api_key: str
    timeout_ms: int = 8000
    max_retries: int = 2
    retry_delay_ms: int = 300
    source: str = "100-ALGO"

    _client: Optional[httpx.AsyncClient] = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self.gateway_url = self.gateway_url.rstrip("/")

    def _get_client(self) -> httpx.AsyncClient:
        """Lazy-initialize persistent client with keep-alive."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.gateway_url,
                headers={
                    "X-API-Key": self.api_key,
                    "Content-Type": "application/json",
                    "Connection": "keep-alive",
                },
                timeout=httpx.Timeout(self.timeout_ms / 1000),
                # Keep-alive pool: persist connections between requests
                limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
            )
        return self._client

    async def send_order(
        self,
        exchange: Exchange,
        tradingsymbol: str,
        transaction_type: TransactionType,
        quantity: int,
        product: Product,
        order_type: OrderType,
        *,
        variety: Variety = "regular",
        price: Optional[float] = None,
        trigger_price: Optional[float] = None,
        tag: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> OrderResult:
        """
        Send an order to the gateway.

        The idempotency_key is auto-generated if not provided.
        The same key can be sent multiple times safely — the gateway
        will return the cached result after the first execution.
        """
        payload: dict = {
            "idempotencyKey": idempotency_key or str(uuid.uuid4()),
            "source": self.source,
            "exchange": exchange,
            "tradingsymbol": tradingsymbol,
            "transactionType": transaction_type,
            "quantity": quantity,
            "product": product,
            "orderType": order_type,
            "variety": variety,
        }
        if price is not None:
            payload["price"] = price
        if trigger_price is not None:
            payload["triggerPrice"] = trigger_price
        if tag is not None:
            payload["tag"] = tag

        return await self._post_with_retry("/order", payload, self.max_retries)

    async def health(self) -> dict:
        """Check gateway health (no auth required)."""
        try:
            client = self._get_client()
            res = await client.get("/health")
            return res.json()
        except Exception as e:
            return {"status": "unreachable", "error": str(e)}

    async def _post_with_retry(
        self, path: str, payload: dict, retries_left: int
    ) -> OrderResult:
        try:
            client = self._get_client()
            res = await client.post(path, json=payload)
            data = res.json()

            # Client-side errors (400, 409) — don't retry
            if res.status_code < 500:
                return OrderResult(
                    success=data.get("success", False),
                    order_id=data.get("orderId"),
                    message=data.get("message"),
                    latency_ms=data.get("latencyMs", 0),
                )

            # 5xx — retry if we have attempts left
            if retries_left > 0:
                logger.warning(
                    "Gateway returned %d, retrying (%d left)",
                    res.status_code,
                    retries_left,
                )
                await asyncio.sleep(self.retry_delay_ms / 1000)
                return await self._post_with_retry(path, payload, retries_left - 1)

            return OrderResult(
                success=False,
                message=f"Gateway error: HTTP {res.status_code}",
                latency_ms=data.get("latencyMs", 0),
            )

        except (httpx.TimeoutException, httpx.ConnectError, httpx.NetworkError) as e:
            if retries_left > 0:
                logger.warning(
                    "Gateway network error: %s, retrying (%d left)", e, retries_left
                )
                await asyncio.sleep(self.retry_delay_ms / 1000)
                # Re-create client on network error
                await self.close()
                return await self._post_with_retry(path, payload, retries_left - 1)

            logger.error("Gateway unreachable after retries: %s", e)
            return OrderResult(success=False, message=f"Gateway unreachable: {e}")

    async def close(self) -> None:
        """Close the HTTP client. Call on app shutdown."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> "GatewayClient":
        return self

    async def __aexit__(self, *_) -> None:
        await self.close()
