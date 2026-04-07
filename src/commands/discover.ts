import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

async function main() {
  const portfolioOwners = new Map<string, any>();

  // Scan trending + all filters
  for (const filter of ['trending', 'all']) {
    try {
      const data = await invo.discoverTraders(filter, 1, 50);
      for (const t of data.items ?? []) {
        if (!portfolioOwners.has(t.ownerId) || t.closedPositions > (portfolioOwners.get(t.ownerId)?.closedPositions ?? 0)) {
          portfolioOwners.set(t.ownerId, t);
        }
      }
    } catch (e: any) {
      console.error(`Scan ${filter} failed:`, e.message);
    }
  }

  // Scan feed for additional users
  const feedUsers = new Map<string, string>();
  let lastPostId: string | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      const data = await invo.getFeed('trending', lastPostId, 50);
      const items = data.items ?? [];
      if (items.length === 0) break;
      for (const p of items) {
        const owner = p.update?.owner ?? p.owner;
        if (owner?.id) feedUsers.set(owner.id, owner.username ?? owner.name ?? '');
        lastPostId = p.id;
      }
    } catch { break; }
  }

  // Enrich feed-only users
  let enriched = 0;
  for (const [userId] of feedUsers) {
    if (portfolioOwners.has(userId)) continue;
    try {
      const data = await invo.discoverTraders('user', 1, 10, userId);
      const items = data.items ?? [];
      const best = items.sort((a: any, b: any) => (b.closedPositions ?? 0) - (a.closedPositions ?? 0))[0];
      if (best) { portfolioOwners.set(userId, best); enriched++; }
    } catch {}
  }

  // Rank
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  const ranked = Array.from(portfolioOwners.values())
    .filter(t => {
      if ((t.closedPositions ?? 0) < 100) return false;
      if (t.createdAt) {
        const days = (now - new Date(t.createdAt).getTime()) / MS_PER_DAY;
        if (days < 90) return false;
      }
      if ((t.winRate ?? 0) < 75) return false;
      if ((t.percentChange ?? 0) < 500) return false;
      const wl = (t.lostPositions ?? 0) > 0 ? (t.wonPositions ?? 0) / t.lostPositions : (t.wonPositions ?? 0);
      if (wl < 3) return false;
      if (t.liquidated) return false;
      return true;
    })
    .map(t => {
      const days = t.createdAt ? Math.round((now - new Date(t.createdAt).getTime()) / MS_PER_DAY) : 0;
      const wl = (t.lostPositions ?? 0) > 0
        ? Math.round(((t.wonPositions ?? 0) / t.lostPositions) * 100) / 100
        : (t.wonPositions ?? 0);
      const score = Math.round((wl * 20 + (t.winRate ?? 0) * 1.5 + Math.min(t.percentChange ?? 0, 10000) * 0.01 + (t.currentWinStreak ?? 0) * 2 - (t.lostPositions ?? 0) * 0.5) * 100) / 100;

      return {
        portfolioId: t.id,
        ownerId: t.ownerId,
        username: t.owner?.username ?? 'unknown',
        winRate: Math.round((t.winRate ?? 0) * 100) / 100,
        pnl: Math.round((t.percentChange ?? 0) * 100) / 100,
        wlRatio: wl,
        daysActive: days,
        streak: t.currentWinStreak ?? 0,
        closed: t.closedPositions ?? 0,
        won: t.wonPositions ?? 0,
        lost: t.lostPositions ?? 0,
        followers: t.followerCount ?? 0,
        isFollowing: t.isFollowing ?? false,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  console.log(JSON.stringify({
    scanned: portfolioOwners.size,
    feedUsers: feedUsers.size,
    enriched,
    matched: ranked.length,
    traders: ranked,
  }));
}

main().catch(e => { console.error(e.message); process.exit(1); });
