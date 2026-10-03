// Network calls must not hang: a hung monitor stops seeing closes, and a hung
// trade/close holds the ledger lock.

export const HTTP_TIMEOUT_MS = 20_000;

/** fetch() options that abort the request after `ms`. */
export const timeoutSignal = (ms = HTTP_TIMEOUT_MS) => ({ signal: AbortSignal.timeout(ms) });

/**
 * Reject if `p` hasn't settled within `ms`. The underlying call is not cancelled
 * (the HL SDK offers no way to), so callers treat a timeout like any failed
 * request — for an order, one that may still have reached the exchange.
 */
export function withTimeout<T>(p: Promise<T>, what: string, ms = HTTP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
