// Settle orders an earlier trade/close run placed but never recorded (it died or
// lost the response after sending). Each is looked up on HL by its client order
// id, so the ledger gets the exact fill. Runs before anything else in that coin;
// if an order can't be looked up, nothing in the coin is touched.

import { settleOrder, unsettledInCoin, type CopyEntry, type LedgerStore } from './copy-ledger.js';

export interface OrderLookup {
  getOrderFill(cloid: string): Promise<{ known: boolean; filledQty: number }>;
}

/**
 * HL saying it has no such order only proves the order never reached it once the
 * order is this old — a request that failed on our side could still arrive late.
 */
export const MIN_SETTLE_AGE_MS = 60_000;

export interface SettledOrder {
  entryId: string;
  kind: 'open' | 'close';
  cloid: string;
  filledQty: number;
}

export async function settlePendingOrders(
  hl: OrderLookup,
  ledger: LedgerStore,
  entries: CopyEntry[],
  coin: string,
  szDecimals: number,
  now: string,
  minAgeMs = MIN_SETTLE_AGE_MS,
): Promise<{ entries: CopyEntry[]; settled: SettledOrder[] }> {
  const settled: SettledOrder[] = [];
  for (const e of unsettledInCoin(entries, coin)) {
    const p = e.pendingOrder!;
    let fill: { known: boolean; filledQty: number };
    try {
      fill = await hl.getOrderFill(p.cloid);
    } catch (err: any) {
      throw new Error(
        `can't settle the ${p.kind} order an earlier run placed for ledger entry ${e.id} (cloid ${p.cloid}): ` +
        `${err.message} — nothing in ${coin} is traded until it is settled`,
      );
    }
    if (!fill.known) {
      const ageMs = Date.parse(now) - Date.parse(p.placedAt);
      if (!(ageMs >= minAgeMs)) {
        throw new Error(
          `the ${p.kind} order an earlier run placed for ledger entry ${e.id} (cloid ${p.cloid}) isn't on HL ` +
          `${Math.round(ageMs / 1000)}s after it was sent — it may still arrive; nothing in ${coin} is traded ` +
          `until it can be settled (try again in ${Math.ceil((minAgeMs - ageMs) / 1000)}s)`,
        );
      }
    }
    // Unknown to HL this long after it was sent = it never reached the exchange: nothing filled
    const filledQty = fill.known ? fill.filledQty : 0;
    entries = settleOrder(entries, e.id, filledQty, szDecimals, now);
    settled.push({ entryId: e.id, kind: p.kind, cloid: p.cloid, filledQty });
  }
  if (settled.length) ledger.save(entries);
  return { entries, settled };
}
