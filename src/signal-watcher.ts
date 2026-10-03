// The monitor's polling loop, without the process around it: Invo, the
// followed-trader registry, the copy ledger and the saved state are injected,
// so it is testable without network or disk.
//
// What it guarantees, beyond filtering (following.ts classifyPost):
//  - Seen posts are saved between runs. A restart (e.g. after --wait-for-signal
//    exits) catches up on posts made while it was stopped instead of treating
//    them as old: closes always; opens/updates only if the gap was short
//    (maxCatchUpMs), since copying a stale entry is a trade at a stale price.
//  - The feed is paged back to the last post already seen, so a burst of more
//    than one page between polls isn't lost.
//  - Every open copy in the ledger is watched on /dex/trade, so its close is
//    seen even if the trader is unfollowed (their posts leave the feed).
//  - A close for a trade we copied gets through even from someone no longer
//    followed; close.ts only acts on it if the ledger matches.
//  - Every close seen is remembered (closedTrades, saved with the state). Each
//    poll, a close signal is sent for every remembered trade we still hold an
//    open copy of — so a copy opened just after its trader closed is still
//    closed, and a close that didn't complete (not filled, partial, unknown,
//    refused for a passing reason) is re-sent every closeRetryMs (90s), up to
//    maxCloseAttempts; then one close_stuck alert asks for the user.
//  - Opens/updates are only emitted if the post itself is recent (createdAt):
//    a newly followed trader's older posts appearing in the feed are not new trades.
//  - Every change the trader makes to a trade we hold a copy of is passed on
//    from /dex/trade, so the copy can replicate it: `increase` (only if recent —
//    an add at a stale price isn't the trader's add), `decrease` (their partial
//    close) and `tpsl` (their take-profit / stop-loss), in the order they made
//    them. Each carries an updateId the ledger records, so it is applied once.
//  - An increase/decrease is held until the feed post for it arrives (matched
//    exactly: post update.id == the change's investmentId) and is sent with that
//    post's $ figures (entrySim, simDifference, prices), which the size ratio is
//    computed from. /dex/trade's positionSize is a share of the trader's portfolio
//    value at that moment, so its ratio drifts when their portfolio value changes
//    (seen live: 2.07 reported for a 1.29× add). No post within notionalWaitMs
//    (default 120s) → the change is not replicated, never sized from positionSize.
//  - A change to a copied trade that can't be replicated (no post with $ figures,
//    a post that doesn't match, a stale add, an unknown or unreadable change) is
//    reported on stdout as `change_not_replicated` and ends --wait-for-signal, so
//    the user hears that the copy no longer matches the trader. Changes there is
//    nothing to replicate for (copy gone, trade closed, made before our copy) stay
//    quiet stderr `skipped` lines.
//  - A /dex/trade updateType never seen live is never read as a close from its name.
//    Invo's /investment/status is asked instead: closed → our copy is closed like any
//    other close (plus an `unknown_update_closed` notice); open → change_not_replicated;
//    unreadable → change_not_replicated, and the status is re-checked on later polls
//    (up to maxStatusChecks) so a real close still closes the copy.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { classifyPost, type FollowedTrader } from './following.js';
import { mimicMetaFromUpdate } from './mimic-meta.js';
import type { CopyEntry } from './copy-ledger.js';

export interface WatchEntry {
  baseShortId: string;
  mimicStartedAt: string;
}

/** A trade its trader has closed, remembered so our copy of it keeps being closed until it is. */
export interface ClosedTrade {
  ownerId: string;
  baseId?: string;
  baseShortId?: string;
  coin?: string;
  closingPrice?: number | null;
  /** Why the trader's trade closed: user_closed, take_profit_hit, stop_loss_hit, liquidated. */
  reasonClosed?: string | null;
  source: 'feed' | 'trade_poll';
  postId?: string;
  catchUp?: boolean;
  seenAt: number;
  /** Close signals sent for it so far, and when the last one was. */
  attempts: number;
  lastEmittedAt: number | null;
  gaveUp?: boolean;
}

/**
 * A trader's increase/decrease in $, from the feed post for it (post update.id ==
 * the /dex/trade change's investmentId). Verified live: for increases the coin
 * ratio these give reproduces Invo's new average entry price exactly.
 */
export interface ChangeNotional {
  investmentId: string;
  ownerId: string;
  baseId: string | null;
  baseShortId: string | null;
  postId: string;
  simIncrease: boolean;
  /** $ of the trade before the change, at its entry price (changes.entrySim). */
  entrySimBefore: number;
  /** $ added (at livePriceAtChange) or removed. */
  simDifference: number;
  /** Average entry before the change (changes.entryPrice — present on increases). */
  entryPriceBefore: number | null;
  livePriceAtChange: number | null;
  /** $ and average entry after the change (the post's update.entrySim / entryPrice). */
  entrySimAfter: number | null;
  entryPriceAfter: number | null;
  seenAt: number;
}

/**
 * A /dex/trade change of an unknown type to a trade we copied, waiting for Invo's
 * /investment/status to say whether the trade is closed.
 */
export interface UnconfirmedChange {
  entryId: string;
  updateId: string;
  update: any;
  seenAt: number;
  /** Status lookups made so far. */
  checks: number;
}

/** An increase/decrease waiting for the feed post with its $ figures. */
export interface PendingChange {
  entryId: string;
  updateId: string;
  update: any;
  seenAt: number;
}

export interface MonitorState {
  version: 1;
  seenPostIds: string[];
  seenTradeUpdates: string[];
  /** Absent in state saved before closes were remembered. */
  closedTrades?: ClosedTrade[];
  /** Absent in state saved before changes were sized from feed posts. */
  changeNotionals?: ChangeNotional[];
  pendingChanges?: PendingChange[];
  /** Absent in state saved before unknown update types were checked against the trade's status. */
  unconfirmedChanges?: UnconfirmedChange[];
  savedAt: number;
}

export interface StateStore {
  /** null when there is no saved state; throws if it can't be read. */
  load(): MonitorState | null;
  save(state: MonitorState): void;
}

export function defaultMonitorStatePath(): string {
  return process.env.MONITOR_STATE_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'monitor-state.json');
}

export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  load(): MonitorState | null {
    if (!existsSync(this.path)) return null;
    const data = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!Array.isArray(data?.seenPostIds) || !Array.isArray(data?.seenTradeUpdates) || typeof data?.savedAt !== 'number' ||
        (data.closedTrades !== undefined && !Array.isArray(data.closedTrades)) ||
        (data.changeNotionals !== undefined && !Array.isArray(data.changeNotionals)) ||
        (data.pendingChanges !== undefined && !Array.isArray(data.pendingChanges)) ||
        (data.unconfirmedChanges !== undefined && !Array.isArray(data.unconfirmedChanges))) {
      throw new Error(`monitor state ${this.path} is malformed`);
    }
    return data;
  }

  save(state: MonitorState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path);
  }
}

export interface WatcherInvo {
  getFeed(filter: string, lastPostId: string | null, itemLimit: number): Promise<any>;
  getTradeUpdates(investments: WatchEntry[]): Promise<any>;
  /** GET /investment/status/{baseId} — seen live: { status: { isOpen, exists }, success: true }. */
  getInvestmentStatus(investmentBaseId: string): Promise<any>;
}

export interface WatcherRegistry {
  traders: FollowedTrader[];
  byUserId: Map<string, FollowedTrader>;
  refreshIfDue(): Promise<{ added: object[]; removed: object[] } | null>;
  refreshOnDemand(): Promise<{ added: object[]; removed: object[] } | null>;
  refreshPortfolios(userId: string): Promise<boolean>;
}

export interface WatcherOptions {
  invo: WatcherInvo;
  registry: WatcherRegistry;
  ledger: { load(): CopyEntry[] };
  state: StateStore;
  /** Extra /dex/trade watch entries from the command line. */
  watchEntries?: WatchEntry[];
  now?: () => number;
  /** Opens/updates missed while stopped are emitted only if the gap was at most this long. */
  maxCatchUpMs?: number;
  /** Opens/updates are emitted only if the post is at most this old. */
  maxSignalAgeMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** How many seen ids to keep. */
  maxSeen?: number;
  /** Re-send a close for a copy that is still open after this long. */
  closeRetryMs?: number;
  /** Close signals per trade before giving up with a close_stuck alert. */
  maxCloseAttempts?: number;
  /** How long a closed trade is remembered (for a copy that appears late). */
  closedTradeRetentionMs?: number;
  /** How long an increase/decrease waits for the feed post with its $ figures before it is skipped. */
  notionalWaitMs?: number;
  /** Status lookups (one per poll) for an unknown /dex/trade change whose status can't be read. */
  maxStatusChecks?: number;
}

export interface WatchEvent {
  stream: 'out' | 'err';
  data: Record<string, unknown>;
  /** A signal or trade update: ends --wait-for-signal. */
  signal?: boolean;
}

export const DEFAULT_MAX_CATCHUP_SEC = 300;
export const DEFAULT_MAX_SIGNAL_AGE_SEC = 300;
/**
 * Longer than MIN_SETTLE_AGE_MS (60s): a retry after an `unknown` close must find the
 * earlier order old enough to settle, or close.ts refuses it and the attempt is wasted.
 */
export const DEFAULT_CLOSE_RETRY_SEC = 90;
export const DEFAULT_MAX_CLOSE_ATTEMPTS = 10;
export const DEFAULT_CLOSED_TRADE_RETENTION_SEC = 24 * 3600;
/** Feed posts for changes were seen ~6s after the change; 120s leaves room for a slow feed. */
export const DEFAULT_NOTIONAL_WAIT_SEC = 120;
export const DEFAULT_MAX_STATUS_CHECKS = 10;
const MAX_NOTIONALS = 500;

const finiteOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface TradeIds {
  ownerId: string;
  baseId?: string;
  baseShortId?: string;
}

/** Same trader, same trade: by baseId when both have one, else by baseShortId. */
export function sameTrade(a: TradeIds, b: TradeIds): boolean {
  if (a.ownerId !== b.ownerId) return false;
  if (a.baseId && b.baseId) return a.baseId === b.baseId;
  return !!a.baseShortId && a.baseShortId === b.baseShortId;
}

/**
 * Does a /dex/trade entry belong to this copy? Same trader (when the entry names
 * one) and same trade, by baseId or baseShortId.
 */
function isCopyOf(c: CopyEntry, t: Partial<TradeIds>): boolean {
  const src = c.source!;
  if (t.ownerId && t.ownerId !== src.creatorInvoUserId) return false;
  if (t.baseId && src.sourcePaperTradeBaseId) return t.baseId === src.sourcePaperTradeBaseId;
  return !!t.baseShortId && t.baseShortId === src.sourcePaperTradeBaseShortId;
}

/**
 * A /dex/trade update that means the trade is over: updateType "close". Every close
 * seen live has this type, liquidations included (details.reasonClosed "liquidated",
 * 6 of 86). Any other type is not guessed at from its name: on a copied trade the
 * trade's status is checked (resolveUnconfirmedChanges).
 */
export function isCloseUpdate(u: any): boolean {
  return typeof u?.updateType === 'string' && u.updateType.toLowerCase() === 'close';
}

const copyIds = (c: CopyEntry): TradeIds => ({
  ownerId: c.source!.creatorInvoUserId,
  baseId: c.source!.sourcePaperTradeBaseId || undefined,
  baseShortId: c.source!.sourcePaperTradeBaseShortId || undefined,
});

const KNOWN_CHANGE_TYPES = new Set(['increase', 'decrease', 'tp', 'sl']);

/**
 * Whether Invo says the trade is open, from /investment/status; null if the response
 * isn't the shape seen live (or the trade doesn't exist) — never read as either.
 */
export function investmentIsOpen(res: any): boolean | null {
  const s = res?.status;
  if (res?.success !== true || !s || typeof s !== 'object' || s.exists !== true || typeof s.isOpen !== 'boolean') return null;
  return s.isOpen;
}

/** When the post was made (ms), from post.createdAt (ISO string or epoch ms); null if absent/unreadable. */
export function postTime(post: any): number | null {
  const v = post?.createdAt;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

export class SignalWatcher {
  private seenPosts = new Set<string>();
  private seenTrade = new Set<string>();
  private closed: ClosedTrade[] = [];
  private notionals = new Map<string, ChangeNotional>();
  private pending: PendingChange[] = [];
  private unconfirmed: UnconfirmedChange[] = [];
  /** Closed trades first seen in the current poll. */
  private closedThisPoll = new Set<ClosedTrade>();
  private started = false;
  pollCount = 0;

  constructor(private o: WatcherOptions) {}

  private get now() { return (this.o.now ?? Date.now)(); }

  async poll(): Promise<WatchEvent[]> {
    const events: WatchEvent[] = [];
    const out = (data: Record<string, unknown>, signal = false) => events.push({ stream: 'out', data, ...(signal && { signal }) });
    const err = (data: Record<string, unknown>) => events.push({ stream: 'err', data });
    this.pollCount++;
    this.closedThisPoll.clear();

    // --- First poll of this process: pick up where the last run left off ---
    const first = !this.started;
    let fresh = false; // no saved state: index what's there, emit nothing old
    let gapMs = 0;
    if (first) {
      this.started = true;
      let saved: MonitorState | null = null;
      try {
        saved = this.o.state.load();
      } catch (e: any) {
        err({ type: 'notice', message: `monitor state unreadable (${e.message}) — starting fresh; posts made while stopped are not checked` });
      }
      fresh = saved === null;
      if (saved) {
        saved.seenPostIds.forEach(id => this.seenPosts.add(id));
        saved.seenTradeUpdates.forEach(k => this.seenTrade.add(k));
        this.closed = saved.closedTrades ?? [];
        for (const n of saved.changeNotionals ?? []) this.notionals.set(n.investmentId, n);
        this.pending = saved.pendingChanges ?? [];
        this.unconfirmed = saved.unconfirmedChanges ?? [];
        gapMs = Math.max(0, this.now - saved.savedAt);
      }
    }
    const maxCatchUpMs = this.o.maxCatchUpMs ?? DEFAULT_MAX_CATCHUP_SEC * 1000;

    await this.refreshFollowing(events);

    // Our open copies: watched on /dex/trade, and their closes always let through
    let copies: CopyEntry[] = [];
    let ledgerReadable = true;
    try {
      copies = this.o.ledger.load().filter(e => e.source && (e.status === 'open' || e.status === 'pending'));
    } catch (e: any) {
      ledgerReadable = false;
      err({ type: 'error', source: 'ledger', message: `${e.message} — every followed trader's close is passed on; closes from unfollowed traders can't be recognised` });
    }
    const isCopied = (ownerId: string, baseId?: string, baseShortId?: string) =>
      copies.some(c => sameTrade({ ownerId, baseId, baseShortId }, copyIds(c)));

    await this.pollTradeUpdates(copies, fresh, first && !fresh, out, err);
    if (ledgerReadable) await this.resolveUnconfirmedChanges(copies, first && !fresh, out, err);
    await this.pollFeed({ first, fresh, gapMs, maxCatchUpMs, isCopied, ledgerReadable }, out, err);
    if (ledgerReadable) this.emitPendingChanges(copies, out, err);
    this.emitCloses(copies, ledgerReadable, out);

    try {
      const keep = this.o.maxSeen ?? 2000;
      this.o.state.save({
        version: 1,
        seenPostIds: [...this.seenPosts].slice(-keep),
        seenTradeUpdates: [...this.seenTrade].slice(-keep),
        closedTrades: this.closed,
        changeNotionals: [...this.notionals.values()].sort((a, b) => a.seenAt - b.seenAt).slice(-MAX_NOTIONALS),
        pendingChanges: this.pending,
        unconfirmedChanges: this.unconfirmed,
        savedAt: this.now,
      });
    } catch (e: any) {
      err({ type: 'error', source: 'state', message: `monitor state not saved: ${e.message}` });
    }
    return events;
  }

  private async refreshFollowing(events: WatchEvent[], onDemand = false) {
    try {
      const diff = onDemand ? await this.o.registry.refreshOnDemand() : await this.o.registry.refreshIfDue();
      if (diff && (diff.added.length || diff.removed.length)) {
        events.push({ stream: 'out', data: { type: 'following_changed', ...followingSummary(this.o.registry.traders), added: diff.added, removed: diff.removed } });
      }
    } catch (e: any) {
      // Keep the last known list; a failed refresh never widens who we copy
      events.push({ stream: 'err', data: { type: 'error', source: 'following', message: e.message } });
    }
  }

  /** /dex/trade for command-line entries plus every open copy in the ledger. */
  private async pollTradeUpdates(
    copies: CopyEntry[],
    fresh: boolean,
    catchUp: boolean,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    const watch = new Map<string, WatchEntry>();
    for (const w of this.o.watchEntries ?? []) watch.set(w.baseShortId, w);
    for (const c of copies) {
      const id = c.source!.sourcePaperTradeBaseShortId;
      // From the trader's open, so a TP/SL they set before our copy existed is seen too
      if (id && !watch.has(id)) watch.set(id, { baseShortId: id, mimicStartedAt: c.traderOpenedAt ?? c.openedAt });
    }
    if (!watch.size) return;

    // Response (seen live 2026-10-02):
    //   { success, data: [ { creatorAppUserId, portfolioId, investmentBaseId, investmentBaseShortId,
    //       unmimickedCount, unseenCount,
    //       updates: [ { investmentId, investmentBaseId, updateType, updatedAt, isSeen, isMimicked, details } ] } ] }
    // updateType seen: "close" (details: closePrice, reasonClosed), "tp", "sl", "increase", "decrease".
    // There is no isOpen field.
    let trades: any[];
    try {
      const res = await this.o.invo.getTradeUpdates([...watch.values()]);
      if (res?.success === false || !Array.isArray(res?.data)) {
        err({ type: 'error', source: 'trade', message: `unrecognised /dex/trade response: ${JSON.stringify(res)?.slice(0, 200)}` });
        return;
      }
      trades = res.data;
    } catch (e: any) {
      err({ type: 'error', source: 'trade', message: e.message });
      return;
    }

    const changes: { copy: CopyEntry; u: any; updateId: string }[] = [];
    for (const t of trades) {
      const ids = {
        ownerId: typeof t?.creatorAppUserId === 'string' ? t.creatorAppUserId : undefined,
        baseId: t?.investmentBaseId || undefined,
        baseShortId: t?.investmentBaseShortId || undefined,
      };
      const copy = copies.find(c => isCopyOf(c, ids));
      for (const u of Array.isArray(t?.updates) ? t.updates : []) {
        const updateKey = `${ids.baseShortId ?? ids.baseId}_${u?.investmentId ?? ''}_${u?.updateType ?? ''}_${u?.updatedAt ?? ''}`;
        if (this.seenTrade.has(updateKey)) continue;
        this.seenTrade.add(updateKey);
        // Informational. On a fresh start, existing updates are just indexed.
        if (!fresh) {
          out({
            type: 'trade_update', poll: this.pollCount,
            baseShortId: ids.baseShortId ?? null, ownerId: ids.ownerId ?? null,
            updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null, details: u?.details ?? null,
          });
        }
        if (!copy) continue;

        if (isCloseUpdate(u)) {
          // Sent by emitCloses (and re-sent while the copy stays open) — even on a fresh start
          this.rememberClose({
            ...copyIds(copy), coin: copy.coin, closingPrice: u.details?.closePrice ?? null,
            reasonClosed: u.details?.reasonClosed ?? null,
            source: 'trade_poll', catchUp,
          });
        } else {
          // Changes to our copy's trade are acted on even on a fresh start: the ledger applies each once
          changes.push({ copy, u, updateId: updateKey });
        }
      }
    }
    // In the order the trader made them
    changes.sort((a, b) => String(a.u?.updatedAt ?? '').localeCompare(String(b.u?.updatedAt ?? '')));
    for (const c of changes) {
      const type = typeof c.u?.updateType === 'string' ? c.u.updateType.toLowerCase() : '';
      if (type === 'increase' || type === 'decrease') {
        // Sized from the feed post for it: wait for that (emitPendingChanges)
        if (!this.pending.some(p => p.updateId === c.updateId)) {
          this.pending.push({ entryId: c.copy.id, updateId: c.updateId, update: c.u, seenAt: this.now });
        }
      } else if (!KNOWN_CHANGE_TYPES.has(type)) {
        // Never guessed from its name: the trade's status decides (resolveUnconfirmedChanges)
        if (!this.unconfirmed.some(p => p.updateId === c.updateId)) {
          this.unconfirmed.push({ entryId: c.copy.id, updateId: c.updateId, update: c.u, seenAt: this.now, checks: 0 });
        }
      } else {
        this.emitChange(c.copy, c.u, c.updateId, out, err);
      }
    }
  }

  /**
   * An unknown /dex/trade change to a copied trade: ask Invo whether the trade is still open.
   * Closed → the copy is closed (rememberClose → emitCloses). Open → alerted. Unreadable →
   * alerted once, then re-checked each poll up to maxStatusChecks, in case it was a close.
   */
  private async resolveUnconfirmedChanges(
    copies: CopyEntry[],
    catchUp: boolean,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    const maxChecks = this.o.maxStatusChecks ?? DEFAULT_MAX_STATUS_CHECKS;
    const keep: UnconfirmedChange[] = [];
    for (const p of this.unconfirmed) {
      const u = p.update;
      const copy = copies.find(c => c.id === p.entryId);
      const label = `unknown /dex/trade updateType ${JSON.stringify(u?.updateType ?? null)}`;
      const skip = (reason: string) => err({
        type: 'skipped', poll: this.pollCount, source: 'trade_poll', updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null,
        entryId: p.entryId, ownerId: copy?.source?.creatorInvoUserId ?? null, coin: copy?.coin ?? null, reason,
      });
      if (!copy) { skip(`${label} on a copy that is no longer open — nothing to replicate`); continue; }
      if (this.closedTradeFor(copyIds(copy))) { skip(`${label} on a trade that is already closed`); continue; }
      const baseId = copy.source!.sourcePaperTradeBaseId;
      if (!baseId) {
        this.notReplicated(copy, u, `${label} and no trade baseId to check its status with — not replicated, check it`, out);
        continue;
      }

      let isOpen: boolean | null = null;
      let why = '';
      try {
        const res = await this.o.invo.getInvestmentStatus(baseId);
        isOpen = investmentIsOpen(res);
        if (isOpen === null) why = `unrecognised /investment/status response: ${JSON.stringify(res)?.slice(0, 200)}`;
      } catch (e: any) {
        why = e.message;
      }
      p.checks++;

      if (isOpen === false) {
        this.rememberClose({
          ...copyIds(copy), coin: copy.coin, closingPrice: finiteOrNull(u?.details?.closePrice),
          reasonClosed: typeof u?.details?.reasonClosed === 'string' && u.details.reasonClosed ? u.details.reasonClosed : null,
          source: 'trade_poll', catchUp,
        });
        out({
          type: 'unknown_update_closed',
          poll: this.pollCount,
          message: `${label} on ${copy.coin} (trade ${copy.source!.sourcePaperTradeBaseShortId ?? baseId}): Invo reports the trade closed — ` +
            `our copy is being closed like any other close. Check what this update type is.`,
          entryId: copy.id,
          coin: copy.coin,
          change: { updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null, investmentId: u?.investmentId ?? null, details: u?.details ?? null },
        });
      } else if (isOpen === true) {
        if (p.checks === 1) {
          this.notReplicated(copy, u, `${label} — Invo reports the trade still open, so it is not a close; not replicated, check it`, out);
        } else {
          skip(`${label}: Invo now reports the trade still open — already alerted, no close`);
        }
      } else {
        if (p.checks === 1) {
          this.notReplicated(copy, u, `${label} — the trade's status couldn't be read (${why}); not replicated, ` +
            `re-checking it for a close for up to ${maxChecks} polls`, out);
        }
        if (p.checks < maxChecks) {
          keep.push(p);
        } else {
          err({ type: 'error', source: 'trade_status', entryId: copy.id, coin: copy.coin, updateType: u?.updateType ?? null,
            message: `${label}: trade status still unreadable after ${p.checks} checks (${why}) — no longer re-checked; the copy stays open` });
        }
      }
    }
    this.unconfirmed = keep;
  }

  /** Remember the $ figures of every change post in the feed (see ChangeNotional). */
  private indexChangeNotionals(posts: any[]) {
    for (const p of posts) {
      const u = p?.update;
      const c = u?.changes;
      if (!u || !c || typeof c !== 'object' || p.repostId != null) continue;
      if (typeof u.id !== 'string' || !u.id || typeof u.owner?.id !== 'string') continue;
      if (p.owner?.id && p.owner.id !== u.owner.id) continue;
      const before = finiteOrNull(c.entrySim);
      const diff = finiteOrNull(c.simDifference);
      if (before === null || diff === null || typeof c.simIncrease !== 'boolean') continue;
      this.notionals.set(u.id, {
        investmentId: u.id,
        ownerId: u.owner.id,
        baseId: u.baseId || null,
        baseShortId: u.baseShortId || null,
        postId: p.id,
        simIncrease: c.simIncrease,
        entrySimBefore: before,
        simDifference: diff,
        entryPriceBefore: finiteOrNull(c.entryPrice),
        livePriceAtChange: finiteOrNull(c.livePriceAtChange),
        entrySimAfter: finiteOrNull(u.entrySim),
        entryPriceAfter: finiteOrNull(u.entryPrice),
        seenAt: this.now,
      });
    }
  }

  /**
   * The trader changed a trade we copied and the copy can't follow: stdout, and it ends
   * --wait-for-signal (a quiet skip would leave the copy diverging unnoticed).
   */
  private notReplicated(copy: CopyEntry, u: any, reason: string, out: (d: Record<string, unknown>, signal?: boolean) => void) {
    const type = typeof u?.updateType === 'string' ? u.updateType.toLowerCase() : '';
    const action = type === 'increase' ? 'add' : type === 'decrease' ? 'partial close' : `change (${u?.updateType ?? 'unknown'})`;
    const src = copy.source;
    const username = src ? this.o.registry.byUserId.get(src.creatorInvoUserId)?.username ?? null : null;
    const who = username ? `@${username}` : `trader ${src?.creatorInvoUserId ?? '?'}`;
    const d = u?.details ?? {};
    const sizes = ['positionSizeBefore', 'positionSizeAfter', 'positionSizeChange'].every(k => typeof d[k] === 'number');
    out({
      type: 'change_not_replicated',
      poll: this.pollCount,
      action,
      orderSent: false,
      message: `NOT REPLICATED — ${who}'s ${action} on ${copy.coin} (trade ${src?.sourcePaperTradeBaseShortId ?? '?'}): ${reason}. ` +
        `No order was sent; our copy stays ${copy.qty} ${copy.coin} ${copy.side}, which may no longer match the trader's position.`,
      reason,
      trader: {
        id: src?.creatorInvoUserId ?? null,
        username,
        portfolioId: src?.portfolioId ?? null,
        tradeBaseId: src?.sourcePaperTradeBaseId ?? null,
        tradeBaseShortId: src?.sourcePaperTradeBaseShortId ?? null,
      },
      coin: copy.coin,
      side: copy.side,
      change: {
        updateType: u?.updateType ?? null,
        updatedAt: u?.updatedAt ?? null,
        investmentId: u?.investmentId ?? null,
        // As /dex/trade reports them: a share of the trader's portfolio value, not a size — shown, never sized from
        ...(sizes && { traderPositionShareBefore: d.positionSizeBefore, traderPositionShareAfter: d.positionSizeAfter }),
      },
      // Our copy as the ledger records it, unchanged (coin units)
      copy: { entryId: copy.id, qty: copy.qty, status: copy.status },
    }, true);
  }

  /**
   * Send each waiting increase/decrease whose feed post has arrived, with its $ figures.
   * One whose post doesn't come within notionalWaitMs is skipped: it can't be sized exactly.
   */
  private emitPendingChanges(
    copies: CopyEntry[],
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    const waitMs = this.o.notionalWaitMs ?? DEFAULT_NOTIONAL_WAIT_SEC * 1000;
    const keep: PendingChange[] = [];
    const ordered = [...this.pending].sort((a, b) => String(a.update?.updatedAt ?? '').localeCompare(String(b.update?.updatedAt ?? '')));
    for (const p of ordered) {
      const u = p.update;
      const copy = copies.find(c => c.id === p.entryId);
      const skip = (reason: string) => err({
        type: 'skipped', poll: this.pollCount, source: 'trade_poll', updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null,
        entryId: p.entryId, ownerId: copy?.source?.creatorInvoUserId ?? null, coin: copy?.coin ?? null, reason,
      });
      if (!copy) { skip(`${u?.updateType} of a copy that is no longer open — nothing to replicate`); continue; }
      const n = this.notionals.get(u?.investmentId);
      if (!n) {
        if (this.now - p.seenAt > waitMs) {
          this.notReplicated(copy, u, `${u?.updateType}: no feed post with its $ figures within ${Math.round(waitMs / 1000)}s — ` +
            `/dex/trade's positionSize alone can't size it exactly, not replicated`, out);
        } else {
          keep.push(p);
        }
        continue;
      }
      const src = copy.source!;
      const wantIncrease = String(u?.updateType).toLowerCase() === 'increase';
      if (n.ownerId !== src.creatorInvoUserId || (n.baseId && src.sourcePaperTradeBaseId && n.baseId !== src.sourcePaperTradeBaseId) ||
          n.simIncrease !== wantIncrease) {
        this.notReplicated(copy, u, `${u?.updateType}: the feed post for it (${n.postId}) is for another trader, trade or kind of change — not replicated`, out);
        continue;
      }
      this.emitChange(copy, u, p.updateId, out, err, n);
    }
    this.pending = keep;
  }

  /** A trader's change to a trade we copied, as an increase / decrease / tpsl signal (or a skip saying why not). */
  private emitChange(
    copy: CopyEntry,
    u: any,
    updateId: string,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
    notional?: ChangeNotional,
  ) {
    const type = typeof u?.updateType === 'string' ? u.updateType.toLowerCase() : '';
    const src = copy.source!;
    const skip = (reason: string) => err({
      type: 'skipped', poll: this.pollCount, source: 'trade_poll', updateType: u?.updateType ?? null, updatedAt: u?.updatedAt ?? null,
      entryId: copy.id, ownerId: src.creatorInvoUserId, coin: copy.coin, reason,
    });
    const at = typeof u?.updatedAt === 'string' ? Date.parse(u.updatedAt) : NaN;
    if (this.closedTradeFor(copyIds(copy))) { skip(`${type} of a trade that is already closed`); return; }

    let action: 'increase' | 'decrease' | 'tpsl';
    let change: Record<string, unknown>;
    if (type === 'increase' || type === 'decrease') {
      action = type;
      change = {
        positionSizeBefore: u.details?.positionSizeBefore ?? null,
        positionSizeAfter: u.details?.positionSizeAfter ?? null,
        positionSizeChange: u.details?.positionSizeChange ?? null,
        // What the size is computed from (see ChangeNotional)
        notional: notional
          ? {
              investmentId: notional.investmentId,
              postId: notional.postId,
              simIncrease: notional.simIncrease,
              entrySimBefore: notional.entrySimBefore,
              simDifference: notional.simDifference,
              entryPriceBefore: notional.entryPriceBefore,
              livePriceAtChange: notional.livePriceAtChange,
              entrySimAfter: notional.entrySimAfter,
              entryPriceAfter: notional.entryPriceAfter,
            }
          : null,
      };
    } else if (type === 'tp' || type === 'sl') {
      action = 'tpsl';
      const px = type === 'tp' ? u.details?.priceTarget : u.details?.stopLoss;
      const before = type === 'tp' ? u.details?.priceTargetBefore : u.details?.stopLossBefore;
      change = { which: type, triggerPx: px ?? null, ...(before !== undefined && { triggerPxBefore: before }) };
    } else {
      this.notReplicated(copy, u, `unknown /dex/trade updateType ${JSON.stringify(u?.updateType ?? null)} — not replicated, check it`, out);
      return;
    }

    if (!Number.isFinite(at) || typeof u?.investmentId !== 'string' || !u.investmentId) {
      this.notReplicated(copy, u, `${type} without a readable updatedAt / investmentId — can't be applied exactly once, not replicated`, out);
      return;
    }
    if (action !== 'tpsl' && at < Date.parse(copy.openedAt)) {
      skip(`${type} made before our copy opened (our size is set from our equity at open) — nothing to replicate`);
      return;
    }
    if (action === 'increase') {
      const maxAgeMs = this.o.maxSignalAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_SEC * 1000;
      if (this.now - at > maxAgeMs) {
        this.notReplicated(copy, u, `increase made ${Math.round((this.now - at) / 1000)}s ago — too old to copy at today's price, not replicated`, out);
        return;
      }
    }

    out({
      type: 'signal',
      source: 'trade_poll',
      poll: this.pollCount,
      action,
      copied: true,
      entryId: copy.id,
      updateId,
      investmentId: u.investmentId,
      updatedAt: u.updatedAt,
      owner: { id: src.creatorInvoUserId },
      trade: { coin: copy.coin, side: copy.side },
      change,
      mimicMeta: {
        portfolioId: src.portfolioId,
        creatorInvoUserId: src.creatorInvoUserId,
        sourcePaperTradeBaseId: src.sourcePaperTradeBaseId,
        sourcePaperTradeBaseShortId: src.sourcePaperTradeBaseShortId,
      },
    }, true);
  }

  /** Remember a trader's close (once per trade). */
  private rememberClose(c: Omit<ClosedTrade, 'seenAt' | 'attempts' | 'lastEmittedAt'>) {
    if (this.closed.some(r => sameTrade(r, c))) return;
    const rec: ClosedTrade = { ...c, seenAt: this.now, attempts: 0, lastEmittedAt: null };
    this.closed.push(rec);
    this.closedThisPoll.add(rec);
  }

  private closedTradeFor(ids: TradeIds) {
    return this.closed.find(r => sameTrade(r, ids));
  }

  /**
   * Send a close signal for every remembered closed trade we still hold an open
   * copy of — again every closeRetryMs while it stays open, up to maxCloseAttempts.
   * If the ledger can't be read, each close first seen this poll is sent once (close.ts checks it).
   */
  private emitCloses(
    copies: CopyEntry[],
    ledgerReadable: boolean,
    out: (d: Record<string, unknown>, signal?: boolean) => void,
  ) {
    const retryMs = this.o.closeRetryMs ?? DEFAULT_CLOSE_RETRY_SEC * 1000;
    const maxAttempts = this.o.maxCloseAttempts ?? DEFAULT_MAX_CLOSE_ATTEMPTS;
    const retentionMs = this.o.closedTradeRetentionMs ?? DEFAULT_CLOSED_TRADE_RETENTION_SEC * 1000;

    for (const rec of this.closed) {
      const copy = copies.find(c => sameTrade(rec, copyIds(c)));
      if (ledgerReadable ? !copy : rec.attempts > 0 || !this.closedThisPoll.has(rec)) continue;

      if (rec.attempts >= maxAttempts) {
        if (!rec.gaveUp) {
          rec.gaveUp = true;
          out({
            type: 'close_stuck',
            poll: this.pollCount,
            message: `${rec.attempts} close signals sent, but our ${copy!.coin} copy of trader ${rec.ownerId}'s trade is still open — needs the user`,
            entryId: copy!.id,
            owner: { id: rec.ownerId },
            trade: { coin: copy!.coin, side: copy!.side },
          }, true);
        }
        continue;
      }
      if (rec.lastEmittedAt !== null && this.now - rec.lastEmittedAt < retryMs) continue;

      rec.attempts++;
      rec.lastEmittedAt = this.now;
      const src = copy?.source;
      out({
        type: 'signal',
        source: rec.source,
        poll: this.pollCount,
        ...(rec.postId && { postId: rec.postId }),
        action: 'close',
        copied: !!copy,
        attempt: rec.attempts,
        ...(rec.attempts > 1 && { retry: true }),
        ...(rec.catchUp && rec.attempts === 1 && { catchUp: true }),
        owner: { id: rec.ownerId },
        trade: { coin: copy?.coin ?? rec.coin, ...(copy && { side: copy.side }), isOpen: false, closingPrice: rec.closingPrice ?? null },
        reasonClosed: rec.reasonClosed ?? null,
        // Identifies the copy for close.ts — from our ledger entry when we have one
        mimicMeta: src
          ? {
              portfolioId: src.portfolioId,
              creatorInvoUserId: src.creatorInvoUserId,
              sourcePaperTradeBaseId: src.sourcePaperTradeBaseId,
              sourcePaperTradeBaseShortId: src.sourcePaperTradeBaseShortId,
            }
          : { creatorInvoUserId: rec.ownerId, sourcePaperTradeBaseId: rec.baseId, sourcePaperTradeBaseShortId: rec.baseShortId },
      }, true);
    }

    // Forget closed trades after the retention period, unless a copy of one is still being retried
    this.closed = this.closed.filter(r =>
      this.now - r.seenAt <= retentionMs || (!r.gaveUp && copies.some(c => sameTrade(r, copyIds(c)))));
  }

  /** Feed posts newer than the last one seen, across pages. */
  private async fetchNewPosts(fresh: boolean, err: (d: Record<string, unknown>) => void): Promise<any[]> {
    const pageSize = this.o.pageSize ?? 20;
    const maxPages = this.o.maxPages ?? 5;
    const found = new Map<string, any>();
    let lastPostId: string | null = null;
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.o.invo.getFeed('following', lastPostId, pageSize);
      const posts: any[] = (data?.items ?? []).filter((p: any) => typeof p?.id === 'string');
      const unseen = posts.filter(p => !this.seenPosts.has(p.id) && !found.has(p.id));
      unseen.forEach(p => found.set(p.id, p));
      // Done once a page reaches posts we've seen, is short, or adds nothing (cursor ignored).
      // A fresh start only indexes the first page.
      if (fresh || unseen.length < posts.length || posts.length < pageSize || unseen.length === 0) break;
      if (page === maxPages) {
        err({ type: 'notice', message: `more than ${maxPages * pageSize} new feed posts since the last poll — older ones were not checked` });
        break;
      }
      lastPostId = posts[posts.length - 1].id;
    }
    return [...found.values()];
  }

  private async pollFeed(
    ctx: { first: boolean; fresh: boolean; gapMs: number; maxCatchUpMs: number; isCopied: Parameters<typeof classifyPost>[2]; ledgerReadable: boolean },
    out: (d: Record<string, unknown>, signal?: boolean) => void,
    err: (d: Record<string, unknown>) => void,
  ) {
    let posts: any[];
    try {
      posts = await this.fetchNewPosts(ctx.fresh, err);
    } catch (e: any) {
      err({ type: 'error', source: 'feed', message: e.message });
      return;
    }
    posts.forEach(p => this.seenPosts.add(p.id));
    this.indexChangeNotionals(posts);
    if (ctx.fresh) return; // first ever run: existing posts are not new signals

    const catchUp = ctx.first; // posts made while this monitor wasn't running
    const accepted: { post: any; verdict: Extract<ReturnType<typeof classifyPost>, { kind: 'accept' }> }[] = [];
    for (const post of posts) {
      let verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
      if (verdict.kind === 'ignore') continue;

      // Unknown owner or portfolio may mean the list is stale (just followed someone,
      // or they opened a new portfolio) — re-check against fresh data (rate-limited) before rejecting
      if (verdict.kind === 'reject' && verdict.ownerId) {
        if (verdict.reason === 'owner not in following list') {
          const events: WatchEvent[] = [];
          await this.refreshFollowing(events, true);
          events.forEach(e => (e.stream === 'out' ? out(e.data) : err(e.data)));
          verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
        } else if (verdict.reason === 'portfolio not owned by followed trader') {
          await this.o.registry.refreshPortfolios(verdict.ownerId).catch(() => {});
          verdict = classifyPost(post, this.o.registry.byUserId, ctx.isCopied);
        }
      }

      if (verdict.kind === 'reject') {
        err({ type: 'skipped', poll: this.pollCount, postId: post.id, reason: verdict.reason, ownerId: verdict.ownerId ?? null, portfolioId: verdict.portfolioId ?? null });
        continue;
      }
      if (verdict.kind === 'accept') accepted.push({ post, verdict });
    }

    // Remember every close first, so a close wins over an open/update of the same trade
    // seen this poll (whatever order the feed lists them in) or in any earlier one.
    // Close signals themselves are sent by emitCloses, once we hold a copy of the trade.
    for (const { post, verdict } of accepted) {
      if (verdict.action !== 'close') continue;
      const u = post.update;
      this.rememberClose({
        ownerId: u.owner.id,
        baseId: u.baseId || undefined,
        baseShortId: u.baseShortId || undefined,
        coin: u.ticker,
        closingPrice: u.closingPrice ?? null,
        reasonClosed: u.reasonClosed ?? (u.isLiquidated === true ? 'liquidated' : null),
        source: 'feed',
        postId: post.id,
        catchUp,
      });
    }
    const maxAgeMs = this.o.maxSignalAgeMs ?? DEFAULT_MAX_SIGNAL_AGE_SEC * 1000;

    for (const { post, verdict } of accepted) {
      const update = post.update;
      const ids: TradeIds = { ownerId: update.owner.id, baseId: update.baseId || undefined, baseShortId: update.baseShortId || undefined };
      const skip = (reason: string) =>
        err({ type: 'skipped', poll: this.pollCount, postId: post.id, reason, ownerId: update.owner?.id ?? null, portfolioId: update.portfolio?.id ?? null });

      if (verdict.action === 'close') {
        if (!verdict.copied && ctx.ledgerReadable) skip('close of a trade we hold no copy of — remembered in case one is opened');
        continue; // sent by emitCloses
      } else {
        if (this.closedTradeFor(ids)) { skip(`${verdict.action} of a trade that is already closed`); continue; }
        const at = postTime(post);
        if (at === null) { skip(`${verdict.action} post has no createdAt — can't tell how old it is, not copying`); continue; }
        if (this.now - at > maxAgeMs) {
          skip(`${verdict.action} posted ${Math.round((this.now - at) / 1000)}s ago — too old to copy`);
          continue;
        }
        if (catchUp && ctx.gapMs > ctx.maxCatchUpMs) {
          skip(`missed while the monitor was stopped (${Math.round(ctx.gapMs / 1000)}s) — too old to copy`);
          continue;
        }
      }

      out({
        type: 'signal',
        source: 'feed',
        poll: this.pollCount,
        postId: post.id,
        // When the post was made: trade.ts refuses an open whose post is too old
        postedAt: new Date(postTime(post)!).toISOString(),
        action: verdict.action,
        ...(verdict.copied && { copied: true }),
        ...(catchUp && { catchUp: true }),
        owner: {
          id: update.owner.id,
          username: update.owner?.username ?? post.owner?.username,
        },
        followed: verdict.trader && { userId: verdict.trader.userId, username: verdict.trader.username },
        trade: {
          coin: update.ticker,
          name: update.name,
          // Left out unless Invo says which, so trade.ts refuses rather than assume a direction
          ...(typeof update.directionLong === 'boolean' && { side: update.directionLong ? 'long' : 'short' }),
          leverage: update.leverage,
          entryPrice: update.entryPrice,
          closingPrice: update.closingPrice ?? null,
          entrySize: update.entrySize,
          isOpen: update.isOpen === true,
          // The trader's TP/SL (null = none set); trade.ts replicates them
          // (left out if Invo's post doesn't say, so trade.ts refuses rather than assume none)
          ...('priceTarget' in update && { priceTarget: update.priceTarget }),
          ...('stopLoss' in update && { stopLoss: update.stopLoss }),
          openedAt: update.createdAt ?? null,
        },
        portfolio: {
          id: update.portfolio?.id,
          title: update.portfolio?.title,
          winRate: update.portfolio?.winRate,
          closedPositions: update.portfolio?.closedPositionsCount,
          openPositions: update.portfolio?.openPositionsCount,
          pnl: update.portfolio?.plSnapshot,
        },
        // Invo's /dex/position/create shape — pass as-is to trade.ts / close.ts.
        // sourcePaperTradeBaseShortId is the trader's baseShortId (use it for /dex/trade watch entries)
        mimicMeta: mimicMetaFromUpdate(update),
      }, true);
    }
  }
}

export function followingSummary(traders: FollowedTrader[]) {
  return {
    count: traders.length,
    traders: traders.map(t => ({ userId: t.userId, username: t.username, portfolioIds: t.portfolios.map(p => p.id) })),
  };
}
