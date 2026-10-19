import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueData, type QueueCache, type QueueResolution, type QueueResolutions, type QueueSaved, type QueueSettingsView, type QueueSource } from "../QueueData";
import { QueueViews } from "../queueViews";
import { parseConversation } from "../queueModel";
import { restoreSaved } from "../QueueCacheStore";
import type { QueueExclusions } from "../../config/SettingsStore";
import type { IntercomAdmin, IntercomWebhookPart } from "../../intercom/types";
import type { QueueCreatedRange } from "../../intercom/IntercomClient";
import type { QueueKvBlock, QueueTableBlock } from "../contract";

// The live list (a sliced full scan, catch-up reads, webhook re-reads, the
// saved copy for restarts), the randomizer's reservations, and the pages
// built from it. Intercom is a fake.

const NOW = 2_000_000_000_000; // ms
const NOW_SEC = Math.floor(NOW / 1000);
const DAY = 86_400;

function rawConv(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    created_at: NOW_SEC - 3600,
    updated_at: NOW_SEC - 60,
    state: "open",
    priority: "not_priority",
    source: { subject: `Subject ${id}`, body: `Body ${id}`, author: { type: "user", id: `c${id}`, name: `Customer ${id}` } },
    admin_assignee_id: null,
    team_assignee_id: 22,
    tags: { tags: [] },
    // The customer's latest message: a minute ago (waiting_since, when a
    // fixture sets one, is never later than this, as in Intercom).
    statistics: { last_contact_reply_at: NOW_SEC - 60, last_admin_reply_at: null },
    custom_attributes: {},
    ...over,
  };
}

interface FakeSource extends QueueSource {
  calls: { conv: number; tickets: number; catchUp: number; ranges: string[]; get: string[]; ticketGet: string[]; transcript: string[] };
  conversations: Array<Record<string, unknown>>;
  tickets: Array<Record<string, unknown>>;
  parts: Map<string, IntercomWebhookPart[]>;
  fail: boolean;
}

function inRange(raw: Record<string, unknown>, range?: QueueCreatedRange): boolean {
  const created = Number(raw.created_at);
  return (range?.after == null || created >= range.after) && (range?.before == null || created < range.before);
}

// Two pages when a slice holds more than two items, to exercise paging.
function paged(list: unknown[], after: string | null | undefined) {
  if (!after && list.length > 2) return { items: list.slice(0, 2), nextStartingAfter: "p2" };
  if (after === "p2") return { items: list.slice(2), nextStartingAfter: null };
  return { items: list, nextStartingAfter: null };
}

function fakeSource(conversations: Array<Record<string, unknown>> = [], tickets: Array<Record<string, unknown>> = []): FakeSource {
  const admins: IntercomAdmin[] = [
    { id: "11", name: "Ada", hasInboxSeat: true },
    { id: "12", name: "Grace", hasInboxSeat: true, awayModeEnabled: true },
    { id: "13", name: "Lite Seat", hasInboxSeat: false },
    { id: "800", name: "Operator", hasInboxSeat: true },
  ];
  const src: FakeSource = {
    calls: { conv: 0, tickets: 0, catchUp: 0, ranges: [], get: [], ticketGet: [], transcript: [] },
    conversations,
    tickets,
    parts: new Map(),
    fail: false,
    async searchOpenConversationsRaw(after, range) {
      src.calls.conv++;
      src.calls.ranges.push(`${range?.after ?? ""}..${range?.before ?? ""}`);
      if (src.fail) throw new Error("Intercom conversation search 500: secret detail");
      return paged(src.conversations.filter((c) => c.state !== "closed" && inRange(c, range)), after);
    },
    async searchOpenCustomerTicketsRaw(_after, range) {
      src.calls.tickets++;
      if (src.fail) throw new Error("down");
      return { items: src.tickets.filter((t) => inRange(t, range)), nextStartingAfter: null };
    },
    async searchConversationsUpdatedRaw(since) {
      src.calls.catchUp++;
      if (src.fail) throw new Error("Intercom conversation search 500: secret detail");
      return { items: src.conversations.filter((c) => Number(c.updated_at) > since), nextStartingAfter: null };
    },
    async searchCustomerTicketsUpdatedRaw(since) {
      if (src.fail) throw new Error("down");
      return { items: src.tickets.filter((t) => Number(t.updated_at ?? 0) > since), nextStartingAfter: null };
    },
    async getConversationRaw(id) {
      src.calls.get.push(id);
      const c = src.conversations.find((x) => x.id === id);
      return c ? { ...c, conversation_parts: { conversation_parts: src.parts.get(id) ?? [] } } : null;
    },
    async getTicketRaw(id) {
      src.calls.ticketGet.push(id);
      return src.tickets.find((t) => t.id === id) ?? null;
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

// Holds every conversation search until release(), each answering with what
// the fake held when the search was asked (an older page than a webhook read
// that lands meanwhile).
function gateScans(src: FakeSource): { entered: () => number; release: () => void } {
  let entered = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const original = src.searchOpenConversationsRaw.bind(src);
  src.searchOpenConversationsRaw = async (after, range) => {
    entered++;
    const page = original(after, range);
    await gate;
    return page;
  };
  return { entered: () => entered, release: () => open() };
}

function settings(over: Partial<{ fin: boolean; notes: boolean; exclusions: QueueExclusions }> = {}): QueueSettingsView & {
  state: { fin: boolean; notes: boolean; exclusions: QueueExclusions; enabled: boolean };
} {
  const state = { fin: false, notes: false, enabled: true, exclusions: { teams: [], tags: [], ticketTypes: [] } as QueueExclusions, ...over };
  return {
    state,
    queueEnabled: () => state.enabled,
    queueFinCountsAsReply: () => state.fin,
    queueNotesCountAsReply: () => state.notes,
    queueExclusions: () => state.exclusions,
    intercomOperatorAdminId: () => "800",
    intercomAdminId: () => "900",
    intercomRegion: () => "us",
    intercomConfigured: () => true,
  };
}

const ids = (snap: { items: Array<{ id: string }> } | null | undefined) => snap?.items.map((i) => i.id);

test("the first read walks five created_at slices at once; later reads catch up on what changed", async () => {
  let now = NOW;
  const src = fakeSource([
    rawConv("1", { waiting_since: NOW_SEC - 100 }),
    rawConv("2", { waiting_since: NOW_SEC - 900 }),
    rawConv("3", { statistics: { last_contact_reply_at: 1, last_admin_reply_at: 2 } }), // we spoke last
    rawConv("4", { created_at: NOW_SEC - 40 * DAY, waiting_since: NOW_SEC - 40 * DAY }),
  ]);
  const data = new QueueData(src, settings(), () => now);
  const a = await data.snapshot();
  assert.deepEqual(ids(a), ["4", "2", "1"]);
  assert.equal(a.scanned, 4);
  assert.equal(new Set(src.calls.ranges).size, 5, "five slices");
  assert.ok(src.calls.ranges.includes(`${NOW_SEC - DAY}..`), "the newest slice has no upper end");
  assert.ok(src.calls.ranges.includes(`..${NOW_SEC - 90 * DAY}`), "the oldest slice has no lower end");
  assert.equal(src.calls.conv, 6, "the newest slice took two pages");
  await data.snapshot();
  assert.equal(src.calls.conv, 6, "nothing new inside the minute");

  // A minute later: one catch-up read. Conversation 2 was closed meanwhile.
  src.conversations[1] = rawConv("2", { state: "closed", updated_at: NOW_SEC + 30 });
  now += 61_000;
  data.readySnapshot();
  await data.idle();
  assert.equal(src.calls.catchUp, 1);
  assert.equal(src.calls.conv, 6, "a catch-up, not a full scan");
  assert.deepEqual(ids(data.readySnapshot()), ["4", "1"]);

  // Fifteen minutes on: the full scan, the backstop.
  now += 15 * 60_000;
  data.readySnapshot();
  await data.idle();
  assert.equal(src.calls.conv, 11);
});

test("concurrent viewers share one read", async () => {
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => NOW);
  await Promise.all([data.snapshot(), data.snapshot(), data.snapshot()]);
  assert.equal(src.calls.conv, 5, "one request per slice");
});

test("browser views return at once during a slow first scan, then show its result", async () => {
  const src = fakeSource([rawConv("1")]);
  const gate = gateScans(src);
  const s = settings();
  const data = new QueueData(src, s, () => NOW);
  const views = new QueueViews(data, { intercomConfigured: () => true, queueExclusions: () => s.state.exclusions }, () => NOW);
  const actor = { adminId: "11", name: "Ada", sessionIdHash: "hash" };
  const req = { page: "global", params: {}, filters: {}, cursor: null };
  const loading = await views.build(actor, req, { waitForSnapshot: false });
  assert.equal(loading?.actorLabel, "Ada");
  assert.ok(!loading?.blocks.some((b) => b.type === "table"), "an incomplete scan must not look like an empty queue");
  await views.build(actor, req, { waitForSnapshot: false });
  assert.equal(gate.entered(), 5, "polling shares the pending scan");
  const changed = data.waitForChange(loading!.version, 5_000);
  gate.release();
  assert.equal(await changed, true, "the waiting page is woken by the finished scan");
  await data.idle();
  const loaded = await views.build(actor, req, { waitForSnapshot: false });
  assert.ok(loaded?.blocks.some((b) => b.type === "table"));
  assert.notEqual(loaded?.version, loading?.version);
});

test("a policy change re-derives the stored list without reading Intercom again", async () => {
  const s = settings();
  const src = fakeSource([rawConv("1"), rawConv("2", { team_assignee_id: 23 })]);
  const data = new QueueData(src, s, () => NOW);
  assert.equal((await data.snapshot()).items.length, 2);
  const reads = src.calls.conv;
  s.state.exclusions = { teams: [{ id: "23", name: "Billing Team" }], tags: [], ticketTypes: [] };
  assert.equal(data.readySnapshot(), null, "never serve a list built under the old policy");
  await data.idle();
  assert.deepEqual(ids(data.readySnapshot()), ["1"]);
  assert.deepEqual(ids(await data.snapshot()), ["1"]);
  assert.equal(src.calls.conv, reads, "no new scan");
});

test("a failed first scan becomes a visible error, not endless warming", async () => {
  const src = fakeSource();
  src.fail = true;
  const data = new QueueData(src, settings(), () => NOW);
  assert.equal(data.readySnapshot(), null);
  await data.snapshot();
  const failed = data.readySnapshot();
  assert.ok(failed?.error);
  const reads = src.calls.conv;
  data.readySnapshot();
  await data.idle();
  assert.equal(src.calls.conv, reads, "the failed scan is not retried on every request");
});

test("a failed refresh keeps the last list and says so without the raw error", async () => {
  let now = NOW;
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => now);
  await data.snapshot();
  src.fail = true;
  now += 61_000;
  data.readySnapshot();
  await data.idle();
  const stale = await data.snapshot();
  assert.deepEqual(ids(stale), ["1"]);
  assert.ok(stale.error);
  assert.doesNotMatch(stale.error, /secret detail/);
});

test("ticket states come from the ticket search: Waiting on customer drops out", async () => {
  const src = fakeSource(
    [rawConv("1"), rawConv("2")],
    [{ id: "2", created_at: NOW_SEC - 3600, ticket_state: { id: "5", category: "waiting_on_customer", internal_label: "Waiting on Customer" }, ticket_type: { id: "8", name: "Billing" } }]
  );
  const data = new QueueData(src, settings(), () => NOW);
  assert.deepEqual(ids(await data.snapshot()), ["1"]);
});

test("Fin's handoff keeps a conversation waiting with Fin replies switched on; parts are read once per version", async () => {
  const s = settings({ fin: true });
  const src = fakeSource([
    rawConv("1", { ai_agent: { resolution_state: "procedure_handoff" } }),
    rawConv("2", { ai_agent: { resolution_state: "assumed_resolution" } }),
  ]);
  const finAnswer = (at: number): IntercomWebhookPart[] => [{ part_type: "comment", body: "Fin here", created_at: at, author: { type: "bot", id: "800", from_ai_agent: true } }];
  src.parts.set("1", finAnswer(NOW_SEC - 50));
  src.parts.set("2", finAnswer(NOW_SEC - 50));
  const data = new QueueData(src, s, () => NOW);
  assert.deepEqual(ids(await data.snapshot()), ["1"], "handed off: waiting; resolved by Fin: answered");
  assert.equal(src.calls.get.length, 2);
  // A webhook for something else re-derives the list: the answered one's
  // parts are not read again (they used to be, on every derive).
  src.conversations.push(rawConv("3", { updated_at: NOW_SEC }));
  data.noteWebhook("conversation.user.created", "3");
  await data.flushWebhooks();
  assert.deepEqual(src.calls.get, ["1", "2", "3"]);
});

test("Fin counts only when switched on, checked from the parts and cached per version", async () => {
  const s = settings();
  const src = fakeSource([rawConv("1")]);
  src.parts.set("1", [{ part_type: "comment", body: "Fin here", created_at: NOW_SEC - 50, author: { type: "bot", id: "b" } }]);
  const data = new QueueData(src, s, () => NOW);
  assert.equal((await data.snapshot()).items.length, 1, "off: Fin is not a reply");
  assert.equal(src.calls.get.length, 0, "no parts fetched while both toggles are off");
  s.state.fin = true;
  assert.equal((await data.snapshot()).items.length, 0, "on: Fin answered");
  assert.equal(src.calls.get.length, 1);
});

// ---- live updates ----

test("a webhook re-reads its one conversation and wakes the waiting pages", async () => {
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => NOW);
  await data.snapshot();
  const before = data.version();
  const waiting = data.waitForChange(before, 5_000);

  // A new conversation arrives.
  src.conversations.push(rawConv("2", { updated_at: NOW_SEC }));
  data.noteWebhook("conversation.user.created", "2");
  await data.flushWebhooks();
  assert.equal(await waiting, true);
  assert.notEqual(data.version(), before);
  assert.deepEqual(ids(data.readySnapshot())?.sort(), ["1", "2"]);

  // A teammate answers 1; the burst of events for it becomes one read.
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 5, statistics: { last_contact_reply_at: NOW_SEC - 60, last_admin_reply_at: NOW_SEC + 5 } });
  data.noteWebhook("conversation.admin.replied", "1");
  data.noteWebhook("conversation.admin.assigned", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot()), ["2"]);
  assert.deepEqual(src.calls.get, ["2", "1"]);
  assert.equal(src.calls.conv, 5, "no new scan");

  data.noteWebhook("contact.created", "not-an-id");
  await data.flushWebhooks();
  assert.equal(src.calls.get.length, 2, "an id that is not a conversation id is ignored");
});

test("a customer reply whose statistics lag still brings the ticket back, and a stale search copy cannot take it away", async () => {
  // Ticket #146041426: a teammate answered, the customer wrote again a minute
  // later, and the read after the webhook still had the old statistics.
  let now = NOW;
  const answered = { last_contact_reply_at: NOW_SEC - 600, last_admin_reply_at: NOW_SEC - 120 };
  const src = fakeSource([rawConv("1", { updated_at: NOW_SEC - 120, statistics: answered })]);
  const data = new QueueData(src, settings(), () => now);
  assert.deepEqual(ids(await data.snapshot()), []);
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC - 60, statistics: answered });
  src.parts.set("1", [
    { part_type: "comment", body: "the answer", created_at: NOW_SEC - 120, author: { type: "admin", id: "11" } },
    { part_type: "comment", body: "thank you, one more thing", created_at: NOW_SEC - 60, author: { type: "user", id: "c1" } },
  ]);
  data.noteWebhook("ticket.contact.replied", "1");
  await data.flushWebhooks();
  const back = data.readySnapshot();
  assert.deepEqual(ids(back), ["1"]);
  assert.equal(back?.items[0].kind, "followup");
  assert.equal(back?.items[0].waitingSince, NOW_SEC - 60);
  // The search copy (same version, the old statistics) does not undo it.
  now += 16 * 60_000;
  data.readySnapshot();
  await data.idle();
  assert.deepEqual(ids(data.readySnapshot()), ["1"]);
});

test("every webhook read is read once more after Intercom settles", async () => {
  const src = fakeSource([rawConv("1")]);
  const data = new QueueData(src, settings(), () => NOW);
  await data.snapshot();
  // The first read after the webhook still sees the conversation before the
  // teammate's answer; the settle read sees it.
  data.noteWebhook("conversation.admin.replied", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot()), ["1"]);
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 5, statistics: { last_contact_reply_at: NOW_SEC - 60, last_admin_reply_at: NOW_SEC + 5 } });
  await data.flushSettles();
  assert.deepEqual(ids(data.readySnapshot()), []);
  assert.deepEqual(src.calls.get, ["1", "1"]);
  await data.flushSettles();
  assert.deepEqual(src.calls.get, ["1", "1"], "a settle read is not settled again");
});

test("a ticket state webhook re-reads the ticket: Waiting on customer leaves at once", async () => {
  const ticket = { id: "1", created_at: NOW_SEC - 3600, updated_at: NOW_SEC - 60, ticket_state: { id: "4", category: "in_progress" }, ticket_type: { id: "8", name: "Billing" } };
  const src = fakeSource([rawConv("1", { ticket: { id: 1, state: "in_progress" } })], [ticket]);
  const data = new QueueData(src, settings(), () => NOW);
  assert.deepEqual(ids(await data.snapshot()), ["1"]);
  src.tickets[0] = { ...ticket, updated_at: NOW_SEC, ticket_state: { id: "5", category: "waiting_on_customer" } };
  data.noteWebhook("ticket.state.updated", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot()), []);
  assert.deepEqual(src.calls.ticketGet, ["1"]);
});

test("a webhook read during a full scan is not undone by the scan's older page", async () => {
  const src = fakeSource([rawConv("1")]);
  const gate = gateScans(src);
  const data = new QueueData(src, settings(), () => NOW);
  data.readySnapshot();
  assert.equal(gate.entered(), 5);
  // Answered while the scan is in flight; its webhook read lands first.
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 10, statistics: { last_contact_reply_at: NOW_SEC - 60, last_admin_reply_at: NOW_SEC + 10 } });
  data.noteWebhook("conversation.admin.replied", "1");
  await data.flushWebhooks();
  gate.release();
  await data.idle();
  assert.deepEqual(ids(data.readySnapshot()), []);
});

test("a long-poll without a change answers false after its wait", async () => {
  const data = new QueueData(fakeSource([rawConv("1")]), settings(), () => NOW);
  await data.snapshot();
  assert.equal(await data.waitForChange(data.version(), 20), false);
  assert.equal(await data.waitForChange("00000000.0", 20), true, "an old version answers at once");
});

// ---- the saved list ----

function memoryCache(saved: QueueSaved | null): QueueCache & { writes: QueueSaved[] } {
  const writes: QueueSaved[] = [];
  return {
    writes,
    load: async () => saved,
    save: async (state) => void writes.push(state),
  };
}

test("after a restart the saved list shows at once, marked as catching up, until the boot scan lands", async () => {
  const src = fakeSource([rawConv("1")]);
  const gate = gateScans(src);
  const s = settings();
  const cache = memoryCache({ savedAt: NOW - 120_000, truncated: false, conversations: [parseConversation(rawConv("9"))!], tickets: [] });
  const data = new QueueData(src, s, () => NOW);
  data.setCache(cache);
  const before = data.version();
  data.start();
  assert.equal(await data.waitForChange(before, 5_000), true);
  const restored = data.readySnapshot();
  assert.deepEqual(ids(restored), ["9"]);
  assert.equal(restored?.restored, true);
  const views = new QueueViews(data, { intercomConfigured: () => true, queueExclusions: () => s.state.exclusions }, () => NOW);
  const page = await views.build({ adminId: "11", name: "Ada", sessionIdHash: "h" }, { page: "global", params: {}, filters: {}, cursor: null }, { waitForSnapshot: false });
  assert.ok(page?.blocks.some((b) => b.type === "notice" && /after a restart/.test(b.text)));
  await data.saveNow();
  assert.equal(cache.writes.length, 0, "nothing new to save while the restored list shows");

  gate.release();
  await data.idle();
  const live = data.readySnapshot();
  assert.deepEqual(ids(live), ["1"], "the scan replaces the saved list");
  assert.equal(live?.restored, false);
  await data.saveNow();
  assert.deepEqual(cache.writes[0]?.conversations.map((c) => c.id), ["1"]);
});

test("a saved list older than a day, or switched off, is not restored", async () => {
  const src = fakeSource([]);
  const old = memoryCache({ savedAt: NOW - 25 * 60 * 60_000, truncated: false, conversations: [parseConversation(rawConv("9"))!], tickets: [] });
  const data = new QueueData(src, settings(), () => NOW);
  data.setCache(old);
  data.start();
  await data.idle();
  assert.deepEqual(ids(data.readySnapshot()), []);

  const off = settings();
  off.state.enabled = false;
  const idle = new QueueData(src, off, () => NOW);
  idle.setCache(memoryCache(null));
  const reads = src.calls.conv;
  idle.start();
  idle.noteWebhook("conversation.user.created", "5");
  await idle.flushWebhooks();
  assert.equal(src.calls.conv, reads, "off: no scan at boot");
  assert.equal(src.calls.get.length, 0, "off: webhooks are ignored");
});

test("restoreSaved keeps well-formed entries and drops the rest", () => {
  const good = parseConversation(rawConv("1"))!;
  const restored = restoreSaved(
    {
      v: 1,
      truncated: true,
      conversations: [good, { ...good, id: 7 }, { ...good, tagIds: "x" }, { ...good, slaStatus: "nope" }, null],
      tickets: [
        { ticket: { id: "1", stateId: null, stateCategory: "submitted", stateLabel: null, typeId: "8", typeName: "Billing" }, updatedAt: 5 },
        { ticket: { id: "3", number: "146041426", stateId: null, stateCategory: "submitted", stateLabel: null, typeId: "8", typeName: "Billing" }, updatedAt: 5 },
        { ticket: { id: "4", number: 146041426, stateId: null, stateCategory: "submitted", stateLabel: null, typeId: "8", typeName: "Billing" }, updatedAt: 5 },
        { ticket: { id: "2", stateId: 3 }, updatedAt: 5 },
      ],
    },
    NOW
  );
  assert.deepEqual(restored?.conversations, [good]);
  assert.deepEqual(restored?.tickets.map((t) => t.ticket.id), ["1", "3"], "a list saved before ticket numbers still restores");
  assert.equal(restored?.tickets[0].ticket.number, null);
  assert.equal(restored?.tickets[1].ticket.number, "146041426");
  const { finHandedOff: _dropped, ...older } = good;
  assert.equal(restoreSaved({ v: 1, conversations: [older], tickets: [] }, NOW)?.conversations[0].finHandedOff, false);
  assert.equal(restored?.truncated, true);
  assert.equal(restored?.savedAt, NOW);
  assert.equal(restoreSaved({ v: 2, conversations: [], tickets: [] }, NOW), null, "another format");
  assert.equal(restoreSaved("garbage", NOW), null);
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

test("rows show the Intercom ticket number, and the search box finds a ticket by it", async () => {
  const src = fakeSource(
    [rawConv("1", { ticket: { type: "ticket", id: 1, state: "in_progress" } }), rawConv("2")],
    [{ id: "1", ticket_id: "146041426", created_at: NOW_SEC - 3600, ticket_state: { id: "4", category: "in_progress", internal_label: "Customer Responded" }, ticket_type: { id: "8", name: "Bug Report" } }]
  );
  const { v } = views(src);
  const table = async (filters: Record<string, string>) =>
    (await v.build(actor, { page: "global", params: {}, filters, cursor: null }))!.blocks.find((b) => b.type === "table") as QueueTableBlock;
  const all = await table({});
  const row = all.rows.find((r) => r.id === "1")!;
  assert.match((row.cells[0] as { sub?: string }).sub ?? "", /^#146041426 · Body 1$/);
  assert.equal(all.filters?.[0].kind, "search");
  const found = await table({ q: "#146041426" });
  assert.deepEqual(found.rows.map((r) => r.id), ["1"]);
  assert.equal(found.filters?.[0].value, "#146041426");
  assert.deepEqual((await table({ q: "Customer 2" })).rows.map((r) => r.id), ["2"]);
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

// ---- marked resolved ----

function fakeResolutions(initial: QueueResolution[] = []): QueueResolutions & { rows: Map<string, QueueResolution>; removed: string[][]; failPut: boolean } {
  const store = {
    rows: new Map(initial.map((r) => [r.conversationId, r] as const)),
    removed: [] as string[][],
    failPut: false,
    async list() {
      return [...store.rows.values()];
    },
    async put(r: QueueResolution) {
      if (store.failPut) throw new Error("db down");
      store.rows.set(r.conversationId, r);
    },
    async remove(ids: string[]) {
      store.removed.push(ids);
      for (const id of ids) store.rows.delete(id);
    },
  };
  return store;
}

function mark(id: string, over: Partial<QueueResolution> = {}): QueueResolution {
  return {
    conversationId: id,
    untilReply: false,
    lastContactAt: NOW_SEC - 60,
    note: null,
    title: `Subject ${id}`,
    ticketNumber: null,
    customer: `Customer ${id}`,
    resolvedById: "11",
    resolvedByName: "Ada",
    resolvedAt: NOW - 1000,
    ...over,
  };
}

const ada = { adminId: "11", name: "Ada" };

test("Resolve hides a ticket for everyone; an until-reply mark ends with the customer's next message", async () => {
  const src = fakeSource([rawConv("1"), rawConv("2")]);
  const store = fakeResolutions();
  const data = new QueueData(src, settings(), () => NOW);
  data.setResolutions(store);
  const item = (await data.snapshot()).items.find((i) => i.id === "1")!;
  await data.resolve(ada, item, { untilReply: true, note: "handled in Discord" });
  assert.deepEqual(ids(data.readySnapshot()), ["2"]);
  assert.equal(store.rows.get("1")?.note, "handled in Discord");
  assert.equal(store.rows.get("1")?.lastContactAt, NOW_SEC - 60);
  assert.deepEqual((await data.resolvedList()).map((r) => r.conversationId), ["1"]);

  // Other activity (an assignment) does not bring it back...
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 5, admin_assignee_id: 11 });
  data.noteWebhook("conversation.admin.assigned", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot()), ["2"]);
  // ...the customer's next message does, and the mark is gone.
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 10, statistics: { last_contact_reply_at: NOW_SEC + 10, last_admin_reply_at: null } });
  data.noteWebhook("conversation.user.replied", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot())?.sort(), ["1", "2"]);
  assert.deepEqual(await data.resolvedList(), []);
  assert.deepEqual(store.removed, [["1"]]);
});

test("a never mark stays through new customer messages until it is restored", async () => {
  const src = fakeSource([rawConv("1")]);
  const store = fakeResolutions();
  const data = new QueueData(src, settings(), () => NOW);
  data.setResolutions(store);
  await data.resolve(ada, (await data.snapshot()).items[0], { untilReply: false, note: null });
  src.conversations[0] = rawConv("1", { updated_at: NOW_SEC + 10, statistics: { last_contact_reply_at: NOW_SEC + 10, last_admin_reply_at: null } });
  data.noteWebhook("conversation.user.replied", "1");
  await data.flushWebhooks();
  assert.deepEqual(ids(data.readySnapshot()), []);
  const before = data.version();
  assert.equal(await data.unresolve("1"), true);
  assert.notEqual(data.version(), before, "open pages redraw");
  assert.deepEqual(ids(data.readySnapshot()), ["1"]);
  assert.equal(store.rows.size, 0);
  assert.equal(await data.unresolve("1"), false, "already restored");
});

test("marks are loaded before the first list, a failed write changes nothing, and an until-reply mark ends when the conversation closes", async () => {
  const src = fakeSource([rawConv("1"), rawConv("2"), rawConv("3")]);
  const store = fakeResolutions([mark("1"), mark("2", { untilReply: true })]);
  const data = new QueueData(src, settings(), () => NOW);
  data.setResolutions(store);
  assert.deepEqual(ids(await data.snapshot()), ["3"], "a restart never shows a resolved ticket");

  store.failPut = true;
  const three = data.readySnapshot()!.items[0];
  await assert.rejects(data.resolve(ada, three, { untilReply: true, note: null }), /db down/);
  assert.deepEqual(ids(data.readySnapshot()), ["3"]);
  assert.equal((await data.resolvedList()).length, 2);

  src.conversations[1] = rawConv("2", { state: "closed", updated_at: NOW_SEC + 10 });
  data.noteWebhook("conversation.admin.closed", "2");
  await data.flushWebhooks();
  assert.deepEqual((await data.resolvedList()).map((r) => r.conversationId), ["1"], "a never mark stays");
});

test("rows and cards carry the Resolve dialog; resolve and restore through the actions are validated", async () => {
  const src = fakeSource([rawConv("1"), rawConv("2", { waiting_since: NOW_SEC - 900 })]);
  const { data, v } = views(src);
  data.setResolutions(fakeResolutions());
  const global = async () => (await v.build(actor, { page: "global", params: {}, filters: {}, cursor: null }))!;
  const table = (await global()).blocks.find((b) => b.type === "table") as QueueTableBlock;
  const resolve = table.rows[0].actions?.[0];
  assert.equal(resolve?.key, "section:queue.resolve");
  assert.equal(resolve?.label, "Resolve");
  assert.deepEqual(resolve?.params, { conversationId: table.rows[0].id });
  const comesBack = resolve?.inputs?.find((i) => i.key === "comesBack");
  assert.equal(comesBack?.type === "select" && comesBack.value, "reply", "comes back is preselected");
  assert.ok(resolve?.inputs?.some((i) => i.key === "note"));
  const card = (await v.build(actor, { page: "global", params: {}, filters: { view: "longest" }, cursor: null }))!.blocks.find((b) => b.type === "kv") as QueueKvBlock;
  assert.ok(card.actions?.some((a) => a.key === "section:queue.resolve"));

  const act = (params: Record<string, unknown>) => v.action(actor, "section:queue.resolve", params);
  assert.equal((await act({ conversationId: "x", comesBack: "reply" })).ok, false);
  assert.equal((await act({ conversationId: "1" })).error, "Pick whether it comes back.");
  assert.equal((await act({ conversationId: "1", comesBack: "reply", note: "n".repeat(301) })).ok, false);
  assert.equal((await act({ conversationId: "99", comesBack: "reply" })).error, "This ticket no longer waits on a reply.");
  const done = await act({ conversationId: "1", comesBack: "never", note: "  tracked\nas a bug  " });
  assert.equal(done.ok, true);
  assert.match(done.text ?? "", /until someone restores it/);
  const after = (await global()).blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.deepEqual(after.rows.map((r) => r.id), ["2"]);

  const resolved = await v.build(actor, { page: "resolved", params: {}, filters: {}, cursor: null });
  assert.equal(resolved?.activeNav, "resolved");
  assert.ok(resolved?.nav.some((n) => n.key === "resolved"));
  const list = resolved!.blocks.find((b) => b.type === "table") as QueueTableBlock;
  assert.deepEqual(list.rows.map((r) => r.id), ["1"]);
  assert.equal((list.rows[0].cells[2] as { v: string }).v, "Ada");
  assert.deepEqual((list.rows[0].cells[4] as { b: { text: string } }).b.text, "Never");
  assert.equal((list.rows[0].cells[5] as { v: string }).v, "tracked as a bug", "one line, trimmed");
  assert.equal(list.rows[0].actions?.[0].key, "section:queue.restore");

  assert.equal((await v.action(actor, "section:queue.restore", { conversationId: "1" })).ok, true);
  assert.equal((await v.action(actor, "section:queue.restore", { conversationId: "1" })).ok, false);
  assert.deepEqual(((await global()).blocks.find((b) => b.type === "table") as QueueTableBlock).rows.map((r) => r.id).sort(), ["1", "2"]);
});

test("the Resolved page: newest first, searchable, 25 to a page", async () => {
  const marks = Array.from({ length: 30 }, (_, k) => mark(String(100 + k), { resolvedAt: NOW - k * 1000, ticketNumber: String(500 + k), note: k === 7 ? "duplicate of 146041426" : null }));
  const { data, v } = views(fakeSource([]));
  data.setResolutions(fakeResolutions(marks));
  const page = async (filters: Record<string, string>, cursor: string | null = null) =>
    (await v.build(actor, { page: "resolved", params: {}, filters, cursor }))!.blocks.find((b) => b.type === "table") as QueueTableBlock;
  const first = await page({});
  assert.equal(first.rows.length, 25);
  assert.equal(first.rows[0].id, "100", "newest first");
  assert.equal(first.nextCursor, "25");
  assert.equal((await page({}, "25")).rows.length, 5);
  assert.deepEqual((await page({ q: "#512" })).rows.map((r) => r.id), ["112"]);
  assert.deepEqual((await page({ q: "duplicate" })).rows.map((r) => r.id), ["107"]);
});
