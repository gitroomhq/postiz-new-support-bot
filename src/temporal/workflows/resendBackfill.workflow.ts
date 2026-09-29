import { proxyActivities } from "@temporalio/workflow";
import type { CoreActivities } from "../types";

// The Resend delivery log's one-month import: pages GET /emails newest first
// and stores each email's last status. Started once per "Register webhook"
// press, never by ensureBaseline (it is not a looper).

// Paging a month of team mail at the client's throttle takes minutes; the
// activity heartbeats per page and resumes from the last cursor on retry.
const heavy = proxyActivities<CoreActivities>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const control = proxyActivities<CoreActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export async function resendBackfillWorkflow(): Promise<string> {
  try {
    return await heavy.resendBackfill();
  } catch (error) {
    const err = error as { message?: string; cause?: { message?: string } } | null;
    const message = err?.cause?.message ?? err?.message ?? String(error);
    await control.resendBackfillRecord(`failed: ${message}`).catch(() => {});
    throw error;
  }
}
