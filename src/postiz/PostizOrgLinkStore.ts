import { PrismaClient } from "../generated/prisma/client";

// Organization to Stripe customer mapping, learned by observation.
//
// Neither system volunteers this link: the platform's Stripe customer carries
// no metadata pointing back at the organization, and the platform's search
// endpoint does not return paymentId. A backend Sentry event carries both ids
// at once, so the bot records the pair whenever it happens to read one.
export class PostizOrgLinkStore {
  constructor(private prisma: PrismaClient) {}

  // Idempotent. A pair seen again bumps the counter and the timestamp; a pair
  // that CONTRADICTS what we hold overwrites it, because the newer event is by
  // definition the more current truth (an org's customer can legitimately
  // change, for instance after the customer object is recreated).
  async record(orgId: string, stripeCustomerId: string): Promise<void> {
    if (!orgId || !stripeCustomerId.startsWith("cus_")) return;
    const now = new Date();
    await this.prisma.postizOrgLink.upsert({
      where: { orgId },
      create: { orgId, stripeCustomerId, firstSeenAt: now, lastSeenAt: now },
      update: { stripeCustomerId, lastSeenAt: now, observations: { increment: 1 } },
    });
  }

  // Convenience for the callers that hold a whole identity and do not want to
  // care whether it happened to carry both halves.
  async recordIdentity(identity: { orgId: string | null; stripeCustomerId: string | null }): Promise<void> {
    if (!identity.orgId || !identity.stripeCustomerId) return;
    await this.record(identity.orgId, identity.stripeCustomerId);
  }

  customerForOrg(orgId: string): Promise<{ stripeCustomerId: string; lastSeenAt: Date } | null> {
    return this.prisma.postizOrgLink.findUnique({
      where: { orgId },
      select: { stripeCustomerId: true, lastSeenAt: true },
    });
  }

  // Reverse direction. Not unique: an org's customer can be replaced over time,
  // so a customer id can appear against more than one organization.
  orgsForCustomer(stripeCustomerId: string): Promise<Array<{ orgId: string; lastSeenAt: Date }>> {
    return this.prisma.postizOrgLink.findMany({
      where: { stripeCustomerId },
      orderBy: { lastSeenAt: "desc" },
      select: { orgId: true, lastSeenAt: true },
    });
  }

  count(): Promise<number> {
    return this.prisma.postizOrgLink.count();
  }

  async list(page: number, pageSize: number): Promise<{ rows: Array<{ orgId: string; stripeCustomerId: string; lastSeenAt: Date; observations: number }>; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.postizOrgLink.findMany({
        orderBy: { lastSeenAt: "desc" },
        skip: page * pageSize,
        take: pageSize,
        select: { orgId: true, stripeCustomerId: true, lastSeenAt: true, observations: true },
      }),
      this.prisma.postizOrgLink.count(),
    ]);
    return { rows, total };
  }
}
