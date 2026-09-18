import { RESPONDABLE_DISPUTE_STATUSES } from "../../bot/billing/DisputeStore";
import { DashboardCtx, DashboardSectionModule, SectionPage, validId } from "./types";
import { DisputesDeps, notFound } from "./disputes/cells";
import { disputeAction } from "./disputes/actions";
import { list } from "./disputes/list";
import { detail } from "./disputes/detail";
import { libraryPage } from "./disputes/library";

// Disputes: the overview (ratio strip, due-date board, All list, Proposals,
// History), the evidence library behind the pack, and the detail page, which is
// the actual working surface: build the pack, read what it produced, submit.
// All evidence mutations run through the shared DisputeEvidenceService, the
// exact code behind /billing → Disputes, so both surfaces stay in lockstep.
//
// The page bodies live in ./disputes/*; this is the wiring: which page belongs
// to whom, and where an action goes.

export type { DisputesDeps } from "./disputes/cells";

export function makeDisputesSection(deps: DisputesDeps): DashboardSectionModule {
  return {
    nav: [{ key: "disputes", label: "Disputes", page: "disputes" }],

    ownsPage(page: string): boolean {
      return (
        page === "disputes" ||
        page === "disputes.detail" ||
        // Folded into the pages below, still routed so a bookmark from before
        // the merge lands on the thing it was pointing at rather than a 404.
        page === "disputes.review" ||
        page === "disputes.library" ||
        page === "disputes.templates" ||
        page === "disputes.documents"
      );
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const filters = req.filters ?? {};
      const cursor = req.cursor ?? null;
      if (req.page === "disputes") return list(ctx, deps, filters, cursor);
      if (req.page === "disputes.library") return libraryPage(deps, filters, cursor);
      // The two former editor pages are now tabs of one library page. Their
      // URLs open it on the tab they used to be.
      if (req.page === "disputes.templates") return libraryPage(deps, filters, cursor, "");
      if (req.page === "disputes.documents") return libraryPage(deps, filters, cursor, "documents");
      const id = validId("dispute", req.params?.id);
      if (!id) return notFound("That dispute id is not valid (dp_/du_…).");
      // The staged read-back is the detail page's body now; the old URL is the
      // same destination rather than a dead one.
      return detail(ctx, deps, id);
    },

    async action(ctx: DashboardCtx, req) {
      return disputeAction(ctx, deps, req.key, req.params ?? {}, req.confirmWord);
    },

    async navBadge(ctx: DashboardCtx): Promise<string | null> {
      const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
      const needing = counts
        .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
        .reduce((sum, c) => sum + c.count, 0);
      return needing > 0 ? String(needing) : null;
    },
  };
}
