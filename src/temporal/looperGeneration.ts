import type { Client } from "@temporalio/client";
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
  runningGen: number | null;
  wantedGen: number;
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
    if (desc.status.name !== "RUNNING") return { action: "absent", runningGen: null, wantedGen };
    const raw = desc.memo?.[LOOPER_GEN_MEMO_KEY];
    // Pre-mechanism runs carry no memo — treat as generation 0 (restart once).
    const runningGen = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    // !== rather than <: a HIGHER running generation (rollback deploy) is just
    // as history-incompatible with this bundle; restart in both directions.
    if (runningGen === wantedGen) return { action: "kept", runningGen, wantedGen };
    await handle.terminate(`looper generation ${runningGen} -> ${wantedGen}`);
    return { action: "terminated", runningGen, wantedGen };
  } catch (e) {
    if (e instanceof WorkflowNotFoundError) return { action: "absent", runningGen: null, wantedGen };
    throw e;
  }
}

// Start options stamping the code generation into a fresh singleton's memo.
// Memo is ignored by signalWithStart when the run already exists — correct:
// only fresh starts define their generation.
export const looperStartOptions = (workflowId: string): { memo: Record<string, number> } => ({
  memo: { [LOOPER_GEN_MEMO_KEY]: LOOPER_GENERATIONS[workflowId] ?? 1 },
});
