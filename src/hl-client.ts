import { Hyperliquid } from 'hyperliquid';
import { limitPrice, TPSL_SLIPPAGE_PCT } from './sizing.js';
import { timeoutSignal, withTimeout } from './timeout.js';

const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };

// SDK expects "SOL-PERP" format; REST API uses "SOL"
function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;

/**
 * The SDK (1.7.x) sends a signed `setReferrer` action (code "PLACEHOLDER") on its own the
 * first time any exchange call resolves a coin (exchange.getAssetIndex → setTimeout →
 * setReferrer()), guarded by a private once-flag `_i`. That's an exchange write nobody asked
 * for, so it is switched off before anything is sent: the flag is set (never scheduled) and
 * setReferrer itself throws. Fails closed if the SDK's shape isn't what this expects.
 */
export function disableSdkReferrer(s: Hyperliquid): void {
  const ex = (s as any).exchange;
  if (!ex || typeof ex.setReferrer !== 'function' || typeof ex.getAssetIndex !== 'function' || !('_i' in ex)) {
    throw new Error('Hyperliquid SDK shape changed — refusing to connect until the automatic setReferrer call is re-checked (see hl-client.ts)');
  }
  ex._i = 1;
  ex.setReferrer = () => {
    throw new Error('setReferrer is disabled: this tool never changes the account referrer');
  };
}

export async function connect(agentKey: string, walletAddress: string): Promise<Hyperliquid> {
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    enableWs: false,
  });
  disableSdkReferrer(sdk);
  await withTimeout(sdk.connect(), 'Hyperliquid connect');
  return sdk;
}

export function getSdk(): Hyperliquid {
  if (!sdk) throw new Error('HL SDK not connected. Call connect() first.');
  return sdk;
}

export async function getMeta() {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'meta' }),
  });
  return (await resp.json()) as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
}

export async function getAllMids(): Promise<Record<string, string>> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'allMids' }),
  });
  return await resp.json();
}

/** Open positions, as clearinghouseState reports them (incl. coin, szi, leverage: { type, value }). */
export async function getPositions(wallet: string): Promise<{ coin: string; szi: string; leverage?: { type?: string; value?: number } }[]> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
  });
  const data = await resp.json();
  return data.assetPositions
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

/**
 * The account's Hyperliquid equity in USD: clearinghouseState marginSummary.accountValue
 * (collateral plus unrealized P&L across cross and isolated positions). Throws on
 * anything it can't read, so sizing fails closed.
 */
export async function getAccountEquity(wallet: string): Promise<number> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
  });
  if (!resp.ok) throw new Error(`clearinghouseState: HTTP ${resp.status}`);
  const data: any = await resp.json();
  const equity = parseFloat(data?.marginSummary?.accountValue);
  if (!Number.isFinite(equity)) {
    throw new Error(`clearinghouseState: no readable marginSummary.accountValue (${JSON.stringify(data?.marginSummary)?.slice(0, 200)})`);
  }
  return equity;
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return withTimeout(s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage), `updateLeverage ${coin}`);
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct: number,
  midPx: number, // the price the size was computed from
  szDecimals: number, // the asset's, so the limit price meets HL's decimal rule
  reduceOnly: boolean, // closes pass true: the order can only shrink the position, never flip it
  cloid?: string, // client order id, so the order can be looked up if we lose its response
) {
  if (!(midPx > 0)) throw new Error(`No mid price for ${coin}`);

  // Same function sizing.ts bounds fills against
  const limitPx = limitPrice(midPx, isBuy, szDecimals, slippagePct).toString();

  const s = getSdk();
  return withTimeout(s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: parseFloat(limitPx),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: reduceOnly,
    grouping: 'na',
    builder: INVO_BUILDER,
    ...(cloid && { cloid }),
  }), `placeOrder ${coin}`);
}

/**
 * How much an order filled, looked up by its client order id (info `orderStatus`).
 * known: false when HL has no such order — it never reached the exchange.
 * Throws on anything it can't read, so callers fail closed.
 */
export async function getOrderFill(wallet: string, cloid: string): Promise<{ known: boolean; filledQty: number }> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'orderStatus', user: wallet, oid: cloid }),
  });
  if (!resp.ok) throw new Error(`orderStatus ${cloid}: HTTP ${resp.status}`);
  const data: any = await resp.json();
  if (data?.status === 'unknownOid') return { known: false, filledQty: 0 };
  // { status: 'order', order: { order: { origSz, sz (unfilled remainder), ... }, status } }
  const origSz = parseFloat(data?.order?.order?.origSz);
  const left = parseFloat(data?.order?.order?.sz);
  if (data?.status !== 'order' || !Number.isFinite(origSz) || !Number.isFinite(left)) {
    throw new Error(`orderStatus ${cloid}: unrecognised response ${JSON.stringify(data)?.slice(0, 200)}`);
  }
  return { known: true, filledQty: Math.max(0, origSz - left) };
}

/** An open order as frontendOpenOrders reports it (fields we use). */
export interface HlOpenOrder {
  coin: string;
  side: string;
  oid: number;
  cloid?: string | null;
  isTrigger?: boolean;
  isPositionTpsl?: boolean;
  reduceOnly?: boolean;
  orderType?: string;
  triggerPx?: string;
}

/** Every open order on the account (incl. TP/SL triggers). Throws on anything unreadable. */
export async function getOpenOrders(wallet: string): Promise<HlOpenOrder[]> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...timeoutSignal(),
    body: JSON.stringify({ type: 'frontendOpenOrders', user: wallet }),
  });
  if (!resp.ok) throw new Error(`frontendOpenOrders: HTTP ${resp.status}`);
  const data: any = await resp.json();
  if (!Array.isArray(data)) throw new Error(`frontendOpenOrders: unrecognised response ${JSON.stringify(data)?.slice(0, 200)}`);
  return data;
}

/**
 * A position take-profit / stop-loss, placed the way the Invo app places them
 * (seen in this wallet's order history): a reduce-only trigger market order with
 * grouping positionTpsl and size 0, so it covers the whole coin position as it
 * grows or shrinks and Hyperliquid cancels it when the position closes. The
 * limit is the trigger ± 5%, like the app's.
 */
export async function placePositionTpsl(
  coin: string,
  isLong: boolean, // the position's side; the trigger order is the opposite side
  which: 'tp' | 'sl',
  triggerPx: number, // exact — callers check it is a valid HL price (assertExactPerpPrice)
  szDecimals: number,
  cloid: string,
) {
  const isBuy = !isLong;
  const limitPx = limitPrice(triggerPx, isBuy, szDecimals, TPSL_SLIPPAGE_PCT);
  const s = getSdk();
  return withTimeout(s.exchange.placeOrder({
    orders: [{
      coin: toSdkCoin(coin),
      is_buy: isBuy,
      sz: 0,
      limit_px: limitPx,
      order_type: { trigger: { triggerPx, isMarket: true, tpsl: which } },
      reduce_only: true,
      cloid,
    }],
    grouping: 'positionTpsl',
    builder: INVO_BUILDER,
  }), `place ${which} ${coin}`);
}

export async function cancelByCloid(coin: string, cloid: string) {
  const s = getSdk();
  return withTimeout(s.exchange.cancelOrderByCloid(toSdkCoin(coin), cloid), `cancel ${cloid} ${coin}`);
}

export { INVO_BUILDER };
