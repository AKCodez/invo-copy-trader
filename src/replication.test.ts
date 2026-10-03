// Copies replicate the trader's trade: entry price, TP/SL, increases, partial
// closes, closes and liquidations. Only the size is ours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { runTpsl } from './tpsl-exec.js';
import { entryBoundPx, assertExactPerpPrice, assertTriggerSide } from './sizing.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry, notionalFor } from './test-fakes.js';
import type { CopyEntry } from './copy-ledger.js';

const NOW = new Date('2026-10-02T12:00:00Z');
let ids = 0;
type HlOpts = NonNullable<Parameters<typeof fakeHl>[0]>;
function setup(opts: HlOpts & { ledger?: MemoryLedgerStore } = {}) {
  const { ledger: givenLedger, ...hlOpts } = opts;
  const hl = fakeHl(hlOpts);
  const invo = fakeInvo();
  const ledger = givenLedger ?? new MemoryLedgerStore();
  const deps = { hl, invo, ledger, newId: () => `tx-${++ids}`, newCloid: () => `0xcloid${++ids}`, now: () => NOW };
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
const openSig = (trade: Record<string, unknown> = {}, trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', action: 'open', postedAt: '2026-10-02T11:59:40.000Z',
  trade: { coin: 'SOL', side: 'long', leverage: 5, entryPrice: 100, isOpen: true, priceTarget: null, stopLoss: null, openedAt: '2026-10-02T11:59:30.000Z', ...trade },
  mimicMeta: signalMeta(trader, tradeId),
});
const tpslSig = (which: 'tp' | 'sl', triggerPx: number | null, updatedAt = '2026-10-02T11:59:50.000Z', trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'tpsl', updateId: `${tradeId}_${which}_${updatedAt}`, investmentId: 'inv', updatedAt,
  trade: { coin: 'SOL', side: 'long' }, change: { which, triggerPx }, mimicMeta: ident(trader, tradeId),
});
const decreaseSig = (before: number, after: number, updatedAt = '2026-10-02T11:59:50.000Z', trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'decrease', updateId: `${tradeId}_dec_${updatedAt}`, investmentId: 'inv', updatedAt,
  trade: { coin: 'SOL', side: 'long' },
  change: { positionSizeBefore: before, positionSizeAfter: after, positionSizeChange: before - after, notional: notionalFor('decrease', (before - after) / before, 'inv') },
  mimicMeta: ident(trader, tradeId),
});
const closeSig = (reasonClosed: string, trader = 'alice', tradeId = 't1') => JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'close', reasonClosed,
  trade: { coin: 'SOL', side: 'long', isOpen: false }, mimicMeta: ident(trader, tradeId),
});
const held = (qty: number, extra: Partial<CopyEntry> = {}): CopyEntry => ({ ...copyEntry('tx-a', 'SOL', qty, 'alice', 't1'), leverage: 5, ...extra });

// --- Entry price ---

test('entryBoundPx: never more than the slippage allowance worse than the trader\'s entry', () => {
  assert.equal(entryBoundPx(101, 100, true), 100); // market above their buy: limit from their entry
  assert.equal(entryBoundPx(99, 100, true), 99); // better than their entry: market
  assert.equal(entryBoundPx(99, 100, false), 100);
  assert.equal(entryBoundPx(101, 100, false), 101);
  assert.equal(entryBoundPx(102, 100, true), 100); // exactly at the allowance
  assert.throws(() => entryBoundPx(102.5, 100, true), /moved 2\.50% against the trader's entry/);
  assert.throws(() => entryBoundPx(97.5, 100, false), /moved 2\.50% against/);
});

test('a copy is refused before leverage or any order when the price ran away from the trader\'s entry', async () => {
  const { hl, ledger, trade } = setup({ mids: { SOL: 103 } });
  await assert.rejects(trade(openSig()), /moved 3\.00% against the trader's entry/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.saves, 0);
});

test('a copy above the trader\'s entry is limited at their entry + 2%, and sized there', async () => {
  const { hl, trade } = setup({ mids: { SOL: 101 } });
  const out = await trade(openSig());
  assert.equal(out.status, 'filled');
  assert.equal(hl.orders[0].midPx, 100);
  assert.deepEqual([out.sizing.mid, out.sizing.orderPx, out.sizing.limitPx], [101, 100, 102]);
  assert.deepEqual(out.trader, { entryPrice: 100, tp: null, sl: null });
});

// --- TP/SL at open ---

test('the trader\'s TP and SL are placed as position TP/SL after the fill, at their exact prices', async () => {
  const { hl, invo, ledger, trade } = setup();
  const out = await trade(openSig({ priceTarget: 112.5, stopLoss: 95.25 }));
  assert.equal(out.status, 'filled');
  assert.deepEqual(hl.tpslOrders.map(o => [o.which, o.triggerPx, o.isLong, o.coin]), [['tp', 112.5, true, 'SOL'], ['sl', 95.25, true, 'SOL']]);
  assert.ok(hl.calls.indexOf('placeMarketOrder') < hl.calls.indexOf('placePositionTpsl:tp'));
  assert.deepEqual(out.tpsl!.outcomes!.map(o => [o.which, o.status]), [['tp', 'active'], ['sl', 'active']]);
  assert.equal(out.tpsl!.error, undefined);
  const e = ledger.entries[0];
  assert.deepEqual([e.tpsl?.tp?.triggerPx, e.tpsl?.tp?.status, e.tpsl?.sl?.triggerPx, e.tpsl?.sl?.status], [112.5, 'active', 95.25, 'active']);
  assert.deepEqual([invo.recorded[0].entry.tpPx, invo.recorded[0].entry.slPx], ['112.5', '95.25']);
  assert.equal(e.traderOpenedAt, '2026-10-02T11:59:30.000Z');
});

test('a short\'s TP is below and SL above; a TP/SL already crossed by the price is refused before anything changes', async () => {
  const short = setup();
  const out = await short.trade(openSig({ side: 'short', priceTarget: 90, stopLoss: 104 }));
  assert.deepEqual(short.hl.tpslOrders.map(o => [o.which, o.isLong]), [['tp', false], ['sl', false]]);
  assert.equal(out.status, 'filled');

  for (const trade of [{ priceTarget: 99 }, { stopLoss: 101 }, { side: 'short', priceTarget: 101 }]) {
    const { hl, ledger, trade: run } = setup();
    await assert.rejects(run(openSig(trade)), /would trigger immediately; not replicated/, JSON.stringify(trade));
    assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
    assert.equal(ledger.saves, 0);
  }
});

test('a TP/SL Hyperliquid can\'t take at the exact price is refused, never rounded', async () => {
  assert.throws(() => assertExactPerpPrice(100.12345, 2, 'tp'), /max 5 significant figures and 4 decimals/);
  assert.throws(() => assertExactPerpPrice(1234.5678, 0, 'tp'), /can't be placed/);
  assert.doesNotThrow(() => assertExactPerpPrice(123456, 5, 'tp')); // integers always pass
  assert.doesNotThrow(() => assertExactPerpPrice(0.065978, 0, 'tp'));
  assert.doesNotThrow(() => assertTriggerSide('sl', 95, 100, true));

  const { hl, trade } = setup();
  await assert.rejects(trade(openSig({ priceTarget: 110.12345 })), /not rounding the trader's price/);
  assert.deepEqual(hl.calls, ['connect', 'getMeta']);
});

test('a trader TP/SL can\'t be replicated on a coin position other trades share: refused', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-bob', 'SOL', 0.5, 'bob', 't2')]);
  const { hl, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  await assert.rejects(trade(openSig({ priceTarget: 110 })), /a Hyperliquid TP\/SL would close those too/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('a coin whose position has TP/SL orders takes no new position (they would act on it too)', async () => {
  const ledger = new MemoryLedgerStore([held(0.5)]);
  const triggers = [{ coin: 'SOL', cloid: '0xtp', isTrigger: true, orderType: 'Take Profit Market' }];
  const { hl, trade } = setup({ positions: { SOL: 0.5 }, ledger, openOrders: triggers });
  await assert.rejects(trade(openSig({}, 'bob', 't2')), /SOL has TP\/SL orders on the position/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('a TP/SL Hyperliquid rejects after the fill is reported as not replicated (non-zero exit), the copy stays recorded', async () => {
  const { ledger, trade } = setup({ rejectTpsl: true });
  const out = await trade(openSig({ priceTarget: 110 }));
  assert.equal(out.status, 'filled');
  assert.match(out.tpsl!.error!, /not fully replicated — retry with tpsl\.ts/);
  assert.match((out.tpsl!.outcomes![0] as any).error, /Invalid TP\/SL price/);
  assert.equal(ledger.entries[0].status, 'open');
  assert.equal(ledger.entries[0].tpsl?.tp, undefined);
});

// --- tpsl.ts: the trader's later TP/SL changes ---

test('a trader moving their TP replaces ours: old cancelled, new placed, the change recorded once', async () => {
  const s = setup();
  await s.trade(openSig({ priceTarget: 110 }));
  const oldCloid = s.ledger.entries[0].tpsl!.tp!.cloid;

  const out = await s.tpsl(tpslSig('tp', 115));
  assert.equal(out.status, 'applied');
  assert.deepEqual(s.hl.cancels, [oldCloid]);
  assert.deepEqual(s.hl.tpslOrders.map(o => o.triggerPx), [110, 115]);
  const e = s.ledger.entries[0];
  assert.deepEqual([e.tpsl!.tp!.triggerPx, e.tpsl!.tp!.status, e.tpsl!.tp!.traderUpdatedAt], [115, 'active', '2026-10-02T11:59:50.000Z']);
  assert.ok(e.sourceUpdateIds!.includes('t1_tp_2026-10-02T11:59:50.000Z'));

  const again = await s.tpsl(tpslSig('tp', 115));
  assert.equal(again.status, 'refused');
  assert.match((again as any).reason, /already applied/);

  // An older change arriving late doesn't override the newer one
  const older = await s.tpsl(tpslSig('tp', 120, '2026-10-02T11:59:40.000Z'));
  assert.equal(older.status, 'unchanged');
  assert.equal(s.ledger.entries[0].tpsl!.tp!.triggerPx, 115);
});

test('a trader setting an SL after we copied adds one; an open signal re-applies a TP/SL that failed', async () => {
  const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.equal((await s.tpsl(tpslSig('sl', 95))).status, 'applied');
  assert.deepEqual(s.hl.tpslOrders.map(o => [o.which, o.triggerPx]), [['sl', 95]]);

  const r = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  const out = await r.tpsl(openSig({ priceTarget: 110, stopLoss: 95 }));
  assert.equal(out.status, 'applied');
  assert.deepEqual(r.hl.tpslOrders.map(o => o.which), ['tp', 'sl']);
});

test('tpsl.ts refuses what it can\'t replicate exactly', async () => {
  // Shared coin position
  const shared = setup({ positions: { SOL: 1.5 }, ledger: new MemoryLedgerStore([held(1), copyEntry('tx-bob', 'SOL', 0.5, 'bob', 't2')]) });
  assert.match((await shared.tpsl(tpslSig('tp', 110)) as any).reason, /also holds trader bob's copy/);
  // Position bigger than the copy (something outside the ledger)
  const outside = setup({ positions: { SOL: 2 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.match((await outside.tpsl(tpslSig('tp', 110)) as any).reason, /isn't just this copy/);
  // A TP on the coin we didn't place
  const foreign = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]), openOrders: [{ coin: 'SOL', cloid: '0xother', isTrigger: true, orderType: 'Take Profit Market' }] });
  assert.match((await foreign.tpsl(tpslSig('tp', 110)) as any).reason, /didn't place/);
  // Already crossed
  const crossed = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.match((await crossed.tpsl(tpslSig('sl', 101)) as any).reason, /would trigger immediately/);
  // A removal (no price): how Invo reports it hasn't been seen — not guessed
  const removed = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.match((await removed.tpsl(tpslSig('tp', null)) as any).reason, /no tp trigger price .* not replicated/);
  // No copy of the trade
  const none = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  assert.match((await none.tpsl(tpslSig('tp', 110, undefined, 'carol', 't9')) as any).reason, /no open SOL copy/);

  for (const s of [shared, outside, foreign, crossed, removed, none]) {
    assert.deepEqual([s.hl.tpslOrders, s.hl.cancels], [[], []]);
  }
});

// --- Decreases (the trader's partial closes) ---

test('a trader\'s partial close closes the same fraction of our copy, once', async () => {
  const s = setup({ positions: { SOL: 2 }, ledger: new MemoryLedgerStore([held(2)]) });
  const out = await s.close(decreaseSig(0.1, 0.075)); // trader closed 25%
  assert.equal(out.status, 'decreased');
  assert.deepEqual([Number((out as any).fraction.toFixed(9)), (out as any).closedQty, (out as any).copyQtyLeft], [0.25, 0.5, 1.5]);
  assert.equal(s.hl.orders[0].reduceOnly, true);
  assert.equal(s.hl.positions.SOL, 1.5);
  assert.equal(s.ledger.entries[0].status, 'open');

  const again = await s.close(decreaseSig(0.1, 0.075));
  assert.equal(again.status, 'refused');
  assert.match((again as any).reason, /already copied/);
  assert.equal(s.hl.orders.length, 1);
});

test('a decrease leaves other copies in the coin alone, and a full decrease closes the copy', async () => {
  const s = setup({ positions: { SOL: 3 }, ledger: new MemoryLedgerStore([held(2), copyEntry('tx-bob', 'SOL', 1, 'bob', 't2')]) });
  assert.equal((await s.close(decreaseSig(0.2, 0.1))).status, 'decreased');
  assert.equal(s.hl.positions.SOL, 2);
  const all = await s.close(decreaseSig(0.1, 0, '2026-10-02T11:59:55.000Z'));
  assert.equal(all.status, 'closed');
  assert.deepEqual(s.ledger.entries.map(e => [e.id, e.status, e.qty]), [['tx-a', 'closed', 0], ['tx-bob', 'open', 1]]);
  assert.equal(s.hl.positions.SOL, 1);
});

test('a decrease under Hyperliquid\'s $10 minimum is refused, not rounded up', async () => {
  const s = setup({ positions: { SOL: 0.5 }, ledger: new MemoryLedgerStore([held(0.5)]) }); // $50 copy
  const out = await s.close(decreaseSig(0.1, 0.09)); // 10% = $5
  assert.equal(out.status, 'refused');
  assert.match((out as any).reason, /below Hyperliquid's \$10 minimum order/);
  assert.deepEqual(s.hl.orders, []);
});

test('a decrease that filled nothing can be retried', async () => {
  const s = setup({ positions: { SOL: 2 }, ledger: new MemoryLedgerStore([held(2)]), fillRatio: 0 });
  assert.equal((await s.close(decreaseSig(0.1, 0.05))).status, 'not_filled');
  assert.deepEqual(s.ledger.entries[0].sourceUpdateIds, ['upd-t1']);
  const retry = await runClose([decreaseSig(0.1, 0.05)], { ...s.deps, hl: fakeHl({ positions: { SOL: 2 } }) });
  assert.equal(retry.status, 'decreased');
});

// --- Closes and liquidations ---

test('a close signal (incl. a liquidation) closes the copy and reports the trader\'s reason', async () => {
  for (const reason of ['user_closed', 'take_profit_hit', 'stop_loss_hit', 'liquidated']) {
    const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
    const out = await s.close(closeSig(reason));
    assert.deepEqual([out.status, (out as any).traderReason], ['closed', reason], reason);
    assert.equal(s.hl.positions.SOL, 0);
  }
});

test('if our own TP/SL already closed the position, the trader\'s close finds it gone and places nothing', async () => {
  const s = setup({ ledger: new MemoryLedgerStore([held(1, { tpsl: { tp: { triggerPx: 110, cloid: '0xtp', status: 'active', traderUpdatedAt: '' } } })]) });
  const out = await s.close(closeSig('take_profit_hit'));
  assert.equal(out.status, 'already_closed');
  assert.deepEqual(s.hl.orders, []);
});

test('signals go to the right command; the wrong one refuses without touching anything', async () => {
  const s = setup({ positions: { SOL: 1 }, ledger: new MemoryLedgerStore([held(1)]) });
  await assert.rejects(s.trade(decreaseSig(0.1, 0.05)), /goes to close\.ts/);
  await assert.rejects(s.trade(tpslSig('tp', 110)), /goes to tpsl\.ts/);
  assert.match((await s.close(openSig()) as any).reason, /goes to trade\.ts/);
  assert.match((await s.tpsl(closeSig('user_closed')) as any).reason, /takes a tpsl or open signal/);
  assert.deepEqual([s.hl.orders, s.hl.tpslOrders], [[], []]);
});
