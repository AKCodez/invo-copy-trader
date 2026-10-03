import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimicMetaFromUpdate, parseMimicMeta, parseMimicMetaArg } from './mimic-meta.js';

// Feed post `update` shape (the trader's investment): { id, baseId, baseShortId, owner: { id }, portfolio: { id }, ... }
const update = {
  id: 'upd-1',
  baseId: 'base-1',
  baseShortId: 'aB3xY9_kLm',
  ticker: 'SOL',
  owner: { id: 'u-trader' },
  portfolio: { id: 'p-main' },
};

test('builds mimicMeta from the trader\'s update with the trader\'s baseShortId', () => {
  assert.deepEqual(mimicMetaFromUpdate(update), {
    portfolioId: 'p-main',
    creatorInvoUserId: 'u-trader',
    initialSourcePaperUpdateId: 'upd-1',
    sourcePaperTradeBaseId: 'base-1',
    sourcePaperTradeBaseShortId: 'aB3xY9_kLm',
  });
});

test('a signal\'s mimicMeta round-trips through parseMimicMeta', () => {
  const meta = mimicMetaFromUpdate(update);
  assert.deepEqual(parseMimicMeta(JSON.parse(JSON.stringify(meta))), meta);
});

test('rejects mimicMeta with a missing or empty field', () => {
  const meta = mimicMetaFromUpdate({ ...update, baseShortId: undefined });
  assert.throws(() => parseMimicMeta(JSON.parse(JSON.stringify(meta))), /sourcePaperTradeBaseShortId/);
  assert.throws(() => parseMimicMeta({ ...mimicMetaFromUpdate(update), initialSourcePaperUpdateId: ' ' }), /initialSourcePaperUpdateId/);
});

test('rejects the old monitor mimicMeta shape', () => {
  const old = { portfolioId: 'p-main', creatorInvoUserId: 'u-trader', baseId: 'base-1', baseShortId: 'aB3xY9_kLm' };
  assert.throws(() => parseMimicMeta(old), /old \{baseId, baseShortId\}/);
});

test('rejects non-objects', () => {
  for (const bad of [null, 'x', 1, []]) assert.throws(() => parseMimicMeta(bad));
});

// --- trade.ts argument ---

test('trade.ts requires mimicMeta — a missing argument never becomes made-up IDs', () => {
  for (const arg of [undefined, '', '  ']) assert.throws(() => parseMimicMetaArg(arg), /mimicMeta is required/);
});

test('trade.ts accepts the signal\'s mimicMeta JSON', () => {
  const meta = mimicMetaFromUpdate(update);
  assert.deepEqual(parseMimicMetaArg(JSON.stringify(meta)), meta);
  assert.throws(() => parseMimicMetaArg('{not json'), /not valid JSON/);
  assert.throws(() => parseMimicMetaArg('{}'), /missing/);
});

test('\'manual\' means a trade that copies nobody (no mimicMeta)', () => {
  assert.equal(parseMimicMetaArg('manual'), null);
});
