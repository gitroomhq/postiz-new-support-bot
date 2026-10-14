import { test } from "node:test";
import assert from "node:assert/strict";
import { AssignmentService } from "../AssignmentService";
import { IntercomClient } from "../IntercomClient";

type Facts = { open: boolean; state: string; snoozedUntil: Date | null; teamAssigneeId: string | null; adminAssigneeId: string | null };
function harness() {
  const conversations = new Map<string, Facts>();
  const assigned: Array<[string, string]> = [];
  const mirrors: Array<[string, string]> = [];
  let cursor: string | null = null;
  let enabled = true;
  let fail = false;
  const admins = [{ id: "a", name: "A", awayModeEnabled: false }, { id: "b", name: "B", awayModeEnabled: false }];
  const service = new AssignmentService({
    listAdmins: async () => admins,
    getTeam: async () => ({ adminIds: ["a", "b"] }),
    getConversationSlaFacts: async (id: string) => conversations.get(id) ?? null,
    assignConversationToAdmin: async (id: string, adminId: string) => {
      // Keep the write outstanding so concurrent requests expose cursor races.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fail) throw new Error("write failed");
      assigned.push([id, adminId]);
      conversations.get(id)!.adminAssigneeId = adminId;
    },
    updateTicket: async (id: string, input: { assigneeId: string }) => { mirrors.push([id, input.assigneeId]); },
  } as never, { setLastAssigneeId: async () => {} } as never, {
    resolveAssignEnabled: () => enabled,
    resolveAssignExcludedAdmins: () => [],
    intercomOperatorAdminId: () => null,
    teamRotationCursor: () => cursor,
    setTeamRotationCursor: async (_team: string, id: string) => { cursor = id; },
  } as never, async (fn) => fn("author"));
  const add = (id: string, overrides: Partial<Facts> = {}) => conversations.set(id, {
    open: true, state: "open", snoozedUntil: null, teamAssigneeId: "team", adminAssigneeId: null, ...overrides,
  });
  return { service, conversations, assigned, mirrors, admins, add, disable: () => { enabled = false; }, setFail: (v: boolean) => { fail = v; } };
}

test("concurrent conversation webhooks rotate fairly, including duplicate deliveries", async () => {
  const h = harness();
  for (const id of ["1", "2", "3", "4"]) h.add(id);
  await Promise.all(["1", "1", "2", "3", "4"].map((id) => h.service.maybeAssignOnCreate(id, "team", null, null)));
  assert.deepEqual(h.assigned, [["1", "a"], ["2", "b"], ["3", "a"], ["4", "b"]]);
});

test("customer reply assigns an unassigned conversation immediately", async () => {
  const h = harness(); h.add("1");
  await h.service.maybeReassignOnCustomerReply("1", null, "team", null, "ticket-1");
  assert.deepEqual(h.assigned, [["1", "a"]]);
  assert.deepEqual(h.mirrors, [["ticket-1", "a"]]);
});

test("creation payload without a team uses the live routed team", async () => {
  const h = harness(); h.add("1");
  await h.service.maybeAssignOnCreate("1", null, null, null);
  assert.deepEqual(h.assigned, [["1", "a"]]);
});

test("stale events cannot override human grabs, closes, snoozes or routing changes", async () => {
  const h = harness();
  h.add("human", { adminAssigneeId: "b" });
  h.add("closed", { open: false, state: "closed" });
  h.add("snoozed", { snoozedUntil: new Date(Date.now() + 60_000) });
  h.add("snoozed-state", { state: "snoozed" });
  h.add("routed", { teamAssigneeId: "other-team" });
  for (const id of h.conversations.keys()) await h.service.maybeAssignOnCreate(id, "team", null, null);
  assert.deepEqual(h.assigned, []);
});

test("away teammate is replaced on reply, but a subsequent human grab is preserved", async () => {
  const h = harness(); h.admins[0].awayModeEnabled = true;
  h.add("away", { adminAssigneeId: "a" });
  h.add("grabbed", { adminAssigneeId: "b" });
  await h.service.maybeReassignOnCustomerReply("away", "a", "team", null, null);
  await h.service.maybeReassignOnCustomerReply("grabbed", "a", "team", null, null);
  assert.deepEqual(h.assigned, [["away", "b"]]);
});

test("disabled assignment and an all-away pool leave conversations alone", async () => {
  const h = harness(); h.add("1"); h.disable();
  await h.service.maybeAssignOnCreate("1", "team", null, null);
  assert.deepEqual(h.assigned, []);
  const away = harness(); away.add("1");
  away.admins.forEach((admin) => { admin.awayModeEnabled = true; });
  await away.service.maybeAssignOnCreate("1", "team", null, null);
  assert.deepEqual(away.assigned, []);
});

test("failed writes release the team queue and do not advance the cursor", async () => {
  const h = harness(); h.add("1"); h.add("2"); h.setFail(true);
  assert.equal(await h.service.assignConversation("1", "team"), null);
  h.setFail(false);
  assert.equal(await h.service.assignConversation("2", "team"), "a");
});

test("Intercom zero assignment sentinels are unassigned in live facts and sweep reads", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    id: "1", admin_assignee_id: 0, team_assignee_id: "0",
    conversations: [{ id: "1", admin_assignee_id: "0", team_assignee_id: 0 }],
  }), { status: 200 }));
  const client = new IntercomClient({ intercomRegion: () => "us", intercomAccessToken: () => "fixture-token" } as never);
  const live = await client.getConversationSlaFacts("1");
  assert.equal(live?.adminAssigneeId, null);
  assert.equal(live?.teamAssigneeId, null);
  const page = await client.searchOpenConversations(null);
  assert.equal(page.items[0].adminAssigneeId, null);
  assert.equal(page.items[0].teamAssigneeId, null);
});
