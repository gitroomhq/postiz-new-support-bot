import { PrismaClient, ForwardedEmailConvert } from "../generated/prisma/client";

// Ledger accessors for forwarded_email_converts: idempotency by original
// conversation id (webhook retries + canvas double-clicks), reverse lookup by
// the recreated conversation id (self-trigger belt + canvas converted-state),
// and the SLA exemption for reopened originals.
export class ForwardConvertStore {
  constructor(private prisma: PrismaClient) {}

  getByOriginalConversationId(originalConversationId: string): Promise<ForwardedEmailConvert | null> {
    return this.prisma.forwardedEmailConvert.findUnique({ where: { originalConversationId } });
  }

  getByNewConversationId(newConversationId: string): Promise<ForwardedEmailConvert | null> {
    return this.prisma.forwardedEmailConvert.findUnique({ where: { newConversationId } });
  }

  async insertConverted(data: {
    originalConversationId: string;
    newConversationId: string;
    forwarderAdminId: string | null;
    forwarderEmail: string | null;
    customerEmail: string;
    customerName: string | null;
    intercomContactId: string;
    contactRole: string;
    trigger: "auto" | "manual";
    actorLabel: string | null;
    attachmentsCount: number;
  }): Promise<void> {
    await this.prisma.forwardedEmailConvert.create({ data });
  }

  async setAttachmentsReuploaded(originalConversationId: string): Promise<void> {
    await this.prisma.forwardedEmailConvert.update({
      where: { originalConversationId },
      data: { attachmentsReuploaded: true },
    });
  }
}
