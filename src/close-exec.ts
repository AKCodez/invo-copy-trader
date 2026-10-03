// Close a copied position: the logic behind commands/close.ts.
//
// A close signal closes only the copy it refers to — the ledger entry for the
// same trader's same trade in that coin — and only that copy's quantity, so
// other traders' copies and manual trades in the same coin are untouched.
// Anything that can't be matched is refused before any order is placed.
// `manual` (explicit user request only) closes the whole coin position.

import { SLIPPAGE_PCT, MIN_ORDER_NOTIONAL_USD, limitPrice } from './sizing.js';
import {
  parseCloseIdentity,
  findCopyToClose,
  isSameTrade,
  planCopyClose,
  beginClose,
  settleOrder,
  closeAllInCoin,
  reconcileWithPosition,
  unsettledInCoin,
  floorQty,
  qtyEpsilon,
  roundQty,
  type CloseIdentity,
  type CopyEntry,
  type LedgerStore,
} from './copy-ledger.js';
import { UsageError, randomCloid, resolveFill, type ExecHl } from './trade-exec.js';
import { orderRejection } from './hl-response.js';
import { settlePendingOrders, type SettledOrder } from './pending-orders.js';
import { isSignalArg, parseTradeSignal, type DecreaseSignal } from './trade-signal.js';

export const MANUAL_CLOSE_ARG = 'manual';
export const CLOSE_USAGE =
  `Usage: close '<close or decrease signal JSON>'  |  close <coin> <close signal mimicMeta JSON | ${MANUAL_CLOSE_ARG}>`;

export interface CloseDeps {
  hl: ExecHl;
  ledger: LedgerStore;
  newCloid?: () => string;
  now?: () => Date;
}

type Mode = 'signal' | 'decrease' | 'manual';

export type CloseResult =
  | { status: 'refused'; coin: string; reason: string; entryId?: string; settledPendingOrders?: SettledOrder[] }
  | {
      // The position this close refers to is already gone on HL (liquidation, TP/SL,
      // closed elsewhere): no order is placed; the stale ledger entries are closed
      status: 'already_closed';
      coin: string;
      mode: Mode;
      entryId: string | null;
      reason: string;
      reconciledEntryIds: string[];
      settledPendingOrders?: SettledOrder[];
    }
  | {
      // The order was sent but neither its response nor HL says what filled. The
      // ledger keeps it pending; the next trade/close in this coin settles it.
      status: 'unknown';
      coin: string;
      mode: Mode;
      entryId: string | null;
      cloid: string;
      reason: string;
      hlResult: any;
    }
  | {
      // decreased: a trader's partial close was copied in full (the copy stays open, smaller)
      status: 'closed' | 'decreased' | 'partial' | 'not_filled';
      coin: string;
      mode: Mode;
      /** decrease: the fraction of the copy the trader's decrease asks for (from their $ figures). */
      fraction?: number;
      /** decrease: /dex/trade's positionSize ratio — reference only, not used for sizing. */
      positionSizeRatio?: number;
      /** close signals: why the trader's trade closed (user_closed, take_profit_hit, stop_loss_hit, liquidated). */
      traderReason?: string | null;
      entryId: string | null;
      trader: string | null;
      requestedQty: number;
      closedQty: number;
      copyQtyLeft: number | null;
      qtyBefore: string;
      qtyAfter: string | null;
      cloid: string;
      hlResult: any;
      orderError?: string;
      settledPendingOrders?: SettledOrder[];
      reconciledEntryIds?: string[];
      ledgerError?: string;
    };

const refuse = (coin: string, reason: string, entryId?: string, settled: SettledOrder[] = []): CloseResult =>
  ({ status: 'refused', coin, reason, ...(entryId && { entryId }), ...(settled.length && { settledPendingOrders: settled }) });

/** Coin's signed position size (0 when flat). */
async function positionSzi(hl: ExecHl, coin: string): Promise<{ szi: number; raw: string }> {
  const pos = (await hl.getPositions()).find(p => p.coin === coin);
  return { szi: pos ? parseFloat(pos.szi) : 0, raw: pos ? pos.szi : '0' };
}

/** Position after an order; null if it can't be read (the fill is known from the order itself). */
async function positionAfter(hl: ExecHl, coin: string) {
  try {
    return await positionSzi(hl, coin);
  } catch {
    return null;
  }
}

async function szDecimalsFor(hl: ExecHl, coin: string): Promise<number> {
  const asset = (await hl.getMeta()).universe.find(a => a.name === coin);
  if (!asset) throw new Error(`Unknown coin: ${coin}`);
  return asset.szDecimals;
}

async function midFor(hl: ExecHl, coin: string): Promise<number> {
  const mid = parseFloat((await hl.getAllMids())[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);
  return mid;
}

/**
 * Close ledger entries the live position shows are gone (see reconcileWithPosition),
 * saving before any order. Returns { error } if that save fails — callers refuse.
 */
function reconcile(entries: CopyEntry[], coin: string, szi: number, szDecimals: number, deps: CloseDeps, now: () => Date) {
  const r = reconcileWithPosition(entries, coin, szi, szDecimals, now().toISOString());
  if (r.reconciled.length) {
    try {
      deps.ledger.save(r.entries);
    } catch (e: any) {
      return { error: `ledger write failed: ${e.message}` };
    }
  }
  return r;
}

/** Connects once and settles any order an earlier run left unrecorded in `coin`. */
class HlSession {
  private connected = false;
  private szDecimals: number | null = null;
  settled: SettledOrder[] = [];

  constructor(private deps: CloseDeps, private coin: string, private now: () => Date) {}

  async decimals(): Promise<number> {
    if (!this.connected) {
      await this.deps.hl.connect();
      this.connected = true;
    }
    return (this.szDecimals ??= await szDecimalsFor(this.deps.hl, this.coin));
  }

  /** Throws if an unsettled order can't be looked up. */
  async settle(entries: CopyEntry[]): Promise<CopyEntry[]> {
    if (!unsettledInCoin(entries, this.coin).length) return entries;
    const r = await settlePendingOrders(this.deps.hl, this.deps.ledger, entries, this.coin, await this.decimals(), this.now().toISOString());
    this.settled.push(...r.settled);
    return r.entries;
  }
}

export async function runClose(args: string[], deps: CloseDeps): Promise<CloseResult> {
  const now = deps.now ?? (() => new Date());

  // The whole signal: a trader's close, or their partial close (decrease)
  if (args.length === 1 && isSignalArg(args[0])) {
    let sig;
    try {
      sig = parseTradeSignal(args[0]);
    } catch (e: any) {
      return refuse('?', e.message);
    }
    if (sig.kind === 'close') return signalClose(sig.coin, sig.identity, deps, now, null, sig.reason);
    if (sig.kind === 'decrease') return signalClose(sig.coin, sig.identity, deps, now, sig, null);
    return refuse(sig.coin, `close.ts runs close and decrease signals; a ${sig.kind} signal goes to ${sig.kind === 'tpsl' ? 'tpsl.ts' : 'trade.ts'}`);
  }

  const [coin, identityArg] = args;
  if (!coin) throw new UsageError(CLOSE_USAGE);

  if (identityArg === MANUAL_CLOSE_ARG) return manualClose(coin, deps, now);

  // --- Checked before Hyperliquid is touched ---
  if (!identityArg?.trim()) {
    return refuse(coin, `no close identity: pass the close signal's mimicMeta (or '${MANUAL_CLOSE_ARG}' on explicit user request)`);
  }
  let identity: CloseIdentity;
  try {
    identity = parseCloseIdentity(JSON.parse(identityArg));
  } catch (e: any) {
    return refuse(coin, e instanceof SyntaxError ? 'close identity is not valid JSON' : e.message);
  }
  return signalClose(coin, identity, deps, now, null, null);
}

/**
 * Close the copy of the trader's trade `identity` in `coin` — all of it, or for a
 * decrease the same fraction of it the trader closed.
 */
async function signalClose(
  coin: string,
  identity: CloseIdentity,
  deps: CloseDeps,
  now: () => Date,
  decrease: DecreaseSignal | null,
  traderReason: string | null,
): Promise<CloseResult> {
  const mode: Mode = decrease ? 'decrease' : 'signal';

  let entries: CopyEntry[];
  try {
    entries = deps.ledger.load();
  } catch (e: any) {
    return refuse(coin, e.message);
  }
  // Each trader decrease is copied once
  const applied = (es: CopyEntry[]) => decrease && es.find(e => e.sourceUpdateIds?.includes(decrease.updateId) && !e.pendingOrder);
  const done = applied(entries);
  if (done) return refuse(coin, `trader decrease ${decrease!.updateId} was already copied (ledger entry ${done.id})`, done.id);

  // An order an earlier run left unrecorded may be this very copy's: settle it first
  const session = new HlSession(deps, coin, now);
  try {
    entries = await session.settle(entries);
  } catch (e: any) {
    return refuse(coin, e.message);
  }
  const doneAfterSettle = applied(entries);
  if (doneAfterSettle) return refuse(coin, `trader decrease ${decrease!.updateId} was already copied (ledger entry ${doneAfterSettle.id})`, doneAfterSettle.id, session.settled);

  const match = findCopyToClose(entries, coin, identity);
  if (match.kind === 'refuse') {
    // A retry after an earlier run lost its close order's response: settling showed it closed this copy
    const closedBySettle = session.settled.find(o =>
      o.kind === 'close' && entries.some(e => e.id === o.entryId && e.status === 'closed' && isSameTrade(e.source, identity)));
    if (closedBySettle) {
      return {
        status: 'already_closed',
        coin,
        mode,
        entryId: closedBySettle.entryId,
        reason: `closed by an earlier run's order ${closedBySettle.cloid} (settled now)`,
        reconciledEntryIds: [],
        settledPendingOrders: session.settled,
      };
    }
    return refuse(coin, match.reason, undefined, session.settled);
  }
  const entry = match.entry;

  // --- Matched: check the live position agrees with the ledger, then close only this copy ---
  const szDecimals = await session.decimals();
  const before = await positionSzi(deps.hl, coin);

  const rec = reconcile(entries, coin, before.szi, szDecimals, deps, now);
  if ('error' in rec) return refuse(coin, rec.error, entry.id, session.settled);
  entries = rec.entries;
  if (rec.reconciled.includes(entry.id)) {
    return {
      status: 'already_closed',
      coin,
      mode,
      entryId: entry.id,
      reason: entries.find(e => e.id === entry.id)!.closeReason!,
      reconciledEntryIds: rec.reconciled,
      ...(session.settled.length && { settledPendingOrders: session.settled }),
    };
  }

  const full = planCopyClose(entry, entries, before.szi, szDecimals);
  if (full.kind === 'refuse') return refuse(coin, full.reason, entry.id, session.settled);

  const mid = await midFor(deps.hl, coin);
  // A decrease closes the trader's fraction of our copy (rounded down to the lot size);
  // all of it when they closed all (or the remainder rounds to nothing)
  let plan = full;
  if (decrease && decrease.fraction < 1) {
    // The fraction is of our tracked copy, so the live position must still hold it in full
    // (plus every other copy in the coin). Smaller means something reduced it outside the
    // ledger: the copy's real size is unknown, and closing a fraction of the ledger figure
    // could take more than the trader's share of what is actually ours.
    const eps = qtyEpsilon(szDecimals);
    const tracked = entries
      .filter(e => e.status === 'open' && e.coin === coin)
      .reduce((sum, e) => sum + e.qty, 0);
    if (Math.abs(before.szi) < tracked - eps) {
      return refuse(coin, `the ${coin} position (${Math.abs(before.szi)}) is smaller than the copies tracked in it ` +
        `(${roundQty(tracked, szDecimals)}) — our copy's real size is unknown, so the trader's ` +
        `${(decrease.fraction * 100).toFixed(2)}% decrease can't be replicated exactly`, entry.id, session.settled);
    }
    const qty = floorQty(entry.qty * decrease.fraction, szDecimals);
    if (qty > entry.qty + eps) {
      return refuse(coin, `decrease of ${qty} ${coin} exceeds our ${entry.qty} copy`, entry.id, session.settled);
    }
    const left = roundQty(entry.qty - qty, szDecimals);
    if (qty < qtyEpsilon(szDecimals)) {
      return refuse(coin, `the trader's ${(decrease.fraction * 100).toFixed(2)}% decrease of our ${entry.qty} ${coin} copy rounds to zero at ${szDecimals} decimals`, entry.id, session.settled);
    }
    if (left >= qtyEpsilon(szDecimals)) {
      // Hyperliquid's $10 minimum applies to a partial close: too small can't be replicated
      if (qty * mid * (1 - SLIPPAGE_PCT) < MIN_ORDER_NOTIONAL_USD) {
        return refuse(coin, `the trader's ${(decrease.fraction * 100).toFixed(2)}% decrease is ${qty} ${coin} (~$${(qty * mid).toFixed(2)}) of our copy — ` +
          `below Hyperliquid's $${MIN_ORDER_NOTIONAL_USD} minimum order, so it can't be replicated`, entry.id, session.settled);
      }
      plan = { ...full, qty, full: false };
    }
  }
  // The price the order will carry must be valid before anything is written or sent
  try {
    limitPrice(mid, !plan.isLong, szDecimals);
  } catch (e: any) {
    return refuse(coin, e.message, entry.id, session.settled);
  }
  const cloid = (deps.newCloid ?? randomCloid)();

  // Written before the order is sent, so a lost response is settled by cloid next run
  try {
    entries = beginClose(entries, entry.id, cloid, plan.qty, now().toISOString(), decrease?.updateId ?? null);
    deps.ledger.save(entries);
  } catch (e: any) {
    return refuse(coin, `ledger write failed: ${e.message}`, entry.id, session.settled);
  }

  // Reduce-only: if the position shrank since the snapshot, the order can't flip it
  let hlResult: any = null;
  let orderError: string | null = null;
  let requestFailed = false;
  try {
    hlResult = await deps.hl.placeMarketOrder(coin, !plan.isLong, plan.qty.toFixed(szDecimals), SLIPPAGE_PCT, mid, szDecimals, true, cloid);
    orderError = orderRejection(hlResult);
  } catch (e: any) {
    requestFailed = true;
    orderError = `order request failed: ${e.message}`;
  }
  const filled = await resolveFill(deps.hl, hlResult, cloid, requestFailed);
  if (filled === null) {
    return {
      status: 'unknown', coin, mode, entryId: entry.id, cloid, hlResult,
      reason: `${orderError ?? 'order response unreadable'}; fill unknown — the next ${coin} trade/close settles it`,
    };
  }

  const after = await positionAfter(deps.hl, coin);
  // From the order itself, and never more than was asked of this copy
  const closedQty = Math.min(plan.qty, roundQty(filled, szDecimals));
  // This copy was the whole position and it's now flat: nothing of it is left, even if the
  // position had shrunk below the ledger's qty beforehand
  const flat = after !== null && Math.abs(after.szi) < qtyEpsilon(szDecimals);
  const wholeCopy = plan.qty >= entry.qty - qtyEpsilon(szDecimals);
  const copyGone = plan.full && flat;
  const ledgerQty = copyGone ? entry.qty : closedQty;

  let ledgerError: string | undefined;
  let copyQtyLeft: number | null;
  try {
    const next = settleOrder(entries, entry.id, ledgerQty, szDecimals, now().toISOString());
    deps.ledger.save(next);
    copyQtyLeft = next.find(e => e.id === entry.id)!.qty;
  } catch (e: any) {
    ledgerError = `ledger write failed: ${e.message} — the order stays pending; the next ${coin} trade/close settles it`;
    copyQtyLeft = null;
  }

  return {
    status: copyGone ? 'closed'
      : closedQty <= 0 ? 'not_filled'
      : closedQty < plan.qty - qtyEpsilon(szDecimals) ? 'partial'
      : wholeCopy ? 'closed' : 'decreased',
    coin,
    mode,
    ...(decrease && { fraction: decrease.fraction, positionSizeRatio: decrease.positionSizeRatio }),
    ...(mode === 'signal' && { traderReason }),
    entryId: entry.id,
    trader: entry.source!.creatorInvoUserId,
    requestedQty: plan.qty,
    closedQty,
    copyQtyLeft,
    qtyBefore: before.raw,
    qtyAfter: after?.raw ?? null,
    cloid,
    hlResult,
    ...(orderError && { orderError }),
    ...(session.settled.length && { settledPendingOrders: session.settled }),
    ...(rec.reconciled.length && { reconciledEntryIds: rec.reconciled }),
    ...(ledgerError && { ledgerError }),
  };
}

/** Explicit user request: flatten the whole coin position, whoever it belongs to. */
async function manualClose(coin: string, deps: CloseDeps, now: () => Date): Promise<CloseResult> {
  let entries: CopyEntry[];
  try {
    entries = deps.ledger.load();
  } catch (e: any) {
    return refuse(coin, e.message);
  }

  const session = new HlSession(deps, coin, now);
  try {
    entries = await session.settle(entries);
  } catch (e: any) {
    return refuse(coin, e.message);
  }
  const szDecimals = await session.decimals();
  const before = await positionSzi(deps.hl, coin);

  const rec = reconcile(entries, coin, before.szi, szDecimals, deps, now);
  if ('error' in rec) return refuse(coin, rec.error, undefined, session.settled);
  entries = rec.entries;

  const qty = floorQty(Math.abs(before.szi), szDecimals);
  if (qty < qtyEpsilon(szDecimals)) {
    if (!rec.reconciled.length) return refuse(coin, `no open ${coin} position on Hyperliquid`, undefined, session.settled);
    return {
      status: 'already_closed',
      coin,
      mode: 'manual',
      entryId: null,
      reason: `no open ${coin} position on Hyperliquid`,
      reconciledEntryIds: rec.reconciled,
      ...(session.settled.length && { settledPendingOrders: session.settled }),
    };
  }

  const mid = await midFor(deps.hl, coin);
  try {
    limitPrice(mid, !(before.szi > 0), szDecimals);
  } catch (e: any) {
    return refuse(coin, e.message, undefined, session.settled);
  }
  const cloid = (deps.newCloid ?? randomCloid)();
  let hlResult: any = null;
  let orderError: string | null = null;
  let requestFailed = false;
  try {
    hlResult = await deps.hl.placeMarketOrder(coin, !(before.szi > 0), qty.toFixed(szDecimals), SLIPPAGE_PCT, mid, szDecimals, true, cloid);
    orderError = orderRejection(hlResult);
  } catch (e: any) {
    requestFailed = true;
    orderError = `order request failed: ${e.message}`;
  }
  const filled = await resolveFill(deps.hl, hlResult, cloid, requestFailed);
  if (filled === null) {
    // Ledger untouched: the next close/trade in the coin reconciles it against the position
    return {
      status: 'unknown', coin, mode: 'manual', entryId: null, cloid, hlResult,
      reason: `${orderError ?? 'order response unreadable'}; fill unknown — check the ${coin} position`,
    };
  }

  const after = await positionAfter(deps.hl, coin);
  const closedQty = Math.min(qty, roundQty(filled, szDecimals));
  const flat = after !== null
    ? Math.abs(after.szi) < qtyEpsilon(szDecimals)
    : closedQty >= qty - qtyEpsilon(szDecimals);

  let ledgerError: string | undefined;
  if (flat) {
    try {
      deps.ledger.save(closeAllInCoin(entries, coin, now().toISOString()));
    } catch (e: any) {
      ledgerError = `ledger write failed: ${e.message}`;
    }
  }

  return {
    status: closedQty <= 0 ? 'not_filled' : flat ? 'closed' : 'partial',
    coin,
    mode: 'manual',
    entryId: null,
    trader: null,
    requestedQty: qty,
    closedQty,
    copyQtyLeft: null,
    qtyBefore: before.raw,
    qtyAfter: after?.raw ?? null,
    cloid,
    hlResult,
    ...(orderError && { orderError }),
    ...(session.settled.length && { settledPendingOrders: session.settled }),
    ...(rec.reconciled.length && { reconciledEntryIds: rec.reconciled }),
    ...(ledgerError && { ledgerError }),
  };
}
