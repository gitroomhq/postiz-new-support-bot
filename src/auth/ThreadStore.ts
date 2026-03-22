import { PrismaClient } from "../generated/prisma/client";

export class ThreadStore {
  constructor(private prisma: PrismaClient) {}

  async registerThread(threadId: string, guildId: string): Promise<void> {
    await this.prisma.supportThread.upsert({
      where: { threadId },
      create: { threadId, guildId },
      update: {},
    });
  }

  /** Called when a human (non-bot) sends a message in a tracked thread. Resets the warning state. */
  async updateActivity(threadId: string): Promise<void> {
    await this.prisma.supportThread.updateMany({
      where: { threadId, closedAt: null },
      data: { lastActivityAt: new Date(), warningSentAt: null, warningMessageId: null },
    });
  }

  async setWarning(threadId: string, warningMessageId: string): Promise<void> {
    await this.prisma.supportThread.updateMany({
      where: { threadId, closedAt: null },
      data: { warningSentAt: new Date(), warningMessageId },
    });
  }

  /** Reset warning state (e.g. user confirms they still need help). */
  async resetWarning(threadId: string): Promise<void> {
    await this.prisma.supportThread.updateMany({
      where: { threadId, closedAt: null },
      data: { warningSentAt: null, warningMessageId: null, lastActivityAt: new Date() },
    });
  }

  async closeThread(threadId: string): Promise<void> {
    await this.prisma.supportThread.updateMany({
      where: { threadId, closedAt: null },
      data: { closedAt: new Date() },
    });
  }

  /** Threads with no activity for longer than `inactiveSince` and no warning sent yet. */
  async getStaleThreads(inactiveSince: Date): Promise<{ threadId: string; guildId: string }[]> {
    return this.prisma.supportThread.findMany({
      where: {
        closedAt: null,
        warningSentAt: null,
        lastActivityAt: { lt: inactiveSince },
      },
      select: { threadId: true, guildId: true },
    });
  }

  /**
   * Threads where a warning was sent at least `warningSentBefore` ago and nobody responded.
   * Because `updateActivity()` clears `warningSentAt` on any new human message, a non-null
   * `warningSentAt` here means there has been no response since the warning.
   */
  async getTimedOutWarnings(
    warningSentBefore: Date
  ): Promise<{ threadId: string; warningMessageId: string | null }[]> {
    return this.prisma.supportThread.findMany({
      where: {
        closedAt: null,
        warningSentAt: { not: null, lt: warningSentBefore },
      },
      select: { threadId: true, warningMessageId: true },
    });
  }
}
