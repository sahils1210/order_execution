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

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  gatewayApiKey: required('GATEWAY_API_KEY'),

  kite: {
    apiKey: required('KITE_API_KEY'),
    apiSecret: optional('KITE_API_SECRET', ''),
    tokenSource: optional('KITE_TOKEN_SOURCE', 'service') as 'env' | 'service',
    accessToken: optional('KITE_ACCESS_TOKEN', ''),
    tokenServiceUrl: optional('TOKEN_SERVICE_URL', ''),
    tokenRefreshTime: optional('TOKEN_REFRESH_TIME', '08:05'),
    timeoutMs: parseInt(optional('KITE_TIMEOUT_MS', '5000'), 10),
  },

  db: {
    path: optional('DB_PATH', './data/orders.db'),
  },

  idempotencyTtlMs: parseInt(optional('IDEMPOTENCY_TTL_MS', '300000'), 10),
  maxRetries: parseInt(optional('MAX_RETRIES', '1'), 10),

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim()),
} as const;
