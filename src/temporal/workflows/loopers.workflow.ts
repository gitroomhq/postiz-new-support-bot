import {
  allHandlersFinished,
  condition,
  makeContinueAsNewFunc,
  proxyActivities,
  setHandler,
  workflowInfo,
  type Workflow,
} from "@temporalio/workflow";
import type { CoreActivities } from "../types";
import {
  disputesRunNowSignal,
  inactivityRunNowSignal,
  kbRefreshNowSignal,
  slaEnforceRunNowSignal,
  slaRunNowSignal,
} from "./definitions";

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

const inactivityActs = proxyActivities<CoreActivities>({
  // A sweep pages the whole workspace's open conversations/tickets with
  // pacing + per-item Intercom writes.
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // the next tick retries naturally
});

// Workspace inactivity sweeper: native (unbridged) Intercom conversations +
// tickets get agent-idle reminders (note + reopen) and customer-idle nags with
// auto-close — the automation Intercom itself cannot run on API-created
// conversations (workflow triggers are channel-gated). Bridged tickets are
// excluded here; the per-ticket workflow owns their timers. The activity
// applies the enable/config gate itself, so /config changes take effect on the
// next tick without any looper plumbing.
export async function inactivityLoopWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(inactivityRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    const force = runNow;
    runNow = false;
    await inactivityActs.inactivitySweepTick(force).catch(() => {});
    await canIfDue(() => continueWithMemo<typeof inactivityLoopWorkflow>());
    await condition(() => runNow, 30 * 60_000);
  }
}

// SLA safety sweep: pages the workspace's open conversations and re-runs the
// SLA rules against each (bridged → via thread id, native → directly). Dedup
// in SlaService makes a steady-state sweep read-only; this heals missed
// webhooks (unsubscribed Developer Hub topics), dead-lettered "sla" events,
// mid-flight rule edits (rule mutations fire the runNow signal) and the
// refund exempt→mirrored flip edge. Gates re-read from BotSettings each tick.
export async function slaSweepWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(slaRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    const force = runNow;
    runNow = false;
    await inactivityActs.slaSweepTick(force).catch(() => {});
    await canIfDue(() => continueWithMemo<typeof slaSweepWorkflow>());
    await condition(() => runNow, 30 * 60_000);
  }
}

// Bot-native SLA enforcement + assignment stray sweep (Intercom Advanced has
// no native SLAs or workload management): one paged open-conversation scan
// per tick powers the business-time clocks (SLA Status attribute, breach
// tag + note) AND routes unassigned conversations through the hybrid
// balancer. 5-minute cadence — clock alerts land within ~5 min of the true
// threshold. Gates (slaEnabled / assignEnabled) re-read from BotSettings each
// tick inside the activity.
export async function slaEnforceWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(slaEnforceRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    const force = runNow;
    runNow = false;
    await inactivityActs.slaEnforceTick(force).catch(() => {});
    await canIfDue(() => continueWithMemo<typeof slaEnforceWorkflow>());
    await condition(() => runNow, 5 * 60_000);
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
// Intercom echo/pending-post retention.
export async function cleanupLoopWorkflow(): Promise<void> {
  for (;;) {
    await light.cleanupTick().catch(() => {});
    await canIfDue(() => continueWithMemo<typeof cleanupLoopWorkflow>());
    await condition(() => false, 5 * 60_000);
  }
}

const disputesActs = proxyActivities<CoreActivities>({
  // Reconcile sweeps disputes + per-dispute charge lookups; the ratio check
  // adds a charges.search round-trip per window.
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // the next tick retries naturally
});

// Dispute console: 6h tick (evidence-due reminders keep their own ≤1-ping/24h
// damper per dispute, so the cadence only affects how fast NEW near-due
// disputes are noticed) — reconcile the local mirror against Stripe, post
// reminders, check the ratio thresholds. /config's "Run now" signals it.
export async function disputesLoopWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(disputesRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    const force = runNow;
    runNow = false;
    await disputesActs.disputesTick(force).catch(() => {});
    await canIfDue(() => continueWithMemo<typeof disputesLoopWorkflow>());
    await condition(() => runNow, 6 * 60 * 60_000);
  }
}
