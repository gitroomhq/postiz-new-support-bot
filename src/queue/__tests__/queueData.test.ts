import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueData, type QueueSettingsView, type QueueSource } from "../QueueData";
import { QueueViews } from "../queueViews";
import type { QueueExclusions } from "../../config/SettingsStore";
import type { IntercomAdmin, IntercomWebhookPart } from "../../intercom/types";
import type { QueueKvBlock, QueueTableBlock } from "../contract";

// The snapshot (one shared Intercom scan a minute), the randomizer's
// reservations, and the pages built from it. Intercom is a fake.

const NOW = 2_000_000_000_000; // ms

// Lets a background refresh (fake source: immediate promises) finish.
const settle = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function rawConv(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    created_at: Math.floor(NOW / 1000) - 3600,
    updated_at: Math.floor(NOW / 1000) - 60,
    state: "open",
    priority: "not_priority",
    source: { subject: `Subject ${id}`, body: `Body ${id}`, author: { type: "user", id: `c${id}`, name: `Customer ${id}` } },
    admin_assignee_id: null,
    team_assignee_id: 22,
    tags: { tags: [] },
    // The customer's latest message: a minute ago (waiting_since, when a
    // fixture sets one, is never later than this, as in Intercom).
    statistics: { last_contact_reply_at: Math.floor(NOW / 1000) - 60, last_admin_reply_at: null },
    custom_attributes: {},
    ...over,
  };
}

interface FakeSource extends QueueSource {
  calls: { conv: number; tickets: number; parts: string[]; transcript: string[] };
  conversations: unknown[];
  tickets: unknown[];
  parts: Map<string, IntercomWebhookPart[]>;
  fail: boolean;
}

function fakeSource(conversations: unknown[] = [], tickets: unknown[] = []): FakeSource {
  const admins: IntercomAdmin[] = [
    { id: "11", name: "Ada", hasInboxSeat: true },
    { id: "12", name: "Grace", hasInboxSeat: true, awayModeEnabled: true },
    { id: "13", name: "Lite Seat", hasInboxSeat: false },
    { id: "800", name: "Operator", hasInboxSeat: true },
  ];
  const src: FakeSource = {
    calls: { conv: 0, tickets: 0, parts: [], transcript: [] },
    conversations,
    tickets,
    parts: new Map(),
    fail: false,
    async searchOpenConversationsRaw(after) {
      src.calls.conv++;
      if (src.fail) throw new Error("Intercom conversation search 500: secret detail");
      // Two pages when there are more than two items, to exercise paging.
      if (!after && src.conversations.length > 2) return { items: src.conversations.slice(0, 2), nextStartingAfter: "p2" };
      if (after === "p2") return { items: src.conversations.slice(2), nextStartingAfter: null };
      return { items: src.conversations, nextStartingAfter: null };
    },
    async searchOpenCustomerTicketsRaw() {
      src.calls.tickets++;
      if (src.fail) throw new Error("down");
      return { items: src.tickets, nextStartingAfter: null };
    },
    async getConversationReplyView(id) {
      src.calls.parts.push(id);
      return { parts: src.parts.get(id) ?? [] };
    },
    async getConversationTranscript(id) {
      src.calls.transcript.push(id);
      return [
        { author: "customer", at: null, text: "first message" },
        { author: "agent Ada", at: null, text: "an answer" },
        { author: "customer", at: null, text: `latest from ${id}` },
      ];
    },
    async listAdmins() {
      return admins;
    },
    async listTeams() {
      return [
        { id: "22", name: "Support Team" },
        { id: "23", name: "Billing Team" },
      ];
    },
    async getMe() {
      return { appIdCode: "abcd1234" };
    },
  };
  return src;
}

function settings(over: Partial<{ fin: boolean; notes: boolean; exclusions: QueueExclusions }> = {}): QueueSettingsView & {
  state: { fin: boolean; notes: boolean; exclusions: QueueExclusions };
} {
  const state = { fin: false, notes: false, exclusions: { teams: [], tags: [], ticketTypes: [] } as QueueExclusions, ...over };
  return {
    state,
    queueFinCountsAsReply: () => state.fin,
    queueNotesCountAsReply: () => state.notes,
    queueExclusions: () => state.exclusions,
    intercomOperatorAdminId: () => "800",
    intercomAdminId: () => "900",
    intercomRegion: () => "us",
    intercomConfigured: () => true,
    slaStatusAttributeName: () => "SLA Status",
    slaAttributeName: () => "SLA Target",
  };
}

test("the snapshot is one shared scan a minute, longest waiting first", async () => {
  let now = NOW;
  const src = fakeSource([
    rawConv("1", { waiting_since: Math.floor(NOW / 1000) - 100 }),
    rawConv("2", { waiting_since: Math.floor(NOW / 1000) - 900 }),
    rawConv("3", { statistics: { last_contact_reply_at: 1, last_admin_reply_at: 2 } }), // we spoke last
  ]);
  const data = new QueueData(src, settings(), () => now);
  const a = await data.snapshot();
  assert.deepEqual(a.items.map((i) => i.id), ["2", "1"]);
  assert.equal(a.scanned, 3);
  assert.equal(src.calls.conv, 2, "two pages");
  await data.snapshot();
  assert.equal(src.calls.conv, 2, "cached inside the minute");
  now += 61_000;
  src.conversations.push(rawConv("4", { waiting_since: Math.floor(NOW / 1000) - 2000 }));
  const stale = await data.snapshot();
  assert.deepEqual(stale.items.map((i) => i.id), ["2", "1"], "past the minute the last list is served at once");
  await settle();
  assert.equal(src.calls.conv, 4, "while a fresh one is read in the background");
  assert.deepEqual((await data.snapshot()).items.map((i) => i.id), ["4", "2", "1"]);
});

test("concurrent viewers share one refresh", async () => {
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => NOW);
  await Promise.all([data.snapshot(), data.snapshot(), data.snapshot()]);
  assert.equal(src.calls.conv, 1);
});

test("a failed refresh keeps the last list and says so without the raw error", async () => {
  let now = NOW;
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => now);
  await data.snapshot();
  src.fail = true;
  now += 61_000;
  await data.snapshot();
  await settle();
  const stale = await data.snapshot();
  assert.deepEqual(stale.items.map((i) => i.id), ["1"]);
  assert.ok(stale.error);
  assert.doesNotMatch(stale.error, /secret detail/);
  // Backing off: no new scan for 30 seconds after a failure.
  const calls = src.calls.conv;
  now += 10_000;
  await data.snapshot();
  await settle();
  assert.equal(src.calls.conv, calls);
  now += 25_000;
  src.fail = false;
  await data.snapshot();
  await settle();
  assert.equal(src.calls.conv, calls + 1);
  assert.equal((await data.snapshot()).error, null, "a good scan clears the error");
});

test("a first scan that fails reports an empty, errored list and backs off", async () => {
  const src = fakeSource([rawConv("1")]);
  src.fail = true;
  const data = new QueueData(src, settings(), () => NOW);
  const snap = await data.snapshot();
  assert.deepEqual(snap.items, []);
  assert.ok(snap.error);
  await data.snapshot();
  assert.equal(src.calls.conv, 1);
});

test("SLA status is read from the attribute names the SLA Manager uses", async () => {
  const s = { ...settings(), slaStatusAttributeName: () => "Custom SLA State", slaAttributeName: () => "Custom Target" };
  const src = fakeSource([rawConv("1", { custom_attributes: { "Custom SLA State": "breached", "Custom Target": "VIP", "SLA Status": "ok" } })]);
  const item = (await new QueueData(src, s, () => NOW).snapshot()).items[0];
  assert.equal(item.slaStatus, "breached");
  assert.equal(item.slaTarget, "VIP");
});

test("a teammate named like Fin is a person; the exact name only counts without an Operator id", async () => {
  const src = fakeSource();
  const base = src.listAdmins;
  src.listAdmins = async () => [...(await base()), { id: "15", name: "Fin Murphy", hasInboxSeat: true }, { id: "16", name: "Fin", hasInboxSeat: true }];
  const withOp = new QueueData(src, settings(), () => NOW);
  assert.equal((await withOp.seatedTeammate("15"))?.name, "Fin Murphy");
  assert.equal((await withOp.seatedTeammate("16"))?.name, "Fin", "the configured Operator id decides");
  const noOp = new QueueData(src, { ...settings(), intercomOperatorAdminId: () => null }, () => NOW);
  assert.equal((await noOp.seatedTeammate("15"))?.name, "Fin Murphy");
  assert.equal(await noOp.seatedTeammate("16"), null);
  assert.equal(await noOp.seatedTeammate("800"), null, "Operator by its exact name");
});

test("randomizer: your own ticket is yours to roll even while a colleague still holds it", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: null })]);
  const data = new QueueData(src, settings(), () => NOW, () => 0);
  const unassigned = (await data.snapshot()).items;
  assert.equal(data.roll("12", "global", unassigned)?.id, "1");
  // It gets assigned to Ada while Grace's reservation lasts.
  const mine = unassigned.map((i) => ({ ...i, assigneeId: "11" }));
  assert.equal(data.roll("11", "mine", mine)?.id, "1");
});

test("a settings change invalidates the cache", async () => {
  const s = settings();
  const src = fakeSource([rawConv("1"), rawConv("2", { team_assignee_id: 23 })]);
  const data = new QueueData(src, s, () => NOW);
  assert.equal((await data.snapshot()).items.length, 2);
  s.state.exclusions = { teams: [{ id: "23", name: "Billing Team" }], tags: [], ticketTypes: [] };
  const after = await data.snapshot();
  assert.deepEqual(after.items.map((i) => i.id), ["1"]);
});

test("ticket states come from the ticket search: Waiting on customer drops out", async () => {
  const src = fakeSource(
    [rawConv("1"), rawConv("2")],
    [{ id: "2", ticket_state: { id: "5", category: "waiting_on_customer", internal_label: "Waiting on Customer" }, ticket_type: { id: "8", name: "Billing" } }]
  );
  const data = new QueueData(src, settings(), () => NOW);
  assert.deepEqual((await data.snapshot()).items.map((i) => i.id), ["1"]);
});

test("Fin counts only when switched on, checked from the parts and cached per version", async () => {
  const s = settings();
  const src = fakeSource([rawConv("1")]);
  const custAt = Math.floor(NOW / 1000) - 60;
  src.parts.set("1", [{ part_type: "comment", body: "Fin here", created_at: custAt + 10, author: { type: "bot", id: "b" } }]);
  const data = new QueueData(src, s, () => NOW);
  assert.equal((await data.snapshot()).items.length, 1, "off: Fin is not a reply");
  assert.equal(src.calls.parts.length, 0, "no parts fetched while both toggles are off");
  s.state.fin = true;
  assert.equal((await data.snapshot()).items.length, 0, "on: Fin answered");
  assert.equal(src.calls.parts.length, 1);
});

test("the directory marks bots and unseated teammates, and seatedTeammate refuses them", async () => {
  const data = new QueueData(fakeSource(), settings(), () => NOW);
  assert.equal((await data.seatedTeammate("11"))?.name, "Ada");
  assert.equal(await data.seatedTeammate("13"), null, "no inbox seat");
  assert.equal(await data.seatedTeammate("800"), null, "Operator");
  assert.equal(await data.seatedTeammate("999"), null, "not in the workspace");
  assert.equal(await data.workspaceIdCode(), "abcd1234");
  assert.equal(data.inboxUrl("55", "abcd1234"), "https://app.intercom.com/a/inbox/abcd1234/inbox/conversation/55");
  assert.equal(data.inboxUrl("55", "../evil"), "https://app.intercom.com/a/inbox/_/inbox/conversation/55");
});

test("randomizer: reservations keep two teammates off the same ticket; release stops auto-rolls", async () => {
  const src = fakeSource([rawConv("1"), rawConv("2")]);
  const data = new QueueData(src, settings(), () => NOW, () => 0);
  const pool = (await data.snapshot()).items;
  const a = data.roll("11", "global", pool);
  const b = data.roll("12", "global", pool);
  assert.ok(a && b);
  assert.notEqual(a.id, b.id, "a held ticket is skipped");
  assert.equal(data.reservedBy(a.id)?.adminId, "11");
  // Re-rolling skips the previous pick while there is another free ticket;
  // here the only other one is held, so the teammate keeps their own.
  const again = data.roll("11", "global", pool);
  assert.equal(again?.id, a.id);
  assert.equal(data.release("11", "global"), true);
  assert.equal(data.currentPick("11", "global")?.conversationId, null);
  assert.equal(data.reservedBy(a.id), null);
});

// ---- pages ----

const actor = { adminId: "11", name: "Ada", sessionIdHash: "h" };

function views(src: FakeSource, s = settings()) {
  const data = new QueueData(src, s, () => NOW, () => 0);
  const v = new QueueViews(data, { intercomConfigured: () => true, queueExclusions: () => s.state.exclusions }, () => NOW);
  return { data, v };
}

test("Global lists everything waiting, with the sidebar counts and Intercom links", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: 11 }), rawConv("2", { team_assignee_id: null }), rawConv("3", { state: "snoozed" })]);
  const { v } = views(src);
  const page = await v.build(actor, { page: "global", params: {}, filters: {}, cursor: null });
  assert.ok(page);
  assert.equal(page.activeNav, "global");
  const table = page.blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.equal(table.rows.length, 2, "snoozed hidden by default");
  const open = table.rows[0].cells[7];
  assert.equal(open.t, "external");
  assert.match((open as { href: string }).href, /^https:\/\/app\.intercom\.com\/a\/inbox\/abcd1234\/inbox\/conversation\//);
  const mine = page.nav.find((n) => n.key === "mine");
  assert.equal(mine?.badge, "1");
  assert.ok(page.nav.some((n) => n.key === "inbox:unassigned"));
  assert.ok(page.nav.some((n) => n.key === "inboxes"));
});

test("Mine, an inbox and a teammate scope the list", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: 11 }), rawConv("2", { admin_assignee_id: 12, team_assignee_id: 23 })]);
  const { v } = views(src);
  const rows = async (page: string, params: Record<string, string> = {}) =>
    ((await v.build(actor, { page, params, filters: {}, cursor: null }))!.blocks.find((b) => b.type === "table") as QueueTableBlock).rows.map((r) => r.id);
  assert.deepEqual(await rows("mine"), ["1"]);
  assert.deepEqual(await rows("inbox.detail", { id: "23" }), ["2"]);
  assert.deepEqual(await rows("person.detail", { id: "12" }), ["2"]);
  assert.equal(await v.build(actor, { page: "inbox.detail", params: { id: "abc" }, filters: {}, cursor: null }), null);
  assert.equal(await v.build(actor, { page: "nope", params: {}, filters: {}, cursor: null }), null);
});

test("All paginates 25 to a page", async () => {
  const many = Array.from({ length: 30 }, (_, k) => rawConv(String(100 + k), { waiting_since: Math.floor(NOW / 1000) - 10_000 + k }));
  const { v } = views(fakeSource(many));
  const first = (await v.build(actor, { page: "global", params: {}, filters: {}, cursor: null }))!.blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.equal(first.rows.length, 25);
  assert.equal(first.nextCursor, "25");
  assert.equal(first.rows[0].id, "100", "longest waiting first");
  const second = (await v.build(actor, { page: "global", params: {}, filters: {}, cursor: "25" }))!.blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextCursor, null);
});

test("Longest waiting shows one card with the latest customer message, stepping through the top ten", async () => {
  const src = fakeSource([rawConv("1", { waiting_since: Math.floor(NOW / 1000) - 50 }), rawConv("2", { waiting_since: Math.floor(NOW / 1000) - 500 })]);
  const { v } = views(src);
  const page = await v.build(actor, { page: "global", params: {}, filters: { view: "longest" }, cursor: null });
  const card = page!.blocks.find((b) => b.type === "kv") as QueueKvBlock;
  assert.match(card.title ?? "", /#1 of 2/);
  assert.equal(card.rows[0].cell.t, "text");
  assert.equal((card.rows[0].cell as { v: string }).v, "Subject 2");
  assert.ok(card.rows.some((r) => r.label === "Latest customer message" && (r.cell as { v: string }).v === "latest from 2"));
  assert.ok(card.actions?.[0].href?.startsWith("https://app.intercom.com/"));
  const second = await v.build(actor, { page: "global", params: {}, filters: { view: "longest", i: "2" }, cursor: null });
  assert.match(((second!.blocks.find((b) => b.type === "kv") as QueueKvBlock).title ?? ""), /#2 of 2/);
});

test("Randomizer rolls once by itself, only from unassigned and own tickets; roll and release actions", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: 12 }), rawConv("2", { admin_assignee_id: null })]);
  const { v, data } = views(src);
  const page = await v.build(actor, { page: "global", params: {}, filters: { view: "random" }, cursor: null });
  const card = page!.blocks.find((b) => b.type === "kv") as QueueKvBlock;
  assert.equal((card.rows[0].cell as { v: string }).v, "Subject 2", "never a colleague's ticket");
  assert.equal(data.reservedBy("2")?.adminId, "11");
  const release = await v.action(actor, "section:queue.release", { scope: "global" });
  assert.equal(release.ok, true);
  const after = await v.build(actor, { page: "global", params: {}, filters: { view: "random" }, cursor: null });
  assert.ok(!after!.blocks.some((b) => b.type === "kv"), "a released pick is not replaced by itself");
  const roll = await v.action(actor, "section:queue.roll", { scope: "global" });
  assert.equal(roll.ok, true);
  assert.equal((await v.action(actor, "section:queue.roll", { scope: "evil" })).ok, false);
  assert.equal((await v.action(actor, "section:queue.nope", { scope: "global" })).ok, false);
});

test("a pick since assigned to a colleague is no longer shown as yours", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: null })]);
  const s = settings();
  let now = NOW;
  const data = new QueueData(src, s, () => now, () => 0);
  const v = new QueueViews(data, { intercomConfigured: () => true, queueExclusions: () => s.state.exclusions }, () => now);
  const first = await v.build(actor, { page: "global", params: {}, filters: { view: "random" }, cursor: null });
  assert.ok(first!.blocks.some((b) => b.type === "kv"));
  (src.conversations[0] as Record<string, unknown>).admin_assignee_id = 12;
  now += 61_000;
  await data.snapshot();
  await settle();
  const after = await v.build(actor, { page: "global", params: {}, filters: { view: "random" }, cursor: null });
  assert.ok(!after!.blocks.some((b) => b.type === "kv"));
  assert.ok(after!.blocks.some((b) => b.type === "notice" && /no longer waits on you/.test(b.text)));
});

test("a colleague's queue has nothing to roll", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: 12 })]);
  const { v } = views(src);
  const page = await v.build(actor, { page: "person.detail", params: { id: "12" }, filters: { view: "random" }, cursor: null });
  assert.ok(page!.blocks.some((b) => b.type === "empty"));
});

test("the overviews list every inbox and seated person, paginated", async () => {
  const src = fakeSource([rawConv("1", { admin_assignee_id: 11 })]);
  const { v } = views(src);
  const inboxes = (await v.build(actor, { page: "inboxes", params: {}, filters: {}, cursor: null }))!;
  const it = inboxes.blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.deepEqual(it.rows.map((r) => r.id), ["22", "23", "unassigned"]);
  const people = (await v.build(actor, { page: "people", params: {}, filters: {}, cursor: null }))!;
  const pt = people.blocks.find((b) => b.type === "table") as QueueTableBlock;
  const ids = pt.rows.map((r) => r.id);
  assert.equal(ids[0], "11", "busiest first");
  assert.ok(ids.includes("none"));
  assert.ok(!ids.includes("13"), "no inbox seat");
  assert.ok(!ids.includes("800"), "Operator");
});
