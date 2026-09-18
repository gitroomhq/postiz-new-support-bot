import { proxyActivities, setHandler } from "@temporalio/workflow";
import type { AnalyticsRebuildStats, CoreActivities } from "../types";
import { analyticsRebuildProgressQuery } from "./definitions";

// The full analytics rebuild: wipe the rebuildable InfluxDB measurements,
// re-walk every Stripe datasource into the Postgres mirrors, and re-emit.
//
// In its own file rather than in loopers.workflow.ts, because it is NOT a
// looper: it runs once per press, it is generation-free, and everything in that
// file is read on the assumption that it ticks forever.
//
// Phase order is REPAIR → WIPE → RE-EMIT. See AnalyticsRebuildService for why
// wiping first would be worse in three separate ways; the short version is that
// a Stripe walk dying at 60% must leave the bucket untouched.

// Control-plane steps: quick, and safe to retry.
const control = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

// Preflight and the wipe. maximumAttempts: 1 because both fail DETERMINISTICALLY
// when they fail — a deployment with no delete endpoint will not grow one on
// the second attempt, and burning five retries only delays the error reaching
// the person who pressed the button.
const guard = proxyActivities<CoreActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

// The long phases. An all-time Stripe walk against a busy account pages for a
// long time, so these heartbeat per page and are given room to finish.
const heavy = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 hours",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export async function analyticsRebuildWorkflow(): Promise<AnalyticsRebuildStats | null> {
  let phase = "starting";
  let stats: AnalyticsRebuildStats | null = null;
  setHandler(analyticsRebuildProgressQuery, () => ({ phase, stats }));

  // Recorded from the workflow, not from an activity, so it is deterministic
  // across replays. The catch-up phase re-emits everything the mirrors changed
  // after this moment, which is how live webhook writes during the run are
  // picked up despite emission being suppressed for most of it.
  const startedAtMs = Date.now();

  try {
    // Before anything is touched: is the delete endpoint reachable and are we
    // allowed to use it? Finding out after the repair has run would leave a
    // rewritten mirror and an un-wiped bucket.
    phase = "preflight";
    await guard.analyticsRebuildPreflight();
    await control.analyticsRebuildBegin();

    phase = "repair";
    stats = await heavy.analyticsRebuildRepair(emptyStats());

    phase = "wipe";
    stats = await guard.analyticsRebuildWipe(stats);

    phase = "reemit";
    stats = await heavy.analyticsRebuildReemit(stats);

    phase = "catchup";
    stats = await heavy.analyticsRebuildCatchUp(stats, startedAtMs);

    phase = "gauges";
    await control.analyticsRebuildGauges();

    phase = "done";
    await control.analyticsRebuildFinish(stats, null);
    await control.analyticsRebuildReport(stats, null);
    return stats;
  } catch (error) {
    const message = describeFailure(error);
    phase = "failed";
    // Both of these must run even though the workflow is failing: finish clears
    // the emission gate and the single-flight lock, and without it every money
    // point stays suppressed until someone notices. A `finally` would not cover
    // a terminate, which is why the service also re-checks the flag at boot.
    await control.analyticsRebuildFinish(stats, message).catch(() => {});
    await control.analyticsRebuildReport(stats, message).catch(() => {});
    throw error;
  }
}

// Activity failures arrive wrapped ("Activity task failed" around the real
// cause), and a timeout carries no cause at all, so both layers are read.
// Deterministic: every input comes from workflow history.
function describeFailure(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } } | null;
  const outer = err?.message ?? String(e);
  const inner = err?.cause?.message;
  return inner && inner !== outer ? `${outer}: ${inner}` : outer;
}

function emptyStats(): AnalyticsRebuildStats {
  return {
    moneyScanned: 0,
    moneyCreated: 0,
    moneyRepaired: 0,
    creditNotes: 0,
    writeOffs: 0,
    discountRows: 0,
    invoicesScanned: 0,
    retiredEstimates: 0,
    disputesSwept: 0,
    disputeClosedAtImproved: 0,
    churnScanned: 0,
    churnCreated: 0,
    churnUsdBackfilled: 0,
    deleted: [],
    droppedLines: 0,
    points: 0,
    catchUpPoints: 0,
    truncated: false,
  };
}
