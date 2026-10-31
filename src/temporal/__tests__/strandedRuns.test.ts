import { test } from "node:test";
import assert from "node:assert/strict";
import { StrandedRunRepair, type StrandedRepairDeps } from "../strandedRuns";
import { strandedKey, strandedRunsQuery, type StrandedRun } from "../producers";
import type { AuditEvent } from "../../bot/AuditLogger";

// A run started before the task queue setting changed never runs again and
// silently swallows every signal. The repair terminates it and heals the
// ticket from Discord and Intercom; nothing may be healed into a run that is
// about to be terminated.

const run = (kind: StrandedRun["kind"], key: string): StrandedRun => ({
  kind,
  key,
  workflowId: kind === "ticket" ? `ticket-${key}` : `icx-${key}`,
  taskQueue: "support-bot",
});

function harness(opts: { runs?: StrandedRun[]; others?: Record<string, number>; links?: Record<string, string> } = {}) {
  const ops: string[] = [];
  const audits: AuditEvent[] = [];
  const links = opts.links ?? {}; // conversation id -> thread id
  const deps: StrandedRepairDeps = {
    temporal: () => ({
      routable: () => true,
      listStrandedRuns: async () => opts.runs ?? [],
      countOtherStranded: async () => opts.others ?? {},
      terminateStranded: async (workflowId) => {
        ops.push(`terminate:${workflowId}`);
        return true;
      },
      nudgeTicket: async (threadId) => void ops.push(`nudge:${threadId}`),
    }),
    getTicket: async (threadId) => (threadId === "gone" ? null : ({ threadId } as never)),
    getLink: async (threadId) => {
      const conv = Object.entries(links).find(([, t]) => t === threadId)?.[0];
      return conv ? { conversationId: conv } : null;
    },
    getLinkByConversationId: async (conversationId) => (links[conversationId] ? { ticketThreadId: links[conversationId] } : null),
    threadMessages: async () => [],
    repair: async (ticket) => {
      ops.push(`repair:${ticket.threadId}`);
      return { kind: "heal", messages: 3 };
    },
    inboundHeal: async (threadId, conversationId) => {
      ops.push(`inbound:${threadId}:${conversationId}`);
      return 1;
    },
    audit: (e) => void audits.push(e),
  };
  return { repair: new StrandedRunRepair(deps), ops, audits };
}

test("query: other task queues only, with the configured name escaped", () => {
  assert.equal(
    strandedRunsQuery("ticketWorkflow", "main"),
    'WorkflowType="ticketWorkflow" AND ExecutionStatus="Running" AND TaskQueue!="main"'
  );
  assert.equal(strandedRunsQuery(null, 'a"b'), 'ExecutionStatus="Running" AND TaskQueue!="a\\"b"');
});

test("key: thread and conversation ids come off the workflow ids, odd ids are skipped", () => {
  assert.equal(strandedKey("ticket", "ticket-1532455822003540098"), "1532455822003540098");
  assert.equal(strandedKey("inbox", "icx-215475294213724"), "215475294213724");
  assert.equal(strandedKey("ticket", "icx-1"), null);
  assert.equal(strandedKey("inbox", "icx-"), null);
});

test("sweep: every run is terminated before any heal, and a ticket with a stranded inbox is healed once", async () => {
  const { repair, ops, audits } = harness({
    runs: [run("ticket", "t1"), run("inbox", "c1"), run("inbox", "native")],
    links: { c1: "t1" },
  });
  const r = await repair.sweep();
  const firstHeal = ops.findIndex((o) => o.startsWith("repair:"));
  const lastTerminate = ops.map((o) => o.startsWith("terminate:")).lastIndexOf(true);
  assert.ok(lastTerminate < firstHeal, "no heal before the last terminate");
  assert.deepEqual(
    ops.filter((o) => o.startsWith("repair:") || o.startsWith("inbound:")),
    ["repair:t1", "inbound:t1:c1"]
  );
  assert.ok(ops.includes("nudge:t1"), "timers come back on a fresh run");
  assert.equal(r?.tickets, 1);
  assert.equal(r?.inboxes, 2);
  assert.deepEqual(r?.repaired, [{ threadId: "t1", recovered: 3, inbound: 1 }]);
  assert.equal(audits.length, 1);
  assert.match(JSON.stringify(audits[0].fields), /support-bot/);
});

test("sweep: nothing stranded posts nothing, even with other stranded types (log only)", async () => {
  const { repair, audits, ops } = harness({ others: { stripeEventWorkflow: 2 } });
  assert.equal(await repair.sweep(), null);
  assert.equal(audits.length, 0);
  assert.equal(ops.length, 0);
});

test("sweep: other stranded types are reported alongside a repair, never touched", async () => {
  const { repair, audits, ops } = harness({ runs: [run("ticket", "t1")], others: { refundWorkflow: 1 } });
  await repair.sweep();
  assert.ok(!ops.some((o) => o.includes("refund")));
  assert.match(JSON.stringify(audits[0].fields), /refundWorkflow ×1/);
});

test("sweep: a ticket whose row is gone is skipped and counted", async () => {
  const { repair } = harness({ runs: [run("ticket", "gone"), run("ticket", "t2")] });
  const r = await repair.sweep();
  assert.equal(r?.gone, 1);
  assert.deepEqual(r?.repaired.map((t) => t.threadId), ["t2"]);
});

test("one ticket: its own run and its conversation's inbox run go, then the heal", async () => {
  const { repair, ops } = harness({ links: { c1: "t1" } });
  const r = await repair.repairTicket("t1");
  assert.deepEqual(ops.slice(0, 3), ["terminate:ticket-t1", "terminate:icx-c1", "repair:t1"]);
  assert.deepEqual(r, { terminated: 2, recovered: 3, inbound: 1 });
});
