import { Router, Request, Response } from 'express';
import { orderManager } from '../oms/OrderManager.js';
import { accountRegistry } from '../kite/AccountRegistry.js';
import { logger } from '../logger.js';
import type { OrderRequest, OrderStatus } from '../types.js';

// =========================================
// POST /order/multi
//
// Execute the SAME logical order across multiple accounts in parallel.
//
// Idempotency is per-account: each (idempotencyKey, accountId) is its own row
// in the DB and gets its own stable `tag`. Retrying the request returns cached
// results per account — no follower duplicates.
// =========================================

export const orderMultiRouter = Router();

interface MultiOrderRequest extends OrderRequest {
  accounts: string[];
}

interface AccountResult {
  success: boolean;
  status: OrderStatus | null;
  orderId?: string;
  error?: string;
  latencyMs: number;
  cached: boolean;
}

orderMultiRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as MultiOrderRequest;

  const missing: string[] = [];
  for (const f of ['idempotencyKey', 'source', 'accounts', 'exchange', 'tradingsymbol',
                   'transactionType', 'quantity', 'product', 'orderType']) {
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

  // Validate accounts exist (master is always implicit)
  const known = new Set<string>(['master', ...accountRegistry.getAccountIds()]);
  const unknown = body.accounts.filter((id) => !known.has(id));
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

  // Place per-account, in parallel. Each account placement is fully idempotent.
  const placements = body.accounts.map(async (accountId): Promise<[string, AccountResult]> => {
    const r = await orderManager.placeOrder(body, accountId);
    return [accountId, {
      success: r.success,
      status: r.status,
      orderId: r.orderId ?? undefined,
      error: r.error ?? undefined,
      latencyMs: r.latencyMs,
      cached: r.cached,
    }];
  });

  const settled = await Promise.allSettled(placements);
  const results: Record<string, AccountResult> = {};
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const [id, result] = s.value;
      results[id] = result;
    }
    // OrderManager.placeOrder catches internally and never throws — `rejected` shouldn't happen.
  }

  // Summarise: 200 if at least one succeeded, 502 otherwise.
  const anySuccess = Object.values(results).some((r) => r.success);
  const statusCode = anySuccess ? 200 : 502;

  res.status(statusCode).json({ results });
});
