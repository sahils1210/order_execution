import { Router, Request, Response } from 'express';
import { positionManager } from '../positions/PositionManager.js';

// =========================================
// GET /positions  → all positions for today (or ?date=YYYY-MM-DD)
// GET /pnl        → realized + unrealized totals + per-symbol breakdown
// =========================================

export const positionsRouter = Router();

positionsRouter.get('/', (req: Request, res: Response): void => {
  const date = (req.query.date as string | undefined) || undefined;
  const positions = positionManager.getPositions(date);
  res.json({
    tradeDate: date ?? positionManager.currentTradeDate(),
    count: positions.length,
    positions,
  });
});

export const pnlRouter = Router();

pnlRouter.get('/', (req: Request, res: Response): void => {
  const date = (req.query.date as string | undefined) || undefined;
  res.json(positionManager.getPnlSummary(date));
});
