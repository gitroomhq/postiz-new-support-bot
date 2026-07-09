import { isCancellation, proxyActivities } from "@temporalio/workflow";
import type { AiRunInput, AutoAnswerInput, CoreActivities } from "../types";

// AI runs wrap a spawned Claude CLI (or a direct Messages call) in ONE
// heartbeating activity — a CLI run is not resumable mid-stream and a silent
// retry would double-post, so maximumAttempts is 1 and failure repair is a
// separate step.

const autoAnswer = proxyActivities<CoreActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "90 seconds",
  retry: { maximumAttempts: 1 },
});

const staffRun = proxyActivities<CoreActivities>({
  // CLI hard timeout is 300s; slack for context gathering + final sends.
  startToCloseTimeout: "8 minutes",
  heartbeatTimeout: "90 seconds",
  retry: { maximumAttempts: 1 },
});

const repair = proxyActivities<CoreActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

const scoring = proxyActivities<CoreActivities>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 1 },
});

// Child of ticketWorkflow: the customer-facing first answer streamed into the
// thread. In-activity failures are already repaired by the activity itself
// (thread embed + staff ping); this catch covers hard activity death
// (heartbeat timeout / worker crash) where at least the staff ping must fire.
export async function autoAnswerWorkflow(input: AutoAnswerInput): Promise<{ ok: boolean; apiLimit: boolean }> {
  try {
    return await autoAnswer.runAutoAnswer(input);
  } catch (e) {
    if (isCancellation(e)) throw e;
    await repair.pingStaffForNewTicket(input.threadId).catch(() => {});
    return { ok: false, apiLimit: false };
  }
}

// /ai ask|cause|draft|summarize. The workflow id (ai-run-{userId}) with
// REJECT_DUPLICATE IS the per-user mutex — a second /ai while one runs gets
// WorkflowExecutionAlreadyStarted at the producer and a friendly reply.
export async function aiRunWorkflow(input: AiRunInput): Promise<void> {
  // User-facing error handling happens inside the activity (it owns the
  // ephemeral reply); a hard activity death simply ends the run.
  await staffRun.runStaffAiCommand(input);
}

// /config "Score one now" — one direct (non-batch) scoring call.
export async function scoreOneWorkflow(input: { threadId: string }): Promise<string> {
  return await scoring.scoreOneNow(input.threadId);
}
