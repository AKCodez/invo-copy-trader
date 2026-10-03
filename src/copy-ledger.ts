// Ledger of positions we opened by copying a trader. Hyperliquid nets every
// fill in a coin into one position, so this is the only record of which trader
// (and which of their trades) each part of that position belongs to. close.ts
// uses it to close exactly the copy a close signal refers to — never another
// trader's copy, a manual trade, or anything it didn't open.
//
// Pure functions + a small store interface, so the logic is testable without
// touching disk, Invo or Hyperliquid.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type Side = 'long' | 'short';

/** The copied trader's trade (from the signal's mimicMeta). null = manual trade. */
export interface CopySource {
  creatorInvoUserId: string;
  portfolioId: string;
  sourcePaperTradeBaseId: string;
  sourcePaperTradeBaseShortId: string;
}

export interface CopyEntry {
  id: string; // clientTxId of the opening trade
  coin: string;
  side: Side;
  /** Coin units of our HL position attributed to this copy. */
  qty: number;
  source: CopySource | null;
  positionRecordIds: string[];
  /** The trader's updates (mimicMeta.initialSourcePaperUpdateId) copied into this entry. Absent on older entries. */
  sourceUpdateIds?: string[];
  /** 'pending' = a new copy whose opening order hasn't been settled yet (qty 0 until it is). */
  status: 'pending' | 'open' | 'closed';
  /** An order placed for this entry whose fill isn't recorded yet (see settleOrder). */
  pendingOrder?: PendingOrder;
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
  /** Set when the entry was closed by reconciliation rather than by an order. */
  closeReason?: string;
  /** The leverage copied from the trader (isolated). Absent on older entries. */
  leverage?: number;
  /** When the trader opened the trade; the monitor watches its changes from then. Absent on older entries. */
  traderOpenedAt?: string;
  /** The trader's TP/SL as replicated on Hyperliquid (position TP/SL orders). */
  tpsl?: Partial<Record<'tp' | 'sl', TpslState>>;
}

/** A take-profit or stop-loss copied from the trader. */
export interface TpslState {
  triggerPx: number;
  /** Client order id of our trigger order on Hyperliquid. */
  cloid: string;
  /** 'placing' is written before the order is sent; 'active' once HL accepted it. */
  status: 'placing' | 'active';
  /** The trader's change it copies (their updatedAt, or the open), so an older change never overrides a newer one. */
  traderUpdatedAt: string;
}

/**
 * Written to the ledger before an order is sent, and cleared once its fill is
 * recorded. If the process dies in between, the next run in that coin looks the
 * order up on HL by `cloid` and settles it, so a fill is never left untracked.
 */
export interface PendingOrder {
  kind: 'open' | 'close';
  /** Hyperliquid client order id sent with the order. */
  cloid: string;
  requestedQty: number;
  /** The trader update being copied (an open, an increase or a decrease) — released again if nothing fills. */
  sourceUpdateId?: string | null;
  placedAt: string;
}

export interface LedgerStore {
  /** Throws if the ledger exists but can't be read — callers fail closed. */
  load(): CopyEntry[];
  save(entries: CopyEntry[]): void;
}

export function defaultLedgerPath(): string {
  return process.env.COPY_LEDGER_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'copy-ledger.json');
}

export class FileLedgerStore implements LedgerStore {
  constructor(readonly path: string) {}

  load(): CopyEntry[] {
    if (!existsSync(this.path)) return [];
    let data: any;
    try {
      data = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e: any) {
      throw new Error(`Copy ledger ${this.path} is unreadable: ${e.message}`);
    }
    if (!Array.isArray(data?.entries)) throw new Error(`Copy ledger ${this.path} is malformed (no entries array)`);
    return data.entries;
  }

  save(entries: CopyEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written ledger
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
    renameSync(tmp, this.path);
  }
}

// --- Quantities ---

/** Half a lot: anything smaller is zero at this asset's precision. */
export const qtyEpsilon = (szDecimals: number) => 0.5 * 10 ** -szDecimals;
export const roundQty = (x: number, szDecimals: number) => Number(x.toFixed(szDecimals));
/** Round down to the lot size, so a close never exceeds what we hold. */
export const floorQty = (x: number, szDecimals: number) =>
  Math.floor(x * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;

// --- Opening ---

export interface OpenIntent {
  id: string; // clientTxId: the new entry's id if this starts a new copy
  coin: string;
  side: Side;
  source: CopySource | null;
  /** The trader update being copied; null for a manual trade. */
  sourceUpdateId: string | null;
  cloid: string;
  requestedQty: number;
  now: string;
  /** New copies only: the trader's leverage and when they opened. */
  leverage?: number;
  traderOpenedAt?: string | null;
}

/**
 * The entry (pending, open or closed) that already copied this trader update,
 * if any. Each update is copied at most once, so a repeated signal can't add again.
 */
export function findCopiedUpdate(entries: CopyEntry[], updateId: string): CopyEntry | undefined {
  return entries.find(e => e.sourceUpdateIds?.includes(updateId));
}

/**
 * Record an opening order before it is sent. A further order on the same
 * trader's same trade (an increase) goes on that copy; anything else — another
 * trader, another trade of theirs, a manual trade — starts a pending entry.
 * The update id is claimed now, so a concurrent or repeated signal is refused.
 */
export function beginOpen(entries: CopyEntry[], open: OpenIntent): { entries: CopyEntry[]; entryId: string } {
  const pendingOrder: PendingOrder = {
    kind: 'open', cloid: open.cloid, requestedQty: open.requestedQty, sourceUpdateId: open.sourceUpdateId, placedAt: open.now,
  };
  const withUpdate = (ids: string[] | undefined) => (open.sourceUpdateId ? [...(ids ?? []), open.sourceUpdateId] : ids);

  const existing = open.source
    ? entries.find(e =>
        e.status === 'open' &&
        e.coin === open.coin &&
        e.side === open.side &&
        e.source?.creatorInvoUserId === open.source!.creatorInvoUserId &&
        e.source?.sourcePaperTradeBaseId === open.source!.sourcePaperTradeBaseId)
    : undefined;

  if (existing) {
    if (existing.pendingOrder) throw new Error(`ledger entry ${existing.id} already has an unsettled order`);
    const entry: CopyEntry = { ...existing, sourceUpdateIds: withUpdate(existing.sourceUpdateIds), pendingOrder, updatedAt: open.now };
    return { entries: entries.map(e => (e.id === existing.id ? entry : e)), entryId: existing.id };
  }

  const ids = withUpdate(undefined);
  const entry: CopyEntry = {
    id: open.id,
    coin: open.coin,
    side: open.side,
    qty: 0,
    source: open.source,
    positionRecordIds: [],
    ...(ids && { sourceUpdateIds: ids }),
    status: 'pending',
    pendingOrder,
    openedAt: open.now,
    updatedAt: open.now,
    ...(open.leverage !== undefined && { leverage: open.leverage }),
    ...(open.traderOpenedAt && { traderOpenedAt: open.traderOpenedAt }),
  };
  return { entries: [...entries, entry], entryId: entry.id };
}

/**
 * Record a closing order for `entryId` before it is sent. A partial close copying
 * a trader's decrease claims that update's id now (released if nothing fills).
 */
export function beginClose(
  entries: CopyEntry[], entryId: string, cloid: string, requestedQty: number, now: string, sourceUpdateId: string | null = null,
): CopyEntry[] {
  return entries.map(e => {
    if (e.id !== entryId) return e;
    if (e.pendingOrder) throw new Error(`ledger entry ${e.id} already has an unsettled order`);
    return {
      ...e,
      ...(sourceUpdateId && { sourceUpdateIds: [...(e.sourceUpdateIds ?? []), sourceUpdateId] }),
      pendingOrder: { kind: 'close' as const, cloid, requestedQty, ...(sourceUpdateId && { sourceUpdateId }), placedAt: now },
      updatedAt: now,
    };
  });
}

/**
 * Record what an entry's pending order filled and clear it.
 *   open:  qty grows by the fill. A new copy with no fill is removed; an increase
 *          with no fill releases its update id, so the update can be retried.
 *   close: qty shrinks by the fill; the entry is closed once nothing is left.
 */
export function settleOrder(
  entries: CopyEntry[],
  entryId: string,
  filledQty: number,
  szDecimals: number,
  now: string,
  positionRecordId: string | null = null,
): CopyEntry[] {
  const eps = qtyEpsilon(szDecimals);
  const filled = roundQty(Math.max(0, filledQty), szDecimals);
  const out: CopyEntry[] = [];
  for (const e of entries) {
    if (e.id !== entryId) {
      out.push(e);
      continue;
    }
    const { pendingOrder: p, ...rest } = e;
    if (!p) throw new Error(`ledger entry ${entryId} has no pending order`);

    if (p.kind === 'close') {
      const left = roundQty(e.qty - filled, szDecimals);
      // A decrease that filled nothing can be retried: release its update id
      const ids = filled < eps && p.sourceUpdateId ? e.sourceUpdateIds?.filter(id => id !== p.sourceUpdateId) : e.sourceUpdateIds;
      out.push(left < eps
        ? { ...rest, sourceUpdateIds: ids, qty: 0, status: 'closed', updatedAt: now, closedAt: now }
        : { ...rest, sourceUpdateIds: ids, qty: left, updatedAt: now });
    } else if (filled < eps) {
      if (e.status === 'pending') continue; // nothing filled: the copy never existed
      out.push({ ...rest, sourceUpdateIds: e.sourceUpdateIds?.filter(id => id !== p.sourceUpdateId), updatedAt: now });
    } else {
      out.push({
        ...rest,
        qty: roundQty(e.qty + filled, szDecimals),
        status: 'open',
        positionRecordIds: positionRecordId ? [...e.positionRecordIds, positionRecordId] : e.positionRecordIds,
        updatedAt: now,
      });
    }
  }
  return out;
}

/** Entries in `coin` with an order that was placed but never settled. */
export const unsettledInCoin = (entries: CopyEntry[], coin: string) =>
  entries.filter(e => e.coin === coin && e.pendingOrder);

// --- Reconciling with the live position ---

/**
 * Close open entries in `coin` that the live HL position shows can no longer
 * exist: the position is flat, or on the other side (it went through zero).
 * This happens after a liquidation, TP/SL, or a close made outside this tool;
 * left open, those entries would make every later close in the coin refuse.
 * A same-side position smaller than the entries is left alone — whose share
 * is gone can't be told, so planCopyClose still refuses that.
 */
export function reconcileWithPosition(
  entries: CopyEntry[],
  coin: string,
  positionSzi: number,
  szDecimals: number,
  now: string,
): { entries: CopyEntry[]; reconciled: string[] } {
  const flat = Math.abs(positionSzi) < qtyEpsilon(szDecimals);
  const side: Side = positionSzi > 0 ? 'long' : 'short';
  const reconciled: string[] = [];
  const next = entries.map(e => {
    if (e.status !== 'open' || e.coin !== coin || (!flat && e.side === side)) return e;
    reconciled.push(e.id);
    const closeReason = flat
      ? `reconciled: no ${coin} position on Hyperliquid`
      : `reconciled: ${coin} position is ${side}, entry was ${e.side}`;
    return { ...e, qty: 0, status: 'closed' as const, updatedAt: now, closedAt: now, closeReason };
  });
  return { entries: reconciled.length ? next : entries, reconciled };
}

// --- Closing ---

/** Who a close signal is from: the trader plus at least one ID of their trade. */
export interface CloseIdentity {
  creatorInvoUserId: string;
  sourcePaperTradeBaseId?: string;
  sourcePaperTradeBaseShortId?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** From a close signal's mimicMeta. Throws unless the trader and their trade are identified. */
export function parseCloseIdentity(raw: unknown): CloseIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('close identity must be the signal\'s mimicMeta object');
  const o = raw as Record<string, unknown>;
  if (!nonEmpty(o.creatorInvoUserId)) throw new Error('close signal has no trader id (creatorInvoUserId)');
  const baseId = nonEmpty(o.sourcePaperTradeBaseId) ? o.sourcePaperTradeBaseId.trim() : undefined;
  const baseShortId = nonEmpty(o.sourcePaperTradeBaseShortId) ? o.sourcePaperTradeBaseShortId.trim() : undefined;
  if (!baseId && !baseShortId) throw new Error('close signal has no trade id (sourcePaperTradeBaseId / sourcePaperTradeBaseShortId)');
  return { creatorInvoUserId: o.creatorInvoUserId.trim(), sourcePaperTradeBaseId: baseId, sourcePaperTradeBaseShortId: baseShortId };
}

export type CopyMatch = { kind: 'match'; entry: CopyEntry } | { kind: 'refuse'; reason: string };

/** Does this copy belong to the trader's trade? Manual entries never do. */
export function isSameTrade(source: CopySource | null, id: CloseIdentity): boolean {
  if (!source || source.creatorInvoUserId !== id.creatorInvoUserId) return false;
  // baseId is the trade's own id (a UUID) and identifies it on its own. Invo's
  // baseShortId isn't known to be the same on every post of a trade, so it is
  // only used when the signal has no baseId.
  return id.sourcePaperTradeBaseId !== undefined
    ? source.sourcePaperTradeBaseId === id.sourcePaperTradeBaseId
    : source.sourcePaperTradeBaseShortId === id.sourcePaperTradeBaseShortId;
}

/**
 * The open copy a close signal refers to: same coin, same trader, same trade
 * (see isSameTrade). Manual entries never match.
 */
export function findCopyToClose(entries: CopyEntry[], coin: string, id: CloseIdentity): CopyMatch {
  const matches = entries.filter(e => e.status === 'open' && e.coin === coin && isSameTrade(e.source, id));

  if (matches.length === 1) return { kind: 'match', entry: matches[0] };
  if (matches.length > 1) return { kind: 'refuse', reason: `${matches.length} open ${coin} copies match this signal — ledger is ambiguous, close manually` };
  return { kind: 'refuse', reason: `no open ${coin} copy of trader ${id.creatorInvoUserId}'s trade ${id.sourcePaperTradeBaseId ?? id.sourcePaperTradeBaseShortId} in the ledger` };
}

export type ClosePlan =
  | { kind: 'close'; qty: number; isLong: boolean; full: boolean }
  | { kind: 'refuse'; reason: string };

/**
 * How much of the HL position to close for `entry`: its own quantity, never
 * other copies'. Refuses when the position doesn't match what the ledger says.
 */
export function planCopyClose(entry: CopyEntry, entries: CopyEntry[], positionSzi: number, szDecimals: number): ClosePlan {
  const eps = qtyEpsilon(szDecimals);
  const posQty = Math.abs(positionSzi);
  if (!Number.isFinite(positionSzi) || posQty < eps) {
    return { kind: 'refuse', reason: `no open ${entry.coin} position on Hyperliquid (ledger expected ${entry.qty})` };
  }
  const isLong = positionSzi > 0;
  if ((entry.side === 'long') !== isLong) {
    return { kind: 'refuse', reason: `${entry.coin} position is ${isLong ? 'long' : 'short'} but the copy is ${entry.side}` };
  }

  const othersQty = entries
    .filter(e => e.status === 'open' && e.coin === entry.coin && e.id !== entry.id)
    .reduce((sum, e) => sum + e.qty, 0);
  if (othersQty > eps && posQty < entry.qty + othersQty - eps) {
    // Something reduced the position outside the ledger; we can't tell whose share is gone
    return {
      kind: 'refuse',
      reason: `${entry.coin} position (${posQty}) is smaller than the copies tracked in it (${roundQty(entry.qty + othersQty, szDecimals)}) — close manually`,
    };
  }

  const qty = floorQty(Math.min(entry.qty, posQty), szDecimals);
  if (qty < eps) return { kind: 'refuse', reason: `copy quantity ${entry.qty} rounds to zero at ${szDecimals} decimals` };
  return { kind: 'close', qty, isLong, full: qty >= posQty - eps };
}

/** After an explicit manual full close: every open entry in the coin is gone. */
export function closeAllInCoin(entries: CopyEntry[], coin: string, now: string): CopyEntry[] {
  return entries.map(e =>
    e.status === 'open' && e.coin === coin ? { ...e, qty: 0, status: 'closed', updatedAt: now, closedAt: now } : e);
}

// --- TP/SL ---

/** Set (or replace) one of an entry's TP/SL records. */
export function setTpsl(entries: CopyEntry[], entryId: string, which: 'tp' | 'sl', state: TpslState | null, now: string): CopyEntry[] {
  return entries.map(e => {
    if (e.id !== entryId) return e;
    const tpsl = { ...e.tpsl };
    if (state) tpsl[which] = state;
    else delete tpsl[which];
    return { ...e, tpsl, updatedAt: now };
  });
}

/** Record that a trader change (e.g. a TP/SL update) was applied to this entry, so it is applied once. */
export function addSourceUpdate(entries: CopyEntry[], entryId: string, updateId: string, now: string): CopyEntry[] {
  return entries.map(e =>
    e.id === entryId && !e.sourceUpdateIds?.includes(updateId)
      ? { ...e, sourceUpdateIds: [...(e.sourceUpdateIds ?? []), updateId], updatedAt: now }
      : e);
}
