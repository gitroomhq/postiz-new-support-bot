import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplyStateService } from "../ReplyStateService";
import { IntercomHttpError, type IntercomClient } from "../IntercomClient";
import type { IntercomStore } from "../IntercomStore";
import type { IntercomSyncService } from "../IntercomSyncService";
import type { SettingsStore } from "../../config/SettingsStore";
import type { TicketStore } from "../../bot/TicketStore";
import type { IntercomTicketState, IntercomTicketStateChange, IntercomTicketStateView, IntercomWebhookPart } from "../types";

// The customer-responded flow end to end against stubbed Intercom + storage:
// which state gets written, what gets remembered, and when nothing happens.

const OPERATOR = "op";
const CR = "cr";
const STATES: IntercomTicketState[] = [
  { id: "s1", category: "submitted", internalLabel: "Submitted", archived: false },
  { id: "p1", category: "in_progress", internalLabel: "In Progress", archived: false },
  { id: "p2", category: "in_progress", internalLabel: "Investigating", archived: false },
  { id: CR, category: "in_progress", internalLabel: "Customer responded", archived: false },
  { id: "w1", category: "waiting_on_customer", internalLabel: "Waiting on customer", archived: false },
  { id: "r1", category: "resolved", internalLabel: "Resolved", archived: false },
];
const byId = (id: string) => STATES.find((s) => s.id === id)!;

interface Row {
  ticketId: string;
  conversationId: string;
  threadId: string | null;
  baseStateId: string | null;
  baseCategory: string | null;
  baseTagId: string | null;
  enteredAt: Date;
}

const TAGS = [
  { id: "t-open", emoji: "🟢", label: "Open", closesThread: false, reminderTarget: "SUPPORT", intercomTicketStateId: "s1" },
  { id: "t-ongoing", emoji: "🟡", label: "Ongoing", closesThread: false, reminderTarget: "SUPPORT", intercomTicketStateId: "p2" },
  { id: "t-woc", emoji: "🟠", label: "Waiting for Customer", closesThread: false, reminderTarget: "CUSTOMER", intercomTicketStateId: "w1" },
  { id: "t-wfd", emoji: "🔵", label: "Waiting for Developer", closesThread: false, reminderTarget: "SUPPORT", intercomTicketStateId: "p1" },
  { id: "t-closed", emoji: "📁", label: "Closed", closesThread: true, reminderTarget: "SUPPORT", intercomTicketStateId: "r1" },
];

function makeHarness(opts: {
  stateId: string;
  convState?: string;
  changes?: IntercomTicketStateChange[];
  parts?: IntercomWebhookPart[];
  typeStates?: IntercomTicketState[] | null;
  typeCategory?: string;
  row?: Partial<Row> | null;
  link?: { lastSyncedStateId?: string | null; lastSyncedOpen?: string | null } | null;
  ticket?: { closed?: boolean; statusTagId?: string } | null;
  rejectWrite?: boolean;
}) {
  const writes: string[] = [];
  const ops: string[] = [];
  let row: Row | null = opts.row
    ? {
        ticketId: "T",
        conversationId: "T",
        threadId: null,
        baseStateId: null,
        baseCategory: null,
        baseTagId: null,
        enteredAt: new Date(),
        ...opts.row,
      }
    : null;
  const view = (): IntercomTicketStateView => ({
    id: "T",
    open: true,
    stateId: opts.stateId,
    stateCategory: byId(opts.stateId).category ?? null,
    typeCategory: opts.typeCategory ?? "Customer",
    typeStates: opts.typeStates === undefined ? STATES : opts.typeStates,
    stateChanges: opts.changes ?? [],
  });
  const client = {
    async getConversationReplyView() {
      return { ticketId: "T", state: opts.convState ?? "open", parts: opts.parts ?? [] };
    },
    async getTicketStateView() {
      return view();
    },
    async updateTicket(_id: string, input: { stateId?: string }) {
      if (opts.rejectWrite) throw new IntercomHttpError(400, "Intercom ticket update 400: state not allowed for this ticket type");
      writes.push(input.stateId ?? "?");
    },
    async listTicketStates() {
      return STATES;
    },
  } as unknown as IntercomClient;
  const store = {
    async getReplyState() {
      return row;
    },
    async getReplyStateByThread() {
      return row;
    },
    async upsertReplyState(r: Omit<Row, "enteredAt">) {
      row = { ...r, enteredAt: new Date() };
      ops.push(`upsert:${r.baseCategory}:${r.baseStateId}:${r.baseTagId}`);
    },
    async deleteReplyState() {
      row = null;
      ops.push("delete");
    },
    async deleteReplyStateByThread() {
      row = null;
      ops.push("delete");
    },
    async getLink() {
      if (opts.link === null) return null;
      return {
        ticketThreadId: "th",
        conversationId: "T",
        ticketId: "T",
        lastSyncedStateId: opts.link?.lastSyncedStateId ?? null,
        lastSyncedOpen: opts.link?.lastSyncedOpen ?? "open",
      };
    },
    async setLastSyncedStateId(_t: string, id: string) {
      ops.push(`synced:${id}`);
    },
  } as unknown as IntercomStore;
  const settings = {
    replyStateActive: () => true,
    replyStateCustomerStateId: () => CR,
    intercomOperatorAdminId: () => OPERATOR,
    intercomAdminId: () => null,
    tagById: (id: string) => TAGS.find((t) => t.id === id),
    tags: () => TAGS,
    customerReplyTarget: () => TAGS.find((t) => t.id === "t-wfd"),
  } as unknown as SettingsStore;
  const ticketStore = {
    async getByThreadId() {
      if (opts.ticket === null) return null;
      return { threadId: "th", closed: opts.ticket?.closed ?? false, statusTagId: opts.ticket?.statusTagId ?? "t-wfd" };
    },
  } as unknown as TicketStore;
  const service = new ReplyStateService(client, store, settings, ticketStore, {} as IntercomSyncService, (fn) => fn(OPERATOR));
  service.setDiscordStatusRequester(async (_t, tagId, actor) => {
    ops.push(`discord:${tagId}:${actor}`);
  });
  return { service, writes, ops, row: () => row };
}

const customerPart = (at: number): IntercomWebhookPart => ({ id: "c", part_type: "comment", body: "<p>hi</p>", created_at: at, author: { id: "u", type: "user" } });
const agentPart: IntercomWebhookPart = { id: "a", part_type: "comment", body: "<p>answer</p>", created_at: 2000, author: { id: "42", type: "admin" } };
const finPart: IntercomWebhookPart = { id: "f", part_type: "comment", body: "<p>Fin</p>", created_at: 2000, author: { id: OPERATOR, type: "bot" } };
const item = (parts: IntercomWebhookPart[]) => ({ id: "T", conversation_parts: { conversation_parts: parts } });

// ---- native: customer replies ----

test("native customer reply on Waiting on customer that Intercom already moved: remembers Waiting on customer", async () => {
  const h = makeHarness({
    stateId: "p1",
    changes: [{ previous: "waiting_on_customer", current: "in_progress", createdAt: 1001, authorType: "bot", authorId: OPERATOR, appPackageCode: null }],
  });
  await h.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(h.writes, [CR]);
  assert.deepEqual(h.ops, ["upsert:waiting_on_customer:null:null"]);
});

test("native customer reply on an In progress ticket remembers that exact state", async () => {
  const h = makeHarness({ stateId: "p2" });
  await h.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(h.writes, [CR]);
  assert.deepEqual(h.ops, ["upsert:in_progress:p2:null"]);
});

test("native customer reply: already in the state, a resolved origin, a type without the state, a closed conversation do nothing", async () => {
  const already = makeHarness({ stateId: CR });
  await already.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(already.writes, []);

  const resolved = makeHarness({
    stateId: "p1",
    changes: [{ previous: "resolved", current: "in_progress", createdAt: 1001, authorType: "bot", authorId: OPERATOR, appPackageCode: null }],
  });
  await resolved.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(resolved.writes, []);
  assert.deepEqual(resolved.ops, ["delete"]);

  const lacking = makeHarness({ stateId: "p2", typeStates: STATES.filter((s) => s.id !== CR) });
  await lacking.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(lacking.writes, []);

  const closed = makeHarness({ stateId: "p2", convState: "closed" });
  await closed.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(closed.writes, []);

  const backOffice = makeHarness({ stateId: "p2", typeCategory: "Back-office" });
  await backOffice.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(backOffice.writes, []);
});

test("native customer reply: a rejected write never throws and records nothing", async () => {
  const h = makeHarness({ stateId: "p2", typeStates: null, rejectWrite: true });
  await h.service.onNativeCustomerReply("T", item([customerPart(1000)]));
  assert.deepEqual(h.ops, []);
});

// ---- native: we reply ----

test("native teammate reply restores the remembered state and drops the row", async () => {
  const h = makeHarness({ stateId: CR, row: { baseStateId: "p2", baseCategory: "in_progress" } });
  await h.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(h.writes, ["p2"]);
  assert.deepEqual(h.ops, ["delete"]);
});

test("native teammate reply: Submitted and category-only Waiting on customer both land on Waiting on customer", async () => {
  const submitted = makeHarness({ stateId: CR, row: { baseStateId: "s1", baseCategory: "submitted" } });
  await submitted.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(submitted.writes, ["w1"]);

  const woc = makeHarness({ stateId: CR, row: { baseStateId: null, baseCategory: "waiting_on_customer" } });
  await woc.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(woc.writes, ["w1"]);
});

test("native Fin reply and a reply on a ticket someone already moved change nothing", async () => {
  const fin = makeHarness({ stateId: CR, row: { baseStateId: "p2", baseCategory: "in_progress" } });
  await fin.service.onNativeAgentReply("T", item([finPart]));
  assert.deepEqual(fin.writes, []);
  assert.deepEqual(fin.ops, []);

  const moved = makeHarness({ stateId: "p1", row: { baseStateId: "p2", baseCategory: "in_progress" } });
  await moved.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(moved.writes, []);
  assert.deepEqual(moved.ops, ["delete"]);
});

test("native teammate reply without a row reads the history, else falls back to Waiting on customer", async () => {
  const fromHistory = makeHarness({
    stateId: CR,
    changes: [{ previous: "in_progress", current: "in_progress", createdAt: 1500, authorType: "admin", authorId: "42", appPackageCode: null }],
  });
  await fromHistory.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(fromHistory.writes, ["p1"]);

  const blind = makeHarness({ stateId: CR });
  await blind.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(blind.writes, ["w1"]);
});

test("native teammate reply on a snoozed conversation keeps the row for later", async () => {
  const h = makeHarness({ stateId: CR, convState: "snoozed", row: { baseStateId: "p2", baseCategory: "in_progress" } });
  await h.service.onNativeAgentReply("T", item([agentPart]));
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.ops, []);
});

test("native reply payload without a message ignores a teammate reply older than the customer's last message", async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = makeHarness({
    stateId: CR,
    row: { baseStateId: "p2", baseCategory: "in_progress" },
    parts: [{ ...agentPart, created_at: now - 120 }, customerPart(now - 60)],
  });
  await h.service.onNativeAgentReply("T", item([{ id: "z", part_type: "assignment", body: null, author: { id: "42", type: "admin" } }]));
  assert.deepEqual(h.writes, []);
});

test("native reply payload without a message falls back to the conversation parts", async () => {
  const h = makeHarness({ stateId: CR, row: { baseStateId: "p2", baseCategory: "in_progress" }, parts: [{ ...agentPart, created_at: Math.floor(Date.now() / 1000) }] });
  await h.service.onNativeAgentReply("T", item([{ id: "z", part_type: "assignment", body: null, author: { id: "42", type: "admin" } }]));
  assert.deepEqual(h.writes, ["p2"]);
});

// ---- bridged ----

test("bridged customer message: Waiting for Customer becomes Customer responded, the tag is remembered", async () => {
  const h = makeHarness({ stateId: "p1", link: { lastSyncedStateId: "p1" } });
  await h.service.executeBridged("th", { kind: "customer", baseTagId: "t-woc" });
  assert.deepEqual(h.writes, [CR]);
  assert.deepEqual(h.ops, [`synced:${CR}`, "upsert:waiting_on_customer:w1:t-woc"]);
});

test("bridged follow-up message while already in the state keeps the first base", async () => {
  const h = makeHarness({ stateId: CR, row: { threadId: "th", baseTagId: "t-woc", baseCategory: "waiting_on_customer" } });
  await h.service.executeBridged("th", { kind: "customer", baseTagId: "t-wfd" });
  assert.deepEqual(h.writes, []);
  assert.equal(h.row()?.baseTagId, "t-woc");
});

test("bridged staff reply puts Intercom and the Discord status back", async () => {
  const h = makeHarness({
    stateId: CR,
    ticket: { statusTagId: "t-wfd" },
    row: { threadId: "th", baseTagId: "t-woc", baseStateId: "w1", baseCategory: "waiting_on_customer" },
  });
  await h.service.executeBridged("th", { kind: "agent" });
  assert.deepEqual(h.writes, ["w1"]);
  assert.deepEqual(h.ops, ["synced:w1", "discord:t-woc:Agent reply", "delete"]);
});

test("bridged staff reply on a ticket that was still Open lands on Waiting for Customer", async () => {
  const h = makeHarness({
    stateId: CR,
    ticket: { statusTagId: "t-open" },
    row: { threadId: "th", baseTagId: "t-open", baseStateId: "s1", baseCategory: "submitted" },
  });
  await h.service.executeBridged("th", { kind: "agent" });
  assert.deepEqual(h.writes, ["w1"]);
  assert.deepEqual(h.ops, ["synced:w1", "discord:t-woc:Agent reply", "delete"]);
});

test("bridged staff reply on an unchanged Discord status only moves Intercom", async () => {
  const h = makeHarness({
    stateId: CR,
    ticket: { statusTagId: "t-ongoing" },
    row: { threadId: "th", baseTagId: "t-ongoing", baseStateId: "p2", baseCategory: "in_progress" },
  });
  await h.service.executeBridged("th", { kind: "agent" });
  assert.deepEqual(h.writes, ["p2"]);
  assert.deepEqual(h.ops, ["synced:p2", "delete"]);
});

test("bridged: closed tickets and closing base tags are left alone", async () => {
  const closed = makeHarness({ stateId: "p1", ticket: { closed: true } });
  await closed.service.executeBridged("th", { kind: "customer", baseTagId: "t-woc" });
  assert.deepEqual(closed.writes, []);

  const closingBase = makeHarness({ stateId: "p1" });
  await closingBase.service.executeBridged("th", { kind: "customer", baseTagId: "t-closed" });
  assert.deepEqual(closingBase.writes, []);
});

test("holdsState keeps the customer-responded state against a late reply flip only", () => {
  const h = makeHarness({ stateId: CR });
  const link = { lastSyncedStateId: CR } as never;
  const flip = { statusTagId: "t-wfd", statusLabel: "x", actorName: "Customer reply", closed: false, resolved: false };
  assert.equal(h.service.holdsState(link, flip), true);
  assert.equal(h.service.holdsState(link, { ...flip, actorName: "Intercom agent" }), false);
  assert.equal(h.service.holdsState(link, { ...flip, closed: true }), false);
  assert.equal(h.service.holdsState({ lastSyncedStateId: "p1" } as never, flip), false);
});
