import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import { withFileLock } from './file-lock.js';

function withTempDir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-lock-test-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('runs are serialised: the second waits for the first to finish', withTempDir(async dir => {
  const lock = join(dir, 'ledger.json.lock');
  const log: string[] = [];
  const run = (name: string) => withFileLock(lock, async () => {
    log.push(`${name} start`);
    await sleep(30);
    log.push(`${name} end`);
  }, { pollMs: 5 });
  await Promise.all([run('a'), run('b')]);
  assert.deepEqual(log, ['a start', 'a end', 'b start', 'b end']);
  assert.equal(existsSync(lock), false);
}));

test('the lock is released when the run throws', withTempDir(async dir => {
  const lock = join(dir, 'l.lock');
  await assert.rejects(withFileLock(lock, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(lock), false);
  assert.equal(await withFileLock(lock, async () => 'ok'), 'ok');
}));

test('a lock held by a live process times out with a clear error', withTempDir(async dir => {
  const lock = join(dir, 'l.lock');
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: hostname(), at: Date.now(), token: 'other' }));
  await assert.rejects(
    withFileLock(lock, async () => assert.fail('ran while locked'), { timeoutMs: 50, pollMs: 5, isAlive: () => true }),
    /another trade\/close is running .* pid 4242/,
  );
  assert.equal(existsSync(lock), true); // not ours to remove
}));

test('a lock left by a dead process, or an old one, is taken over', withTempDir(async dir => {
  const lock = join(dir, 'l.lock');
  writeFileSync(lock, JSON.stringify({ pid: 4242, host: hostname(), at: Date.now(), token: 'dead' }));
  assert.equal(await withFileLock(lock, async () => 'ran', { timeoutMs: 50, isAlive: () => false }), 'ran');

  writeFileSync(lock, JSON.stringify({ pid: 4242, host: 'other-host', at: Date.now() - 11 * 60_000, token: 'old' }));
  assert.equal(await withFileLock(lock, async () => 'ran', { timeoutMs: 50, isAlive: () => true }), 'ran');
  assert.equal(existsSync(lock), false);
}));

test('a slow but live run keeps its lock past the stale age (heartbeat)', withTempDir(async dir => {
  const lock = join(dir, 'l.lock');
  const log: string[] = [];
  const opts = { staleMs: 100, heartbeatMs: 20, pollMs: 10, isAlive: () => true };
  const slow = withFileLock(lock, async () => { log.push('slow start'); await sleep(350); log.push('slow end'); }, opts);
  await sleep(20);
  const other = withFileLock(lock, async () => { log.push('other'); }, opts);
  await Promise.all([slow, other]);
  assert.deepEqual(log, ['slow start', 'slow end', 'other']);
}));

test('an empty lock file (writer died before writing) is taken over once it is old, not before', withTempDir(async dir => {
  const lock = join(dir, 'l.lock');
  writeFileSync(lock, '');
  await assert.rejects(withFileLock(lock, async () => 'ran', { timeoutMs: 30, pollMs: 5 }), /another trade\/close is running/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(await withFileLock(lock, async () => 'ran', { timeoutMs: 30, pollMs: 5 }), 'ran');
  assert.equal(existsSync(lock), false);
}));
