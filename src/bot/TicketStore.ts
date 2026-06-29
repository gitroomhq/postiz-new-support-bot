import { PrismaClient, Ticket, StatusTag } from "../generated/prisma/client";

export type TicketWithTag = Ticket & { statusTag: StatusTag | null };

export interface CreateTicketInput {
  threadId: string;
  channelId: string;
  statusTagId: string;
  customerId?: string | null;
  customerDisplayName?: string | null;
  categoryId?: string | null;
}

export class TicketStore {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateTicketInput): Promise<Ticket> {
    return this.prisma.ticket.create({
      data: {
        threadId: input.threadId,
        channelId: input.channelId,
        statusTagId: input.statusTagId,
        customerId: input.customerId ?? null,
        customerDisplayName: input.customerDisplayName ?? null,
        categoryId: input.categoryId ?? null,
      },
    });
  }

  async getByThreadId(threadId: string): Promise<TicketWithTag | null> {
    return this.prisma.ticket.findUnique({
      where: { threadId },
      include: { statusTag: true },
    });
  }

  async setStatus(threadId: string, statusTagId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: { statusTagId, lastStatusChangeAt: new Date(), lastReminderAt: null, reminderCount: 0 },
    });
  }

  async recordReminder(threadId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: { lastReminderAt: new Date(), reminderCount: { increment: 1 } },
    });
  }

  async close(threadId: string): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { closed: true } });
  }

  // Open tickets whose current status has reminders enabled.
  async listRemindable(): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { closed: false, statusTag: { reminderEnabled: true } },
      include: { statusTag: true },
    });
  }

  async existsForThread(threadId: string): Promise<boolean> {
    return (await this.prisma.ticket.count({ where: { threadId } })) > 0;
  }
}
