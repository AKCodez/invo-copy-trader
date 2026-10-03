import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPost,
  diffFollowed,
  fetchFollowing,
  fetchPortfolios,
  loadFollowedTraders,
  FOLLOWING_PAGE_SIZE,
  PORTFOLIO_PAGE_SIZE,
  type FollowingClient,
  type FollowedTrader,
} from './following.js';
import { FollowedTraderRegistry } from './followed-registry.js';

// Fake Invo client with the response shapes of the live endpoints:
//   GET  /users/get_user        → { success, error, user: { id, ... } }
//   POST /users/get_following   → { page, size, success, error, following: [...] }
//   POST /portfolios/v2/get_users_portfolios → { portfolios: [{ id, ownerId, ... }] }
const ME = 'me-0000';

function fakeClient(state: { following: { id: string; username: string; isPending?: boolean }[]; portfolios: Record<string, any[]> }) {
  const calls = { getCurrentUser: 0, getFollowing: [] as { userId: string; page: number; size: number }[], getUserPortfolios: [] as string[] };
  const client: FollowingClient & { calls: typeof calls; failFollowing?: boolean; failPortfoliosFor?: Set<string> } = {
    calls,
    async getCurrentUser() {
      calls.getCurrentUser++;
      return { success: true, error: null, user: { id: ME, username: 'me' } };
    },
    async getFollowing(userId, page, size) {
      calls.getFollowing.push({ userId, page, size });
      if (client.failFollowing) throw new Error('Invo /v1_0/users/get_following 500');
      const all = userId === ME ? state.following : [];
      return { page, size, success: true, error: null, following: all.slice((page - 1) * size, page * size) };
    },
    async getUserPortfolios(userId, page, size) {
      calls.getUserPortfolios.push(userId);
      if (client.failPortfoliosFor?.has(userId)) throw new Error('500');
      const all = state.portfolios[userId] ?? [];
      return { portfolios: all.slice((page - 1) * size, page * size) };
    },
  };
  return client;
}

const pf = (id: string, ownerId: string, extra: object = {}) => ({ id, ownerId, title: `P ${id}`, winRate: 90, ...extra });

// --- Fetching the following list ---

test('fetches the current account following list and resolves portfolios', async () => {
  const client = fakeClient({
    following: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
    portfolios: { u1: [pf('p1', 'u1'), pf('p1b', 'u1')], u2: [pf('p2', 'u2')] },
  });
  const traders = await loadFollowedTraders(client);
  assert.deepEqual(client.calls.getFollowing[0], { userId: ME, page: 1, size: FOLLOWING_PAGE_SIZE });
  assert.deepEqual(traders.map(t => [t.userId, t.username, t.portfolios.map(p => p.id)]), [
    ['u1', 'alice', ['p1', 'p1b']],
    ['u2', 'bob', ['p2']],
  ]);
});

test('paginates the following list until a short page', async () => {
  const following = Array.from({ length: FOLLOWING_PAGE_SIZE * 2 + 3 }, (_, i) => ({ id: `u${i}`, username: `n${i}` }));
  const client = fakeClient({ following, portfolios: {} });
  const users = await fetchFollowing(client, ME);
  assert.equal(users.length, following.length);
  assert.deepEqual(client.calls.getFollowing.map(c => c.page), [1, 2, 3]);
});

test('pending follow requests are not treated as follows', async () => {
  const client = fakeClient({ following: [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b', isPending: true }], portfolios: {} });
  assert.deepEqual((await fetchFollowing(client, ME)).map(u => u.id), ['u1']);
});

test('a failed or malformed following response throws (fail closed)', async () => {
  const client = fakeClient({ following: [], portfolios: {} });
  client.failFollowing = true;
  await assert.rejects(fetchFollowing(client, ME));

  const bad: FollowingClient = { ...client, async getFollowing() { return { success: false, error: { message: 'nope' } }; } };
  await assert.rejects(fetchFollowing(bad, ME), /get_following failed/);
  const noList: FollowingClient = { ...client, async getFollowing() { return { success: true, error: null }; } };
  await assert.rejects(fetchFollowing(noList, ME), /get_following failed/);
});

test('missing current user id throws', async () => {
  const client = fakeClient({ following: [], portfolios: {} });
  const noUser: FollowingClient = { ...client, async getCurrentUser() { return { success: false, user: null }; } };
  await assert.rejects(loadFollowedTraders(noUser), /Could not determine Invo user id/);
});

test('portfolios owned by someone else are dropped', async () => {
  const client = fakeClient({ following: [], portfolios: { u1: [pf('p1', 'u1'), pf('px', 'someone-else')] } });
  assert.deepEqual((await fetchPortfolios(client, 'u1')).map(p => p.id), ['p1']);
});

test('paginates portfolios until a short page', async () => {
  const many = Array.from({ length: PORTFOLIO_PAGE_SIZE + 2 }, (_, i) => pf(`p${i}`, 'u1'));
  const client = fakeClient({ following: [], portfolios: { u1: many } });
  assert.equal((await fetchPortfolios(client, 'u1')).length, many.length);
  assert.equal(client.calls.getUserPortfolios.length, 2);
});

test('portfolio pagination stops if the server repeats a page', async () => {
  const full = Array.from({ length: PORTFOLIO_PAGE_SIZE }, (_, i) => pf(`p${i}`, 'u1'));
  const client: FollowingClient = {
    async getCurrentUser() { return {}; },
    async getFollowing() { return {}; },
    async getUserPortfolios() { return { portfolios: full }; },
  };
  assert.equal((await fetchPortfolios(client, 'u1')).length, PORTFOLIO_PAGE_SIZE);
});

test('a malformed portfolios response throws', async () => {
  const client: FollowingClient = {
    async getCurrentUser() { return {}; },
    async getFollowing() { return {}; },
    async getUserPortfolios() { return { items: [] }; },
  };
  await assert.rejects(fetchPortfolios(client, 'u1'), /get_users_portfolios/);
});

test('a per-trader portfolio failure keeps the trader with no portfolios', async () => {
  const client = fakeClient({ following: [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }], portfolios: { u2: [pf('p2', 'u2')] } });
  client.failPortfoliosFor = new Set(['u1']);
  const traders = await loadFollowedTraders(client);
  assert.deepEqual(traders.map(t => [t.userId, t.portfolios.length]), [['u1', 0], ['u2', 1]]);
});

test('never calls follow or unfollow', async () => {
  const client: any = fakeClient({ following: [{ id: 'u1', username: 'a' }], portfolios: { u1: [pf('p1', 'u1')] } });
  client.followUser = () => assert.fail('followUser called');
  client.unfollowUser = () => assert.fail('unfollowUser called');
  const reg = new FollowedTraderRegistry(client, { refreshIntervalMs: 0 });
  await reg.refresh();
  await reg.refresh();
});

// --- Detecting follow/unfollow changes ---

test('diffFollowed reports added and removed traders', () => {
  const t = (userId: string): FollowedTrader => ({ userId, username: userId, portfolios: [] });
  const d = diffFollowed([t('a'), t('b')], [t('b'), t('c')]);
  assert.deepEqual(d.added.map(x => x.userId), ['c']);
  assert.deepEqual(d.removed.map(x => x.userId), ['a']);
});

test('registry refresh picks up follows and unfollows made on Invo', async () => {
  const state = { following: [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }], portfolios: { u1: [pf('p1', 'u1')], u2: [pf('p2', 'u2')], u3: [pf('p3', 'u3')] } };
  const client = fakeClient(state);
  const reg = new FollowedTraderRegistry(client, { refreshIntervalMs: 0 });

  const first = await reg.refresh();
  assert.deepEqual(first.added.map(x => x.userId), ['u1', 'u2']);
  const lookupsBefore = client.calls.getUserPortfolios.length;

  // User unfollows u1 and follows u3 in the Invo app
  state.following = [{ id: 'u2', username: 'b' }, { id: 'u3', username: 'c' }];
  const second = await reg.refresh();
  assert.deepEqual(second.added.map(x => x.userId), ['u3']);
  assert.deepEqual(second.removed.map(x => x.userId), ['u1']);
  assert.equal(reg.byUserId.has('u1'), false);
  assert.deepEqual(reg.byUserId.get('u3')?.portfolios.map(p => p.id), ['p3']);
  // Portfolios aren't re-fetched for traders already resolved
  assert.deepEqual(new Set(client.calls.getUserPortfolios.slice(lookupsBefore)), new Set(['u3']));
});

test('registry keeps the last list when a refresh fails', async () => {
  const client = fakeClient({ following: [{ id: 'u1', username: 'a' }], portfolios: { u1: [pf('p1', 'u1')] } });
  const reg = new FollowedTraderRegistry(client, { refreshIntervalMs: 0 });
  await reg.refresh();
  client.failFollowing = true;
  await assert.rejects(reg.refresh());
  assert.deepEqual([...reg.byUserId.keys()], ['u1']);
});

test('scheduled and on-demand refreshes are rate-limited', async () => {
  let now = 1_000_000;
  const client = fakeClient({ following: [{ id: 'u1', username: 'a' }], portfolios: { u1: [pf('p1', 'u1')] } });
  const reg = new FollowedTraderRegistry(client, { refreshIntervalMs: 60_000, minOnDemandMs: 15_000, now: () => now });
  await reg.refresh();
  assert.equal(await reg.refreshIfDue(), null);
  assert.equal(await reg.refreshOnDemand(), null);
  now += 15_000;
  assert.notEqual(await reg.refreshOnDemand(), null);
  now += 59_999;
  assert.equal(await reg.refreshIfDue(), null);
  now += 1;
  assert.notEqual(await reg.refreshIfDue(), null);
  assert.equal(client.calls.getFollowing.length, 3);
});

test('refreshPortfolios picks up a new portfolio for a followed trader', async () => {
  let now = 0;
  const state = { following: [{ id: 'u1', username: 'a' }], portfolios: { u1: [pf('p1', 'u1')] } as Record<string, any[]> };
  const reg = new FollowedTraderRegistry(fakeClient(state), { refreshIntervalMs: 60_000, minOnDemandMs: 15_000, now: () => now });
  await reg.refresh();
  state.portfolios.u1 = [pf('p1', 'u1'), pf('pNew', 'u1')];
  assert.equal(await reg.refreshPortfolios('u1'), false); // rate-limited
  now += 15_000;
  assert.equal(await reg.refreshPortfolios('u1'), true);
  assert.deepEqual(reg.byUserId.get('u1')?.portfolios.map(p => p.id), ['p1', 'pNew']);
  assert.equal(await reg.refreshPortfolios('not-followed'), false);
});

// --- Signal filtering ---

const followed = new Map<string, FollowedTrader>([
  ['u1', { userId: 'u1', username: 'alice', portfolios: [{ id: 'p1' }] }],
]);

function tradePost(over: { post?: any; update?: any } = {}) {
  return {
    id: 'post-1',
    repostId: null,
    owner: { id: 'u1', username: 'alice' },
    ...over.post,
    update: {
      id: 'upd-1',
      baseId: 'base-1',
      baseShortId: 'aB3xY9_kLm',
      ticker: 'SOL',
      verifiedTrade: true,
      owner: { id: 'u1', username: 'alice' },
      portfolio: { id: 'p1', title: 'Main' },
      isOpen: true,
      changes: { isAdded: false }, // a new trade, as on live posts
      closingPrice: null,
      ...over.update,
    },
  };
}

test('accepts a verified trade from a followed trader', () => {
  const v = classifyPost(tradePost(), followed);
  assert.equal(v.kind, 'accept');
  if (v.kind === 'accept') {
    assert.equal(v.trader!.userId, 'u1');
    assert.equal(v.portfolio!.id, 'p1');
    assert.equal(v.copied, false);
    assert.equal(v.action, 'open');
  }
});

test('rejects trades from traders not currently followed', () => {
  const v = classifyPost(tradePost({ post: { owner: { id: 'u9' } }, update: { owner: { id: 'u9' } } }), followed);
  assert.deepEqual(v, { kind: 'reject', reason: 'owner not in following list', ownerId: 'u9', portfolioId: 'p1' });
  // After an unfollow (empty list) the same post is rejected
  assert.equal(classifyPost(tradePost(), new Map()).kind, 'reject');
});

test('rejects unverified trades from followed traders', () => {
  for (const verifiedTrade of [false, undefined, 'true']) {
    const v = classifyPost(tradePost({ update: { verifiedTrade } }), followed);
    assert.equal(v.kind === 'reject' && v.reason, 'unverified trade');
  }
});

test('rejects reposts, owner mismatches and foreign portfolios', () => {
  const cases: [any, string][] = [
    [tradePost({ post: { repostId: 'r1' } }), 'repost'],
    [tradePost({ post: { owner: { id: 'u9' } } }), 'post owner differs from trade owner'],
    [tradePost({ update: { portfolio: { id: 'p-other' } } }), 'portfolio not owned by followed trader'],
    [tradePost({ update: { portfolio: null } }), 'trade has no portfolio'],
    [tradePost({ update: { owner: null } }), 'trade has no owner'],
  ];
  for (const [post, reason] of cases) {
    const v = classifyPost(post, followed);
    assert.equal(v.kind === 'reject' && v.reason, reason, reason);
  }
});

test('ignores non-trade posts', () => {
  assert.deepEqual(classifyPost({ id: 'x', update: null }, followed), { kind: 'ignore' });
  assert.deepEqual(classifyPost({ id: 'x', update: { ticker: null } }, followed), { kind: 'ignore' });
});

test('action rules: only a new trade (changes exactly { isAdded: false }) is an open; other changes are updates', () => {
  const action = (update: any) => {
    const v = classifyPost(tradePost({ update }), followed);
    return v.kind === 'accept' ? v.action : v.kind;
  };
  // changes holds previous values: a new trade "wasn't added before"
  assert.equal(action({ isOpen: true, changes: { isAdded: false } }), 'open');
  // Anything else on an open trade — shape of an add / partial close not seen live yet — never auto-copied
  assert.equal(action({ isOpen: true, changes: { isAdded: true } }), 'update');
  assert.equal(action({ isOpen: true, changes: { isAdded: false, entrySize: 2 } }), 'update');
  assert.equal(action({ isOpen: true, changes: { entrySize: 2 } }), 'update');
  assert.equal(action({ isOpen: true, changes: undefined }), 'update');
  assert.equal(action({ isOpen: true, changes: {} }), 'update');
  assert.equal(action({ isOpen: true, changes: [false] }), 'update');
  // Closed without a closing price is still a close, never a possible add
  assert.equal(action({ isOpen: false, closingPrice: null }), 'close');
  assert.equal(action({ isOpen: undefined, changes: { isAdded: false } }), 'update');
  assert.equal(action({ isOpen: false, closingPrice: 150 }), 'close');
});

test('a live new-trade post (WLD, captured 2026-10-02) is an open', () => {
  const owner = 'd7600f11-c38d-427f-b945-91c547e57d71';
  const portfolio = 'f392d602-4882-40bc-8198-6d681943284d';
  const live = new Map<string, FollowedTrader>([[owner, { userId: owner, username: 'nicush', portfolios: [{ id: portfolio }] }]]);
  const post = {
    id: '05acaefa-4555-433d-819b-af5e78d17942',
    repostId: null,
    createdAt: '2026-10-02T19:31:06.168Z',
    postTypeId: 'investment',
    owner: { id: owner, username: 'nicush' },
    update: {
      id: '92938146-664a-4615-90ec-439e6540abe7',
      owner: { id: owner, username: 'nicush' },
      portfolio: { id: portfolio, title: 'Kitchen' },
      baseId: '2db0d005-3dad-4d34-8471-d572877d8fee',
      baseShortId: 'PG3fbHjtd7',
      name: 'WLD',
      ticker: 'WLD',
      verifiedTrade: true,
      directionLong: true,
      leverage: 10,
      entryPrice: 0.54142,
      isOpen: true,
      closingPrice: null,
      changes: { isAdded: false },
      createdAt: '2026-10-02T19:30:52.339Z',
      updatedAt: '2026-10-02T19:30:52.339Z',
    },
  };
  const v = classifyPost(post, live);
  assert.equal(v.kind === 'accept' && v.action, 'open');
});

test('a close of a trade we copied gets through from someone no longer followed, a repost or an unknown portfolio', () => {
  const closed = { isOpen: false, closingPrice: 150 };
  const isCopied = (owner: string, baseId?: string) => owner === 'u9' && baseId === 'base-1';
  const posts = [
    tradePost({ post: { owner: { id: 'u9' } }, update: { ...closed, owner: { id: 'u9' } } }), // unfollowed
    tradePost({ post: { repostId: 'r1', owner: { id: 'u5' } }, update: { ...closed, owner: { id: 'u9' } } }), // repost
    tradePost({ post: { owner: { id: 'u9' } }, update: { ...closed, owner: { id: 'u9' }, verifiedTrade: false, portfolio: { id: 'p?' } } }),
  ];
  for (const post of posts) {
    const v = classifyPost(post, followed, isCopied);
    assert.equal(v.kind === 'accept' && v.action === 'close' && v.copied && v.trader, null);
  }
  // Not a copied trade (other trade id): still rejected
  const other = tradePost({ post: { owner: { id: 'u9' } }, update: { ...closed, owner: { id: 'u9' }, baseId: 'base-2' } });
  assert.equal(classifyPost(other, followed, isCopied).kind, 'reject');
  // Opens are never let through this way
  const open = tradePost({ post: { owner: { id: 'u9' } }, update: { owner: { id: 'u9' } } });
  assert.equal(classifyPost(open, followed, () => true).kind, 'reject');
});

test('rejects opens and updates missing the trader\'s trade ids', () => {
  for (const changes of [{ isAdded: true }, { isAdded: false }]) {
    const v = classifyPost(tradePost({ update: { changes, baseShortId: undefined } }), followed);
    assert.equal(v.kind === 'reject' && v.reason, 'trade is missing sourcePaperTradeBaseShortId');
  }
  const v = classifyPost(tradePost({ update: { id: null, baseId: '', baseShortId: '  ' } }), followed);
  assert.equal(v.kind === 'reject' && v.reason,
    'trade is missing initialSourcePaperUpdateId, sourcePaperTradeBaseId, sourcePaperTradeBaseShortId');
});

test('close signals are accepted without trade ids (close.ts works by coin)', () => {
  const v = classifyPost(tradePost({ update: { isOpen: false, closingPrice: 150, id: null, baseId: null, baseShortId: null } }), followed);
  assert.equal(v.kind === 'accept' && v.action, 'close');
});
