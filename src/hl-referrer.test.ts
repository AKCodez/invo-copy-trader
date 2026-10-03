// The SDK's automatic setReferrer write is switched off. Uses the real SDK class with a
// throwaway key; every network path is stubbed or blocked, so nothing is sent anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { Hyperliquid } from 'hyperliquid';
import { disableSdkReferrer } from './hl-client.js';

const realFetch = globalThis.fetch;
function blockNetwork() {
  globalThis.fetch = (async () => { throw new Error('network blocked in tests'); }) as typeof fetch;
}
function restoreNetwork() {
  globalThis.fetch = realFetch;
}

/** An SDK instance whose exchange requests are recorded instead of sent. */
function offlineSdk() {
  const sdk = new Hyperliquid({ privateKey: `0x${randomBytes(32).toString('hex')}`, enableWs: false });
  const ex = (sdk as any).exchange;
  const sent: any[] = [];
  ex.httpApi.makeRequest = async (payload: any) => { sent.push(payload); return { status: 'ok' }; };
  ex.symbolConversion.getAssetIndex = async () => 0; // no meta fetch
  (sdk as any).ensureInitialized = async () => {};
  return { sdk, ex, sent };
}
const tick = () => new Promise(r => setTimeout(r, 20));

test('without the fix, the SDK sends a setReferrer action on its own after the first coin lookup', async () => {
  blockNetwork();
  try {
    const { ex, sent } = offlineSdk();
    await ex.getAssetIndex('BTC-PERP');
    await tick();
    assert.deepEqual(sent.map(p => [p.action?.type, p.action?.code]), [['setReferrer', 'PLACEHOLDER']]);
  } finally {
    restoreNetwork();
  }
});

test('disableSdkReferrer: no setReferrer is ever scheduled or sent, and calling it directly throws', async () => {
  blockNetwork();
  try {
    const { sdk, ex, sent } = offlineSdk();
    disableSdkReferrer(sdk);
    for (const coin of ['BTC-PERP', 'SOL-PERP', 'TAO-PERP']) await ex.getAssetIndex(coin);
    await tick();
    assert.deepEqual(sent, []);
    assert.throws(() => ex.setReferrer(), /setReferrer is disabled/);
    assert.throws(() => ex.setReferrer('ANY'), /setReferrer is disabled/);
    assert.deepEqual(sent, []);
  } finally {
    restoreNetwork();
  }
});

test('disableSdkReferrer leaves the order path itself working (requests still go out, none of them setReferrer)', async () => {
  blockNetwork();
  try {
    const { sdk, ex, sent } = offlineSdk();
    disableSdkReferrer(sdk);
    await ex.placeOrder({
      coin: 'BTC-PERP', is_buy: false, sz: 0.001, limit_px: 60000, order_type: { limit: { tif: 'Ioc' } }, reduce_only: true,
    });
    await tick();
    assert.deepEqual(sent.map(p => p.action?.type), ['order']);
    assert.equal(sent[0].action.orders[0].r, true, 'reduce-only flag carried through');
  } finally {
    restoreNetwork();
  }
});

test('disableSdkReferrer refuses an SDK whose shape changed (fails closed)', () => {
  assert.throws(() => disableSdkReferrer({} as any), /SDK shape changed/);
  assert.throws(() => disableSdkReferrer({ exchange: { setReferrer() {}, getAssetIndex() {} } } as any), /SDK shape changed/);
});
