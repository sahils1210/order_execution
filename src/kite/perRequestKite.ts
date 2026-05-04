// =========================================
// perRequestKite — single-shot KiteConnect factory
//
// Constructs a fresh KiteConnect bound to a caller-supplied accessToken.
// Used when a request body carries `accountTokens[accountId]`: we MUST NOT
// mutate the shared AccountRegistry instance via setAccessToken (concurrent
// requests for the same account would race on the shared connection state).
//
// Construction is cheap — KiteConnect is a thin HTTP wrapper, no network I/O
// at instantiation. The returned object is intentionally typed `any` because
// the npm `kiteconnect` types omit several methods we use elsewhere.
// =========================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { KiteConnect } = require('kiteconnect') as { KiteConnect: new (p: { api_key: string }) => import('kiteconnect').Connect };

export function makePerRequestKite(apiKey: string, accessToken: string): import('kiteconnect').Connect {
  const kite = new KiteConnect({ api_key: apiKey });
  kite.setAccessToken(accessToken);
  return kite;
}
