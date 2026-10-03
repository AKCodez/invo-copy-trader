import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrade, UsageError } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry, notionalFor } from './test-fakes.js';

let ids = 0;
type HlOpts = NonNullable<Parameters<typeof fakeHl>[0]>;
function setup(opts: HlOpts & { ledger?: MemoryLedgerStore; failRecordOpen?: boolean } = {}) {
  const { ledger: givenLedger, failRecordOpen, ...hlOpts } = opts;
  const hl = fakeHl(hlOpts);
  const invo = fakeInvo({ failRecordOpen });
  const ledger = givenLedger ?? new MemoryLedgerStore();
  const deps = {
    hl, invo, ledger,
    newId: () => `tx-${++ids}`,
    newCloid: () => `0xcloid${ids}`,
    now: () => new Date('2026-10-02T12:00:00Z'),
  };
  return { hl, invo, ledger, deps, trade: (args: (string | undefined)[]) => runTrade(args as string[], deps) };
}
const meta = (trader: string, trade: string, update = trade) => JSON.stringify(signalMeta(trader, trade, update));
const MIDS: Record<string, number> = { SOL: 100, BTC: 60000, ETH: 3000 };
/** trade.ts's argument for a trader's open signal (entry at the fake mid, no TP/SL unless given). */
const open = (coin: string, side: 'long' | 'short', leverage: number, trader: string, tradeId: string, trade: Record<string, unknown> = {}) =>
  [openSignal(coin, side, leverage, trader, tradeId, trade)];
function openSignal(coin: string, side: 'long' | 'short', leverage: number, trader: string, tradeId: string, trade: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'signal', source: 'feed', action: 'open', postedAt: '2026-10-02T11:59:40.000Z',
    trade: { coin, side, leverage, entryPrice: MIDS[coin], isOpen: true, priceTarget: null, stopLoss: null, openedAt: '2026-10-02T11:59:30.000Z', ...trade },
    mimicMeta: signalMeta(trader, tradeId),
  });
}
/** trade.ts's argument for a /dex/trade increase of `trader`'s trade: their position grew by `ratio`. */
const increase = (trader: string, tradeId: string, ratio: number, updatedAt = '2026-10-02T11:59:00.000Z', coin = 'SOL') => [JSON.stringify({
  type: 'signal', source: 'trade_poll', action: 'increase', updateId: `${tradeId}_inv-${updatedAt}_increase`, investmentId: `inv-${updatedAt}`, updatedAt,
  trade: { coin, side: 'long' },
  change: { positionSizeBefore: 0.1, positionSizeAfter: 0.1 * (1 + ratio), positionSizeChange: 0.1 * ratio, notional: notionalFor('increase', ratio, `inv-${updatedAt}`) },
  mimicMeta: { ...signalMeta(trader, tradeId), initialSourcePaperUpdateId: undefined },
})];

// --- mimicMeta / argument validation: nothing is touched on failure ---

test('a copy is only run from the trader\'s signal: positional coin/side/leverage with a mimicMeta is refused', async () => {
  for (const arg of [meta('alice', 't1'), undefined, '']) {
    const { hl, invo, ledger, trade } = setup();
    await assert.rejects(trade(['SOL', 'long', 'auto', '5', arg]), /run from the trader's signal|pass the whole signal/);
    assert.deepEqual([hl.calls, invo.calls, ledger.saves], [[], [], 0]);
  }
});

test('an incomplete or invalid signal is refused before HL, Invo or the ledger are touched', async () => {
  const { sourcePaperTradeBaseShortId, ...noShortId } = signalMeta('alice', 't1');
  const sig = (patch: (s: any) => void) => {
    const s = JSON.parse(openSignal('SOL', 'long', 5, 'alice', 't1'));
    patch(s);
    return JSON.stringify(s);
  };
  const cases: [string, string, RegExp][] = [
    ['not JSON', '{oops', /not valid JSON/],
    ['missing trader baseShortId', sig(s => { s.mimicMeta = noShortId; }), /missing sourcePaperTradeBaseShortId/],
    ['no leverage', sig(s => { delete s.trade.leverage; }), /trade\.leverage must be a whole number/],
    ['fractional leverage', sig(s => { s.trade.leverage = 2.5; }), /trade\.leverage must be a whole number/],
    ['leverage as text', sig(s => { s.trade.leverage = '5'; }), /trade\.leverage must be a whole number/],
    ['no side', sig(s => { delete s.trade.side; }), /trade\.side must be/],
    ['no entry price', sig(s => { s.trade.entryPrice = null; }), /no trade\.entryPrice/],
    ['TP unknown', sig(s => { delete s.trade.priceTarget; }), /no trade\.priceTarget — can't tell/],
    ['SL unknown', sig(s => { delete s.trade.stopLoss; }), /no trade\.stopLoss — can't tell/],
    ['bad TP', sig(s => { s.trade.priceTarget = -1; }), /not a positive price/],
    ['update signal', sig(s => { s.action = 'update'; }), /informational/],
    ['close signal', sig(s => { s.action = 'close'; }), /goes to close\.ts/],
  ];
  for (const [name, arg, err] of cases) {
    const { hl, invo, ledger, trade } = setup();
    await assert.rejects(trade([arg]), err, name);
    assert.deepEqual([hl.calls, invo.calls, ledger.saves], [[], [], 0], name);
  }
});

test('the trader\'s leverage is used as is: over the asset max is refused before any order', async () => {
  const { hl, invo, trade } = setup();
  await assert.rejects(trade(open('SOL', 'long', 21, 'alice', 't1')), /exceeds SOL max of 20x/);
  assert.deepEqual(hl.calls, ['connect', 'getMeta']);
  assert.deepEqual(invo.calls, []);

  const ok = setup();
  const out = await ok.trade(open('SOL', 'short', 7, 'alice', 't1'));
  assert.deepEqual([out.status, out.leverage, out.side, ok.hl.leverage], ['filled', 7, 'short', [['SOL', 7]]]);
  assert.equal(ok.hl.orders[0].isBuy, false);
  assert.equal(ok.invo.recorded[0].entry.leverage, 7);
  assert.equal(ok.ledger.entries[0].leverage, 7);
});

test('manual trades: bad leverage is refused before anything is touched', async () => {
  for (const lev of [undefined, 'abc', '0', '2.5']) {
    const { hl, invo, trade } = setup();
    await assert.rejects(trade(['SOL', 'long', 'auto', lev, 'manual']), /leverage must be a whole number/);
    assert.deepEqual([hl.calls, invo.calls], [[], []]);
  }
});

test('bad coin/side is a usage error', async () => {
  const { hl, trade } = setup();
  await assert.rejects(trade([]), UsageError);
  await assert.rejects(trade(['SOL', 'up', 'auto', '5', 'manual']), UsageError);
  assert.deepEqual(hl.calls, []);
});

test('an unreadable ledger is refused before trading', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failLoad = true;
  const { hl, invo, trade } = setup({ ledger });
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /unreadable/);
  assert.deepEqual([hl.calls, invo.calls], [[], []]);
});

test('an opposite-direction position is refused before leverage or orders', async () => {
  const { hl, trade } = setup({ positions: { SOL: -0.5 } });
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /existing position is short/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
});

// --- Leverage is per coin: never change it under an existing position ---

test('adding to a position at a different leverage is refused before leverage, ledger or orders change', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, invo, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: { type: 'isolated', value: 3 } }, ledger });
  await assert.rejects(trade(open('SOL', 'long', 20, 'bob', 't2')),
    /Refusing 20x on SOL: the existing SOL position is 3x isolated.*the trader's 20x can't be replicated/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.saves, 0);
});

test('an existing position that is cross, or whose leverage can\'t be read, is refused', async () => {
  for (const lev of [{ type: 'cross', value: 5 }, undefined, { type: 'isolated' }, { type: 'isolated', value: NaN }]) {
    const { hl, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: lev } });
    await assert.rejects(trade(open('SOL', 'long', 5, 'bob', 't2')), /leverage can't be confirmed as isolated/, JSON.stringify(lev));
    assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'), JSON.stringify(lev));
  }
});

test('another trader at the existing leverage joins the position as its own initial-size copy; a new position sets its own', async () => {
  const { hl, trade } = setup({ positions: { SOL: 0.5 }, positionLeverage: { SOL: { type: 'isolated', value: 3 } } });
  const add = await trade(open('SOL', 'long', 3, 'bob', 't2'));
  assert.equal(add.status, 'filled');
  assert.equal(add.sizing.mode, 'initial');
  assert.deepEqual(hl.leverage, [['SOL', 3]]);

  const fresh = setup();
  assert.equal((await fresh.trade(open('ETH', 'long', 10, 'carol', 't3'))).status, 'filled');
  assert.deepEqual(fresh.hl.leverage, [['ETH', 10]]);
  // The next copy in ETH must now match 10x
  await assert.rejects(fresh.trade(open('ETH', 'long', 5, 'dave', 't4')), /existing ETH position is 10x isolated/);
});

// --- Price freshness ---

test('size and limit come from the price fetched after the slow steps, so a short stays within 15% of equity', async () => {
  const { hl, invo, trade } = setup();
  // The price rises 10% while the Invo stats lookup is in flight
  const lookup = invo.getPortfolioById.bind(invo);
  invo.getPortfolioById = async (id: string) => { hl.mids.SOL = 110; return lookup(id); };

  const out = await trade(open('SOL', 'short', 5, 'alice', 't1'));
  assert.equal(out.status, 'filled');
  assert.equal(hl.orders[0].midPx, 110);
  assert.equal(out.sizing.mid, 110);
  // Equity $784 → max $117.60. Sized at the old $100 it would be 1.15 SOL: $129.03 at a $112.20 fill
  assert.ok(parseFloat(out.size) * 110 * 1.02 <= 117.6 + 1e-9, `${out.size} SOL at up to $112.20`);
  // Price fetched after the stats lookup and the leverage change, right before the order
  const at = (c: string) => hl.calls.lastIndexOf(c);
  assert.ok(at('setLeverage') < at('getAllMids') && at('getAllMids') < at('placeMarketOrder'), hl.calls.join(' '));
});

// --- Account-percentage sizing ---

test('a new copy is the trader\'s tier % of current equity, within 5%–15%', async () => {
  // Strong trader (fake stats) → 15%; manual → poor tier → 5%
  for (const [args, pct] of [[open('SOL', 'long', 5, 'alice', 't1'), 15], [['SOL', 'long', 'auto', '5', 'manual'], 5]] as const) {
    const { hl, trade } = setup({ equity: 2000 });
    const out = await trade([...args]);
    assert.equal(out.status, 'filled');
    assert.deepEqual(
      [out.sizing.equityUsd, out.sizing.tierPct, out.sizing.minUsd, out.sizing.maxUsd, out.sizing.targetUsd],
      [2000, pct, 100, 300, 2000 * pct / 100]);
    // Worst-case fill within [$100, $300]
    assert.ok(out.sizing.minFillNotionalUsd >= 100 && out.sizing.maxFillNotionalUsd <= 300, JSON.stringify(out.sizing));
    assert.equal(hl.orders.length, 1);
  }
});

test('equity is read fresh, after the slow steps, so a balance change during the stats lookup is used', async () => {
  const { hl, invo, trade } = setup({ equity: 2000 });
  const lookup = invo.getPortfolioById.bind(invo);
  invo.getPortfolioById = async (id: string) => { hl.equity = 1000; return lookup(id); };
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.sizing.equityUsd, 1000);
  assert.ok(out.sizing.maxFillNotionalUsd <= 150, `${out.sizing.maxFillNotionalUsd} > 15% of $1,000`);
  const at = (c: string) => hl.calls.lastIndexOf(c);
  assert.ok(at('setLeverage') < at('getAccountEquity') && at('getAccountEquity') < at('placeMarketOrder'), hl.calls.join(' '));
});

test('a small account copies at least HL\'s $10 minimum; under $66.67 of equity it can\'t copy', async () => {
  const small = setup({ equity: 150 }); // 5% = $7.50 → floor $10; max 15% = $22.50
  const out = await small.trade(['SOL', 'long', 'auto', '5', 'manual']);
  assert.equal(out.status, 'filled');
  assert.deepEqual([out.sizing.minUsd, out.sizing.maxUsd], [10, 22.5]);
  assert.ok(out.sizing.minFillNotionalUsd >= 10 && out.sizing.maxFillNotionalUsd <= 22.5, JSON.stringify(out.sizing));

  const tiny = setup({ equity: 60 }); // 15% = $9
  await assert.rejects(tiny.trade(['SOL', 'long', 'auto', '5', 'manual']), /Account equity \$60\.00 is too small to copy: 15% \(\$9\.00\)/);
  assert.ok(!tiny.hl.calls.includes('placeMarketOrder'));
  assert.equal(tiny.ledger.entries.length, 0);
});

test('unreadable equity stops the trade before any order', async () => {
  const { hl, ledger, trade } = setup();
  hl.getAccountEquity = async () => { throw new Error('clearinghouseState: no readable marginSummary.accountValue'); };
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /no readable marginSummary/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.entries.length, 0);
  hl.getAccountEquity = async () => NaN;
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't2')), /Invalid account equity/);
});

test('an increase mirrors the trader\'s add in proportion to our copy, capped at the tier %, 15% of equity per copy and 80% of the copy', async () => {
  const withCopy = (qty: number) => setup({ equity: 2000, positions: { SOL: qty }, ledger: new MemoryLedgerStore([{ ...copyEntry('tx-a', 'SOL', qty, 'alice', 't1'), leverage: 5 }]) });

  // Trader adds 25% → our 2 SOL copy ($200) adds $50: 0.49 SOL (≤ $50 at the worst-case fill)
  const prop = withCopy(2);
  const a = await prop.trade(increase('alice', 't1', 0.25));
  assert.deepEqual([a.status, a.action, a.sizing.mode, a.sizing.mirroredUsd, a.sizing.targetUsd, a.size], ['filled', 'increase', 'increase', 50, 50, '0.49']);
  assert.ok(a.sizing.maxFillNotionalUsd <= 50);
  assert.ok(!prop.hl.calls.includes('setLeverage'), 'leverage unchanged');
  assert.equal(prop.ledger.entries[0].qty, 2.49);

  // Trader doubles: $100 copy → mirrored $100, but capped at 80% of the copy ($80)
  const capped = withCopy(1);
  const b = await capped.trade(increase('alice', 't1', 1));
  assert.deepEqual([b.sizing.mirroredUsd, b.sizing.capUsd, b.size], [100, 80, '0.78']);

  // A $1,000 copy on $2,000 of equity is already over the 15% ($300) a copy may reach: no add at all
  const big = withCopy(10);
  await assert.rejects(big.trade(increase('alice', 't1', 3)), /already \$1000\.00, at or above 15% of equity \(\$300\.00\)/);
  assert.ok(!big.hl.calls.includes('placeMarketOrder'));

  // A tiny add that comes to under HL's $10 minimum can't be replicated
  const tiny = withCopy(1);
  await assert.rejects(tiny.trade(increase('alice', 't1', 0.05)), /Increase too small/);
  assert.ok(!tiny.hl.calls.includes('placeMarketOrder'));
});

test('an increase is refused when stale, when we hold no copy of the trade, or when it was already copied', async () => {
  const ledger = () => new MemoryLedgerStore([{ ...copyEntry('tx-a', 'SOL', 1, 'alice', 't1'), leverage: 5 }]);
  const stale = setup({ positions: { SOL: 1 }, ledger: ledger() });
  await assert.rejects(stale.trade(increase('alice', 't1', 0.5, '2026-10-02T11:50:00.000Z')), /600s ago — too old/);
  assert.deepEqual(stale.hl.calls, []);

  const none = setup({ positions: { SOL: 1 }, ledger: ledger() });
  await assert.rejects(none.trade(increase('bob', 't2', 0.5)), /Can't copy the increase: no open SOL copy of trader bob/);
  assert.ok(!none.hl.calls.includes('placeMarketOrder'));

  const twice = setup({ positions: { SOL: 1 }, ledger: ledger() });
  assert.equal((await twice.trade(increase('alice', 't1', 0.5))).status, 'filled');
  await assert.rejects(twice.trade(increase('alice', 't1', 0.5)), /Already copied trader update/);
  assert.equal(twice.hl.orders.length, 1);
});

test('an increase keeps the copy\'s leverage; a position whose leverage changed is refused', async () => {
  const { hl, trade } = setup({
    positions: { SOL: 1 }, positionLeverage: { SOL: { type: 'isolated', value: 3 } },
    ledger: new MemoryLedgerStore([{ ...copyEntry('tx-a', 'SOL', 1, 'alice', 't1'), leverage: 5 }]),
  });
  await assert.rejects(trade(increase('alice', 't1', 0.5)), /existing SOL position is 3x isolated/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
});

// --- Trader (copy) path ---

test('copying a trader sends their mimicMeta, sizes from their stats and records the copy in the ledger', async () => {
  const { hl, invo, ledger, trade } = setup();
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));

  assert.deepEqual(invo.recorded[0].mimicMeta, signalMeta('alice', 't1'));
  assert.ok(invo.calls.includes('getUserPortfolios:alice') && invo.calls.includes('getPortfolioById:p-alice'));
  assert.equal(out.sizing.tier, 'strong');
  assert.equal(out.sizing.statsLookup, 'ok');
  assert.deepEqual(hl.leverage, [['SOL', 5]]);
  assert.equal(hl.orders.length, 1);
  assert.equal(hl.orders[0].isBuy, true);
  assert.equal(hl.orders[0].reduceOnly, false);
  assert.equal(hl.orders[0].szDecimals, 2);
  assert.equal(out.status, 'filled');

  assert.equal(out.manual, false);
  assert.equal(out.sourceBaseShortId, 'short-t1');
  assert.equal(out.positionRecordId, 'rec-1');
  assert.equal(out.filledQty, parseFloat(out.size));
  assert.equal(ledger.entries.length, 1);
  const e = ledger.entries[0];
  assert.deepEqual(
    [e.id, e.coin, e.side, e.qty, e.status, e.positionRecordIds],
    [out.clientTxId, 'SOL', 'long', out.filledQty, 'open', ['rec-1']]);
  assert.deepEqual(e.source, {
    creatorInvoUserId: 'alice', portfolioId: 'p-alice', sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'short-t1',
  });
  assert.deepEqual(out.ledger, { entryId: e.id, copyQty: e.qty });
  assert.deepEqual(e.sourceUpdateIds, ['upd-t1']);
});

test('an increase adds to that trader\'s copy and records the change; Invo gets the copy\'s mimicMeta', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { ledger: l, invo, trade } = setup({ positions: { SOL: 0.5 }, ledger, equity: 2000 });
  const out = await trade(increase('alice', 't1', 0.5));
  assert.equal(out.sizing.mode, 'increase');
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].id, 'tx-alice');
  assert.equal(l.entries[0].qty, Number((0.5 + out.filledQty!).toFixed(2)));
  assert.deepEqual(l.entries[0].sourceUpdateIds, ['upd-t1', 't1_inv-2026-10-02T11:59:00.000Z_increase']);
  assert.deepEqual(invo.recorded[0].mimicMeta, { ...signalMeta('alice', 't1'), initialSourcePaperUpdateId: 'inv-2026-10-02T11:59:00.000Z' });
});

test('a second open signal for a trade we already hold is refused (adds come as increase signals)', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  await assert.rejects(trade([openSignal('SOL', 'long', 5, 'alice', 't1').replace('upd-t1', 'upd-t1-again')]), /Already holding a copy of this trade/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

// --- Each trader update is copied once ---

test('the same trader update is never copied twice, even after its copy closed', async () => {
  const { hl, invo, ledger, deps, trade } = setup();
  const first = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(first.status, 'filled');
  const position = hl.positions.SOL;

  for (const label of ['repeat while open', 'repeat after close']) {
    const callsBefore = [hl.calls.length, invo.calls.length, ledger.saves];
    await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /Already copied trader update upd-t1/, label);
    assert.deepEqual([hl.calls.length, invo.calls.length, ledger.saves], callsBefore, `${label}: nothing touched`);
    if (label === 'repeat while open') {
      assert.equal(hl.positions.SOL, position);
      assert.equal((await runClose(['SOL', meta('alice', 't1')], deps)).status, 'closed');
    }
  }
  assert.equal(hl.positions.SOL, 0);
});

test('an update that did not fill can be retried', async () => {
  const { hl, ledger, deps } = setup({ fillRatio: 0 });
  assert.equal((await runTrade(open('SOL', 'long', 5, 'alice', 't1'), deps)).status, 'not_filled');
  const retry = await runTrade(open('SOL', 'long', 5, 'alice', 't1'), { ...deps, hl: fakeHl() });
  assert.equal(retry.status, 'filled');
  assert.equal(ledger.entries.length, 1);
  assert.equal(hl.orders.length, 1);
});

// --- Hyperliquid rejections are not mistaken for success ---

test('a rejected leverage change stops the trade before any order', async () => {
  const { hl, invo, ledger, trade } = setup({ rejectLeverage: true });
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /Setting SOL to 5x isolated rejected by Hyperliquid: .*Cannot switch leverage type/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.saves, 0);
});

test('a rejected order reports not_filled with the reason and records nothing anywhere', async () => {
  const { hl, invo, ledger, trade } = setup({ rejectOrder: true });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'not_filled');
  assert.match(out.orderError!, /Insufficient margin/);
  assert.equal(out.filledQty, 0);
  assert.equal(hl.positions.SOL, undefined);
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(out.invoResult, null);
  assert.equal(ledger.entries.length, 0);
});

// --- Stale ledger entries are reconciled with the live position ---

test('entries for a position that is gone are closed before trading, so later closes work', async () => {
  // Alice's copy was liquidated outside this tool: ledger still says 0.5 open, HL is flat
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, deps, trade } = setup({ ledger });

  const bob = await trade(open('SOL', 'long', 5, 'bob', 't2'));
  assert.equal(bob.sizing.mode, 'initial');
  assert.deepEqual(bob.reconciledEntryIds, ['tx-alice']);
  const alice = ledger.entries.find(e => e.id === 'tx-alice')!;
  assert.deepEqual([alice.status, alice.qty], ['closed', 0]);
  assert.match(alice.closeReason!, /no SOL position/);

  // Without reconciliation this was refused ("smaller than the copies tracked")
  const closeBob = await runClose(['SOL', meta('bob', 't2')], deps);
  assert.equal(closeBob.status, 'closed');
  assert.equal(hl.positions.SOL, 0);
});

test('an increase of a copy whose position is gone is refused (the stale entry is reconciled closed)', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { hl, trade } = setup({ ledger });
  await assert.rejects(trade(increase('alice', 't1', 0.5)), /no open SOL copy/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status]), [['tx-alice', 'closed']]);
});

test('entries on the other side of the live position are reconciled even when the trade is refused', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1', 'long')]);
  const { hl, trade } = setup({ positions: { SOL: -0.3 }, ledger });
  await assert.rejects(trade(open('SOL', 'long', 5, 'bob', 't2')), /existing position is short/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.entries[0].status, 'closed');
});

test('a ledger write failure while reconciling stops the trade before any order', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  ledger.failSave = true;
  const { hl, trade } = setup({ ledger });
  await assert.rejects(trade(open('SOL', 'long', 5, 'bob', 't2')), /disk full/);
  assert.ok(!hl.calls.includes('setLeverage') && !hl.calls.includes('placeMarketOrder'));
});

test('another trader in the same coin gets a separate copy', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')]);
  const { ledger: l, trade } = setup({ positions: { SOL: 0.5 }, ledger });
  const out = await trade(open('SOL', 'long', 5, 'bob', 't2'));
  assert.deepEqual(l.entries.map(e => [e.id, e.source?.creatorInvoUserId, e.qty]),
    [['tx-alice', 'alice', 0.5], [out.clientTxId, 'bob', out.filledQty]]);
});

// --- Manual path ---

test('`manual` sends no mimicMeta, skips the stats lookup and records an unlinked entry', async () => {
  const { invo, ledger, trade } = setup();
  const out = await trade(['SOL', 'long', 'auto', '5', 'manual']);
  assert.ok(!('mimicMeta' in invo.recorded[0]));
  assert.deepEqual(invo.calls, ['recordOpen']);
  assert.equal(out.sizing.tier, 'poor');
  assert.equal(out.manual, true);
  assert.equal(out.sourceBaseShortId, null);
  assert.equal(ledger.entries[0].source, null);
});

// --- Failures after the order ---

test('an Invo record failure still records the copy (the HL position exists)', async () => {
  const { ledger, trade } = setup({ failRecordOpen: true });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.match(out.invoResult.error, /500/);
  assert.equal(out.positionRecordId, null);
  assert.equal(ledger.entries.length, 1);
  assert.deepEqual(ledger.entries[0].positionRecordIds, []);
});

test('a ledger that can\'t be written stops the trade before any order', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failSave = true;
  const { hl, trade } = setup({ ledger });
  await assert.rejects(trade(open('SOL', 'long', 5, 'alice', 't1')), /disk full/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('a ledger write failure after a fill is reported, and the order stays pending to be settled', async () => {
  const ledger = new MemoryLedgerStore();
  ledger.failSavesAfter = 1; // the pending write works; recording the fill fails
  const { trade } = setup({ ledger });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'filled');
  assert.ok(out.filledQty! > 0);
  assert.match(out.ledger.error!, /ledger write failed: disk full.*stays pending/);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', out.cloid]]);
});

test('no fill records nothing, on Invo or in the ledger', async () => {
  const { invo, ledger, trade } = setup({ fillRatio: 0 });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'not_filled');
  assert.match(out.orderError!, /could not immediately match/);
  assert.equal(out.filledQty, 0);
  assert.ok(!invo.calls.includes('recordOpen'));
  assert.equal(ledger.entries.length, 0);
});

// --- Lost responses and crashes: a fill is never left untracked ---

test('the fill comes from the order, not the position, so other activity in the coin is not counted', async () => {
  // Someone else's 1.0 SOL lands between our snapshot and our fill
  const { ledger, trade } = setup({ beforeOrder: p => { p.SOL = (p.SOL ?? 0) + 1; } });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.filledQty, parseFloat(out.size));
  assert.equal(ledger.entries[0].qty, parseFloat(out.size));
});

test('a response lost after HL filled the order: the fill is looked up by cloid and recorded', async () => {
  for (const opts of [{ orderThrows: 'after' as const }, { opaqueOrderResponse: true }]) {
    const { hl, ledger, trade } = setup(opts);
    const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
    assert.equal(out.status, 'filled');
    assert.ok(hl.calls.includes(`getOrderFill:${out.cloid}`));
    assert.deepEqual(ledger.entries.map(e => [e.status, e.qty, e.pendingOrder]), [['open', out.filledQty, undefined]]);
  }
});

test('a failed request HL has no record of stays pending: it may still arrive', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'before' });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'unknown');
  assert.match(out.orderError!, /order request failed: ECONNRESET/);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', out.cloid]]);

  // Too soon to conclude it never reached HL: trading the coin is refused, no order
  const hl2 = fakeHl();
  await assert.rejects(runTrade(open('SOL', 'long', 5, 'bob', 't2'), { ...deps, hl: hl2 }), /isn't on HL 0s after it was sent — it may still arrive/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));

  // A minute later it is settled as never sent: the copy is dropped and the update can be retried
  const later = { ...deps, hl: fakeHl(), now: () => new Date('2026-10-02T12:01:00Z') };
  const retry = await runTrade(open('SOL', 'long', 5, 'alice', 't1'), later);
  assert.equal(retry.status, 'filled');
  assert.deepEqual(retry.settledPendingOrders, [{ entryId: out.clientTxId, kind: 'open', cloid: out.cloid, filledQty: 0 }]);
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status]), [[retry.clientTxId, 'open']]);
});

test('a failed request that did reach HL is found by cloid and recorded', async () => {
  const { ledger, trade } = setup({ orderThrows: 'after' });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'filled');
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty]), [['open', out.filledQty]]);
});

test('the position read failing after the order does not lose the fill', async () => {
  const { ledger, trade } = setup({ failPositionsAfterOrder: true });
  const out = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(out.status, 'filled');
  assert.equal(out.qtyAfter, out.size);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty]), [['open', out.filledQty]]);
});

test('fill unknown: the order stays pending, and the next run in the coin settles it first', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'after', failOrderLookup: true });
  const lost = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  assert.equal(lost.status, 'unknown');
  assert.deepEqual(ledger.entries.map(e => [e.status, e.pendingOrder?.cloid]), [['pending', lost.cloid]]);

  // The same update again: once settled, it's a repeat and refused before any order
  const hl2 = fakeHl({ positions: { SOL: 0.76 }, orderFills: { [lost.cloid]: 0.76 } });
  await assert.rejects(runTrade(open('SOL', 'long', 5, 'alice', 't1'), { ...deps, hl: hl2 }), /Already copied trader update upd-t1/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty, e.pendingOrder]), [['open', 0.76, undefined]]);

  // ...and the settled copy closes normally on its trader's signal
  assert.equal((await runClose(['SOL', meta('alice', 't1')], { ...deps, hl: hl2 })).status, 'closed');
});

test('an unsettled order that can\'t be looked up blocks trading in that coin', async () => {
  const { ledger, deps, trade } = setup({ orderThrows: 'after', failOrderLookup: true });
  await trade(open('SOL', 'long', 5, 'alice', 't1'));
  const hl2 = fakeHl({ failOrderLookup: true });
  await assert.rejects(runTrade(open('SOL', 'long', 5, 'bob', 't2'), { ...deps, hl: hl2 }), /can't settle the open order/);
  assert.ok(!hl2.calls.includes('placeMarketOrder'));
  assert.equal(ledger.entries[0].status, 'pending');
});

// --- End to end with fakes: open two traders' copies, close one ---

test('two traders copied into one coin: each close signal closes only that trader\'s copy', async () => {
  const { hl, ledger, deps, trade } = setup();
  const a = await trade(open('SOL', 'long', 5, 'alice', 't1'));
  const b = await trade(open('SOL', 'long', 5, 'bob', 't2'));
  const total = Number((a.filledQty! + b.filledQty!).toFixed(2));
  assert.equal(hl.positions.SOL, total);

  // A third trader's close in SOL does nothing
  const other = await runClose(['SOL', meta('carol', 't1')], deps);
  assert.equal(other.status, 'refused');
  assert.equal(hl.positions.SOL, total);

  const closeA = await runClose(['SOL', meta('alice', 't1')], deps);
  assert.equal(closeA.status, 'closed');
  assert.equal(hl.positions.SOL, b.filledQty);

  // Alice's close again: her copy is already closed
  assert.equal((await runClose(['SOL', meta('alice', 't1')], deps)).status, 'refused');
  assert.equal(hl.positions.SOL, b.filledQty);

  const closeB = await runClose(['SOL', meta('bob', 't2')], deps);
  assert.equal(closeB.status, 'closed');
  assert.equal(hl.positions.SOL, 0);
  assert.deepEqual(ledger.entries.map(e => e.status), ['closed', 'closed']);
});
