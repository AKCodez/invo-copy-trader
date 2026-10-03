// Copy-trade position sizing. Pure functions — no network or env access.
//
// Sizes follow the account: percentages of the current Hyperliquid account
// equity (marginSummary.accountValue), read fresh before each copy.
//
// Initial copy:  USD notional between 5% and 15% of equity (copyRange). The
//                copied trader's performance tier picks the percentage: poor 5%,
//                average 7.8% (streak < 5) or 10.4% (streak >= 5), strong 15%.
//                The floor is never below Hyperliquid's $10 minimum order, so
//                under $200 of equity it is $10 rather than 5%; under $66.67
//                (15% < $10) the account is too small to copy at all.
// Increase:      the tier's % of equity (at most 15%), capped at 80% of the
//                current USD notional of our position (valued at mid). No 5%
//                floor (the 80% cap can be smaller); $10 minimum. No cap on
//                total position size.
//
// All limits are enforced at the worst-case fill price, not at mid. Orders are
// IOC limits at mid ± SLIPPAGE_PCT (see limitPrice), so fills are assumed to
// land within [mid × (1 - s), mid × (1 + s)]:
//   - buy max / sell min:  bounded by the order's own limit price (hard guarantee)
//   - buy min / sell max:  assumes price doesn't move > s between the mid fetch
//                          and the fill — a limit order can't bound it. trade-exec
//                          fetches mid last, just before sizing and sending the
//                          order, so that gap is one order round trip

/** A copy's size range, as % of account equity. */
export const MIN_EQUITY_PCT = 5;
export const MAX_EQUITY_PCT = 15;
/**
 * % of equity each tier aims for, within [MIN_EQUITY_PCT, MAX_EQUITY_PCT]. Each
 * tier keeps its relative place in the range (average: 28% and 54% of the way
 * from the minimum to the maximum; poor at the minimum, strong at the maximum).
 */
export const TIER_EQUITY_PCT = {
  poor: 5,
  averageShortStreak: 7.8, // streak < 5
  averageLongStreak: 10.4, // streak >= 5
  strong: 15,
} as const;
export const MAX_INCREASE_FRACTION = 0.8;
/**
 * Combined cap: the notional of every active copy on the account (all coins, all
 * traders, manual trades included, pending orders counted at their requested size)
 * plus a new order at its worst-case fill may not exceed this % of current equity.
 * Opens and adds both respect it, so several traders sending the same signal can't
 * stack past it.
 */
export const MAX_COMBINED_EQUITY_PCT = 80;
export const MIN_ORDER_NOTIONAL_USD = 10; // Hyperliquid minimum order value
export const SLIPPAGE_PCT = 0.02;

const EPS = 1e-9;

// Fields from Invo's get_portfolios_pl (same source discover.ts ranks on).
export interface TraderStats {
  winRate?: number; // percent, 0-100
  wonPositions?: number;
  lostPositions?: number;
  currentWinStreak?: number;
  percentChange?: number; // lifetime P&L %
  liquidated?: boolean;
}

export type Tier = 'strong' | 'average' | 'poor';

export interface TierResult {
  tier: Tier;
  /** % of account equity this tier aims for. */
  equityPct: number;
  reasons: string[];
}

export function classifyTrader(stats: TraderStats | null | undefined): TierResult {
  if (!stats) return { tier: 'poor', equityPct: TIER_EQUITY_PCT.poor, reasons: ['trader stats unavailable'] };

  const winRate = stats.winRate;
  const streak = stats.currentWinStreak;
  const pnl = stats.percentChange;
  const won = stats.wonPositions ?? 0;
  const lost = stats.lostPositions ?? 0;
  const wl = lost > 0 ? won / lost : won > 0 ? Infinity : 0;

  const summary = `streak ${streak ?? '?'}, WR ${winRate ?? '?'}%, W/L ${Number.isFinite(wl) ? wl.toFixed(2) : '∞'}, P&L ${pnl ?? '?'}%`;

  // Poor: anything missing or a negative signal → minimum size
  const poor: string[] = [];
  if (winRate == null || streak == null || pnl == null) poor.push('incomplete stats');
  if (stats.liquidated) poor.push('liquidated');
  if (pnl != null && pnl <= 0) poor.push('non-positive P&L');
  if (streak === 0) poor.push('last closed trade lost');
  if (winRate != null && winRate < 60) poor.push('win rate < 60%');
  if (wl < 1.5) poor.push('W/L < 1.5');
  if (poor.length) return { tier: 'poor', equityPct: TIER_EQUITY_PCT.poor, reasons: [...poor, summary] };

  if (streak! >= 10 && winRate! >= 85 && wl >= 5) {
    return { tier: 'strong', equityPct: TIER_EQUITY_PCT.strong, reasons: [summary] };
  }

  return {
    tier: 'average',
    equityPct: streak! >= 5 ? TIER_EQUITY_PCT.averageLongStreak : TIER_EQUITY_PCT.averageShortStreak,
    reasons: [summary],
  };
}

/** USD bounds for a new copy, from the account's equity. */
export interface CopyRange {
  equityUsd: number;
  /** 5% of equity, or Hyperliquid's $10 minimum order if that is more. */
  minUsd: number;
  /** 15% of equity. */
  maxUsd: number;
}

/** Throws if equity is unusable, or too small for a copy (15% below the $10 minimum order). */
export function copyRange(equityUsd: number): CopyRange {
  if (!Number.isFinite(equityUsd) || !(equityUsd > 0)) throw new Error(`Invalid account equity: ${equityUsd}`);
  const maxUsd = (equityUsd * MAX_EQUITY_PCT) / 100;
  const minUsd = Math.max((equityUsd * MIN_EQUITY_PCT) / 100, MIN_ORDER_NOTIONAL_USD);
  if (minUsd > maxUsd) {
    throw new Error(
      // Cents rounded down, so 15% of $66.66 shows as $9.99, not a misleading "$10.00"
      `Account equity $${equityUsd.toFixed(2)} is too small to copy: ${MAX_EQUITY_PCT}% ($${(Math.floor(maxUsd * 100) / 100).toFixed(2)}) ` +
      `is below Hyperliquid's $${MIN_ORDER_NOTIONAL_USD} minimum order`,
    );
  }
  return { equityUsd, minUsd, maxUsd };
}

/** The tier's percentage of equity in USD (clamped by sizeInitial, capped by sizeIncrease). */
export const tierTargetUsd = (equityUsd: number, equityPct: number) => (equityUsd * equityPct) / 100;

function floorQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(qty * f + EPS) / f;
}

function ceilQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.ceil(qty * f - EPS) / f;
}

function roundQty(qty: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.round(qty * f) / f;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hyperliquid perps: a price may have at most this many decimals minus the asset's szDecimals. */
export const MAX_PERP_PRICE_DECIMALS = 6;

/**
 * IOC limit price for a market-style order. Used by hl-client, so sizing sees the exact price sent.
 * Hyperliquid accepts at most 5 significant figures AND at most 6 − szDecimals decimals
 * (e.g. 0.55407 is rejected for szDecimals 2). The decimal cut rounds away from mid
 * (buy up, sell down), so it never makes the order less likely to fill.
 */
export function limitPrice(mid: number, isBuy: boolean, szDecimals: number, slippagePct = SLIPPAGE_PCT): number {
  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  const px = parseFloat(rawPx.toPrecision(5));
  const decimals = Math.max(0, MAX_PERP_PRICE_DECIMALS - szDecimals);
  const f = 10 ** decimals;
  // Tolerance so a price already on the grid isn't pushed a tick by float error
  const ticks = isBuy ? Math.ceil(px * f - 1e-6) : Math.floor(px * f + 1e-6);
  if (!(ticks > 0)) {
    throw new Error(`Can't express a ${isBuy ? 'buy' : 'sell'} limit price near ${mid} with ${decimals} decimals (szDecimals ${szDecimals})`);
  }
  return Number((ticks / f).toFixed(decimals));
}

/** Lowest and highest price an order is assumed to fill at. */
export function fillPriceRange(mid: number, isBuy: boolean, szDecimals: number, slippagePct = SLIPPAGE_PCT) {
  const limitPx = limitPrice(mid, isBuy, szDecimals, slippagePct);
  // Rounding can push the limit slightly past mid × (1 ± s); take the wider side
  return isBuy
    ? { limitPx, lowPx: mid * (1 - slippagePct), highPx: Math.max(limitPx, mid * (1 + slippagePct)) }
    : { limitPx, lowPx: Math.min(limitPx, mid * (1 - slippagePct)), highPx: mid * (1 + slippagePct) };
}

export interface SizeResult {
  qty: string; // coin units, formatted to szDecimals
  notionalUsd: number; // qty × mid
  minFillNotionalUsd: number; // qty × lowest assumed fill price
  maxFillNotionalUsd: number; // qty × highest assumed fill price
  limitPx: number; // the price the order must be sent with
}

function result(qty: number, mid: number, szDecimals: number, px: ReturnType<typeof fillPriceRange>): SizeResult {
  return {
    qty: qty.toFixed(szDecimals),
    notionalUsd: round2(qty * mid),
    // Round outward so the reported range never understates the worst case
    minFillNotionalUsd: Math.floor(qty * px.lowPx * 100 + EPS) / 100,
    maxFillNotionalUsd: Math.ceil(qty * px.highPx * 100 - EPS) / 100,
    limitPx: px.limitPx,
  };
}

function assertPrice(mid: number, szDecimals: number) {
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error(`Invalid mid price: ${mid}`);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) throw new Error(`Invalid szDecimals: ${szDecimals}`);
}

/**
 * Size a new copied position: targetUsd clamped to [range.minUsd, range.maxUsd].
 * Any fill in the assumed price range lands within that band, or this throws.
 */
export function sizeInitial(
  targetUsd: number,
  range: Pick<CopyRange, 'minUsd' | 'maxUsd'>,
  mid: number,
  szDecimals: number,
  isBuy: boolean,
  slippagePct = SLIPPAGE_PCT,
): SizeResult {
  assertPrice(mid, szDecimals);
  const px = fillPriceRange(mid, isBuy, szDecimals, slippagePct);
  const { minUsd, maxUsd } = range;
  if (!(minUsd > 0) || !(maxUsd >= minUsd)) throw new Error(`Invalid size range: $${minUsd}-$${maxUsd}`);
  const lo = ceilQty(minUsd / px.lowPx, szDecimals);
  const hi = floorQty(maxUsd / px.highPx, szDecimals);
  if (lo > hi || hi <= 0) {
    throw new Error(
      `Cannot size within $${minUsd.toFixed(2)}-$${maxUsd.toFixed(2)} at worst-case fill: ` +
      `one size step (${10 ** -szDecimals} @ $${mid}, ±${slippagePct * 100}%) is too coarse`,
    );
  }
  const target = Math.min(Math.max(targetUsd, minUsd), maxUsd);
  const qty = Math.min(Math.max(roundQty(target / mid, szDecimals), lo), hi);
  return result(qty, mid, szDecimals, px);
}

export interface IncreaseResult extends SizeResult {
  capUsd: number; // 80% of current position notional
}

/**
 * Size an add to an existing position: min(targetUsd, 80% of current notional),
 * with the worst-case fill held under that amount. Rounded down. targetUsd is the
 * tier's % of equity, at most 15% of it (see trade-exec).
 */
export function sizeIncrease(
  targetUsd: number,
  currentNotionalUsd: number,
  mid: number,
  szDecimals: number,
  isBuy: boolean,
  slippagePct = SLIPPAGE_PCT,
): IncreaseResult {
  assertPrice(mid, szDecimals);
  if (!(currentNotionalUsd > 0)) throw new Error(`Invalid current position notional: ${currentNotionalUsd}`);
  const px = fillPriceRange(mid, isBuy, szDecimals, slippagePct);
  const capUsd = currentNotionalUsd * MAX_INCREASE_FRACTION;
  const addUsd = Math.min(targetUsd, capUsd);
  const qty = floorQty(addUsd / px.highPx, szDecimals);
  if (qty * px.lowPx < MIN_ORDER_NOTIONAL_USD - EPS) {
    throw new Error(
      `Increase too small: $${(qty * px.lowPx).toFixed(2)} at worst-case fill is below the ` +
      `$${MIN_ORDER_NOTIONAL_USD} minimum order (cap $${capUsd.toFixed(2)})`,
    );
  }
  return { ...result(qty, mid, szDecimals, px), capUsd: round2(capUsd) };
}

// --- Replicating the trader's entry and TP/SL prices ---

/**
 * The price a copy's open is sized and limited from. The trader filled at
 * `entryPrice`; we never pay more than SLIPPAGE_PCT worse than that. If the
 * market already moved further against us than that, the trader's entry can't
 * be replicated and this throws (a refused copy, not a chased one). If the
 * market is better than their entry, we use it as is.
 *   buy:  min(mid, entry) — limit ≤ entry × (1 + s)
 *   sell: max(mid, entry) — limit ≥ entry × (1 − s)
 */
export function entryBoundPx(mid: number, entryPrice: number, isBuy: boolean, slippagePct = SLIPPAGE_PCT): number {
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error(`Invalid mid price: ${mid}`);
  if (!(entryPrice > 0) || !Number.isFinite(entryPrice)) throw new Error(`Invalid trader entry price: ${entryPrice}`);
  const adverse = isBuy ? mid / entryPrice - 1 : 1 - mid / entryPrice;
  if (adverse > slippagePct + EPS) {
    throw new Error(
      `Price moved ${(adverse * 100).toFixed(2)}% against the trader's entry ($${entryPrice} → mid $${mid}), more than the ` +
      `${slippagePct * 100}% allowed — refusing rather than entering at a different price than the trader`,
    );
  }
  return isBuy ? Math.min(mid, entryPrice) : Math.max(mid, entryPrice);
}

/** Limit-price slippage on TP/SL trigger orders: what the Invo app uses (seen on its position TP/SL orders). */
export const TPSL_SLIPPAGE_PCT = 0.05;

/**
 * Throws unless `px` is a price Hyperliquid accepts as is for this asset (at most
 * 5 significant figures — integers always pass — and at most 6 − szDecimals
 * decimals). A trader's TP/SL is never rounded: a different trigger price is a
 * different TP/SL.
 */
export function assertExactPerpPrice(px: number, szDecimals: number, label: string): void {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`${label} ${px} is not a valid price`);
  const decimals = Math.max(0, MAX_PERP_PRICE_DECIMALS - szDecimals);
  const onDecimals = Number(px.toFixed(decimals)) === px;
  const onSigFigs = Number.isInteger(px) || parseFloat(px.toPrecision(5)) === px;
  if (!onDecimals || !onSigFigs) {
    throw new Error(`${label} ${px} can't be placed on Hyperliquid exactly (max 5 significant figures and ${decimals} decimals) — not rounding the trader's price`);
  }
}

/**
 * A TP/SL trigger must be on the right side of the current price, or Hyperliquid
 * would fire it at once (the trader's, still open, evidently hasn't).
 *   long:  tp > mid, sl < mid      short: tp < mid, sl > mid
 */
export function assertTriggerSide(which: 'tp' | 'sl', triggerPx: number, mid: number, isLong: boolean): void {
  const above = triggerPx > mid;
  const ok = (which === 'tp') === isLong ? above : triggerPx < mid;
  if (!ok) {
    throw new Error(
      `The trader's ${which === 'tp' ? 'take-profit' : 'stop-loss'} $${triggerPx} is already ${above ? 'above' : 'at or below'} the ` +
      `current price $${mid} for a ${isLong ? 'long' : 'short'} — it would trigger immediately; not replicated`,
    );
  }
}
