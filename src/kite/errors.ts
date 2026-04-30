// =========================================
// Kite Error Classification
//
// Replaces brittle string matching like `err.toLowerCase().includes('token')`.
// Decisions based on this classifier drive retry policy, so it must be precise.
// =========================================

export type KiteErrorKind =
  | 'TIMEOUT'         // OUR Promise.race timeout fired before Kite responded — DO NOT retry
  | 'CONNECT_FAILED'  // never reached Kite (DNS / refused) — safe to retry
  | 'MIDFLIGHT_RESET' // request was sent, connection lost mid-flight — DO NOT retry, reconcile
  | 'GATEWAY_5XX'     // Kite returned 5xx — retry once
  | 'TOKEN'           // expired/invalid token — refresh, retry once
  | 'REJECTED'        // OrderException — Kite rejected the order (RMS, lot size, etc.) — DO NOT retry
  | 'INPUT'           // InputException — bad params — DO NOT retry
  | 'PERMISSION'      // PermissionException — user not allowed — DO NOT retry
  | 'GENERAL';        // GeneralException — unknown Kite-side problem — DO NOT retry

export interface ClassifiedError {
  kind: KiteErrorKind;
  message: string;
  status: number | null;
  errorType: string | null;
  retryable: boolean;
}

/** Sentinel thrown by our own timeout race */
export class KiteTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Kite call exceeded ${timeoutMs}ms timeout`);
    this.name = 'KiteTimeoutError';
  }
}

/**
 * Pull the salient fields off whatever the kiteconnect SDK or axios threw at us.
 * The SDK throws plain objects with `error_type` and `message`, axios errors carry
 * `response.status` and `code`. Node fetch errors carry `cause.code`.
 */
export function classifyKiteError(err: unknown): ClassifiedError {
  if (err instanceof KiteTimeoutError) {
    return { kind: 'TIMEOUT', message: err.message, status: null, errorType: null, retryable: false };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;

  // HTTP status from axios-style error
  const status: number | null =
    typeof e?.response?.status === 'number' ? e.response.status :
    typeof e?.status === 'number' ? e.status :
    null;

  // Kite's own taxonomy
  const errorType: string | null =
    typeof e?.error_type === 'string' ? e.error_type :
    typeof e?.response?.data?.error_type === 'string' ? e.response.data.error_type :
    null;

  // Underlying Node code (ECONNRESET, ENOTFOUND, etc.)
  const code: string | null =
    typeof e?.code === 'string' ? e.code :
    typeof e?.cause?.code === 'string' ? e.cause.code :
    null;

  const message: string =
    typeof e?.message === 'string' ? e.message :
    typeof e?.response?.data?.message === 'string' ? e.response.data.message :
    typeof e === 'string' ? e :
    JSON.stringify(e);

  // Kite typed errors (preferred discriminator)
  if (errorType === 'TokenException') return mk('TOKEN', message, status, errorType, true);
  if (errorType === 'OrderException') return mk('REJECTED', message, status, errorType, false);
  if (errorType === 'InputException') return mk('INPUT', message, status, errorType, false);
  if (errorType === 'PermissionException') return mk('PERMISSION', message, status, errorType, false);
  if (errorType === 'NetworkException') return mk('MIDFLIGHT_RESET', message, status, errorType, false);
  if (errorType === 'GeneralException') return mk('GENERAL', message, status, errorType, false);

  // HTTP-status-only fallbacks (when SDK didn't classify)
  if (status === 401 || status === 403) return mk('TOKEN', message, status, errorType, true);
  if (status !== null && status >= 500 && status <= 599) return mk('GATEWAY_5XX', message, status, errorType, true);
  if (status !== null && status >= 400 && status <= 499) return mk('REJECTED', message, status, errorType, false);

  // Node-level connection errors
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH') {
    return mk('CONNECT_FAILED', message, status, errorType, true);
  }
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') {
    return mk('MIDFLIGHT_RESET', message, status, errorType, false);
  }

  // Anything else — assume mid-flight, do not retry
  return mk('MIDFLIGHT_RESET', message, status, errorType, false);
}

function mk(kind: KiteErrorKind, message: string, status: number | null, errorType: string | null, retryable: boolean): ClassifiedError {
  return { kind, message, status, errorType, retryable };
}
