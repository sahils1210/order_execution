import { Router, Request, Response } from 'express';
import { getOrderLogs } from '../db/database.js';

// =========================================
// GET /orders — Fetch order logs with filters
// =========================================

export const ordersRouter = Router();

ordersRouter.get('/', (req: Request, res: Response): void => {
  const { source, status, from, to, limit, offset } = req.query;

  const logs = getOrderLogs({
    source: source as string | undefined,
    status: status as string | undefined,
    from: from as string | undefined,
    to: to as string | undefined,
    limit: limit ? parseInt(String(limit), 10) : 200,
    offset: offset ? parseInt(String(offset), 10) : 0,
  });

  res.json({ orders: logs, count: logs.length });
});
