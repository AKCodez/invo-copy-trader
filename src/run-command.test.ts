import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { runCommand, type CommandIo } from './run-command.js';

function fakeIo() {
  const io: CommandIo & { logs: string[]; errors: string[]; codes: number[] } = {
    logs: [], errors: [], codes: [],
    log(line) { this.logs.push(line); },
    error(line) { this.errors.push(line); },
    exit(code) { this.codes.push(code); },
  };
  return io;
}

test('prints the result as JSON and exits 0, or 1 when the result is a failure', async () => {
  const ok = fakeIo();
  await runCommand(async () => ({ status: 'filled' }), r => r.status !== 'filled', ok);
  assert.deepEqual([ok.logs, ok.errors, ok.codes], [['{"status":"filled"}'], [], [0]]);

  const failed = fakeIo();
  await runCommand(async () => ({ status: 'refused' }), r => r.status !== 'filled', failed);
  assert.deepEqual([failed.logs, failed.codes], [['{"status":"refused"}'], [1]]);
});

test('a thrown error is printed to stderr and exits 1', async () => {
  const io = fakeIo();
  await runCommand(async () => { throw new Error('another trade/close is running'); }, () => false, io);
  assert.deepEqual([io.logs, io.errors, io.codes], [[], ['another trade/close is running'], [1]]);
});

test('the process exits even with a timer left running (as the HL SDK leaves one)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-command-test-'));
  try {
    const script = join(dir, 'cmd.ts');
    const helper = fileURLToPath(new URL('./run-command.ts', import.meta.url));
    writeFileSync(script, [
      `import { runCommand } from ${JSON.stringify(helper)};`,
      // Like SymbolConversion.startPeriodicRefresh: never unref'd, keeps the event loop alive
      `setInterval(() => {}, 60_000);`,
      `runCommand(async () => ({ status: 'closed' }), r => r.status !== 'closed');`,
    ].join('\n'));
    const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const started = Date.now();
    const r = spawnSync(tsx, [script], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.error, undefined, 'process had to be killed: it did not exit on its own');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '{"status":"closed"}');
    assert.ok(Date.now() - started < 20_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
