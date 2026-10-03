import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN } from '../env.js';
import * as invo from '../invo-client.js';
import { FollowedTraderRegistry } from '../followed-registry.js';
import { FileLedgerStore, defaultLedgerPath } from '../copy-ledger.js';
import {
  SignalWatcher,
  FileStateStore,
  defaultMonitorStatePath,
  followingSummary,
  DEFAULT_MAX_CATCHUP_SEC,
  DEFAULT_MAX_SIGNAL_AGE_SEC,
  type WatchEntry,
  type WatchEvent,
} from '../signal-watcher.js';

validateEnv();
if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);

const DEFAULT_REFRESH_SEC = 60;
const FEED_INTERVAL = 5_000; // 5s for faster signal detection

function usage(): never {
  console.error('Usage: monitor [--wait-for-signal] [--refresh=<sec>] [--max-catchup=<sec>] [--max-signal-age=<sec>] [watchEntries]');
  console.error('');
  console.error('Traders are the users your Invo account currently follows — loaded at startup');
  console.error(`and re-fetched every --refresh seconds (default ${DEFAULT_REFRESH_SEC}). Follow/unfollow in the Invo app.`);
  console.error('Every open copy in the copy ledger is polled on /dex/trade automatically.');
  console.error('  Watch entries: \'[{"baseShortId":"x","mimicStartedAt":"..."}]\'  (optional, extra /dex/trade polling)');
  console.error('');
  console.error('Seen posts are saved (MONITOR_STATE_PATH, default data/monitor-state.json), so a restart catches up on');
  console.error(`posts made while stopped: closes always; opens/updates only if stopped <= --max-catchup seconds (default ${DEFAULT_MAX_CATCHUP_SEC}).`);
  console.error(`Opens/updates are only emitted if the post's createdAt is <= --max-signal-age seconds old (default ${DEFAULT_MAX_SIGNAL_AGE_SEC}).`);
  console.error('Closes are only emitted for trades with an open copy in the ledger, once each.');
  console.error('');
  console.error('Modes:');
  console.error('  default:             Run forever, print all signals as JSON lines');
  console.error('  --wait-for-signal:   Exit after the first poll with a signal (for agent auto-notify)');
  process.exit(1);
}

function secondsArg(args: string[], name: string, fallback: number, min: number): number {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  const value = arg ? Number(arg.slice(name.length + 3)) : fallback;
  if (!Number.isFinite(value) || value < min) {
    console.error(`--${name} must be a number of seconds >= ${min}`);
    usage();
  }
  return value;
}

function print(events: WatchEvent[]) {
  for (const e of events) (e.stream === 'out' ? console.log : console.error)(JSON.stringify(e.data));
}

async function main() {
  const args = process.argv.slice(2);
  const waitMode = args.includes('--wait-for-signal');
  const refreshSec = secondsArg(args, 'refresh', DEFAULT_REFRESH_SEC, 10);
  const maxCatchUpSec = secondsArg(args, 'max-catchup', DEFAULT_MAX_CATCHUP_SEC, 0);
  const maxSignalAgeSec = secondsArg(args, 'max-signal-age', DEFAULT_MAX_SIGNAL_AGE_SEC, 10);
  const flags = ['--wait-for-signal', '--refresh=', '--max-catchup=', '--max-signal-age='];
  const unknown = args.filter(a => !a.startsWith('[') && !flags.some(f => (f.endsWith('=') ? a.startsWith(f) : a === f)));
  if (unknown.length) usage();

  // Watch entries (objects) are still accepted. Portfolio ID arrays (strings) are
  // no longer needed — the followed-trader list is the source of truth.
  const watchEntries: WatchEntry[] = [];
  let ignoredPortfolioIds = 0;
  for (const arg of args.filter(a => a.startsWith('['))) {
    const arr = JSON.parse(arg);
    if (!Array.isArray(arr)) usage();
    for (const x of arr) {
      if (typeof x === 'string') ignoredPortfolioIds++;
      else if (x?.baseShortId) watchEntries.push(x);
    }
  }
  if (ignoredPortfolioIds) {
    console.error(JSON.stringify({
      type: 'notice',
      message: `Ignoring ${ignoredPortfolioIds} portfolio ID argument(s) — traders come from your Invo following list`,
    }));
  }

  // Fails closed: if the following list can't be loaded at startup, exit rather than copy anyone
  const registry = new FollowedTraderRegistry(invo, { refreshIntervalMs: refreshSec * 1000 });
  await registry.refresh();

  const watcher = new SignalWatcher({
    invo,
    registry,
    ledger: new FileLedgerStore(defaultLedgerPath()),
    state: new FileStateStore(defaultMonitorStatePath()),
    watchEntries,
    maxCatchUpMs: maxCatchUpSec * 1000,
    maxSignalAgeMs: maxSignalAgeSec * 1000,
  });

  console.log(JSON.stringify({
    type: 'started',
    waitForSignal: waitMode,
    watchEntries: watchEntries.length,
    followedTraders: registry.traders.length,
    refreshSec,
    maxCatchUpSec,
    maxSignalAgeSec,
  }));
  console.log(JSON.stringify({ type: 'following_loaded', ...followingSummary(registry.traders) }));
  if (registry.traders.length === 0) {
    console.error(JSON.stringify({ type: 'notice', message: 'Your Invo account follows nobody — no new trades will be copied until you follow someone' }));
  }

  // The first poll catches up on what happened while stopped (see signal-watcher.ts)
  for (;;) {
    const events = await watcher.poll();
    print(events);
    if (waitMode && events.some(e => e.signal)) process.exit(0);
    await new Promise(r => setTimeout(r, FEED_INTERVAL));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
