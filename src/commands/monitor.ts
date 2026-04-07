import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

interface WatchEntry {
  baseShortId: string;
  mimicStartedAt: string;
}

async function main() {
  const args = process.argv.slice(2);
  const waitMode = args.includes('--wait-for-signal');
  const jsonArgs = args.filter(a => a.startsWith('['));

  if (jsonArgs.length === 0) {
    console.error('Usage: monitor [--wait-for-signal] <portfolioIds> [watchEntries]');
    console.error('  Portfolio IDs: \'["id1","id2"]\'');
    console.error('  Watch entries: \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'');
    console.error('  Both:          \'["id1"]\'  \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'');
    console.error('');
    console.error('Modes:');
    console.error('  default:             Run forever, print all signals as JSON lines');
    console.error('  --wait-for-signal:   Exit after first signal (for agent auto-notify)');
    process.exit(1);
  }

  // Parse all JSON args — separate portfolio IDs (strings) from watch entries (objects)
  let portfolioIds: string[] = [];
  let watchEntries: WatchEntry[] = [];
  for (const arg of jsonArgs) {
    const arr = JSON.parse(arg);
    if (Array.isArray(arr) && arr.length > 0) {
      if (typeof arr[0] === 'string') portfolioIds = portfolioIds.concat(arr);
      else if (arr[0]?.baseShortId) watchEntries = watchEntries.concat(arr);
    }
  }

  const isWatchEntries = watchEntries.length > 0;
  const parsed = isWatchEntries ? watchEntries : portfolioIds;

  const seenPosts = new Set<string>();
  const seenUpdates = new Set<string>();
  let pollCount = 0;
  let isFirstFeedPoll = true;

  const TRADE_INTERVAL = 5_000;
  const FEED_INTERVAL = 5_000; // 5s for faster signal detection

  const poll = async (): Promise<boolean> => {
    pollCount++;
    let signalFound = false;

    // Poll /dex/trade if we have watch entries
    if (isWatchEntries) {
      try {
        const data = await invo.getTradeUpdates(watchEntries);
        const items = (data as any).investments ?? (data as any).items ?? [];
        for (const item of items) {
          const key = `${item.baseShortId ?? item.id}_${item.lastUpdate ?? ''}`;
          if (!seenUpdates.has(key)) {
            seenUpdates.add(key);
            console.log(JSON.stringify({ type: 'trade_update', poll: pollCount, data: item }));
            signalFound = true;
          }
        }
      } catch (e: any) {
        console.error(JSON.stringify({ type: 'error', source: 'trade', message: e.message }));
      }
    }

    // Poll feed for trade signals from followed traders
    try {
      const data = await invo.getFeed('following', null, 20);
      const posts = data.items ?? [];
      for (const post of posts) {
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);

        // Skip non-trade posts (photos, text, etc.)
        const update = post.update;
        if (!update || !update.ticker) continue;

        // Skip first poll results (existing posts, not new signals)
        if (isFirstFeedPoll) continue;

        // Only process verified trades
        if (!update.verifiedTrade) continue;

        const isOpen = update.isOpen === true;
        const isClosed = update.isOpen === false && update.closingPrice != null;
        const isIncrease = update.changes?.isAdded === false && isOpen;

        let action: string;
        if (isClosed) action = 'close';
        else if (update.changes?.isAdded !== false) action = 'open';
        else action = 'increase';

        console.log(JSON.stringify({
          type: 'signal',
          poll: pollCount,
          postId: post.id,
          action,
          owner: {
            id: update.owner?.id ?? post.owner?.id,
            username: update.owner?.username ?? post.owner?.username,
          },
          trade: {
            coin: update.ticker,
            name: update.name,
            side: update.directionLong ? 'long' : 'short',
            leverage: update.leverage,
            entryPrice: update.entryPrice,
            closingPrice: update.closingPrice ?? null,
            entrySize: update.entrySize,
            isOpen,
          },
          portfolio: {
            id: update.portfolio?.id,
            title: update.portfolio?.title,
            winRate: update.portfolio?.winRate,
            closedPositions: update.portfolio?.closedPositionsCount,
            openPositions: update.portfolio?.openPositionsCount,
            pnl: update.portfolio?.plSnapshot,
          },
          mimicMeta: {
            portfolioId: update.portfolio?.id,
            creatorInvoUserId: update.owner?.id ?? post.owner?.id,
            baseId: update.baseId,
            baseShortId: update.baseShortId,
          },
        }));
        signalFound = true;
      }

      if (isFirstFeedPoll) {
        isFirstFeedPoll = false;
      }
    } catch (e: any) {
      console.error(JSON.stringify({ type: 'error', source: 'feed', message: e.message }));
    }

    return signalFound;
  };

  const mode = isWatchEntries && portfolioIds.length > 0 ? 'trade_poll+feed'
    : isWatchEntries ? 'trade_poll'
    : 'feed_only';
  console.log(JSON.stringify({
    type: 'started',
    mode,
    waitForSignal: waitMode,
    watchEntries: watchEntries.length,
    portfolioIds: portfolioIds.length,
  }));

  // First poll: index existing posts so we only react to new ones
  await poll();

  while (true) {
    await new Promise(r => setTimeout(r, FEED_INTERVAL));
    const found = await poll();

    if (waitMode && found) {
      process.exit(0);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
