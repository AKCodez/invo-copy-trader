import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClose } from './close-exec.js';
import { UsageError } from './trade-exec.js';
import { MemoryLedgerStore, fakeHl, signalMeta, copyEntry } from './test-fakes.js';

// Two traders' copies netted into one SOL long on HL (0.5 + 0.3), plus a manual 0.2
const aliceSol = copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1');
const bobSol = copyEntry('tx-bob', 'SOL', 0.3, 'bob', 't2');
const manualSol = copyEntry('tx-manual', 'SOL', 0.2, null);

const close = (args: (string | undefined)[], ledger: MemoryLedgerStore, hl: ReturnType<typeof fakeHl>) =>
  runClose(args as string[], { hl, ledger, newCloid: () => '0xclose', now: () => new Date('2026-10-02T12:00:00Z') });

// --- 1. Matching trader close closes the right copied position ---

test('a trader\'s close closes only their copy\'s quantity, leaving other copies in the coin', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol, manualSol]);
  const hl = fakeHl({ positions: { SOL: 1.0 } });

  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);

  assert.equal(out.status, 'closed');
  assert.deepEqual(hl.orders.map(o => [o.coin, o.isBuy, o.size, o.reduceOnly]), [['SOL', false, '0.50', true]]);
  assert.equal(hl.positions.SOL, 0.5); // bob's 0.3 + manual 0.2 still open
  if (out.status === 'closed') {
    assert.equal(out.entryId, 'tx-alice');
    assert.equal(out.trader, 'alice');
    assert.equal(out.closedQty, 0.5);
    assert.equal(out.copyQtyLeft, 0);
  }
  const byId = Object.fromEntries(ledger.entries.map(e => [e.id, e]));
  assert.equal(byId['tx-alice'].status, 'closed');
  assert.equal(byId['tx-alice'].closedAt, '2026-10-02T12:00:00.000Z');
  assert.deepEqual([byId['tx-bob'].status, byId['tx-bob'].qty], ['open', 0.3]);
  assert.deepEqual([byId['tx-manual'].status, byId['tx-manual'].qty], ['open', 0.2]);
});

test('the only copy in a coin closes the whole position (short side too)', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-a', 'ETH', 0.25, 'alice', 't1', 'short')]);
  const hl = fakeHl({ positions: { ETH: -0.25 } });
  const out = await close(['ETH', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'closed');
  assert.deepEqual(hl.orders.map(o => [o.isBuy, o.size]), [[true, '0.2500']]);
  assert.equal(hl.positions.ETH, 0);
});

test('matches on the trader\'s baseShortId alone', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl = fakeHl({ positions: { SOL: 0.8 } });
  const { sourcePaperTradeBaseId, ...noBaseId } = signalMeta('bob', 't2');
  const out = await close(['SOL', JSON.stringify(noBaseId)], ledger, hl);
  assert.equal(out.status, 'closed');
  assert.deepEqual(hl.orders.map(o => o.size), ['0.30']);
  assert.equal(hl.positions.SOL, 0.5);
});

test('a single copy whose position shrank outside the ledger closes what remains', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  const hl = fakeHl({ positions: { SOL: 0.4 } });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'closed');
  assert.deepEqual(hl.orders.map(o => o.size), ['0.40']);
  assert.equal(hl.positions.SOL, 0);
  // Flat now, so no phantom remainder is left to skew later closes
  assert.deepEqual([ledger.entries[0].status, ledger.entries[0].qty], ['closed', 0]);
});

test('a partial fill reduces the copy and reports partial', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl = fakeHl({ positions: { SOL: 0.8 }, fillRatio: 0.4 });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'partial');
  if (out.status === 'partial') assert.deepEqual([out.closedQty, out.copyQtyLeft], [0.2, 0.3]);
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status, e.qty]), [['tx-alice', 'open', 0.3], ['tx-bob', 'open', 0.3]]);
});

// --- 2. Another trader's close on the same coin leaves our position alone ---

test('a different trader\'s close on the same coin closes nothing and never touches HL', async () => {
  const cases: [string, object][] = [
    ['unknown trader', signalMeta('carol', 't1')],
    ['followed trader, other trader\'s trade id', signalMeta('bob', 't1')],
    ['same trader, a different trade', signalMeta('alice', 't9')],
    ['trade id from another trade, short id from this one', { ...signalMeta('alice', 't2'), sourcePaperTradeBaseShortId: 'short-t1' }],
  ];
  for (const [name, meta] of cases) {
    const ledger = new MemoryLedgerStore([aliceSol, manualSol]);
    const hl = fakeHl({ positions: { SOL: 0.7 } });
    const out = await close(['SOL', JSON.stringify(meta)], ledger, hl);
    assert.equal(out.status, 'refused', name);
    if (out.status === 'refused') assert.match(out.reason, /no open SOL copy/, name);
    assert.deepEqual(hl.calls, [], name);
    assert.equal(hl.positions.SOL, 0.7, name);
    assert.equal(ledger.saves, 0, name);
  }
});

test('the right trader and trade in a different coin does not close this coin', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  const hl = fakeHl({ positions: { SOL: 0.5, ETH: 1 } });
  const out = await close(['ETH', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  assert.deepEqual(hl.calls, []);
});

test('manual trades are never closed by a signal', async () => {
  const ledger = new MemoryLedgerStore([manualSol]);
  const hl = fakeHl({ positions: { SOL: 0.2 } });
  for (const trader of ['alice', 'bob']) {
    const out = await close(['SOL', JSON.stringify(signalMeta(trader, 'tx-manual'))], ledger, hl);
    assert.equal(out.status, 'refused');
  }
  assert.deepEqual(hl.calls, []);
});

// --- 3. Missing trader/position identity refuses safely ---

test('missing or malformed close identity refuses before touching HL or the ledger', async () => {
  const { creatorInvoUserId, ...noTrader } = signalMeta('alice', 't1');
  const { sourcePaperTradeBaseId, sourcePaperTradeBaseShortId, ...noTradeIds } = signalMeta('alice', 't1');
  const cases: [string, string | undefined, RegExp][] = [
    ['no argument', undefined, /no close identity/],
    ['empty', '', /no close identity/],
    ['blank', '   ', /no close identity/],
    ['not JSON', '{oops', /not valid JSON/],
    ['array', '[]', /mimicMeta object/],
    ['empty object', '{}', /no trader id/],
    ['no trader', JSON.stringify(noTrader), /no trader id/],
    ['blank trader', JSON.stringify({ ...signalMeta('alice', 't1'), creatorInvoUserId: ' ' }), /no trader id/],
    ['no trade ids', JSON.stringify(noTradeIds), /no trade id/],
    ['null trade ids (close post without ids)', JSON.stringify({ ...noTradeIds, sourcePaperTradeBaseId: null, sourcePaperTradeBaseShortId: null }), /no trade id/],
  ];
  for (const [name, arg, reason] of cases) {
    const ledger = new MemoryLedgerStore([aliceSol]);
    const hl = fakeHl({ positions: { SOL: 0.5 } });
    const out = await close(['SOL', arg], ledger, hl);
    assert.equal(out.status, 'refused', name);
    if (out.status === 'refused') assert.match(out.reason, reason, name);
    assert.deepEqual(hl.calls, [], name);
    assert.equal(ledger.saves, 0, name);
  }
});

test('an empty or unreadable ledger refuses before touching HL', async () => {
  const empty = new MemoryLedgerStore([]);
  const hl = fakeHl({ positions: { SOL: 0.5 } });
  assert.equal((await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], empty, hl)).status, 'refused');

  const broken = new MemoryLedgerStore([aliceSol]);
  broken.failLoad = true;
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], broken, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.reason, /unreadable/);
  assert.deepEqual(hl.calls, []);
});

test('a same-side position smaller than the copies tracked in it refuses without an order', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl = fakeHl({ positions: { SOL: 0.6 } });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') {
    assert.match(out.reason, /smaller than the copies tracked/);
    assert.equal(out.entryId, 'tx-alice');
  }
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.saves, 0);
});

// --- Stale entries: the position is already gone on HL ---

test('the copy\'s position is already gone (flat or flipped): no order, stale entries closed', async () => {
  const cases: [string, Record<string, number>, any[], RegExp, string[]][] = [
    ['no HL position', {}, [aliceSol, bobSol], /no SOL position/, ['tx-alice', 'tx-bob']],
    ['position is now the other direction', { SOL: -0.4 }, [aliceSol, bobSol], /position is short, entry was long/, ['tx-alice', 'tx-bob']],
  ];
  for (const [name, positions, entries, reason, reconciled] of cases) {
    const ledger = new MemoryLedgerStore(entries);
    const hl = fakeHl({ positions });
    const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
    assert.equal(out.status, 'already_closed', name);
    if (out.status === 'already_closed') {
      assert.equal(out.entryId, 'tx-alice', name);
      assert.match(out.reason, reason, name);
      assert.deepEqual(out.reconciledEntryIds, reconciled, name);
    }
    assert.ok(!hl.calls.includes('placeMarketOrder'), name);
    assert.deepEqual(ledger.entries.map(e => e.status), ['closed', 'closed'], name);
    assert.deepEqual(hl.positions, positions, name);
  }
});

test('a stale entry on the other side no longer blocks closing the live copy', async () => {
  // Alice's long was stopped out and Bob's short opened elsewhere; the ledger still has Alice open
  const bobShort = copyEntry('tx-bob', 'SOL', 0.3, 'bob', 't2', 'short');
  const ledger = new MemoryLedgerStore([aliceSol, bobShort]);
  const hl = fakeHl({ positions: { SOL: -0.3 } });
  const out = await close(['SOL', JSON.stringify(signalMeta('bob', 't2'))], ledger, hl);
  assert.equal(out.status, 'closed');
  if (out.status === 'closed') assert.deepEqual(out.reconciledEntryIds, ['tx-alice']);
  assert.equal(hl.positions.SOL, 0);
  assert.deepEqual(ledger.entries.map(e => e.status), ['closed', 'closed']);
});

test('a ledger write failure while reconciling refuses before any order', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  ledger.failSave = true;
  const hl = fakeHl({ positions: {} });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.reason, /ledger write failed: disk full/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

// --- Close orders are reduce-only and checked ---

test('a position that shrinks before the close fills is closed, never flipped', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  // Partly liquidated between our snapshot (0.5) and the order
  const hl = fakeHl({ positions: { SOL: 0.5 }, beforeOrder: p => { p.SOL = 0.2; } });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.deepEqual(hl.orders.map(o => [o.size, o.reduceOnly]), [['0.50', true]]);
  assert.equal(hl.positions.SOL, 0); // not -0.3
  assert.equal(out.status, 'closed');
  assert.equal(ledger.entries[0].status, 'closed');
});

test('a rejected close order reports not_filled with the reason and leaves the ledger', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  const hl = fakeHl({ positions: { SOL: 0.5 }, rejectOrder: true });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'not_filled');
  if (out.status === 'not_filled') assert.match(out.orderError!, /Insufficient margin/);
  assert.equal(hl.positions.SOL, 0.5);
  assert.deepEqual([ledger.entries[0].status, ledger.entries[0].qty], ['open', 0.5]);
});

test('two open entries for the same trade are ambiguous and refused', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, { ...aliceSol, id: 'tx-alice-dup' }]);
  const hl = fakeHl({ positions: { SOL: 1 } });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.reason, /ambiguous/);
  assert.deepEqual(hl.calls, []);
});

test('missing coin is a usage error', async () => {
  await assert.rejects(close([], new MemoryLedgerStore(), fakeHl()), UsageError);
});

// --- Explicit manual close ---

test('`manual` flattens the whole coin and closes every ledger entry in it', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol, manualSol, copyEntry('tx-eth', 'ETH', 1, 'alice', 't3')]);
  const hl = fakeHl({ positions: { SOL: 1.0, ETH: 1 } });
  const out = await close(['SOL', 'manual'], ledger, hl);
  assert.equal(out.status, 'closed');
  assert.deepEqual(hl.orders.map(o => [o.coin, o.isBuy, o.size, o.reduceOnly]), [['SOL', false, '1.00', true]]);
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status]),
    [['tx-alice', 'closed'], ['tx-bob', 'closed'], ['tx-manual', 'closed'], ['tx-eth', 'open']]);
});

// --- Lost responses and crashes ---

test('a close whose response is lost is settled by cloid; if even that fails it stays pending', async () => {
  const signal = JSON.stringify(signalMeta('alice', 't1'));

  const ledger = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl = fakeHl({ positions: { SOL: 0.8 }, orderThrows: 'after' });
  const out = await close(['SOL', signal], ledger, hl);
  assert.equal(out.status, 'closed');
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status, e.qty]), [['tx-alice', 'closed', 0], ['tx-bob', 'open', 0.3]]);

  const ledger2 = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl2 = fakeHl({ positions: { SOL: 0.8 }, orderThrows: 'after', failOrderLookup: true });
  const lost = await close(['SOL', signal], ledger2, hl2);
  assert.equal(lost.status, 'unknown');
  assert.equal(hl2.positions.SOL, 0.3); // it did fill
  assert.equal(ledger2.entries[0].pendingOrder?.cloid, '0xclose');

  // Retry: the earlier order is settled first and turns out to have closed the copy — no second order
  const hl3 = fakeHl({ positions: { SOL: 0.3 }, orderFills: { '0xclose': 0.5 } });
  const retry = await close(['SOL', signal], ledger2, hl3);
  assert.equal(retry.status, 'already_closed');
  assert.ok(!hl3.calls.includes('placeMarketOrder'));
  assert.deepEqual(ledger2.entries.map(e => [e.id, e.status, e.qty]), [['tx-alice', 'closed', 0], ['tx-bob', 'open', 0.3]]);
  // Bob's close still works afterwards
  assert.equal((await close(['SOL', JSON.stringify(signalMeta('bob', 't2'))], ledger2, hl3)).status, 'closed');
  assert.equal(hl3.positions.SOL, 0);
});

test('an unsettled order that can\'t be looked up: close refuses without an order', async () => {
  const ledger = new MemoryLedgerStore([{ ...aliceSol, pendingOrder: { kind: 'close', cloid: '0xold', requestedQty: 0.5, placedAt: 'x' } }]);
  const hl = fakeHl({ positions: { SOL: 0.5 }, failOrderLookup: true });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.reason, /can't settle the close order/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('the position read failing after a close does not lose the fill', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, bobSol]);
  const hl = fakeHl({ positions: { SOL: 0.8 }, failPositionsAfterOrder: true });
  const out = await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'closed');
  if (out.status === 'closed') assert.equal(out.qtyAfter, null);
  assert.deepEqual(ledger.entries.map(e => [e.status, e.qty]), [['closed', 0], ['open', 0.3]]);
});

// --- Order price ---

test('close orders carry the asset\'s szDecimals so the limit price meets HL\'s decimal rule', async () => {
  const ledger = new MemoryLedgerStore([aliceSol]);
  const hl = fakeHl({ positions: { SOL: 0.5 } });
  await close(['SOL', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.deepEqual(hl.orders.map(o => o.szDecimals), [2]);
});

test('a price that can\'t be expressed is refused before the ledger or HL order is touched', async () => {
  const ledger = new MemoryLedgerStore([copyEntry('tx-b', 'BTC', 0.001, 'alice', 't1')]);
  // BTC (szDecimals 5) allows 1 decimal: a sell limit near $0.04 floors to 0
  const hl = fakeHl({ positions: { BTC: 0.001 }, mids: { BTC: 0.04 } });
  const out = await close(['BTC', JSON.stringify(signalMeta('alice', 't1'))], ledger, hl);
  assert.equal(out.status, 'refused');
  if (out.status === 'refused') assert.match(out.reason, /Can't express a sell limit price/);
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.equal(ledger.saves, 0);
});

test('`manual` with no position refuses without an order', async () => {
  const hl = fakeHl({ positions: {} });
  const out = await close(['SOL', 'manual'], new MemoryLedgerStore(), hl);
  assert.equal(out.status, 'refused');
  assert.ok(!hl.calls.includes('placeMarketOrder'));
});

test('`manual` with no position but stale entries closes them without an order', async () => {
  const ledger = new MemoryLedgerStore([aliceSol, copyEntry('tx-eth', 'ETH', 1, 'alice', 't3')]);
  const hl = fakeHl({ positions: { ETH: 1 } });
  const out = await close(['SOL', 'manual'], ledger, hl);
  assert.equal(out.status, 'already_closed');
  assert.ok(!hl.calls.includes('placeMarketOrder'));
  assert.deepEqual(ledger.entries.map(e => [e.id, e.status]), [['tx-alice', 'closed'], ['tx-eth', 'open']]);
});
