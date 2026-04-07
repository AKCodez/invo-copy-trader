import { Hyperliquid } from 'hyperliquid';

const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };

// SDK expects "SOL-PERP" format; REST API uses "SOL"
function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;

export async function connect(agentKey: string, walletAddress: string): Promise<Hyperliquid> {
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    enableWs: false,
  });
  await sdk.connect();
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
    body: JSON.stringify({ type: 'meta' }),
  });
  return (await resp.json()) as { universe: { name: string; szDecimals: number; maxLeverage: number }[] };
}

export async function getAllMids(): Promise<Record<string, string>> {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  });
  return await resp.json();
}

export async function getPositions(wallet: string) {
  const resp = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: wallet }),
  });
  const data = await resp.json();
  return data.assetPositions
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage);
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct = 0.02,
) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);

  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  const limitPx = parseFloat(rawPx.toPrecision(5)).toString();

  const s = getSdk();
  return s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: parseFloat(limitPx),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
    grouping: 'na',
    builder: INVO_BUILDER,
  });
}

export async function closePosition(coin: string, wallet: string) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const size = Math.abs(parseFloat(pos.szi));
  const isLong = parseFloat(pos.szi) > 0;

  // Close = opposite direction
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02);
}

export { INVO_BUILDER };
