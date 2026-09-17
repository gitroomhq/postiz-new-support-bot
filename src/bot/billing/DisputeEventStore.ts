import type { PrismaClient, DisputeEvent, Prisma } from "../../generated/prisma/client";
import { exportDisputeEvent } from "../../metrics/MetricsExporter";
import { log } from "../../util/logger";

const eventLog = log.child("dispute-events");

// The per-dispute history stream. Recording is ALWAYS best-effort: a failed
// write here must never take down the thing it was describing. Losing a
// timeline entry is a gap in an explanation; failing a webhook because the
// explanation could not be written is an outage.

export const DISPUTE_EVENT_KINDS = [
  "opened",
  "status_changed",
  "receipt_attached",
  "pack_built",
  "pack_staged",
  "evidence_edited",
  "evidence_submitted",
  "auto_submit_refused",
  "accepted",
  "resolve_proposed",
  "resolve_blocked",
  "resolve_vetoed",
  "resolve_executed",
  "resolve_failed",
  "resolve_superseded",
  "reminder_sent",
  "escalated",
  "note_added",
] as const;
export type DisputeEventKind = (typeof DISPUTE_EVENT_KINDS)[number];

export interface RecordEvent {
  disputeId: string;
  kind: DisputeEventKind;
  summary: string;
  // Omit for anything the bot did on its own. A present actor is a real person,
  // which is exactly the distinction the timeline exists to show.
  actorId?: string | null;
  actorName?: string | null;
  detail?: unknown;
}

export class DisputeEventStore {
  constructor(private prisma: PrismaClient) {}

  async record(event: RecordEvent): Promise<void> {
    try {
      await this.prisma.disputeEvent.create({
        data: {
          disputeId: event.disputeId,
          kind: event.kind,
          summary: event.summary.slice(0, 500),
          actorId: event.actorId ?? null,
          actorName: event.actorName ?? null,
          detail: (event.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      exportDisputeEvent({ kind: event.kind, automated: !event.actorId });
    } catch (error) {
      eventLog.warn("dispute event not recorded", {
        "stripe.dispute_id": event.disputeId,
        "event.kind": event.kind,
        "error.message": String(error),
      });
    }
  }

  // Oldest first: a timeline is read forwards.
  async list(disputeId: string, limit = 200): Promise<DisputeEvent[]> {
    return this.prisma.disputeEvent
      .findMany({ where: { disputeId }, orderBy: { at: "asc" }, take: limit })
      .catch(() => [] as DisputeEvent[]);
  }

  async count(disputeId: string): Promise<number> {
    return this.prisma.disputeEvent.count({ where: { disputeId } }).catch(() => 0);
  }
}
