// The pre-merge safeguards: B1 trigger orders block opens (fail closed), B2 stale
// open signals are refused by trade.ts itself, B3 partial closes need the live
// position to hold the tracked copies, B4 adds keep a copy within 15% of equity.
// Plus duplicate / stale / replayed signals and proportional-add edge cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { runTpsl, isTriggerLike, type OpenOrder } from './tpsl-exec.js';
import { SignalWatcher, type MonitorState } from './signal-watcher.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry, notionalFor } from './test-fakes.js';
import type { CopyEntry } from './copy-ledger.js';

const NOW_MS = Date.parse('2026-10-02T12:00:00.000Z');
const iso = (offsetSec: number) => new Date(NOW_MS + offsetSec * 1000).toISOString();

let ids = 0;
type HlOpts = NonNullable<Parameters<typeof fakeHl>[0]>;
function setup(opts: HlOpts & { ledger?: MemoryLedgerStore; nowMs?: number } = {}) {
  const { ledger: givenLedger, nowMs, ...hlOpts } = opts;
  const hl = fakeHl(hlOpts);
  const invo = fakeInvo();
  const ledger = givenLedger ?? new MemoryLedgerStore();
  const deps = { hl, invo, ledger, newId: () => `tx-${++ids}`, newCloid: () => `0xcloid${++ids}`, now: () => new Date(nowMs ?? NOW_MS) };
  return {
    hl, invo, ledger, deps,
    trade: (sig: string) => runTrade([sig], deps),
    close: (sig: string) => runClose([sig], deps),
    tpsl: (sig: string) => runTpsl([sig], deps),
  };
}

const ident = (trader: string, tradeId: string) => {
  const { initialSourcePaperUpdateId, ...m } = signalMeta(trader, tradeId);
  return m;
};
function openSig(opts: { postedAtSec?: number | null; trade?: Record<string, unknown>; trader?: string; tradeId?: string } = {}) {
  const { postedAtSec = -20, trade = {}, trader = 'alice', tradeId = 't1' } = opts;
  return JSON.stringify({
    type: 'signal', source: 'feed', action: 'open',
    ...(postedAtSec !== null && { postedAt: iso(postedAtSec) }),
    trade: { coin: 'SOL', side: 'long', leverage: 5, entryPrice: 100, isOpen: true, priceTarget: null, stopLoss: null, openedAt: iso(-25), ...trade },
    mimicMeta: signalMeta(trader, tradeId),
  });
}
const increaseSig = (ratio: number, atSec = -30, trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'increase', updateId: `${tradeId}_inc_${atSec}`, investmentId: `inv${atSec}`, updatedAt: iso(atSec),
  trade: { coin: 'SOL', side: 'long' },
  change: { positionSizeBefore: 0.1, positionSizeAfter: 0.1 * (1 + ratio), positionSizeChange: 0.1 * ratio, notional: notionalFor('increase', ratio, `inv${atSec}`) },
  mimicMeta: ident(trader, tradeId),
});
const decreaseSig = (before: number, after: number, atSec = -10, trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'decrease', updateId: `${tradeId}_dec_${atSec}`, investmentId: `inv${atSec}`, updatedAt: iso(atSec),
  trade: { coin: 'SOL', side: 'long' },
  change: { positionSizeBefore: before, positionSizeAfter: after, positionSizeChange: before - after, notional: notionalFor('decrease', (before - after) / before, `inv${atSec}`) },
  mimicMeta: ident(trader, tradeId),
});
const tpslSig = (which: 'tp' | 'sl', triggerPx: number, atSec = -10) => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'tpsl', updateId: `t1_${which}_${atSec}`, investmentId: 'inv', updatedAt: iso(atSec),
  trade: { coin: 'SOL', side: 'long' }, change: { which, triggerPx }, mimicMeta: ident('alice', 't1'),
});
const held = (qty: number, id = 'tx-a', trader = 'alice', tradeId = 't1'): CopyEntry => ({ ...copyEntry(id, 'SOL', qty, trader, tradeId), leverage: 5 });
const noOrders = (hl: ReturnType<typeof fakeHl>) => !hl.calls.includes('placeMarketOrder') && !hl.calls.includes('setLeverage');

// ============ B1: trigger / position TP/SL orders block opens (fail closed) ============

test('B1: isTriggerLike counts any trigger, position TP/SL or TP/SL-named order — whatever the exact label', () => {
  const like: Partial<OpenOrder>[] = [
    { isTrigger: true, orderType: 'Take Profit Market' },
    { isTrigger: true, orderType: 'Stop Market' },
    { isTrigger: true, orderType: 'Something New' }, // unknown label, still a trigger
    { isTrigger: false, isPositionTpsl: true, orderType: 'Limit' },
    { orderType: 'Take Profit Limit' }, // no flags at all
    { orderType: 'Stop Limit' },
    { orderType: 'TP' },
    { orderType: 'SL' },
    { orderType: 'Trigger Market' },
  ];
  for (const o of like) assert.equal(isTriggerLike(o as OpenOrder), true, JSON.stringify(o));
  for (const o of [{ orderType: 'Limit' }, { orderType: 'Market' }, { isTrigger: false, orderType: 'Limit', reduceOnly: true }, {}]) {
    assert.equal(isTriggerLike(o as OpenOrder), false, JSON.stringify(o));
  }
});

test('B1: an open is refused, before leverage or any order, when the coin has any trigger-like order', async () => {
  const blocking: OpenOrder[] = [
    { coin: 'SOL', cloid: '0x1', isTrigger: true, orderType: 'Unrecognised Trigger Label' },
    { coin: 'SOL', cloid: '0x2', isPositionTpsl: true, orderType: 'Limit' },
    { coin: 'SOL', cloid: null, orderType: 'Take Profit Limit' },
  ];
  for (const o of blocking) {
    // Into a flat coin, and into a coin another copy holds; copies and manual trades alike
    for (const positions of [{}, { SOL: 0.5 }] as Record<string, number>[]) {
      const ledger = new MemoryLedgerStore(positions.SOL ? [copyEntry('tx-bob', 'SOL', 0.5, 'bob', 't2')] : []);
      const s = setup({ positions, ledger, openOrders: [o] });
      await assert.rejects(s.trade(openSig()), /has TP\/SL orders on the position/, JSON.stringify([o, positions]));
      assert.ok(noOrders(s.hl), JSON.stringify(o));
      const m = setup({ positions, openOrders: [o] });
      await assert.rejects(runTrade(['SOL', 'long', 'auto', '5', 'manual'], m.deps), /has TP\/SL orders on the position/);
      assert.ok(noOrders(m.hl));
    }
  }
});

test('B1: orders that can\'t act on the new position don\'t block it (another coin, a plain resting limit)', async () => {
  const s = setup({ openOrders: [
    { coin: 'ETH', cloid: '0xeth', isTrigger: true, orderType: 'Stop Market' },
    { coin: 'SOL', cloid: '0xlimit', isTrigger: false, orderType: 'Limit' },
  ] });
  assert.equal((await s.trade(openSig())).status, 'filled');
});

test('B1: tpsl.ts refuses when the coin has any trigger it didn\'t place — of either kind, or of unknown kind', async () => {
  for (const o of [
    { coin: 'SOL', cloid: '0xsl', isTrigger: true, orderType: 'Stop Market' }, // other kind than the TP being set
    { coin: 'SOL', cloid: '0xodd', isTrigger: true, orderType: 'Odd' },
    { coin: 'SOL', isPositionTpsl: true }, // no cloid
  ] as OpenOrder[]) {
    const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]), openOrders: [o] });
    const out = await s.tpsl(tpslSig('tp', 110));
    assert.equal(out.status, 'refused', JSON.stringify(o));
    assert.match((out as any).reason, /didn't place/);
    assert.deepEqual([s.hl.tpslOrders, s.hl.cancels], [[], []]);
  }
});

test('B1: tpsl.ts still replaces its own TP/SL (both of ours present)', async () => {
  const s = setup();
  await s.trade(openSig({ trade: { priceTarget: 110, stopLoss: 95 } }));
  const out = await s.tpsl(tpslSig('tp', 115, -5));
  assert.equal(out.status, 'applied');
  assert.equal(s.hl.openOrders.length, 2);
});

// ============ B2: stale open signals are refused by trade.ts itself ============

test('B2: an open older than 300s, with no postedAt, or dated in the future is refused before anything is touched', async () => {
  const cases: [string, number | null, RegExp][] = [
    ['stale', -301, /posted 301s ago — too old to copy \(max 300s\)/],
    ['very stale (replayed hours later)', -3 * 3600, /too old to copy/],
    ['no postedAt (older monitor)', null, /no readable postedAt/],
    ['future', 120, /in the future — unreadable time/],
  ];
  for (const [name, postedAtSec, err] of cases) {
    const s = setup();
    await assert.rejects(s.trade(openSig({ postedAtSec })), err, name);
    assert.deepEqual([s.hl.calls, s.invo.calls, s.ledger.saves], [[], [], 0], name);
  }
});

test('B2: within the window (incl. small clock skew) the open goes through', async () => {
  for (const postedAtSec of [-300, -1, 30]) {
    const s = setup();
    assert.equal((await s.trade(openSig({ postedAtSec }))).status, 'filled', String(postedAtSec));
  }
});

test('B2: the same open signal replayed later is refused — by age, and by the ledger while still fresh', async () => {
  const sig = openSig({ postedAtSec: -10 });
  const ledger = new MemoryLedgerStore();
  const first = setup({ ledger });
  assert.equal((await first.trade(sig)).status, 'filled');

  // Re-run a minute later (e.g. the agent re-reads its output): the ledger refuses it
  const again = setup({ ledger, positions: { SOL: first.hl.positions.SOL }, nowMs: NOW_MS + 60_000 });
  await assert.rejects(again.trade(sig), /Already copied trader update upd-t1/);
  assert.deepEqual(again.hl.calls, []);

  // Replayed after the copy closed and the ledger was lost (worst case): age refuses it
  const lost = setup({ ledger: new MemoryLedgerStore(), nowMs: NOW_MS + 10 * 60_000 });
  await assert.rejects(lost.trade(sig), /too old to copy/);
  assert.deepEqual(lost.hl.calls, []);
});

test('B2: the monitor stamps open signals with the post\'s time, and a restart after a long stop skips opens', async () => {
  let clock = NOW_MS;
  const feed: any[] = [];
  const state = { s: null as MonitorState | null, load() { return this.s && structuredClone(this.s); }, save(x: MonitorState) { this.s = structuredClone(x); } };
  const traders = [{ userId: 'alice', username: 'alice', portfolios: [{ id: 'p-alice' }] }];
  const make = () => new SignalWatcher({
    invo: { async getFeed() { return { items: feed }; }, async getTradeUpdates() { return { success: true, data: [] }; }, async getInvestmentStatus() { return null; } },
    registry: { traders, byUserId: new Map(traders.map(t => [t.userId, t])), async refreshIfDue() { return null; }, async refreshOnDemand() { return null; }, async refreshPortfolios() { return false; } },
    ledger: { load: () => [] },
    state,
    now: () => clock,
  });
  const post = (id: string, createdAt: number) => ({
    id, repostId: null, createdAt: new Date(createdAt).toISOString(), owner: { id: 'alice' },
    update: {
      id: `upd-${id}`, baseId: `base-${id}`, baseShortId: `short-${id}`, ticker: 'SOL', verifiedTrade: true, isOpen: true,
      owner: { id: 'alice' }, portfolio: { id: 'p-alice' }, changes: { isAdded: false }, priceTarget: null, stopLoss: null,
    },
  });
  await make().poll(); // first run indexes
  feed.unshift(post('a', clock - 5_000));
  const w = make();
  const [s] = (await w.poll()).filter(e => e.data.type === 'signal').map(e => e.data as any);
  assert.equal(s.postedAt, new Date(clock - 5_000).toISOString());

  // Stopped for 20 minutes; a post made 15 minutes ago is not emitted on restart
  clock += 20 * 60_000;
  feed.unshift(post('b', clock - 15 * 60_000));
  const events = await make().poll();
  assert.deepEqual(events.filter(e => e.data.type === 'signal'), []);
  assert.ok(events.some(e => e.data.type === 'skipped' && /too old/.test(String((e.data as any).reason))));
});

test('B2: increases dated in the future are refused; at the 300s limit they still go through', async () => {
  const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]), equity: 2000 });
  await assert.rejects(s.trade(increaseSig(0.5, 120)), /in the future/);
  await assert.rejects(s.trade(increaseSig(0.5, -301)), /301s ago — too old/);
  assert.deepEqual(s.hl.calls, []);
  assert.equal((await s.trade(increaseSig(0.5, -300))).status, 'filled');
});

test('B2: tpsl.ts re-applying an old open signal\'s TP/SL never opens anything', async () => {
  const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]), nowMs: NOW_MS + 3600_000 });
  const out = await s.tpsl(openSig({ trade: { priceTarget: 110 } }));
  assert.equal(out.status, 'applied');
  assert.deepEqual(s.hl.orders, []);
  assert.deepEqual(s.hl.tpslOrders.map(o => o.which), ['tp']);
});

// ============ Duplicates and reordering ============

test('duplicate increase / decrease / TP/SL signals are applied once', async () => {
  const s = setup({ positions: { SOL: 2 }, ledger: new MemoryLedgerStore([held(2)]), equity: 2000 });
  assert.equal((await s.trade(increaseSig(0.2))).status, 'filled');
  await assert.rejects(s.trade(increaseSig(0.2)), /Already copied trader update/);
  assert.equal((await s.close(decreaseSig(0.1, 0.05))).status, 'decreased');
  assert.equal((await s.close(decreaseSig(0.1, 0.05))).status, 'refused');
  assert.equal((await s.tpsl(tpslSig('sl', 95))).status, 'applied');
  assert.equal((await s.tpsl(tpslSig('sl', 95))).status, 'refused');
  assert.deepEqual([s.hl.orders.length, s.hl.tpslOrders.length], [2, 1]);
});

test('a delayed older TP/SL change never overrides a newer one', async () => {
  const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.equal((await s.tpsl(tpslSig('tp', 120, -5))).status, 'applied');
  assert.equal((await s.tpsl(tpslSig('tp', 110, -50))).status, 'unchanged');
  assert.equal(s.ledger.entries[0].tpsl!.tp!.triggerPx, 120);
});

// ============ B3: partial closes need the live position to hold the tracked copies ============

test('B3: a decrease is refused when the position is smaller than our tracked copy', async () => {
  const s = setup({ positions: { SOL: 1.5 }, ledger: new MemoryLedgerStore([held(2)]) });
  const out = await s.close(decreaseSig(0.1, 0.075));
  assert.equal(out.status, 'refused');
  assert.match((out as any).reason, /smaller than the copies tracked in it \(2\) — our copy's real size is unknown/);
  assert.deepEqual(s.hl.orders, []);
  assert.deepEqual(s.ledger.entries[0].sourceUpdateIds, ['upd-t1'], 'the decrease is not claimed');
});

test('B3: …or smaller than all copies in the coin together', async () => {
  const s = setup({ positions: { SOL: 2.5 }, ledger: new MemoryLedgerStore([held(2), held(1, 'tx-bob', 'bob', 't2')]) });
  assert.equal((await s.close(decreaseSig(0.1, 0.05))).status, 'refused');
  assert.deepEqual(s.hl.orders, []);
});

test('B3: with the copies intact, a decrease closes exactly the fraction of our copy — never of the position', async () => {
  // Position also holds 1 SOL from outside the ledger; the copy is 2
  const s = setup({ positions: { SOL: 3 }, ledger: new MemoryLedgerStore([held(2)]) });
  const out = await s.close(decreaseSig(0.1, 0.075)); // 25%
  assert.deepEqual([out.status, (out as any).requestedQty, (out as any).copyQtyLeft], ['decreased', 0.5, 1.5]);
  assert.equal(s.hl.positions.SOL, 2.5);
  assert.equal(s.hl.orders[0].reduceOnly, true);
});

test('B3: a decrease rounds down to the lot size (never up)', async () => {
  const s = setup({ positions: { SOL: 1.23 }, ledger: new MemoryLedgerStore([held(1.23)]) });
  const out = await s.close(decreaseSig(0.3, 0.2)); // 1/3 of 1.23 = 0.41
  assert.equal((out as any).requestedQty, 0.41);
  const s2 = setup({ positions: { SOL: 1.25 }, ledger: new MemoryLedgerStore([held(1.25)]) });
  const out2 = await s2.close(decreaseSig(0.3, 0.2)); // 0.41666… → 0.41
  assert.equal((out2 as any).requestedQty, 0.41);
});

test('B3: a full decrease (trader at zero) still closes what is left of a shrunken copy, reduce-only', async () => {
  const s = setup({ positions: { SOL: 1.5 }, ledger: new MemoryLedgerStore([held(2)]) });
  const out = await s.close(decreaseSig(0.1, 0));
  assert.equal(out.status, 'closed');
  assert.equal(s.hl.positions.SOL, 0);
});

// ============ B4: adds keep a copy within 15% of equity; proportional-add edge cases ============

test('B4: an add is limited to the room left under 15% of equity for the copy', async () => {
  // Equity $10,000 → copy max $1,500. Copy 10 SOL = $1,000 → $500 of room.
  // Trader triples: mirrored $3,000; tier (strong) $1,500; 80% cap $800 → room ($500) binds
  const s = setup({ equity: 10_000, positions: { SOL: 10 }, ledger: new MemoryLedgerStore([held(10)]) });
  const out = await s.trade(increaseSig(3));
  assert.deepEqual([out.sizing.mirroredUsd, out.sizing.copyHeadroomUsd, out.sizing.capUsd, out.sizing.targetUsd, out.size],
    [3000, 500, 800, 500, '4.90']);
  assert.ok(out.sizing.maxFillNotionalUsd <= 500);
  // The whole copy, at today's mid, is within $1,500
  assert.ok(s.ledger.entries[0].qty * 100 <= 1500);
});

test('B4: repeated adds grow a copy only up to 15% of equity, then are refused', async () => {
  // Equity $2,000 → copy max $300. Copy starts at 1 SOL ($100). Trader doubles each time.
  const s = setup({ equity: 2000, positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  const a = await s.trade(increaseSig(1, -40)); // mirrored $100, 80% cap $80 → 0.78
  assert.equal(a.size, '0.78');
  const b = await s.trade(increaseSig(1, -30)); // copy 1.78 = $178; room $122 binds (80% = $142.40)
  assert.deepEqual([b.sizing.copyHeadroomUsd, b.size], [122, '1.19']);
  assert.ok(s.ledger.entries[0].qty * 100 <= 300, `copy ${s.ledger.entries[0].qty} SOL`);
  // Copy 2.97 = $297: $3 of room is under HL's $10 minimum
  await assert.rejects(s.trade(increaseSig(1, -20)), /Increase too small/);
  // At or over the cap (e.g. after the price rose): refused outright
  s.hl.mids.SOL = 110;
  await assert.rejects(s.trade(increaseSig(1, -10)), /at or above 15% of equity/);
  assert.equal(s.hl.orders.length, 2);
});

test('B4: the tier % caps a single add (a poor-tier trader adds at most 5% of equity)', async () => {
  // Stats lookup fails → poor tier 5% of $4,000 = $200. Copy 3 SOL = $300; trader doubles → mirrored $300.
  // Room under 15% ($600) = $300; 80% cap $240 → tier ($200) binds
  const s = setup({ equity: 4000, positions: { SOL: 3 }, ledger: new MemoryLedgerStore([held(3)]) });
  s.invo.getPortfolioById = async () => { throw new Error('Invo 500'); };
  const out = await s.trade(increaseSig(1));
  assert.deepEqual([out.sizing.tier, out.sizing.targetUsd, out.size], ['poor', 200, '1.96']);
});

test('B4: the 80% cap uses the smaller of the copy and the whole coin position', async () => {
  // Ledger copy 1 SOL ($100) but the position holds only 0.5 ($50): cap 80% of $50 = $40
  const s = setup({ equity: 2000, positions: { SOL: 0.5 }, ledger: new MemoryLedgerStore([held(1)]) });
  const out = await s.trade(increaseSig(1));
  assert.deepEqual([out.sizing.capUsd, out.size], [40, '0.39']);
});

test('proportional adds never exceed the trader\'s proportion of our copy, at any ratio', async () => {
  for (const ratio of [0.15, 0.333, 0.5, 0.8, 1, 2.5, 100]) {
    const s = setup({ equity: 100_000, positions: { SOL: 10 }, ledger: new MemoryLedgerStore([held(10)]) });
    const out = await s.trade(increaseSig(ratio));
    const added = parseFloat(out.size);
    assert.ok(added <= 10 * ratio + 1e-9, `ratio ${ratio}: added ${added}`);
    assert.ok(added <= 10 * 0.8 + 1e-9, `ratio ${ratio}: 80% cap`);
    assert.ok(out.sizing.maxFillNotionalUsd <= Math.min(10 * 100 * ratio, 800, 15_000 - 1000) + 1e-9, `ratio ${ratio}`);
  }
});

test('an increase with sizes that don\'t add up, or that didn\'t grow, is refused before anything is touched', async () => {
  const bad = (change: object) => JSON.stringify({ ...JSON.parse(increaseSig(1)), change });
  for (const change of [
    { positionSizeBefore: 0.1, positionSizeAfter: 0.3, positionSizeChange: 0.1 }, // inconsistent
    { positionSizeBefore: 0.1, positionSizeAfter: 0.05, positionSizeChange: 0.05 }, // shrank
    { positionSizeBefore: 0, positionSizeAfter: 0.1, positionSizeChange: 0.1 }, // no size before
    {},
  ]) {
    const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
    await assert.rejects(s.trade(bad(change)), /inconsistent|didn.t grow|positionSize/, JSON.stringify(change));
    assert.deepEqual(s.hl.calls, []);
  }
});
