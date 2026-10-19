import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ClassifyOptions,
  QueueConversation,
  QueueItem,
  QueueTicketInfo,
  applyFilters,
  classify,
  extraReplyAfter,
  inScope,
  matchesQuery,
  mergeReplyTimes,
  parseConversation,
  parseFilters,
  parseScopeKey,
  parseTicket,
  plainText,
  resolveTicket,
  waitLabel,
  weightedPick,
  withParts,
} from "../queueModel";
import type { IntercomWebhookPart } from "../../intercom/types";

// The queue's one question: does this conversation wait on a reply from a
// person on the team? Plus the parsing of Intercom's search shapes, the
// scopes and the randomizer. Fixtures are synthetic.

const NO_OPTS: ClassifyOptions = {
  excludedTeamIds: new Set(),
  excludedTagIds: new Set(),
  excludedTicketTypeIds: new Set(),
  excludedTicketTypeNames: new Set(),
  botAdminIds: new Set(["900"]),
};

function rawConv(over: Record<string, unknown> = {}, stats: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "conversation",
    id: "1001",
    created_at: 1_000_000,
    updated_at: 1_000_500,
    waiting_since: null,
    snoozed_until: null,
    state: "open",
    open: true,
    priority: "not_priority",
    title: "",
    source: {
      subject: "<p>Can&#39;t connect &amp; post</p>",
      body: "<div>Hello,<br>my channel <b>disconnects</b>&nbsp;daily.</div>",
      author: { type: "user", id: "c1", name: "Robin Example", email: "robin@example.test" },
    },
    admin_assignee_id: 11,
    team_assignee_id: 22,
    tags: { type: "tag.list", tags: [{ type: "tag", id: "t1", name: "x" }] },
    statistics: { last_contact_reply_at: 1_000_000, last_admin_reply_at: null, ...stats },
    custom_attributes: { "SLA Status": "at_risk", "SLA Target": "Default" },
    ...over,
  };
}

function conv(over: Record<string, unknown> = {}, stats: Record<string, unknown> = {}): QueueConversation {
  const c = parseConversation(rawConv(over, stats));
  assert.ok(c);
  return c;
}

test("parseConversation reads the projection the queue needs and strips HTML", () => {
  const c = conv();
  assert.equal(c.id, "1001");
  assert.equal(c.title, "Can't connect & post");
  assert.equal(c.excerpt, "Hello, my channel disconnects daily.");
  assert.equal(c.customerName, "Robin Example");
  assert.equal(c.customerEmail, "robin@example.test");
  assert.equal(c.teamId, "22");
  assert.equal(c.adminAssigneeId, "11");
  assert.deepEqual(c.tagIds, ["t1"]);
  assert.equal(c.slaStatus, "at_risk");
  assert.equal(c.slaTarget, "Default");
  assert.equal(c.lastContactReplyAt, 1_000_000);
  assert.equal(c.lastAdminReplyAt, null);
  assert.equal(c.finHandedOff, false);
});

test("parseConversation reads Fin's handoff and the inline ticket number", () => {
  for (const state of ["escalated", "procedure_handoff", "routed_to_team"]) {
    assert.equal(conv({ ai_agent: { resolution_state: state } }).finHandedOff, true, state);
  }
  assert.equal(conv({ ai_agent: { resolution_state: "assumed_resolution" } }).finHandedOff, false);
  assert.equal(conv({ ai_agent: null }).finHandedOff, false);
  const c = conv({ ticket: { type: "ticket", id: "T1", ticket_id: "146041426", state: "in_progress" } });
  assert.equal(c.ticketInline?.number, "146041426");
});

test("parseConversation treats 0 assignees as nobody and rejects junk", () => {
  const c = conv({ admin_assignee_id: 0, team_assignee_id: "0" });
  assert.equal(c.adminAssigneeId, null);
  assert.equal(c.teamId, null);
  assert.equal(parseConversation(null), null);
  assert.equal(parseConversation({ id: "" }), null);
  assert.equal(parseConversation([]), null);
  // An unknown SLA value is not trusted.
  assert.equal(conv({ custom_attributes: { "SLA Status": "<script>" } }).slaStatus, null);
});

test("an admin-authored opening message hides the customer identity", () => {
  const c = conv({ source: { subject: "Hi", body: "Outbound", author: { type: "admin", id: "5", name: "Staff", email: "s@x.test" } } });
  assert.equal(c.customerName, null);
  assert.equal(c.customerEmail, null);
});

test("customer spoke and nobody answered: a first reply, waiting since the start", () => {
  const item = classify(conv(), null, NO_OPTS);
  assert.ok(item);
  assert.equal(item.kind, "first");
  assert.equal(item.waitingSince, 1_000_000);
  assert.equal(item.assigneeId, "11");
});

test("customer wrote again after a teammate: a follow-up, waiting since waiting_since", () => {
  const item = classify(conv({ waiting_since: 1_000_200 }, { last_admin_reply_at: 1_000_100, last_contact_reply_at: 1_000_300 }), null, NO_OPTS);
  assert.ok(item);
  assert.equal(item.kind, "followup");
  assert.equal(item.waitingSince, 1_000_200);
});

test("without waiting_since a follow-up waits since the newest customer message", () => {
  const item = classify(conv({}, { last_admin_reply_at: 1_000_100, last_contact_reply_at: 1_000_300 }), null, NO_OPTS);
  assert.equal(item?.waitingSince, 1_000_300);
});

test("a teammate spoke last: not waiting on us", () => {
  assert.equal(classify(conv({}, { last_admin_reply_at: 1_000_400, last_contact_reply_at: 1_000_300 }), null, NO_OPTS), null);
  // A reply in the same second still counts as answered.
  assert.equal(classify(conv({}, { last_admin_reply_at: 1_000_300, last_contact_reply_at: 1_000_300 }), null, NO_OPTS), null);
});

test("an outbound conversation the customer never answered waits on nobody", () => {
  const c = conv({ source: { subject: "", body: "Hi from us", author: { type: "admin", id: "5" } } }, { last_contact_reply_at: null });
  assert.equal(classify(c, null, NO_OPTS), null);
});

test("closed conversations and Waiting on customer tickets are never listed; a Resolved ticket the customer wrote into is", () => {
  assert.equal(classify(conv({ state: "closed" }), null, NO_OPTS), null);
  const ticket = (category: string): QueueTicketInfo => ({ id: "1001", number: null, stateId: "s", stateCategory: category, stateLabel: null, typeId: "tt", typeName: "Billing" });
  assert.equal(classify(conv(), ticket("waiting_on_customer"), NO_OPTS), null);
  assert.equal(classify(conv({}, { last_admin_reply_at: 1_000_100, last_contact_reply_at: 1_000_300 }), ticket("resolved"), NO_OPTS)?.kind, "followup");
  assert.equal(classify(conv({}, { last_admin_reply_at: 1_000_400, last_contact_reply_at: 1_000_300 }), ticket("resolved"), NO_OPTS), null);
  // Submitted and In progress (custom "Customer responded" included) stay.
  assert.ok(classify(conv(), ticket("submitted"), NO_OPTS));
  assert.ok(classify(conv(), { ...ticket("in_progress"), stateLabel: "Customer responded" }, NO_OPTS));
});

test("snoozed conversations are kept but flagged (the page hides them by default)", () => {
  const item = classify(conv({ state: "snoozed", snoozed_until: 2_000_000 }), null, NO_OPTS);
  assert.equal(item?.snoozed, true);
  assert.equal(item?.snoozedUntil, 2_000_000);
});

test("exclusions: team, tag, ticket type by id and by name", () => {
  assert.equal(classify(conv(), null, { ...NO_OPTS, excludedTeamIds: new Set(["22"]) }), null);
  assert.equal(classify(conv(), null, { ...NO_OPTS, excludedTagIds: new Set(["t1"]) }), null);
  const typed: QueueTicketInfo = { id: "1001", number: null, stateId: null, stateCategory: "in_progress", stateLabel: null, typeId: "tt", typeName: "Billing" };
  assert.equal(classify(conv(), typed, { ...NO_OPTS, excludedTicketTypeIds: new Set(["tt"]) }), null);
  const nameOnly = { ...typed, typeId: null };
  assert.equal(classify(conv(), nameOnly, { ...NO_OPTS, excludedTicketTypeNames: new Set(["billing"]) }), null);
  assert.ok(classify(conv(), typed, { ...NO_OPTS, excludedTicketTypeNames: new Set(["billing"]) }), "the id wins when there is one");
});

test("an assignment to Operator/Fin or the bridge admin is no person", () => {
  const item = classify(conv({ admin_assignee_id: 900 }), null, NO_OPTS);
  assert.equal(item?.assigneeId, null);
});

test("resolveTicket: the ticket search first, the inline copy next, the conversation id last", () => {
  const searched: QueueTicketInfo = { id: "T1", number: "146041426", stateId: "9", stateCategory: "in_progress", stateLabel: "Customer responded", typeId: "tt", typeName: "Billing" };
  const tickets = new Map([["T1", searched]]);
  const withInline = conv({ ticket: { type: "ticket", id: "T1", state: "submitted", ticket_type: "Billing" } });
  assert.equal(resolveTicket(withInline, tickets), searched);
  const unknownInline = conv({ ticket: { type: "ticket", id: "T2", state: "waiting_on_customer", ticket_custom_state_admin_label: "Waiting on Customer" } });
  assert.equal(resolveTicket(unknownInline, tickets)?.stateCategory, "waiting_on_customer");
  assert.equal(resolveTicket(unknownInline, tickets)?.stateLabel, "Waiting on Customer");
  const noTicket = conv();
  assert.equal(resolveTicket(noTicket, new Map([["1001", searched]])), searched);
  assert.equal(resolveTicket(noTicket, new Map()), null);
});

test("parseTicket reads the state object, the type and the ticket number", () => {
  const t = parseTicket({ id: 77, ticket_id: "146041426", ticket_state: { id: 4, category: "in_progress", internal_label: "Customer responded" }, ticket_type: { id: 8, name: "Bug" } });
  assert.deepEqual(t, { id: "77", number: "146041426", stateId: "4", stateCategory: "in_progress", stateLabel: "Customer responded", typeId: "8", typeName: "Bug" });
  assert.equal(parseTicket({ id: 78 })?.number, null);
  assert.equal(parseTicket({}), null);
});

test("extraReplyAfter: Fin and notes count only when switched on, and only after the customer", () => {
  const parts: IntercomWebhookPart[] = [
    { part_type: "comment", body: "help", created_at: 100, author: { type: "user", id: "c1" } },
    { part_type: "comment", body: "Fin answer", created_at: 110, author: { type: "bot", id: "b1" } },
    { part_type: "note", body: "looking", created_at: 120, author: { type: "admin", id: "11" } },
  ];
  const ids = { finAdminIds: new Set(["800"]), botAdminIds: new Set(["800", "900"]) };
  assert.equal(extraReplyAfter(parts, 100, { fin: false, notes: false, ...ids }), false);
  assert.equal(extraReplyAfter(parts, 100, { fin: true, notes: false, ...ids }), true);
  assert.equal(extraReplyAfter(parts, 100, { fin: false, notes: true, ...ids }), true);
  // Both happened before the customer's latest message: no reply.
  assert.equal(extraReplyAfter(parts, 130, { fin: true, notes: true, ...ids }), false);
  // Operator as an admin id counts as Fin.
  const operator: IntercomWebhookPart[] = [{ part_type: "comment", body: "auto", created_at: 150, author: { type: "admin", id: "800" } }];
  assert.equal(extraReplyAfter(operator, 100, { fin: true, notes: false, ...ids }), true);
});

test("after Fin hands the conversation to the team its own answers stop counting; the bridge's relays still count", () => {
  const ids = { finAdminIds: new Set(["800"]), botAdminIds: new Set(["800", "900"]) };
  const handoff: IntercomWebhookPart[] = [
    { part_type: "comment", body: "refund please", created_at: 100, author: { type: "user", id: "c1" } },
    { part_type: "comment", body: "I'll pass this to the team", created_at: 110, author: { type: "bot", id: "800", from_ai_agent: true } },
  ];
  assert.equal(extraReplyAfter(handoff, 100, { fin: true, notes: false, ...ids }), true, "Fin resolved it");
  assert.equal(extraReplyAfter(handoff, 100, { fin: true, notes: false, ...ids, finHandedOff: true }), false, "Fin handed it off");
  const relay: IntercomWebhookPart[] = [
    { part_type: "comment", body: "refund please", created_at: 100, author: { type: "user", id: "c1" } },
    { part_type: "comment", body: "<b>Ada:</b> done", created_at: 120, author: { type: "bot", id: "800", from_ai_agent: false } },
  ];
  assert.equal(extraReplyAfter(relay, 100, { fin: true, notes: false, ...ids, finHandedOff: true }), true, "a staff reply relayed from Discord");
});

test("withParts: the parts win over statistics that lag the customer's new message", () => {
  // A teammate answered at 1_000_100; the customer wrote again at 1_000_300,
  // but the statistics read right after still name the opening message.
  const stale = conv({ waiting_since: null }, { last_contact_reply_at: 1_000_000, last_admin_reply_at: 1_000_100 });
  assert.equal(classify(stale, null, NO_OPTS), null);
  const parts: IntercomWebhookPart[] = [
    { part_type: "comment", body: "answer", created_at: 1_000_100, author: { type: "admin", id: "11" } },
    { part_type: "note", body: "internal", created_at: 1_000_150, author: { type: "admin", id: "11" } },
    { part_type: "comment", body: "thanks, one more thing", created_at: 1_000_300, author: { type: "user", id: "c1" } },
    { part_type: "comment", body: "and another", created_at: 1_000_400, author: { type: "user", id: "c1" } },
  ];
  const fresh = withParts(stale, parts);
  assert.equal(fresh.lastContactReplyAt, 1_000_400);
  assert.equal(fresh.lastAdminReplyAt, 1_000_100, "a note is no reply");
  assert.equal(fresh.waitingSince, 1_000_300, "waiting since the first message after our reply");
  const item = classify(fresh, null, NO_OPTS);
  assert.equal(item?.kind, "followup");
  assert.equal(item?.waitingSince, 1_000_300);
  // Never answered: waiting since the opening message, which is the source.
  const first = withParts(conv({ waiting_since: null }, { last_contact_reply_at: null }), [
    { part_type: "comment", body: "hello?", created_at: 1_000_200, author: { type: "user", id: "c1" } },
  ]);
  assert.equal(first.waitingSince, 1_000_000);
  // Newer statistics are kept.
  assert.equal(withParts(conv({}, { last_contact_reply_at: 1_000_900 }), parts).lastContactReplyAt, 1_000_900);
});

test("mergeReplyTimes: a later read never moves a reply time backwards", () => {
  const fresh = conv({ updated_at: 1_000_400, waiting_since: 1_000_300 }, { last_contact_reply_at: 1_000_300, last_admin_reply_at: 1_000_100 });
  const staleSearch = conv({ updated_at: 1_000_400, waiting_since: null, priority: "priority" }, { last_contact_reply_at: 1_000_000, last_admin_reply_at: 1_000_100 });
  const merged = mergeReplyTimes(fresh, staleSearch);
  assert.equal(merged.priority, true, "other fields come from the later read");
  assert.equal(merged.lastContactReplyAt, 1_000_300);
  assert.equal(merged.waitingSince, 1_000_300);
  assert.equal(classify(merged, null, NO_OPTS)?.kind, "followup");
  // A teammate's answer moves it out, whichever read carries it.
  const answered = conv({ updated_at: 1_000_500 }, { last_contact_reply_at: 1_000_000, last_admin_reply_at: 1_000_500 });
  assert.equal(classify(mergeReplyTimes(merged, answered), null, NO_OPTS), null);
});

test("the bot's own notes never count as a reply", () => {
  const parts: IntercomWebhookPart[] = [
    { part_type: "comment", body: "help", created_at: 100, author: { type: "user", id: "c1" } },
    { part_type: "note", body: "SLA breached", created_at: 120, author: { type: "admin", id: "900" } },
    { part_type: "note", body: "gone", created_at: 121, author: { type: "admin", id: "11" }, redacted: true },
  ];
  assert.equal(extraReplyAfter(parts, 100, { fin: false, notes: true, finAdminIds: new Set(), botAdminIds: new Set(["900"]) }), false);
});

test("scope keys are validated strictly", () => {
  assert.deepEqual(parseScopeKey("global"), { kind: "global" });
  assert.deepEqual(parseScopeKey("inbox:123"), { kind: "inbox", id: "123" });
  assert.deepEqual(parseScopeKey("inbox:unassigned"), { kind: "inbox", id: "unassigned" });
  assert.deepEqual(parseScopeKey("person:none"), { kind: "person", id: "none" });
  for (const bad of ["inbox:abc", "person:1:2", "inbox:", "admin", "", 5, null, "person:../x"]) {
    assert.equal(parseScopeKey(bad), null, String(bad));
  }
});

function item(over: Partial<QueueItem>): QueueItem {
  return {
    id: "x",
    title: "t",
    excerpt: "",
    customerName: null,
    customerEmail: null,
    snoozed: false,
    snoozedUntil: null,
    priority: false,
    teamId: null,
    assigneeId: null,
    tagIds: [],
    ticket: null,
    kind: "first",
    waitingSince: 0,
    lastContactAt: 0,
    updatedAt: 0,
    slaStatus: null,
    slaTarget: null,
    ...over,
  };
}

test("inScope: mine, inboxes (Unassigned included) and people (no person included)", () => {
  const a = item({ id: "a", teamId: "22", assigneeId: "11" });
  const b = item({ id: "b", teamId: null, assigneeId: null });
  assert.equal(inScope(a, { kind: "mine" }, "11"), true);
  assert.equal(inScope(b, { kind: "mine" }, "11"), false);
  assert.equal(inScope(a, { kind: "inbox", id: "22" }, "11"), true);
  assert.equal(inScope(b, { kind: "inbox", id: "unassigned" }, "11"), true);
  assert.equal(inScope(b, { kind: "person", id: "none" }, "11"), true);
  assert.equal(inScope(a, { kind: "person", id: "12" }, "11"), false);
});

test("filters: snoozed hidden by default, kind, priority and SLA", () => {
  const items = [
    item({ id: "1", kind: "first", priority: true, slaStatus: "breached" }),
    item({ id: "2", kind: "followup" }),
    item({ id: "3", snoozed: true }),
  ];
  assert.deepEqual(applyFilters(items, parseFilters({})).map((i) => i.id), ["1", "2"]);
  assert.deepEqual(applyFilters(items, parseFilters({ snoozed: "include" })).map((i) => i.id), ["1", "2", "3"]);
  assert.deepEqual(applyFilters(items, parseFilters({ kind: "followup" })).map((i) => i.id), ["2"]);
  assert.deepEqual(applyFilters(items, parseFilters({ priority: "only" })).map((i) => i.id), ["1"]);
  assert.deepEqual(applyFilters(items, parseFilters({ sla: "none" })).map((i) => i.id), ["2"]);
  // Junk values are ignored rather than trusted.
  assert.deepEqual(parseFilters({ kind: "evil", sla: "x" }), { kind: null, priorityOnly: false, sla: null, includeSnoozed: false, query: null });
  assert.equal(parseFilters({ q: "   " }).query, null);
  assert.equal(parseFilters({ q: "x".repeat(100) }).query?.length, 64);
});

test("search: the ticket number with or without #, the conversation id, the customer and the text", () => {
  const ticket: QueueTicketInfo = { id: "215476423871073", number: "146041426", stateId: null, stateCategory: "in_progress", stateLabel: null, typeId: null, typeName: "Bug Report" };
  const grant = item({ id: "215476423871073", title: "FarmerGrant · Report a Bug", excerpt: "TikTok reconnect blocked", customerName: "FarmerGrant", ticket });
  const other = item({ id: "215476452646387", title: "Refund", customerEmail: "victor@example.test" });
  const search = (q: string) => applyFilters([grant, other], parseFilters({ q })).map((i) => i.id);
  assert.deepEqual(search("146041426"), ["215476423871073"]);
  assert.deepEqual(search("#146041426"), ["215476423871073"]);
  assert.deepEqual(search("215476452646387"), ["215476452646387"]);
  assert.deepEqual(search("farmergrant"), ["215476423871073"]);
  assert.deepEqual(search("VICTOR@"), ["215476452646387"]);
  assert.deepEqual(search("tiktok"), ["215476423871073"]);
  assert.deepEqual(search("nothing like it"), []);
  assert.equal(matchesQuery(grant, ""), true);
});

test("weightedPick favors the longest waiting and is driven by the injected rng", () => {
  const pool = [item({ id: "old", waitingSince: 0 }), item({ id: "new", waitingSince: 9_000 })];
  // weights: old 10,000s, new 1,000s (now 10,000) → old owns [0, 0.909).
  assert.equal(weightedPick(pool, 10_000, () => 0.5)?.id, "old");
  assert.equal(weightedPick(pool, 10_000, () => 0.95)?.id, "new");
  assert.equal(weightedPick([], 10_000, () => 0.5), null);
  // A ticket younger than a minute still has a chance.
  assert.equal(weightedPick([item({ id: "fresh", waitingSince: 10_000 })], 10_000, () => 0.99)?.id, "fresh");
});

test("waitLabel and plainText", () => {
  assert.equal(waitLabel(30), "just now");
  assert.equal(waitLabel(12 * 60), "12m");
  assert.equal(waitLabel(3 * 3600 + 12 * 60), "3h 12m");
  assert.equal(waitLabel(2 * 86400), "2d");
  assert.equal(waitLabel(2 * 86400 + 4 * 3600 + 59), "2d 4h");
  assert.equal(plainText("<p>a&lt;b&gt;</p><p>c</p>"), "a<b> c");
  assert.equal(plainText(null), "");
});
