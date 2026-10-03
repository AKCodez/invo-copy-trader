// In-memory copy of the account's followed traders, refreshed from Invo on an
// interval. A refresh replaces the list wholesale, so unfollowed traders drop
// out and newly followed ones are added. Never follows or unfollows anyone.

import {
  type FollowingClient,
  type FollowedTrader,
  getMyUserId,
  fetchFollowing,
  fetchPortfolios,
  diffFollowed,
} from './following.js';

export interface RegistryOptions {
  refreshIntervalMs: number;
  /** Minimum gap between on-demand refreshes (unknown owner / portfolio in the feed). */
  minOnDemandMs?: number;
  now?: () => number;
}

export class FollowedTraderRegistry {
  traders: FollowedTrader[] = [];
  byUserId = new Map<string, FollowedTrader>();

  private myUserId: string | null = null;
  private lastRefresh = -Infinity;
  private lastPortfolioRefresh = new Map<string, number>();
  private readonly minOnDemandMs: number;
  private readonly now: () => number;

  constructor(private client: FollowingClient, private opts: RegistryOptions) {
    this.minOnDemandMs = opts.minOnDemandMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Re-fetch the following list. Portfolios are looked up only for newly
   * followed traders (and ones whose earlier lookup came back empty); existing
   * traders keep theirs. Throws — leaving the current list untouched — if the
   * following list can't be fetched.
   */
  async refresh() {
    this.myUserId ??= await getMyUserId(this.client);
    this.lastRefresh = this.now();
    const users = await fetchFollowing(this.client, this.myUserId);

    const next: FollowedTrader[] = [];
    for (const u of users) {
      const known = this.byUserId.get(u.id);
      let portfolios = known?.portfolios ?? [];
      if (portfolios.length === 0) {
        try {
          portfolios = await fetchPortfolios(this.client, u.id);
          this.lastPortfolioRefresh.set(u.id, this.now());
        } catch { /* retried on demand when they post */ }
      }
      next.push({ userId: u.id, username: u.username || known?.username || '', portfolios });
    }

    const diff = diffFollowed(this.traders, next);
    this.traders = next;
    this.byUserId = new Map(next.map(t => [t.userId, t]));
    for (const id of this.lastPortfolioRefresh.keys()) {
      if (!this.byUserId.has(id)) this.lastPortfolioRefresh.delete(id);
    }
    return diff;
  }

  /** Scheduled refresh: runs once the refresh interval has elapsed. */
  async refreshIfDue() {
    if (this.now() - this.lastRefresh < this.opts.refreshIntervalMs) return null;
    return this.refresh();
  }

  /** On-demand refresh (rate-limited), e.g. when the feed shows an unknown owner. */
  async refreshOnDemand() {
    if (this.now() - this.lastRefresh < this.minOnDemandMs) return null;
    return this.refresh();
  }

  /** Re-resolve one followed trader's portfolios (rate-limited per trader). */
  async refreshPortfolios(userId: string): Promise<boolean> {
    const trader = this.byUserId.get(userId);
    if (!trader) return false;
    if (this.now() - (this.lastPortfolioRefresh.get(userId) ?? -Infinity) < this.minOnDemandMs) return false;
    this.lastPortfolioRefresh.set(userId, this.now());
    trader.portfolios = await fetchPortfolios(this.client, userId);
    return true;
  }
}
