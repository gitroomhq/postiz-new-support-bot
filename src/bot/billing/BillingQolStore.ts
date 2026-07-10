import { BillingBookmark, BillingNote, PrismaClient } from "../../generated/prisma/client";

export type BillingObjectType = "dispute" | "customer" | "charge";

// Team-visible notes + the shared bookmark board for billing objects
// (disputes/customers/charges). Notes mirror the ticket_notes shape; the
// bookmark board is one global list (unique per object), not per-admin.
export class BillingQolStore {
  constructor(private prisma: PrismaClient) {}

  // ---- Notes ----

  async addNote(
    objectType: BillingObjectType,
    objectId: string,
    authorId: string,
    authorName: string,
    text: string
  ): Promise<BillingNote> {
    return this.prisma.billingNote.create({ data: { objectType, objectId, authorId, authorName, text } });
  }

  async listNotes(
    objectType: BillingObjectType,
    objectId: string,
    skip = 0,
    take = 10
  ): Promise<{ rows: BillingNote[]; total: number }> {
    const where = { objectType, objectId };
    const [rows, total] = await Promise.all([
      this.prisma.billingNote.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      this.prisma.billingNote.count({ where }),
    ]);
    return { rows, total };
  }

  async latestNote(objectType: BillingObjectType, objectId: string): Promise<BillingNote | null> {
    return this.prisma.billingNote.findFirst({
      where: { objectType, objectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async countNotes(objectType: BillingObjectType, objectId: string): Promise<number> {
    return this.prisma.billingNote.count({ where: { objectType, objectId } });
  }

  // ---- Bookmarks ----

  // Toggle semantics: returns the new state. The unique (objectType, objectId)
  // makes a concurrent double-toggle land on one of the two valid states.
  async toggleBookmark(
    objectType: BillingObjectType,
    objectId: string,
    label: string | null,
    addedById: string,
    addedByName: string
  ): Promise<{ bookmarked: boolean }> {
    const existing = await this.prisma.billingBookmark.findUnique({
      where: { objectType_objectId: { objectType, objectId } },
    });
    if (existing) {
      await this.prisma.billingBookmark.deleteMany({ where: { id: existing.id } });
      return { bookmarked: false };
    }
    try {
      await this.prisma.billingBookmark.create({ data: { objectType, objectId, label, addedById, addedByName } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error; // raced: someone else just bookmarked it
    }
    return { bookmarked: true };
  }

  async isBookmarked(objectType: BillingObjectType, objectId: string): Promise<boolean> {
    return (
      (await this.prisma.billingBookmark.findUnique({
        where: { objectType_objectId: { objectType, objectId } },
      })) !== null
    );
  }

  async listBookmarks(skip: number, take: number): Promise<{ rows: BillingBookmark[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.billingBookmark.findMany({ orderBy: { createdAt: "desc" }, skip, take }),
      this.prisma.billingBookmark.count(),
    ]);
    return { rows, total };
  }
}
