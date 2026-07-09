import { proxyActivities } from "@temporalio/workflow";
import type { CoreActivities, StatusChangeInput, StatusChangeResult } from "../types";

// One child workflow per status change, so every transition is individually
// visible and replayable in the Temporal UI. The transition itself runs as ONE
// activity delegating to StatusService.applyStatusDirect — the exact same
// implementation the legacy path uses (rate-limit-graced thread edits,
// claim-gated CSAT prompt, Intercom mirror via the sync seam), so the two
// regimes can never drift apart. Serialization comes from the parent ticket
// workflow's status chain.

const apply = proxyActivities<CoreActivities>({
  // editWithGrace bounds each Discord edit at ~3s; DB writes + notice sends
  // fit comfortably. Single attempt: the body is a mix of best-effort sends
  // (legacy fire-and-forget semantics) — a blind retry could double-post the
  // customer notice.
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export async function statusChangeWorkflow(input: StatusChangeInput): Promise<StatusChangeResult> {
  return await apply.statusApplyDirect(input);
}
