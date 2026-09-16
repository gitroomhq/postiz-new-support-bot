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
  kbRefreshNowSignal,
  moneyOutRunNowSignal,
  sentryFeedbackRunNowSignal,
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

// Activity failures arrive wrapped ("Activity task failed" around the real
// cause), and a timeout carries no cause at all, so both layers are read.
// Deterministic: every input comes from workflow history.
function describeActivityFailure(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } } | null;
  const outer = err?.message ?? String(e);
  const inner = err?.cause?.message;
  return inner ? `${outer}: ${inner}` : outer;
}

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

// Shared proxy for the workspace-scoped Intercom sweeps (SLA safety sweep +
// SLA enforcement): each pages every open conversation with pacing + per-item
// Intercom writes, so it needs the long start-to-close + heartbeat budget.
const inactivityActs = proxyActivities<CoreActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 }, // the next tick retries naturally
});

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

// Sentry feedback → Intercom import: poll for new User Feedback widget
// submissions and create Intercom conversations (agents reply there; Intercom
// emails the submitter). 15-minute safety-net cadence — the POST
// /sentry/webhook endpoint fires the runNow signal for near-real-time
// imports. Gates (enabled/configured/watermark) re-read inside the activity,
// so /config changes apply on the next tick.
export async function sentryFeedbackWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(sentryFeedbackRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    const force = runNow;
    runNow = false;
    // A timeout kills the activity server-side, so the tick's own error
    // stamping never runs and the failure would live ONLY in this workflow's
    // history (which nothing in Discord can read). Hand the reason to a tiny
    // activity so /config can show it.
    await inactivityActs.sentryFeedbackTick(force).catch(async (e) => {
      await light.sentryFeedbackTickFailed(describeActivityFailure(e)).catch(() => {});
    });
    await canIfDue(() => continueWithMemo<typeof sentryFeedbackWorkflow>());
    await condition(() => runNow, 15 * 60_000);
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

// Dispute console: HOURLY tick. The cadence is set by the two time-critical
// jobs, not by the expensive ones: a due auto-resolve must fire close to the
// veto window a human was promised, and an evidence package must be submitted
// before its deadline rather than up to six hours after it.
//
// The expensive Stripe work did NOT become hourly. The 90-day reconcile and the
// ratio sweeps stay on a 6h cadence behind a persisted cursor inside the tick
// body (see DisputeMonitor.tick), so this buys timeliness without multiplying
// Stripe reads by six. Evidence-due reminders keep their own damper of at most
// one ping per dispute per 24h. /config's "Run now" signals it and bypasses the
// cursor.
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
    await condition(() => runNow, 60 * 60_000);
  }
}

// Money-out ledger reconcile: 30-minute tick that walks Stripe's balance
// transactions forward from the stored cursor. This is the SAFETY NET, not the
// primary path — the Stripe webhook calls syncForObject so a refund (including
// one issued straight from the Stripe Dashboard) lands within seconds. What
// this tick adds is everything a webhook cannot deliver: Stripe fees, the
// chargeback fee, and any event lost while the endpoint was unreachable.
// The enabled gate re-reads from BotSettings inside the activity.
export async function moneyOutWorkflow(): Promise<void> {
  let runNow = false;
  setHandler(moneyOutRunNowSignal, () => {
    runNow = true;
  });
  for (;;) {
    runNow = false;
    await disputesActs.moneyOutTick().catch(() => {});
    await canIfDue(() => continueWithMemo<typeof moneyOutWorkflow>());
    await condition(() => runNow, 30 * 60_000);
  }
}
