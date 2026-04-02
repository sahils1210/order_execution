import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// =========================================
// API Key Authentication Middleware
//
// Clients must send:
//   X-API-Key: <GATEWAY_API_KEY>
//
// This is simple and sufficient for a private
// internal service. No JWT complexity needed.
// =========================================

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.gatewayApiKey) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing X-API-Key' });
    return;
  }
  next();
}
