import {
  allHandlersFinished,
  condition,
  executeChild,
  makeContinueAsNewFunc,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
  type Workflow,
} from "@temporalio/workflow";
import type { CoreActivities, ScoringBatchInput } from "../types";
import { scoringBatchWorkflowId } from "../types";
import { kbRefreshNowSignal, scoringEscalationRunNowSignal, scoringRunNowSignal } from "./definitions";

// Interval-based recurring jobs as eternal looping workflows (user decision:
// Schedules only for the wall-clock status report). Each iteration reads its
// config through the activity, so /config interval changes apply on the next
// tick without any Schedule-update plumbing. Continue-As-New keeps histories
// bounded.

const HISTORY_SOFT_LIMIT = 10_000;

const kb = proxyActivities<CoreActivities>({
  // git fetch + reset for two repos on a slow network.
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "90 seconds",
  retry: { maximumAttempts: 1 }, // per-repo failure tolerance lives inside
});

const scoringQuick = proxyActivities<CoreActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

const scoringSubmitActs = proxyActivities<CoreActivities>({
  // Batch submit fetches up to 200 transcripts with pacing.
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // next 60s tick retries naturally
});

const scoringPollActs = proxyActivities<CoreActivities>({
  // A poll that finds the batch ended also fetches + processes every result
  // (Discord lookups, score rows, Influx) — give it room.
  startToCloseTimeout: "15 minutes",
  retry: { initialInterval: "5 seconds", maximumAttempts: 2 },
});

const light = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

async function canIfDue(makeNext: () => Promise<never> | Promise<void>): Promise<void> {
  if (workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > HISTORY_SOFT_LIMIT) {
    await condition(allHandlersFinished);
    await makeNext();
  }
}

// Continue-As-New preserving the run's memo: plain continueAsNew() sends
// memo undefined, which would drop the looper generation stamp (and the
// scoring batch's purpose memo) on the next run.
function continueWithMemo<F extends Workflow>(...args: Parameters<F>): Promise<never> {
  return makeContinueAsNewFunc<F>({ memo: workflowInfo().memo })(...args);
}

// KB refresh: the activity applies the kbRefreshEnabled/interval due-check
// itself (legacy KnowledgeBaseScheduler semantics); the loop just provides the
// 60s cadence + the manual-refresh signal from /config.
export async function kbRefreshWorkflow(): Promise<void> {
  let refreshNow = false;
  setHandler(kbRefreshNowSignal, () => {
    refreshNow = true;
  });
  for (;;) {
    const force = refreshNow;
    refreshNow = false;
    await kb.kbTick(force).catch(() => {});
    await canIfDue(() => continueWithMemo<typeof kbRefreshWorkflow>());
    await condition(() => refreshNow, 60_000);
  }
}

// Scoring: each Anthropic Message Batch runs as its OWN child workflow
// (scoring-batch-<id>) so the whole lifecycle — submit, every poll round-trip,
// the moment results come back and get processed — is visible per batch in the
// Temporal UI. The loop keeps the legacy invariants: one batch in flight,
// 60s cadence, interval/backfill due-check, Run-Scoring-Now signal. The daily
// escalation re-score batch rides the same loop: regular work wins a shared
// tick, escalation submits on a later one (adoption covers both kinds).
export async function scoringLoopWorkflow(): Promise<void> {
  let runNow = false;
  let escalationNow = false;
  setHandler(scoringRunNowSignal, () => {
    runNow = true;
  });
  setHandler(scoringEscalationRunNowSignal, () => {
    escalationNow = true;
  });
  for (;;) {
    // Capture-and-clear BOTH flags up front: a flag left set while disabled
    // would make the condition() below return immediately — a 0s hot loop.
    const force = runNow;
    runNow = false;
    const escForce = escalationNow;
    escalationNow = false;
    try {
      const state = await scoringQuick.scoringGetState();
      if (state.enabled) {
        // Adopt in-flight batches first (restart / Continue-As-New / import —
        // a CAN terminates running children, so the fresh run re-adopts any
        // batch that is still SUBMITTED in Postgres). Awaited sequentially:
        // one batch in flight is the invariant.
        for (const batchId of state.pendingBatchIds) {
          await watchBatch(batchId, "adopted");
        }
        if (state.due || state.backfill || force) {
          const purpose = state.backfill ? "backfill" : "interval";
          const r = await scoringSubmitActs.scoringSubmit(purpose);
          if (r.batchId) await watchBatch(r.batchId, purpose);
          // A manual escalation press preempted by a due regular batch is
          // re-armed (only reachable while enabled, so it cannot hot-loop).
          if (escForce) escalationNow = true;
        } else if (state.escalationDue || escForce) {
          const r = await scoringSubmitActs.scoringSubmit("escalation");
          if (r.batchId) await watchBatch(r.batchId, "escalation");
        }
      }
    } catch {
      // transient (activity budget exhausted) — the next tick retries
    }
    await canIfDue(() => continueWithMemo<typeof scoringLoopWorkflow>());
    await condition(() => runNow || escalationNow, 60_000);
  }
}

async function watchBatch(batchId: string, purpose: string): Promise<void> {
  try {
    await executeChild(scoringBatchWorkflow, {
      workflowId: scoringBatchWorkflowId(batchId),
      args: [{ batchId }],
      // UI context only (memo needs no registration and cannot fail a start).
      memo: { batchId, purpose },
    });
  } catch {
    // duplicate id / child failure — the batch stays SUBMITTED in Postgres and
    // is re-adopted on the next loop pass; never wedge the loop.
  }
}

const BATCH_POLL_INTERVAL_MS = 60_000;
// Anthropic ends every Message Batch within 24h (later, expired results 404
// and pollBatchOnce fails the batch). 26h is the backstop for a batch stuck
// reporting "running" so the child can never poll — and block the
// one-batch-in-flight loop — forever.
const BATCH_DEADLINE_MS = 26 * 60 * 60 * 1000;

// One Anthropic batch, cradle to grave: a poll activity every minute until the
// batch ends, then the same activity fetches + processes the results. The
// workflow history IS the batch timeline; Continue-As-New carries the poll
// count + deadline when a long batch nears the history limit.
export async function scoringBatchWorkflow(input: ScoringBatchInput): Promise<{ outcome: string; polls: number }> {
  // Date.now() is deterministic workflow time; captured once, CAN-stable.
  const deadlineAtMs = input.deadlineAtMs ?? Date.now() + BATCH_DEADLINE_MS;
  let polls = input.polls ?? 0;
  for (;;) {
    polls++;
    const r = await scoringPollActs.scoringPollBatch(input.batchId);
    if (r.status !== "running") return { outcome: r.status, polls };
    if (Date.now() >= deadlineAtMs) {
      await scoringQuick.scoringExpireBatch(input.batchId).catch(() => {});
      return { outcome: "timeout", polls };
    }
    await canIfDue(() =>
      continueWithMemo<typeof scoringBatchWorkflow>({ batchId: input.batchId, polls, deadlineAtMs })
    );
    await sleep(BATCH_POLL_INTERVAL_MS);
  }
}

// Influx gauge snapshots every 5 minutes (no-op while Influx inactive).
export async function metricsSnapshotWorkflow(): Promise<void> {
  for (;;) {
    await light.snapshotTick().catch(() => {});
    await canIfDue(() => continueWithMemo<typeof metricsSnapshotWorkflow>());
    await condition(() => false, 5 * 60_000);
  }
}

// 5-minute sweep: expired pending auths, old Stripe webhook dedup rows,
// Intercom echo/pending-post retention, ticket AI-run history purge.
export async function cleanupLoopWorkflow(): Promise<void> {
  for (;;) {
    await light.cleanupTick().catch(() => {});
    await canIfDue(() => continueWithMemo<typeof cleanupLoopWorkflow>());
    await condition(() => false, 5 * 60_000);
  }
}
