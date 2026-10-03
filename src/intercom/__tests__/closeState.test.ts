import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgedClosingState, decideClose, resolveTarget } from "../closeState";
import type { IntercomTicketState, IntercomTicketStateView } from "../types";

const STATES: IntercomTicketState[] = [
  { id: "s1", category: "submitted", internalLabel: "Submitted", archived: false },
  { id: "p1", category: "in_progress", internalLabel: "In Progress", archived: false },
  { id: "w1", category: "waiting_on_customer", internalLabel: "Waiting on customer", archived: false },
  { id: "r0", category: "resolved", internalLabel: "Won't fix", archived: false },
  { id: "r1", category: "resolved", internalLabel: "Resolved", archived: false },
  { id: "rx", category: "resolved", internalLabel: "Old resolved", archived: true },
];

function view(over: Partial<IntercomTicketStateView> = {}): IntercomTicketStateView {
  return {
    id: "T",
    open: false,
    stateId: "p1",
    stateCategory: "in_progress",
    typeCategory: "Customer",
    typeStates: STATES,
    stateChanges: [],
    ...over,
  };
}

test("resolveTarget: no pick takes the state labelled Resolved, never an archived one", () => {
  assert.equal(resolveTarget(STATES, [], null)?.id, "r1");
  assert.equal(resolveTarget(STATES.filter((s) => s.id !== "r1"), [], null)?.id, "r0");
  assert.equal(resolveTarget(STATES.filter((s) => s.category !== "resolved" || s.archived), [], null), null);
});

test("resolveTarget: the pick wins when the type allows it, else the type's own", () => {
  assert.equal(resolveTarget(STATES, [], "r0")?.id, "r0");
  assert.equal(resolveTarget(STATES.filter((s) => s.id !== "r0"), [], "r0")?.id, "r1");
  // A non-resolved or archived pick is never used.
  assert.equal(resolveTarget(STATES, [], "p1")?.id, "r1");
  assert.equal(resolveTarget(STATES, [], "rx")?.id, "r1");
});

test("resolveTarget: without the type's states the workspace list stands in", () => {
  assert.equal(resolveTarget(null, STATES, "r0")?.id, "r0");
  assert.equal(resolveTarget(null, STATES, null)?.id, "r1");
});

test("decideClose: a closed Customer ticket outside Resolved gets the target", () => {
  assert.deepEqual(decideClose(view(), [], null), { action: "write", stateId: "r1" });
  assert.deepEqual(decideClose(view({ stateId: "w1", stateCategory: "waiting_on_customer" }), [], "r0"), {
    action: "write",
    stateId: "r0",
  });
  assert.deepEqual(decideClose(view({ stateId: "s1", stateCategory: "submitted" }), [], null), { action: "write", stateId: "r1" });
});

test("decideClose: open, already resolved, non-Customer and target-less tickets are skipped", () => {
  assert.deepEqual(decideClose(view({ open: true }), [], null), { action: "skip", reason: "open" });
  // A deliberate custom resolved state is kept, even when another is picked.
  assert.deepEqual(decideClose(view({ stateId: "r0", stateCategory: "resolved" }), [], "r1"), {
    action: "skip",
    reason: "already-resolved",
  });
  assert.deepEqual(decideClose(view({ typeCategory: "Tracker" }), [], null), { action: "skip", reason: "not-customer-type" });
  assert.deepEqual(decideClose(view({ typeCategory: "Back-office" }), [], null), { action: "skip", reason: "not-customer-type" });
  assert.deepEqual(decideClose(view({ typeStates: STATES.filter((s) => s.category !== "resolved") }), [], null), {
    action: "skip",
    reason: "no-target",
  });
});

test("bridgedClosingState: a closing tag mapped to a resolved state keeps it", () => {
  assert.equal(bridgedClosingState("r0", "resolved", view(), STATES, "r1"), "r0");
});

test("bridgedClosingState: an unmapped or non-resolved closing tag gets the target", () => {
  assert.equal(bridgedClosingState(null, null, view(), STATES, null), "r1");
  assert.equal(bridgedClosingState("w1", "waiting_on_customer", view(), STATES, "r0"), "r0");
});

test("bridgedClosingState: a ticket already resolved in Intercom keeps its state over the mapping", () => {
  assert.equal(bridgedClosingState("w1", "waiting_on_customer", view({ stateId: "r0", stateCategory: "resolved" }), STATES, null), "r0");
});

test("bridgedClosingState: no view, a non-Customer type or no target keeps the mapping", () => {
  assert.equal(bridgedClosingState("w1", "waiting_on_customer", null, STATES, null), "w1");
  assert.equal(bridgedClosingState("w1", "waiting_on_customer", view({ typeCategory: "Back-office" }), STATES, null), "w1");
  assert.equal(
    bridgedClosingState("w1", "waiting_on_customer", view({ typeStates: STATES.filter((s) => s.category !== "resolved") }), [], null),
    "w1"
  );
});
