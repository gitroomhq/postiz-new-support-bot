import type { PrismaClient, DisputeEvidenceDocument } from "../../../generated/prisma/client";

// The standing evidence documents: the merchant's own published policies,
// uploaded once and attached to every dispute that has an empty slot for them.
//
// Deliberately NOT per dispute. A refund policy is the same document for
// everyone, and a file uploaded to Stripe with purpose dispute_evidence can be
// referenced by any number of disputes, so the upload happens once and each
// dispute costs one more field on an update call it was already making.

// Which Stripe FILE evidence slots may hold a standing document. The generated
// per-dispute documents (a usage log, a support transcript) are a different
// mechanism and deliberately not listed here: those are built from that
// dispute's own facts and cannot be uploaded ahead of time.
export const STANDING_DOCUMENT_SLOTS = [
  { slot: "refund_policy", label: "Refund policy", help: "The published refund policy, as the customer could read it." },
  {
    slot: "cancellation_policy",
    label: "Cancellation policy",
    help: "The published cancellation policy. Stripe shows this to the analyst next to the cancellation disclosure text.",
  },
  {
    slot: "uncategorized_file",
    label: "Terms of service",
    help: "The terms the customer accepted. Stripe has no terms slot, so it travels as the general proof file.",
  },
] as const;

export type StandingDocumentSlot = (typeof STANDING_DOCUMENT_SLOTS)[number]["slot"];

export function isStandingSlot(slot: string): slot is StandingDocumentSlot {
  return STANDING_DOCUMENT_SLOTS.some((s) => s.slot === slot);
}

export interface PutDocumentInput {
  slot: StandingDocumentSlot;
  stripeFileId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  uploadedById: string;
  uploadedByName: string;
}

export class EvidenceDocumentStore {
  constructor(private prisma: PrismaClient) {}

  async list(): Promise<DisputeEvidenceDocument[]> {
    return this.prisma.disputeEvidenceDocument.findMany({ orderBy: { slot: "asc" } });
  }

  // Keyed by slot, for the attach path, which wants a lookup rather than a scan.
  async bySlot(): Promise<Map<string, DisputeEvidenceDocument>> {
    const rows = await this.list();
    return new Map(rows.map((r) => [r.slot, r]));
  }

  // Replacing a policy overwrites the row. Disputes staged before that keep the
  // file they were actually given: the old Stripe file is still referenced by
  // them and must not be deleted.
  async put(input: PutDocumentInput): Promise<void> {
    const { slot, ...rest } = input;
    await this.prisma.disputeEvidenceDocument.upsert({
      where: { slot },
      create: { slot, ...rest, uploadedAt: new Date() },
      update: { ...rest, uploadedAt: new Date() },
    });
  }

  // Stops FUTURE disputes being given this document. Nothing already staged is
  // touched, and the Stripe file stays where it is.
  async remove(slot: string): Promise<boolean> {
    const deleted = await this.prisma.disputeEvidenceDocument.deleteMany({ where: { slot } });
    return deleted.count > 0;
  }
}
