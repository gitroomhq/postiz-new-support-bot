import type { Client, WorkflowExecutionDescription } from "@temporalio/client";
import { WorkflowNotFoundError } from "@temporalio/common";
import { LOOPER_GEN_MEMO_KEY, LOOPER_GENERATIONS } from "./types";

// Generation reconcile for the eternal looper singletons (see the
// LOOPER_GENERATIONS comment in types.ts): a running singleton whose memo
// generation differs from the code's is history-incompatible with this bundle
// — terminate it so ensureBaseline's signal-with-start brings up a fresh run
// on the new shape. Termination is server-side, so this works even on a run
// already wedged with nondeterminism task failures.

export interface LooperReconcileResult {
  action: "kept" | "terminated" | "absent";
  // Why a run was terminated: a generation change, or a workflow task that has
  // been failing long enough that the run will never make progress again.
  cause: "generation" | "wedged" | null;
  runningGen: number | null;
  wantedGen: number;
  health: LooperHealth;
}

// A looper whose workflow task keeps failing stays RUNNING forever: it never
// schedules its activity again and signals pile up unread, so every symptom
// the app could report (a stale sync stamp, a silent Sync Now) points at the
// feature rather than at the loop that stopped driving it. The classic cause
// is a replay that turned nondeterministic under a new bundle, which is what
// the generation bump exists for — but that only helps when someone KNOWS to
// bump it. This is the safety net for when nobody does: loopers hold no state
// between iterations, so terminating a wedged run and letting the
// signal-with-start below re-create it is always safe.
//
// A healthy looper is asleep on its timer with NO pending workflow task, and a
// task that is merely slow is retried within seconds, so "still retrying the
// same task minutes later" is not something a working loop does.
const WEDGE_MIN_ATTEMPTS = 5;
const WEDGE_MIN_AGE_MS = 5 * 60_000;

export interface LooperHealth {
  // RUNNING / COMPLETED / TERMINATED / … , or "absent" when there is no run.
  status: string;
  // Pending workflow-task attempt (0 = none pending, which is the healthy
  // steady state for a looper sitting on its interval timer).
  taskAttempt: number;
  taskScheduledAt: Date | null;
  wedged: boolean;
}

export const ABSENT_LOOPER: LooperHealth = {
  status: "absent",
  taskAttempt: 0,
  taskScheduledAt: null,
  wedged: false,
};

// Health straight off a DescribeWorkflowExecution response. Exported for the
// reconcile below, which already holds one (describing twice would double the
// boot's RPCs for no new information).
export function looperHealthOf(desc: WorkflowExecutionDescription): LooperHealth {
  const status = desc.status.name;
  const pending = desc.raw?.pendingWorkflowTask;
  const attempt = Number(pending?.attempt ?? 0);
  const scheduledSeconds = pending?.scheduledTime?.seconds;
  const taskScheduledAt = scheduledSeconds != null ? new Date(Number(scheduledSeconds) * 1000) : null;
  return {
    status,
    taskAttempt: Number.isFinite(attempt) ? attempt : 0,
    taskScheduledAt,
    wedged:
      status === "RUNNING" &&
      attempt >= WEDGE_MIN_ATTEMPTS &&
      taskScheduledAt != null &&
      Date.now() - taskScheduledAt.getTime() >= WEDGE_MIN_AGE_MS,
  };
}

// Current state of a singleton. Feeds the /config health line, so an absent or
// unreachable run is a value, never a throw.
export async function describeLooper(client: Client, workflowId: string): Promise<LooperHealth> {
  try {
    return looperHealthOf(await client.workflow.getHandle(workflowId).describe());
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return ABSENT_LOOPER;
    throw e;
  }
}

// wantedGen is a parameter (not a LOOPER_GENERATIONS lookup) so tests can
// drive bumps without editing the map.
export async function reconcileLooperGeneration(
  client: Client,
  workflowId: string,
  wantedGen: number
): Promise<LooperReconcileResult> {
  const handle = client.workflow.getHandle(workflowId);
  try {
    const desc = await handle.describe();
    const health = looperHealthOf(desc);
    if (desc.status.name !== "RUNNING") return { action: "absent", cause: null, runningGen: null, wantedGen, health };
    const raw = desc.memo?.[LOOPER_GEN_MEMO_KEY];
    // Pre-mechanism runs carry no memo — treat as generation 0 (restart once).
    const runningGen = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    // !== rather than <: a HIGHER running generation (rollback deploy) is just
    // as history-incompatible with this bundle; restart in both directions.
    if (runningGen !== wantedGen) {
      await handle.terminate(`looper generation ${runningGen} -> ${wantedGen}`);
      return { action: "terminated", cause: "generation", runningGen, wantedGen, health };
    }
    if (health.wedged) {
      await handle.terminate(`looper wedged: workflow task attempt ${health.taskAttempt}`);
      return { action: "terminated", cause: "wedged", runningGen, wantedGen, health };
    }
    return { action: "kept", cause: null, runningGen, wantedGen, health };
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) {
      return { action: "absent", cause: null, runningGen: null, wantedGen, health: ABSENT_LOOPER };
    }
    throw e;
  }
}

// Start options stamping the code generation into a fresh singleton's memo.
// Memo is ignored by signalWithStart when the run already exists — correct:
// only fresh starts define their generation.
export const looperStartOptions = (workflowId: string): { memo: Record<string, number> } => ({
  memo: { [LOOPER_GEN_MEMO_KEY]: LOOPER_GENERATIONS[workflowId] ?? 1 },
});

// Terminate a retired singleton if it is still running (idempotent: absent /
// already-closed runs are a no-op). Retired workflow types are no longer in
// the bundle, so a surviving run would wedge on its next workflow task — the
// boot-time retire is what keeps the namespace clean without Temporal-UI
// access on the deploy host.
export async function retireWorkflowId(client: Client, workflowId: string, reason: string): Promise<boolean> {
  const handle = client.workflow.getHandle(workflowId);
  try {
    const desc = await handle.describe();
    if (desc.status.name !== "RUNNING") return false;
    await handle.terminate(reason);
    return true;
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return false;
    throw e;
  }
}

// Visibility sweep for retired children orphaned by a crash race (parent-close
// TERMINATE normally takes them down with the parent). Returns the number of
// runs terminated.
export async function retireByQuery(client: Client, query: string, reason: string): Promise<number> {
  let terminated = 0;
  for await (const wf of client.workflow.list({ query })) {
    try {
      await client.workflow.getHandle(wf.workflowId, wf.runId).terminate(reason);
      terminated++;
    } catch (e) {
      if (!(e instanceof WorkflowNotFoundError)) throw e;
    }
  }
  return terminated;
}
