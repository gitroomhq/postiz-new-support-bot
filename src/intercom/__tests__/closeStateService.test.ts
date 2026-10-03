import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseStateService } from "../CloseStateService";
import { IntercomHttpError, type IntercomClient } from "../IntercomClient";
import type { IntercomStore } from "../IntercomStore";
import type { SettingsStore } from "../../config/SettingsStore";
import type { TicketStore } from "../../bot/TicketStore";
import type { IntercomConversationItem, IntercomTicketState, IntercomTicketStateView } from "../types";

// Resolve on close end to end against stubbed Intercom + storage: which state
// gets written, when the ticket is closed again, and when nothing happens.

const STATES: IntercomTicketState[] = [
  { id: "p1", category: "in_progress", internalLabel: "In Progress", archived: false },
  { id: "w1", category: "waiting_on_customer", internalLabel: "Waiting on customer", archived: false },
  { id: "r0", category: "resolved", internalLabel: "Won't fix", archived: false },
  { id: "r1", category: "resolved", internalLabel: "Resolved", archived: false },
];

function makeHarness(opts: {
  view?: Partial<IntercomTicketStateView> | null;
  picked?: string | null;
  active?: boolean;
  link?: { lastSyncedStateId?: string | null } | null;
  discordClosed?: boolean;
  reopens?: boolean;
  rejectWrite?: boolean;
  backfilledAt?: Date | null;
  pages?: IntercomTicketStateView[][];
  ticketIdForConversation?: string | null;
}) {
  const writes: Array<{ stateId?: string; open?: boolean }> = [];
  const ops: string[] = [];
  const searches: Array<number | null> = [];
  const view = (id = "T"): IntercomTicketStateView | null =>
    opts.view === null
      ? null
      : {
          id,
          open: false,
          stateId: "p1",
          stateCategory: "in_progress",
          typeCategory: "Customer",
          typeStates: STATES,
          stateChanges: [],
          ...opts.view,
        };
  const client = {
    async getTicketStateView(id: string) {
      ops.push(`get:${id}`);
      return view(id);
    },
    async getConversationTicketId() {
      return opts.ticketIdForConversation === undefined ? "T" : opts.ticketIdForConversation;
    },
    async updateTicket(id: string, input: { stateId?: string; open?: boolean }) {
      if (opts.rejectWrite && input.stateId) {
        throw new IntercomHttpError(400, "Intercom ticket update 400: state not allowed for this ticket type");
      }
      writes.push({ stateId: input.stateId, open: input.open });
      ops.push(`put:${id}`);
      return { open: input.stateId ? opts.reopens === true : false };
    },
    async setConversationOpen(id: string, open: boolean) {
      ops.push(`conv:${id}:${open ? "open" : "close"}`);
    },
    async searchClosedUnresolvedTickets(since: number | null, cursor: string | null) {
      searches.push(since);
      const pages = opts.pages ?? [];
      const index = cursor ? Number(cursor) : 0;
      return { items: pages[index] ?? [], nextStartingAfter: index + 1 < pages.length ? String(index + 1) : null };
    },
  } as unknown as IntercomClient;
  const link =
    opts.link === undefined || opts.link === null
      ? null
      : { ticketThreadId: "th", conversationId: "C", ticketId: "T", lastSyncedStateId: opts.link.lastSyncedStateId ?? null };
  const store = {
    async getLinkByConversationId() {
      return link;
    },
    async getLinkByTicketId() {
      return link;
    },
    async setLastSyncedStateId(_t: string, id: string | null) {
      ops.push(`synced:${id}`);
    },
    async deleteReplyState(id: string) {
      ops.push(`reply-delete:${id}`);
    },
    async deleteReplyStateByThread(id: string) {
      ops.push(`reply-delete-thread:${id}`);
    },
  } as unknown as IntercomStore;
  let backfilledAt = opts.backfilledAt ?? null;
  const settings = {
    resolveOnCloseActive: () => opts.active !== false,
    resolveOnCloseStateId: () => opts.picked ?? null,
    resolveOnCloseBackfilledAt: () => backfilledAt,
    async recordResolveOnCloseBackfill() {
      backfilledAt = new Date();
      ops.push("backfill-done");
    },
  } as unknown as SettingsStore;
  const ticketStore = {
    async getByThreadId() {
      return { threadId: "th", closed: opts.discordClosed ?? true };
    },
  } as unknown as TicketStore;
  const service = new CloseStateService(client, store, settings, ticketStore, async () => STATES, (fn) => fn("op"));
  return { service, writes, ops, searches };
}

const closedItem = (ticket?: IntercomConversationItem["ticket"]): IntercomConversationItem => ({ id: "C", ticket });

// ---- the close webhook (native) ----

test("close webhook: a native ticket left In progress is resolved in one write that keeps it closed", async () => {
  const h = makeHarness({});
  await h.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
  assert.deepEqual(h.writes, [{ stateId: "r1", open: false }]);
  assert.ok(h.ops.includes("reply-delete:T"));
});

test("close webhook: the picked state is used", async () => {
  const h = makeHarness({ picked: "r0" });
  await h.service.onConversationClosed(closedItem({ id: "T", state: "waiting_on_customer" }));
  assert.deepEqual(h.writes, [{ stateId: "r0", open: false }]);
});

test("close webhook: a write that reopens the ticket closes it again", async () => {
  const h = makeHarness({ reopens: true });
  await h.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
  assert.deepEqual(h.writes, [
    { stateId: "r1", open: false },
    { stateId: undefined, open: false },
  ]);
});

test("close webhook: resolved payloads, non-tickets, bridged conversations and the feature off do nothing", async () => {
  const resolved = makeHarness({});
  await resolved.service.onConversationClosed(closedItem({ id: "T", state: "resolved" }));
  assert.deepEqual(resolved.writes, []);
  assert.deepEqual(resolved.ops, []);

  const notTicket = makeHarness({});
  await notTicket.service.onConversationClosed(closedItem(null));
  assert.deepEqual(notTicket.ops, []);

  const bridged = makeHarness({ link: {} });
  await bridged.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
  assert.deepEqual(bridged.writes, []);

  const off = makeHarness({ active: false });
  await off.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
  assert.deepEqual(off.ops, []);
});

test("close webhook: a payload without the ticket looks it up; a conversation that is no ticket stops there", async () => {
  const lookedUp = makeHarness({});
  await lookedUp.service.onConversationClosed(closedItem(undefined));
  assert.deepEqual(lookedUp.writes, [{ stateId: "r1", open: false }]);

  const none = makeHarness({ ticketIdForConversation: null });
  await none.service.onConversationClosed(closedItem(undefined));
  assert.deepEqual(none.writes, []);
});

test("close webhook: a ticket that is open again, already resolved or not a Customer ticket is left alone", async () => {
  for (const view of [
    { open: true },
    { stateId: "r0", stateCategory: "resolved" },
    { typeCategory: "Tracker" },
  ] as Partial<IntercomTicketStateView>[]) {
    const h = makeHarness({ view });
    await h.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
    assert.deepEqual(h.writes, [], JSON.stringify(view));
  }
});

test("close webhook: a write the ticket type rejects never throws", async () => {
  const h = makeHarness({ rejectWrite: true });
  await h.service.onConversationClosed(closedItem({ id: "T", state: "in_progress" }));
  assert.deepEqual(h.writes, []);
  assert.ok(!h.ops.includes("reply-delete:T"));
});

// ---- the bridged closing push ----

test("closingStateFor: a resolved mapping is kept without a ticket read", async () => {
  const h = makeHarness({});
  assert.equal(await h.service.closingStateFor("T", "r0"), "r0");
  assert.deepEqual(h.ops, []);
});

test("closingStateFor: an unmapped or non-resolved closing tag gets the target", async () => {
  const h = makeHarness({ picked: "r0" });
  assert.equal(await h.service.closingStateFor("T", null), "r0");
  assert.equal(await h.service.closingStateFor("T", "w1"), "r0");
});

test("closingStateFor: off, or a failed read, keeps the mapping", async () => {
  const off = makeHarness({ active: false });
  assert.equal(await off.service.closingStateFor("T", "w1"), "w1");

  const h = makeHarness({});
  (h.service as unknown as { client: { getTicketStateView: () => Promise<never> } }).client.getTicketStateView = async () => {
    throw new IntercomHttpError(500, "boom");
  };
  assert.equal(await h.service.closingStateFor("T", "w1"), "w1");
});

// ---- the customer-idle sweep's auto-close ----

test("resolveBeforeClose: writes the state without closing (the sweep closes next)", async () => {
  const h = makeHarness({ view: { open: true } });
  assert.equal(await h.service.resolveBeforeClose("T", "42"), true);
  assert.deepEqual(h.writes, [{ stateId: "r1", open: undefined }]);
});

test("resolveBeforeClose: an already resolved ticket needs no write", async () => {
  const h = makeHarness({ view: { open: true, stateId: "r1", stateCategory: "resolved" } });
  assert.equal(await h.service.resolveBeforeClose("T", "42"), false);
  assert.deepEqual(h.writes, []);
});

// ---- the sweep ----

const hit = (id: string, over: Partial<IntercomTicketStateView> = {}): IntercomTicketStateView => ({
  id,
  open: false,
  stateId: "p1",
  stateCategory: "in_progress",
  typeCategory: "Customer",
  typeStates: STATES,
  stateChanges: [],
  ...over,
});

test("sweep: the backfill walks every page without a window and resolves each hit", async () => {
  const h = makeHarness({ pages: [[hit("A"), hit("B")], [hit("C")]] });
  const report = await h.service.sweep();
  assert.deepEqual(h.searches, [null, null]);
  assert.equal(report?.resolved, 3);
  assert.equal(report?.backfillDone, false);
  assert.equal(h.writes.length, 3);
});

test("sweep: a full backfill pass with nothing left to write stamps the backfill", async () => {
  const h = makeHarness({ pages: [[hit("A", { stateId: "r1", stateCategory: "resolved" })]] });
  const report = await h.service.sweep();
  assert.equal(report?.backfillDone, true);
  assert.ok(h.ops.includes("backfill-done"));
});

test("sweep: after the backfill only recent closes are searched", async () => {
  const h = makeHarness({ backfilledAt: new Date(), pages: [[]] });
  await h.service.sweep();
  assert.equal(h.searches.length, 1);
  assert.equal(typeof h.searches[0], "number");
});

test("sweep: a hit without its type's states is read fresh", async () => {
  const h = makeHarness({ pages: [[hit("A", { typeStates: null })]] });
  await h.service.sweep();
  assert.ok(h.ops.includes("get:A"));
  assert.deepEqual(h.writes, [{ stateId: "r1", open: false }]);
});

test("sweep: a rejected ticket is not retried by the next sweep", async () => {
  const h = makeHarness({ rejectWrite: true, pages: [[hit("A")]] });
  const first = await h.service.sweep();
  assert.equal(first?.rejected, 1);
  // Nothing left that can be written: the backfill is complete.
  assert.equal(first?.backfillDone, true);
  const second = await h.service.sweep();
  assert.equal(second?.rejected, 0);
  assert.equal(second?.skipped, 1);
  assert.equal(h.writes.length, 0);
});

test("sweep: a bridged ticket is resolved only once Discord has it closed, with the damper set", async () => {
  const open = makeHarness({ link: { lastSyncedStateId: "w1" }, discordClosed: false, pages: [[hit("T")]] });
  const r = await open.service.sweep();
  assert.deepEqual(open.writes, []);
  assert.equal(r?.skipped, 1);

  const closed = makeHarness({ link: { lastSyncedStateId: "w1" }, discordClosed: true, reopens: true, pages: [[hit("T")]] });
  await closed.service.sweep();
  assert.equal(closed.writes[0].stateId, "r1");
  assert.ok(closed.ops.indexOf("synced:r1") < closed.ops.indexOf("put:T"), "damper before the write");
  assert.ok(closed.ops.includes("reply-delete-thread:th"));
  assert.ok(closed.ops.includes("conv:C:close"), "a reopened bridged conversation is closed again");
});

test("sweep: a rejected bridged write rolls the damper back", async () => {
  const h = makeHarness({ link: { lastSyncedStateId: "w1" }, rejectWrite: true, pages: [[hit("T")]] });
  await h.service.sweep();
  assert.deepEqual(
    h.ops.filter((o) => o.startsWith("synced:")),
    ["synced:r1", "synced:w1"]
  );
});

test("sweep: off does nothing", async () => {
  const h = makeHarness({ active: false, pages: [[hit("A")]] });
  assert.equal(await h.service.sweep(), null);
  assert.deepEqual(h.searches, []);
});
