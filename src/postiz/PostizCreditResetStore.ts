import { PrismaClient } from "../generated/prisma/client";
import type { PostizCreditType } from "./PostizClient";

export interface PostizCreditResetRow {
  orgId: string;
  orgName: string | null;
  creditType: string;
  // The address the teammate entered to find the organization.
  email: string;
  // Usage rows the platform deleted; null when it did not say.
  restored: number | null;
  actorId: string;
  actorName: string;
  conversationId: string | null;
  createdAt: Date;
}

// Narrow slice the credit service needs, so it can be tested without a
// database.
export interface PostizCreditResetLedger {
  record(row: Omit<PostizCreditResetRow, "createdAt">): Promise<void>;
  last(orgId: string, type: PostizCreditType): Promise<PostizCreditResetRow | null>;
}

// Every AI credit reset support made. The platform keeps no trace of one (it
// deletes the period's usage rows), so this ledger is the only way the next
// teammate can see that an organization was already given its credits back.
export class PostizCreditResetStore implements PostizCreditResetLedger {
  constructor(private prisma: PrismaClient) {}

  async record(row: Omit<PostizCreditResetRow, "createdAt">): Promise<void> {
    await this.prisma.postizCreditReset.create({ data: row });
  }

  last(orgId: string, type: PostizCreditType): Promise<PostizCreditResetRow | null> {
    return this.prisma.postizCreditReset.findFirst({
      where: { orgId, creditType: type },
      orderBy: { createdAt: "desc" },
      select: {
        orgId: true,
        orgName: true,
        creditType: true,
        email: true,
        restored: true,
        actorId: true,
        actorName: true,
        conversationId: true,
        createdAt: true,
      },
    });
  }
}
