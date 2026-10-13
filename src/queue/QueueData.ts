import type { IntercomAdmin, IntercomWebhookPart } from "../intercom/types";
import type { IntercomRegion, QueueExclusions } from "../config/SettingsStore";
import { log } from "../util/logger";
import {
  ClassifyOptions,
  QueueItem,
  QueueTicketInfo,
  classify,
  clip,
  compareWaiting,
  extraReplyAfter,
  intercomAppHost,
  parseConversation,
  parseTicket,
  resolveTicket,
  weightedPick,
} from "./queueModel";

const queueLog = log.child("queue");

// What the queue reads from Intercom. IntercomClient satisfies it; tests hand
// in a fake.
export interface QueueSource {
  searchOpenConversationsRaw(startingAfter?: string | null): Promise<{ items: unknown[]; nextStartingAfter: string | null }>;
  searchOpenCustomerTicketsRaw(startingAfter?: string | null): Promise<{ items: unknown[]; nextStartingAfter: string | null }>;
  getConversationReplyView(conversationId: string): Promise<{ parts: IntercomWebhookPart[] } | null>;
  getConversationTranscript(conversationId: string): Promise<Array<{ author: string; at: Date | null; text: string }>>;
  listAdmins(): Promise<IntercomAdmin[]>;
  listTeams(): Promise<Array<{ id: string; name: string }>>;
  getMe(): Promise<{ appIdCode?: string | null }>;
}

// The settings the queue reads (SettingsStore satisfies it).
export interface QueueSettingsView {
  queueFinCountsAsReply(): boolean;
  queueNotesCountAsReply(): boolean;
  queueExclusions(): QueueExclusions;
  intercomOperatorAdminId(): string | null;
  intercomAdminId(): string | null;
  intercomRegion(): IntercomRegion;
  intercomConfigured(): boolean;
}

export interface QueueSnapshot {
  builtAt: number; // ms
  items: QueueItem[]; // longest waiting first
  scanned: number; // open conversations read
  truncated: boolean; // the page cap stopped the scan early
  // Toggle checks (Fin / notes count as replied) that needed the parts but
  // were skipped by the per-refresh budget: those items were decided from the
  // statistics alone.
  partsSkipped: number;
  error: string | null; // the last refresh failed; items are the previous ones
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

const SNAPSHOT_TTL_MS = 60_000;
const MAX_PAGES = 40; // 6,000 open conversations; the rest is reported as truncated
const PARTS_BUDGET = 200; // toggle checks per refresh
const PARTS_CONCURRENCY = 4;
const ADMINS_TTL_MS = 60_000;
const TEAMS_TTL_MS = 5 * 60_000;
const WORKSPACE_TTL_MS = 60 * 60_000;
const MESSAGE_TTL_MS = 5 * 60_000;
export const RESERVATION_MS = 10 * 60_000;
const FIN_NAME_RE = /^(operator|fin)(\s|$)/i;

export class QueueData {
  private snap: QueueSnapshot | null = null;
  private snapKey = "";
  private inflight: Promise<QueueSnapshot> | null = null;
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

  // ---- snapshot ----

  // Cached for a minute and shared by every viewer, so the Intercom cost is
  // one scan a minute however many tabs are open. A settings change (toggles,
  // exclusions) invalidates it. A failed refresh keeps the previous items and
  // says so.
  async snapshot(): Promise<QueueSnapshot> {
    const key = this.settingsKey();
    if (this.snap && this.snapKey === key && this.now() - this.snap.builtAt < SNAPSHOT_TTL_MS) return this.snap;
    if (!this.inflight) {
      this.inflight = this.build(key).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
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

  private async build(key: string): Promise<QueueSnapshot> {
    try {
      const [convPages, ticketPages, directory] = await Promise.all([
        this.pageAll((after) => this.source.searchOpenConversationsRaw(after)),
        this.pageAll((after) => this.source.searchOpenCustomerTicketsRaw(after)),
        this.directory().catch(() => null),
      ]);
      const tickets = new Map<string, QueueTicketInfo>();
      for (const raw of ticketPages.items) {
        const t = parseTicket(raw);
        if (t) tickets.set(t.id, t);
      }
      const opts = this.classifyOptions(directory);
      const candidates: Array<{ item: QueueItem; lastContactStat: number }> = [];
      let scanned = 0;
      for (const raw of convPages.items) {
        const conv = parseConversation(raw);
        if (!conv) continue;
        scanned++;
        const item = classify(conv, resolveTicket(conv, tickets), opts);
        if (item) candidates.push({ item, lastContactStat: conv.lastContactReplyAt ?? item.lastContactAt });
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
      // Bounded caches: drop entries for conversations no longer open.
      const open = new Set(items.map((i) => i.id));
      for (const id of this.partsCache.keys()) if (!open.has(id)) this.partsCache.delete(id);
      for (const id of this.messageCache.keys()) if (!open.has(id)) this.messageCache.delete(id);

      items.sort(compareWaiting);
      const snap: QueueSnapshot = {
        builtAt: this.now(),
        items,
        scanned,
        truncated: convPages.truncated || ticketPages.truncated,
        partsSkipped,
        error: null,
      };
      this.snap = snap;
      this.snapKey = key;
      return snap;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      queueLog.warn("queue snapshot refresh failed", { "error.message": message });
      // The raw message stays in the logs; the page only learns that it failed.
      if (this.snap) return { ...this.snap, error: "Intercom did not answer the last refresh." };
      return { builtAt: this.now(), items: [], scanned: 0, truncated: false, partsSkipped: 0, error: "Intercom did not answer." };
    }
  }

  private async pageAll(
    fetchPage: (after: string | null) => Promise<{ items: unknown[]; nextStartingAfter: string | null }>
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchPage(after);
      items.push(...res.items);
      if (!res.nextStartingAfter) return { items, truncated: false };
      after = res.nextStartingAfter;
    }
    queueLog.warn("queue scan truncated", { "queue.pages": MAX_PAGES });
    return { items, truncated: true };
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
    candidates: Array<{ item: QueueItem; lastContactStat: number }>,
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
        let parts: IntercomWebhookPart[] | null = cached && cached.updatedAt === c.item.updatedAt ? cached.parts : null;
        if (!parts) {
          if (fetches >= PARTS_BUDGET) {
            skipped++;
            keep.set(c.item.id, true);
            continue;
          }
          fetches++;
          const view = await this.source.getConversationReplyView(c.item.id).catch(() => undefined);
          if (view === undefined) {
            // A failed fetch keeps the statistics' answer.
            keep.set(c.item.id, true);
            continue;
          }
          if (view === null) {
            keep.set(c.item.id, false); // deleted meanwhile
            continue;
          }
          parts = view.parts;
          this.partsCache.set(c.item.id, { updatedAt: c.item.updatedAt, parts });
        }
        keep.set(c.item.id, !extraReplyAfter(parts, c.lastContactStat, { fin: opts.fin, notes: opts.notes, finAdminIds, botAdminIds }));
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
    return pick;
  }

  release(adminId: string, scope: string): boolean {
    const key = `${adminId}|${scope}`;
    const had = this.picks.get(key)?.conversationId != null;
    this.picks.set(key, { conversationId: null, reservedUntil: 0 });
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
