// Adds and partial closes are sized from the trader's $ figures (the feed post for
// the change), not /dex/trade's positionSize, which is a share of the trader's
// portfolio value and drifts when that value changes. Fixtures are live changes
// captured read-only on 2026-10-03 (~/invo-live-checks/check6-raw.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTradeSignal, notionalRatio } from './trade-signal.js';
import { runTrade } from './trade-exec.js';
import { runClose } from './close-exec.js';
import { MemoryLedgerStore, fakeHl, fakeInvo, signalMeta, copyEntry } from './test-fakes.js';

const LIVE = {
  // Increases: the coin ratio from these reproduces Invo's new average entry exactly
  XLNykLBlo3: {
    type: 'increase', positionSize: [0.0129783495, 0.0398806015, 0.026902252],
    notional: { investmentId: 'fe840048-ef52-49b6-9cd9-85d5b9294cb0', postId: '59bb05df', simIncrease: true, entrySimBefore: 13.554173058703308,
      simDifference: 17.32085815030755, entryPriceBefore: 84763, livePriceAtChange: 83993, entrySimAfter: 30.875031209010857, entryPriceAfter: 84329.30128679365 },
    coinRatio: 1.2896, positionSizeRatio: 2.0729,
  },
  ylT4I0QkQ3: {
    type: 'increase', positionSize: [0.0139956208, 0.0530816567, 0.039086035899999996],
    notional: { investmentId: 'e576d1b0-5016-408c-b6aa-a3ddc2a2c5fb', postId: '4d888c20', simIncrease: true, entrySimBefore: 13.552254178098508,
      simDifference: 23.982990966216995, entryPriceBefore: 119.515, livePriceAtChange: 117.65, entrySimAfter: 37.5352451443155, entryPriceAfter: 118.31661400664284 },
    coinRatio: 1.7977, positionSizeRatio: 2.7927,
  },
  EFbY0Zd6Nj: {
    type: 'increase', positionSize: [0.1401818285, 0.2100685337, 0.06988670520000001],
    notional: { investmentId: '86042c70-afe3-4d01-b385-6bdbf656abd3', postId: '259a3b48', simIncrease: true, entrySimBefore: 70.34890936617738,
      simDifference: 10.189959206033365, entryPriceBefore: 2.6008252133242014, livePriceAtChange: 2.4355, entrySimAfter: 80.53886857221075, entryPriceAfter: 2.5786782070371217 },
    coinRatio: 0.1547, positionSizeRatio: 0.4985,
  },
  YZAehs5SHF: {
    type: 'increase', positionSize: [0.1989213042, 0.3015835363, 0.1026622321],
    notional: { investmentId: '74f635b3-6373-40eb-8410-5d5070ca27ef', postId: 'e54fac44', simIncrease: true, entrySimBefore: 46.88260068610106,
      simDifference: 24.2645117201709, entryPriceBefore: 84589, livePriceAtChange: 84577, entrySimAfter: 71.14711240627196, entryPriceAfter: 84584.9070529711 },
    coinRatio: 0.5176, positionSizeRatio: 0.5161,
  },
  // Decreases: the $ left afterwards matches Invo's within 0.3%
  qxnB93eVrd: {
    type: 'decrease', positionSize: [0.0114951232, 0.0104865008, 0.0010086224000000008],
    notional: { investmentId: '270de090-02b3-4355-8e4e-06a85e694b41', postId: '1cfb5361', simIncrease: false, entrySimBefore: 7.104746541699936,
      simDifference: 0.9237131278613635, entryPriceBefore: null, livePriceAtChange: 1.4795, entrySimAfter: 6.181557905314414, entryPriceAfter: 1.4794159498910233 },
    coinRatio: 0.1300, positionSizeRatio: 0.0877,
  },
  PzysZOKC85: {
    type: 'decrease', positionSize: [0.0508721712, 0.0319815774, 0.0188905938],
    notional: { investmentId: 'cebf3fdc-4f62-406c-b54c-2280f5875bc2', postId: 'cb1a178a', simIncrease: false, entrySimBefore: 45.07742660023542,
      simDifference: 13.283606662589392, entryPriceBefore: null, livePriceAtChange: 4139.3, entrySimAfter: 31.902768129029894, entryPriceAfter: 4146.15735187241 },
    coinRatio: 0.2947, positionSizeRatio: 0.3713,
  },
  G9cJoimGDq: {
    type: 'decrease', positionSize: [0.0245608995, 0.0100409886, 0.0145199109],
    notional: { investmentId: '2244b355-e5df-41de-9750-d9dc25aeee6c', postId: '04515051', simIncrease: false, entrySimBefore: 15.097239485828755,
      simDifference: 8.995024896246813, entryPriceBefore: null, livePriceAtChange: 84493, entrySimAfter: 6.146663048515219, entryPriceAfter: 84482.51152065399 },
    coinRatio: 0.5958, positionSizeRatio: 0.5912,
  },
} as const;

const NOW = new Date('2026-10-02T12:00:00Z');
const at = '2026-10-02T11:59:30.000Z';
const ident = (trader: string, tradeId: string) => {
  const { initialSourcePaperUpdateId, ...m } = signalMeta(trader, tradeId);
  return m;
};
function changeSignal(kind: 'increase' | 'decrease', positionSize: readonly number[], notional: any, investmentId = notional?.investmentId ?? 'inv') {
  const [before, after, change] = positionSize;
  return JSON.stringify({
    type: 'signal', source: 'trade_poll', action: kind, updateId: `t1_${investmentId}_${kind}`, investmentId, updatedAt: at,
    trade: { coin: 'SOL', side: 'long' },
    change: { positionSizeBefore: before, positionSizeAfter: after, positionSizeChange: change, notional },
    mimicMeta: ident('alice', 't1'),
  });
}
const live = (name: keyof typeof LIVE) => changeSignal(LIVE[name].type, LIVE[name].positionSize, LIVE[name].notional);

let ids = 0;
function setup(qty: number, opts: { equity?: number } = {}) {
  const hl = fakeHl({ positions: { SOL: qty }, equity: opts.equity ?? 1_000_000 });
  const ledger = new MemoryLedgerStore([{ ...copyEntry('tx-a', 'SOL', qty, 'alice', 't1'), leverage: 5 }]);
  const deps = { hl, invo: fakeInvo(), ledger, newId: () => `tx-${++ids}`, newCloid: () => `0xc${++ids}`, now: () => NOW };
  return { hl, ledger, deps };
}

// --- The ratio comes from the $ figures, on live data ---

test('live changes: the ratio is the trader\'s change in coins from their $ figures, not positionSize\'s', () => {
  for (const [name, c] of Object.entries(LIVE)) {
    const sig = parseTradeSignal(live(name as keyof typeof LIVE)) as any;
    const used = c.type === 'increase' ? sig.ratio : sig.fraction;
    assert.equal(+used.toFixed(4), c.coinRatio, `${name} ratio`);
    assert.equal(+sig.positionSizeRatio.toFixed(4), c.positionSizeRatio, `${name} positionSize ratio kept for reference`);
  }
});

test('live increase XLNykLBlo3 (a 1.29× add that positionSize reported as 2.07×): sized from 1.29×, then capped', async () => {
  const { deps } = setup(10); // 10 SOL @ $100 = $1,000; equity $1M, so only the 80% cap ($800) can bind
  const out = await runTrade([live('XLNykLBlo3')], deps);
  assert.equal(out.trader!.ratio!.toFixed(4), '1.2896');
  assert.equal(out.trader!.positionSizeRatio!.toFixed(4), '2.0729');
  assert.equal(out.sizing.mirroredUsd, 1289.61); // 1.28961 × $1,000 — not $2,073
  assert.deepEqual([out.sizing.capUsd, out.size], [800, '7.84']); // 80% cap binds
});

test('live increase EFbY0Zd6Nj (0.15× add, positionSize said 0.50×): the add follows 0.15×', async () => {
  const { deps, ledger } = setup(10);
  const out = await runTrade([live('EFbY0Zd6Nj')], deps);
  const added = parseFloat(out.size);
  // 0.1547 × 10 SOL = 1.547 SOL ($154.70); sized ≤ that at the worst-case fill → 1.51
  assert.equal(out.size, '1.51');
  assert.ok(added <= 1.547);
  assert.equal(ledger.entries[0].qty, 11.51);
});

test('live decrease qxnB93eVrd (13.0% closed, positionSize said 8.8%): closes 13.0% of our copy', async () => {
  const { hl, deps } = setup(10);
  const out = await runClose([live('qxnB93eVrd')], deps) as any;
  assert.deepEqual([out.status, out.requestedQty, out.copyQtyLeft], ['decreased', 1.3, 8.7]); // floor(10 × 0.130014) = 1.30
  assert.equal(+out.positionSizeRatio.toFixed(4), 0.0877);
  assert.equal(hl.orders[0].reduceOnly, true);
});

test('live decrease PzysZOKC85 (29.5% closed, positionSize said 37.1%): never closes more than the trader did', async () => {
  const { deps } = setup(10);
  const out = await runClose([live('PzysZOKC85')], deps) as any;
  assert.equal(out.requestedQty, 2.94);
  assert.ok(out.requestedQty <= 10 * 0.2947);
});

// --- Refused when the $ figures are missing, mismatched or don't reconcile ---

test('an increase or decrease without $ figures is refused before anything is touched', async () => {
  for (const kind of ['increase', 'decrease'] as const) {
    const { hl, deps } = setup(10);
    const sig = changeSignal(kind, kind === 'increase' ? [0.1, 0.2, 0.1] : [0.2, 0.1, 0.1], null, 'inv');
    const run = kind === 'increase' ? runTrade([sig], deps) : runClose([sig], deps);
    if (kind === 'increase') await assert.rejects(run, /no change\.notional/);
    else assert.match((await run as any).reason, /no change\.notional/);
    assert.deepEqual(hl.calls, []);
  }
});

test('$ figures that are for another change, the wrong kind, incomplete, or don\'t reconcile are refused', () => {
  const inc = LIVE.XLNykLBlo3;
  const dec = LIVE.qxnB93eVrd;
  const bad: [string, () => unknown, RegExp][] = [
    ['other change', () => notionalRatio('increase', inc.notional, 'some-other-id'), /are for change/],
    ['wrong kind', () => notionalRatio('decrease', inc.notional, inc.notional.investmentId), /describe an increase/],
    ['no entry price before', () => notionalRatio('increase', { ...inc.notional, entryPriceBefore: null }, null), /no usable entryPriceBefore/],
    ['no change price', () => notionalRatio('increase', { ...inc.notional, livePriceAtChange: undefined }, null), /no usable entryPriceBefore/],
    ['no after figure', () => notionalRatio('increase', { ...inc.notional, entrySimAfter: null }, null), /no entrySimAfter/],
    ['add 1.5× larger than Invo\'s after figures', () => notionalRatio('increase', { ...inc.notional, simDifference: inc.notional.simDifference * 1.5 }, null), /don't reconcile/],
    ['average entry off by 0.5%', () => notionalRatio('increase', { ...inc.notional, entryPriceAfter: inc.notional.entryPriceAfter * 1.005 }, null), /don't reconcile/],
    ['decrease larger than the trade', () => notionalRatio('decrease', { ...dec.notional, simDifference: 8 }, null), /removes \$8 of a \$7\.1/],
    ['decrease $ left off by 5%', () => notionalRatio('decrease', { ...dec.notional, entrySimAfter: dec.notional.entrySimAfter * 1.05 }, null), /don't reconcile/],
    ['zero change', () => notionalRatio('increase', { ...inc.notional, simDifference: 0 }, null), /no usable entrySimBefore \/ simDifference/],
  ];
  for (const [name, fn, err] of bad) assert.throws(fn, err, name);
});

test('a decrease down to nothing closes the whole copy without needing $ figures', async () => {
  const { hl, deps } = setup(2);
  const out = await runClose([changeSignal('decrease', [0.1, 0, 0.1], null, 'inv-zero')], deps) as any;
  assert.equal(out.status, 'closed');
  assert.equal(hl.positions.SOL, 0);
});
