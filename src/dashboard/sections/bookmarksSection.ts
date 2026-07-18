import { Block, Cell, ObjectRef, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { badgeCell, idCell, isoDateCell, sentence, text } from "./cells";

// Team bookmarks (#/bookmarks, Operate group): the shared board over
// BillingQolStore — one list for the whole team, rows deep-link into the
// typed detail pages. Saved filters were considered and SKIPPED (palette
// recents already cover the cheap version; server persistence isn't worth it).

const PAGE_SIZE = 25;

const REF_PAGES: Record<string, string> = {
  dispute: "disputes.detail",
  customer: "customers.detail",
  charge: "payments.detail",
};

export function makeBookmarksSection(): DashboardSectionModule {
  return {
    nav: [{ key: "bookmarks", label: "Bookmarks", page: "bookmarks", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "bookmarks";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const offset = /^\d{1,6}$/.test(req.cursor ?? "") ? Number(req.cursor) : 0;
      const { rows, total } = await ctx.stores.qol.listBookmarks(offset, PAGE_SIZE);
      const table: TableBlock = {
        type: "table",
        key: "bookmarks",
        columns: [
          { key: "type", label: "Type" },
          { key: "label", label: "Bookmark" },
          { key: "id", label: "ID" },
          { key: "by", label: "Added by" },
          { key: "when", label: "When" },
        ],
        rows: rows.map((b) => {
          const page = REF_PAGES[b.objectType];
          const ref: ObjectRef | undefined = page ? { page, params: { id: b.objectId } } : undefined;
          return {
            id: b.id,
            ...(ref ? { ref } : {}),
            cells: [
              badgeCell("neutral", sentence(b.objectType)),
              text(b.label ?? b.objectId),
              idCell(b.objectId, { copy: true, ...(ref ? { ref } : {}) }),
              text(b.addedByName),
              isoDateCell(b.createdAt),
            ] as Cell[],
            actions: [
              {
                key: "section:bookmarks.remove",
                label: "Remove",
                params: { type: b.objectType, id: b.objectId },
              },
            ],
          };
        }),
        nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
        empty: "Nothing bookmarked yet — use the Bookmark action on a dispute, customer or payment.",
        ...(rows.length ? { footer: `${rows.length} of ${total} bookmark${total === 1 ? "" : "s"}` } : {}),
        notice: "One shared list for the whole team.",
      };
      const blocks: Block[] = [table];
      return { title: "Bookmarks", crumbs: [{ label: "Bookmarks" }], blocks };
    },

    async action(ctx: DashboardCtx, req) {
      if (req.key !== "section:bookmarks.remove") return { ok: false, error: "Unknown action." };
      const p = req.params ?? {};
      const type = str(p.type, 20);
      const id = str(p.id, 80);
      if (!REF_PAGES[type] || !id) return { ok: false, error: "Bad bookmark." };
      // toggleBookmark on an existing entry removes it (shared-list semantics).
      const r = await ctx.stores.qol.toggleBookmark(type as "dispute" | "customer" | "charge", id, null, ctx.actor.id, ctx.actor.name);
      return { ok: true, text: r.bookmarked ? "Bookmarked." : "Bookmark removed." };
    },
  };
}
