import { test } from "node:test";
import assert from "node:assert/strict";
import { StrandedRunRepair, type StrandedRepairDeps } from "../strandedRuns";
import { strandedKey, strandedRunsQuery, type StrandedRun } from "../producers";
import type { AuditEvent } from "../../bot/AuditLogger";

// A run started before the task queue setting changed never runs again and
// silently swallows every signal. Worker start only reports it; /ticket
// repairs one ticket by terminating its runs, then healing it.

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

test("worker start only reports: nothing is terminated or healed, and the tickets are listed", async () => {
  // An automatic bulk repair reopened and unassigned tickets teammates had
  // closed in Intercom; the boot pass must stay read-only.
  const { repair, ops, audits } = harness({
    runs: [run("ticket", "t1"), run("inbox", "c1"), run("inbox", "native")],
    links: { c1: "t1" },
    others: { refundWorkflow: 1 },
  });
  const r = await repair.report();
  assert.deepEqual(ops, []);
  assert.equal(r?.tickets, 1);
  assert.equal(r?.inboxes, 2);
  assert.deepEqual(r?.threads, ["t1"]);
  assert.equal(audits.length, 1);
  const fields = JSON.stringify(audits[0].fields);
  assert.match(fields, /support-bot/);
  assert.match(fields, /<#t1>/);
  assert.match(fields, /refundWorkflow ×1/);
});

test("worker start with nothing stranded posts nothing", async () => {
  const { repair, audits } = harness();
  assert.equal(await repair.report(), null);
  assert.equal(audits.length, 0);
});

test("one ticket: its own run and its conversation's inbox run go, then the heal", async () => {
  const { repair, ops } = harness({ links: { c1: "t1" } });
  const r = await repair.repairTicket("t1");
  assert.deepEqual(ops.slice(0, 3), ["terminate:ticket-t1", "terminate:icx-c1", "repair:t1"]);
  assert.deepEqual(r, { terminated: 2, recovered: 3, inbound: 1 });
});
