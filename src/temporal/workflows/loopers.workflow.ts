import {
  allHandlersFinished,
  condition,
  continueAsNew,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { CoreActivities } from "../types";
import { kbRefreshNowSignal, scoringRunNowSignal } from "./definitions";

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

const scoringActs = proxyActivities<CoreActivities>({
  // Batch submit fetches up to 200 transcripts with pacing.
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // next 60s tick retries naturally
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
    await canIfDue(() => continueAsNew<typeof kbRefreshWorkflow>());
    await condition(() => refreshNow, 60_000);
  }
}

// Scoring: poll in-flight Anthropic batches every minute; submit when the
// interval elapses / backfill pending (all decided inside the activity, which
// is a verbatim port of ScoringScheduler.tick()).
export async function scoringLoopWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(scoringRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    await scoringActs.scoringTick().catch(() => {});
    await canIfDue(() => continueAsNew<typeof scoringLoopWorkflow>());
    await condition(() => runNow, 60_000);
    runNow = false;
  }
}

// Influx gauge snapshots every 5 minutes (no-op while Influx inactive).
export async function metricsSnapshotWorkflow(): Promise<void> {
  for (;;) {
    await light.snapshotTick().catch(() => {});
    await canIfDue(() => continueAsNew<typeof metricsSnapshotWorkflow>());
    await condition(() => false, 5 * 60_000);
  }
}

// 5-minute sweep: expired pending auths, old Stripe webhook dedup rows,
// Intercom echo/pending-post retention, ticket AI-run history purge.
export async function cleanupLoopWorkflow(): Promise<void> {
  for (;;) {
    await light.cleanupTick().catch(() => {});
    await canIfDue(() => continueAsNew<typeof cleanupLoopWorkflow>());
    await condition(() => false, 5 * 60_000);
  }
}
