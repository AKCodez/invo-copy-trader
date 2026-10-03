// Open (or increase) a position: the logic behind commands/trade.ts.
// Hyperliquid, Invo and the copy ledger are injected so this is testable
// without network access or the HL SDK.

import { randomBytes, randomUUID } from 'crypto';
import type { RecordOpenPayload } from './invo-client.js';
import {
  assertExactPerpPrice,
  assertTriggerSide,
  classifyTrader,
  copyRange,
  entryBoundPx,
  sizeInitial,
  sizeIncrease,
  tierTargetUsd,
  SLIPPAGE_PCT,
  MAX_EQUITY_PCT,
  MAX_COMBINED_EQUITY_PCT,
  MIN_ORDER_NOTIONAL_USD,
} from './sizing.js';
import { getTraderStats, type TraderStatsClient } from './trader-stats.js';
import { MANUAL_TRADE_ARG, type MimicMeta } from './mimic-meta.js';
import { parseLeverageArg, checkLeverage } from './leverage.js';
import {
  beginOpen,
  findCopiedUpdate,
  findCopyToClose,
  isSameTrade,
  reconcileWithPosition,
  roundQty,
  settleOrder,
  type CopyEntry,
  type LedgerStore,
  type Side,
} from './copy-ledger.js';
import { assertHlOk, orderFilledQty, orderRejection } from './hl-response.js';
import { settlePendingOrders, type OrderLookup } from './pending-orders.js';
import {
  isSignalArg,
  parseTradeSignal,
  MAX_CHANGE_AGE_MS,
  MAX_CLOCK_SKEW_MS,
  MAX_OPEN_AGE_MS,
  type IncreaseSignal,
  type OpenSignal,
} from './trade-signal.js';
import { coinTriggers, replaceTpsl, type TpslHl, type TpslOutcome } from './tpsl-exec.js';

export interface HlMeta {
  universe: { name: string; szDecimals: number; maxLeverage: number }[];
}

/** A position as clearinghouseState reports it (fields we use). */
export interface HlPosition {
  coin: string;
  szi: string;
  /** Hyperliquid sets leverage per coin: one value for the whole position. */
  leverage?: { type?: string; value?: number };
}

/** The Hyperliquid calls trade/close need, bound to our wallet. */
export interface ExecHl extends OrderLookup {
  connect(): Promise<unknown>;
  getMeta(): Promise<HlMeta>;
  getAllMids(): Promise<Record<string, string>>;
  getPositions(): Promise<HlPosition[]>;
  /**
   * reduceOnly is required so every caller decides: closes must never open or flip a position.
   * cloid lets the order be looked up (getOrderFill) if its response is lost.
   */
  placeMarketOrder(
    coin: string, isBuy: boolean, size: string, slippagePct: number, midPx: number, szDecimals: number, reduceOnly: boolean, cloid: string,
  ): Promise<any>;
}

export interface TradeHl extends ExecHl, TpslHl {
  setLeverage(coin: string, leverage: number): Promise<unknown>;
  /** The account's current Hyperliquid equity in USD (marginSummary.accountValue). */
  getAccountEquity(): Promise<number>;
}

export interface TradeInvo extends TraderStatsClient {
  recordOpen(payload: RecordOpenPayload): Promise<any>;
}

export interface TradeDeps {
  hl: TradeHl;
  invo: TradeInvo;
  ledger: LedgerStore;
  newId?: () => string;
  newCloid?: () => string;
  now?: () => Date;
}

export class UsageError extends Error {}

export const TRADE_USAGE =
  `Usage: trade '<open or increase signal JSON>'  |  trade <coin> <long|short> <size (ignored)> <leverage> ${MANUAL_TRADE_ARG}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const randomCloid = () => `0x${randomBytes(16).toString('hex')}`;

/**
 * What an order filled: from its response, else looked up on HL by cloid.
 * null when that can't be known yet — the order is left pending for a later run to settle.
 *
 * If our request failed (threw), the order may still reach HL after we look:
 * "no such order" then proves nothing, so it stays pending instead of counting
 * as unfilled. settlePendingOrders only trusts that answer once the order is old.
 */
export async function resolveFill(hl: OrderLookup, orderResult: any, cloid: string, requestFailed: boolean): Promise<number | null> {
  const fromResponse = requestFailed ? null : orderFilledQty(orderResult);
  if (fromResponse !== null) return fromResponse;
  try {
    const f = await hl.getOrderFill(cloid);
    if (f.known) return f.filledQty;
    // HL answered our request, so it has processed the order: unknown = rejected without being stored
    return requestFailed ? null : 0;
  } catch {
    return null;
  }
}

/**
 * Leverage is per coin on Hyperliquid: setting it for this copy would change it
 * for everything already held in the coin (other traders' copies, manual
 * trades). So adding to a position needs the same leverage, isolated; anything
 * else — including leverage we can't read — is refused before anything changes.
 */
export function checkExistingLeverage(coin: string, position: HlPosition, leverage: number): void {
  const lev = position.leverage;
  const value = lev?.value;
  if (lev?.type !== 'isolated' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `Refusing to add to ${coin}: the existing position's leverage can't be confirmed as isolated ` +
      `(got ${JSON.stringify(lev ?? null)}) — changing it would affect everything held in ${coin}`,
    );
  }
  if (value !== leverage) {
    throw new Error(
      `Refusing ${leverage}x on ${coin}: the existing ${coin} position is ${value}x isolated, and leverage applies to the ` +
      `whole position (other copies included) — the trader's ${leverage}x can't be replicated while it is held`,
    );
  }
}

/**
 * USD notional of every active copy in the ledger (open entries' qty, plus the requested
 * size of any open order not yet settled), valued at current mids. Throws if a coin with
 * a copy has no mid: exposure that can't be valued can't be capped.
 */
export function activeCopiesNotionalUsd(entries: CopyEntry[], mids: Record<string, string>): number {
  let total = 0;
  for (const e of entries) {
    if (e.status !== 'open' && e.status !== 'pending') continue;
    const qty = e.qty + (e.pendingOrder?.kind === 'open' ? e.pendingOrder.requestedQty : 0);
    if (!(qty > 0)) continue;
    const px = parseFloat(mids[e.coin]);
    if (!(px > 0)) throw new Error(`No mid price for ${e.coin} (ledger entry ${e.id}) — can't value active copies for the combined cap`);
    total += qty * px;
  }
  return total;
}

function refuseRepeat(entry: CopyEntry, updateId: string): never {
  throw new Error(`Already copied trader update ${updateId} (ledger entry ${entry.id}, ${entry.status}) — refusing to trade it again`);
}


/**
 * trade.ts:
 *   trade '<signal JSON>'                      a copy: `open` or `increase` signal from the monitor.
 *                                              Coin, side, leverage, entry and TP/SL all come from it.
 *   trade <coin> <side> <ignored> <lev> manual  a trade the user asked for that copies nobody
 */
export async function runTrade(args: string[], deps: TradeDeps) {
  if (args.length === 1 && isSignalArg(args[0])) {
    const sig = parseTradeSignal(args[0]);
    if (sig.kind === 'open') return execute({ mode: 'open', coin: sig.coin, side: sig.side, leverage: sig.leverage, copy: sig, ignoredSizeArg: null }, deps);
    if (sig.kind === 'increase') return execute({ mode: 'increase', sig }, deps);
    throw new Error(`trade.ts runs open and increase signals; a ${sig.kind} signal goes to ${sig.kind === 'tpsl' ? 'tpsl.ts' : 'close.ts'}`);
  }

  const [coin, side, ignoredSizeArg, leverageStr, mimicArg] = args;
  if (!coin || (side !== 'long' && side !== 'short')) throw new UsageError(TRADE_USAGE);
  if (mimicArg !== MANUAL_TRADE_ARG) {
    throw new Error(
      mimicArg?.trim()
        ? `A copy is run from the trader's signal: trade.ts '<signal JSON>' — its coin, side, leverage, entry and TP/SL are taken from it, ` +
          `never typed separately. Positional arguments are only for a '${MANUAL_TRADE_ARG}' trade`
        : `mimicMeta is required: pass the whole signal (trade.ts '<signal JSON>'), or '${MANUAL_TRADE_ARG}' for a trade that copies nobody`,
    );
  }
  const leverage = parseLeverageArg(leverageStr);
  return execute({ mode: 'open', coin, side, leverage, copy: null, ignoredSizeArg: ignoredSizeArg ?? null }, deps);
}

type Request =
  | { mode: 'open'; coin: string; side: Side; leverage: number; copy: OpenSignal | null; ignoredSizeArg: string | null }
  | { mode: 'increase'; sig: IncreaseSignal };

async function execute(req: Request, deps: TradeDeps) {
  const { hl, invo } = deps;
  const newId = deps.newId ?? randomUUID;
  const newCloid = deps.newCloid ?? randomCloid;
  const now = deps.now ?? (() => new Date());

  const coin = req.mode === 'open' ? req.coin : req.sig.coin;
  const copy = req.mode === 'open' ? req.copy : null;
  const mimicMetaArg: MimicMeta | null = copy?.mimicMeta ?? null;
  // The trader update this order copies: the open's update id, or the /dex/trade change
  const updateId = req.mode === 'open' ? mimicMetaArg?.initialSourcePaperUpdateId ?? null : req.sig.updateId;

  // --- Checked before Hyperliquid is touched ---
  if (copy) {
    // A stale open (saved, delayed, replayed after a restart) is never traded
    if (!copy.postedAt) {
      throw new Error('open signal has no readable postedAt — can\'t tell how old it is, not copying (re-run the monitor; its signals include it)');
    }
    const ageMs = now().getTime() - Date.parse(copy.postedAt);
    if (ageMs > MAX_OPEN_AGE_MS) {
      throw new Error(`The trader's open was posted ${Math.round(ageMs / 1000)}s ago — too old to copy (max ${MAX_OPEN_AGE_MS / 1000}s)`);
    }
    if (ageMs < -MAX_CLOCK_SKEW_MS) {
      throw new Error(`open signal postedAt ${copy.postedAt} is ${Math.round(-ageMs / 1000)}s in the future — unreadable time, not copying`);
    }
  }
  if (req.mode === 'increase') {
    const ageMs = now().getTime() - Date.parse(req.sig.updatedAt);
    if (ageMs > MAX_CHANGE_AGE_MS) {
      throw new Error(`The trader's increase was ${Math.round(ageMs / 1000)}s ago — too old to copy at today's price (max ${MAX_CHANGE_AGE_MS / 1000}s)`);
    }
    if (ageMs < -MAX_CLOCK_SKEW_MS) {
      throw new Error(`increase signal updatedAt ${req.sig.updatedAt} is ${Math.round(-ageMs / 1000)}s in the future — unreadable time, not copying`);
    }
  }
  // Read the ledger before trading: a copy we can't record could never be closed by its trader's signal
  let ledgerEntries = deps.ledger.load();
  // Each trader update is copied once: a repeated signal (re-run, retry, duplicate post) must not add again.
  // An update whose order is still unsettled is re-checked once that's settled (below).
  const copied = updateId ? findCopiedUpdate(ledgerEntries, updateId) : undefined;
  if (copied && !copied.pendingOrder) refuseRepeat(copied, updateId!);

  await hl.connect();

  // Resolve asset index
  const meta = await hl.getMeta();
  const assetIndex = meta.universe.findIndex(a => a.name === coin);
  if (assetIndex < 0) throw new Error(`Unknown coin: ${coin}`);
  const { szDecimals, maxLeverage } = meta.universe[assetIndex];
  if (req.mode === 'open') checkLeverage(req.leverage, coin, maxLeverage);
  // The trader's TP/SL must be placeable exactly as they set it, or the copy isn't opened
  if (copy?.tp != null) assertExactPerpPrice(copy.tp, szDecimals, "The trader's take-profit");
  if (copy?.sl != null) assertExactPerpPrice(copy.sl, szDecimals, "The trader's stop-loss");

  // An earlier run's order in this coin that was never recorded is settled first (throws if it can't be)
  const pending = await settlePendingOrders(hl, deps.ledger, ledgerEntries, coin, szDecimals, now().toISOString());
  ledgerEntries = pending.entries;
  const copiedAfterSettle = updateId ? findCopiedUpdate(ledgerEntries, updateId) : undefined;
  if (copiedAfterSettle) refuseRepeat(copiedAfterSettle, updateId!);

  // Snapshot position before
  const posBefore = await hl.getPositions();
  const existing = posBefore.find(p => p.coin === coin);
  const qtyBefore = existing ? existing.szi : '0';
  const existingSzi = parseFloat(qtyBefore);

  // Entries the live position shows are gone (flat / other side) are closed first, so
  // they can't block later closes or absorb this fill. Saved now, before any order.
  const reconcile = reconcileWithPosition(ledgerEntries, coin, existingSzi, szDecimals, now().toISOString());
  if (reconcile.reconciled.length) {
    deps.ledger.save(reconcile.entries);
    ledgerEntries = reconcile.entries;
  }

  let side: Side;
  let leverage: number;
  let target: CopyEntry | null = null; // increase: the copy being added to
  if (req.mode === 'increase') {
    const match = findCopyToClose(ledgerEntries, coin, req.sig.identity);
    if (match.kind === 'refuse') throw new Error(`Can't copy the increase: ${match.reason}`);
    target = match.entry;
    side = target.side;
    if (req.sig.side && req.sig.side !== side) throw new Error(`increase signal is ${req.sig.side} but the copy is ${side}`);
    if (existingSzi === 0 || (existingSzi > 0) !== (side === 'long')) {
      throw new Error(`Can't copy the increase: the ${coin} position (${existingSzi}) doesn't hold the ${side} copy`);
    }
    // Same leverage as the copy: the trader's increase doesn't change it, and neither do we
    const copyLev = target.leverage ?? existing!.leverage?.value;
    checkExistingLeverage(coin, existing!, copyLev as number);
    leverage = copyLev as number;
  } else {
    side = req.side;
    leverage = req.leverage;
    if (copy) {
      const held = ledgerEntries.find(e =>
        (e.status === 'open' || e.status === 'pending') && e.coin === coin &&
        isSameTrade(e.source, { creatorInvoUserId: copy.mimicMeta.creatorInvoUserId, sourcePaperTradeBaseId: copy.mimicMeta.sourcePaperTradeBaseId }));
      if (held) throw new Error(`Already holding a copy of this trade (ledger entry ${held.id}) — an add arrives as an increase signal`);
    }
    if (existingSzi !== 0 && (existingSzi > 0) !== (side === 'long')) {
      throw new Error(`Refusing ${side} ${coin}: existing position is ${existingSzi > 0 ? 'long' : 'short'} ${Math.abs(existingSzi)}`);
    }
    if (existingSzi !== 0) checkExistingLeverage(coin, existing!, leverage);
  }
  const isBuy = side === 'long';

  // Position TP/SL on Hyperliquid act on the whole coin position: a new position can't
  // join one that has them, and a trader's TP/SL can't be set on a position others share
  if (req.mode === 'open') {
    const triggers = coinTriggers(await hl.getOpenOrders(), coin);
    if (triggers.length) {
      throw new Error(`${coin} has TP/SL orders on the position (${triggers.map(o => o.cloid ?? o.orderType).join(', ')}) — they would ` +
        `act on this new position too, so it can't be opened with the trader's parameters`);
    }
    if (copy && (copy.tp !== null || copy.sl !== null) && existingSzi !== 0) {
      throw new Error(`The trader set a TP/SL, but the ${coin} position already holds other trades — a Hyperliquid TP/SL would ` +
        `close those too, so this trade can't be replicated`);
    }
  }

  // A copy whose entry or TP/SL can't be replicated at today's price is refused before
  // leverage is set (checked again with the price the order is sent at, below)
  if (copy) {
    const mid0 = parseFloat((await hl.getAllMids())[coin]);
    if (!mid0) throw new Error(`No mid price for ${coin}`);
    entryBoundPx(mid0, copy.entryPrice, isBuy, SLIPPAGE_PCT);
    if (copy.tp != null) assertTriggerSide('tp', copy.tp, mid0, isBuy);
    if (copy.sl != null) assertTriggerSide('sl', copy.sl, mid0, isBuy);
  }

  // An open the combined cap can't take is refused before leverage is set (re-checked below
  // with the equity and prices the order is sized from)
  if (req.mode === 'open') {
    const early = copyRange(await hl.getAccountEquity());
    const room = (early.equityUsd * MAX_COMBINED_EQUITY_PCT) / 100 - activeCopiesNotionalUsd(ledgerEntries, await hl.getAllMids());
    if (room < early.minUsd) {
      throw new Error(`Combined cap: $${Math.max(0, room).toFixed(2)} left under ${MAX_COMBINED_EQUITY_PCT}% of $${early.equityUsd.toFixed(2)} equity ` +
        `for all active copies, less than the $${early.minUsd.toFixed(2)} a new copy needs at minimum — refusing rather than opening below the 5% floor`);
    }
  }

  // Trader's tier, as a % of equity. Stats null on any lookup failure → poor tier (5%)
  const statsLookup = await getTraderStats(invo, mimicMetaArg ?? target?.source ?? null);
  const perf = classifyTrader(statsLookup.stats);

  // Set leverage for a new position. HL reports a rejection (e.g. can't switch an open cross
  // position to isolated) in the response body; never place the order at a leverage we didn't set.
  // (With a position open, checkExistingLeverage above means this changes nothing.)
  if (req.mode === 'open') assertHlOk(await hl.setLeverage(coin, leverage), `Setting ${coin} to ${leverage}x isolated`);

  // Equity and price last: the stats lookup and leverage change above are network calls
  // (up to 20s each), and the size must track the balance and price as they are when the
  // order goes out. Only a local ledger write sits between these reads and the order.
  const range = copyRange(await hl.getAccountEquity()); // throws if unusable or too small
  const mids = await hl.getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  // Combined cap: every active copy on the account plus this order stays within
  // MAX_COMBINED_EQUITY_PCT of equity (worst-case fill for this order, mid for the rest)
  const combinedCapUsd = (range.equityUsd * MAX_COMBINED_EQUITY_PCT) / 100;
  const combinedExposureUsd = activeCopiesNotionalUsd(ledgerEntries, mids);
  const combinedHeadroomUsd = combinedCapUsd - combinedExposureUsd;
  const combinedRefusal = (need: number, what: string) =>
    `Combined cap: active copies are $${combinedExposureUsd.toFixed(2)} of the $${combinedCapUsd.toFixed(2)} allowed ` +
    `(${MAX_COMBINED_EQUITY_PCT}% of $${range.equityUsd.toFixed(2)} equity) — $${Math.max(0, combinedHeadroomUsd).toFixed(2)} left, ` +
    `less than the $${need.toFixed(2)} ${what}`;
  if (req.mode === 'open' && combinedHeadroomUsd < range.minUsd) {
    throw new Error(`${combinedRefusal(range.minUsd, 'a new copy needs at minimum')} — refusing rather than opening below the 5% floor`);
  }
  if (req.mode === 'increase' && combinedHeadroomUsd < MIN_ORDER_NOTIONAL_USD) {
    throw new Error(`Can't copy the increase: ${combinedRefusal(MIN_ORDER_NOTIONAL_USD, 'minimum order')}`);
  }

  // A copy enters no worse than the trader's own entry allows (see entryBoundPx), and its
  // TP/SL must still be on the right side of the price, or nothing is opened
  const orderPx = copy ? entryBoundPx(mid, copy.entryPrice, isBuy, SLIPPAGE_PCT) : mid;
  if (copy?.tp != null) assertTriggerSide('tp', copy.tp, mid, isBuy);
  if (copy?.sl != null) assertTriggerSide('sl', copy.sl, mid, isBuy);

  // Size — the only thing not copied from the trader: always from our own equity.
  //   open:     the tier's % of equity, clamped to 5–15% of equity
  //   increase: the trader's add in proportion to our copy (their change / their size before),
  //             never more than any of:
  //               - the tier's % of equity (≤ 15%) for this add
  //               - what keeps the whole copy within 15% of equity (MAX_EQUITY_PCT)
  //               - 80% of the current notional (the smaller of this copy and the whole coin position)
  //   both:     never more than the room left under the combined cap (above); an open is
  //             still at least 5% of equity, or it was refused
  // Bounds hold at the worst-case fill (orderPx ± SLIPPAGE_PCT), not just at mid.
  const openRange = { minUsd: range.minUsd, maxUsd: Math.min(range.maxUsd, combinedHeadroomUsd) };
  const tierUsd = Math.min(tierTargetUsd(range.equityUsd, perf.equityPct), openRange.maxUsd);
  const copyNotionalUsd = target ? target.qty * mid : 0;
  const positionNotionalUsd = Math.abs(existingSzi) * mid;
  const mirroredUsd = req.mode === 'increase' ? copyNotionalUsd * req.sig.ratio : null;
  // Room left under the 15% cap on the copy's total size, valued at today's mid
  const copyHeadroomUsd = req.mode === 'increase' ? range.maxUsd - copyNotionalUsd : null;
  if (copyHeadroomUsd !== null && copyHeadroomUsd <= 0) {
    throw new Error(
      `Can't copy the increase: our ${coin} copy is already $${copyNotionalUsd.toFixed(2)}, at or above ` +
      `${MAX_EQUITY_PCT}% of equity ($${range.maxUsd.toFixed(2)}) — the maximum a copy may reach`,
    );
  }
  const targetUsd = mirroredUsd === null ? tierUsd : Math.min(mirroredUsd, tierUsd, copyHeadroomUsd!, combinedHeadroomUsd);
  const sizing = req.mode === 'increase'
    ? sizeIncrease(targetUsd, Math.min(copyNotionalUsd, positionNotionalUsd), mid, szDecimals, isBuy, SLIPPAGE_PCT)
    : sizeInitial(targetUsd, openRange, orderPx, szDecimals, isBuy, SLIPPAGE_PCT);
  const sizeStr = sizing.qty;

  const clientTxId = newId();
  const cloid = newCloid();

  // Write the order to the ledger before sending it: if this process dies after
  // the order fills, the next run settles it by cloid instead of losing the fill.
  const source = target?.source ?? (mimicMetaArg && {
    creatorInvoUserId: mimicMetaArg.creatorInvoUserId,
    portfolioId: mimicMetaArg.portfolioId,
    sourcePaperTradeBaseId: mimicMetaArg.sourcePaperTradeBaseId,
    sourcePaperTradeBaseShortId: mimicMetaArg.sourcePaperTradeBaseShortId,
  });
  const begun = beginOpen(ledgerEntries, {
    id: clientTxId,
    coin,
    side,
    source,
    sourceUpdateId: updateId,
    cloid,
    requestedQty: parseFloat(sizeStr),
    now: now().toISOString(),
    leverage,
    traderOpenedAt: copy?.traderOpenedAt ?? null,
  });
  deps.ledger.save(begun.entries);

  // Place order on HL (limit derived from orderPx — see sizing.limitPrice)
  const nonceMs = now().getTime();
  let orderResult: any = null;
  let orderError: string | null = null;
  let requestFailed = false;
  try {
    orderResult = await hl.placeMarketOrder(coin, isBuy, sizeStr, SLIPPAGE_PCT, orderPx, szDecimals, false, cloid);
    orderError = orderRejection(orderResult);
  } catch (e: any) {
    // May or may not have reached HL — resolveFill looks it up by cloid
    requestFailed = true;
    orderError = `order request failed: ${e.message}`;
  }
  const filled = await resolveFill(hl, orderResult, cloid, requestFailed);

  const base = {
    action: req.mode,
    coin,
    side,
    size: sizeStr,
    leverage,
    ...(copy && { trader: { entryPrice: copy.entryPrice, tp: copy.tp, sl: copy.sl } }),
    // ratio: the trader's add in coins, from their $ figures; positionSizeRatio: /dex/trade's (reference only)
    ...(req.mode === 'increase' && { trader: { ratio: req.sig.ratio, positionSizeRatio: req.sig.positionSizeRatio, updateId: req.sig.updateId } }),
    sizing: {
      mode: req.mode === 'increase' ? 'increase' : 'initial',
      tier: perf.tier,
      equityUsd: round2(range.equityUsd),
      tierPct: perf.equityPct,
      // Initial copies are clamped to [minUsd, maxUsd]; increases use targetUsd under the 80% cap
      minUsd: round2(range.minUsd),
      maxUsd: round2(range.maxUsd),
      targetUsd: round2(targetUsd),
      ...(mirroredUsd !== null && { mirroredUsd: round2(mirroredUsd) }),
      ...(copyHeadroomUsd !== null && { copyHeadroomUsd: round2(copyHeadroomUsd), positionNotionalUsd: round2(positionNotionalUsd) }),
      combinedCapUsd: round2(combinedCapUsd),
      combinedExposureUsd: round2(combinedExposureUsd),
      combinedHeadroomUsd: round2(combinedHeadroomUsd),
      notionalUsd: sizing.notionalUsd,
      minFillNotionalUsd: sizing.minFillNotionalUsd,
      maxFillNotionalUsd: sizing.maxFillNotionalUsd,
      mid,
      ...(orderPx !== mid && { orderPx }),
      limitPx: sizing.limitPx,
      ...('capUsd' in sizing && { currentNotionalUsd: round2(copyNotionalUsd), capUsd: sizing.capUsd }),
      reasons: perf.reasons,
      statsLookup: statsLookup.status,
      ...(req.mode === 'open' && !copy && { ignoredSizeArg: req.ignoredSizeArg }),
    },
    manual: source === null,
    // Trader's baseShortId (for /dex/trade watch entries) — null for a manual trade
    sourceBaseShortId: source?.sourcePaperTradeBaseShortId ?? null,
    clientTxId,
    cloid,
    qtyBefore,
    hlResult: orderResult,
    ...(orderError && { orderError }),
    ...(pending.settled.length && { settledPendingOrders: pending.settled }),
    ...(reconcile.reconciled.length && { reconciledEntryIds: reconcile.reconciled }),
  };
  const wantsTpsl = !!copy && (copy.tp !== null || copy.sl !== null);

  if (filled === null) {
    // Neither the response nor HL says what happened. The ledger keeps the order
    // pending; the next trade/close in this coin settles it before doing anything.
    return {
      status: 'unknown' as const,
      ...base,
      filledQty: null,
      positionRecordId: null,
      ledger: { entryId: begun.entryId, copyQty: null, error: `order ${cloid} unsettled — the next ${coin} trade/close settles it` },
      qtyAfter: null,
      invoResult: null,
      ...(wantsTpsl && { tpsl: { error: `not placed: fill unknown — once settled, run tpsl.ts with this open signal` } }),
    };
  }

  // Fill comes from the order itself, so other activity in the coin can't be counted as this copy
  const filledQty = roundQty(filled, szDecimals);

  // Snapshot position after (informational; also sent to Invo)
  let qtyAfter: string;
  try {
    qtyAfter = (await hl.getPositions()).find(p => p.coin === coin)?.szi ?? '0';
  } catch {
    qtyAfter = String(roundQty(existingSzi + (isBuy ? filledQty : -filledQty), szDecimals));
  }

  // Record on Invo (non-fatal if it fails — position is open on HL regardless).
  // Nothing filled → nothing to record.
  const invoMimicMeta: MimicMeta | null = req.mode === 'increase'
    ? (source && { ...source, initialSourcePaperUpdateId: req.sig.investmentId })
    : mimicMetaArg;
  let invoResult: any = null;
  if (filledQty > 0) {
    try {
      invoResult = await invo.recordOpen({
        clientTxId,
        coin,
        assetIndex,
        entry: {
          side: isBuy ? 'long' : 'short',
          marginMode: 'isolated',
          leverage,
          tpPx: copy?.tp != null ? String(copy.tp) : null,
          slPx: copy?.sl != null ? String(copy.sl) : null,
        },
        submission: {
          hlOrder: orderResult,
          nonceMs,
          hlResponse: orderResult,
        },
        summary: {
          qtyBefore,
          qtyAfter,
          intendedLeverage: leverage,
        },
        ...(invoMimicMeta && { mimicMeta: invoMimicMeta }),
      });
    } catch (e: any) {
      invoResult = { error: e.message };
    }
  }
  const positionRecordId: string | null = invoResult?.positionRecordId ?? null;

  // Settle the pending order: record what filled against the trader we copied,
  // so only their close signal closes it
  let ledger: { entryId: string | null; copyQty: number | null; error?: string };
  let settled: CopyEntry[] | null = null;
  try {
    settled = settleOrder(begun.entries, begun.entryId, filledQty, szDecimals, now().toISOString(), positionRecordId);
    deps.ledger.save(settled);
    const entry = settled.find(e => e.id === begun.entryId);
    ledger = filledQty > 0
      ? { entryId: begun.entryId, copyQty: entry!.qty }
      : { entryId: null, copyQty: null, error: 'no fill — nothing recorded' };
  } catch (e: any) {
    settled = null;
    ledger = { entryId: begun.entryId, copyQty: null, error: `ledger write failed: ${e.message} — the order stays pending; the next ${coin} trade/close settles it` };
  }

  // The trader's TP/SL, as position TP/SL on the copy we just opened
  let tpsl: { outcomes?: TpslOutcome[]; error?: string } | undefined;
  if (wantsTpsl && filledQty > 0) {
    if (!settled) {
      tpsl = { error: 'not placed: the ledger could not be written — once settled, run tpsl.ts with this open signal' };
    } else {
      const outcomes: TpslOutcome[] = [];
      let entries = settled;
      for (const [which, px] of [['tp', copy!.tp], ['sl', copy!.sl]] as const) {
        if (px === null) continue;
        const entry = entries.find(e => e.id === begun.entryId)!;
        try {
          const r = await replaceTpsl(hl, deps.ledger, entries, entry, which, px, copy!.traderOpenedAt ?? '', szDecimals, newCloid(),
            now().toISOString(), []);
          entries = r.entries;
          outcomes.push(r.outcome);
        } catch (e: any) {
          outcomes.push({ which, status: 'error', triggerPx: px, error: e.message });
        }
      }
      tpsl = outcomes.some(o => o.status === 'error')
        ? { outcomes, error: 'the trader\'s TP/SL is not fully replicated — retry with tpsl.ts and this open signal' }
        : { outcomes };
    }
  }

  return {
    status: filledQty > 0 ? ('filled' as const) : ('not_filled' as const),
    ...base,
    filledQty,
    // Invo's record of our copy. /dex/position/create returns no baseShortId of ours.
    positionRecordId,
    ledger,
    qtyAfter,
    invoResult,
    ...(tpsl && { tpsl }),
  };
}
