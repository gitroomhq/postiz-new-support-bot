import * as Sentry from "@sentry/node";
import { IntercomInboxEvent } from "../generated/prisma/client";
import { AuditLogger } from "../bot/AuditLogger";
import { Logger } from "../util/logger";
import { IntercomStore } from "./IntercomStore";
import { DeferEchoError, IntercomWebhookHandler } from "./IntercomWebhookHandler";
import { withTickSpan, wasCaptured, metricCount, SPAN_STATUS_ERROR } from "../util/instrument";

const CHECK_INTERVAL_MS = 2 * 1000;
const BATCH_LIMIT = 25;
const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
// Echo-defer retries are cheap and time-sensitive — short fixed backoff.
const DEFER_BACKOFF_MS = 10 * 1000;

// Drains the intercom_inbox (durable inbound webhook queue) in seq order.
// The HTTP route only inserts rows; all real handling happens here, with
// retry/backoff, so a crash mid-handle no longer loses Intercom's single
// redelivery. Rows are independent — a failing event delays only itself
// (handlers are convergent/damped, so cross-event ordering inversions under
// retry are acceptable).
export class IntercomInboxScheduler {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private log = new Logger("intercom:inbox");

  constructor(
    private store: IntercomStore,
    private handler: IntercomWebhookHandler,
    private audit: AuditLogger
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        if (!wasCaptured(err)) this.log.error("tick failed", err);
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = await this.store.listDueInbound(BATCH_LIMIT);
      if (due.length === 0) return;
      // Span only ticks with actual work — this polls every 2 seconds.
      await withTickSpan("intercom-inbox", async () => {
        Sentry.getActiveSpan()?.setAttribute("queue.batch_size", due.length);
        for (const event of due) {
          await this.processEvent(event);
        }
      });
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: IntercomInboxEvent): Promise<void> {
    await Sentry.startSpan(
      {
        name: `inbox.${event.topic}`,
        op: "queue.process",
        attributes: {
          "queue.event_id": event.id,
          "queue.event_topic": event.topic,
          "queue.attempts": event.attempts,
        },
      },
      async (span) => {
        try {
          await this.handler.process(event.topic, event.payload, event.attempts);
          await this.store.deleteInbound(event.id);
          metricCount("intercom.inbox.processed", 1, { topic: event.topic, outcome: "ok" });
        } catch (e) {
          if (e instanceof DeferEchoError) {
            await this.store.markInboundRetry(
              event.id,
              event.attempts + 1,
              new Date(Date.now() + DEFER_BACKOFF_MS),
              e.message
            );
            metricCount("intercom.inbox.processed", 1, { topic: event.topic, outcome: "defer" });
            return;
          }
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "processing_failed" });
          const message = e instanceof Error ? e.message : String(e);
          const attempts = event.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await this.store.markInboundDead(event.id, message);
            this.log.error("inbound event dead-lettered", e, {
              "queue.event_topic": event.topic,
              "queue.attempts": attempts,
            });
            metricCount("intercom.inbox.processed", 1, { topic: event.topic, outcome: "dead" });
            void this.audit.log({
              title: "🌉 Intercom inbound event dead-lettered",
              severity: "warn",
              actor: "Intercom bridge",
              fields: [
                { name: "Topic", value: event.topic, inline: true },
                { name: "Attempts", value: String(attempts), inline: true },
                { name: "Error", value: message.slice(0, 1024), inline: false },
              ],
            });
            return;
          }
          const backoff = Math.min(2000 * 2 ** attempts, MAX_BACKOFF_MS);
          await this.store.markInboundRetry(event.id, attempts, new Date(Date.now() + backoff), message);
          metricCount("intercom.inbox.processed", 1, { topic: event.topic, outcome: "retry" });
        }
      }
    );
  }
}
