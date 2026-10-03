// Parse a monitor signal into what trade.ts / close.ts / tpsl.ts execute.
//
// A copy replicates the trader's trade exactly — coin, direction, leverage,
// entry price, TP/SL, and every later change — so all of those come from the
// signal itself, never from separately typed arguments. Only the size is ours
// (computed from our equity in sizing.ts). Anything missing or malformed is
// refused here, before Hyperliquid is touched: a parameter we'd have to guess
// is a parameter we don't trade on.

import { parseMimicMeta, type MimicMeta } from './mimic-meta.js';
import { parseCloseIdentity, type CloseIdentity, type Side } from './copy-ledger.js';

/** An increase older than this is a trade at a stale price: refused (the monitor skips them too). */
export const MAX_CHANGE_AGE_MS = 300_000;
/**
 * An open signal whose post is older than this is refused by trade.ts itself, so a
 * saved, delayed or replayed signal can't open a trade the trader may have left
 * (the monitor's --max-signal-age filters them first; this holds whatever it was set to).
 */
export const MAX_OPEN_AGE_MS = 300_000;
/** Clock skew tolerated for a post time in the future; more than this is refused as unreadable. */
export const MAX_CLOCK_SKEW_MS = 60_000;

export type TpslKind = 'tp' | 'sl';

export interface OpenSignal {
  kind: 'open';
  coin: string;
  side: Side;
  leverage: number;
  /** The trader's fill price: our order is never worse than this by more than the slippage allowance. */
  entryPrice: number;
  /** The trader's take-profit / stop-loss trigger prices at open (null = none set). */
  tp: number | null;
  sl: number | null;
  /** When the trader opened (their trade's createdAt), if the signal says. */
  traderOpenedAt: string | null;
  /** When the feed post announcing the open was made (signal.postedAt); null if the signal doesn't say. */
  postedAt: string | null;
  mimicMeta: MimicMeta;
}

interface ChangeBase {
  coin: string;
  side: Side | null;
  identity: CloseIdentity;
  /** Unique per trader change (from /dex/trade), recorded so it is applied once. */
  updateId: string;
  updatedAt: string;
}

/**
 * The trader added to the trade: their position grew by `ratio`, in coins (see
 * notionalRatio). `positionSizeRatio` is /dex/trade's figure, kept for reference only.
 */
export interface IncreaseSignal extends ChangeBase { kind: 'increase'; ratio: number; positionSizeRatio: number; investmentId: string }
/** The trader reduced the trade by `fraction` of it, in coins (at most 1; see notionalRatio). */
export interface DecreaseSignal extends ChangeBase { kind: 'decrease'; fraction: number; positionSizeRatio: number }

/** Tolerances for the $ figures to reconcile with Invo's own after-change numbers. */
export const INCREASE_RECONCILE_TOLERANCE = 0.001; // 0.1% — matched to 0.000% on every live increase
export const DECREASE_RECONCILE_TOLERANCE = 0.01; // 1% — live decreases matched within 0.7%
/** The trader set (or moved) their take-profit or stop-loss. */
export interface TpslSignal extends ChangeBase { kind: 'tpsl'; which: TpslKind; triggerPx: number }
/** The trader closed the trade (closed by them, TP/SL hit or liquidated). */
export interface CloseSignal { kind: 'close'; coin: string; identity: CloseIdentity; reason: string | null }

export type TradeSignal = OpenSignal | IncreaseSignal | DecreaseSignal | TpslSignal | CloseSignal;

/** Does a CLI argument look like a signal (rather than a coin name)? */
export const isSignalArg = (arg: string | undefined) => typeof arg === 'string' && arg.trim().startsWith('{');

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function coinOf(trade: any): string {
  if (!nonEmpty(trade?.coin)) throw new Error('signal has no trade.coin');
  return trade.coin.trim();
}

function sideOf(trade: any, required: boolean): Side | null {
  const s = trade?.side;
  if (s === 'long' || s === 'short') return s;
  if (!required && s === undefined) return null;
  throw new Error(`signal trade.side must be "long" or "short" (got ${JSON.stringify(s ?? null)})`);
}

/** An optional price: absent from the signal is an error (unknown), null means "none set". */
function optionalPrice(trade: any, key: string, label: string): number | null {
  if (!(key in (trade ?? {}))) {
    throw new Error(`signal has no trade.${key} — can't tell whether the trader set a ${label}; re-run the monitor (it includes it)`);
  }
  const v = trade[key];
  if (v === null) return null;
  if (!positive(v)) throw new Error(`signal trade.${key} is not a positive price (got ${JSON.stringify(v)})`);
  return v;
}

function changeBase(sig: any): ChangeBase {
  if (!nonEmpty(sig.updateId)) throw new Error('signal has no updateId');
  if (!nonEmpty(sig.updatedAt) || !Number.isFinite(Date.parse(sig.updatedAt))) throw new Error('signal has no readable updatedAt');
  return {
    coin: coinOf(sig.trade),
    side: sideOf(sig.trade, false),
    identity: parseCloseIdentity(sig.mimicMeta),
    updateId: sig.updateId.trim(),
    updatedAt: sig.updatedAt,
  };
}

/** Position sizes before/after/change from a /dex/trade increase or decrease. */
function sizeChange(change: any): { before: number; after: number; delta: number } {
  const before = change?.positionSizeBefore;
  const after = change?.positionSizeAfter;
  const delta = change?.positionSizeChange;
  if (!positive(before) || typeof after !== 'number' || !Number.isFinite(after) || after < 0 || !positive(delta)) {
    throw new Error(`signal change has no usable positionSizeBefore/After/Change (got ${JSON.stringify(change ?? null)})`);
  }
  // The three must agree, or we don't know which one describes the trade
  if (Math.abs(Math.abs(after - before) - delta) > 1e-6 * Math.max(before, after)) {
    throw new Error(`signal change is inconsistent: |${after} - ${before}| != ${delta}`);
  }
  return { before, after, delta };
}

/**
 * How much the trader's position changed, in coins, from the feed post's $ figures
 * (change.notional). /dex/trade's positionSize is a share of the trader's portfolio
 * value at that moment, so its ratio drifts when their portfolio value changes —
 * it is never used for sizing.
 *   increase: coins before = entrySimBefore / entryPriceBefore, coins added =
 *             simDifference / livePriceAtChange → ratio = added / before. Must
 *             reproduce Invo's entrySimAfter and new average entry (entryPriceAfter).
 *   decrease: fraction = simDifference / entrySimBefore (both at the entry price).
 *             Must reproduce entrySimAfter.
 * Throws when the figures are missing or don't reconcile.
 */
export function notionalRatio(kind: 'increase' | 'decrease', notional: any, investmentId: string | null): number {
  if (!notional || typeof notional !== 'object') {
    throw new Error(`${kind} signal has no change.notional ($ figures from the trader's feed post) — positionSize alone can't size it exactly`);
  }
  const n = notional;
  if (investmentId !== null && n.investmentId !== investmentId) {
    throw new Error(`${kind} signal's $ figures are for change ${JSON.stringify(n.investmentId ?? null)}, not ${investmentId}`);
  }
  if (n.simIncrease !== (kind === 'increase')) throw new Error(`${kind} signal's $ figures describe ${n.simIncrease ? 'an increase' : 'a decrease'}`);
  if (!positive(n.entrySimBefore) || !positive(n.simDifference)) {
    throw new Error(`${kind} signal has no usable entrySimBefore / simDifference (got ${JSON.stringify([n.entrySimBefore ?? null, n.simDifference ?? null])})`);
  }
  if (typeof n.entrySimAfter !== 'number' || !Number.isFinite(n.entrySimAfter)) {
    throw new Error(`${kind} signal has no entrySimAfter to check its $ figures against`);
  }
  const off = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

  if (kind === 'increase') {
    if (!positive(n.entryPriceBefore) || !positive(n.livePriceAtChange) || !positive(n.entryPriceAfter)) {
      throw new Error(`increase signal has no usable entryPriceBefore / livePriceAtChange / entryPriceAfter (got ${
        JSON.stringify([n.entryPriceBefore ?? null, n.livePriceAtChange ?? null, n.entryPriceAfter ?? null])})`);
    }
    const coinsBefore = n.entrySimBefore / n.entryPriceBefore;
    const coinsAdded = n.simDifference / n.livePriceAtChange;
    const simAfter = n.entrySimBefore + n.simDifference;
    const avgEntry = simAfter / (coinsBefore + coinsAdded);
    if (off(n.entrySimAfter, simAfter) > INCREASE_RECONCILE_TOLERANCE || off(avgEntry, n.entryPriceAfter) > INCREASE_RECONCILE_TOLERANCE) {
      throw new Error(`increase signal's $ figures don't reconcile with Invo's (entrySim ${simAfter} vs ${n.entrySimAfter}, ` +
        `average entry ${avgEntry} vs ${n.entryPriceAfter}) — can't tell how much the trader added`);
    }
    return coinsAdded / coinsBefore;
  }

  if (n.simDifference > n.entrySimBefore * (1 + DECREASE_RECONCILE_TOLERANCE)) {
    throw new Error(`decrease signal removes $${n.simDifference} of a $${n.entrySimBefore} trade`);
  }
  const simAfter = Math.max(0, n.entrySimBefore - n.simDifference);
  if (Math.abs(n.entrySimAfter - simAfter) > DECREASE_RECONCILE_TOLERANCE * n.entrySimBefore) {
    throw new Error(`decrease signal's $ figures don't reconcile with Invo's (entrySim after ${simAfter} vs ${n.entrySimAfter}) — ` +
      `can't tell how much the trader closed`);
  }
  return Math.min(1, n.simDifference / n.entrySimBefore);
}

/** Parse a monitor signal (JSON). Throws on anything that isn't fully specified. */
export function parseTradeSignal(arg: string): TradeSignal {
  let sig: any;
  try {
    sig = JSON.parse(arg);
  } catch {
    throw new Error('signal is not valid JSON');
  }
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) throw new Error('signal must be a JSON object');
  if (sig.type !== undefined && sig.type !== 'signal') throw new Error(`not a signal (type ${JSON.stringify(sig.type)})`);

  switch (sig.action) {
    case 'open': {
      const t = sig.trade;
      if (t?.isOpen === false) throw new Error('open signal for a trade that is not open');
      const lev = t?.leverage;
      if (typeof lev !== 'number' || !Number.isSafeInteger(lev) || lev < 1) {
        throw new Error(`signal trade.leverage must be a whole number >= 1 (got ${JSON.stringify(lev ?? null)}) — Hyperliquid can't set it exactly`);
      }
      if (!positive(t?.entryPrice)) throw new Error(`signal has no trade.entryPrice (got ${JSON.stringify(t?.entryPrice ?? null)})`);
      const openedAt = nonEmpty(t?.openedAt) && Number.isFinite(Date.parse(t.openedAt)) ? t.openedAt : null;
      return {
        kind: 'open',
        coin: coinOf(t),
        side: sideOf(t, true)!,
        leverage: lev,
        entryPrice: t.entryPrice,
        tp: optionalPrice(t, 'priceTarget', 'take-profit'),
        sl: optionalPrice(t, 'stopLoss', 'stop-loss'),
        traderOpenedAt: openedAt,
        postedAt: nonEmpty(sig.postedAt) && Number.isFinite(Date.parse(sig.postedAt)) ? sig.postedAt : null,
        mimicMeta: parseMimicMeta(sig.mimicMeta),
      };
    }
    case 'increase': {
      const base = changeBase(sig);
      const { before, after, delta } = sizeChange(sig.change);
      if (!(after > before)) throw new Error(`increase signal whose position didn't grow (${before} → ${after})`);
      if (!nonEmpty(sig.investmentId)) throw new Error('increase signal has no investmentId');
      const investmentId = sig.investmentId.trim();
      const ratio = notionalRatio('increase', sig.change?.notional, investmentId);
      return { kind: 'increase', ...base, ratio, positionSizeRatio: delta / before, investmentId };
    }
    case 'decrease': {
      const base = changeBase(sig);
      const { before, after, delta } = sizeChange(sig.change);
      if (!(after < before)) throw new Error(`decrease signal whose position didn't shrink (${before} → ${after})`);
      if (!nonEmpty(sig.investmentId)) throw new Error('decrease signal has no investmentId');
      // Down to nothing is a full close of the copy, whatever the $ figures say
      const fraction = after === 0 ? 1 : notionalRatio('decrease', sig.change?.notional, sig.investmentId.trim());
      return { kind: 'decrease', ...base, fraction, positionSizeRatio: delta / before };
    }
    case 'tpsl': {
      const base = changeBase(sig);
      const which = sig.change?.which;
      if (which !== 'tp' && which !== 'sl') throw new Error(`tpsl signal change.which must be "tp" or "sl" (got ${JSON.stringify(which ?? null)})`);
      const px = sig.change?.triggerPx;
      if (!positive(px)) {
        // How Invo reports a removed TP/SL hasn't been seen: don't guess that it means "cancel"
        throw new Error(`tpsl signal has no ${which} trigger price (got ${JSON.stringify(px ?? null)}) — not replicated`);
      }
      return { kind: 'tpsl', ...base, which, triggerPx: px };
    }
    case 'close':
      return {
        kind: 'close',
        coin: coinOf(sig.trade),
        identity: parseCloseIdentity(sig.mimicMeta),
        reason: nonEmpty(sig.reasonClosed) ? sig.reasonClosed : null,
      };
    case 'update':
      throw new Error('`update` feed signals are informational: changes to a copied trade arrive as increase / decrease / tpsl signals');
    default:
      throw new Error(`unknown signal action ${JSON.stringify(sig.action ?? null)}`);
  }
}
