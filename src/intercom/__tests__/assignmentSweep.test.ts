import { test } from "node:test";
import assert from "node:assert/strict";
import { SlaEnforcer } from "../SlaEnforcer";

test("recovery assigns within the live team and excludes parked work from load counts", async () => {
  const item = (id: string, extra = {}) => ({
    id, state: "open", teamAssigneeId: "old-team", adminAssigneeId: "a", snoozedUntil: null, ...extra,
  });
  let counts = new Map<string, number>();
  const picks: Array<[string, string]> = [];
  const enforcer = new SlaEnforcer({
    slaState: { findMany: async () => [] }, intercomLink: { findMany: async () => [] },
  } as never, {
    searchOpenConversations: async () => ({ items: [
      item("working"), item("parked", { snoozedUntil: new Date(Date.now() + 60_000) }),
      item("stray", { adminAssigneeId: null }),
    ], nextStartingAfter: null }),
    getConversationSlaFacts: async () => ({ open: true, adminAssigneeId: null, teamAssigneeId: "new-team" }),
  } as never, {} as never, {
    intercomConfigured: () => true, slaEnabled: () => false, anyAssignmentEnabled: () => true,
    inactivityEnabled: () => false, intercomAdminId: () => null, intercomAuthorAdminId: () => null,
    resolveAssignEnabled: () => true,
  } as never, async (fn) => fn("author"), {
    setOpenCounts: (value: Map<string, number>) => { counts = value; },
    assignConversation: async (id: string, team: string) => { picks.push([id, team]); return "b"; },
  } as never);
  assert.equal((await enforcer.sweep(false)).assigned, 1);
  assert.deepEqual([...counts], [["a", 1]]);
  assert.deepEqual(picks, [["stray", "new-team"]]);
});
