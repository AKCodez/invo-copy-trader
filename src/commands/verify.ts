import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as hl from '../hl-client.js';
import * as invo from '../invo-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function main() {
  const results: Record<string, any> = {};

  // 1. HL Meta (public)
  try {
    const meta = await hl.getMeta();
    const solIdx = meta.universe.findIndex(a => a.name === 'SOL');
    results.hlMeta = {
      status: 'ok',
      universeSize: meta.universe.length,
      solIndex: solIdx,
      solDecimals: meta.universe[solIdx]?.szDecimals,
    };
  } catch (e: any) {
    results.hlMeta = { status: 'error', message: e.message };
  }

  // 2. HL Mids (public)
  try {
    const mids = await hl.getAllMids();
    results.hlMids = {
      status: 'ok',
      totalAssets: Object.keys(mids).length,
      SOL: mids['SOL'],
      BTC: mids['BTC'],
      ETH: mids['ETH'],
    };
  } catch (e: any) {
    results.hlMids = { status: 'error', message: e.message };
  }

  // 3. HL Positions (public read)
  try {
    const positions = await hl.getPositions(WALLET_ADDRESS);
    results.hlPositions = {
      status: 'ok',
      count: positions.length,
      positions: positions.map((p: any) => ({ coin: p.coin, szi: p.szi, entryPx: p.entryPx })),
    };
  } catch (e: any) {
    results.hlPositions = { status: 'error', message: e.message };
  }

  // 4. HL SDK Connect (agent key auth)
  try {
    await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);
    results.hlConnect = { status: 'ok' };
  } catch (e: any) {
    results.hlConnect = { status: 'error', message: e.message };
  }

  // 5. Invo: Discover traders
  try {
    const data = await invo.discoverTraders('trending', 1, 5);
    const items = data.items ?? [];
    results.invoDiscover = {
      status: 'ok',
      itemCount: items.length,
      sample: items[0] ? { ownerId: items[0].ownerId, winRate: items[0].winRate, username: items[0].owner?.username } : null,
    };
  } catch (e: any) {
    results.invoDiscover = { status: 'error', message: e.message };
  }

  // 6. Invo: Feed
  try {
    const data = await invo.getFeed('trending', null, 5);
    const items = data.items ?? [];
    results.invoFeed = {
      status: 'ok',
      itemCount: items.length,
      firstPostId: items[0]?.id,
    };
  } catch (e: any) {
    results.invoFeed = { status: 'error', message: e.message };
  }

  // 7. Invo: Account ready
  try {
    const data = await invo.checkAccountReady();
    results.invoAccountReady = { status: 'ok', data };
  } catch (e: any) {
    results.invoAccountReady = { status: 'error', message: e.message };
  }

  // 8. Invo: Trending users
  try {
    const data = await invo.getTrendingUsers(1, 5);
    const items = data.items ?? [];
    results.invoTrendingUsers = {
      status: 'ok',
      itemCount: items.length,
    };
  } catch (e: any) {
    results.invoTrendingUsers = { status: 'error', message: e.message };
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
