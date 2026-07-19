import type Stripe from "stripe";
import type { HomeMetrics } from "../metrics/HomeMetrics";
import { AttentionItem, Badge, Block, Cell, ObjectRef } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage } from "./types";
import { badgeCell, refForId, sentence, strong, text } from "./cells";

// Home v1+charts: the needs-attention inbox (disputes closing in, queued
// approvals, charge reviews, fresh early-fraud warnings), account stat tiles,
// the five home charts (lazily hydrated via the series endpoint) and the
// recent-activity feed from Stripe events. The view build stays ≤4 direct
// Stripe calls — charts and the active-subs count come from HomeMetrics'
// 10-minute cache. The inbox computation is shared with the topbar bell via
// computeAttention — one implementation feeds both surfaces.

const DUE_SOON_HOURS = 72;
const EFW_WINDOW_HOURS = 72;

const CHART_WINDOWS = new Set(["7d", "30d", "90d"]);

// One needs-attention entry, renderable as an inbox table row (label/sub +
// badge + when) or a bell AttentionItem. whenUnknown = the entry has no real
// timestamp (pending charge reviews) — the table shows "—" for it.
export interface AttentionEntry {
  id: string;
  label: string;
  sub?: string;
  badge: Badge;
  iso: string;
  ref: ObjectRef;
  whenUnknown?: boolean;
}

// The shared inbox computation. Also returns the raw counts so Home's stat
// tiles don't re-fetch what this already read.
export async function computeAttention(
  ctx: DashboardCtx
): Promise<{ entries: AttentionEntry[]; approvalsTotal: number; reviewCount: number }> {
  const [efws, approvals, reviewCount, openDisputes] = await Promise.all([
    ctx.stripe.listRecentEarlyFraudWarnings(50).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]),
    ctx.billing.actions.pendingPage(0, 5).catch(() => ({ rows: [], total: 0 })),
    ctx.stores.session.countPendingChargeReviews().catch(() => 0),
    ctx.stores.dispute.listOpen(0, 10).catch(() => ({ rows: [], total: 0 })),
  ]);

  const now = Date.now();
  const entries: AttentionEntry[] = [];

  for (const d of openDisputes.rows) {
    if (!d.evidenceDueBy) continue;
    const hoursLeft = (d.evidenceDueBy.getTime() - now) / 3_600_000;
    if (hoursLeft > DUE_SOON_HOURS) continue;
    const overdue = hoursLeft < 0;
    entries.push({
      id: `dispute-${d.id}`,
      label: `Dispute ${ctx.stripe.formatAmount(d.amount, d.currency)} — ${d.reason.replace(/_/g, " ")}`,
      sub: d.id,
      badge: { kind: "error", text: overdue ? "Evidence OVERDUE" : `Due in ${Math.max(1, Math.round(hoursLeft))}h` },
      iso: d.evidenceDueBy.toISOString(),
      ref: { page: "disputes.detail", params: { id: d.id } },
    });
  }

  for (const a of approvals.rows) {
    entries.push({
      id: `approval-${a.id}`,
      label: a.summary,
      sub: `requested by ${a.requestedByName} · ${a.origin}`,
      badge: { kind: a.status === "FAILED" ? "error" : "warn", text: a.status === "FAILED" ? "Failed — retry" : "Awaiting approval" },
      iso: a.createdAt.toISOString(),
      ref: { page: "approvals" },
    });
  }

  if (reviewCount > 0) {
    entries.push({
      id: "charge-reviews",
      label: `${reviewCount} blocked self-service refund${reviewCount === 1 ? "" : "s"} waiting for review`,
      badge: { kind: "warn", text: "Charge review" },
      iso: new Date(now).toISOString(),
      ref: { page: "approvals" },
      whenUnknown: true,
    });
  }

  for (const w of efws.slice(0, 10)) {
    const ageHours = (now - w.created * 1000) / 3_600_000;
    if (ageHours > EFW_WINDOW_HOURS) continue;
    const chargeId = typeof w.charge === "string" ? w.charge : w.charge.id;
    entries.push({
      id: `efw-${w.id}`,
      label: `Early fraud warning on ${chargeId}`,
      sub: w.fraud_type.replace(/_/g, " "),
      badge: { kind: "error", text: w.actionable ? "Actionable" : "EFW" },
      iso: new Date(w.created * 1000).toISOString(),
      ref: { page: "payments.detail", params: { id: chargeId } },
    });
  }

  return { entries, approvalsTotal: approvals.total, reviewCount };
}

export function makeHomeSection(deps: { metrics: HomeMetrics }): DashboardSectionModule {
  return {
    nav: [{ key: "home", label: "Home", page: "home" }],

    ownsPage(page: string): boolean {
      return page === "home";
    },

    // Bell feed: the SAME inbox entries, newest-first cap applied by
    // the Dashboard collector.
    async attention(ctx: DashboardCtx): Promise<AttentionItem[]> {
      const { entries } = await computeAttention(ctx);
      return entries.map((e) => ({
        label: e.sub ? `${e.label} · ${e.sub}` : e.label,
        badge: e.badge,
        iso: e.iso,
        ref: e.ref,
      }));
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const window = CHART_WINDOWS.has(req.filters?.window ?? "") ? req.filters!.window : "30d";
      const [balance, subCount, events, inbox] = await Promise.all([
        ctx.stripe.getBalance().catch(() => null),
        deps.metrics.activeSubsCount().catch(() => null),
        ctx.stripe.listEvents(12).catch(() => [] as Stripe.Event[]),
        computeAttention(ctx),
      ]);

      const blocks: Block[] = [];

      // ---- stat tiles ----
      const fmtBuckets = (buckets: Array<{ amount: number; currency: string }> | undefined): string => {
        const parts = (buckets ?? []).filter((b) => b.amount !== 0).map((b) => ctx.stripe.formatAmount(b.amount, b.currency));
        return parts.join(" + ") || (buckets?.length ? ctx.stripe.formatAmount(0, buckets[0].currency) : "—");
      };
      const openApprovals = inbox.approvalsTotal + inbox.reviewCount;
      blocks.push({
        type: "stats",
        items: [
          { label: "Available balance", value: balance ? fmtBuckets(balance.available) : "—" },
          { label: "Pending", value: balance ? fmtBuckets(balance.pending) : "—" },
          {
            label: "Active subscriptions",
            value: subCount ? `${subCount.count}${subCount.truncated ? "+" : ""}` : "counting…",
            ...(subCount ? {} : { sub: "full sweep running — refresh in a minute" }),
          },
          {
            label: "Open approvals",
            value: String(openApprovals),
            ...(openApprovals > 0 ? { badge: { kind: "warn", text: "action needed" } as Badge } : {}),
            ref: { page: "approvals" },
          },
        ],
      });

      // ---- needs-attention inbox (shared with the bell) ----
      const inboxRows: Array<{ id: string; cells: Cell[]; ref?: ObjectRef }> = inbox.entries.map((e) => ({
        id: e.id,
        ref: e.ref,
        cells: [
          strong(e.label, e.sub),
          badgeCell(e.badge.kind, e.badge.text),
          e.whenUnknown ? text("—") : ({ t: "date", v: e.iso.slice(0, 10), iso: e.iso } as Cell),
        ],
      }));

      blocks.push({
        type: "table",
        key: "inbox",
        title: "Needs attention",
        columns: [
          { key: "what", label: "Item" },
          { key: "status", label: "Status" },
          { key: "when", label: "When" },
        ],
        // The window pill steers the charts below (7d/30d/90d).
        filters: [
          {
            key: "window",
            label: "Chart window",
            kind: "select",
            value: window === "30d" ? undefined : window,
            options: [
              { value: "7d", label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
              { value: "90d", label: "Last 90 days" },
            ],
          },
        ],
        rows: inboxRows,
        empty: "Nothing needs attention — disputes, approvals and fraud warnings show up here.",
        ...(inboxRows.length ? { footer: `${inboxRows.length} item${inboxRows.length === 1 ? "" : "s"}` } : {}),
      });

      // ---- the five home charts (hydrated lazily via the series endpoint) ----
      blocks.push(
        { type: "chart", key: "gross_volume", title: "Gross volume", kind: "area", window },
        { type: "chart", key: "new_customers", title: "New customers", kind: "bars", window },
        { type: "chart", key: "failed_payments", title: "Failed payments", kind: "bars", window },
        { type: "chart", key: "mrr_by_plan", title: "MRR estimate by plan", kind: "bars", window },
        { type: "chart", key: "dispute_ratio", title: "Dispute ratio (monthly)", kind: "line", window }
      );

      // ---- recent activity (Stripe events) ----
      blocks.push({
        type: "timeline",
        title: "Recent activity",
        items: events.map((e) => {
          const obj = e.data.object as { id?: string; amount?: number; currency?: string };
          const amountText =
            typeof obj.amount === "number" && typeof obj.currency === "string"
              ? ` · ${ctx.stripe.formatAmount(obj.amount, obj.currency)}`
              : "";
          const ref = obj.id ? refForId(obj.id) : null;
          return {
            label: sentence(e.type.replace(/[._]/g, " ")) + amountText,
            iso: new Date(e.created * 1000).toISOString(),
            ...(obj.id ? { text: obj.id } : {}),
            ...(ref ? { ref } : {}),
            kind: e.type.includes("failed") || e.type.includes("dispute") ? ("error" as const) : ("info" as const),
          };
        }),
      });

      return { title: "Home", crumbs: [{ label: "Home" }], blocks };
    },
  };
}
