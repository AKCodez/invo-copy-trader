// Replicate a trader's take-profit / stop-loss on our copy: the logic behind
// commands/tpsl.ts, and the TP/SL step of trade.ts after an open fills.
//
// Our TP/SL are Hyperliquid position TP/SL orders (see hl-client
// placePositionTpsl), which act on the whole coin position. So they are only
// placed when the copy IS the whole position: no other copy, manual trade or
// outside position in the coin. Otherwise the change is refused — a TP/SL that
// would also close someone else's copy isn't a replica of this trader's.

import { assertExactPerpPrice, assertTriggerSide } from './sizing.js';
import {
  addSourceUpdate,
  findCopiedUpdate,
  findCopyToClose,
  qtyEpsilon,
  reconcileWithPosition,
  setTpsl,
  type CopyEntry,
  type LedgerStore,
  type TpslState,
} from './copy-ledger.js';
import { orderRejection } from './hl-response.js';
import { settlePendingOrders, type OrderLookup } from './pending-orders.js';
import { isSignalArg, parseTradeSignal, type TpslKind } from './trade-signal.js';
import type { HlMeta, HlPosition } from './trade-exec.js';

/** An open order, as frontendOpenOrders reports it (fields we use). */
export interface OpenOrder {
  coin: string;
  cloid?: string | null;
  isTrigger?: boolean;
  isPositionTpsl?: boolean;
  reduceOnly?: boolean;
  orderType?: string;
  triggerPx?: string;
}

export interface TpslHl {
  getOpenOrders(): Promise<OpenOrder[]>;
  placePositionTpsl(coin: string, isLong: boolean, which: TpslKind, triggerPx: number, szDecimals: number, cloid: string): Promise<any>;
  cancelByCloid(coin: string, cloid: string): Promise<any>;
}

export interface TpslCommandHl extends TpslHl, OrderLookup {
  connect(): Promise<unknown>;
  getMeta(): Promise<HlMeta>;
  getAllMids(): Promise<Record<string, string>>;
  getPositions(): Promise<HlPosition[]>;
}

export interface TpslDeps {
  hl: TpslCommandHl;
  ledger: LedgerStore;
  newCloid: () => string;
  now?: () => Date;
}

/** Which TP/SL kind an open trigger order is, from its orderType; null if it isn't one. */
export function tpslKindOf(o: Pick<OpenOrder, 'isTrigger' | 'orderType'>): TpslKind | null {
  if (!o.isTrigger) return null;
  const t = (o.orderType ?? '').toLowerCase();
  if (t.startsWith('take profit')) return 'tp';
  if (t.startsWith('stop')) return 'sl';
  return null;
}

/**
 * Could this order close (part of) a position when a price is reached? Fails closed:
 * any trigger, any position TP/SL, or an order type naming a take-profit / stop —
 * whatever its exact wording — counts, so an unexpected label can't hide one.
 */
export function isTriggerLike(o: Pick<OpenOrder, 'isTrigger' | 'isPositionTpsl' | 'orderType'>): boolean {
  if (o.isTrigger === true || o.isPositionTpsl === true) return true;
  const t = (o.orderType ?? '').toLowerCase();
  return /take ?profit|stop|trigger|tp\b|sl\b/.test(t);
}

/** Trigger-like orders open in `coin` (see isTriggerLike). */
export const coinTriggers = (orders: OpenOrder[], coin: string) => orders.filter(o => o.coin === coin && isTriggerLike(o));

export type TpslOutcome =
  | { which: TpslKind; status: 'active'; triggerPx: number; cloid: string; replacedCloid?: string }
  | { which: TpslKind; status: 'error'; triggerPx: number; error: string };

/**
 * Place `which` at `triggerPx` for the copy `entryId`, replacing the one we placed
 * before (cancelled first). Callers have checked the price and that the copy is
 * the whole coin position. The ledger is written before the order is sent.
 */
export async function replaceTpsl(
  hl: TpslHl,
  ledger: LedgerStore,
  entries: CopyEntry[],
  entry: CopyEntry,
  which: TpslKind,
  triggerPx: number,
  traderUpdatedAt: string,
  szDecimals: number,
  cloid: string,
  now: string,
  openOrders: OpenOrder[],
): Promise<{ entries: CopyEntry[]; outcome: TpslOutcome }> {
  const isLong = entry.side === 'long';
  const old = entry.tpsl?.[which];
  let replacedCloid: string | undefined;
  if (old && openOrders.some(o => o.cloid === old.cloid)) {
    const res = await hl.cancelByCloid(entry.coin, old.cloid);
    const err = orderRejection(res);
    if (err) return { entries, outcome: { which, status: 'error', triggerPx, error: `cancelling our previous ${which} ${old.cloid} failed: ${err}` } };
    replacedCloid = old.cloid;
  }

  const placing: TpslState = { triggerPx, cloid, status: 'placing', traderUpdatedAt };
  entries = setTpsl(entries, entry.id, which, placing, now);
  ledger.save(entries);

  let error: string | null;
  try {
    error = orderRejection(await hl.placePositionTpsl(entry.coin, isLong, which, triggerPx, szDecimals, cloid));
  } catch (e: any) {
    error = `request failed: ${e.message}`;
  }
  if (error) {
    // Keep the record only if HL may have it after all (request failed): the cloid identifies it as ours
    if (!error.startsWith('request failed')) {
      entries = setTpsl(entries, entry.id, which, null, now);
      ledger.save(entries);
    }
    return { entries, outcome: { which, status: 'error', triggerPx, error } };
  }
  entries = setTpsl(entries, entry.id, which, { ...placing, status: 'active' }, now);
  ledger.save(entries);
  return { entries, outcome: { which, status: 'active', triggerPx, cloid, ...(replacedCloid && { replacedCloid }) } };
}

export type TpslResult =
  | { status: 'refused'; coin: string | null; reason: string; entryId?: string }
  | { status: 'applied' | 'failed' | 'unchanged'; coin: string; entryId: string; outcomes: TpslOutcome[]; skipped: string[] };

const refuse = (coin: string | null, reason: string, entryId?: string): TpslResult =>
  ({ status: 'refused', coin, reason, ...(entryId && { entryId }) });

export const TPSL_USAGE = `Usage: tpsl '<tpsl signal JSON | open signal JSON>'`;

/**
 * Apply a trader's TP/SL change (a `tpsl` signal), or re-apply the TP/SL from the
 * open signal of a copy (e.g. after trade.ts couldn't place them).
 */
export async function runTpsl(args: string[], deps: TpslDeps): Promise<TpslResult> {
  const now = deps.now ?? (() => new Date());
  if (args.length !== 1 || !isSignalArg(args[0])) return refuse(null, TPSL_USAGE);

  let items: { which: TpslKind; triggerPx: number; traderUpdatedAt: string }[];
  let coin: string;
  let identity;
  let updateId: string | null = null;
  try {
    const sig = parseTradeSignal(args[0]);
    if (sig.kind === 'tpsl') {
      items = [{ which: sig.which, triggerPx: sig.triggerPx, traderUpdatedAt: sig.updatedAt }];
      coin = sig.coin;
      identity = sig.identity;
      updateId = sig.updateId;
    } else if (sig.kind === 'open') {
      const at = sig.traderOpenedAt ?? '';
      items = [
        ...(sig.tp !== null ? [{ which: 'tp' as const, triggerPx: sig.tp, traderUpdatedAt: at }] : []),
        ...(sig.sl !== null ? [{ which: 'sl' as const, triggerPx: sig.sl, traderUpdatedAt: at }] : []),
      ];
      coin = sig.coin;
      identity = {
        creatorInvoUserId: sig.mimicMeta.creatorInvoUserId,
        sourcePaperTradeBaseId: sig.mimicMeta.sourcePaperTradeBaseId,
        sourcePaperTradeBaseShortId: sig.mimicMeta.sourcePaperTradeBaseShortId,
      };
      if (!items.length) return refuse(coin, 'the open signal has no TP/SL');
    } else {
      return refuse(null, `tpsl.ts takes a tpsl or open signal, not ${sig.kind}`);
    }
  } catch (e: any) {
    return refuse(null, e.message);
  }

  let entries: CopyEntry[];
  try {
    entries = deps.ledger.load();
  } catch (e: any) {
    return refuse(coin, e.message);
  }
  if (updateId) {
    const done = findCopiedUpdate(entries, updateId);
    if (done && !done.pendingOrder) return refuse(coin, `trader change ${updateId} was already applied (ledger entry ${done.id})`, done.id);
  }

  const { hl } = deps;
  await hl.connect();
  const asset = (await hl.getMeta()).universe.find(a => a.name === coin);
  if (!asset) return refuse(coin, `Unknown coin: ${coin}`);
  const { szDecimals } = asset;
  try {
    entries = (await settlePendingOrders(hl, deps.ledger, entries, coin, szDecimals, now().toISOString())).entries;
  } catch (e: any) {
    return refuse(coin, e.message);
  }

  const match = findCopyToClose(entries, coin, identity);
  if (match.kind === 'refuse') return refuse(coin, match.reason);
  let entry = match.entry;

  const pos = (await hl.getPositions()).find(p => p.coin === coin);
  const szi = pos ? parseFloat(pos.szi) : 0;
  const rec = reconcileWithPosition(entries, coin, szi, szDecimals, now().toISOString());
  if (rec.reconciled.length) {
    deps.ledger.save(rec.entries);
    entries = rec.entries;
  }
  if (rec.reconciled.includes(entry.id)) return refuse(coin, `the copy is already closed on Hyperliquid (${entries.find(e => e.id === entry.id)!.closeReason})`, entry.id);

  // Position TP/SL act on the whole coin position: only when this copy is all of it
  const others = entries.filter(e => e.coin === coin && e.id !== entry.id && (e.status === 'open' || e.status === 'pending'));
  if (others.length) {
    return refuse(coin, `the ${coin} position also holds ${others.map(e => e.source ? `trader ${e.source.creatorInvoUserId}'s copy` : 'a manual trade').join(', ')} — ` +
      `a Hyperliquid TP/SL would close those too, so this trader's TP/SL can't be replicated on its own`, entry.id);
  }
  if (Math.abs(Math.abs(szi) - entry.qty) >= qtyEpsilon(szDecimals)) {
    return refuse(coin, `the ${coin} position (${szi}) isn't just this copy (${entry.qty}) — a TP/SL on it would act on more than the copy`, entry.id);
  }

  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) return refuse(coin, `No mid price for ${coin}`, entry.id);

  // Older than what we already copied → skipped. Everything else is checked before any order changes.
  const skipped: string[] = [];
  const todo = items.filter(it => {
    const cur = entry.tpsl?.[it.which];
    if (cur && cur.traderUpdatedAt > it.traderUpdatedAt) {
      skipped.push(`${it.which}: a newer trader ${it.which} (${cur.traderUpdatedAt}) is already applied`);
      return false;
    }
    if (cur && cur.status === 'active' && cur.triggerPx === it.triggerPx) {
      skipped.push(`${it.which}: already at ${it.triggerPx}`);
      return false;
    }
    return true;
  });
  try {
    for (const it of todo) {
      assertExactPerpPrice(it.triggerPx, szDecimals, `The trader's ${it.which}`);
      assertTriggerSide(it.which, it.triggerPx, mid, entry.side === 'long');
    }
  } catch (e: any) {
    return refuse(coin, e.message, entry.id);
  }

  let openOrders: OpenOrder[];
  try {
    openOrders = await hl.getOpenOrders();
  } catch (e: any) {
    return refuse(coin, `can't read open orders: ${e.message}`, entry.id);
  }
  // Every trigger-like order in the coin must be one this copy placed. One whose kind
  // can't be read, or that we didn't place, would act on the copy too: refuse.
  const ourCloids = new Set(Object.values(entry.tpsl ?? {}).map(t => t!.cloid));
  const foreign = coinTriggers(openOrders, coin).filter(o => !o.cloid || !ourCloids.has(o.cloid));
  if (foreign.length) {
    const f = foreign[0];
    return refuse(coin, `${coin} has a trigger/TP/SL order this copy didn't place (${f.orderType ?? 'unknown type'}, cloid ${f.cloid ?? 'none'}) — ` +
      `it would act on the copy too, so the trader's TP/SL can't be replicated on its own`, entry.id);
  }

  const outcomes: TpslOutcome[] = [];
  for (const it of todo) {
    const r = await replaceTpsl(hl, deps.ledger, entries, entry, it.which, it.triggerPx, it.traderUpdatedAt, szDecimals, deps.newCloid(),
      now().toISOString(), openOrders);
    entries = r.entries;
    entry = entries.find(e => e.id === entry.id)!;
    outcomes.push(r.outcome);
  }
  const failed = outcomes.some(o => o.status === 'error');
  if (updateId && !failed) {
    entries = addSourceUpdate(entries, entry.id, updateId, now().toISOString());
    deps.ledger.save(entries);
  }
  return {
    status: failed ? 'failed' : outcomes.length ? 'applied' : 'unchanged',
    coin,
    entryId: entry.id,
    outcomes,
    skipped,
  };
}
