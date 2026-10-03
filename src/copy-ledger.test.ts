import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileLedgerStore, beginOpen, beginClose, settleOrder, findCopyToClose, planCopyClose, floorQty } from './copy-ledger.js';
import { copyEntry } from './test-fakes.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'copy-ledger-test-'));
}

test('file ledger: missing file is empty, saves round-trip, no temp file left behind', () => {
  const dir = tempDir();
  try {
    const store = new FileLedgerStore(join(dir, 'nested', 'ledger.json'));
    assert.deepEqual(store.load(), []);
    const entries = [copyEntry('tx-1', 'SOL', 0.5, 'alice', 't1')];
    store.save(entries);
    assert.deepEqual(store.load(), entries);
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['ledger.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file ledger: corrupt or malformed file throws (fail closed)', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, '{not json');
    assert.throws(() => new FileLedgerStore(path).load(), /unreadable/);
    writeFileSync(path, JSON.stringify({ version: 1 }));
    assert.throws(() => new FileLedgerStore(path).load(), /malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const openIntent = (over: object = {}) => ({
  id: 'tx-new', coin: 'SOL', side: 'long' as const, source: null, sourceUpdateId: null, cloid: '0xc1', requestedQty: 0.2, now: 'now', ...over,
});

test('a manual fill never merges into a trader\'s copy', () => {
  const start = [copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1')];
  const begun = beginOpen(start, openIntent({ id: 'tx-m' }));
  const entries = settleOrder(begun.entries, begun.entryId, 0.2, 2, 'now');
  assert.deepEqual(entries.map(e => [e.id, e.qty, e.status]), [['tx-alice', 0.5, 'open'], ['tx-m', 0.2, 'open']]);
});

test('an open is pending until settled; with no fill a new copy disappears', () => {
  const begun = beginOpen([], openIntent({ sourceUpdateId: 'upd-1' }));
  assert.deepEqual(begun.entries.map(e => [e.status, e.qty, e.pendingOrder?.cloid, e.sourceUpdateIds]), [['pending', 0, '0xc1', ['upd-1']]]);
  assert.deepEqual(settleOrder(begun.entries, begun.entryId, 0, 2, 'now'), []);
  const filled = settleOrder(begun.entries, begun.entryId, 0.2, 2, 'now', 'rec-1');
  assert.deepEqual(filled.map(e => [e.status, e.qty, e.pendingOrder, e.positionRecordIds]), [['open', 0.2, undefined, ['rec-1']]]);
});

test('an increase with no fill releases its update id; a close settles by its fill', () => {
  const alice = copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1');
  const source = alice.source;
  const begun = beginOpen([alice], openIntent({ source, sourceUpdateId: 'upd-t1-add' }));
  assert.equal(begun.entryId, 'tx-alice');
  assert.deepEqual(begun.entries[0].sourceUpdateIds, ['upd-t1', 'upd-t1-add']);
  const none = settleOrder(begun.entries, 'tx-alice', 0, 2, 'now');
  assert.deepEqual([none[0].qty, none[0].sourceUpdateIds, none[0].pendingOrder], [0.5, ['upd-t1'], undefined]);

  const closing = beginClose([alice], 'tx-alice', '0xc2', 0.5, 'now');
  assert.throws(() => beginClose(closing, 'tx-alice', '0xc3', 0.5, 'now'), /unsettled order/);
  assert.deepEqual(settleOrder(closing, 'tx-alice', 0.2, 2, 'now').map(e => [e.status, e.qty]), [['open', 0.3]]);
  assert.deepEqual(settleOrder(closing, 'tx-alice', 0.5, 2, 'now').map(e => [e.status, e.qty]), [['closed', 0]]);
});

test('close matching: baseId identifies the trade; baseShortId only when there is no baseId', () => {
  const entries = [copyEntry('tx-alice', 'SOL', 0.5, 'alice', 't1'), copyEntry('tx-bob', 'SOL', 0.3, 'bob', 't2')];
  const id = (o: object) => ({ creatorInvoUserId: 'alice', ...o });
  // A differing baseShortId on the close post doesn't stop a baseId match
  assert.equal(findCopyToClose(entries, 'SOL', id({ sourcePaperTradeBaseId: 'base-t1', sourcePaperTradeBaseShortId: 'other' })).kind, 'match');
  assert.equal(findCopyToClose(entries, 'SOL', id({ sourcePaperTradeBaseShortId: 'short-t1' })).kind, 'match');
  // A different baseId never matches, whatever the short id says
  assert.equal(findCopyToClose(entries, 'SOL', id({ sourcePaperTradeBaseId: 'base-t2', sourcePaperTradeBaseShortId: 'short-t1' })).kind, 'refuse');
  // Another trader's trade ids never match
  assert.equal(findCopyToClose(entries, 'SOL', id({ sourcePaperTradeBaseId: 'base-t2' })).kind, 'refuse');
});

test('close quantity is rounded down to the lot size, never up', () => {
  assert.equal(floorQty(0.129, 2), 0.12);
  assert.equal(floorQty(0.3, 2), 0.3); // no float drift below an exact lot
  const plan = planCopyClose(copyEntry('tx', 'SOL', 0.129, 'alice'), [], 1, 2);
  assert.deepEqual(plan, { kind: 'close', qty: 0.12, isLong: true, full: false });
});
