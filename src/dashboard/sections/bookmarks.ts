import type { BillingObjectType } from "../../bot/billing/BillingQolStore";
import { ActionButton, ActionResult } from "../renderer/contract";
import { DashboardCtx } from "./types";

// Bookmark-everything (user ask): one shared button + action handler
// so every detail page offers the shared-team bookmark. Each section keeps
// its own "section:<area>.bookmark" key (section actions route by page
// ownership) but delegates here; the Bookmarks board routes rows back via
// cells.refForId, which covers every prefix below.

export const BOOKMARK_ID_RES: Record<BillingObjectType, RegExp> = {
  dispute: /^(dp|du)_[A-Za-z0-9]{1,64}$/,
  customer: /^cus_[A-Za-z0-9]{1,64}$/,
  charge: /^(ch|py)_[A-Za-z0-9]{1,64}$/,
  subscription: /^sub_[A-Za-z0-9]{1,64}$/,
  invoice: /^in_[A-Za-z0-9]{1,64}$/,
  payout: /^po_[A-Za-z0-9]{1,64}$/,
  link: /^plink_[A-Za-z0-9]{1,64}$/,
  quote: /^qt_[A-Za-z0-9]{1,64}$/,
  product: /^prod_[A-Za-z0-9]{1,64}$/,
};

export function isBookmarkType(v: unknown): v is BillingObjectType {
  return typeof v === "string" && v in BOOKMARK_ID_RES;
}

// Read the flag without ever failing the page build (DB down → un-bookmarked
// button; the toggle itself would surface the real error).
export async function isBookmarkedSafe(ctx: DashboardCtx, type: BillingObjectType, id: string): Promise<boolean> {
  try {
    return await ctx.stores.qol.isBookmarked(type, id);
  } catch {
    return false;
  }
}

export function bookmarkButton(actionKey: string, bookmarked: boolean, id: string, label?: string | null): ActionButton {
  return {
    key: actionKey,
    label: bookmarked ? "Remove bookmark" : "Bookmark",
    params: { id, ...(label ? { label: label.slice(0, 80) } : {}) },
    summary: bookmarked
      ? "Removes this from the shared team bookmark board."
      : "Adds this to the shared team bookmark board (Operate → Bookmarks).",
  };
}

// T0 toggle. The label snapshots the page's display name at bookmark time.
export async function toggleBookmarkAction(
  ctx: DashboardCtx,
  type: BillingObjectType,
  p: Record<string, unknown>
): Promise<ActionResult> {
  const id = typeof p.id === "string" && BOOKMARK_ID_RES[type].test(p.id) ? p.id : null;
  if (!id) return { ok: false, error: "Bad id." };
  const label = typeof p.label === "string" && p.label.trim() ? p.label.trim().slice(0, 80) : null;
  const r = await ctx.stores.qol.toggleBookmark(type, id, label, ctx.actor.id, ctx.actor.name);
  return { ok: true, text: r.bookmarked ? "Bookmarked for the team." : "Bookmark removed." };
}
