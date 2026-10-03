// Hyperliquid's /exchange endpoint rejects requests with HTTP 200 and
// { status: 'err', response: '<reason>' }, and the SDK returns that body rather
// than throwing — so every exchange response must be checked here.

const describe = (resp: any) => (JSON.stringify(resp?.response ?? resp) ?? String(resp)).slice(0, 300);

/** Throws unless an exchange action (e.g. updateLeverage) succeeded. */
export function assertHlOk(resp: any, what: string): void {
  if (resp?.status !== 'ok') throw new Error(`${what} rejected by Hyperliquid: ${describe(resp)}`);
}

/** Why an order was rejected, or null when HL accepted it (filled or resting). */
export function orderRejection(resp: any): string | null {
  if (resp?.status !== 'ok') return describe(resp);
  const statuses = resp?.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return `no order status in response: ${describe(resp)}`;
  const errors = statuses.map((s: any) => s?.error).filter((e: unknown) => e != null);
  return errors.length ? errors.map(String).join('; ') : null;
}

/**
 * Coin units an order filled, from its own response: 0 when HL rejected it,
 * null when the response doesn't say (then look the order up by cloid).
 * Measured per order, so other activity in the coin can't be counted as ours.
 */
export function orderFilledQty(resp: any): number | null {
  if (resp?.status === 'err') return 0;
  if (resp?.status !== 'ok') return null;
  const statuses = resp?.response?.data?.statuses;
  if (!Array.isArray(statuses) || statuses.length !== 1) return null;
  if (statuses[0]?.error != null) return 0;
  const sz = parseFloat(statuses[0]?.filled?.totalSz);
  return Number.isFinite(sz) && sz >= 0 ? sz : null;
}
