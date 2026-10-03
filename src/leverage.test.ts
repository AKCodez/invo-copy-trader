import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeverageArg, checkLeverage } from './leverage.js';

test('parses whole-number leverage', () => {
  assert.equal(parseLeverageArg('1'), 1);
  assert.equal(parseLeverageArg('8'), 8);
  assert.equal(parseLeverageArg(' 20 '), 20);
});

test('rejects missing, non-numeric, fractional, zero and negative leverage', () => {
  for (const bad of [undefined, '', 'abc', 'manual', '{"portfolioId":"p"}', '5x', '2.5', '0', '-3', '1e2', 'NaN', '99999999999999999999']) {
    assert.throws(() => parseLeverageArg(bad), /leverage must be a whole number/, String(bad));
  }
});

test('accepts leverage up to the asset max', () => {
  assert.doesNotThrow(() => checkLeverage(1, 'SOL', 20));
  assert.doesNotThrow(() => checkLeverage(20, 'SOL', 20));
});

test('rejects leverage above the asset max', () => {
  assert.throws(() => checkLeverage(21, 'SOL', 20), /exceeds SOL max of 20x/);
});

test('a missing or invalid asset max fails closed', () => {
  for (const max of [undefined, null, 0, NaN, '20']) {
    assert.throws(() => checkLeverage(5, 'SOL', max), /No valid maxLeverage/, String(max));
  }
});
