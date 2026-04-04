import { Router, Request, Response } from 'express';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { kiteClient } from '../kite/KiteClient.js';
import { logger } from '../logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// POST /order/multi
//
// Execute one order across multiple accounts in parallel.
// One account failure never blocks others.
//
// Request body:
//   {
//     idempotencyKey: string,       // unique UUID — deduplicated per account
//     source: string,
//     accounts: string[],           // ["master", "huf"] — must be registered
//     exchange: string,
//     tradingsymbol: string,
//     transactionType: "BUY"|"SELL",
//     quantity: number,
//     product: string,
//     orderType: string,
//     variety?: string,
//     price?: number,
//     triggerPrice?: number,
//     tag?: string
//   }
//
// Response:
//   {
//     results: {
//       master: { success: true,  orderId: "12345", latencyMs: 87 },
//       huf:    { success: false, error: "Token invalid", latencyMs: 120 }
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────

export const orderMultiRouter = Router();

interface MultiOrderRequest {
  idempotencyKey: string;
  source: string;
  accounts: string[];
  exchange: string;
  tradingsymbol: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  product: string;
  orderType: string;
  variety?: string;
  price?: number;
  triggerPrice?: number;
  tag?: string;
}

interface AccountResult {
  success: boolean;
  orderId?: string;
  error?: string;
  latencyMs: number;
}

orderMultiRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as MultiOrderRequest;

  // ── Validate required fields ──────────────────────────────────────────────
  const missing: string[] = [];
  for (const f of ['idempotencyKey', 'source', 'accounts', 'exchange', 'tradingsymbol', 'transactionType', 'quantity', 'product', 'orderType']) {
    if (body[f as keyof MultiOrderRequest] == null) missing.push(f);
  }
  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    return;
  }

  if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
    res.status(400).json({ error: 'accounts must be a non-empty array of account IDs' });
    return;
  }

  // ── Validate requested accounts exist ─────────────────────────────────────
  const unknown = body.accounts.filter(
    (id) => id !== 'master' && !accountRegistry.getAccountIds().includes(id)
  );
  if (unknown.length > 0) {
    res.status(400).json({ error: `Unknown account IDs: ${unknown.join(', ')}` });
    return;
  }

  logger.info('Multi-account order received', {
    idempotencyKey: body.idempotencyKey,
    accounts: body.accounts,
    symbol: body.tradingsymbol,
    type: body.transactionType,
    qty: body.quantity,
    source: body.source,
  });

  // ── Execute per-account in parallel ──────────────────────────────────────
  const executions = body.accounts.map(async (accountId): Promise<[string, AccountResult]> => {
    const start = Date.now();

    try {
      let orderId: string;

      if (accountId === 'master') {
        // Master uses the existing KiteClient (token refresh, retry logic, etc.)
        orderId = await kiteClient.placeOrder({
          idempotencyKey: body.idempotencyKey,
          source: body.source,
          exchange: body.exchange as any,
          tradingsymbol: body.tradingsymbol,
          transactionType: body.transactionType,
          quantity: body.quantity,
          product: body.product as any,
          orderType: body.orderType as any,
          variety: body.variety as any,
          price: body.price,
          triggerPrice: body.triggerPrice,
          tag: body.tag,
        });
      } else {
        // Additional accounts use AccountRegistry
        const kite = accountRegistry.getKite(accountId);
        if (!kite) throw new Error(`Account ${accountId} not found in registry`);
        if (!accountRegistry.isValid(accountId)) throw new Error(`Account ${accountId} has invalid token`);

        const variety = body.variety ?? 'regular';
        const params: Record<string, unknown> = {
          exchange: body.exchange,
          tradingsymbol: body.tradingsymbol,
          transaction_type: body.transactionType,
          quantity: body.quantity,
          product: body.product,
          order_type: body.orderType,
          ...(body.price != null && { price: body.price }),
          ...(body.triggerPrice != null && { trigger_price: body.triggerPrice }),
          ...(body.tag && { tag: body.tag }),
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await Promise.race([
          (kite as any).placeOrder(variety, params),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Kite API timeout')), 10000)
          ),
        ]);
        orderId = (result as { order_id: string }).order_id;
      }

      const latencyMs = Date.now() - start;

      logger.info('Multi-account order placed', {
        account: accountId,
        orderId,
        symbol: body.tradingsymbol,
        latencyMs,
      });

      return [accountId, { success: true, orderId, latencyMs }];

    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const error = String(err);

      logger.error('Multi-account order failed', {
        account: accountId,
        symbol: body.tradingsymbol,
        error,
        latencyMs,
      });

      return [accountId, { success: false, error, latencyMs }];
    }
  });

  const settled = await Promise.allSettled(executions);

  const results: Record<string, AccountResult> = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const [id, result] = s.value;
      results[id] = result;
    }
    // allSettled on an async fn that catches internally — fulfilled always
  }

  const allFailed = Object.values(results).every((r) => !r.success);
  const statusCode = allFailed ? 500 : 200;

  res.status(statusCode).json({ results });
});
