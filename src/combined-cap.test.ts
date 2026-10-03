// Combined cap: every active copy on the account (all coins, all traders, manual
// trades and unsettled open orders included) plus a new order may not exceed 80%
// of current equity. Opens and adds both respect it; the 5–15% initial rule and
// proportional adds still apply inside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade, activeCopiesNotionalUsd } from './trade-exec.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry, notionalFor } from './test-fakes.js';
import type { CopyEntry } from './copy-ledger.js';

const NOW = new Date('2026-10-02T12:00:00Z');
let ids = 0;
type HlOpts = NonNullable<Parameters<typeof fakeHl>[0]>;
function setup(opts: HlOpts & { ledger?: CopyEntry[] } = {}) {
  const { ledger: entries = [], ...hlOpts } = opts;
  const hl = fakeHl({ equity: 2000, ...hlOpts });
  const invo = fakeInvo();
  const ledger = new MemoryLedgerStore(entries);
  const deps = { hl, invo, ledger, newId: () => `tx-${++ids}`, newCloid: () => `0xc${++ids}`, now: () => NOW };
  return { hl, invo, ledger, deps, trade: (args: string[]) => runTrade(args, deps) };
}
const open = (trader: string, tradeId: string, coin = 'SOL', entryPrice = 100) => [JSON.stringify({
  type: 'signal', source: 'feed', action: 'open', postedAt: '2026-10-02T11:59:40.000Z',
  trade: { coin, side: 'long', leverage: 5, entryPrice, isOpen: true, priceTarget: null, stopLoss: null, openedAt: '2026-10-02T11:59:30.000Z' },
  mimicMeta: signalMeta(trader, tradeId),
})];
const increase = (ratio: number, trader = 'alice', tradeId = 't1', atSec = -30) => {
  const updatedAt = new Date(NOW.getTime() + atSec * 1000).toISOString();
  return [JSON.stringify({
    type: 'signal', source: 'trade_poll', action: 'increase', updateId: `${tradeId}_inc_${atSec}`, investmentId: `inv${atSec}`, updatedAt,
    trade: { coin: 'SOL', side: 'long' },
    change: { positionSizeBefore: 0.1, positionSizeAfter: 0.1 * (1 + ratio), positionSizeChange: 0.1 * ratio, notional: notionalFor('increase', ratio, `inv${atSec}`) },
    mimicMeta: (({ initialSourcePaperUpdateId, ...m }) => m)(signalMeta(trader, tradeId)),
  })];
};
const held = (id: string, coin: string, qty: number, trader: string | null, tradeId = id): CopyEntry =>
  ({ ...copyEntry(id, coin, qty, trader, tradeId), leverage: 5 });
/** Every active copy in the ledger at the fake's mids. */
const exposure = (s: ReturnType<typeof setup>) =>
  activeCopiesNotionalUsd(s.ledger.entries, Object.fromEntries(Object.entries(s.hl.mids).map(([k, v]) => [k, String(v)])));

// --- Measuring exposure ---

test('exposure counts every active copy in every coin, plus unsettled open orders; not closed ones', () => {
  const mids = { SOL: '100', ETH: '3000', BTC: '60000' };
  const pending: CopyEntry = { ...held('p', 'BTC', 0, 'carol'), status: 'pending', pendingOrder: { kind: 'open', cloid: '0x1', requestedQty: 0.001, placedAt: '' } };
  const closed: CopyEntry = { ...held('c', 'SOL', 5, 'dave'), status: 'closed' };
  const entries = [held('a', 'SOL', 2, 'alice'), held('b', 'ETH', 0.1, 'bob'), held('m', 'SOL', 1, null), pending, closed];
  // 2×100 + 0.1×3000 + 1×100 (manual) + 0.001×60000 (pending) = 660
  assert.equal(activeCopiesNotionalUsd(entries, mids), 660);
  assert.throws(() => activeCopiesNotionalUsd([held('x', 'DOGE', 10, 'eve')], mids), /No mid price for DOGE .* can't value active copies/);
});

// --- Opens ---

test('an open is clamped to the room left under 80% of equity, still within 5–15%', async () => {
  // Equity $2,000 → combined cap $1,600. ETH copy 0.48 × $3,000 = $1,440 → $160 left.
  // Strong trader → 15% = $300, clamped to $160 (≥ the $100 floor)
  const s = setup({ positions: { ETH: 0.48 }, ledger: [held('e', 'ETH', 0.48, 'bob')] });
  const out = await s.trade(open('alice', 't1'));
  assert.equal(out.status, 'filled');
  assert.deepEqual([out.sizing.combinedCapUsd, out.sizing.combinedExposureUsd, out.sizing.combinedHeadroomUsd, out.sizing.targetUsd], [1600, 1440, 160, 160]);
  assert.ok(out.sizing.maxFillNotionalUsd <= 160 && out.sizing.minFillNotionalUsd >= 100, JSON.stringify(out.sizing));
  assert.ok(exposure(s) <= 1600, `combined ${exposure(s)}`);
});

test('an open the combined cap can\'t fit at the 5% floor is refused before leverage, ledger or orders change', async () => {
  // $1,560 of copies → $40 left, under the $100 floor
  const s = setup({ positions: { ETH: 0.52 }, ledger: [held('e', 'ETH', 0.52, 'bob')] });
  await assert.rejects(s.trade(open('alice', 't1')), /Combined cap: \$40\.00 left under 80% of \$2000\.00 equity .* refusing rather than opening below the 5% floor/);
  assert.ok(!s.hl.calls.includes('setLeverage') && !s.hl.calls.includes('placeMarketOrder'));
  assert.equal(s.ledger.saves, 0);
});

test('several traders sending the same signal can\'t stack past the combined cap', async () => {
  // Equity $2,000 → cap $1,600; each strong copy is ≤ $300 at the worst fill
  const s = setup();
  const results: string[] = [];
  for (const trader of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    const before = exposure(s);
    try {
      const out = await s.trade(open(trader, `t-${trader}`));
      // Enforced at order time: copies held (at mid) + this order at its worst-case fill
      assert.ok(before + out.sizing.maxFillNotionalUsd <= 1600 + 1e-9, `${trader}: ${before} + ${out.sizing.maxFillNotionalUsd}`);
      results.push(out.size);
    } catch (e: any) {
      assert.match(e.message, /Combined cap/);
      results.push('refused');
    }
  }
  // Five full copies (2.94 SOL = $294 each), a sixth clamped to the $130 left, then refused
  assert.deepEqual(results, ['2.94', '2.94', '2.94', '2.94', '2.94', '1.27', 'refused', 'refused']);
  assert.ok(exposure(s) <= 1600, `combined ${exposure(s)}`);
});

test('copies in other coins, manual trades and unsettled orders all count toward the cap', async () => {
  // SOL manual 5 ($500) + BTC copy 0.01 ($600) + ETH unsettled open order 0.15 ($450) = $1,550 → $50 left
  const pendingEth: CopyEntry = { ...held('p', 'ETH', 0, 'carol'), status: 'pending', pendingOrder: { kind: 'open', cloid: '0xeth', requestedQty: 0.15, placedAt: '2026-10-02T11:59:59.000Z' } };
  const s = setup({ positions: { SOL: 5, BTC: 0.01 }, ledger: [held('m', 'SOL', 5, null), held('b', 'BTC', 0.01, 'bob'), pendingEth] });
  await assert.rejects(s.trade(open('alice', 't1', 'SOL')), /Combined cap: \$50\.00 left/);
  // A manual trade is capped the same way
  await assert.rejects(runTrade(['SOL', 'long', 'auto', '5', 'manual'], s.deps), /Combined cap/);
  assert.deepEqual(s.hl.orders, []);
});

test('a copy in a coin with no price is refused (exposure that can\'t be valued can\'t be capped)', async () => {
  const s = setup({ ledger: [held('x', 'DOGE', 100, 'eve')] });
  await assert.rejects(s.trade(open('alice', 't1')), /No mid price for DOGE/);
  assert.ok(!s.hl.calls.includes('placeMarketOrder'));
});

test('without other copies the 5–15% initial rule is unchanged', async () => {
  const s = setup();
  const out = await s.trade(open('alice', 't1'));
  assert.deepEqual([out.sizing.targetUsd, out.size, out.sizing.combinedHeadroomUsd], [300, '2.94', 1600]);
});

// --- Adds ---

test('an add is limited to the room left under the combined cap', async () => {
  // Alice SOL 2 ($200) + Bob ETH 0.45 ($1,350) = $1,550 → $50 left.
  // Trader doubles: mirrored $200, tier $300, copy room $100, 80% of copy $160 → combined $50 binds
  const s = setup({ positions: { SOL: 2, ETH: 0.45 }, ledger: [held('a', 'SOL', 2, 'alice', 't1'), held('b', 'ETH', 0.45, 'bob')] });
  const out = await s.trade(increase(1));
  assert.deepEqual([out.sizing.mirroredUsd, out.sizing.copyHeadroomUsd, out.sizing.combinedHeadroomUsd, out.sizing.targetUsd, out.size],
    [200, 100, 50, 50, '0.49']);
  assert.ok(exposure(s) <= 1600);
  // $1 left now: the next add is refused
  await assert.rejects(s.trade(increase(1, 'alice', 't1', -20)), /Can't copy the increase: Combined cap: .* less than the \$10\.00 minimum order/);
  assert.equal(s.hl.orders.length, 1);
});

test('adds and opens from several traders interleaved never exceed the combined cap', async () => {
  const s = setup({ equity: 3000 }); // cap $2,400
  for (let i = 0; i < 12; i++) {
    const trader = `tr${i % 4}`;
    const args = i < 4 ? open(trader, `t-${trader}`) : increase(2, trader, `t-${trader}`, -60 + i);
    const before = exposure(s);
    try {
      const out = await s.trade(args);
      assert.ok(before + out.sizing.maxFillNotionalUsd <= 2400 + 1e-9, `step ${i}: ${before} + ${out.sizing.maxFillNotionalUsd}`);
    } catch (e: any) { assert.match(e.message, /Combined cap|Increase too small|at or above 15%/); }
    assert.ok(exposure(s) <= 2400 + 1e-9, `step ${i}: combined ${exposure(s)}`);
  }
});
