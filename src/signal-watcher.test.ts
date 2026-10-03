import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalWatcher, DEFAULT_CLOSE_RETRY_SEC, type MonitorState, type StateStore, type WatchEntry } from './signal-watcher.js';
import { MIN_SETTLE_AGE_MS } from './pending-orders.js';
import { parseTradeSignal } from './trade-signal.js';
import type { FollowedTrader } from './following.js';
import type { CopyEntry } from './copy-ledger.js';
import { copyEntry, notionalFor } from './test-fakes.js';

// --- Fakes: nothing here touches the network or disk ---

class MemoryState implements StateStore {
  state: MonitorState | null = null;
  corrupt = false;
  load() {
    if (this.corrupt) throw new Error('Unexpected token');
    return this.state && structuredClone(this.state);
  }
  save(s: MonitorState) { this.state = structuredClone(s); }
}

let postSeq = 0;
/** The test clock: what the watcher sees as now, and when post() posts are made. */
let clock = 1_000_000;
/** A trade post by `owner` on trade `trade` (baseId base-<trade>, baseShortId short-<trade>), made now. */
function post(owner: string, trade: string, kind: 'open' | 'update' | 'close' = 'open', extra: { post?: object; update?: object } = {}) {
  const id = `post-${++postSeq}`;
  return {
    id,
    repostId: null,
    createdAt: new Date(clock).toISOString(),
    owner: { id: owner, username: owner },
    ...extra.post,
    update: {
      id: `upd-${id}`,
      baseId: `base-${trade}`,
      baseShortId: `short-${trade}`,
      ticker: 'SOL',
      verifiedTrade: true,
      owner: { id: owner, username: owner },
      portfolio: { id: `p-${owner}` },
      isOpen: kind !== 'close',
      closingPrice: kind === 'close' ? 150 : null,
      // Live shapes (2026-10-02): changes holds the previous values of what changed.
      // A new trade is exactly { isAdded: false }; a close { isOpen: true, reasonClosed: null }.
      // An update's shape hasn't been seen live; any other changes object is an ambiguous update.
      changes: kind === 'open' ? { isAdded: false } : kind === 'close' ? { isOpen: true, reasonClosed: null } : { entrySize: 2.5 },
      ...extra.update,
    },
  };
}

/**
 * A /dex/trade entry in the live shape (captured 2026-10-02) for `owner`'s trade `trade`.
 * There is no isOpen: a close is an update with updateType "close".
 */
function dexTrade(owner: string, trade: string, updates: { updateType: string; updatedAt?: string; investmentId?: string; details?: object }[]) {
  return {
    creatorAppUserId: owner,
    portfolioId: `p-${owner}`,
    investmentBaseId: `base-${trade}`,
    investmentBaseShortId: `short-${trade}`,
    unmimickedCount: updates.length,
    unseenCount: updates.length,
    updates: updates.map((u, i) => ({
      investmentId: u.investmentId ?? `inv-${trade}-${i}`,
      investmentBaseId: `base-${trade}`,
      isSeen: false,
      updatedAt: u.updatedAt ?? '2026-10-02T14:31:15.806Z',
      updateType: u.updateType,
      isMimicked: false,
      details: u.details ?? {},
    })),
  };
}

/**
 * The feed post Invo makes for a change to `owner`'s trade `trade` (update.id = the
 * change's investmentId), carrying its $ figures like live ones (see notionalFor).
 */
function changePost(owner: string, trade: string, investmentId: string, kind: 'increase' | 'decrease', ratio: number, extra: { post?: object } = {}) {
  const n = notionalFor(kind, ratio, investmentId);
  return post(owner, trade, 'update', {
    post: extra.post,
    update: {
      id: investmentId,
      entrySim: n.entrySimAfter,
      entryPrice: n.entryPriceAfter,
      changes: {
        entrySim: n.entrySimBefore, simDifference: n.simDifference, simIncrease: n.simIncrease,
        ...(n.entryPriceBefore !== null && { entryPrice: n.entryPriceBefore }), livePriceAtChange: n.livePriceAtChange,
      },
    },
  });
}
/** stdout change_not_replicated alerts. */
const alerts = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'change_not_replicated').map(e => ({ ...(e.data as any), endsWait: e.signal === true, stream: e.stream }));
const changeSignals = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'signal' && ['increase', 'decrease', 'tpsl'].includes((e.data as any).action)).map(e => e.data as any);

// Live /investment/status shapes (captured 2026-10-03)
const STATUS_OPEN = { status: { isOpen: true, exists: true }, success: true };
const STATUS_CLOSED = { status: { isOpen: false, exists: true }, success: true };

/** Feed newest-first; `lastPostId` pages to older posts (or is ignored, like a broken cursor). */
function fakeInvo(opts: { ignoreCursor?: boolean } = {}) {
  const feed: any[] = [];
  /** /dex/trade `data` entries (see dexTrade); `rawTradeResponse` replaces the whole response. */
  const trades: any[] = [];
  /** /investment/status responses by baseId (a function may throw); none → an error, like an unknown id. */
  const statuses = new Map<string, unknown>();
  const calls = { getFeed: [] as (string | null)[], getTradeUpdates: [] as WatchEntry[][], getInvestmentStatus: [] as string[] };
  return {
    feed, trades, calls, statuses,
    rawTradeResponse: undefined as unknown,
    publish(...posts: any[]) { feed.unshift(...posts.reverse()); },
    async getFeed(_filter: string, lastPostId: string | null, itemLimit: number) {
      calls.getFeed.push(lastPostId);
      const start = lastPostId && !opts.ignoreCursor ? feed.findIndex(p => p.id === lastPostId) + 1 : 0;
      return { items: feed.slice(start, start + itemLimit) };
    },
    async getTradeUpdates(investments: WatchEntry[]) {
      calls.getTradeUpdates.push(investments);
      return this.rawTradeResponse ?? { success: true, data: trades };
    },
    async getInvestmentStatus(baseId: string) {
      calls.getInvestmentStatus.push(baseId);
      const r = statuses.get(baseId);
      if (typeof r === 'function') return r();
      return r ?? { status: 'error', statusCode: 500, message: 'Base ID must be a valid UUID' };
    },
  };
}

function fakeRegistry(userIds: string[]) {
  const traders: FollowedTrader[] = userIds.map(u => ({ userId: u, username: u, portfolios: [{ id: `p-${u}` }] }));
  return {
    traders,
    byUserId: new Map(traders.map(t => [t.userId, t])),
    async refreshIfDue() { return null; },
    async refreshOnDemand() { return null; },
    async refreshPortfolios() { return false; },
  };
}

function setup(opts: { following?: string[]; ledger?: CopyEntry[]; state?: MemoryState; invo?: ReturnType<typeof fakeInvo>; pageSize?: number; maxPages?: number } = {}) {
  clock = 1_000_000;
  const invo = opts.invo ?? fakeInvo();
  const state = opts.state ?? new MemoryState();
  const ledgerEntries = opts.ledger ?? [];
  const make = () => new SignalWatcher({
    invo,
    registry: fakeRegistry(opts.following ?? ['alice', 'bob']),
    ledger: { load: () => ledgerEntries },
    state,
    now: () => clock,
    maxCatchUpMs: 300_000,
    pageSize: opts.pageSize ?? 20,
    maxPages: opts.maxPages ?? 5,
  });
  return { invo, state, make, advance: (ms: number) => { clock += ms; } };
}

const signals = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'signal').map(e => e.data as any);
const skipped = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'skipped').map(e => e.data as any);

// --- Restarts ---

test('first ever run indexes the feed without emitting; later posts are signals', async () => {
  const { invo, make } = setup();
  invo.publish(post('alice', 't0'));
  const w = make();
  assert.deepEqual(signals(await w.poll()), []);
  invo.publish(post('alice', 't1'));
  const s = signals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.mimicMeta.sourcePaperTradeBaseId, x.catchUp]), [['open', 'base-t1', undefined]]);
});

test('an open\'s side comes only from a boolean directionLong; missing or unreadable is left out and trade.ts refuses it', async () => {
  const { invo, make } = setup();
  const w = make();
  await w.poll(); // first run: index
  const cases: [unknown, string | undefined][] = [[true, 'long'], [false, 'short'], [undefined, undefined], [null, undefined], ['true', undefined], [1, undefined]];
  for (const [directionLong, want] of cases) {
    // A complete open apart from the side, so only the side can make trade.ts refuse it
    const p = post('alice', `t-${String(directionLong)}`, 'open', { update: { leverage: 5, entryPrice: 150, priceTarget: null, stopLoss: null } });
    if (directionLong !== undefined) (p.update as any).directionLong = directionLong;
    invo.publish(p);
    const [sig] = signals(await w.poll());
    assert.equal(sig.action, 'open', String(directionLong));
    assert.equal(sig.trade.side, want, `directionLong ${JSON.stringify(directionLong)}`);
    if (want === undefined) {
      assert.ok(!('side' in sig.trade), `directionLong ${JSON.stringify(directionLong)}: no side key`);
      assert.throws(() => parseTradeSignal(JSON.stringify(sig)), /trade\.side must be "long" or "short"/);
    }
  }
});

test('a restart catches up on posts made while stopped (the --wait-for-signal gap)', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-b', 'SOL', 0.3, 'bob', 't2')] });
  invo.publish(post('alice', 't0'));
  await make().poll(); // first run: index
  invo.publish(post('alice', 't1'), post('bob', 't2', 'close'));
  advance(60_000); // the agent took a minute before relaunching

  const s = signals(await make().poll());
  assert.deepEqual(s.map(x => [x.owner.id, x.action, x.catchUp]).sort(), [['alice', 'open', true], ['bob', 'close', true]]);
});

test('after a long stop, missed opens are skipped as too old but missed closes are still emitted', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-b', 'SOL', 0.3, 'bob', 't3')] });
  await make().poll();
  invo.publish(post('alice', 't1'), post('bob', 't2', 'update'), post('bob', 't3', 'close'));
  advance(3_600_000);

  const events = await make().poll();
  assert.deepEqual(signals(events).map(x => [x.owner.id, x.action]), [['bob', 'close']]);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), [
    'open posted 3600s ago — too old to copy',
    'update posted 3600s ago — too old to copy',
  ]);
});

test('a stop longer than --max-catchup skips missed opens even if the posts look recent', async () => {
  const { invo, make, advance } = setup();
  await make().poll();
  advance(400_000);
  invo.publish(post('alice', 't1')); // made just now, but the monitor was down 400s
  assert.deepEqual(skipped(await make().poll()).map(x => x.reason), ['missed while the monitor was stopped (400s) — too old to copy']);
});

// --- Post age ---

test('older posts showing up in the feed (e.g. a newly followed trader) are not copied', async () => {
  const { invo, make, advance } = setup();
  const w = make();
  await w.poll();
  const old = post('alice', 't1'); // made at the start...
  advance(3_600_000);
  invo.publish(old, post('alice', 't2')); // ...but only appears in the feed an hour later
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => x.mimicMeta.sourcePaperTradeBaseId), ['base-t2']);
  assert.deepEqual(skipped(events).map(x => x.reason), ['open posted 3600s ago — too old to copy']);
});

test('opens and updates without a readable createdAt are not copied; closes still are', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't3')] });
  const w = make();
  await w.poll();
  invo.publish(
    post('alice', 't1', 'open', { post: { createdAt: undefined } }),
    post('alice', 't2', 'update', { post: { createdAt: 'yesterday-ish' } }),
    post('alice', 't3', 'close', { post: { createdAt: undefined } }),
  );
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => x.action), ['close']);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), [
    'open post has no createdAt — can\'t tell how old it is, not copying',
    'update post has no createdAt — can\'t tell how old it is, not copying',
  ]);
});

test('posts already handled before a restart are not emitted again', async () => {
  const { invo, make } = setup();
  await make().poll();
  invo.publish(post('alice', 't1'));
  assert.equal(signals(await make().poll()).length, 1);
  assert.equal(signals(await make().poll()).length, 0);
});

test('unreadable state: a notice, then a fresh start', async () => {
  const state = new MemoryState();
  state.corrupt = true;
  const { invo, make } = setup({ state });
  invo.publish(post('alice', 't1'));
  const events = await make().poll();
  assert.ok(events.some(e => e.data.type === 'notice' && /monitor state unreadable/.test(String(e.data.message))));
  assert.deepEqual(signals(events), []);
});

// --- Paging ---

test('a burst bigger than one page is read across pages back to the last seen post', async () => {
  const { invo, make } = setup({ pageSize: 20, ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.publish(post('alice', 't0'));
  const w = make();
  await w.poll();
  for (let i = 1; i <= 45; i++) invo.publish(post('alice', `t${i}`, i === 1 ? 'open' : 'update'));
  invo.publish(post('alice', 't1', 'close'));
  const s = signals(await w.poll());
  // The close of t1, from 46 posts back, is not lost
  assert.ok(s.some(x => x.action === 'close' && x.mimicMeta.sourcePaperTradeBaseId === 'base-t1'));
  assert.equal(s.length, 45); // t1's open is dropped: that trade is already closed
});

test('more new posts than the page limit: a notice says older ones were not checked', async () => {
  const { invo, make } = setup({ pageSize: 5, maxPages: 2 });
  const w = make();
  await w.poll();
  for (let i = 1; i <= 12; i++) invo.publish(post('alice', `t${i}`));
  const events = await w.poll();
  assert.equal(signals(events).length, 10);
  assert.ok(events.some(e => /more than 10 new feed posts/.test(String(e.data.message))));
});

test('a cursor the API ignores does not loop', async () => {
  const invo = fakeInvo({ ignoreCursor: true });
  const { make } = setup({ invo, pageSize: 3 });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1'), post('alice', 't2'), post('alice', 't3'));
  assert.equal(signals(await w.poll()).length, 3);
  assert.ok(invo.calls.getFeed.length <= 4);
});

// --- Closes of our copies ---

test('a close for a trade we copied is emitted even after the trader was unfollowed', async () => {
  const { invo, make } = setup({ following: ['bob'], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'), post('alice', 't9', 'close'));
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => [x.mimicMeta.sourcePaperTradeBaseId, x.copied, x.owner.id]), [['base-t1', true, 'alice']]);
  assert.deepEqual(skipped(events).map(x => x.reason), ['owner not in following list']);
});

test('every open copy is polled on /dex/trade; a closed one becomes a close signal from the ledger', async () => {
  const ledger = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), { ...copyEntry('tx-b', 'SOL', 0, 'bob', 't2'), status: 'closed' as const }];
  const { invo, make } = setup({ following: [], ledger });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'close', details: { closePrice: 150, reasonClosed: 'user_closed' } }]));

  // Even on a fresh start (closes of our copies are never just indexed)
  const s = signals(await make().poll());
  assert.deepEqual(invo.calls.getTradeUpdates[0].map(w => w.baseShortId), ['short-t1']);
  assert.deepEqual(s.map(x => [x.source, x.action, x.mimicMeta]), [['trade_poll', 'close', {
    portfolioId: 'p-alice', creatorInvoUserId: 'alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1',
  }]]);
});

test('closes of trades we hold no copy of are skipped; each close is emitted once', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'close' }]));
  const w = make();
  // Fresh start: the /dex/trade close of our copy is emitted
  assert.deepEqual(signals(await w.poll()).map(x => x.source), ['trade_poll']);
  // The same close then arrives on the feed (this poll and later): not emitted again
  invo.publish(post('alice', 't1', 'close'), post('bob', 't5', 'close'));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  assert.deepEqual(skipped(events).map(x => x.reason), ['close of a trade we hold no copy of — remembered in case one is opened']);
});

// --- Closes are remembered: late copies and incomplete closes ---

test('a copy opened just after its trader closed is still closed (close seen first)', async () => {
  const ledger: CopyEntry[] = [];
  const { invo, make } = setup({ ledger });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close')); // trader closes while trade.ts is still running
  assert.deepEqual(signals(await w.poll()), []);
  ledger.push(copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')); // trade.ts finishes
  const s = signals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.copied, x.attempt, x.mimicMeta.sourcePaperTradeBaseId]), [['close', true, 1, 'base-t1']]);
});

test('an open or update of a trade whose close was seen in an earlier poll is not copied', async () => {
  const { invo, make, advance } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  await w.poll();
  advance(10_000);
  invo.publish(post('alice', 't1'), post('alice', 't1', 'update'));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  assert.deepEqual(skipped(events).map(x => x.reason).sort(), ['open of a trade that is already closed', 'update of a trade that is already closed']);
});

test('a close that did not complete is re-sent every 90s while the copy is open, then stops', async () => {
  const ledger: CopyEntry[] = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const { invo, make, advance } = setup({ ledger });
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  assert.deepEqual(signals(await w.poll()).map(x => [x.attempt, x.retry]), [[1, undefined]]);

  // close.ts didn't fill: the copy is still open
  advance(60_000);
  assert.deepEqual(signals(await w.poll()), []);
  advance(30_000);
  assert.deepEqual(signals(await w.poll()).map(x => [x.attempt, x.retry, x.mimicMeta.sourcePaperTradeBaseId]), [[2, true, 'base-t1']]);

  // Now it closed
  ledger[0] = { ...ledger[0], status: 'closed', qty: 0 };
  advance(90_000);
  assert.deepEqual(signals(await w.poll()), []);
});

test('a close retry never comes before an unsettled close order can be settled', () => {
  // Otherwise the retry after an `unknown` close is refused as "may still arrive" and the attempt is wasted
  assert.ok(DEFAULT_CLOSE_RETRY_SEC * 1000 > MIN_SETTLE_AGE_MS + 15_000);
});

test('retries survive a restart (--wait-for-signal) and give up with one close_stuck alert', async () => {
  const ledger: CopyEntry[] = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const { invo, state, advance } = setup({ ledger });
  const make = () => new SignalWatcher({
    invo, registry: fakeRegistry(['alice']), ledger: { load: () => ledger }, state,
    now: () => clock, closeRetryMs: 60_000, maxCloseAttempts: 3,
  });
  await make().poll();
  invo.publish(post('alice', 't1', 'close'));
  const attempts: number[] = [];
  for (let i = 0; i < 3; i++) {
    attempts.push(...signals(await make().poll()).map(x => x.attempt)); // a new process each time, like wait mode
    advance(60_000);
  }
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(state.state!.closedTrades![0].attempts, 3);

  const stuck = (await make().poll()).filter(e => e.data.type === 'close_stuck');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].signal, true);
  assert.match(String(stuck[0].data.message), /3 close signals sent, but our SOL copy .* still open — needs the user/);
  advance(60_000);
  const after = await make().poll();
  assert.deepEqual([signals(after), after.filter(e => e.data.type === 'close_stuck')], [[], []]);
});

test('closed trades without a copy are forgotten after the retention period', async () => {
  const { invo, state, make, advance } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'close'));
  await w.poll();
  assert.equal(state.state!.closedTrades!.length, 1);
  advance(24 * 3600_000 + 1);
  await w.poll();
  assert.equal(state.state!.closedTrades!.length, 0);
});

test('state saved before closes were remembered still loads', async () => {
  const state = new MemoryState();
  state.state = { version: 1, seenPostIds: [], seenTradeUpdates: [], savedAt: 1_000_000 };
  const { invo, make } = setup({ state, ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.publish(post('alice', 't1', 'close'));
  assert.deepEqual(signals(await make().poll()).map(x => x.action), ['close']);
});

test('if the ledger can\'t be read, each newly seen followed-trader close is passed on once', async () => {
  const { invo, advance } = setup();
  let broken = false;
  const w = new SignalWatcher({
    invo, registry: fakeRegistry(['bob']),
    ledger: { load: () => { if (broken) throw new Error('ledger unreadable'); return []; } },
    state: new MemoryState(), now: () => clock,
  });
  await w.poll();
  invo.publish(post('bob', 't4', 'close'));
  assert.deepEqual(signals(await w.poll()), []); // ledger fine, no copy: remembered only
  broken = true;
  invo.publish(post('bob', 't5', 'close'));
  // Only the new close, not every remembered one
  assert.deepEqual(signals(await w.poll()).map(x => x.mimicMeta.sourcePaperTradeBaseId), ['base-t5']);
  advance(120_000);
  assert.deepEqual(signals(await w.poll()), []);
});

test('/dex/trade tp/sl updates on a copied trade become tpsl signals, once each', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  // As on the live WLD trade: a TP and an SL set together
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'tp', investmentId: 'v2', updatedAt: '2026-10-02T19:31:31.448Z', details: { priceTarget: 0.58 } },
    { updateType: 'sl', investmentId: 'v2', updatedAt: '2026-10-02T19:31:31.448Z', details: { stopLoss: 0.516, stopLossBefore: 0.5 } },
  ]));
  const events = await w.poll();
  assert.deepEqual(events.filter(e => e.data.type === 'trade_update').map(e => [e.data.updateType, e.data.baseShortId]), [['tp', 'short-t1'], ['sl', 'short-t1']]);
  const s = signals(events);
  assert.deepEqual(s.map(x => [x.action, x.change.which, x.change.triggerPx, x.trade.coin, x.trade.side, x.entryId]),
    [['tpsl', 'tp', 0.58, 'SOL', 'long', 'tx-a'], ['tpsl', 'sl', 0.516, 'SOL', 'long', 'tx-a']]);
  assert.equal(s[1].change.triggerPxBefore, 0.5);
  assert.deepEqual(s[0].mimicMeta, { portfolioId: 'p-alice', creatorInvoUserId: 'alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1' });
  assert.notEqual(s[0].updateId, s[1].updateId);
  assert.ok(events.filter(e => e.data.type === 'signal').every(e => e.signal), 'they end --wait-for-signal');
  // The same updates aren't reported again
  const again = await w.poll();
  assert.equal(again.filter(e => e.data.type === 'trade_update' || e.data.type === 'signal').length, 0);
});

test('/dex/trade increases and decreases of a copied trade become signals, in the order the trader made them', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  clock = Date.parse('2026-10-02T18:00:00.000Z');
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'decrease', investmentId: 'v3', updatedAt: '2026-10-02T17:59:00.000Z', details: { positionSizeBefore: 0.1, positionSizeAfter: 0.075, positionSizeChange: 0.025 } },
    { updateType: 'increase', investmentId: 'v2', updatedAt: '2026-10-02T17:58:00.000Z', details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } },
  ]));
  invo.publish(changePost('alice', 't1', 'v2', 'increase', 1.3), changePost('alice', 't1', 'v3', 'decrease', 0.2));
  const s = changeSignals(await w.poll());
  assert.deepEqual(s.map(x => [x.action, x.investmentId, x.change.positionSizeBefore, x.change.positionSizeAfter]),
    [['increase', 'v2', 0.05, 0.1], ['decrease', 'v3', 0.1, 0.075]]);
  // Each carries the $ figures of its own feed post
  assert.deepEqual(s.map(x => [x.change.notional.investmentId, x.change.notional.simIncrease, x.change.notional.simDifference]),
    [['v2', true, 130], ['v3', false, 20]]);
});

test('an increase older than the signal age limit, or a change made before our copy opened, is skipped', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] }); // opened 2026-10-01T00:00Z
  const w = make();
  await w.poll();
  clock = Date.parse('2026-10-02T18:00:00.000Z');
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'increase', investmentId: 'v1', updatedAt: '2026-09-30T12:00:00.000Z', details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } },
    { updateType: 'tp', investmentId: 'v1', updatedAt: '2026-09-30T12:00:00.000Z', details: { priceTarget: 150 } },
    { updateType: 'increase', investmentId: 'v2', updatedAt: '2026-10-02T17:50:00.000Z', details: { positionSizeBefore: 0.1, positionSizeAfter: 0.2, positionSizeChange: 0.1 } },
    { updateType: 'decrease', investmentId: 'v3', updatedAt: '2026-10-02T12:00:00.000Z', details: { positionSizeBefore: 0.2, positionSizeAfter: 0.1, positionSizeChange: 0.1 } },
  ]));
  invo.publish(changePost('alice', 't1', 'v1', 'increase', 1), changePost('alice', 't1', 'v2', 'increase', 1), changePost('alice', 't1', 'v3', 'decrease', 0.5));
  const events = await w.poll();
  // The TP set before our copy opened still applies (it's the trader's current TP); a stale decrease still applies too
  assert.deepEqual(changeSignals(events).map(x => [x.action, x.investmentId]), [['tpsl', 'v1'], ['decrease', 'v3']]);
  // Before our copy opened: nothing to replicate, a quiet skip. Too old to copy: the copy diverges, an alert
  assert.deepEqual(skipped(events).map(x => [x.updateType, x.reason.split(' — ')[0]]),
    [['increase', 'increase made before our copy opened (our size is set from our equity at open)']]);
  assert.deepEqual(alerts(events).map(x => [x.action, x.change.investmentId, x.reason.split(' — ')[0]]), [['add', 'v2', 'increase made 600s ago']]);
});

test('changes to a trade its trader already closed are skipped; the close wins', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'close', investmentId: 'v3', updatedAt: '2026-10-02T17:59:00.000Z', details: { closePrice: 140, reasonClosed: 'liquidated' } },
    { updateType: 'sl', investmentId: 'v2', updatedAt: '2026-10-02T17:58:00.000Z', details: { stopLoss: 90 } },
  ]));
  const events = await w.poll();
  assert.deepEqual(signals(events).map(x => [x.action, x.reasonClosed]), [['close', 'liquidated']]);
  assert.match(skipped(events)[0].reason, /already closed/);
});

test('an unknown /dex/trade change on a copied trade is alerted, never guessed at', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', STATUS_OPEN);
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'leverage', details: { leverage: 10 } }]));
  const events = await w.poll();
  assert.deepEqual(signals(events), []);
  const [a] = alerts(events);
  assert.equal(a.action, 'change (leverage)');
  assert.match(a.reason, /unknown \/dex\/trade updateType "leverage" — Invo reports the trade still open.*not replicated/);
});

test('a copy is watched on /dex/trade from when its trader opened, so earlier TP/SL changes are seen', async () => {
  const { invo, make } = setup({ ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), traderOpenedAt: '2026-09-30T23:59:00.000Z' }] });
  await make().poll();
  assert.deepEqual(invo.calls.getTradeUpdates[0], [{ baseShortId: 'short-t1', mimicStartedAt: '2026-09-30T23:59:00.000Z' }]);
});

test('open signals carry the trader\'s TP/SL and open time; a post that doesn\'t say leaves them out', async () => {
  const { invo, make } = setup();
  const w = make();
  await w.poll();
  invo.publish(
    post('alice', 't1', 'open', { update: { priceTarget: 160, stopLoss: null, createdAt: '2026-10-02T19:30:52.339Z', leverage: 10, directionLong: true, entryPrice: 150 } }),
  );
  const [s] = signals(await w.poll());
  assert.deepEqual([s.trade.priceTarget, s.trade.stopLoss, s.trade.openedAt, s.trade.leverage, s.trade.entryPrice], [160, null, '2026-10-02T19:30:52.339Z', 10, 150]);

  invo.publish(post('bob', 't2'));
  const [s2] = signals(await w.poll());
  assert.ok(!('priceTarget' in s2.trade) && !('stopLoss' in s2.trade));
});

test('the live /dex/trade close response (captured 2026-10-02) becomes a close signal for our copy', async () => {
  const owner = '8439473c-be0a-4738-a7f5-6b932d551f0f';
  const copy: CopyEntry = {
    ...copyEntry('tx-eth', 'ETH', 0.01, 'x', 'x'),
    source: {
      creatorInvoUserId: owner,
      portfolioId: '1f70989c-4bc7-4ee2-86a6-5d5aa5642359',
      sourcePaperTradeBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
      sourcePaperTradeBaseShortId: 'QeGEOGIhfF',
    },
  };
  const { invo, make } = setup({ following: [], ledger: [copy] });
  invo.rawTradeResponse = {
    success: true,
    data: [{
      creatorAppUserId: owner,
      portfolioId: '1f70989c-4bc7-4ee2-86a6-5d5aa5642359',
      investmentBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
      investmentBaseShortId: 'QeGEOGIhfF',
      unmimickedCount: 1,
      unseenCount: 1,
      updates: [{
        investmentId: '254923ca-1dff-4b6d-818e-5ab3515db8ac',
        investmentBaseId: '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d',
        isSeen: false,
        updatedAt: '2026-10-02T14:31:15.806Z',
        updateType: 'close',
        isMimicked: false,
        details: { closePrice: 2730.7, reasonClosed: 'user_closed' },
      }],
    }],
  };
  const s = signals(await make().poll());
  assert.deepEqual(invo.calls.getTradeUpdates[0].map(w => w.baseShortId), ['QeGEOGIhfF']);
  assert.deepEqual(s.map(x => [x.source, x.action, x.trade.coin, x.trade.closingPrice, x.mimicMeta.sourcePaperTradeBaseId]),
    [['trade_poll', 'close', 'ETH', 2730.7, '1f5a1bc5-9e11-4dff-8c6b-b41696f1c52d']]);
});

test('a /dex/trade close for another trader\'s trade with the same short id is not ours', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push({ ...dexTrade('mallory', 't1', [{ updateType: 'close' }]), investmentBaseId: undefined });
  assert.deepEqual(signals(await make().poll()), []);
});

test('a liquidation arrives as a close with reasonClosed "liquidated" (the live shape) and closes the copy', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'close', details: { closePrice: 140, reasonClosed: 'liquidated' } }]));
  const s = signals(await make().poll());
  assert.deepEqual(s.map(x => [x.action, x.reasonClosed, x.copied, x.mimicMeta.sourcePaperTradeBaseId]), [['close', 'liquidated', true, 'base-t1']]);
});

const unconfirmedEvents = (events: Awaited<ReturnType<SignalWatcher['poll']>>) =>
  events.filter(e => e.data.type === 'unknown_update_closed').map(e => ({ ...(e.data as any), endsWait: e.signal === true, stream: e.stream }));

test('an update type never seen live (e.g. "liquidated") is not guessed from its name: a trade Invo reports open is alerted, not closed', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', STATUS_OPEN);
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated', investmentId: 'inv-liq' }]));
  const events = await make().poll();
  assert.deepEqual(invo.calls.getInvestmentStatus, ['base-t1']);
  assert.deepEqual(signals(events), []);
  assert.deepEqual(alerts(events).map(a => [a.change.updateType, a.orderSent, a.endsWait]), [['liquidated', false, true]]);
  assert.match(alerts(events)[0].reason, /reports the trade still open/);
});

test('an unknown update type on a trade Invo reports closed closes the copy like any other close, with a notice', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', STATUS_CLOSED);
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidation', investmentId: 'inv-liq', details: { closePrice: 140, reasonClosed: 'liquidated' } }]));
  const events = await make().poll();
  const s = signals(events);
  assert.deepEqual(s.map(x => [x.action, x.reasonClosed, x.trade.closingPrice, x.copied, x.mimicMeta.sourcePaperTradeBaseId]),
    [['close', 'liquidated', 140, true, 'base-t1']]);
  assert.equal(parseTradeSignal(JSON.stringify(s[0])).kind, 'close');
  assert.deepEqual(unconfirmedEvents(events).map(e => [e.change.updateType, e.stream, e.endsWait]), [['liquidation', 'out', false]]);
  assert.deepEqual(alerts(events), []);
});

test('an unknown update type with no reason given closes with reasonClosed null, never a guessed one', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', STATUS_CLOSED);
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated', investmentId: 'inv-liq' }]));
  assert.deepEqual(signals(await make().poll()).map(x => [x.action, x.reasonClosed]), [['close', null]]);
});

test('an unknown update type whose trade status can\'t be read is alerted once and re-checked; a later closed status closes the copy', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', () => { throw new Error('ETIMEDOUT'); });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated', investmentId: 'inv-liq' }]));
  const first = await make().poll();
  assert.deepEqual(signals(first), []);
  assert.deepEqual(alerts(first).map(a => [a.orderSent, a.endsWait]), [[false, true]]);
  assert.match(alerts(first)[0].reason, /status couldn't be read \(ETIMEDOUT\).*re-checking/);

  // Still unreadable (junk response): no second alert
  invo.statuses.set('base-t1', { success: true, data: [] });
  const second = await make().poll(); // a new process: carried in saved state
  assert.deepEqual([signals(second), alerts(second)], [[], []]);

  invo.statuses.set('base-t1', STATUS_CLOSED);
  const third = await make().poll();
  assert.deepEqual(signals(third).map(x => x.action), ['close']);
  assert.equal(unconfirmedEvents(third).length, 1);
  assert.deepEqual(invo.calls.getInvestmentStatus, ['base-t1', 'base-t1', 'base-t1']);
  await make().poll();
  assert.equal(invo.calls.getInvestmentStatus.length, 3, 'resolved: not checked again');
});

test('an unknown update type whose status stays unreadable is given up on after maxStatusChecks, never closed', async () => {
  const ledger = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const { invo, state } = setup({ following: [], ledger });
  const w = new SignalWatcher({
    invo, registry: fakeRegistry([]), ledger: { load: () => ledger }, state, now: () => clock, maxStatusChecks: 3,
  });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated', investmentId: 'inv-liq' }]));
  const polls = [];
  for (let i = 0; i < 5; i++) polls.push(await w.poll());
  assert.equal(invo.calls.getInvestmentStatus.length, 3);
  assert.deepEqual(polls.flatMap(signals), []);
  assert.equal(polls.flatMap(alerts).length, 1);
  assert.deepEqual(polls.flatMap(e => e.filter(x => x.data.type === 'error' && x.data.source === 'trade_status')).length, 1);
});

test('a status saying the trade does not exist is unreadable, not closed', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.statuses.set('base-t1', { status: { isOpen: false, exists: false }, success: true });
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'liquidated', investmentId: 'inv-liq' }]));
  const events = await make().poll();
  assert.deepEqual(signals(events), []);
  assert.match(alerts(events)[0].reason, /status couldn't be read/);
});

test('an unknown update type on a trade already closed is skipped quietly: no alert, no status lookup', async () => {
  const { invo, make } = setup({ following: [], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'close', investmentId: 'inv-c', details: { closePrice: 140, reasonClosed: 'liquidated' } },
    { updateType: 'liquidated', investmentId: 'inv-liq' },
  ]));
  const events = await make().poll();
  assert.deepEqual(signals(events).map(x => x.action), ['close']);
  assert.deepEqual(alerts(events), []);
  assert.deepEqual(invo.calls.getInvestmentStatus, []);
  assert.ok(skipped(events).some(x => /already closed/.test(x.reason)));
});

test('an unrecognised /dex/trade response is reported, not read as "no updates" silently', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  for (const raw of [{ investments: [] }, { success: false, error: 'boom' }]) {
    invo.rawTradeResponse = raw;
    const events = await make().poll();
    assert.ok(events.some(e => e.stream === 'err' && e.data.source === 'trade' && /unrecognised \/dex\/trade response/.test(String(e.data.message))), JSON.stringify(raw));
  }
});

test('an open and a close of the same trade in one poll: the open is dropped, in either feed order', async () => {
  for (const order of ['open first', 'close first']) {
    const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
    const w = make();
    await w.poll();
    const open = post('alice', 't1');
    const close = post('alice', 't1', 'close');
    if (order === 'open first') invo.publish(open, close); else invo.publish(close, open);
    const events = await w.poll();
    assert.deepEqual(signals(events).map(x => x.action), ['close'], order);
    assert.deepEqual(skipped(events).map(x => x.reason), ['open of a trade that is already closed'], order);
  }
});

test('ambiguous trade changes are emitted as update, never as an open', async () => {
  const { invo, make } = setup();
  const w = make();
  await w.poll();
  invo.publish(post('alice', 't1', 'update'), post('alice', 't2', 'open', { update: { changes: undefined } }));
  assert.deepEqual(signals(await w.poll()).map(x => x.action), ['update', 'update']);
});

// --- Increases/decreases are held for the feed post with their $ figures ---

const incUpdate = (investmentId: string, updatedAt = '2026-10-02T17:58:00.000Z') =>
  ({ updateType: 'increase', investmentId, updatedAt, details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } });

test('an increase waits for its feed post, then is sent with that post\'s $ figures', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  const first = await w.poll();
  assert.deepEqual(changeSignals(first), [], 'held: no post yet');
  assert.deepEqual(skipped(first), []);

  advance(6_000); // the post comes ~6s later (as seen live)
  invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.4));
  const [s] = changeSignals(await w.poll());
  assert.deepEqual([s.action, s.investmentId, s.change.notional.investmentId, s.change.notional.simIncrease], ['increase', 'v2', 'v2', true]);
  assert.equal(changeSignals(await w.poll()).length, 0, 'sent once');
});

test('a feed post seen before its /dex/trade change is used when the change arrives', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.4));
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  assert.deepEqual(changeSignals(await w.poll()).map(x => x.investmentId), ['v2']);
});

test('with no feed post within 120s the change is alerted as not replicated, never sized from positionSize', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  await w.poll();
  advance(119_000);
  const waiting = await w.poll();
  assert.deepEqual([skipped(waiting), alerts(waiting)], [[], []], 'still waiting at 119s');
  advance(2_000);
  const events = await w.poll();
  assert.deepEqual(changeSignals(events), []);
  assert.match(alerts(events)[0].reason, /no feed post with its \$ figures within 120s — .* not replicated/);
  // A post arriving after that doesn't revive it
  invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.4));
  assert.deepEqual(changeSignals(await w.poll()), []);
});

test('a feed post for another trader, a repost, or the wrong kind of change is not used', async () => {
  const cases: [string, any, RegExp | null][] = [
    ['another trader\'s post with the same id', changePost('bob', 't1', 'v2', 'increase', 0.4), /another trader, trade or kind/],
    ['wrong kind', changePost('alice', 't1', 'v2', 'decrease', 0.4), /another trader, trade or kind/],
    ['repost', changePost('alice', 't1', 'v2', 'increase', 0.4, { post: { repostId: 'orig' } }), null],
  ];
  for (const [name, p, err] of cases) {
    const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
    const w = make();
    await w.poll();
    invo.publish(p);
    invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
    const events = await w.poll();
    assert.deepEqual(changeSignals(events), [], name);
    if (err) assert.match(alerts(events)[0].reason, err, name);
    else assert.deepEqual([alerts(events), skipped(events).filter(x => x.updateType === 'increase')], [[], []], `${name}: ignored, still waiting`);
  }
});

test('a change waiting for its post survives a monitor restart', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  await make().poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  await make().poll(); // seen, waiting — then this process exits
  advance(10_000);
  invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.4));
  const s = changeSignals(await make().poll()); // a new process: the update is already "seen" on /dex/trade
  assert.deepEqual(s.map(x => x.investmentId), ['v2']);
});

test('TP/SL changes are not held (they carry their own price)', async () => {
  const { invo, make } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'tp', investmentId: 'v2', details: { priceTarget: 150 } }]));
  assert.deepEqual(changeSignals(await w.poll()).map(x => x.action), ['tpsl']);
});

// --- change_not_replicated: a skipped add / partial close is reported on stdout ---

const decUpdate = (investmentId: string, updatedAt = '2026-10-02T17:59:00.000Z') =>
  ({ updateType: 'decrease', investmentId, updatedAt, details: { positionSizeBefore: 0.1, positionSizeAfter: 0.06, positionSizeChange: 0.04 } });

/** Poll until the 120s wait for a feed post runs out; returns that poll's events. */
async function pollPastWait(w: SignalWatcher, advance: (ms: number) => void) {
  await w.poll();
  advance(121_000);
  return w.poll();
}

test('alert: a skipped add says who, which trade, coin, action, why, our copy, and that no order was sent', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  const events = await pollPastWait(w, advance);
  const [a] = alerts(events);
  assert.deepEqual(
    {
      type: a.type, action: a.action, orderSent: a.orderSent, coin: a.coin, side: a.side, stream: a.stream, endsWait: a.endsWait,
      trader: a.trader, copy: a.copy, change: a.change,
    },
    {
      type: 'change_not_replicated', action: 'add', orderSent: false, coin: 'SOL', side: 'long', stream: 'out', endsWait: true,
      trader: { id: 'alice', username: 'alice', portfolioId: 'p-alice', tradeBaseId: 'base-t1', tradeBaseShortId: 'short-t1' },
      copy: { entryId: 'tx-a', qty: 0.5, status: 'open' },
      change: { updateType: 'increase', updatedAt: '2026-10-02T17:58:00.000Z', investmentId: 'v2', traderPositionShareBefore: 0.05, traderPositionShareAfter: 0.1 },
    });
  assert.match(a.reason, /no feed post with its \$ figures within 120s/);
  assert.match(a.message, /^NOT REPLICATED — @alice's add on SOL \(trade short-t1\): increase: no feed post .*\. No order was sent; our copy stays 0\.5 SOL long/);
  assert.deepEqual(changeSignals(events), [], 'no signal to act on');
  // Reported once
  assert.deepEqual(alerts(await w.poll()), []);
});

test('alert: a skipped partial close is reported as such', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 2, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [decUpdate('v3')]));
  const [a] = alerts(await pollPastWait(w, advance));
  assert.deepEqual([a.action, a.orderSent, a.copy.qty, a.change.traderPositionShareBefore, a.change.traderPositionShareAfter], ['partial close', false, 2, 0.1, 0.06]);
  assert.match(a.message, /@alice's partial close on SOL .* No order was sent; our copy stays 2 SOL long, which may no longer match the trader's position/);
});

test('alert: a post that doesn\'t match the change, and a stale add, are alerted with their reason', async () => {
  const mismatch = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w1 = mismatch.make();
  await w1.poll();
  mismatch.invo.publish(changePost('alice', 't1', 'v2', 'decrease', 0.3)); // a decrease post for an increase
  mismatch.invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  const [a1] = alerts(await w1.poll());
  assert.deepEqual([a1.action, a1.orderSent], ['add', false]);
  assert.match(a1.reason, /feed post for it \(post-\d+\) is for another trader, trade or kind of change/);

  const stale = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w2 = stale.make();
  await w2.poll();
  clock = Date.parse('2026-10-02T18:00:00.000Z');
  stale.invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.5));
  stale.invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2', '2026-10-02T17:50:00.000Z')]));
  const [a2] = alerts(await w2.poll());
  assert.match(a2.reason, /increase made 600s ago — too old to copy/);
});

test('alert: for a trader no longer followed the username is unknown and the id is named instead', async () => {
  const { invo, make, advance } = setup({ following: ['bob'], ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w = make();
  await w.poll();
  invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  const [a] = alerts(await pollPastWait(w, advance));
  assert.deepEqual([a.trader.id, a.trader.username], ['alice', null]);
  assert.match(a.message, /^NOT REPLICATED — trader alice's add on SOL/);
});

test('no alert where there is nothing to replicate: copy gone, trade closed, change made before our copy', async () => {
  // The copy closes while its change waits for a post
  const ledger = [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')];
  const gone = setup({ ledger });
  const w = gone.make();
  await w.poll();
  gone.invo.trades.push(dexTrade('alice', 't1', [incUpdate('v2')]));
  await w.poll();
  ledger[0] = { ...ledger[0], status: 'closed', qty: 0 };
  gone.advance(121_000);
  const events = await w.poll();
  assert.deepEqual(alerts(events), []);
  assert.match(skipped(events)[0].reason, /copy that is no longer open — nothing to replicate/);

  // Trade already closed: the close wins
  const closed = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w2 = closed.make();
  await w2.poll();
  closed.invo.publish(changePost('alice', 't1', 'v2', 'increase', 0.5));
  closed.invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'close', investmentId: 'v3', updatedAt: '2026-10-02T17:59:00.000Z', details: { closePrice: 140, reasonClosed: 'user_closed' } },
    incUpdate('v2'),
  ]));
  assert.deepEqual(alerts(await w2.poll()), []);

  // Made before our copy opened (copy opened 2026-10-01)
  const early = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  const w3 = early.make();
  await w3.poll();
  early.invo.publish(changePost('alice', 't1', 'v1', 'increase', 0.5));
  early.invo.trades.push(dexTrade('alice', 't1', [incUpdate('v1', '2026-09-30T12:00:00.000Z')]));
  assert.deepEqual(alerts(await w3.poll()), []);
});

test('alert: a change waiting when the monitor restarts is still alerted by the new process', async () => {
  const { invo, make, advance } = setup({ ledger: [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')] });
  await make().poll();
  invo.trades.push(dexTrade('alice', 't1', [decUpdate('v3')]));
  await make().poll(); // seen, waiting — process exits
  advance(121_000);
  const [a] = alerts(await make().poll());
  assert.deepEqual([a.action, a.change.investmentId, a.orderSent], ['partial close', 'v3', false]);
});

// --- Every signal type in its live shape (captured 2026-10-02/03, 146 feed posts, 276 /dex/trade updates) ---
// Feed: update.* is the trade's current state; changes holds the previous values of what this post changed.

const LIVE_OPEN = { isOpen: true, changes: { isAdded: false }, directionLong: true, leverage: 20, entryPrice: 86740, priceTarget: 87607, stopLoss: null, reasonClosed: null, isLiquidated: false };
const livePosts = (createdAt: string) => ({
  open: post('alice', 'open1', 'open', { update: { ...LIVE_OPEN, createdAt } }),
  // An open post read after its trade closed: now isOpen false — a close, never an open
  openNowClosed: post('alice', 'open2', 'open', { update: { ...LIVE_OPEN, isOpen: false, reasonClosed: 'user_closed', closingPrice: 86424, createdAt } }),
  close: post('alice', 'cl1', 'close', { update: { ...LIVE_OPEN, isOpen: false, changes: { isOpen: true, reasonClosed: null }, reasonClosed: 'user_closed', closingPrice: 2730.7, createdAt } }),
  liquidated: post('alice', 'liq1', 'close', { update: { ...LIVE_OPEN, isOpen: false, changes: { isOpen: true, reasonClosed: null }, reasonClosed: 'liquidated', isLiquidated: true, closingPrice: 80000, createdAt } }),
  tpEdit: post('alice', 'tp1', 'update', { update: { ...LIVE_OPEN, changes: { priceTarget: 0.26127 }, priceTarget: 0.23957, createdAt } }),
  slEdit: post('alice', 'sl1', 'update', { update: { ...LIVE_OPEN, changes: { stopLoss: 80954 }, stopLoss: 82900, createdAt } }),
  tpSlSet: post('alice', 'tpsl1', 'update', { update: { ...LIVE_OPEN, changes: { stopLoss: null, priceTarget: null }, priceTarget: 0.076919, stopLoss: 0.070122, createdAt } }),
  // A live increase post and a live decrease post (real $ figures)
  increase: post('alice', 'inc1', 'update', { update: { ...LIVE_OPEN, id: 'inv-live-inc', entrySim: 80.53886857221075, entryPrice: 2.5786782070371217, createdAt,
    changes: { entrySim: 70.34890936617738, entrySize: 14.047592305655758, entryPrice: 2.6008252133242014, simIncrease: true, simDifference: 10.189959206033365,
      liquidationPrice: 2.305915548065829, livePriceAtChange: 2.4355, percentDifference: 2.976566554744 } } }),
  decrease: post('alice', 'dec1', 'update', { update: { ...LIVE_OPEN, id: 'inv-live-dec', entrySim: 6.181557905314414, entryPrice: 1.4794159498910233, createdAt,
    changes: { entrySim: 7.104746541699936, entrySize: 1.0009523133710676, simIncrease: false, simDifference: 0.9237131278613635,
      liquidationPrice: null, livePriceAtChange: 1.4795, percentDifference: 0.14936728595211007 } } }),
});

test('live feed shapes: only {isAdded:false} on an open trade is an open; closes and liquidations are closes; TP/SL edits and $-change posts are informational', async () => {
  const ledger = ['open2', 'cl1', 'liq1'].map(t => copyEntry(`tx-${t}`, 'SOL', 0.5, 'alice', t));
  const { invo, make } = setup({ ledger });
  const w = make();
  await w.poll(); // first run: index
  const p = livePosts(new Date(clock).toISOString());
  invo.publish(...Object.values(p));
  const byTrade = Object.fromEntries(signals(await w.poll()).map(x => [x.mimicMeta.sourcePaperTradeBaseId, x]));
  const action = (t: string) => byTrade[`base-${t}`]?.action;

  assert.equal(action('open1'), 'open');
  for (const t of ['open2', 'cl1', 'liq1']) assert.equal(action(t), 'close', t);
  assert.equal(byTrade['base-liq1'].reasonClosed, 'liquidated');
  assert.equal(byTrade['base-cl1'].reasonClosed, 'user_closed');
  for (const t of ['tp1', 'sl1', 'tpsl1', 'inc1', 'dec1']) assert.equal(action(t), 'update', `${t}: never an open`);

  // What trade.ts / close.ts / tpsl.ts would make of each
  const open = parseTradeSignal(JSON.stringify(byTrade['base-open1']));
  assert.equal(open.kind, 'open');
  if (open.kind === 'open') {
    assert.deepEqual([open.coin, open.side, open.leverage, open.entryPrice, open.tp, open.sl], ['SOL', 'long', 20, 86740, 87607, null]);
  }
  for (const t of ['open2', 'cl1', 'liq1']) assert.equal(parseTradeSignal(JSON.stringify(byTrade[`base-${t}`])).kind, 'close', t);
  for (const t of ['tp1', 'sl1', 'tpsl1', 'inc1', 'dec1']) {
    assert.throws(() => parseTradeSignal(JSON.stringify(byTrade[`base-${t}`])), /informational/, `${t}: refused as a trade`);
  }
});

test('a TP/SL edit post is never taken as the $ figures of an add or partial close', async () => {
  const { invo, make, advance } = setup({ following: ['alice'], ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 'tp1'), openedAt: '2026-10-02T00:00:00.000Z' }] });
  const w = make();
  await w.poll();
  const tpPost = livePosts(new Date(clock).toISOString()).tpEdit;
  invo.publish(tpPost);
  // A /dex/trade increase claiming the TP edit post's id
  invo.trades.push(dexTrade('alice', 'tp1', [{ updateType: 'increase', investmentId: tpPost.update.id, updatedAt: new Date(clock).toISOString(),
    details: { positionSizeBefore: 0.05, positionSizeAfter: 0.1, positionSizeChange: 0.05 } }]));
  assert.deepEqual(changeSignals(await w.poll()), []);
  advance(121_000);
  const events = await w.poll();
  assert.deepEqual(changeSignals(events), []);
  assert.deepEqual(alerts(events).map(a => [a.action, a.orderSent]), [['add', false]]);
});

test('live /dex/trade tp and sl updates (with and without the Before field) are tpsl signals only — refused by trade.ts and close.ts', async () => {
  const { invo, make } = setup({ following: [], ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), openedAt: '2026-10-02T00:00:00.000Z' }] });
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'tp', investmentId: 'i-tp', updatedAt: '2026-10-02T14:31:15.806Z', details: { priceTarget: 160, priceTargetBefore: 155 } },
    { updateType: 'sl', investmentId: 'i-sl', updatedAt: '2026-10-02T14:31:20.000Z', details: { stopLoss: 120 } },
  ]));
  const s = changeSignals(await make().poll());
  assert.deepEqual(s.map(x => [x.action, x.change.which, x.change.triggerPx]), [['tpsl', 'tp', 160], ['tpsl', 'sl', 120]]);
  for (const sig of s) {
    const parsed = parseTradeSignal(JSON.stringify(sig));
    assert.equal(parsed.kind, 'tpsl');
    assert.notEqual(parsed.kind, 'increase');
  }
});

test('duplicates: the same open post or /dex/trade change seen again (next poll or after a restart) is emitted once', async () => {
  const { invo, make } = setup({ ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), openedAt: '2026-10-02T00:00:00.000Z' }] });
  const w = make();
  await w.poll();
  const open = post('alice', 'dup1', 'open', { update: { ...LIVE_OPEN, createdAt: new Date(clock).toISOString() } });
  invo.publish(open);
  invo.trades.push(dexTrade('alice', 't1', [{ updateType: 'sl', investmentId: 'i-sl', updatedAt: '2026-10-02T14:31:20.000Z', details: { stopLoss: 120 } }]));
  const first = signals(await w.poll()).map(x => x.action).sort();
  assert.deepEqual(first, ['open', 'tpsl']);
  assert.deepEqual(signals(await w.poll()), []);
  assert.deepEqual(signals(await make().poll()), []); // restart: saved state
});

test('delays: a stale open or add is not copied; a delayed partial close or close still is (it only reduces)', async () => {
  const { invo, make, advance } = setup({ following: ['alice'], ledger: [
    { ...copyEntry('tx-a', 'SOL', 1, 'alice', 't1'), openedAt: '1970-01-01T00:00:00.000Z' },
    { ...copyEntry('tx-b', 'SOL', 1, 'alice', 't2'), openedAt: '1970-01-01T00:00:00.000Z' },
  ] });
  const w = make();
  await w.poll();
  const old = new Date(clock).toISOString();
  invo.publish(post('alice', 'late-open', 'open', { update: { ...LIVE_OPEN, createdAt: old } }));
  advance(301_000);
  invo.publish(changePost('alice', 't1', 'i-inc', 'increase', 0.5), changePost('alice', 't1', 'i-dec', 'decrease', 0.25));
  invo.trades.push(dexTrade('alice', 't1', [
    { updateType: 'increase', investmentId: 'i-inc', updatedAt: old, details: { positionSizeBefore: 0.1, positionSizeAfter: 0.15, positionSizeChange: 0.05 } },
    { updateType: 'decrease', investmentId: 'i-dec', updatedAt: old, details: { positionSizeBefore: 0.15, positionSizeAfter: 0.1125, positionSizeChange: 0.0375 } },
  ]), dexTrade('alice', 't2', [{ updateType: 'close', investmentId: 'i-close', updatedAt: old, details: { closePrice: 150, reasonClosed: 'user_closed' } }]));
  const events = await w.poll();
  const s = signals(events);
  assert.ok(!s.some(x => x.action === 'open'), 'stale open not copied');
  assert.ok(!s.some(x => x.action === 'increase'), 'stale add not copied');
  assert.deepEqual(alerts(events).map(a => a.action), ['add']);
  assert.ok(skipped(events).some(x => /posted \d+s ago — too old to copy/.test(x.reason)));
  assert.deepEqual(s.filter(x => x.action === 'decrease').map(x => x.change.notional.investmentId), ['i-dec'], 'delayed partial close still sent, with its $ figures');
  assert.deepEqual(s.filter(x => x.action === 'close').map(x => x.mimicMeta.sourcePaperTradeBaseId), ['base-t2'], 'delayed close still sent');
});

test('a /dex/trade change without a readable updatedAt or investmentId is alerted, never applied', async () => {
  for (const u of [{ updateType: 'sl', updatedAt: 'not a date', details: { stopLoss: 120 } }, { updateType: 'tp', investmentId: '', details: { priceTarget: 160 } }]) {
    const { invo, make } = setup({ following: [], ledger: [{ ...copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), openedAt: '2026-10-02T00:00:00.000Z' }] });
    invo.trades.push(dexTrade('alice', 't1', [u]));
    const events = await make().poll();
    assert.deepEqual(changeSignals(events), [], JSON.stringify(u));
    assert.equal(alerts(events).length, 1, JSON.stringify(u));
  }
});
