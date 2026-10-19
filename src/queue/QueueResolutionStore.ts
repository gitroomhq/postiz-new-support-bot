import type { PrismaClient } from "../generated/prisma/client";
import type { QueueResolution, QueueResolutions } from "./QueueData";

// The tickets marked resolved on the Intercom Queue (queue_resolutions).
// QueueData reads them once at boot and writes each resolve and restore
// before it changes the list, so a failed write never hides a ticket that
// would come back after a restart.

// Far more than a team marks by hand; past it the oldest are not loaded.
const MAX_LOADED = 10_000;

export type QueueResolutionDb = Pick<PrismaClient, "queueResolution">;

export class QueueResolutionStore implements QueueResolutions {
  constructor(private db: QueueResolutionDb) {}

  async list(): Promise<QueueResolution[]> {
    const rows = await this.db.queueResolution.findMany({ orderBy: { resolvedAt: "desc" }, take: MAX_LOADED });
    return rows.map((r) => ({
      conversationId: r.conversationId,
      lastContactAt: r.lastContactAt,
      note: r.note,
      title: r.title,
      ticketNumber: r.ticketNumber,
      customer: r.customer,
      resolvedById: r.resolvedById,
      resolvedByName: r.resolvedByName,
      resolvedAt: r.resolvedAt.getTime(),
    }));
  }

  async put(r: QueueResolution): Promise<void> {
    const data = {
      // Every mark holds until restored; the column is left from when a mark
      // could end with the customer's next message.
      untilReply: false,
      lastContactAt: r.lastContactAt,
      note: r.note,
      title: r.title,
      ticketNumber: r.ticketNumber,
      customer: r.customer,
      resolvedById: r.resolvedById,
      resolvedByName: r.resolvedByName,
      resolvedAt: new Date(r.resolvedAt),
    };
    await this.db.queueResolution.upsert({
      where: { conversationId: r.conversationId },
      create: { conversationId: r.conversationId, ...data },
      update: data,
    });
  }

  async remove(conversationIds: string[]): Promise<void> {
    if (!conversationIds.length) return;
    await this.db.queueResolution.deleteMany({ where: { conversationId: { in: conversationIds } } });
  }
}
