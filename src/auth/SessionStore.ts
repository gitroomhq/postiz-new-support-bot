import { PrismaClient } from "../generated/prisma/client";

export class SessionStore {
  constructor(private prisma: PrismaClient) {}

  async setSession(discordUserId: string, accessToken: string, postizUserId?: string, stripeCustomerId?: string): Promise<void> {
    await this.prisma.userSession.upsert({
      where: { discordUserId },
      update: { accessToken, postizUserId, stripeCustomerId, authenticatedAt: new Date() },
      create: { discordUserId, accessToken, postizUserId, stripeCustomerId },
    });
  }

  async getSession(discordUserId: string) {
    return this.prisma.userSession.findUnique({
      where: { discordUserId },
    });
  }

  // Reverse lookups for /search-tickets. postizUserId/stripeCustomerId are not @unique,
  // so a single id can (in theory) map to several Discord accounts — return all of them.
  async findDiscordIdsByPostizId(postizUserId: string): Promise<string[]> {
    const rows = await this.prisma.userSession.findMany({
      where: { postizUserId },
      select: { discordUserId: true },
    });
    return rows.map((r) => r.discordUserId);
  }

  async findDiscordIdsByStripeId(stripeCustomerId: string): Promise<string[]> {
    const rows = await this.prisma.userSession.findMany({
      where: { stripeCustomerId },
      select: { discordUserId: true },
    });
    return rows.map((r) => r.discordUserId);
  }

  // Batch-resolve sessions for display (Postiz/Stripe id columns) on a page of results.
  async listByDiscordIds(discordUserIds: string[]) {
    if (discordUserIds.length === 0) return [];
    return this.prisma.userSession.findMany({
      where: { discordUserId: { in: discordUserIds } },
    });
  }

  async removeSession(discordUserId: string): Promise<void> {
    await this.prisma.userSession.deleteMany({
      where: { discordUserId },
    });
  }

  async isAuthenticated(discordUserId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findUnique({
      where: { discordUserId },
    });
    return session !== null;
  }

  async addPendingAuth(state: string, discordUserId: string, channelId: string, interactionToken?: string): Promise<void> {
    await this.prisma.pendingAuth.create({
      data: { state, discordUserId, channelId, interactionToken },
    });
  }

  async consumePendingAuth(state: string) {
    const pending = await this.prisma.pendingAuth.findUnique({
      where: { state },
    });

    if (pending) {
      await this.prisma.pendingAuth.delete({ where: { state } });
    }

    return pending;
  }

  async hasBillingAction(invoiceId: string): Promise<boolean> {
    const action = await this.prisma.billingAction.findUnique({
      where: { stripeInvoiceId: invoiceId },
    });
    return action !== null;
  }

  async recordBillingAction(discordUserId: string, invoiceId: string, action: "refund" | "discount"): Promise<void> {
    await this.prisma.billingAction.create({
      data: { discordUserId, stripeInvoiceId: invoiceId, action },
    });
  }

  async cleanExpiredPending(maxAgeMs: number = 10 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await this.prisma.pendingAuth.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  }
}
