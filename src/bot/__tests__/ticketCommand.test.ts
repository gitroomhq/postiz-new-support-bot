import { test } from "node:test";
import assert from "node:assert/strict";
import { TICKET_COMMAND, TicketCommand, diagnoseSync, type SyncFacts, type TicketCommandDeps } from "../TicketCommand";
import { intercomInboxUrl } from "../../queue/queueModel";

// /ticket is visible to everyone who can see the channel, so registration is
// not the gate: the runtime check is, on the command and on every button.

const LINKED_AT = new Date("2026-10-01T10:00:00Z");

function facts(over: Partial<SyncFacts> = {}): SyncFacts {
  return {
    mode: "bi",
    configured: true,
    exempt: false,
    link: null,
    remote: { kind: "none" },
    failure: null,
    queue: { depth: 0, head: null },
    stranded: null,
    workerPaused: false,
    backfillClaimed: false,
    ...over,
  };
}

const failure = (at: Date) => ({ eventType: "ensure", error: "Intercom conversation create 422: bad", attempts: 8, failedAt: at });

test("/ticket: registered without default permissions, so the support role can see it", () => {
  assert.equal(TICKET_COMMAND.name, "ticket");
  assert.ok(!("default_member_permissions" in TICKET_COMMAND));
  assert.ok(TICKET_COMMAND.description.length <= 100);
});

test("diagnose: a mirrored ticket with no failure is synced and offers nothing", () => {
  const r = diagnoseSync(
    facts({
      link: { conversationId: "c1", ticketId: "c1", createdAt: LINKED_AT },
      remote: { kind: "found", number: "146041426", stateLabel: "In progress" },
    })
  );
  assert.equal(r.synced, "yes");
  assert.equal(r.why, null);
  assert.equal(r.canSync, false);
});

test("diagnose: the bridge being off explains everything, and nothing is offered", () => {
  const r = diagnoseSync(facts({ mode: "none", exempt: true, failure: failure(new Date()) }));
  assert.equal(r.synced, "no");
  assert.match(r.why!, /sync is off/);
  assert.equal(r.canSync, false);
  assert.equal(r.canLift, false);
});

test("diagnose: a Discord-only refund ticket can be lifted, not synced", () => {
  const r = diagnoseSync(facts({ exempt: true }));
  assert.match(r.why!, /Discord-only refund ticket/);
  assert.equal(r.canLift, true);
  assert.equal(r.canSync, false);
});

test("diagnose: a failed creation push with nothing queued releases the stale import marker", () => {
  const r = diagnoseSync(facts({ failure: failure(new Date()), backfillClaimed: true }));
  assert.match(r.why!, /push to Intercom failed/);
  assert.equal(r.canSync, true);
  assert.equal(r.releaseStaleClaim, true);
  assert.ok(r.failure);
});

test("diagnose: a failed creation push with events still held keeps the marker (the queue still carries the import)", () => {
  const r = diagnoseSync(facts({ failure: failure(new Date()), queue: { depth: 4, head: "message" } }));
  assert.equal(r.canSync, true);
  assert.equal(r.releaseStaleClaim, false);
  assert.match(r.note!, /4 events are held/);
});

test("diagnose: queued without a failure is just waiting; a paused worker is named", () => {
  const r = diagnoseSync(facts({ queue: { depth: 1, head: "ensure" }, workerPaused: true }));
  assert.match(r.why!, /delivery queue \(1 event\)/);
  assert.match(r.note!, /worker is paused/);
  assert.equal(r.canSync, false);
});

test("diagnose: Temporal not answering is unknown, never a reason to drop the marker", () => {
  const r = diagnoseSync(facts({ queue: null, backfillClaimed: true }));
  assert.match(r.why!, /did not answer/);
  assert.equal(r.canSync, true);
  assert.equal(r.releaseStaleClaim, false);
});

test("diagnose: never pushed vs an import that never delivered", () => {
  const never = diagnoseSync(facts());
  assert.match(never.why!, /Never pushed/);
  assert.equal(never.releaseStaleClaim, false);
  const lost = diagnoseSync(facts({ backfillClaimed: true }));
  assert.match(lost.why!, /never delivered/);
  assert.equal(lost.releaseStaleClaim, true);
});

test("diagnose: linked halves (no ticket, deleted ticket, Intercom down)", () => {
  const link = { conversationId: "c1", ticketId: null, createdAt: LINKED_AT };
  assert.equal(diagnoseSync(facts({ link, remote: { kind: "none" } })).synced, "partly");
  const missing = diagnoseSync(facts({ link: { ...link, ticketId: "c1" }, remote: { kind: "missing" } }));
  assert.equal(missing.synced, "no");
  assert.equal(missing.canSync, true);
  const down = diagnoseSync(facts({ link: { ...link, ticketId: "c1" }, remote: { kind: "unknown" } }));
  assert.equal(down.synced, "yes");
  assert.equal(down.canSync, false);
});

test("diagnose: a failure before the link is history, one after it makes the ticket partly synced", () => {
  const base = {
    link: { conversationId: "c1", ticketId: "c1", createdAt: LINKED_AT },
    remote: { kind: "found" as const, number: "1", stateLabel: null },
  };
  const old = diagnoseSync(facts({ ...base, failure: failure(new Date(LINKED_AT.getTime() - 60_000)) }));
  assert.equal(old.synced, "yes");
  assert.equal(old.failure, null);
  const later = diagnoseSync(facts({ ...base, failure: { ...failure(new Date(LINKED_AT.getTime() + 60_000)), eventType: "message" } }));
  assert.equal(later.synced, "partly");
  assert.equal(later.canSync, true);
});

test("diagnose: a run stranded on a queue no worker polls is named; Repair sync replaces Sync now (which would feed it)", () => {
  const linked = diagnoseSync(
    facts({
      link: { conversationId: "c1", ticketId: "c1", createdAt: LINKED_AT },
      remote: { kind: "found", number: "120379947", stateLabel: "In progress" },
      queue: null,
      stranded: "support-bot",
    })
  );
  assert.equal(linked.synced, "partly");
  assert.match(linked.why!, /stuck on the task queue `support-bot`/);
  assert.equal(linked.canSync, false);
  assert.equal(linked.canRepair, true);
  const never = diagnoseSync(facts({ queue: null, stranded: "support-bot" }));
  assert.equal(never.synced, "no");
  assert.equal(never.canSync, false);
  assert.equal(never.canRepair, true);
  assert.equal(diagnoseSync(facts()).canRepair, false);
});

test("diagnose: a mirrored ticket whose queue Temporal could not read says so instead of a bare Yes", () => {
  const base = {
    link: { conversationId: "c1", ticketId: "c1", createdAt: LINKED_AT },
    remote: { kind: "found" as const, number: "1", stateLabel: null },
    queue: null,
  };
  const silent = diagnoseSync(facts(base));
  assert.equal(silent.synced, "yes");
  assert.match(silent.note!, /did not answer/);
  assert.match(diagnoseSync(facts({ ...base, workerPaused: true })).note!, /worker is paused/);
});

test("inbox link: the region's host, and an unusable workspace id degrades to _", () => {
  assert.equal(intercomInboxUrl("eu", "abcd1234", "55"), "https://app.eu.intercom.com/a/inbox/abcd1234/inbox/conversation/55");
  assert.equal(intercomInboxUrl("us", "../evil", "55"), "https://app.intercom.com/a/inbox/_/inbox/conversation/55");
});

// ---- command and buttons ----

function ticketRow(over: Record<string, unknown> = {}) {
  return {
    threadId: "t1",
    closed: false,
    categoryId: "bugs",
    question: "It broke",
    intercomExempt: false,
    statusTag: null,
    ...over,
  };
}

function harness(
  opts: { allowed?: boolean; admin?: boolean; ticket?: Record<string, unknown> | null; failure?: boolean; stranded?: boolean } = {}
) {
  const calls: string[] = [];
  const deps: TicketCommandDeps = {
    authorize: async () => opts.allowed ?? true,
    isAdmin: () => opts.admin ?? false,
    getTicket: async (id) => {
      calls.push(`getTicket:${id}`);
      return opts.ticket === null ? null : (ticketRow(opts.ticket ?? {}) as never);
    },
    store: {
      getLink: async () => null,
      getSyncFailure: async () => (opts.failure ? failure(new Date()) : null),
      clearSyncFailure: async () => void calls.push("clear"),
      hasBackfillClaim: async () => false,
    },
    settings: { intercomMode: () => "bi", intercomConfigured: () => true, intercomRegion: () => "us" },
    intercom: { getTicketRaw: async () => null, getMe: async () => ({ appIdCode: "abcd1234" }) },
    temporal: () => ({
      routable: () => true,
      enabled: () => true,
      ticketOutbox: async () =>
        opts.stranded ? { kind: "stranded", taskQueue: "support-bot" } : { kind: "queue", depth: 0, head: null },
      intercomRetryNow: async () => void calls.push("wake"),
    }),
    sync: {
      repairTicket: async (_t, _m, o) => {
        calls.push(`repair:${o.releaseStaleClaim}`);
        return { kind: "backfill", events: 5 };
      },
      liftRefundTicket: async () => {
        calls.push("lift");
        return "flipped";
      },
    },
    threadMessages: async () => [],
    inboundHeal: async () => 0,
    repairStranded: async (threadId) => {
      calls.push(`repairStranded:${threadId}`);
      return { terminated: 2, recovered: 6, inbound: 1 };
    },
    slaTrigger: () => void calls.push("sla"),
    audit: () => void calls.push("audit"),
  };
  return { cmd: new TicketCommand(deps), calls };
}

function button(customId: string) {
  const edits: unknown[] = [];
  const replies: unknown[] = [];
  return {
    edits,
    replies,
    interaction: {
      customId,
      channelId: "t1",
      user: { id: "u1", displayName: "Sam", displayAvatarURL: () => "" },
      reply: async (p: unknown) => void replies.push(p),
      deferUpdate: async () => {},
      editReply: async (p: unknown) => void edits.push(p),
    },
  };
}

function customIds(panel: unknown): string[] {
  const rows = (panel as { components: Array<{ components: Array<{ data: { custom_id?: string; url?: string } }> }> }).components;
  return rows.flatMap((r) => r.components.map((c) => c.data.custom_id ?? c.data.url ?? ""));
}

test("/ticket: a refused invoker gets nothing read", async () => {
  const { cmd, calls } = harness({ allowed: false });
  const replies: unknown[] = [];
  await cmd.handleCommand({ channelId: "t1", reply: async (p: unknown) => void replies.push(p) } as never);
  assert.deepEqual(calls, []);
});

test("/ticket: outside a ticket thread it says so", async () => {
  const { cmd } = harness({ ticket: null });
  const replies: Array<{ flags?: number }> = [];
  await cmd.handleCommand({ channelId: "c9", reply: async (p: { flags?: number }) => void replies.push(p) } as never);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].flags, 64);
});

test("/ticket: an unsynced ticket offers Sync now; Sync now clears the record first, then repairs and wakes the queue", async () => {
  const { cmd, calls } = harness({ failure: true });
  const deferred: unknown[] = [];
  await cmd.handleCommand({
    channelId: "t1",
    reply: async () => {},
    deferReply: async () => void deferred.push(1),
    editReply: async (p: unknown) => void deferred.push(p),
  } as never);
  assert.ok(customIds(deferred.at(-1)).includes("ticketcmd_sync"));

  const b = button("ticketcmd_sync");
  await cmd.handleButton(b.interaction as never);
  const order = calls.filter((c) => ["clear", "repair:true", "wake", "audit"].includes(c));
  assert.deepEqual(order, ["clear", "repair:true", "wake", "audit"]);
});

test("/ticket: Mirror to Intercom is admin-only, on the button too", async () => {
  const staff = harness({ admin: false, ticket: { intercomExempt: true, categoryId: "billing", question: "Refund request" } });
  const b = button("ticketcmd_lift");
  await staff.cmd.handleButton(b.interaction as never);
  assert.ok(!staff.calls.includes("lift"));
  assert.ok(!customIds(b.edits.at(-1)).includes("ticketcmd_lift"), "no lift button for staff");

  const admin = harness({ admin: true, ticket: { intercomExempt: true, categoryId: "billing", question: "Refund request" } });
  await admin.cmd.handleButton(button("ticketcmd_lift").interaction as never);
  assert.ok(admin.calls.includes("lift"));
  assert.ok(admin.calls.includes("sla"));
});

test("/ticket: a stranded ticket offers Repair sync, which replaces the run, heals and audits", async () => {
  const { cmd, calls } = harness({ stranded: true });
  const shown: unknown[] = [];
  await cmd.handleCommand({
    channelId: "t1",
    reply: async () => {},
    deferReply: async () => {},
    editReply: async (p: unknown) => void shown.push(p),
  } as never);
  const ids = customIds(shown.at(-1));
  assert.ok(ids.includes("ticketcmd_repair"));
  assert.ok(!ids.includes("ticketcmd_sync"), "Sync now would only feed the stranded run");

  const b = button("ticketcmd_repair");
  await cmd.handleButton(b.interaction as never);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("repairStranded") || c === "audit"),
    ["repairStranded:t1", "audit"]
  );
});

test("/ticket: Repair sync on a healthy ticket does nothing", async () => {
  const { cmd, calls } = harness();
  await cmd.handleButton(button("ticketcmd_repair").interaction as never);
  assert.ok(!calls.some((c) => c.startsWith("repairStranded")));
});
