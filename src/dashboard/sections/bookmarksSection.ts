import { Block, Cell, ObjectRef, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { isBookmarkType, toggleBookmarkAction } from "./bookmarks";
import { badgeCell, idCell, isoDateCell, refForId, sentence, text } from "./cells";

// Team bookmarks (/billing/bookmarks, Operate group): the shared board over
// BillingQolStore — one list for the whole team, rows deep-link into the
// typed detail pages (every object family since the bookmark-everything
// pass; rows route via the shared refForId). Saved filters were considered
// and SKIPPED (palette recents already cover the cheap version).

const PAGE_SIZE = 25;

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
          const ref: ObjectRef | undefined = refForId(b.objectId) ?? undefined;
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
        empty: "Nothing bookmarked yet — every detail page has a Bookmark action.",
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
      if (!isBookmarkType(type)) return { ok: false, error: "Bad bookmark." };
      // toggleBookmark on an existing entry removes it (shared-list semantics).
      return toggleBookmarkAction(ctx, type, p);
    },
  };
}
