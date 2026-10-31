import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomEventExecutor } from "../IntercomEventExecutor";
import type { EnsurePayload } from "../types";

// A re-ensure of a bridge that already has its conversation and ticket (Sync
// now's verify, the stranded-run repair) must not write the ticket state or
// re-route the conversation: Intercom is the newer side by then, and either
// write reopens a conversation a teammate closed. On 2026-10-31 the repair
// did exactly that to the tickets resolved in Intercom since August.

function recorder(overrides: Record<string, unknown>, calls: string[]) {
  return new Proxy(overrides, {
    get: (target, name: string) =>
      name in target
        ? target[name]
        : async (...args: unknown[]) => {
            calls.push(`${name}${name === "updateTicket" ? `:${Object.keys((args[1] as object) ?? {}).filter((k) => k !== "adminId").join(",")}` : ""}`);
            if (name === "convertToTicket") return { ticketId: "tk-new" };
            if (name === "findOrCreateTag") return { id: "tag-discord" };
            return null;
          },
  });
}

function executor(link: { ticketId: string | null }) {
  const calls: string[] = [];
  const client = recorder({}, calls);
  const store = recorder(
    {
      getLink: async () => ({ ticketThreadId: "t1", conversationId: "c1", contactId: "u1", lastSyncedOpen: "open", ...link }),
      setTicketId: async () => {},
      setLastSyncedStateId: async () => void calls.push("setLastSyncedStateId"),
      setLastSyncedOpen: async () => {},
    },
    calls
  );
  const settings = recorder(
    {
      intercomOperatorAdminId: () => "op",
      intercomAdminId: () => null,
      intercomTeamId: () => "team-support",
      intercomTicketTypeIdFor: () => "type-bug",
      tagById: () => ({ intercomTicketStateId: "state-in-progress" }),
    },
    calls
  );
  const ex = new IntercomEventExecutor(client as never, store as never, settings as never, {} as never, {} as never, { log: async () => {} } as never);
  return { ex, calls };
}

const payload = {
  customerId: "d1",
  customerDisplayName: null,
  categoryId: "bugs",
  categoryLabel: "Report a Bug",
  question: "It broke",
  statusTagId: "tag-ongoing",
  statusLabel: "Ongoing",
  closed: false,
  resolved: false,
  createdAtIso: "2026-07-30T18:32:20Z",
} as unknown as EnsurePayload;

test("re-ensure of a linked, ticketed bridge: no state write, no routing", async () => {
  const { ex, calls } = executor({ ticketId: "tk1" });
  await ex.ensureBridge("t1", payload);
  assert.ok(!calls.some((c) => c.startsWith("updateTicket:") && c.includes("stateId")), calls.join(" "));
  assert.ok(!calls.includes("assignConversationToTeam"), calls.join(" "));
  assert.ok(!calls.some((c) => c.includes("assigneeId")), calls.join(" "));
});

test("a ticket attached by this ensure still gets its initial state and routing", async () => {
  const { ex, calls } = executor({ ticketId: null });
  await ex.ensureBridge("t1", payload);
  assert.ok(calls.includes("convertToTicket"));
  assert.ok(calls.some((c) => c.startsWith("updateTicket:") && c.includes("stateId")), calls.join(" "));
  assert.ok(calls.includes("assignConversationToTeam"), calls.join(" "));
});
