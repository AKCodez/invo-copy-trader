// Look up the copied trader's portfolio stats for sizing (classifyTrader).
//
//   1. POST /v1_0/portfolios/v2/get_users_portfolios — confirms mimicMeta.portfolioId
//      is one of creatorInvoUserId's portfolios. This list lacks currentWinStreak,
//      percentChange and liquidated, so it can't be the stats source on its own.
//   2. POST /v1_0/portfolios/get_portfolio_by_id — full stats for that portfolio.
//
// (get_portfolios_pl with filter 'user' was used before, but it ignores userId and
// returns other owners' portfolios, so the lookup never matched.)
//
// Returns stats: null on any failure — classifyTrader treats that as the poor tier ($40).

import { fetchPortfolios } from './following.js';
import type { TraderStats } from './sizing.js';

export interface TraderStatsClient {
  getUserPortfolios(userId: string, page: number, size: number): Promise<any>;
  getPortfolioById(portfolioId: string): Promise<any>;
}

export interface TraderStatsLookup {
  stats: TraderStats | null;
  /** 'ok', or why stats are unavailable */
  status: string;
}

export async function getTraderStats(client: TraderStatsClient, mimicMeta: any): Promise<TraderStatsLookup> {
  const userId = mimicMeta?.creatorInvoUserId;
  const portfolioId = mimicMeta?.portfolioId;
  if (typeof userId !== 'string' || !userId || typeof portfolioId !== 'string' || !portfolioId) {
    return { stats: null, status: 'no mimicMeta portfolioId/creatorInvoUserId' };
  }

  try {
    const owned = await fetchPortfolios(client, userId);
    if (!owned.some(p => p.id === portfolioId)) {
      return { stats: null, status: 'portfolio not owned by creatorInvoUserId' };
    }

    const data = await client.getPortfolioById(portfolioId);
    const p = data?.portfolio;
    if (data?.success === false || data?.error || !p) {
      return { stats: null, status: `get_portfolio_by_id failed: ${JSON.stringify(data?.error ?? data)?.slice(0, 200)}` };
    }
    if (p.id !== portfolioId || p.ownerId !== userId) {
      return { stats: null, status: 'get_portfolio_by_id returned a different portfolio or owner' };
    }

    // Field names match TraderStats one-to-one; pass them through untouched
    const stats: TraderStats = {
      winRate: p.winRate ?? undefined,
      wonPositions: p.wonPositions ?? undefined,
      lostPositions: p.lostPositions ?? undefined,
      currentWinStreak: p.currentWinStreak ?? undefined,
      percentChange: p.percentChange ?? undefined,
      liquidated: p.liquidated ?? undefined,
    };
    return { stats, status: 'ok' };
  } catch (e: any) {
    return { stats: null, status: `lookup error: ${e?.message ?? e}` };
  }
}
