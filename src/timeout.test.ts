import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from './timeout.js';

test('withTimeout rejects a call that hangs, and passes through one that settles', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 'placeOrder SOL', 20), /placeOrder SOL timed out after 0.02s/);
  assert.equal(await withTimeout(Promise.resolve('ok'), 'x', 20), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 'x', 20), /boom/);
});
