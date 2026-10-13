import type { Badge, ObjectRef } from "../dashboard/renderer/contract";
import type { QueueExclusions } from "../config/SettingsStore";
import type { QueueActor } from "./QueueAuth";
import type { QueueData, QueueDirectory, QueueSnapshot } from "./QueueData";
import {
  NO_PERSON,
  QueueFilters,
  QueueItem,
  QueueScope,
  UNASSIGNED_INBOX,
  applyBaseFilters,
  applyFilters,
  inScope,
  parseFilters,
  parseScopeKey,
  scopeKey,
  waitLabel,
} from "./queueModel";
import type {
  QueueAction,
  QueueActionResult,
  QueueBlock,
  QueueCell,
  QueueKvBlock,
  QueueNavItem,
  QueuePageView,
  QueueTableBlock,
  QueueViewRequest,
} from "./contract";

// Server-built pages for the Intercom Queue (the dashboard's server-driven
// pattern: the client draws exactly what it is handed). Every view reads the
// shared one-minute snapshot; nothing here calls Intercom except the big
// cards' latest customer message.

export const QUEUE_PAGE_SIZE = 25;
const LONGEST_TOP = 10;
const NAV_TOP = 6;
const OFFSET_RE = /^\d{1,6}$/;
const ID_RE = /^\d{1,20}$/;

const CATEGORY_LABELS: Record<string, string> = {
  submitted: "Submitted",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
  resolved: "Resolved",
};

export interface QueueViewSettings {
  intercomConfigured(): boolean;
  queueExclusions(): QueueExclusions;
}

type Ctx = {
  actor: QueueActor;
  snap: QueueSnapshot;
  dir: QueueDirectory;
  workspace: string | null;
  nowSec: number;
  nav: QueueNavItem[];
};

export class QueueViews {
  constructor(
    private data: QueueData,
    private settings: QueueViewSettings,
    private now: () => number = Date.now
  ) {}

  async build(actor: QueueActor, req: QueueViewRequest): Promise<QueuePageView | null> {
    const scope = this.scopeFor(req);
    if (!scope && req.page !== "inboxes" && req.page !== "people") return null;
    const [snap, dir, workspace] = await Promise.all([
      this.data.snapshot(),
      this.data.directory().catch((): QueueDirectory => ({ teammates: new Map(), teams: new Map() })),
      this.data.workspaceIdCode().catch(() => null),
    ]);
    const ctx: Ctx = { actor, snap, dir, workspace, nowSec: Math.floor(this.now() / 1000), nav: [] };
    ctx.nav = this.nav(ctx);
    let built: { title: string; crumbs: QueuePageView["crumbs"]; blocks: QueueBlock[]; active: string };
    if (req.page === "inboxes") built = this.inboxesPage(ctx, req);
    else if (req.page === "people") built = this.peoplePage(ctx, req);
    else built = await this.scopePage(ctx, scope!, req);
    return {
      page: req.page,
      title: built.title,
      crumbs: built.crumbs,
      nav: ctx.nav,
      activeNav: built.active,
      blocks: built.blocks,
      actorLabel: actor.name,
      updatedAt: new Date(snap.builtAt).toISOString(),
    };
  }

  // Randomizer buttons. The scope and the filters the page showed are baked
  // into the button; both are validated again here.
  async action(actor: QueueActor, key: string, params: Record<string, unknown>): Promise<QueueActionResult> {
    const scope = parseScopeKey(params.scope);
    if (!scope) return { ok: false, error: "Unknown view." };
    const sk = scopeKey(scope);
    if (key === "section:queue.release") {
      const had = this.data.release(actor.adminId, sk);
      return { ok: true, text: had ? "Released: others can roll it again." : "No pick to release." };
    }
    if (key === "section:queue.roll") {
      const filters = parseFilters(stringParams(params));
      const snap = await this.data.snapshot();
      const pick = this.data.roll(actor.adminId, sk, this.randomPool(snap.items, scope, filters, actor));
      return pick ? { ok: true, text: "New pick, reserved for you for 10 minutes." } : { ok: false, error: "Nothing left to roll in this view." };
    }
    return { ok: false, error: "Unknown action." };
  }

  // ---- scopes ----

  private scopeFor(req: QueueViewRequest): QueueScope | null {
    if (req.page === "mine") return { kind: "mine" };
    if (req.page === "global") return { kind: "global" };
    const id = req.params.id ?? "";
    if (req.page === "inbox.detail" && (id === UNASSIGNED_INBOX || ID_RE.test(id))) return { kind: "inbox", id };
    if (req.page === "person.detail" && (id === NO_PERSON || ID_RE.test(id))) return { kind: "person", id };
    return null;
  }

  private teamName(ctx: Ctx, id: string | null): string {
    if (id == null || id === UNASSIGNED_INBOX) return "Unassigned";
    return ctx.dir.teams.get(id) ?? `Team ${id}`;
  }

  private personName(ctx: Ctx, id: string | null): string {
    if (id == null || id === NO_PERSON) return "No person";
    const name = ctx.dir.teammates.get(id)?.name ?? `Teammate ${id}`;
    return id === ctx.actor.adminId ? `${name} (you)` : name;
  }

  private scopeTitle(ctx: Ctx, scope: QueueScope): string {
    switch (scope.kind) {
      case "mine":
        return "Mine";
      case "global":
        return "Global";
      case "inbox":
        return this.teamName(ctx, scope.id);
      case "person":
        return scope.id === NO_PERSON ? "No person assigned" : this.personName(ctx, scope.id);
    }
  }

  private scopeRef(scope: QueueScope, filters?: Record<string, string>): ObjectRef {
    const page = scope.kind === "inbox" ? "inbox.detail" : scope.kind === "person" ? "person.detail" : scope.kind;
    return {
      page,
      ...(scope.kind === "inbox" || scope.kind === "person" ? { params: { id: scope.id } } : {}),
      ...(filters ? { filters } : {}),
    };
  }

  // ---- the sidebar ----

  private nav(ctx: Ctx): QueueNavItem[] {
    const visible = ctx.snap.items.filter((i) => !i.snoozed);
    const badge = (n: number) => (n > 0 ? { badge: String(n) } : {});
    const nav: QueueNavItem[] = [
      { key: "mine", label: "Mine", page: "mine", ...badge(visible.filter((i) => i.assigneeId === ctx.actor.adminId).length) },
      { key: "global", label: "Global", page: "global", ...badge(visible.length) },
    ];
    const inboxes = this.groupCounts(visible, (i) => i.teamId ?? UNASSIGNED_INBOX);
    for (const [id, n] of this.top(inboxes, (id) => this.teamName(ctx, id))) {
      nav.push({ key: `inbox:${id}`, label: this.teamName(ctx, id), page: "inbox.detail", params: { id }, group: "Inboxes", ...badge(n) });
    }
    nav.push({ key: "inboxes", label: "All inboxes", page: "inboxes", group: "Inboxes" });
    const people = this.groupCounts(visible, (i) => i.assigneeId ?? NO_PERSON);
    for (const [id, n] of this.top(people, (id) => this.personName(ctx, id))) {
      nav.push({ key: `person:${id}`, label: this.personName(ctx, id), page: "person.detail", params: { id }, group: "People", ...badge(n) });
    }
    nav.push({ key: "people", label: "All people", page: "people", group: "People" });
    return nav;
  }

  private groupCounts(items: readonly QueueItem[], keyOf: (i: QueueItem) => string): Map<string, number> {
    const m = new Map<string, number>();
    for (const i of items) m.set(keyOf(i), (m.get(keyOf(i)) ?? 0) + 1);
    return m;
  }

  // The busiest few, by count then name.
  private top(counts: Map<string, number>, nameOf: (id: string) => string): Array<[string, number]> {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0])))
      .slice(0, NAV_TOP);
  }

  private activeKey(scope: QueueScope, nav: QueueNavItem[]): string {
    const key = scopeKey(scope);
    if (nav.some((n) => n.key === key)) return key;
    return scope.kind === "inbox" ? "inboxes" : scope.kind === "person" ? "people" : key;
  }

  // ---- a scope: Mine, Global, one inbox, one teammate ----

  private async scopePage(
    ctx: Ctx,
    scope: QueueScope,
    req: QueueViewRequest
  ): Promise<{ title: string; crumbs: QueuePageView["crumbs"]; blocks: QueueBlock[]; active: string }> {
    const filters = parseFilters(req.filters);
    const scoped = ctx.snap.items.filter((i) => inScope(i, scope, ctx.actor.adminId));
    const base = applyBaseFilters(scoped, filters);
    const list = applyFilters(scoped, filters);
    const view = req.filters.view === "longest" || req.filters.view === "random" ? req.filters.view : "";
    const title = this.scopeTitle(ctx, scope);

    const blocks: QueueBlock[] = [this.scopeHeader(ctx, scope, title, base)];
    blocks.push(...this.notices(ctx));
    blocks.push({
      type: "tabs",
      key: "view",
      value: view,
      items: [
        { value: "", label: "All", badge: String(list.length) },
        { value: "longest", label: "Longest waiting" },
        { value: "random", label: "Randomizer" },
      ],
    });
    if (view === "") blocks.push(this.allTable(ctx, base, list, filters, req));
    else {
      const active = activeFilterLabels(filters);
      if (active.length) {
        const keep: Record<string, string> = { view };
        blocks.push({
          type: "notice",
          badge: { kind: "info", text: "Filtered" },
          text: `Showing ${active.join(", ")} only (set on the All tab).`,
          actions: [{ key: "nav:clear", label: "Clear filters", ref: this.scopeRef(scope, keep) }],
        });
      }
      if (view === "longest") blocks.push(...(await this.longestBlocks(ctx, scope, list, req)));
      else blocks.push(...(await this.randomBlocks(ctx, scope, list, filters)));
    }

    const crumbs: QueuePageView["crumbs"] =
      scope.kind === "inbox"
        ? [{ label: "Inboxes", ref: { page: "inboxes" } }, { label: title }]
        : scope.kind === "person"
          ? [{ label: "People", ref: { page: "people" } }, { label: title }]
          : [{ label: title }];
    return { title, crumbs, blocks, active: this.activeKey(scope, ctx.nav) };
  }

  private scopeHeader(ctx: Ctx, scope: QueueScope, title: string, base: QueueItem[]): QueueBlock {
    const first = base.filter((i) => i.kind === "first").length;
    const oldest = base.length ? base[0] : null;
    const sub = oldest
      ? `${base.length} waiting on a reply · oldest ${waitLabel(ctx.nowSec - oldest.waitingSince)}`
      : "Nothing waits on a reply";
    const badges: Badge[] = [];
    if (scope.kind === "person" && scope.id !== NO_PERSON && ctx.dir.teammates.get(scope.id)?.away) {
      badges.push({ kind: "warn", text: "Away" });
    }
    if (scope.kind === "mine" && ctx.dir.teammates.get(ctx.actor.adminId)?.away) badges.push({ kind: "warn", text: "You are away" });
    const age = Math.max(0, Math.floor(this.now() / 1000) - Math.floor(ctx.snap.builtAt / 1000));
    return {
      type: "header",
      title,
      sub,
      ...(badges.length ? { badges } : {}),
      meta: [
        { label: "First reply", value: String(first) },
        { label: "Follow-up", value: String(base.length - first) },
        { label: "Priority", value: String(base.filter((i) => i.priority).length) },
        { label: "SLA breached", value: String(base.filter((i) => i.slaStatus === "breached").length) },
        { label: "Updated", value: age < 60 ? "just now" : `${waitLabel(age)} ago` },
      ],
    };
  }

  private notices(ctx: Ctx): QueueBlock[] {
    const out: QueueBlock[] = [];
    if (!this.settings.intercomConfigured()) {
      out.push({
        type: "notice",
        badge: { kind: "error", text: "Not connected" },
        text: "The bridge's Intercom connection is not set up, so there is nothing to read. An admin sets it in Discord: /config → Integrations → Intercom.",
      });
    }
    if (ctx.snap.error) out.push({ type: "notice", badge: { kind: "warn", text: "Stale" }, text: `${ctx.snap.error} Showing the last list read.` });
    if (ctx.snap.truncated) {
      out.push({ type: "notice", badge: { kind: "warn", text: "Partial" }, text: "Only the first 6,000 open conversations were read; older ones may be missing." });
    }
    if (ctx.snap.partsSkipped > 0) {
      out.push({
        type: "notice",
        badge: { kind: "info", text: "Approximate" },
        text: `${ctx.snap.partsSkipped} ticket(s) were not checked for Fin replies or internal notes this minute and are listed from Intercom's statistics.`,
      });
    }
    return out;
  }

  // ---- All ----

  private allTable(ctx: Ctx, base: QueueItem[], list: QueueItem[], filters: QueueFilters, req: QueueViewRequest): QueueTableBlock {
    const offset = req.cursor && OFFSET_RE.test(req.cursor) ? Math.min(Number(req.cursor), Math.max(0, list.length - 1)) : 0;
    const page = list.slice(offset, offset + QUEUE_PAGE_SIZE);
    const first = base.filter((i) => i.kind === "first").length;
    return {
      type: "table",
      key: "queue",
      columns: [
        { key: "ticket", label: "Ticket" },
        { key: "customer", label: "Customer" },
        { key: "inbox", label: "Inbox" },
        { key: "assignee", label: "Assignee" },
        { key: "state", label: "State" },
        { key: "waiting", label: "Waiting" },
        { key: "flags", label: "" },
        { key: "open", label: "" },
      ],
      rows: page.map((i) => ({
        id: i.id,
        cells: [
          ticketCell(i),
          customerCell(i),
          { t: "link", v: this.teamName(ctx, i.teamId), ref: { page: "inbox.detail", params: { id: i.teamId ?? UNASSIGNED_INBOX } } },
          { t: "link", v: this.personName(ctx, i.assigneeId), ref: { page: "person.detail", params: { id: i.assigneeId ?? NO_PERSON } } },
          { t: "badge", b: stateBadge(i) },
          ageCell(i),
          { t: "flags", badges: this.flags(ctx, i) },
          { t: "external", v: "Open", href: this.data.inboxUrl(i.id, ctx.workspace) },
        ],
      })),
      counts: {
        key: "kind",
        items: [
          { value: "", label: "All", count: base.length },
          { value: "first", label: "First reply", count: first },
          { value: "followup", label: "Follow-up", count: base.length - first },
        ],
      },
      filters: [
        {
          key: "priority",
          label: "Priority",
          kind: "select",
          options: [{ value: "only", label: "Priority only" }],
          value: filters.priorityOnly ? "only" : "",
        },
        {
          key: "sla",
          label: "SLA",
          kind: "select",
          options: [
            { value: "breached", label: "Breached" },
            { value: "at_risk", label: "At risk" },
            { value: "ok", label: "OK" },
            { value: "none", label: "No SLA" },
          ],
          value: filters.sla ?? "",
        },
        {
          key: "snoozed",
          label: "Snoozed",
          kind: "select",
          options: [{ value: "include", label: "Include snoozed" }],
          value: filters.includeSnoozed ? "include" : "",
        },
      ],
      nextCursor: offset + QUEUE_PAGE_SIZE < list.length ? String(offset + QUEUE_PAGE_SIZE) : null,
      empty: "Nothing waits on a reply here.",
      ...(list.length > QUEUE_PAGE_SIZE
        ? { footer: `${offset + 1} to ${Math.min(offset + QUEUE_PAGE_SIZE, list.length)} of ${list.length}` }
        : list.length
          ? { footer: `${list.length} waiting` }
          : {}),
    };
  }

  private flags(ctx: Ctx, i: QueueItem): Badge[] {
    const out: Badge[] = [i.kind === "first" ? { kind: "info", text: "First reply" } : { kind: "neutral", text: "Follow-up" }];
    if (i.priority) out.push({ kind: "warn", text: "Priority" });
    if (i.slaStatus === "breached") out.push({ kind: "error", text: "SLA breached" });
    else if (i.slaStatus === "at_risk") out.push({ kind: "warn", text: "SLA at risk" });
    const holder = this.data.reservedBy(i.id);
    if (holder) {
      out.push({ kind: "neutral", text: holder.adminId === ctx.actor.adminId ? "Rolled by you" : `Rolled by ${this.personName(ctx, holder.adminId)}` });
    }
    return out;
  }

  // ---- the big card (Longest waiting, Randomizer) ----

  private async card(ctx: Ctx, i: QueueItem, title: string, actions: QueueAction[], extra: Array<{ label: string; cell: QueueCell }> = []): Promise<QueueKvBlock> {
    const latest = await this.data.latestCustomerMessage(i);
    const rows: Array<{ label: string; cell: QueueCell }> = [
      { label: "Ticket", cell: { t: "text", v: i.title, strong: true } },
      { label: "Customer", cell: customerCell(i) },
      { label: "Inbox", cell: { t: "link", v: this.teamName(ctx, i.teamId), ref: { page: "inbox.detail", params: { id: i.teamId ?? UNASSIGNED_INBOX } } } },
      { label: "Assignee", cell: { t: "link", v: this.personName(ctx, i.assigneeId), ref: { page: "person.detail", params: { id: i.assigneeId ?? NO_PERSON } } } },
      { label: "State", cell: { t: "badge", b: stateBadge(i) } },
      { label: "Waiting", cell: ageCell(i) },
      { label: "Flags", cell: { t: "flags", badges: this.flags(ctx, i) } },
      ...(i.slaTarget ? [{ label: "SLA target", cell: { t: "text" as const, v: i.slaTarget } }] : []),
      ...extra,
      { label: "Latest customer message", cell: { t: "text", v: latest ?? (i.excerpt || "(no text)"), pre: true } },
    ];
    return { type: "kv", title, rows, actions: [{ key: "nav:open", label: "Open in Intercom", style: "primary", href: this.data.inboxUrl(i.id, ctx.workspace) }, ...actions] };
  }

  // ---- Longest waiting ----

  private async longestBlocks(ctx: Ctx, scope: QueueScope, list: QueueItem[], req: QueueViewRequest): Promise<QueueBlock[]> {
    const top = list.slice(0, LONGEST_TOP);
    if (!top.length) return [{ type: "empty", title: "Nothing waits on a reply", hint: "Every ticket in this view has an answer from the team." }];
    const n = Number(req.filters.i);
    const idx = Number.isInteger(n) && n >= 1 && n <= top.length ? n : 1;
    const item = top[idx - 1];
    const at = (k: number): ObjectRef => this.scopeRef(scope, { ...req.filters, view: "longest", i: String(k) });
    const card = await this.card(ctx, item, `#${idx} of ${top.length} longest waiting`, [
      { key: "nav:prev", label: "Previous", ref: at(idx - 1), ...(idx === 1 ? { disabledReason: "This is the longest waiting ticket." } : {}) },
      { key: "nav:next", label: "Next", ref: at(idx + 1), ...(idx === top.length ? { disabledReason: "This is the last of the top ten." } : {}) },
    ]);
    const table: QueueTableBlock = {
      type: "table",
      key: "longest",
      title: `Top ${top.length}`,
      columns: [
        { key: "rank", label: "#" },
        { key: "ticket", label: "Ticket" },
        { key: "assignee", label: "Assignee" },
        { key: "waiting", label: "Waiting" },
      ],
      rows: top.map((i, k) => ({
        id: i.id,
        ref: at(k + 1),
        cells: [
          { t: "text", v: k + 1 === idx ? `${k + 1} (shown)` : String(k + 1) },
          ticketCell(i),
          { t: "text", v: this.personName(ctx, i.assigneeId) },
          ageCell(i),
        ],
      })),
    };
    return [card, table];
  }

  // ---- Randomizer ----

  private randomPool(items: readonly QueueItem[], scope: QueueScope, filters: QueueFilters, actor: QueueActor): QueueItem[] {
    return applyFilters(
      items.filter((i) => inScope(i, scope, actor.adminId)),
      filters
    ).filter((i) => i.assigneeId == null || i.assigneeId === actor.adminId);
  }

  private async randomBlocks(ctx: Ctx, scope: QueueScope, list: QueueItem[], filters: QueueFilters): Promise<QueueBlock[]> {
    const sk = scopeKey(scope);
    const pool = list.filter((i) => i.assigneeId == null || i.assigneeId === ctx.actor.adminId);
    const baked: Record<string, unknown> = { scope: sk, ...filterParams(filters) };
    const roll: QueueAction = { key: "section:queue.roll", label: "Roll again", params: baked };
    const release: QueueAction = { key: "section:queue.release", label: "Release", params: { scope: sk } };
    const explain: QueueBlock = {
      type: "notice",
      badge: { kind: "info", text: "How it picks" },
      text: `Picks only unassigned tickets and your own (${pool.length} in this view), older ones likelier. A pick stays reserved for you for 10 minutes, so nobody else rolls it.`,
    };

    let pick = this.data.currentPick(ctx.actor.adminId, sk);
    // First visit to this view: roll once by itself.
    if (!pick && pool.length) {
      this.data.roll(ctx.actor.adminId, sk, pool);
      pick = this.data.currentPick(ctx.actor.adminId, sk);
    }
    if (!pick || pick.conversationId == null) {
      if (!pool.length) return [explain, this.emptyPool(ctx, scope)];
      return [
        explain,
        { type: "notice", badge: { kind: "neutral", text: "No pick" }, text: "You have no pick in this view right now.", actions: [{ ...roll, label: "Roll", style: "primary" }] },
      ];
    }
    const item = ctx.snap.items.find((i) => i.id === pick!.conversationId);
    if (!item) {
      return [
        explain,
        {
          type: "notice",
          badge: { kind: "ok", text: "Done" },
          text: "Your last pick no longer waits on a reply (answered, closed or moved out of this view).",
          actions: pool.length ? [{ ...roll, style: "primary" }] : [],
        },
        ...(pool.length ? [] : [this.emptyPool(ctx, scope)]),
      ];
    }
    const nowMs = this.now();
    const reserved: { label: string; cell: QueueCell } =
      pick.reservedUntil > nowMs
        ? { label: "Reserved for you until", cell: { t: "date", v: new Date(pick.reservedUntil).toISOString(), iso: new Date(pick.reservedUntil).toISOString() } }
        : { label: "Reservation", cell: { t: "text", v: "Expired: others can roll it now" } };
    const card = await this.card(ctx, item, "Your random pick", [roll, release], [reserved]);
    return [explain, card];
  }

  private emptyPool(ctx: Ctx, scope: QueueScope): QueueBlock {
    const colleague = scope.kind === "person" && scope.id !== NO_PERSON && scope.id !== ctx.actor.adminId;
    return {
      type: "empty",
      title: "Nothing to roll here",
      hint: colleague
        ? "The randomizer only hands out unassigned tickets and your own, so it never picks from a colleague's queue."
        : "No unassigned ticket, and none of yours, waits on a reply in this view.",
    };
  }

  // ---- overviews ----

  private inboxesPage(ctx: Ctx, req: QueueViewRequest): { title: string; crumbs: QueuePageView["crumbs"]; blocks: QueueBlock[]; active: string } {
    const excluded = new Set(this.settings.queueExclusions().teams.map((t) => t.id));
    const visible = ctx.snap.items.filter((i) => !i.snoozed);
    const ids = new Set<string>([UNASSIGNED_INBOX, ...[...ctx.dir.teams.keys()].filter((id) => !excluded.has(id))]);
    for (const i of visible) ids.add(i.teamId ?? UNASSIGNED_INBOX);
    const rows = this.overviewRows(ctx, [...ids], visible, (i) => i.teamId ?? UNASSIGNED_INBOX, (id) => this.teamName(ctx, id));
    const table = this.overviewTable(
      "inboxes",
      "Inbox",
      rows.map((r) => ({ ...r, cell: { t: "link", v: r.name, ref: { page: "inbox.detail", params: { id: r.id } } } })),
      req
    );
    return { title: "Inboxes", crumbs: [{ label: "Inboxes" }], blocks: [this.overviewHeader(ctx, "Inboxes", visible), ...this.notices(ctx), table], active: "inboxes" };
  }

  private peoplePage(ctx: Ctx, req: QueueViewRequest): { title: string; crumbs: QueuePageView["crumbs"]; blocks: QueueBlock[]; active: string } {
    const visible = ctx.snap.items.filter((i) => !i.snoozed);
    const ids = new Set<string>([NO_PERSON]);
    for (const t of ctx.dir.teammates.values()) if (t.seated && !t.bot) ids.add(t.id);
    for (const i of visible) ids.add(i.assigneeId ?? NO_PERSON);
    const rows = this.overviewRows(ctx, [...ids], visible, (i) => i.assigneeId ?? NO_PERSON, (id) => this.personName(ctx, id));
    const table = this.overviewTable(
      "people",
      "Teammate",
      rows.map((r) => ({
        ...r,
        cell: {
          t: "link",
          v: r.id !== NO_PERSON && ctx.dir.teammates.get(r.id)?.away ? `${r.name} (away)` : r.name,
          ref: { page: "person.detail", params: { id: r.id } },
        },
      })),
      req
    );
    return { title: "People", crumbs: [{ label: "People" }], blocks: [this.overviewHeader(ctx, "People", visible), ...this.notices(ctx), table], active: "people" };
  }

  private overviewHeader(ctx: Ctx, title: string, visible: QueueItem[]): QueueBlock {
    const age = Math.max(0, Math.floor(this.now() / 1000) - Math.floor(ctx.snap.builtAt / 1000));
    return {
      type: "header",
      title,
      sub: visible.length ? `${visible.length} waiting on a reply across the workspace` : "Nothing waits on a reply",
      meta: [{ label: "Updated", value: age < 60 ? "just now" : `${waitLabel(age)} ago` }],
    };
  }

  private overviewRows(
    ctx: Ctx,
    ids: string[],
    visible: QueueItem[],
    keyOf: (i: QueueItem) => string,
    nameOf: (id: string) => string
  ): Array<{ id: string; name: string; count: number; first: number; priority: number; oldest: QueueItem | null }> {
    const byId = new Map<string, QueueItem[]>();
    for (const i of visible) {
      const k = keyOf(i);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k)!.push(i);
    }
    return ids
      .map((id) => {
        const items = byId.get(id) ?? [];
        return {
          id,
          name: nameOf(id),
          count: items.length,
          first: items.filter((i) => i.kind === "first").length,
          priority: items.filter((i) => i.priority).length,
          oldest: items[0] ?? null, // the snapshot is already longest-waiting first
        };
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private overviewTable(
    key: string,
    label: string,
    rows: Array<{ id: string; cell: QueueCell; count: number; first: number; priority: number; oldest: QueueItem | null }>,
    req: QueueViewRequest
  ): QueueTableBlock {
    const offset = req.cursor && OFFSET_RE.test(req.cursor) ? Math.min(Number(req.cursor), Math.max(0, rows.length - 1)) : 0;
    const page = rows.slice(offset, offset + QUEUE_PAGE_SIZE);
    return {
      type: "table",
      key,
      columns: [
        { key: "name", label },
        { key: "waiting", label: "Waiting", align: "right" },
        { key: "first", label: "First reply", align: "right" },
        { key: "followup", label: "Follow-up", align: "right" },
        { key: "priority", label: "Priority", align: "right" },
        { key: "oldest", label: "Oldest" },
      ],
      rows: page.map((r) => ({
        id: r.id,
        cells: [
          r.cell,
          { t: "text", v: String(r.count) },
          { t: "text", v: String(r.first) },
          { t: "text", v: String(r.count - r.first) },
          { t: "text", v: String(r.priority) },
          r.oldest ? ageCell(r.oldest) : { t: "text", v: "None" },
        ],
      })),
      nextCursor: offset + QUEUE_PAGE_SIZE < rows.length ? String(offset + QUEUE_PAGE_SIZE) : null,
      empty: "Nothing to show.",
      ...(rows.length > QUEUE_PAGE_SIZE ? { footer: `${offset + 1} to ${Math.min(offset + QUEUE_PAGE_SIZE, rows.length)} of ${rows.length}` } : {}),
    };
  }
}

// ---- cells ----

function ticketCell(i: QueueItem): QueueCell {
  return { t: "text", v: i.title, strong: true, ...(i.excerpt && i.excerpt !== i.title ? { sub: i.excerpt } : {}) };
}

function customerCell(i: QueueItem): QueueCell {
  const name = i.customerName ?? i.customerEmail ?? "Unknown customer";
  return { t: "text", v: name, ...(i.customerName && i.customerEmail ? { sub: i.customerEmail } : {}) };
}

function ageCell(i: QueueItem): QueueCell {
  return { t: "age", iso: new Date(i.waitingSince * 1000).toISOString() };
}

function stateBadge(i: QueueItem): Badge {
  if (i.snoozed) return { kind: "neutral", text: "Snoozed" };
  if (!i.ticket) return { kind: "info", text: "Conversation" };
  const label = i.ticket.stateLabel ?? CATEGORY_LABELS[i.ticket.stateCategory ?? ""] ?? "Open ticket";
  return { kind: i.ticket.stateCategory === "submitted" ? "warn" : "info", text: label };
}

function activeFilterLabels(f: QueueFilters): string[] {
  const out: string[] = [];
  if (f.kind === "first") out.push("first replies");
  if (f.kind === "followup") out.push("follow-ups");
  if (f.priorityOnly) out.push("priority");
  if (f.sla === "breached") out.push("SLA breached");
  if (f.sla === "at_risk") out.push("SLA at risk");
  if (f.sla === "ok") out.push("SLA ok");
  if (f.sla === "none") out.push("no SLA");
  if (f.includeSnoozed) out.push("including snoozed");
  return out;
}

// The filters as the randomizer buttons carry them (string params, the same
// keys the URL uses).
function filterParams(f: QueueFilters): Record<string, string> {
  return {
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.priorityOnly ? { priority: "only" } : {}),
    ...(f.sla ? { sla: f.sla } : {}),
    ...(f.includeSnoozed ? { snoozed: "include" } : {}),
  };
}

function stringParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === "string" && v.length <= 32) out[k] = v;
  return out;
}
