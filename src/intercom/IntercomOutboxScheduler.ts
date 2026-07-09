import * as Sentry from "@sentry/node";
import { IntercomOutboxEvent } from "../generated/prisma/client";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomClient, IntercomHttpError } from "./IntercomClient";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService } from "./IntercomSyncService";
import { IntercomEventExecutor } from "./IntercomEventExecutor";
import { log } from "../util/logger";
import { withTickSpan, wasCaptured, metricCount, metricGauge, SPAN_STATUS_ERROR } from "../util/instrument";

const CHECK_INTERVAL_MS = 5 * 1000;
const BATCH_LIMIT = 25;
const CALL_SPACING_MS = 300;
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// Echo-part rows only matter while a webhook for them can still arrive.
const ECHO_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ECHO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Pending-post reservations are crash leftovers after this long.
const PENDING_POST_RETENTION_MS = 60 * 60 * 1000;

// The executor bodies (ensure ladder, message/status/priority/csat pushes,
// echo bookkeeping) moved to IntercomEventExecutor so the Temporal delivery
// activity shares them; re-exported constants keep old import paths working.
export { TICKET_ATTR_PRIORITY, TICKET_ATTR_CSAT, TICKET_ATTR_THREAD, CONVERSATION_TAG, CONV_ATTR_ORIGIN } from "./IntercomEventExecutor";

// Drains the intercom_outbox: per tick it takes the head event of each ticket
// queue (per-ticket FIFO — a failing event blocks only its own ticket) and
// executes the corresponding Intercom API calls. All transient failures retry
// with exponential backoff; permanent ones dead-letter with an audit warning.
// LEGACY PATH: runs only while temporalEnabled is off; the Temporal regime
// replaces this queue with per-ticket workflow state.
export class IntercomOutboxScheduler {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private lastEchoCleanupAt = 0;
  private schedLog = log.child("intercom:outbox");
  private lastDepthGaugeAt = 0;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger,
    private executor: IntercomEventExecutor
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        if (!wasCaptured(err)) this.schedLog.error("tick failed", err);
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // Mode "none" or missing connection: leave events queued; draining resumes
    // as soon as the bridge is re-enabled in /config. Overlap guard because a
    // slow batch can outlast the interval.
    if (this.draining) return;
    if (this.settingsStore.intercomMode() === "none" || !this.settingsStore.intercomConfigured()) return;

    this.draining = true;
    try {
      if (Date.now() - this.lastEchoCleanupAt > ECHO_CLEANUP_INTERVAL_MS) {
        this.lastEchoCleanupAt = Date.now();
        await this.store.cleanupEchoParts(new Date(Date.now() - ECHO_RETENTION_MS)).catch(() => {});
        await this.store.cleanupPendingPosts(new Date(Date.now() - PENDING_POST_RETENTION_MS)).catch(() => {});
      }
      // Queue depth gauge at most once a minute — this polls every 5 seconds.
      if (Date.now() - this.lastDepthGaugeAt > 60_000) {
        this.lastDepthGaugeAt = Date.now();
        const counts = await this.store.counts().catch(() => null);
        if (counts) {
          metricGauge("intercom.outbox.queue_depth", counts.pending);
          metricGauge("intercom.outbox.dead_letters", counts.dead);
        }
      }
      const due = await this.store.listDueHeads(BATCH_LIMIT);
      if (due.length === 0) return;
      // Span only ticks with actual work (a 5s poller would otherwise emit
      // ~17k empty transactions per day).
      await withTickSpan("intercom-outbox", async () => {
        Sentry.getActiveSpan()?.setAttribute("queue.batch_size", due.length);
        for (const event of due) {
          await this.processEvent(event);
          await sleep(CALL_SPACING_MS);
        }
      });
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: IntercomOutboxEvent): Promise<void> {
    // One child span per queue event; the Intercom fetches nest underneath.
    await Sentry.startSpan(
      {
        name: `outbox.${event.type}`,
        op: "queue.process",
        attributes: {
          "queue.event_id": event.id,
          "queue.event_type": event.type,
          "ticket.thread_id": event.ticketThreadId,
          "queue.attempts": event.attempts,
        },
      },
      async (span) => {
        try {
          await this.execute(event);
          await this.store.markSuccess(event.id);
          metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "ok" });
        } catch (e) {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "processing_failed" });
          await this.handleFailure(event, e);
        }
      }
    );
  }

  private async handleFailure(event: IntercomOutboxEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof IntercomHttpError && error.status === 404 && event.type !== "ensure") {
      // A linked remote object was deleted in Intercom. Figure out which half
      // died, self-heal inline (shared executor logic), then retry this event
      // on the next pass.
      const ticket = await this.ticketStore.getByThreadId(event.ticketThreadId);
      if (ticket) {
        try {
          await this.selfHeal404(event);
        } catch (healError) {
          this.schedLog.error("404 self-heal failed", healError, { "ticket.thread_id": event.ticketThreadId });
        }
        await this.retryOrDie(event, `404 — remote object recreated, retrying: ${message}`);
        return;
      }
    }

    const transient =
      !(error instanceof IntercomHttpError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500;

    if (!transient) {
      await this.store.markDead(event.id, message);
      this.schedLog.warn("intercom.outbox.dead_letter", {
        "queue.event_id": event.id,
        "queue.event_type": event.type,
        "ticket.thread_id": event.ticketThreadId,
        "queue.attempts": event.attempts,
        "error.message": message.slice(0, 512),
        "queue.reason": "permanent_error",
      });
      metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "dead" });
      void this.audit.log({
        title: "🌉 Intercom push failed",
        severity: "warn",
        actor: "Intercom bridge",
        threadId: event.ticketThreadId,
        fields: [
          { name: "Event", value: event.type, inline: true },
          { name: "Error", value: message.slice(0, 1024), inline: false },
        ],
      });
      return;
    }

    const retryAfterMs =
      error instanceof IntercomHttpError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : null;
    await this.retryOrDie(event, message, retryAfterMs);
  }

  private async retryOrDie(event: IntercomOutboxEvent, message: string, retryAfterMs?: number | null): Promise<void> {
    const attempts = event.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markDead(event.id, message);
      this.schedLog.warn("intercom.outbox.dead_letter", {
        "queue.event_id": event.id,
        "queue.event_type": event.type,
        "ticket.thread_id": event.ticketThreadId,
        "queue.attempts": attempts,
        "error.message": message.slice(0, 512),
        "queue.reason": "max_attempts",
      });
      metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "dead" });
      void this.audit.log({
        title: "🌉 Intercom push dead-lettered",
        severity: "warn",
        actor: "Intercom bridge",
        threadId: event.ticketThreadId,
        fields: [
          { name: "Event", value: event.type, inline: true },
          { name: "Attempts", value: String(attempts), inline: true },
          { name: "Error", value: message.slice(0, 1024), inline: false },
        ],
      });
      return;
    }
    const backoff = retryAfterMs ?? Math.min(5000 * 2 ** attempts, MAX_BACKOFF_MS);
    await this.store.markRetry(event.id, attempts, new Date(Date.now() + backoff), message);
    metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "retry" });
  }

  private async execute(event: IntercomOutboxEvent): Promise<void> {
    await this.executor.execute(event.ticketThreadId, event.type as never, event.payload as unknown);
  }

  private async selfHeal404(event: IntercomOutboxEvent): Promise<void> {
    await this.executor.selfHeal404(event.ticketThreadId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
