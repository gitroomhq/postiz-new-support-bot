import {
  ActivityFailure,
  allHandlersFinished,
  ApplicationFailure,
  condition,
  continueAsNew,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  CoreActivities,
  InboundEventSignal,
  InboxCarry,
  IntercomDeliveryInput,
  IntercomDeliveryResult,
  IntercomFailureDetails,
} from "../types";
import { inboundEventSignal } from "./definitions";

// ---- Outbound delivery (child of ticketWorkflow, one per queued event) ----

// The retry loop lives in WORKFLOW code (not activity RetryPolicy) so it can
// replicate the legacy outbox policy exactly — Retry-After, permanent-4xx
// short-circuit, dead-letter audit — with every attempt visible in history.
const MAX_DELIVERY_ATTEMPTS = 10;
const MAX_DELIVERY_BACKOFF_MS = 15 * 60 * 1000;

const exec = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "45 seconds",
  retry: { maximumAttempts: 1 }, // the workflow loop owns retries
});

const audit = proxyActivities<CoreActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export async function intercomDeliveryWorkflow(input: IntercomDeliveryInput): Promise<IntercomDeliveryResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      await exec.executeIntercomEvent(input);
      return { outcome: "ok" };
    } catch (e) {
      if (isCancellation(e)) throw e;
      const { details, message } = classifyFailure(e);
      if (details?.permanent || attempt >= MAX_DELIVERY_ATTEMPTS) {
        await audit.intercomDeadLetterAudit({
          threadId: input.threadId,
          type: input.event.type,
          attempts: attempt,
          message,
        });
        return { outcome: "dead", error: message };
      }
      // Legacy backoff: min(5000 · 2^attempts, 15min), Retry-After wins.
      const backoff =
        details?.retryAfterSeconds != null
          ? details.retryAfterSeconds * 1000
          : Math.min(5000 * 2 ** attempt, MAX_DELIVERY_BACKOFF_MS);
      await sleep(backoff);
    }
  }
}

// The activity throws ApplicationFailure with IntercomFailureDetails as
// details[0]; anything else (crash, timeout) counts as transient.
function classifyFailure(e: unknown): { details: IntercomFailureDetails | null; message: string } {
  if (e instanceof ActivityFailure && e.cause instanceof ApplicationFailure) {
    const details = (e.cause.details?.[0] ?? null) as IntercomFailureDetails | null;
    return { details, message: e.cause.message ?? "intercom delivery failed" };
  }
  return { details: null, message: e instanceof Error ? e.message : String(e) };
}

// ---- Inbound (per-conversation, replaces the intercom_inbox queue) ----

// Separate defer accounting: echo-deferral must never burn the real retry
// budget (the activity's own RetryPolicy handles transient failures).
const MAX_DEFERS = 24;
const DEFER_BACKOFF_MS = 10 * 1000;
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SEEN_RING_SIZE = 50;
const HISTORY_SOFT_LIMIT = 10_000;

const inbound = proxyActivities<CoreActivities>({
  startToCloseTimeout: "1 minute",
  // Legacy: min(2000 · 2^attempts, 5min), max 8 real attempts.
  retry: {
    initialInterval: "4 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 8,
  },
});

export async function intercomInboxWorkflow(input: { conversationId: string; carry?: InboxCarry }): Promise<void> {
  const queue: InboundEventSignal[] = input.carry?.queue ?? [];
  const seen: string[] = input.carry?.seenDeliveryIds ?? [];

  setHandler(inboundEventSignal, (p) => {
    // Intercom sends each webhook at most twice — the ring buffer replaces the
    // legacy deliveryId unique-column dedup.
    if (p.deliveryId) {
      if (seen.includes(p.deliveryId)) return;
      seen.push(p.deliveryId);
      if (seen.length > SEEN_RING_SIZE) seen.shift();
    }
    queue.push(p);
  });

  for (;;) {
    const got = await condition(() => queue.length > 0, IDLE_TIMEOUT_MS);
    if (!got) break; // idle — complete; the next webhook starts a fresh run

    const evt = queue[0];
    for (let defer = 0; ; defer++) {
      try {
        await inbound.processInboundEvent({ topic: evt.topic, payload: evt.payload, deferAttempts: defer });
        break;
      } catch (e) {
        if (isCancellation(e)) throw e;
        if (isDeferEcho(e) && defer < MAX_DEFERS) {
          await sleep(DEFER_BACKOFF_MS);
          continue;
        }
        await inbound.inboundDeadLetterAudit({
          topic: evt.topic,
          attempts: defer > 0 ? defer : 8,
          message: failureMessage(e),
        });
        break;
      }
    }
    queue.shift();

    if (workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > HISTORY_SOFT_LIMIT) {
      await condition(allHandlersFinished);
      await continueAsNew<typeof intercomInboxWorkflow>({
        conversationId: input.conversationId,
        carry: { queue, seenDeliveryIds: seen },
      });
    }
  }
  await condition(allHandlersFinished);
}

// DeferEchoError is rethrown by the activity as a NON-retryable
// ApplicationFailure(type: "DeferEcho") so the workflow owns the defer loop.
function isDeferEcho(e: unknown): boolean {
  return e instanceof ActivityFailure && e.cause instanceof ApplicationFailure && e.cause.type === "DeferEcho";
}

function failureMessage(e: unknown): string {
  if (e instanceof ActivityFailure && e.cause instanceof Error) return e.cause.message;
  return e instanceof Error ? e.message : String(e);
}
