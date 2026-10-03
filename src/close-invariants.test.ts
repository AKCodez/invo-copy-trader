// Close-path invariants, checked across scenarios: every close order is reduce-only,
// on the side that shrinks the live position, never more than the tracked copy (or
// the position), and anything malformed or ambiguous is refused before an order.
// Also: TP/SL-only updates are never opens or closes, and the sizing limits stand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClose } from './close-exec.js';
import { runTrade } from './trade-exec.js';
import { signalAction } from './following.js';
import { parseTradeSignal } from './trade-signal.js';
import {
  MIN_EQUITY_PCT, MAX_EQUITY_PCT, MAX_COMBINED_EQUITY_PCT, MAX_INCREASE_FRACTION, TIER_EQUITY_PCT, copyRange,
} from './sizing.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry, notionalFor } from './test-fakes.js';

const NOW = new Date('2026-10-02T12:00:00Z');
let ids = 0;
const depsFor = (hl: ReturnType<typeof fakeHl>, ledger: MemoryLedgerStore) =>
  ({ hl, invo: fakeInvo(), ledger, newId: () => `tx-${++ids}`, newCloid: () => `0xcloid${++ids}`, now: () => NOW });

const ident = (trader: string, tradeId: string) => {
  const { initialSourcePaperUpdateId, ...m } = signalMeta(trader, tradeId);
  return m;
};
const closeSig = (coin = 'SOL', trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'close', reasonClosed: 'user_closed',
  trade: { coin, side: 'long', isOpen: false }, mimicMeta: ident(trader, tradeId),
});
const decreaseSig = (before: number, after: number, opts: { coin?: string; notional?: unknown } = {}) => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'decrease', updateId: `t1_dec_${before}_${after}`, investmentId: 'inv',
  updatedAt: '2026-10-02T11:59:50.000Z', trade: { coin: opts.coin ?? 'SOL', side: 'long' },
  change: {
    positionSizeBefore: before, positionSizeAfter: after, positionSizeChange: before - after,
    notional: 'notional' in opts ? opts.notional : notionalFor('decrease', (before - after) / before, 'inv'),
  },
  mimicMeta: ident('alice', 't1'),
});
const tpslSig = JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'tpsl', updateId: 't1_tp', investmentId: 'inv', updatedAt: '2026-10-02T11:59:50.000Z',
  trade: { coin: 'SOL', side: 'long' }, change: { which: 'tp', triggerPx: 120 }, mimicMeta: ident('alice', 't1'),
});

/** Every order a close path sent: reduce-only, shrinking side of `szi`, at most `maxQty`. */
function assertCloseOrders(hl: ReturnType<typeof fakeHl>, szi: number, maxQty: number) {
  assert.ok(hl.orders.length > 0, 'an order was placed');
  for (const o of hl.orders) {
    assert.equal(o.reduceOnly, true, 'close order is reduce-only');
    assert.equal(o.isBuy, szi < 0, `close of a ${szi > 0 ? 'long' : 'short'} is a ${szi > 0 ? 'sell' : 'buy'}`);
    assert.ok(parseFloat(o.size) <= maxQty + 1e-12, `size ${o.size} <= ${maxQty}`);
    assert.ok(parseFloat(o.size) <= Math.abs(szi) + 1e-12, `size ${o.size} <= position ${Math.abs(szi)}`);
  }
}

// --- 1. Full closes are reduce-only ---

test('1: every full-close path sends a reduce-only order on the closing side (signal, mimicMeta, decrease to zero, manual; long and short)', async () => {
  const cases: { name: string; coin: string; szi: number; side: 'long' | 'short'; copyQty: number; args: string[] }[] = [
    { name: 'close signal, long', coin: 'SOL', szi: 0.5, side: 'long', copyQty: 0.5, args: [closeSig()] },
    { name: 'close signal, short', coin: 'ETH', szi: -0.25, side: 'short', copyQty: 0.25, args: [closeSig('ETH')] },
    { name: 'coin + mimicMeta', coin: 'SOL', szi: 0.5, side: 'long', copyQty: 0.5, args: ['SOL', JSON.stringify(ident('alice', 't1'))] },
    { name: 'decrease to zero', coin: 'SOL', szi: 0.5, side: 'long', copyQty: 0.5, args: [decreaseSig(10, 0)] },
    { name: 'manual, long', coin: 'SOL', szi: 0.7, side: 'long', copyQty: 0.7, args: ['SOL', 'manual'] },
    { name: 'manual, short', coin: 'ETH', szi: -0.4, side: 'short', copyQty: 0.4, args: ['ETH', 'manual'] },
  ];
  for (const c of cases) {
    const hl = fakeHl({ positions: { [c.coin]: c.szi } });
    const ledger = new MemoryLedgerStore([copyEntry('tx-a', c.coin, c.copyQty, 'alice', 't1', c.side)]);
    const out = await runClose(c.args, depsFor(hl, ledger));
    assert.equal(out.status, 'closed', c.name);
    assertCloseOrders(hl, c.szi, c.copyQty);
    assert.equal(hl.positions[c.coin], 0, `${c.name}: flat afterwards`);
  }
});

// --- 2. Partial closes are reduce-only ---

test('2: a partial close (trader decrease) is reduce-only, on the closing side, the trader\'s fraction of our copy', async () => {
  for (const [side, szi] of [['long', 1.0], ['short', -1.0]] as const) {
    const hl = fakeHl({ positions: { SOL: szi } });
    const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 1.0, 'alice', 't1', side)]);
    const out = await runClose([decreaseSig(10, 6)], depsFor(hl, ledger)); // trader closed 40%
    assert.equal(out.status, 'decreased', side);
    assertCloseOrders(hl, szi, 1.0);
    assert.deepEqual(hl.orders.map(o => o.size), ['0.40']);
    assert.equal(Math.abs(hl.positions.SOL), 0.6, `${side}: same side, smaller`);
    assert.equal(Math.sign(hl.positions.SOL), Math.sign(szi));
  }
});

// --- 3. A close never exceeds the tracked copy ---

test('3: a close takes only the tracked copy, even when the coin position is larger (other copies, manual, outside)', async () => {
  // alice 0.5 + bob 0.3 tracked, plus 1.2 opened outside this tool
  const hl = fakeHl({ positions: { SOL: 2.0 } });
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1'), copyEntry('tx-b', 'SOL', 0.3, 'bob', 't2')]);
  const out = await runClose([closeSig()], depsFor(hl, ledger));
  assert.equal(out.status, 'closed');
  assertCloseOrders(hl, 2.0, 0.5);
  assert.deepEqual(hl.orders.map(o => o.size), ['0.50']);
  assert.equal(hl.positions.SOL, 1.5);
});

test('3: a decrease can never close more than the copy: fraction capped at 1, over-sized $ figures refused', async () => {
  // The trader's figures say they removed more than the trade held: refused before any order
  const bad = { ...notionalFor('decrease', 0.5, 'inv'), simDifference: 150, entrySimAfter: 0 };
  const hl = fakeHl({ positions: { SOL: 1.0 } });
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 1.0, 'alice', 't1')]);
  const out = await runClose([decreaseSig(10, 5, { notional: bad })], depsFor(hl, ledger));
  assert.equal(out.status, 'refused');
  assert.deepEqual(hl.orders, []);

  // A 99.6% decrease of a 1.0 copy is floored to the lot size, never rounded up past the copy
  const hl2 = fakeHl({ positions: { SOL: 1.0 } });
  const out2 = await runClose([decreaseSig(10, 0.04)], depsFor(hl2, new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 1.0, 'alice', 't1')])));
  assert.ok(out2.status === 'decreased' || out2.status === 'closed');
  assertCloseOrders(hl2, 1.0, 1.0);
});

// --- 4. A close can't flip the position ---

test('4: a copy larger than what is left closes only what is left — never past zero', async () => {
  const hl = fakeHl({ positions: { SOL: 0.4 } });
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')]);
  const out = await runClose([closeSig()], depsFor(hl, ledger));
  assert.equal(out.status, 'closed');
  assertCloseOrders(hl, 0.4, 0.4);
  assert.equal(hl.positions.SOL, 0);
});

test('4: a position already flat or on the other side gets no order at all (reconciled, never re-opened)', async () => {
  for (const szi of [0, -0.3]) {
    const hl = fakeHl({ positions: { SOL: szi } });
    const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')]);
    const out = await runClose([closeSig()], depsFor(hl, ledger));
    assert.equal(out.status, 'already_closed', `szi ${szi}`);
    assert.deepEqual(hl.orders, [], `szi ${szi}: no order`);
    assert.equal(hl.positions.SOL ?? 0, szi);
  }
});

test('4: a position that shrinks between the snapshot and the fill is closed, not flipped (reduce-only)', async () => {
  const hl = fakeHl({ positions: { SOL: 0.5 }, beforeOrder: p => { p.SOL = 0.2; } });
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')]);
  await runClose([closeSig()], depsFor(hl, ledger));
  assert.equal(hl.orders.length, 1);
  assert.equal(hl.orders[0].reduceOnly, true);
  assert.equal(hl.orders[0].isBuy, false);
  assert.equal(hl.positions.SOL, 0);
});

// --- 5. Malformed or ambiguous close signals are refused, never guessed ---

test('5: malformed, mismatched or ambiguous closes are refused without any order', async () => {
  const meta = ident('alice', 't1');
  const { creatorInvoUserId, ...noTrader } = meta;
  const { sourcePaperTradeBaseId, sourcePaperTradeBaseShortId, ...noTradeIds } = meta;
  const cases: { name: string; args: string[]; ledger?: ReturnType<typeof copyEntry>[] }[] = [
    { name: 'invalid JSON signal', args: ['{not json'] },
    { name: 'unknown action', args: [JSON.stringify({ type: 'signal', action: 'reverse', trade: { coin: 'SOL' }, mimicMeta: meta })] },
    { name: 'informational update', args: [JSON.stringify({ type: 'signal', action: 'update', trade: { coin: 'SOL' }, mimicMeta: meta })] },
    { name: 'close with no coin', args: [JSON.stringify({ type: 'signal', action: 'close', trade: {}, mimicMeta: meta })] },
    { name: 'close with no mimicMeta', args: [JSON.stringify({ type: 'signal', action: 'close', trade: { coin: 'SOL' } })] },
    { name: 'close with no trader id', args: [JSON.stringify({ type: 'signal', action: 'close', trade: { coin: 'SOL' }, mimicMeta: noTrader })] },
    { name: 'close with no trade id', args: [JSON.stringify({ type: 'signal', action: 'close', trade: { coin: 'SOL' }, mimicMeta: noTradeIds })] },
    { name: 'another trader\'s close', args: [closeSig('SOL', 'mallory', 't1')] },
    { name: 'same trader, other trade', args: [closeSig('SOL', 'alice', 't9')] },
    { name: 'same trade, other coin', args: [closeSig('ETH')] },
    { name: 'manual entry never matched by a signal', args: [closeSig()], ledger: [copyEntry('tx-m', 'SOL', 0.5, null)] },
    { name: 'two entries for the same trade (ambiguous)', args: [closeSig()], ledger: [copyEntry('tx-a', 'SOL', 0.3, 'alice', 't1'), copyEntry('tx-a2', 'SOL', 0.2, 'alice', 't1')] },
    { name: 'decrease with inconsistent sizes', args: [JSON.stringify({ ...JSON.parse(decreaseSig(10, 6)), change: { positionSizeBefore: 10, positionSizeAfter: 6, positionSizeChange: 3 } })] },
    { name: 'decrease that did not shrink', args: [decreaseSig(10, 10)] },
    { name: 'decrease without $ figures', args: [decreaseSig(10, 6, { notional: null })] },
    { name: 'decrease whose $ figures describe an increase', args: [decreaseSig(10, 6, { notional: notionalFor('increase', 0.4, 'inv') })] },
    { name: 'decrease whose $ figures are for another change', args: [decreaseSig(10, 6, { notional: notionalFor('decrease', 0.4, 'other-inv') })] },
    { name: 'tpsl signal sent to close', args: [tpslSig] },
    { name: 'coin with no identity', args: ['SOL', ''] },
    { name: 'identity not JSON', args: ['SOL', '{oops'] },
  ];
  for (const c of cases) {
    const hl = fakeHl({ positions: { SOL: 0.5, ETH: 0.5 } });
    const ledger = new MemoryLedgerStore(c.ledger ?? [copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')]);
    const out = await runClose(c.args, depsFor(hl, ledger));
    assert.equal(out.status, 'refused', c.name);
    assert.ok(!hl.calls.includes('placeMarketOrder'), `${c.name}: no order`);
  }
});

// --- 6. TP/SL-only updates are never opens or closes ---

test('6: a feed post that only changes TP/SL is an informational update, never an open or close', () => {
  for (const changes of [{ priceTarget: 120 }, { stopLoss: 80 }, { priceTarget: 120, stopLoss: 80 }, { isAdded: false, priceTarget: 120 }, {}, null]) {
    assert.equal(signalAction({ isOpen: true, changes }), 'update', JSON.stringify(changes));
  }
  assert.equal(signalAction({ isOpen: true, changes: { isAdded: false } }), 'open'); // only exactly this is a new trade
  assert.equal(signalAction({ isOpen: false, changes: { priceTarget: 120 } }), 'close'); // a closed trade is a close
  assert.throws(() => parseTradeSignal(JSON.stringify({ type: 'signal', action: 'update', trade: { coin: 'SOL' } })), /informational/);
  assert.equal(parseTradeSignal(tpslSig).kind, 'tpsl');
});

test('6: a tpsl signal is refused by trade.ts and close.ts — no order, no leverage change', async () => {
  const hl = fakeHl({ positions: { SOL: 0.5 } });
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'SOL', 0.5, 'alice', 't1')]);
  await assert.rejects(() => runTrade([tpslSig], depsFor(hl, ledger)), /goes to tpsl\.ts/);
  const out = await runClose([tpslSig], depsFor(hl, ledger));
  assert.equal(out.status, 'refused');
  assert.deepEqual(hl.orders, []);
  assert.deepEqual(hl.leverage, []);
  assert.equal(hl.positions.SOL, 0.5);
});

// --- 7. Sizing limits unchanged ---

test('7: the 5–15% sizing range, tier percentages, 80% increase cap and 80% combined cap are unchanged', () => {
  assert.equal(MIN_EQUITY_PCT, 5);
  assert.equal(MAX_EQUITY_PCT, 15);
  assert.deepEqual({ ...TIER_EQUITY_PCT }, { poor: 5, averageShortStreak: 7.8, averageLongStreak: 10.4, strong: 15 });
  assert.equal(MAX_INCREASE_FRACTION, 0.8);
  assert.equal(MAX_COMBINED_EQUITY_PCT, 80);
  const r = copyRange(1000);
  assert.equal(r.minUsd, 50);
  assert.equal(r.maxUsd, 150);
});
