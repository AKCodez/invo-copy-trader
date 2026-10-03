import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTraderStats, type TraderStatsClient } from './trader-stats.js';
import { classifyTrader } from './sizing.js';

// Response shapes from the live endpoints:
//   get_users_portfolios → { portfolios: [{ id, ownerId, winRate, wonPositions, lostPositions, closedPositions, plSnapshot, ... }] }
//     (no currentWinStreak / percentChange / liquidated)
//   get_portfolio_by_id  → { success, error, portfolio: { id, ownerId, winRate, wonPositions, lostPositions,
//                            currentWinStreak, percentChange, liquidated, ... } }
const TRADER = 'u-trader';
const PID = 'p-main';
const meta = { portfolioId: PID, creatorInvoUserId: TRADER, initialSourcePaperUpdateId: 'x', sourcePaperTradeBaseId: 'y' };

const listItem = (id: string, ownerId = TRADER) => ({ id, ownerId, winRate: 92, wonPositions: 184, lostPositions: 16, closedPositions: 200, plSnapshot: 1200 });
const fullPortfolio = (over: object = {}) => ({
  id: PID, ownerId: TRADER, winRate: 92, wonPositions: 184, lostPositions: 16,
  currentWinStreak: 14, percentChange: 1200, liquidated: false, plSnapshot: 1200, ...over,
});

function fakeClient(opts: { lists?: Record<string, any[]>; byId?: Record<string, any>; failList?: boolean; failById?: boolean } = {}) {
  const calls = { list: [] as [string, number][], byId: [] as string[] };
  const lists = opts.lists ?? { [TRADER]: [listItem(PID), listItem('p-other')] };
  const byId = opts.byId ?? { [PID]: { success: true, error: null, portfolio: fullPortfolio() } };
  const client: TraderStatsClient & { calls: typeof calls } = {
    calls,
    async getUserPortfolios(userId, page, size) {
      calls.list.push([userId, page]);
      if (opts.failList) throw new Error('Invo get_users_portfolios 500');
      return { portfolios: (lists[userId] ?? []).slice((page - 1) * size, page * size) };
    },
    async getPortfolioById(portfolioId) {
      calls.byId.push(portfolioId);
      if (opts.failById) throw new Error('Invo get_portfolio_by_id 500');
      return byId[portfolioId] ?? { success: false, error: { message: 'Portfolio or Strategy not found' } };
    },
  };
  return client;
}

test('resolves the copied trader\'s portfolio and returns its full stats', async () => {
  const client = fakeClient();
  const r = await getTraderStats(client, meta);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.stats, {
    winRate: 92, wonPositions: 184, lostPositions: 16, currentWinStreak: 14, percentChange: 1200, liquidated: false,
  });
  assert.deepEqual(client.calls.list, [[TRADER, 1]]);
  assert.deepEqual(client.calls.byId, [PID]);
});

test('resolved stats drive the existing sizing tiers', async () => {
  const tierFor = async (over: object) =>
    classifyTrader((await getTraderStats(fakeClient({ byId: { [PID]: { success: true, portfolio: fullPortfolio(over) } } }), meta)).stats);

  assert.deepEqual([(await tierFor({})).tier, (await tierFor({})).equityPct], ['strong', 15]);
  assert.equal((await tierFor({ currentWinStreak: 7 })).equityPct, 10.4);
  assert.equal((await tierFor({ currentWinStreak: 3 })).equityPct, 7.8);
  assert.equal((await tierFor({ currentWinStreak: 0 })).tier, 'poor');
  assert.equal((await tierFor({ liquidated: true })).tier, 'poor');
  assert.equal((await tierFor({ percentChange: -3 })).tier, 'poor');
});

test('stats come from get_portfolio_by_id, not the list (which lacks streak/P&L)', async () => {
  // The list entry alone would classify as poor (incomplete stats)
  assert.equal(classifyTrader(listItem(PID)).tier, 'poor');
  const r = await getTraderStats(fakeClient(), meta);
  assert.equal(classifyTrader(r.stats).tier, 'strong');
});

test('a portfolio not owned by creatorInvoUserId gets no stats', async () => {
  const client = fakeClient({ lists: { [TRADER]: [listItem('p-other')] } });
  const r = await getTraderStats(client, meta);
  assert.deepEqual(r, { stats: null, status: 'portfolio not owned by creatorInvoUserId' });
  assert.deepEqual(client.calls.byId, []); // never fetched
});

test('list entries owned by someone else are not trusted', async () => {
  const r = await getTraderStats(fakeClient({ lists: { [TRADER]: [listItem(PID, 'someone-else')] } }), meta);
  assert.equal(r.stats, null);
});

test('finds the portfolio on a later page', async () => {
  const many = [...Array.from({ length: 20 }, (_, i) => listItem(`p${i}`)), listItem(PID)];
  const client = fakeClient({ lists: { [TRADER]: many } });
  const r = await getTraderStats(client, meta);
  assert.equal(r.status, 'ok');
  assert.deepEqual(client.calls.list, [[TRADER, 1], [TRADER, 2]]);
});

test('get_portfolio_by_id failures or mismatches give no stats', async () => {
  const cases: [any, RegExp][] = [
    [{ success: false, error: { message: 'Portfolio or Strategy not found' } }, /get_portfolio_by_id failed/],
    [{ success: true, error: null }, /get_portfolio_by_id failed/],
    [{ success: true, portfolio: fullPortfolio({ id: 'p-different' }) }, /different portfolio or owner/],
    [{ success: true, portfolio: fullPortfolio({ ownerId: 'someone-else' }) }, /different portfolio or owner/],
  ];
  for (const [resp, re] of cases) {
    const r = await getTraderStats(fakeClient({ byId: { [PID]: resp } }), meta);
    assert.equal(r.stats, null);
    assert.match(r.status, re);
  }
});

test('network errors give no stats instead of throwing', async () => {
  for (const o of [{ failList: true }, { failById: true }]) {
    const r = await getTraderStats(fakeClient(o), meta);
    assert.equal(r.stats, null);
    assert.match(r.status, /lookup error/);
  }
});

test('missing mimicMeta ids give no stats without any API call', async () => {
  for (const m of [null, undefined, {}, { portfolioId: PID }, { creatorInvoUserId: TRADER }, { portfolioId: '', creatorInvoUserId: TRADER }]) {
    const client = fakeClient();
    const r = await getTraderStats(client, m);
    assert.equal(r.stats, null);
    assert.equal(client.calls.list.length + client.calls.byId.length, 0);
    assert.equal(classifyTrader(r.stats).equityPct, 5);
  }
});

test('null stat fields stay missing, so sizing falls back to poor', async () => {
  const r = await getTraderStats(fakeClient({ byId: { [PID]: { success: true, portfolio: fullPortfolio({ currentWinStreak: null }) } } }), meta);
  assert.equal(r.status, 'ok');
  assert.equal(r.stats?.currentWinStreak, undefined);
  assert.equal(classifyTrader(r.stats).tier, 'poor');
});
