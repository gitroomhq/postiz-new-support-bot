import { createHash, randomBytes } from "node:crypto";
import type { IntercomAdmin, IntercomWebhookPart } from "../intercom/types";
import type { QueueCreatedRange, QueueRawPage } from "../intercom/IntercomClient";
import type { IntercomRegion, QueueExclusions } from "../config/SettingsStore";
import { log } from "../util/logger";
import {
  ClassifyOptions,
  QueueConversation,
  QueueItem,
  QueueTicketInfo,
  classify,
  clip,
  compareWaiting,
  extraReplyAfter,
  intercomAppHost,
  mergeReplyTimes,
  parseConversation,
  parseTicket,
  partsOf,
  resolveTicket,
  ticketUpdatedAt,
  weightedPick,
  withParts,
} from "./queueModel";

const queueLog = log.child("queue");

// What the queue reads from Intercom. IntercomClient satisfies it; tests hand
// in a fake.
export interface QueueSource {
  searchOpenConversationsRaw(startingAfter?: string | null, created?: QueueCreatedRange): Promise<QueueRawPage>;
  searchOpenCustomerTicketsRaw(startingAfter?: string | null, created?: QueueCreatedRange): Promise<QueueRawPage>;
  searchConversationsUpdatedRaw(sinceSec: number, startingAfter?: string | null): Promise<QueueRawPage>;
  searchCustomerTicketsUpdatedRaw(sinceSec: number, startingAfter?: string | null): Promise<QueueRawPage>;
  getConversationRaw(conversationId: string): Promise<unknown | null>;
  getTicketRaw(ticketId: string): Promise<unknown | null>;
  getConversationTranscript(conversationId: string): Promise<Array<{ author: string; at: Date | null; text: string }>>;
  listAdmins(): Promise<IntercomAdmin[]>;
  listTeams(): Promise<Array<{ id: string; name: string }>>;
  getMe(): Promise<{ appIdCode?: string | null }>;
}

// The settings the queue reads (SettingsStore satisfies it).
export interface QueueSettingsView {
  queueEnabled(): boolean;
  queueFinCountsAsReply(): boolean;
  queueNotesCountAsReply(): boolean;
  queueExclusions(): QueueExclusions;
  intercomOperatorAdminId(): string | null;
  intercomAdminId(): string | null;
  intercomRegion(): IntercomRegion;
  intercomConfigured(): boolean;
}

// The list a restart starts from. QueueCacheStore keeps it in queue_cache.
export interface QueueSaved {
  savedAt: number; // ms
  truncated: boolean;
  conversations: QueueConversation[];
  tickets: Array<{ ticket: QueueTicketInfo; updatedAt: number }>;
}

export interface QueueCache {
  load(): Promise<QueueSaved | null>;
  save(state: QueueSaved): Promise<void>;
}

export interface QueueSnapshot {
  builtAt: number; // ms: the last read of the whole list (scan or catch-up)
  items: QueueItem[]; // longest waiting first
  scanned: number; // open conversations known
  truncated: boolean; // the page cap stopped the last full scan early
  // Toggle checks (Fin / notes count as replied) that needed the parts but
  // were skipped by the per-refresh budget: those items were decided from the
  // statistics alone.
  partsSkipped: number;
  error: string | null; // the last read failed; items are the previous ones
  // The list came from the database after a restart and the first read from
  // Intercom has not finished yet.
  restored: boolean;
}

export interface QueueTeammate {
  id: string;
  name: string;
  seated: boolean;
  away: boolean;
  bot: boolean; // Operator/Fin or the bridge's own admin
}

export interface QueueDirectory {
  teammates: Map<string, QueueTeammate>;
  teams: Map<string, string>;
}

type DirtyKind = "conversation" | "ticket";

// A conversation that waits on us by the statistics, before the toggles.
type Candidate = { item: QueueItem; lastContactStat: number; finHandedOff: boolean };

const SYNC_TTL_MS = 60_000; // catch-up read while someone is looking
const FULL_TTL_MS = 15 * 60_000; // whole-list read, the backstop for anything a catch-up misses
const REFRESH_RETRY_MS = 5_000;
const FAILURE_RETRY_MS = 15_000;
const CATCH_UP_OVERLAP_SEC = 120; // Intercom's search index lags its writes
const MAX_PAGES = 40; // per full scan and object type: 6,000; the rest is reported as truncated
const MAX_CATCH_UP_PAGES = 5; // more changed than this: a full scan instead
const SLICE_DAYS = [1, 7, 30, 90]; // created_at cuts: five slices read at once
const PARTS_BUDGET = 200; // toggle checks per derive
const PARTS_CONCURRENCY = 8;
const WEBHOOK_DEBOUNCE_MS = 750;
const WEBHOOK_CONCURRENCY = 4;
const MAX_DIRTY = 500;
// Intercom settles a conversation's statistics, ticket and search copy behind
// the write a webhook reports: every webhook read is read once more after this.
const SETTLE_MS = 20_000;
// Each save rewrites the whole list (a few hundred KB): at most every two
// minutes, plus once at shutdown.
const SAVE_DEBOUNCE_MS = 2 * 60_000;
const RESTORE_MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_WAITERS = 1_000;
const ADMINS_TTL_MS = 60_000;
const TEAMS_TTL_MS = 5 * 60_000;
const WORKSPACE_TTL_MS = 60 * 60_000;
const MESSAGE_TTL_MS = 5 * 60_000;
export const RESERVATION_MS = 10 * 60_000;
const FIN_NAME_RE = /^(operator|fin)(\s|$)/i;

export class QueueData {
  // What Intercom says, independent of the queue's settings: the open
  // conversations and Customer tickets. Every page is derived from these, so
  // a change of exclusions or reply rules needs no new read. A conversation
  // that closes stays as a closed entry until the next full scan, so an older
  // search page cannot bring it back.
  private convs = new Map<string, QueueConversation>();
  private tickets = new Map<string, { ticket: QueueTicketInfo; updatedAt: number }>();
  private loaded = false; // a full scan finished, or the saved list was restored
  private restored = false;
  private truncated = false;
  private lastSyncAt = 0; // ms, when the last successful read started
  private lastFullAt = 0;
  private lastSyncAttemptAt = -Infinity;
  private syncError: string | null = null;
  private syncing: Promise<void> | null = null;

  private snap: QueueSnapshot | null = null;
  private snapKey = "";
  private snapSig = "";
  private deriving: Promise<void> | null = null;
  private deriveAgain = false;

  // Webhook items waiting to be read again.
  private dirty = new Map<string, DirtyKind>();
  // Of those, the ones queued only by their settle read (no second settle).
  private settleReads = new Set<string>();
  private settles = new Map<string, { kind: DirtyKind; timer: NodeJS.Timeout }>();
  private webhookTimer: NodeJS.Timeout | null = null;
  private patching: Promise<void> | null = null;

  private cache: QueueCache | null = null;
  private restoreTried = false;
  private unsaved = false;
  private saveTimer: NodeJS.Timeout | null = null;

  // Long-poll: the version pages compare, and the requests waiting on it.
  private readonly bootId = randomBytes(4).toString("hex");
  private changes = 0;
  private waiters = new Set<() => void>();

  private partsCache = new Map<string, { updatedAt: number; parts: IntercomWebhookPart[] }>();
  private messageCache = new Map<string, { updatedAt: number; at: number; text: string | null }>();
  private admins: { at: number; list: IntercomAdmin[] } | null = null;
  private teams: { at: number; list: Array<{ id: string; name: string }> } | null = null;
  private workspace: { at: number; idCode: string | null } | null = null;
  // Randomizer: each teammate's current pick per scope, and the reservation it
  // holds. In memory on purpose: a restart only frees reservations early.
  // A null conversationId is a released pick: the page shows "no pick" rather
  // than rolling a new one by itself.
  private picks = new Map<string, { conversationId: string | null; reservedUntil: number }>();

  constructor(
    private source: QueueSource,
    private settings: QueueSettingsView,
    private now: () => number = Date.now,
    private rng: () => number = Math.random
  ) {}

  setCache(cache: QueueCache): void {
    this.cache = cache;
  }

  // Boot: restore the saved list and start the first scan, so the page is
  // ready before anyone opens it.
  start(): void {
    if (!this.settings.queueEnabled() || !this.settings.intercomConfigured()) return;
    this.ensureFresh();
  }

  // ---- reads ----

  // Never waits on Intercom: the current list, or null while there is none
  // for these settings yet (the first scan, or the moment after the
  // exclusions or reply rules changed). Starts whatever read is due.
  readySnapshot(): QueueSnapshot | null {
    this.ensureFresh();
    if (this.snap && this.snapKey === this.settingsKey()) return this.snap;
    if (this.loaded) void this.derive();
    return null;
  }

  // Waits for a list when there is none yet (the randomizer's roll).
  async snapshot(): Promise<QueueSnapshot> {
    this.ensureFresh();
    if (!this.loaded && this.syncing) await this.syncing;
    if (!this.snap || this.snapKey !== this.settingsKey()) await this.derive();
    return this.snap ?? { builtAt: this.now(), items: [], scanned: 0, truncated: false, partsSkipped: 0, error: "Intercom did not answer.", restored: false };
  }

  // The Refresh button: a catch-up read now rather than within the minute.
  requestRefresh(): void {
    if (this.syncing || this.now() - this.lastSyncAttemptAt < REFRESH_RETRY_MS) return;
    this.startSync(!this.loaded || this.now() - this.lastFullAt >= FULL_TTL_MS);
  }

  // Changes whenever what a page shows may have changed: the list, its
  // errors, a randomizer pick. A restart starts a new series.
  version(): string {
    return `${this.bootId}.${this.changes}`;
  }

  // Long-poll: true as soon as the version moves past `since`, false after
  // timeoutMs without a change.
  waitForChange(since: string, timeoutMs: number): Promise<boolean> {
    this.readySnapshot();
    if (since !== this.version()) return Promise.resolve(true);
    if (this.waiters.size >= MAX_WAITERS) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }

  // Resolves once no read, webhook re-read or derive is running (tests).
  async idle(): Promise<void> {
    for (;;) {
      const busy = this.syncing ?? this.patching ?? this.deriving;
      if (!busy) return;
      await busy;
    }
  }

  private bump(): void {
    this.changes++;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  private settingsKey(): string {
    const x = this.settings.queueExclusions();
    return JSON.stringify([
      this.settings.queueFinCountsAsReply(),
      this.settings.queueNotesCountAsReply(),
      x.teams.map((t) => t.id),
      x.tags.map((t) => t.id),
      x.ticketTypes.map((t) => t.id),
      this.settings.intercomOperatorAdminId(),
      this.settings.intercomAdminId(),
    ]);
  }

  // ---- reading Intercom ----

  // While someone looks: a catch-up read a minute, a full scan every fifteen.
  // Webhooks keep the list current in between.
  private ensureFresh(): void {
    if (this.cache && !this.restoreTried) {
      this.restoreTried = true;
      void this.restore();
    }
    if (this.syncing) return;
    const now = this.now();
    if (now - this.lastSyncAttemptAt < (this.syncError ? FAILURE_RETRY_MS : REFRESH_RETRY_MS)) return;
    const full = !this.loaded || now - this.lastFullAt >= FULL_TTL_MS;
    if (!full && now - this.lastSyncAt < SYNC_TTL_MS) return;
    this.startSync(full);
  }

  private startSync(full: boolean): void {
    this.lastSyncAttemptAt = this.now();
    this.syncing = this.sync(full).finally(() => {
      this.syncing = null;
    });
  }

  private async sync(full: boolean): Promise<void> {
    const startedAt = this.now();
    this.pruneClosed(startedAt);
    try {
      if (full || !(await this.catchUp())) await this.fullScan(startedAt);
      this.lastSyncAt = startedAt;
      this.syncError = null;
      this.restored = false;
      this.scheduleSave();
    } catch (e) {
      queueLog.warn("queue refresh failed", { "queue.full": full, "error.message": e instanceof Error ? e.message : String(e) });
      // The raw message stays in the logs; the page only learns that it failed.
      this.syncError = this.loaded ? "Intercom did not answer the last refresh." : "Intercom did not answer.";
    }
    await this.derive();
  }

  // The whole open list. Conversations and Customer tickets are each read in
  // created_at slices at once (five short cursor walks instead of one long
  // one), then merged so a webhook read that landed meanwhile is kept.
  private async fullScan(startedAt: number): Promise<void> {
    const nowSec = Math.floor(startedAt / 1000);
    const [convs, tickets] = await Promise.all([
      this.scanSlices(nowSec, (after, range) => this.source.searchOpenConversationsRaw(after, range)),
      this.scanSlices(nowSec, (after, range) => this.source.searchOpenCustomerTicketsRaw(after, range)),
    ]);
    const seen = new Set<string>();
    for (const raw of convs.items) {
      const c = parseConversation(raw);
      if (!c) continue;
      seen.add(c.id);
      this.putConversation(c);
    }
    // Missing from the open list and not touched since the scan started: closed.
    for (const [id, c] of this.convs) {
      if (!seen.has(id) && c.updatedAt < nowSec) {
        this.convs.delete(id);
        this.unsaved = true;
      }
    }
    const seenTickets = new Set<string>();
    for (const raw of tickets.items) {
      const t = parseTicket(raw);
      if (!t) continue;
      seenTickets.add(t.id);
      this.putTicket(t, ticketUpdatedAt(raw));
    }
    for (const [id, t] of this.tickets) {
      if (!seenTickets.has(id) && t.updatedAt < nowSec) {
        this.tickets.delete(id);
        this.unsaved = true;
      }
    }
    this.truncated = convs.truncated || tickets.truncated;
    this.lastFullAt = startedAt;
    this.loaded = true;
  }

  // Everything touched since the last read, closed conversations included.
  // false = too much changed: read the whole list instead.
  private async catchUp(): Promise<boolean> {
    const since = Math.floor(this.lastSyncAt / 1000) - CATCH_UP_OVERLAP_SEC;
    const [convs, tickets] = await Promise.all([
      this.walk((after) => this.source.searchConversationsUpdatedRaw(since, after), { pages: MAX_CATCH_UP_PAGES }),
      this.walk((after) => this.source.searchCustomerTicketsUpdatedRaw(since, after), { pages: MAX_CATCH_UP_PAGES }),
    ]);
    if (convs.truncated || tickets.truncated) return false;
    for (const raw of convs.items) {
      const c = parseConversation(raw);
      if (c) this.putConversation(c);
    }
    for (const raw of tickets.items) {
      const t = parseTicket(raw);
      if (t) this.putTicket(t, ticketUpdatedAt(raw));
    }
    return true;
  }

  private async scanSlices(
    nowSec: number,
    fetchPage: (after: string | null, range: QueueCreatedRange) => Promise<QueueRawPage>
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const cuts = SLICE_DAYS.map((d) => nowSec - d * 86_400);
    const ranges: QueueCreatedRange[] = [{ after: cuts[0] }];
    for (let i = 1; i < cuts.length; i++) ranges.push({ after: cuts[i], before: cuts[i - 1] });
    ranges.push({ before: cuts[cuts.length - 1] });
    const budget = { pages: MAX_PAGES };
    const walks = await Promise.all(ranges.map((range) => this.walk((after) => fetchPage(after, range), budget)));
    const truncated = walks.some((w) => w.truncated);
    if (truncated) queueLog.warn("queue scan truncated", { "queue.pages": MAX_PAGES });
    return { items: walks.flatMap((w) => w.items), truncated };
  }

  // One cursor walk, sharing a page budget with its sibling slices.
  private async walk(
    fetchPage: (after: string | null) => Promise<QueueRawPage>,
    budget: { pages: number }
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    let after: string | null = null;
    for (;;) {
      if (budget.pages <= 0) return { items, truncated: true };
      budget.pages--;
      const res = await fetchPage(after);
      items.push(...res.items);
      if (!res.nextStartingAfter) return { items, truncated: false };
      after = res.nextStartingAfter;
    }
  }

  // Newer wins: a search page can be older than a webhook read that landed
  // while it was in flight. Reply times only move forward, whichever read
  // carries them (see mergeReplyTimes). A closed conversation the list never
  // had is not worth keeping.
  private putConversation(c: QueueConversation): boolean {
    const cur = this.convs.get(c.id);
    if (!cur && c.state === "closed") return false;
    const next = !cur ? c : cur.updatedAt > c.updatedAt ? mergeReplyTimes(c, cur) : mergeReplyTimes(cur, c);
    if (cur && JSON.stringify(cur) === JSON.stringify(next)) return false;
    this.convs.set(c.id, next);
    this.unsaved = true;
    return true;
  }

  // Closed entries guard against search pages older than the close. Past
  // the search index's lag no read can bring one back.
  private pruneClosed(nowMs: number): void {
    const cutoff = Math.floor(nowMs / 1000) - CATCH_UP_OVERLAP_SEC;
    for (const [id, c] of this.convs) if (c.state === "closed" && c.updatedAt < cutoff) this.convs.delete(id);
  }

  private putTicket(ticket: QueueTicketInfo, updatedAt: number): boolean {
    const cur = this.tickets.get(ticket.id);
    if (cur && cur.updatedAt > updatedAt) return false;
    if (cur && JSON.stringify(cur.ticket) === JSON.stringify(ticket)) {
      cur.updatedAt = Math.max(cur.updatedAt, updatedAt);
      return false;
    }
    this.tickets.set(ticket.id, { ticket, updatedAt });
    this.unsaved = true;
    return true;
  }

  // ---- webhooks ----

  // A verified Intercom webhook named a conversation or ticket: read that one
  // item again shortly. A burst of events for one ticket becomes one read.
  noteWebhook(topic: string, itemId: string): void {
    if (!this.settings.queueEnabled() || !/^\d{1,20}$/.test(itemId)) return;
    this.queueRead(itemId, topic.startsWith("ticket.") ? "ticket" : "conversation", false);
    // Nobody opened the page since boot (the queue was switched on later):
    // start the first scan, so the list is ready when they do.
    if (!this.loaded) this.ensureFresh();
  }

  private queueRead(itemId: string, kind: DirtyKind, settle: boolean): void {
    // Past the cap the next catch-up read covers the rest.
    if (!this.dirty.has(itemId) && this.dirty.size >= MAX_DIRTY) return;
    if (!settle) this.settleReads.delete(itemId);
    else if (!this.dirty.has(itemId)) this.settleReads.add(itemId);
    if (this.dirty.get(itemId) !== "ticket") this.dirty.set(itemId, kind);
    if (!this.webhookTimer && !this.patching) {
      this.webhookTimer = setTimeout(() => void this.flushWebhooks(), WEBHOOK_DEBOUNCE_MS);
      this.webhookTimer.unref?.();
    }
  }

  // One more read SETTLE_MS after the last webhook read of an item; a newer
  // webhook pushes it back.
  private scheduleSettle(itemId: string, kind: DirtyKind): void {
    const prev = this.settles.get(itemId);
    if (prev) clearTimeout(prev.timer);
    else if (this.settles.size >= MAX_DIRTY) return;
    const settleKind: DirtyKind = prev?.kind === "ticket" ? "ticket" : kind;
    const timer = setTimeout(() => {
      this.settles.delete(itemId);
      this.queueRead(itemId, settleKind, true);
    }, SETTLE_MS);
    timer.unref?.();
    this.settles.set(itemId, { kind: settleKind, timer });
  }

  // Runs every pending settle read now (tests).
  flushSettles(): Promise<void> {
    for (const [itemId, s] of this.settles) {
      clearTimeout(s.timer);
      this.queueRead(itemId, s.kind, true);
    }
    this.settles.clear();
    return this.flushWebhooks();
  }

  // Reads every item the webhooks named (the debounce timer, and tests).
  flushWebhooks(): Promise<void> {
    if (this.webhookTimer) {
      clearTimeout(this.webhookTimer);
      this.webhookTimer = null;
    }
    if (!this.patching) {
      this.patching = this.drainWebhooks().finally(() => {
        this.patching = null;
      });
    }
    return this.patching;
  }

  private async drainWebhooks(): Promise<void> {
    while (this.dirty.size) {
      const batch = [...this.dirty.entries()].map(([id, kind]) => ({ id, kind, settle: this.settleReads.delete(id) }));
      this.dirty.clear();
      let changed = false;
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const { id, kind, settle } = batch[cursor++];
          if (await this.patchOne(id, kind)) changed = true;
          if (!settle) this.scheduleSettle(id, kind);
        }
      };
      await Promise.all(Array.from({ length: WEBHOOK_CONCURRENCY }, () => worker()));
      if (changed) {
        this.scheduleSave();
        if (this.loaded) await this.derive();
      }
    }
    if (!this.syncing) this.pruneClosed(this.now());
  }

  // One item, read fresh. A ticket event re-reads the ticket (its state) and
  // its conversation; a conversation event re-reads the conversation, and its
  // ticket only when the conversation's own copy of the state disagrees with
  // the stored one. A failed read is left to the next catch-up.
  private async patchOne(id: string, kind: DirtyKind): Promise<boolean> {
    try {
      let changed = false;
      let ticketId: string | null = kind === "ticket" ? id : null;
      const raw = await this.source.getConversationRaw(id);
      if (raw == null) {
        // Deleted. A ticket's id need not name a conversation.
        if (kind === "conversation" && this.convs.delete(id)) {
          this.unsaved = true;
          changed = true;
        }
      } else {
        const parsed = parseConversation(raw);
        const parts = partsOf(raw);
        const conv = parsed && withParts(parsed, parts);
        if (conv) {
          if (this.putConversation(conv)) changed = true;
          if (this.settings.queueFinCountsAsReply() || this.settings.queueNotesCountAsReply()) {
            this.partsCache.set(conv.id, { updatedAt: conv.updatedAt, parts });
          }
          if (conv.ticketId) {
            const stored = this.tickets.get(conv.ticketId);
            if (kind === "ticket" || (conv.ticketInline && stored?.ticket.stateCategory !== conv.ticketInline.stateCategory)) {
              ticketId = conv.ticketId;
            }
          }
        }
      }
      if (ticketId) {
        const rawTicket = await this.source.getTicketRaw(ticketId);
        const t = rawTicket == null ? null : parseTicket(rawTicket);
        if (t && this.putTicket(t, ticketUpdatedAt(rawTicket))) changed = true;
      }
      return changed;
    } catch (e) {
      queueLog.debug("queue webhook read failed", { "intercom.item_id": id, "error.message": e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  // ---- the saved list ----

  private async restore(): Promise<void> {
    try {
      const saved = await this.cache!.load();
      if (!saved || this.loaded || this.now() - saved.savedAt > RESTORE_MAX_AGE_MS) return;
      for (const c of saved.conversations) this.putConversation(c);
      for (const t of saved.tickets) this.putTicket(t.ticket, t.updatedAt);
      this.truncated = saved.truncated;
      this.lastSyncAt = saved.savedAt;
      this.loaded = true;
      this.restored = true;
      queueLog.info("queue list restored", { "queue.conversations": saved.conversations.length });
      await this.derive();
    } catch (e) {
      queueLog.warn("queue cache restore failed", { "error.message": e instanceof Error ? e.message : String(e) });
    }
  }

  private scheduleSave(): void {
    if (!this.cache || !this.unsaved || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  // Writes the open list behind (the debounce timer, and tests). Nothing new
  // while the restored list is still showing.
  async saveNow(): Promise<void> {
    if (!this.cache || !this.loaded || this.restored || !this.unsaved || !this.settings.queueEnabled()) return;
    this.unsaved = false;
    try {
      await this.cache.save({
        savedAt: this.now(),
        truncated: this.truncated,
        conversations: [...this.convs.values()].filter((c) => c.state !== "closed"),
        tickets: [...this.tickets.values()],
      });
    } catch (e) {
      this.unsaved = true;
      queueLog.warn("queue cache save failed", { "error.message": e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- the derived list ----

  // One derive at a time; a request during one runs it again afterwards.
  private derive(): Promise<void> {
    if (this.deriving) {
      this.deriveAgain = true;
      return this.deriving;
    }
    this.deriving = (async () => {
      do {
        this.deriveAgain = false;
        try {
          await this.deriveOnce();
        } catch (e) {
          queueLog.warn("queue derive failed", { "error.message": e instanceof Error ? e.message : String(e) });
        }
      } while (this.deriveAgain);
    })().finally(() => {
      this.deriving = null;
    });
    return this.deriving;
  }

  private async deriveOnce(): Promise<void> {
    const key = this.settingsKey();
    if (!this.loaded) {
      if (this.syncError) {
        this.publish(key, { builtAt: this.now(), items: [], scanned: 0, truncated: false, partsSkipped: 0, error: this.syncError, restored: false });
      }
      return;
    }
    const directory = await this.directory().catch(() => null);
    const tickets = new Map<string, QueueTicketInfo>();
    for (const [id, t] of this.tickets) tickets.set(id, t.ticket);
    const opts = this.classifyOptions(directory);
    const candidates: Candidate[] = [];
    let scanned = 0;
    for (const conv of this.convs.values()) {
      if (conv.state === "closed") continue;
      scanned++;
      const item = classify(conv, resolveTicket(conv, tickets), opts);
      if (item) candidates.push({ item, lastContactStat: conv.lastContactReplyAt ?? item.lastContactAt, finHandedOff: conv.finHandedOff });
    }

    const fin = this.settings.queueFinCountsAsReply();
    const notes = this.settings.queueNotesCountAsReply();
    let partsSkipped = 0;
    let items = candidates.map((c) => c.item);
    if (fin || notes) {
      const checked = await this.applyToggles(candidates, { fin, notes, directory });
      items = checked.items;
      partsSkipped = checked.skipped;
    }
    // Bounded caches. The parts stay for every candidate, the ones a toggle
    // took out included: they are checked again on every derive, and
    // re-reading them each time multiplied the Intercom calls.
    const live = new Set(candidates.map((c) => c.item.id));
    for (const id of this.partsCache.keys()) if (!live.has(id)) this.partsCache.delete(id);
    const open = new Set(items.map((i) => i.id));
    for (const id of this.messageCache.keys()) if (!open.has(id)) this.messageCache.delete(id);

    items.sort(compareWaiting);
    this.publish(key, {
      builtAt: this.lastSyncAt,
      items,
      scanned,
      truncated: this.truncated,
      partsSkipped,
      error: this.syncError,
      restored: this.restored,
    });
  }

  // A new list wakes the long-polls only when something in it changed.
  private publish(key: string, snap: QueueSnapshot): void {
    const sig = createHash("sha1").update(JSON.stringify([key, snap])).digest("hex");
    this.snap = snap;
    this.snapKey = key;
    if (sig === this.snapSig) return;
    this.snapSig = sig;
    this.bump();
  }

  private classifyOptions(directory: QueueDirectory | null): ClassifyOptions {
    const x = this.settings.queueExclusions();
    return {
      excludedTeamIds: new Set(x.teams.map((t) => t.id)),
      excludedTagIds: new Set(x.tags.map((t) => t.id)),
      excludedTicketTypeIds: new Set(x.ticketTypes.map((t) => t.id)),
      excludedTicketTypeNames: new Set(x.ticketTypes.map((t) => t.name.toLowerCase())),
      botAdminIds: this.botAdminIds(directory),
    };
  }

  // Operator/Fin (the configured id, or any admin named like it) and the
  // bridge's own posting admin.
  private botAdminIds(directory: QueueDirectory | null): Set<string> {
    const ids = new Set<string>();
    const op = this.settings.intercomOperatorAdminId();
    const bridge = this.settings.intercomAdminId();
    if (op) ids.add(op);
    if (bridge) ids.add(bridge);
    for (const t of directory?.teammates.values() ?? []) if (t.bot) ids.add(t.id);
    return ids;
  }

  private finAdminIds(directory: QueueDirectory | null): Set<string> {
    const ids = new Set<string>();
    const op = this.settings.intercomOperatorAdminId();
    if (op) ids.add(op);
    for (const t of directory?.teammates.values() ?? []) if (FIN_NAME_RE.test(t.name)) ids.add(t.id);
    return ids;
  }

  private async applyToggles(
    candidates: Candidate[],
    opts: { fin: boolean; notes: boolean; directory: QueueDirectory | null }
  ): Promise<{ items: QueueItem[]; skipped: number }> {
    const finAdminIds = this.finAdminIds(opts.directory);
    const botAdminIds = this.botAdminIds(opts.directory);
    // Oldest first, so the budget is spent where a wrong answer costs most.
    const ordered = [...candidates].sort((a, b) => compareWaiting(a.item, b.item));
    const keep = new Map<string, boolean>();
    let fetches = 0;
    let skipped = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ordered.length) {
        const c = ordered[cursor++];
        const cached = this.partsCache.get(c.item.id);
        // A webhook read can be newer than the item: still the right answer.
        let parts: IntercomWebhookPart[] | null = cached && cached.updatedAt >= c.item.updatedAt ? cached.parts : null;
        if (!parts) {
          if (fetches >= PARTS_BUDGET) {
            skipped++;
            keep.set(c.item.id, true);
            continue;
          }
          fetches++;
          const raw = await this.source.getConversationRaw(c.item.id).catch(() => undefined);
          if (raw === undefined) {
            // A failed fetch keeps the statistics' answer.
            keep.set(c.item.id, true);
            continue;
          }
          if (raw === null) {
            keep.set(c.item.id, false); // deleted meanwhile
            continue;
          }
          parts = partsOf(raw);
          this.partsCache.set(c.item.id, { updatedAt: c.item.updatedAt, parts });
        }
        keep.set(
          c.item.id,
          !extraReplyAfter(parts, c.lastContactStat, { fin: opts.fin, notes: opts.notes, finAdminIds, botAdminIds, finHandedOff: c.finHandedOff })
        );
      }
    };
    await Promise.all(Array.from({ length: PARTS_CONCURRENCY }, () => worker()));
    return { items: candidates.map((c) => c.item).filter((i) => keep.get(i.id) !== false), skipped };
  }

  // ---- directory (teammates and teams) ----

  async directory(): Promise<QueueDirectory> {
    const now = this.now();
    if (!this.admins || now - this.admins.at >= ADMINS_TTL_MS) {
      try {
        this.admins = { at: now, list: await this.source.listAdmins() };
      } catch (e) {
        if (!this.admins) throw e;
      }
    }
    if (!this.teams || now - this.teams.at >= TEAMS_TTL_MS) {
      try {
        this.teams = { at: now, list: await this.source.listTeams() };
      } catch {
        // Team names only label the inboxes; ids still work without them.
        if (!this.teams) this.teams = { at: 0, list: [] };
      }
    }
    const op = this.settings.intercomOperatorAdminId();
    const bridge = this.settings.intercomAdminId();
    const teammates = new Map<string, QueueTeammate>();
    for (const a of this.admins.list) {
      const name = a.name?.trim() || a.email?.trim() || `Teammate ${a.id}`;
      teammates.set(a.id, {
        id: a.id,
        name,
        seated: a.hasInboxSeat !== false,
        away: a.awayModeEnabled === true,
        bot: a.id === op || a.id === bridge || FIN_NAME_RE.test(name),
      });
    }
    return { teammates, teams: new Map(this.teams.list.map((t) => [t.id, t.name])) };
  }

  // The teammate an Intercom sign-in resolved to, freshly checked: present in
  // the workspace, holding an inbox seat, and a person. null = refused.
  async seatedTeammate(adminId: string): Promise<QueueTeammate | null> {
    const dir = await this.directory();
    const t = dir.teammates.get(adminId);
    return t && t.seated && !t.bot ? t : null;
  }

  // The bot's workspace id ("d7n4qsa4"). The sign-in check compares the
  // teammate's workspace with it; inbox links carry it.
  async workspaceIdCode(): Promise<string | null> {
    const now = this.now();
    if (this.workspace && now - this.workspace.at < WORKSPACE_TTL_MS && this.workspace.idCode) return this.workspace.idCode;
    try {
      const me = await this.source.getMe();
      this.workspace = { at: now, idCode: me.appIdCode ?? null };
    } catch (e) {
      if (!this.workspace) throw e;
    }
    return this.workspace.idCode;
  }

  // The teammate-facing Intercom link for one conversation.
  inboxUrl(conversationId: string, workspaceIdCode: string | null): string {
    const host = intercomAppHost(this.settings.intercomRegion());
    const ws = workspaceIdCode && /^[a-z0-9]{4,20}$/i.test(workspaceIdCode) ? workspaceIdCode : "_";
    return `${host}/a/inbox/${ws}/inbox/conversation/${encodeURIComponent(conversationId)}`;
  }

  // The customer's newest message, plain text (the big cards). Cached per
  // conversation version; null when there is none or Intercom did not answer.
  async latestCustomerMessage(item: QueueItem): Promise<string | null> {
    const cached = this.messageCache.get(item.id);
    const now = this.now();
    if (cached && cached.updatedAt === item.updatedAt && now - cached.at < MESSAGE_TTL_MS) return cached.text;
    try {
      const transcript = await this.source.getConversationTranscript(item.id);
      let text: string | null = null;
      for (let i = transcript.length - 1; i >= 0; i--) {
        if (transcript[i].author === "customer" && transcript[i].text.trim()) {
          text = clip(transcript[i].text.replace(/\s+\n/g, "\n").trim(), 1500);
          break;
        }
      }
      this.messageCache.set(item.id, { updatedAt: item.updatedAt, at: now, text });
      return text;
    } catch {
      return cached?.text ?? null;
    }
  }

  // ---- randomizer ----

  // Who holds a live reservation on a conversation (null = nobody).
  reservedBy(conversationId: string): { adminId: string; until: number } | null {
    const now = this.now();
    for (const [key, pick] of this.picks) {
      if (pick.conversationId === conversationId && pick.reservedUntil > now) {
        return { adminId: key.slice(0, key.indexOf("|")), until: pick.reservedUntil };
      }
    }
    return null;
  }

  // null = this teammate never rolled in this scope (the page rolls once by
  // itself); a null conversationId = they released their pick.
  currentPick(adminId: string, scope: string): { conversationId: string | null; reservedUntil: number } | null {
    return this.picks.get(`${adminId}|${scope}`) ?? null;
  }

  // Draws a new pick for this teammate and scope from the pool, skipping the
  // previous pick and anything another teammate holds. Weighted by wait.
  roll(adminId: string, scope: string, pool: readonly QueueItem[]): QueueItem | null {
    const key = `${adminId}|${scope}`;
    const previous = this.picks.get(key)?.conversationId ?? null;
    this.picks.delete(key);
    const now = this.now();
    const free = pool.filter((i) => {
      const holder = this.reservedBy(i.id);
      return !holder || holder.adminId === adminId;
    });
    // Re-rolling never hands back the same ticket while there is another.
    const fresh = free.length > 1 ? free.filter((i) => i.id !== previous) : free;
    const pick = weightedPick(fresh, Math.floor(now / 1000), this.rng);
    if (pick) this.picks.set(key, { conversationId: pick.id, reservedUntil: now + RESERVATION_MS });
    this.prunePicks();
    // Other pages show who holds what.
    this.bump();
    return pick;
  }

  release(adminId: string, scope: string): boolean {
    const key = `${adminId}|${scope}`;
    const had = this.picks.get(key)?.conversationId != null;
    this.picks.set(key, { conversationId: null, reservedUntil: 0 });
    if (had) this.bump();
    return had;
  }

  private prunePicks(): void {
    // Expired picks only matter as "what am I looking at"; keep the map bounded.
    if (this.picks.size <= 500) return;
    const now = this.now();
    for (const [key, pick] of this.picks) if (pick.reservedUntil < now - RESERVATION_MS) this.picks.delete(key);
    while (this.picks.size > 500) {
      const oldest = this.picks.keys().next().value;
      if (oldest === undefined) break;
      this.picks.delete(oldest);
    }
  }
}
