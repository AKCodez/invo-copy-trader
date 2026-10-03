// One trade/close at a time. Both read the ledger, trade, then rewrite it; two
// running at once could overwrite each other's entries. The lock is a file
// created with O_EXCL holding the owner's pid and a heartbeat the owner renews
// while it runs. A lock is taken over only if its owner is gone: the pid is
// dead (same host), or the heartbeat has stopped. A run that is merely slow
// (waiting on the network) keeps its lock.

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { dirname } from 'path';
import { hostname } from 'os';

export interface LockOptions {
  /** How long to wait for another run to finish. */
  timeoutMs?: number;
  pollMs?: number;
  /** How often the holder renews its heartbeat. */
  heartbeatMs?: number;
  /** A lock whose heartbeat (or, if unreadable, whose file) is older than this is stale. */
  staleMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

interface LockInfo {
  pid: number;
  host: string;
  at: number; // last heartbeat
  token: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // exists, owned by someone else
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, 'utf8'));
    return typeof info?.token === 'string' && typeof info?.at === 'number' ? info : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Run `fn` holding the lock at `path`. Throws if the lock can't be had within timeoutMs. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 250;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? pidAlive;
  const me = { pid: process.pid, host: hostname(), token: `${process.pid}-${now()}-${Math.random()}` };
  const deadline = now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, 'wx');
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (fd !== null) {
      try {
        writeSync(fd, JSON.stringify({ ...me, at: now() }));
        closeSync(fd);
      } catch (e) {
        // Never leave an empty lock behind: it would block every later run
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(path); } catch { /* gone */ }
        throw e;
      }
      break;
    }

    const held = readLock(path);
    let stale: boolean;
    if (held) {
      stale = now() - held.at > staleMs || (held.host === me.host && !isAlive(held.pid));
    } else {
      // Unreadable: normally a lock being written this instant. If it stays that
      // way, its writer died between creating and writing it.
      let mtime: number | null = null;
      try { mtime = statSync(path).mtimeMs; } catch { /* removed meanwhile */ }
      stale = mtime !== null && now() - mtime > Math.min(staleMs, 5_000);
    }
    if (stale) {
      // Move it aside, then check we moved the stale lock and not a fresh one
      // another process took in between; put a fresh one back if so.
      const aside = `${path}.stale.${me.token}`;
      try {
        renameSync(path, aside);
        const moved = readLock(aside);
        if (held ? moved?.token !== held.token : moved !== null) {
          try { linkSync(aside, path); } catch { /* someone holds it again */ }
        }
        unlinkSync(aside);
      } catch { /* lost the race; retry */ }
      continue;
    }

    if (now() >= deadline) {
      throw new Error(
        `another trade/close is running (lock ${path} held by pid ${held?.pid ?? '?'}) — try again shortly`,
      );
    }
    await sleep(pollMs);
  }

  // Renew the heartbeat while fn runs, so a slow run is never mistaken for a dead one
  const heartbeat = setInterval(() => {
    try {
      if (readLock(path)?.token !== me.token) return; // not ours any more
      const tmp = `${path}.${me.token}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...me, at: now() }));
      renameSync(tmp, path);
    } catch { /* try again next beat */ }
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only remove our own lock
    if (readLock(path)?.token === me.token) unlinkSync(path);
  }
}
