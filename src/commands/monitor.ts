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
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: monitor <watchEntriesJson>');
    console.error('  [{"baseShortId":"x","mimicStartedAt":"2024-01-01T00:00:00Z"}]');
    console.error('  OR portfolio IDs: ["id1","id2"]');
    process.exit(1);
  }

  const parsed = JSON.parse(arg);
  const isWatchEntries = Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.baseShortId;

  const seenPosts = new Set<string>();
  const seenUpdates = new Set<string>();
  let pollCount = 0;

  const TRADE_INTERVAL = 5_000;
  const FEED_INTERVAL = 15_000;
  let lastFeedPoll = 0;

  const poll = async () => {
    pollCount++;

    // Poll /dex/trade if we have watch entries
    if (isWatchEntries) {
      try {
        const data = await invo.getTradeUpdates(parsed as WatchEntry[]);
        const items = (data as any).investments ?? (data as any).items ?? [];
        for (const item of items) {
          const key = `${item.baseShortId ?? item.id}_${item.lastUpdate ?? ''}`;
          if (!seenUpdates.has(key)) {
            seenUpdates.add(key);
            console.log(JSON.stringify({ type: 'trade_update', poll: pollCount, data: item }));
          }
        }
      } catch (e: any) {
        console.error(JSON.stringify({ type: 'error', source: 'trade', message: e.message }));
      }
    }

    // Poll feed less frequently
    const now = Date.now();
    if (now - lastFeedPoll >= FEED_INTERVAL) {
      lastFeedPoll = now;
      try {
        const data = await invo.getFeed('following', null, 20);
        const items = data.items ?? [];
        for (const post of items) {
          if (!seenPosts.has(post.id)) {
            seenPosts.add(post.id);
            const update = post.update;
            if (update?.type === 'trade' || update?.type === 'open' || update?.type === 'close') {
              console.log(JSON.stringify({
                type: 'signal',
                poll: pollCount,
                postId: post.id,
                owner: update.owner ?? post.owner,
                trade: {
                  action: update.type,
                  coin: update.coin ?? update.asset,
                  side: update.side,
                  leverage: update.leverage,
                  size: update.size ?? update.qty,
                  price: update.price ?? update.entryPrice,
                  portfolioId: update.portfolioId,
                },
              }));
            }
          }
        }
      } catch (e: any) {
        console.error(JSON.stringify({ type: 'error', source: 'feed', message: e.message }));
      }
    }
  };

  console.log(JSON.stringify({
    type: 'started',
    mode: isWatchEntries ? 'trade_poll' : 'feed_only',
    entries: parsed.length,
  }));

  while (true) {
    await poll();
    await new Promise(r => setTimeout(r, TRADE_INTERVAL));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
