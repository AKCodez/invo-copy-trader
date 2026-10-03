import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrader,
  sizeInitial,
  sizeIncrease,
  limitPrice,
  fillPriceRange,
  copyRange,
  tierTargetUsd,
  TIER_EQUITY_PCT,
  MIN_EQUITY_PCT,
  MAX_EQUITY_PCT,
  SLIPPAGE_PCT,
  type TraderStats,
} from './sizing.js';

const strong: TraderStats = {
  winRate: 92, wonPositions: 184, lostPositions: 16, currentWinStreak: 14, percentChange: 1200, liquidated: false,
};

// --- Tiers ---

test('strong trader aims for 15% of equity', () => {
  const r = classifyTrader(strong);
  assert.equal(r.tier, 'strong');
  assert.equal(r.equityPct, 15);
});

test('average trader aims for 7.8% or 10.4% of equity by streak', () => {
  assert.deepEqual(
    [classifyTrader({ ...strong, currentWinStreak: 3 }).equityPct, classifyTrader({ ...strong, currentWinStreak: 7 }).equityPct],
    [7.8, 10.4],
  );
  // Long streak but win rate / W/L below strong thresholds
  const r = classifyTrader({ ...strong, winRate: 80, wonPositions: 80, lostPositions: 20 });
  assert.equal(r.tier, 'average');
  assert.equal(r.equityPct, 10.4);
});

test('strong boundaries are inclusive', () => {
  const r = classifyTrader({ ...strong, currentWinStreak: 10, winRate: 85, wonPositions: 50, lostPositions: 10 });
  assert.equal(r.tier, 'strong');
  assert.equal(classifyTrader({ ...strong, currentWinStreak: 9 }).tier, 'average');
});

test('poor or missing performance aims for 5% of equity', () => {
  const cases: (TraderStats | null)[] = [
    null,
    {},
    { ...strong, percentChange: -5 },
    { ...strong, percentChange: 0 },
    { ...strong, currentWinStreak: 0 },
    { ...strong, liquidated: true },
    { ...strong, winRate: 55 },
    { ...strong, wonPositions: 10, lostPositions: 10 },
    { ...strong, currentWinStreak: undefined },
  ];
  for (const c of cases) {
    const r = classifyTrader(c);
    assert.equal(r.tier, 'poor', JSON.stringify(c));
    assert.equal(r.equityPct, 5);
  }
});

test('no losses counts as infinite W/L', () => {
  assert.equal(classifyTrader({ ...strong, lostPositions: 0 }).tier, 'strong');
});

test('every tier percentage lies within the 5%–15% range', () => {
  assert.deepEqual([MIN_EQUITY_PCT, MAX_EQUITY_PCT], [5, 15]);
  for (const pct of Object.values(TIER_EQUITY_PCT)) assert.ok(pct >= MIN_EQUITY_PCT && pct <= MAX_EQUITY_PCT, String(pct));
  assert.deepEqual(TIER_EQUITY_PCT, { poor: 5, averageShortStreak: 7.8, averageLongStreak: 10.4, strong: 15 });
});

test('tiers keep their relative place when the range widened from 5–10% to 5–15%', () => {
  // Old: poor 5, average 6.4 / 7.7, strong 10 → same fraction of the way from min to max
  const old = { poor: 5, averageShortStreak: 6.4, averageLongStreak: 7.7, strong: 10 };
  for (const [tier, pct] of Object.entries(TIER_EQUITY_PCT)) {
    const oldFraction = (old[tier as keyof typeof old] - 5) / (10 - 5);
    const newFraction = (pct - MIN_EQUITY_PCT) / (MAX_EQUITY_PCT - MIN_EQUITY_PCT);
    assert.ok(Math.abs(oldFraction - newFraction) < 1e-9, `${tier}: ${oldFraction} vs ${newFraction}`);
  }
});

// --- Equity range ---

test('copyRange is 5%–15% of equity', () => {
  assert.deepEqual(copyRange(2000), { equityUsd: 2000, minUsd: 100, maxUsd: 300 });
  assert.deepEqual(copyRange(784), { equityUsd: 784, minUsd: 39.2, maxUsd: 117.6 });
  // Tier targets at $2,000: poor $100, average $156 / $208, strong $300
  assert.deepEqual(Object.values(TIER_EQUITY_PCT).map(p => Math.round(tierTargetUsd(2000, p) * 100) / 100), [100, 156, 208, 300]);
});

test('below $200 of equity the floor is HL\'s $10 minimum order; below $66.67 the account is too small', () => {
  assert.deepEqual(copyRange(150), { equityUsd: 150, minUsd: 10, maxUsd: 22.5 }); // 5% would be $7.50
  assert.deepEqual(copyRange(70), { equityUsd: 70, minUsd: 10, maxUsd: 10.5 });
  assert.equal(copyRange(200 / 3).minUsd, 10); // exactly $66.67: 15% = $10
  assert.throws(() => copyRange(66.66), /Account equity \$66\.66 is too small to copy: 15% \(\$9\.99\) is below Hyperliquid's \$10 minimum order/);
  assert.throws(() => copyRange(50), /15% \(\$7\.50\)/);
});

test('copyRange rejects unusable equity', () => {
  for (const bad of [0, -50, NaN, Infinity]) assert.throws(() => copyRange(bad), /Invalid account equity/, String(bad));
});

// --- Fill price range ---

test('limitPrice matches the original formula when 5 significant figures fit the decimal limit', () => {
  for (const [mid, szDecimals] of [[142.37, 2], [97123.5, 5], [0.31234, 0], [2.3456, 0], [123.456, 2]] as const) {
    for (const isBuy of [true, false]) {
      const raw = isBuy ? mid * 1.02 : mid * 0.98;
      assert.equal(limitPrice(mid, isBuy, szDecimals), parseFloat(parseFloat(raw.toPrecision(5)).toString()));
    }
  }
  assert.equal(SLIPPAGE_PCT, 0.02);
});

const decimalsOf = (x: number) => (String(x).split('.')[1] ?? '').length;
const sigFigsOf = (x: number) => String(x).replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;

test('limitPrice never exceeds 6 − szDecimals decimals or 5 significant figures (HL price rule)', () => {
  for (const mid of [0.00123456, 0.0123456, 0.54321, 0.98765, 1.00321, 5.4321, 9.99987, 54.321, 142.37, 3012.34, 97123.5, 123456.7]) {
    for (let szDecimals = 0; szDecimals <= 5; szDecimals++) {
      for (const isBuy of [true, false]) {
        let px: number;
        try {
          px = limitPrice(mid, isBuy, szDecimals);
        } catch (e: any) {
          // Only when the decimal grid can't hold a positive price (e.g. $0.0012 with 2 decimals, selling)
          assert.match(e.message, /Can't express a (buy|sell) limit price/);
          assert.ok(!isBuy && mid * 0.98 < 10 ** -(6 - szDecimals), `mid ${mid} szDecimals ${szDecimals}: ${e.message}`);
          continue;
        }
        const label = `mid ${mid} szDecimals ${szDecimals} ${isBuy ? 'buy' : 'sell'} -> ${px}`;
        assert.ok(px > 0, label);
        assert.ok(decimalsOf(px) <= 6 - szDecimals, `${label}: ${decimalsOf(px)} decimals`);
        assert.ok(Number.isInteger(px) || sigFigsOf(px) <= 5, `${label}: ${sigFigsOf(px)} sig figs`);
      }
    }
  }
});

test('the decimal cut rounds away from mid, so the order is never less likely to fill', () => {
  // 0.54321 × 1.02 = 0.5540742 → 0.55407 (5 sig figs) → 4 decimals allowed for szDecimals 2
  assert.equal(limitPrice(0.54321, true, 2), 0.5541);
  assert.equal(limitPrice(0.54321, false, 2), 0.5323); // 0.53235 → down
  assert.equal(limitPrice(5.4321, true, 3), 5.541); // 5.5407 → up
  assert.equal(limitPrice(5.4321, false, 3), 5.323); // 5.3235 → down
  assert.equal(limitPrice(0.00123456, true, 0), 0.00126); // 0.0012593 → 6 decimals
  for (const [mid, sz] of [[0.54321, 2], [5.4321, 3], [0.00123456, 0], [0.98765, 3]] as const) {
    assert.ok(limitPrice(mid, true, sz) >= mid * 1.02 - 1e-12 || limitPrice(mid, true, sz) >= parseFloat((mid * 1.02).toPrecision(5)));
    assert.ok(limitPrice(mid, true, sz) > mid && limitPrice(mid, false, sz) < mid);
  }
});

test('fill range covers the rounded limit price even when rounding widens it', () => {
  // 123.456 × 1.02 = 125.92512 → toPrecision(5) = 125.93 (above the raw 2%)
  const buy = fillPriceRange(123.456, true, 2);
  assert.equal(buy.limitPx, 125.93);
  assert.equal(buy.highPx, 125.93);
  // 123.456 × 0.98 = 120.98688 → 120.99 (above raw, so the raw 2% stays the low bound)
  const sell = fillPriceRange(123.456, false, 2);
  assert.equal(sell.limitPx, 120.99);
  assert.ok(Math.abs(sell.lowPx - 123.456 * 0.98) < 1e-9);
});

// --- Initial sizing ---

// Worst-case-fill mechanics with a fixed example band (hand-checked numbers below).
// Equity-derived bands are covered further down.
const BAND = { minUsd: 40, maxUsd: 78.4 };

const assets = [
  { name: 'SOL', mid: 142.37, szDecimals: 2 },
  { name: 'BTC', mid: 97123.5, szDecimals: 5 },
  { name: 'ETH', mid: 3456.78, szDecimals: 4 },
  { name: 'XRP', mid: 2.3456, szDecimals: 0 },
  { name: 'DOGE', mid: 0.31234, szDecimals: 0 },
  { name: 'ROUNDUP', mid: 123.456, szDecimals: 2 },
  // Where 5 significant figures exceed HL's decimal limit, so the decimal cut applies
  { name: 'LOWPX', mid: 0.54321, szDecimals: 2 },
  { name: 'SUB10', mid: 5.4321, szDecimals: 3 },
];

test('initial size stays within the band at every possible fill price, both sides', () => {
  for (const a of assets) {
    for (const isBuy of [true, false]) {
      const px = fillPriceRange(a.mid, isBuy, a.szDecimals);
      for (const target of [0, 40, 50, 60, 78.4, 80, 1000]) {
        const r = sizeInitial(target, BAND, a.mid, a.szDecimals, isBuy);
        const qty = parseFloat(r.qty);
        const label = `${a.name} ${isBuy ? 'buy' : 'sell'} target ${target}: ${r.qty}`;
        assert.ok(qty * px.lowPx >= BAND.minUsd - 1e-9, `${label} min fill $${qty * px.lowPx}`);
        assert.ok(qty * px.highPx <= BAND.maxUsd + 1e-9, `${label} max fill $${qty * px.highPx}`);
        // Hard guarantee from the order's own limit price
        if (isBuy) assert.ok(qty * r.limitPx <= BAND.maxUsd + 1e-9, label);
        else assert.ok(qty * r.limitPx >= BAND.minUsd - 1e-9, label);
        // Reported range is within the band
        assert.ok(r.minFillNotionalUsd >= BAND.minUsd && r.maxFillNotionalUsd <= BAND.maxUsd, label);
        // qty respects szDecimals
        const decimals = r.qty.includes('.') ? r.qty.split('.')[1].length : 0;
        assert.equal(decimals, a.szDecimals);
      }
    }
  }
});

test('initial size converts USD to coin units within the worst-case band', () => {
  // mid $100, 2% → fills in [$98, $102]; qty band [ceil(40/98), floor(78.4/102)] = [0.41, 0.76]
  assert.deepEqual(sizeInitial(50, BAND, 100, 2, true), {
    qty: '0.50', notionalUsd: 50, minFillNotionalUsd: 49, maxFillNotionalUsd: 51, limitPx: 102,
  });
  assert.deepEqual(sizeInitial(78.4, BAND, 100, 2, true), {
    qty: '0.76', notionalUsd: 76, minFillNotionalUsd: 74.48, maxFillNotionalUsd: 77.52, limitPx: 102,
  });
  assert.deepEqual(sizeInitial(40, BAND, 100, 2, false), {
    qty: '0.41', notionalUsd: 41, minFillNotionalUsd: 40.18, maxFillNotionalUsd: 41.82, limitPx: 98,
  });
});

test('regression: mid-only sizing could fill below the band minimum or above its maximum', () => {
  // Old: 0.40 @ $100 = $40 at mid, but a sell filling at $98 = $39.20
  assert.equal(sizeInitial(40, BAND, 100, 2, false).qty, '0.41');
  // Old: 0.78 @ $100 = $78 at mid, but a buy filling at $102 = $79.56
  assert.equal(sizeInitial(78.4, BAND, 100, 2, true).qty, '0.76');
});

test('initial size refuses when one size step cannot land in the worst-case band', () => {
  // szDecimals 0 at $50: 1 coin fills in [$49, $51] — fits
  assert.equal(sizeInitial(50, BAND, 50, 0, true).qty, '1');
  // At $39.50: 1 coin may fill < $40, 2 coins may fill > $78.40
  assert.throws(() => sizeInitial(50, BAND, 39.5, 0, true), /too coarse/);
  assert.throws(() => sizeInitial(50, BAND, 100, 0, true), /too coarse/);
  // At $77.50: fit at mid, but a buy filling at $79.05 exceeds $78.40
  assert.throws(() => sizeInitial(78.4, BAND, 77.5, 0, true), /too coarse/);
});

test('initial size stays within 5%–15% of equity at every fill price, for every tier and account size', () => {
  for (const equity of [150, 500, 784, 2000, 10_000, 250_000]) {
    const range = copyRange(equity);
    for (const a of assets) {
      for (const isBuy of [true, false]) {
        const px = fillPriceRange(a.mid, isBuy, a.szDecimals);
        for (const pct of Object.values(TIER_EQUITY_PCT)) {
          const r = sizeInitial(tierTargetUsd(equity, pct), range, a.mid, a.szDecimals, isBuy);
          const qty = parseFloat(r.qty);
          const label = `equity ${equity} ${a.name} ${isBuy ? 'buy' : 'sell'} ${pct}%: ${r.qty}`;
          assert.ok(qty * px.lowPx >= range.minUsd - 1e-9, `${label} min fill $${qty * px.lowPx} < $${range.minUsd}`);
          assert.ok(qty * px.highPx <= range.maxUsd + 1e-9, `${label} max fill $${qty * px.highPx} > $${range.maxUsd}`);
          assert.ok(qty * px.lowPx >= 10 - 1e-9, `${label} below HL's $10 minimum`);
        }
      }
    }
  }
});

test('just above the minimum account size the range is narrow, and a coarse lot is refused rather than overshot', () => {
  // $70 equity → $10.00–$10.50. One SOL lot (0.01 @ $142.37) is $1.42, so no qty stays inside at ±2% fills
  assert.throws(() => sizeInitial(10, copyRange(70), 142.37, 2, true), /Cannot size within \$10\.00-\$10\.50 .* too coarse/);
  // An asset with finer lots still fits (a $2.35 coin in 0.01 lots)
  const r = sizeInitial(10, copyRange(70), 2.3456, 2, true);
  assert.ok(r.minFillNotionalUsd >= 10 && r.maxFillNotionalUsd <= 10.5, JSON.stringify(r));
});

test('a higher tier never sizes smaller than a lower one', () => {
  const range = copyRange(2000);
  const sizes = Object.values(TIER_EQUITY_PCT).map(p => parseFloat(sizeInitial(tierTargetUsd(2000, p), range, 100, 2, true).qty));
  assert.deepEqual(sizes, [...sizes].sort((x, y) => x - y));
  // 5% ($100) must hold even at a $98 fill → 1.03; 15% ($300) even at $102 → 2.94
  assert.deepEqual(sizes, [1.03, 1.56, 2.08, 2.94]);
});

test('targets outside the band are clamped to it', () => {
  const range = copyRange(2000);
  assert.equal(sizeInitial(5, range, 100, 2, true).qty, sizeInitial(100, range, 100, 2, true).qty);
  assert.equal(sizeInitial(10_000, range, 100, 2, true).qty, '2.94');
  assert.throws(() => sizeInitial(50, { minUsd: 80, maxUsd: 40 }, 100, 2, true), /Invalid size range/);
});

test('initial size rejects bad prices', () => {
  assert.throws(() => sizeInitial(50, BAND, 0, 2, true), /Invalid mid/);
  assert.throws(() => sizeInitial(50, BAND, NaN, 2, true), /Invalid mid/);
});

// --- Increases ---

test('increase worst-case fill is capped at 80% of current notional', () => {
  // Current $50 → cap $40; floor(40 / 102) = 0.39 → max fill $39.78
  for (const isBuy of [true, false]) {
    const r = sizeIncrease(78.4, 50, 100, 2, isBuy);
    assert.equal(r.capUsd, 40);
    assert.equal(r.qty, '0.39');
    assert.equal(r.maxFillNotionalUsd, 39.78);
    assert.equal(r.limitPx, isBuy ? 102 : 98);
  }
});

test('increase below the cap uses the tier target at worst-case fill', () => {
  // Current $200 → cap $160; target $40 → floor(40 / 102) = 0.39
  const r = sizeIncrease(40, 200, 100, 2, true);
  assert.equal(r.qty, '0.39');
  assert.ok(r.maxFillNotionalUsd <= 40);
});

test('increase never exceeds the cap at any fill price', () => {
  for (const a of assets) {
    for (const isBuy of [true, false]) {
      const px = fillPriceRange(a.mid, isBuy, a.szDecimals);
      for (const current of [40, 55.5, 78.4, 150, 1000]) {
        for (const target of [40, 50, 60, 78.4]) {
          const r = sizeIncrease(target, current, a.mid, a.szDecimals, isBuy);
          const maxFill = parseFloat(r.qty) * px.highPx;
          assert.ok(maxFill <= current * 0.8 + 1e-9, `${a.name} current ${current}: $${maxFill}`);
          assert.ok(maxFill <= target + 1e-9);
        }
      }
    }
  }
});

test('increase refuses when the worst-case fill is below the $10 minimum order', () => {
  assert.throws(() => sizeIncrease(78.4, 10, 100, 2, true), /below the \$10 minimum/);
  // cap $10.40 → floor(10.40 / 102) = 0.10 → may fill at $9.80
  assert.throws(() => sizeIncrease(78.4, 13, 100, 2, true), /below the \$10 minimum/);
  assert.throws(() => sizeIncrease(78.4, 0, 100, 2, true), /Invalid current/);
});

test('multiple consecutive increases each respect the 80% cap and the position can exceed 10% of equity', () => {
  const mid = 100;
  const szDecimals = 2;
  const { highPx } = fillPriceRange(mid, true, szDecimals);
  // Strong trader: initial 0.76 ($76 at mid, ≤ $77.52 at worst fill), then 5 increases
  let qty = parseFloat(sizeInitial(78.4, BAND, mid, szDecimals, true).qty);
  assert.equal(qty, 0.76);

  const caps: number[] = [];
  const adds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const current = qty * mid;
    const r = sizeIncrease(78.4, current, mid, szDecimals, true);
    const maxFill = parseFloat(r.qty) * highPx;
    assert.ok(maxFill <= current * 0.8 + 1e-9, `increase ${i + 1}: $${maxFill} > 80% of $${current}`);
    assert.ok(maxFill <= 78.4 + 1e-9);
    caps.push(r.capUsd);
    adds.push(r.qty);
    qty = Math.round((qty + parseFloat(r.qty)) * 100) / 100;
  }

  // $76 → cap $60.80 → +0.59 → $135 → cap $108, target $78.40 → +0.76 per step after that
  assert.deepEqual(adds, ['0.59', '0.76', '0.76', '0.76', '0.76']);
  assert.deepEqual(caps, [60.8, 108, 168.8, 229.6, 290.4]);
  assert.ok(qty * mid > BAND.maxUsd);
  assert.equal(qty, 4.39);
});

test('consecutive increases with a poor trader stay cap-limited when the position is small', () => {
  const mid = 2;
  const szDecimals = 0;
  // Fills in [$1.96, $2.04]; initial band [ceil(40/1.96), floor(78.4/2.04)] = [21, 38]
  let qty = parseFloat(sizeInitial(40, BAND, mid, szDecimals, true).qty);
  assert.equal(qty, 21);

  // $42 → cap $33.60 → floor(33.6/2.04) = 16 → $74 → cap $59.20, target $40 → floor(40/2.04) = 19 → ...
  const adds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = sizeIncrease(40, qty * mid, mid, szDecimals, true);
    assert.ok(r.maxFillNotionalUsd <= r.capUsd);
    adds.push(r.qty);
    qty += parseFloat(r.qty);
  }
  assert.deepEqual(adds, ['16', '19', '19']);
  assert.equal(qty * mid, 150);
});

test('increases after the price moves use current notional at that time', () => {
  const szDecimals = 2;
  let qty = parseFloat(sizeInitial(40, BAND, 100, szDecimals, true).qty); // 0.41
  assert.equal(qty, 0.41);
  // Price drops to $50: position is $20.50 → cap $16.40 → floor(16.4 / 51) = 0.32
  const r1 = sizeIncrease(78.4, qty * 50, 50, szDecimals, true);
  assert.equal(r1.capUsd, 16.4);
  assert.equal(r1.qty, '0.32');
  qty += parseFloat(r1.qty);
  // Price rises to $200: 0.73 → $146 → cap $116.80, target $78.40 wins → floor(78.4 / 204) = 0.38
  const r2 = sizeIncrease(78.4, qty * 200, 200, szDecimals, true);
  assert.equal(r2.capUsd, 116.8);
  assert.equal(r2.qty, '0.38');
});

test('short increases are capped the same way', () => {
  // Short position $100 → cap $80; target $78.40 at worst fill $102 → floor(0.7686) = 0.76
  const r = sizeIncrease(78.4, 100, 100, 2, false);
  assert.equal(r.qty, '0.76');
  assert.equal(r.limitPx, 98);
  assert.ok(r.maxFillNotionalUsd <= 78.4);
});
