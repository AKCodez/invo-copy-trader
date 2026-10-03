// In-memory stand-ins for Hyperliquid, Invo and the copy ledger, shared by
// trade-exec / close-exec tests. Nothing here touches the network or disk.

import type { CopyEntry, LedgerStore } from './copy-ledger.js';
import type { HlMeta, TradeHl, TradeInvo } from './trade-exec.js';
import type { OpenOrder } from './tpsl-exec.js';

export class MemoryLedgerStore implements LedgerStore {
  entries: CopyEntry[];
  saves = 0;
  failLoad = false;
  failSave = false;
  /** Saves fail once this many have succeeded (e.g. 1: the write before the order works, the one after fails). */
  failSavesAfter = Infinity;

  constructor(initial: CopyEntry[] = []) {
    this.entries = structuredClone(initial);
  }
  load(): CopyEntry[] {
    if (this.failLoad) throw new Error('Copy ledger is unreadable: boom');
    return structuredClone(this.entries);
  }
  save(entries: CopyEntry[]): void {
    if (this.failSave || this.saves >= this.failSavesAfter) throw new Error('disk full');
    this.saves++;
    this.entries = structuredClone(entries);
  }
}

export const UNIVERSE: HlMeta['universe'] = [
  { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
  { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
  { name: 'SOL', szDecimals: 2, maxLeverage: 20 },
];

/**
 * Fake HL: positions are signed coin sizes; orders fill `fillRatio` of their size.
 * Responses have HL's shape: rejections come back as { status: 'err' } or a
 * per-order { error }, not as exceptions. A reduce-only order never grows or
 * flips the position. Orders are kept by cloid for getOrderFill.
 *   beforeOrder:  change the position between the caller's snapshot and the fill
 *   orderThrows:  'before' — the request never reaches HL; 'after' — HL fills it,
 *                 then the response is lost (timeout)
 *   opaqueOrderResponse: HL fills it but the response has no per-order status
 *   failPositionsAfterOrder / failOrderLookup: those reads throw
 *   orderFills:   fills HL already holds for cloids (orders from an earlier run)
 *   positionLeverage: leverage of positions held at the start (default 5x isolated);
 *                 setLeverage changes it for the whole coin, as on HL
 *   equity:       account equity in USD (default 784: 15% = $117.60, 5% = $39.20);
 *                 `hl.equity` can be changed mid-test
 */
export function fakeHl(opts: {
  positions?: Record<string, number>;
  mids?: Record<string, number>;
  fillRatio?: number;
  rejectLeverage?: boolean;
  rejectOrder?: boolean;
  beforeOrder?: (positions: Record<string, number>) => void;
  orderThrows?: 'before' | 'after';
  opaqueOrderResponse?: boolean;
  failPositionsAfterOrder?: boolean;
  failOrderLookup?: boolean;
  orderFills?: Record<string, number>;
  positionLeverage?: Record<string, { type?: string; value?: number } | undefined>;
  equity?: number;
  /** Open orders on the account at the start (e.g. TP/SL triggers placed elsewhere). */
  openOrders?: OpenOrder[];
  rejectTpsl?: boolean;
} = {}) {
  const positions: Record<string, number> = { ...opts.positions };
  const mids = { SOL: 100, BTC: 60000, ETH: 3000, ...opts.mids };
  const calls: string[] = [];
  const orders: { coin: string; isBuy: boolean; size: string; slippagePct: number; midPx: number; szDecimals: number; reduceOnly: boolean; cloid: string }[] = [];
  const leverage: [string, number][] = [];
  const fills: Record<string, number> = { ...opts.orderFills };
  const coinLeverage: Record<string, { type?: string; value?: number } | undefined> = Object.fromEntries(
    Object.keys(positions).map(coin => [coin, { type: 'isolated', value: 5 }]));
  Object.assign(coinLeverage, opts.positionLeverage);

  const openOrders: OpenOrder[] = [...(opts.openOrders ?? [])];
  const tpslOrders: { coin: string; isLong: boolean; which: 'tp' | 'sl'; triggerPx: number; szDecimals: number; cloid: string }[] = [];
  const cancels: string[] = [];

  const hl: TradeHl & {
    calls: string[]; orders: typeof orders; leverage: typeof leverage; positions: typeof positions; mids: typeof mids; equity: number;
    openOrders: typeof openOrders; tpslOrders: typeof tpslOrders; cancels: typeof cancels;
  } = {
    calls, orders, leverage, positions, mids, openOrders, tpslOrders, cancels,
    async getOpenOrders() { calls.push('getOpenOrders'); return structuredClone(openOrders); },
    async placePositionTpsl(coin, isLong, which, triggerPx, szDecimals, cloid) {
      calls.push(`placePositionTpsl:${which}`);
      tpslOrders.push({ coin, isLong, which, triggerPx, szDecimals, cloid });
      if (opts.rejectTpsl) return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Invalid TP/SL price.' }] } } };
      openOrders.push({ coin, cloid, isTrigger: true, orderType: which === 'tp' ? 'Take Profit Market' : 'Stop Market', triggerPx: String(triggerPx) });
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 7 } }] } } };
    },
    async cancelByCloid(coin, cloid) {
      calls.push(`cancelByCloid:${cloid}`);
      cancels.push(cloid);
      const i = openOrders.findIndex(o => o.coin === coin && o.cloid === cloid);
      if (i < 0) return { status: 'ok', response: { type: 'cancel', data: { statuses: [{ error: 'Order was never placed, already canceled, or filled.' }] } } };
      openOrders.splice(i, 1);
      return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } };
    },
    equity: opts.equity ?? 784,
    async getAccountEquity() { calls.push('getAccountEquity'); return this.equity; },
    async connect() { calls.push('connect'); },
    async getMeta() { calls.push('getMeta'); return { universe: UNIVERSE }; },
    async getAllMids() { calls.push('getAllMids'); return Object.fromEntries(Object.entries(mids).map(([k, v]) => [k, String(v)])); },
    async getPositions() {
      calls.push('getPositions');
      if (opts.failPositionsAfterOrder && orders.length) throw new Error('clearinghouseState timeout');
      return Object.entries(positions).filter(([, v]) => v !== 0)
        .map(([coin, v]) => ({ coin, szi: String(v), ...(coinLeverage[coin] && { leverage: coinLeverage[coin] }) }));
    },
    async getOrderFill(cloid) {
      calls.push(`getOrderFill:${cloid}`);
      if (opts.failOrderLookup) throw new Error('orderStatus timeout');
      return cloid in fills ? { known: true, filledQty: fills[cloid] } : { known: false, filledQty: 0 };
    },
    async setLeverage(coin, lev) {
      calls.push('setLeverage');
      if (opts.rejectLeverage) return { status: 'err', response: 'Cannot switch leverage type with open position.' };
      leverage.push([coin, lev]);
      coinLeverage[coin] = { type: 'isolated', value: lev };
      return { status: 'ok', response: { type: 'default' } };
    },
    async placeMarketOrder(coin, isBuy, size, slippagePct, midPx, szDecimals, reduceOnly, cloid) {
      calls.push('placeMarketOrder');
      orders.push({ coin, isBuy, size, slippagePct, midPx, szDecimals, reduceOnly, cloid });
      if (opts.orderThrows === 'before') throw new Error('ECONNRESET');
      opts.beforeOrder?.(positions);
      if (opts.rejectOrder) return { status: 'err', response: 'Insufficient margin to place order.' };
      const pos = positions[coin] ?? 0;
      let filled = parseFloat(size) * (opts.fillRatio ?? 1);
      // Reduce-only: only the side that shrinks the position, and no further than flat
      if (reduceOnly) filled = pos !== 0 && (pos > 0) !== isBuy ? Math.min(filled, Math.abs(pos)) : 0;
      fills[cloid] = Math.max(0, filled);
      if (filled > 0) positions[coin] = Number((pos + (isBuy ? filled : -filled)).toFixed(8));
      if (opts.orderThrows === 'after') throw new Error('request timed out');
      if (opts.opaqueOrderResponse) return { status: 'ok', response: { type: 'order' } };
      if (filled <= 0) {
        return { status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders.' }] } } };
      }
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(filled), avgPx: String(midPx), oid: 1 } }] } } };
    },
  };
  return hl;
}

/** Fake Invo: trader stats lookups + recordOpen. */
export function fakeInvo(opts: { failRecordOpen?: boolean } = {}) {
  const calls: string[] = [];
  const recorded: any[] = [];
  let n = 0;
  const invo: TradeInvo & { calls: string[]; recorded: any[] } = {
    calls, recorded,
    async getUserPortfolios(userId) {
      calls.push(`getUserPortfolios:${userId}`);
      return { portfolios: [{ id: `p-${userId}`, ownerId: userId }] };
    },
    async getPortfolioById(portfolioId) {
      calls.push(`getPortfolioById:${portfolioId}`);
      const ownerId = portfolioId.replace(/^p-/, '');
      return {
        success: true, error: null,
        portfolio: { id: portfolioId, ownerId, winRate: 92, wonPositions: 184, lostPositions: 16, currentWinStreak: 14, percentChange: 1200, liquidated: false },
      };
    },
    async recordOpen(payload) {
      calls.push('recordOpen');
      recorded.push(structuredClone(payload));
      if (opts.failRecordOpen) throw new Error('Invo /dex/position/create 500');
      return { positionRecordId: `rec-${++n}`, eventId: `evt-${n}`, cloids: [], oids: [] };
    },
  };
  return invo;
}

/** A signal's mimicMeta for `trader`'s trade `trade` (portfolio p-<trader>). */
export const signalMeta = (trader: string, trade: string, update = trade) => ({
  portfolioId: `p-${trader}`,
  creatorInvoUserId: trader,
  initialSourcePaperUpdateId: `upd-${update}`,
  sourcePaperTradeBaseId: `base-${trade}`,
  sourcePaperTradeBaseShortId: `short-${trade}`,
});

/** A ledger entry copying `trader`'s trade `trade` (null trader = manual). */
export function copyEntry(id: string, coin: string, qty: number, trader: string | null, trade = id, side: 'long' | 'short' = 'long'): CopyEntry {
  const m = trader ? signalMeta(trader, trade) : null;
  return {
    id, coin, side, qty,
    source: m && {
      creatorInvoUserId: m.creatorInvoUserId,
      portfolioId: m.portfolioId,
      sourcePaperTradeBaseId: m.sourcePaperTradeBaseId,
      sourcePaperTradeBaseShortId: m.sourcePaperTradeBaseShortId,
    },
    positionRecordIds: [],
    ...(m && { sourceUpdateIds: [m.initialSourcePaperUpdateId] }),
    status: 'open',
    openedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/**
 * $ figures for a trader's change (as the feed post for it carries them) that
 * reconcile like live ones: an increase by `ratio` in coins (entry and change at
 * `px`), or a decrease by `ratio` of the trade.
 */
export function notionalFor(kind: 'increase' | 'decrease', ratio: number, investmentId: string, px = 100) {
  const entrySimBefore = 100;
  if (kind === 'decrease') {
    const simDifference = entrySimBefore * ratio;
    return {
      investmentId, postId: `post-${investmentId}`, simIncrease: false, entrySimBefore, simDifference,
      entryPriceBefore: null, livePriceAtChange: px, entrySimAfter: entrySimBefore - simDifference, entryPriceAfter: px,
    };
  }
  const coinsBefore = entrySimBefore / px;
  const simDifference = coinsBefore * ratio * px;
  const entrySimAfter = entrySimBefore + simDifference;
  return {
    investmentId, postId: `post-${investmentId}`, simIncrease: true, entrySimBefore, simDifference,
    entryPriceBefore: px, livePriceAtChange: px, entrySimAfter, entryPriceAfter: entrySimAfter / (coinsBefore * (1 + ratio)),
  };
}
