import type { IntercomTicketState, IntercomTicketStateView } from "./types";
import { pickStateForCategory } from "./replyState";

// Resolve on close, the pure half. Fin, Workflows, the bot's own customer-idle
// sweep and teammates can all close an Intercom ticket while leaving its state
// in Submitted / In progress / Waiting on customer. Every close lands the
// ticket in a Resolved-category state instead. CloseStateService does the I/O.

export type CloseDecision =
  | { action: "write"; stateId: string }
  | { action: "skip"; reason: "open" | "not-customer-type" | "already-resolved" | "no-target" };

// The Resolved-category state a closed ticket goes to: the picked one when the
// ticket's type allows it, else the type's own Resolved state (the one labelled
// "Resolved" when there are several). Without the type's states (a payload
// that omitted them) the workspace list stands in; a write the type rejects is
// logged by the caller.
export function resolveTarget(
  typeStates: readonly IntercomTicketState[] | null,
  workspaceStates: readonly IntercomTicketState[],
  pickedId: string | null
): IntercomTicketState | null {
  const pool = typeStates ?? workspaceStates;
  const picked = pickedId ? pool.find((s) => s.id === pickedId && s.category === "resolved" && !s.archived) : undefined;
  return picked ?? pickStateForCategory(pool, "resolved", null);
}

// Whether a ticket needs the write, and which state it gets. Only Customer
// tickets: a Tracker's state change is customer-facing on every linked ticket,
// and Back-office tickets have no conversation that Fin or the sweep closes.
// Any Resolved-category state counts as done, so a teammate's deliberate
// custom resolved state is never overwritten.
export function decideClose(
  view: IntercomTicketStateView,
  workspaceStates: readonly IntercomTicketState[],
  pickedId: string | null
): CloseDecision {
  if (view.open) return { action: "skip", reason: "open" };
  if (view.typeCategory && view.typeCategory !== "Customer") return { action: "skip", reason: "not-customer-type" };
  if (view.stateCategory === "resolved") return { action: "skip", reason: "already-resolved" };
  const target = resolveTarget(view.typeStates, workspaceStates, pickedId);
  if (!target) return { action: "skip", reason: "no-target" };
  return { action: "write", stateId: target.id };
}

// The state a bridged closing status pushes. A Discord closing tag mapped to a
// Resolved-category state keeps its mapping; an unmapped one, or one mapped to
// anything else, gets the resolve target. A ticket already resolved in
// Intercom keeps that state rather than being moved off it by the mapping.
export function bridgedClosingState(
  mappedStateId: string | null,
  mappedCategory: string | null,
  view: IntercomTicketStateView | null,
  workspaceStates: readonly IntercomTicketState[],
  pickedId: string | null
): string | null {
  if (mappedStateId && mappedCategory === "resolved") return mappedStateId;
  if (!view) return mappedStateId;
  if (view.typeCategory && view.typeCategory !== "Customer") return mappedStateId;
  if (view.stateCategory === "resolved") return view.stateId ?? mappedStateId;
  return resolveTarget(view.typeStates, workspaceStates, pickedId)?.id ?? mappedStateId;
}
