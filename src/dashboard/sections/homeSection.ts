import type Stripe from "stripe";
import type { HomeMetrics } from "../metrics/HomeMetrics";
import { Badge, Block, Cell, ObjectRef } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage } from "./types";
import { badgeCell, isoDateCell, sentence, strong, text } from "./cells";

// Home v1+charts: the needs-attention inbox (disputes closing in, queued
// approvals, charge reviews, fresh early-fraud warnings), account stat tiles,
// the five M5 charts (lazily hydrated via the series endpoint) and the
// recent-activity feed from Stripe events. The view build stays ≤4 direct
// Stripe calls — charts and the active-subs count come from HomeMetrics'
// 10-minute cache.

const DUE_SOON_HOURS = 72;
const EFW_WINDOW_HOURS = 72;

const CHART_WINDOWS = new Set(["7d", "30d", "90d"]);

export function makeHomeSection(deps: { metrics: HomeMetrics }): DashboardSectionModule {
  return {
    nav: [{ key: "home", label: "Home", page: "home" }],

    ownsPage(page: string): boolean {
      return page === "home";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const window = CHART_WINDOWS.has(req.filters?.window ?? "") ? req.filters!.window : "30d";
      const [balance, subCount, events, efws, approvals, reviewCount, openDisputes] = await Promise.all([
        ctx.stripe.getBalance().catch(() => null),
        deps.metrics.activeSubsCount().catch(() => null),
        ctx.stripe.listEvents(12).catch(() => [] as Stripe.Event[]),
        ctx.stripe.listRecentEarlyFraudWarnings(50).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]),
        ctx.billing.actions.pendingPage(0, 5).catch(() => ({ rows: [], total: 0 })),
        ctx.stores.session.countPendingChargeReviews().catch(() => 0),
        ctx.stores.dispute.listOpen(0, 10).catch(() => ({ rows: [], total: 0 })),
      ]);

      const blocks: Block[] = [];

      // ---- stat tiles ----
      const fmtBuckets = (buckets: Array<{ amount: number; currency: string }> | undefined): string => {
        const parts = (buckets ?? []).filter((b) => b.amount !== 0).map((b) => ctx.stripe.formatAmount(b.amount, b.currency));
        return parts.join(" + ") || (buckets?.length ? ctx.stripe.formatAmount(0, buckets[0].currency) : "—");
      };
      blocks.push({
        type: "stats",
        items: [
          { label: "Available balance", value: balance ? fmtBuckets(balance.available) : "—" },
          { label: "Pending", value: balance ? fmtBuckets(balance.pending) : "—" },
          {
            label: "Active subscriptions",
            value: subCount ? `${subCount.count}${subCount.truncated ? "+" : ""}` : "—",
          },
          {
            label: "Open approvals",
            value: String(approvals.total + reviewCount),
            ...(approvals.total + reviewCount > 0 ? { badge: { kind: "warn", text: "action needed" } as Badge } : {}),
            ref: { page: "approvals" },
          },
        ],
      });

      // ---- needs-attention inbox ----
      const now = Date.now();
      const inboxRows: Array<{ id: string; cells: Cell[]; ref?: ObjectRef }> = [];

      for (const d of openDisputes.rows) {
        if (!d.evidenceDueBy) continue;
        const hoursLeft = (d.evidenceDueBy.getTime() - now) / 3_600_000;
        if (hoursLeft > DUE_SOON_HOURS) continue;
        const overdue = hoursLeft < 0;
        inboxRows.push({
          id: `dispute-${d.id}`,
          cells: [
            strong(`Dispute ${ctx.stripe.formatAmount(d.amount, d.currency)} — ${d.reason.replace(/_/g, " ")}`,
              `${d.id} · manage in /billing → Disputes until the web console ships`),
            badgeCell("error", overdue ? "Evidence OVERDUE" : `Due in ${Math.max(1, Math.round(hoursLeft))}h`),
            isoDateCell(d.evidenceDueBy),
          ],
        });
      }

      for (const a of approvals.rows) {
        inboxRows.push({
          id: `approval-${a.id}`,
          ref: { page: "approvals" },
          cells: [
            strong(a.summary, `requested by ${a.requestedByName} · ${a.origin}`),
            badgeCell(a.status === "FAILED" ? "error" : "warn", a.status === "FAILED" ? "Failed — retry" : "Awaiting approval"),
            isoDateCell(a.createdAt),
          ],
        });
      }

      if (reviewCount > 0) {
        inboxRows.push({
          id: "charge-reviews",
          ref: { page: "approvals" },
          cells: [
            strong(`${reviewCount} blocked self-service refund${reviewCount === 1 ? "" : "s"} waiting for review`),
            badgeCell("warn", "Charge review"),
            text("—"),
          ],
        });
      }

      for (const w of efws.slice(0, 10)) {
        const ageHours = (now - w.created * 1000) / 3_600_000;
        if (ageHours > EFW_WINDOW_HOURS) continue;
        const chargeId = typeof w.charge === "string" ? w.charge : w.charge.id;
        inboxRows.push({
          id: `efw-${w.id}`,
          ref: { page: "payments.detail", params: { id: chargeId } },
          cells: [
            strong(`Early fraud warning on ${chargeId}`, w.fraud_type.replace(/_/g, " ")),
            badgeCell("error", w.actionable ? "Actionable" : "EFW"),
            isoDateCell(new Date(w.created * 1000)),
          ],
        });
      }

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

      // ---- the five M5 charts (hydrated lazily via the series endpoint) ----
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

// Route a Stripe object id to its dashboard page (subset that exists today).
function refForId(id: string): ObjectRef | null {
  if (/^cus_/.test(id)) return { page: "customers.detail", params: { id } };
  if (/^(ch|py|pi)_/.test(id)) return { page: "payments.detail", params: { id } };
  if (/^po_/.test(id)) return { page: "balances.detail", params: { id } };
  if (/^sub_/.test(id)) return { page: "subscriptions.detail", params: { id } };
  if (/^in_/.test(id)) return { page: "invoices.detail", params: { id } };
  return null;
}
