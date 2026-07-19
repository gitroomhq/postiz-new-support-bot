import type Stripe from "stripe";
import { ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { badgeCell, dateCell, idCell, sentence, text } from "./cells";

// Reports (#/reports): Stripe financial report runs. Runs execute
// asynchronously; succeeded runs produce a real Stripe File, so downloads
// mint a short-lived FileLink URL (10 minutes) instead of piping bytes —
// itemized reports routinely exceed the JSON channel's size cap.

const RUN_ID_RE = /^frr_[A-Za-z0-9]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LINK_TTL_SECONDS = 600;

// Curated report types (free strings in SDK v20). Availability varies per
// account — Stripe's create-time refusal is mapped to a friendly error.
const REPORT_TYPES = [
  { value: "balance.summary.1", label: "Balance summary" },
  { value: "balance_change_from_activity.itemized.3", label: "Balance change from activity (itemized)" },
  { value: "payout_reconciliation.itemized.5", label: "Payout reconciliation (itemized)" },
];

export function makeReportsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "reports", label: "Reports", page: "reports", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "reports";
    },

    async buildPage(ctx: DashboardCtx, _req): Promise<SectionPage | null> {
      const runs = await ctx.stripe.listReportRuns(25);
      const blocks: Block[] = [
        {
          type: "header",
          title: "Reports",
          actions: [
            {
              key: "section:reports.run",
              label: "Run report",
              style: "primary",
              inputs: [
                { type: "select", key: "reportType", label: "Report type", options: REPORT_TYPES },
                { type: "text", key: "start", label: "Interval start (YYYY-MM-DD)", placeholder: "2026-06-01", maxLength: 10 },
                { type: "text", key: "end", label: "Interval end (YYYY-MM-DD)", placeholder: "2026-07-01", maxLength: 10 },
              ],
              summary: "Starts an asynchronous report run over the given interval — Refresh the page to watch it finish.",
            },
            // No-op section action: dispatchAction reloads the page on ok, so
            // "Refresh" needs zero client changes.
            { key: "section:reports.refresh", label: "Refresh", params: {} },
          ],
        },
        {
          type: "table",
          key: "reports",
          columns: [
            { key: "type", label: "Report" },
            { key: "status", label: "Status" },
            { key: "interval", label: "Interval" },
            { key: "created", label: "Created" },
            { key: "id", label: "ID" },
          ],
          rows: runs.map((run) => ({
            id: run.id,
            cells: [
              { t: "text", v: reportLabel(run.report_type), strong: true, sub: run.report_type } as Cell,
              badgeCell(runBadge(run.status).kind, runBadge(run.status).text),
              text(intervalLabel(run)),
              dateCell(run.created),
              idCell(run.id, { copy: true }),
            ] as Cell[],
            ...(run.status === "succeeded" && run.result
              ? {
                  actions: [
                    {
                      key: "section:reports.link",
                      label: "Get download link",
                      params: { id: run.id },
                      summary: `Mints a download URL that expires in ${LINK_TTL_SECONDS / 60} minutes.`,
                    },
                  ],
                }
              : {}),
          })),
          empty: "No report runs yet — start one above.",
          ...(runs.length ? { footer: `${runs.length} most recent runs` } : {}),
          notice: "Reports run asynchronously — Refresh to update. Download links expire after 10 minutes.",
        },
      ];
      return { title: "Reports", crumbs: [{ label: "Reports" }], blocks };
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      switch (req.key) {
        // T0 + audit — start an async run.
        case "section:reports.run": {
          const reportType = REPORT_TYPES.some((t) => t.value === p.reportType) ? (p.reportType as string) : null;
          if (!reportType) return { ok: false, fieldErrors: { reportType: "Pick a report type." } };
          const startRaw = str(p.start, 10).trim();
          const endRaw = str(p.end, 10).trim();
          if (!DATE_RE.test(startRaw)) return { ok: false, fieldErrors: { start: "Use YYYY-MM-DD." } };
          if (!DATE_RE.test(endRaw)) return { ok: false, fieldErrors: { end: "Use YYYY-MM-DD." } };
          const intervalStart = Math.floor(Date.parse(`${startRaw}T00:00:00Z`) / 1000);
          const intervalEnd = Math.floor(Date.parse(`${endRaw}T00:00:00Z`) / 1000);
          if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd)) {
            return { ok: false, error: "Those dates do not parse." };
          }
          if (intervalStart >= intervalEnd) return { ok: false, fieldErrors: { end: "End must be after start." } };
          if (intervalEnd > Math.floor(Date.now() / 1000)) {
            return { ok: false, fieldErrors: { end: "End cannot be in the future — reports cover settled data." } };
          }
          let run: Stripe.Reporting.ReportRun;
          try {
            run = await ctx.stripe.createReportRun(
              reportType,
              { intervalStart, intervalEnd },
              `dash-report-${Date.now().toString(36)}`
            );
          } catch (e) {
            // Common case: the report type is not enabled for this account.
            const msg = e instanceof Error ? e.message : "Stripe refused the report run.";
            return { ok: false, error: `Stripe refused the run: ${msg.slice(0, 300)}` };
          }
          await ctx.audit(`Report run ${run.id} started — ${reportType} ${startRaw}..${endRaw}`);
          return { ok: true, text: `Report run ${run.id} started — it will appear as Succeeded when ready.` };
        }
        // T0 + audit — mint a 10-minute FileLink for a SUCCEEDED run. Live
        // re-read: the run id is client-supplied, the status check is ours.
        case "section:reports.link": {
          const id = typeof p.id === "string" && RUN_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad report run id." };
          const run = await ctx.stripe.getReportRun(id).catch(() => null);
          if (!run) return { ok: false, error: "This report run does not exist." };
          if (run.status !== "succeeded" || !run.result?.id) {
            return { ok: false, error: `Run is ${run.status} — download links exist for succeeded runs only.` };
          }
          const link = await ctx.stripe.createFileLink(run.result.id, Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS);
          if (!link.url) return { ok: false, error: "Stripe returned no URL for this file." };
          await ctx.audit(`Report run ${id} download link minted (expires in ${LINK_TTL_SECONDS / 60}m)`);
          return {
            ok: true,
            text: `Download link ready — expires in ${LINK_TTL_SECONDS / 60} minutes.`,
            link: { href: link.url, label: "Download report" },
          };
        }
        // T0 — no-op: an ok result makes the client reload the page.
        case "section:reports.refresh":
          return { ok: true, text: "Refreshed." };
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function reportLabel(reportType: string): string {
  const curated = REPORT_TYPES.find((t) => t.value === reportType);
  return curated ? curated.label : sentence(reportType.split(".")[0].replace(/_/g, " "));
}

function runBadge(status: string): Badge {
  const kind: Badge["kind"] = status === "succeeded" ? "ok" : status === "failed" ? "error" : "warn";
  return { kind, text: sentence(status) };
}

function intervalLabel(run: Stripe.Reporting.ReportRun): string {
  const params = run.parameters;
  if (!params?.interval_start || !params?.interval_end) return "—";
  const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
  return `${day(params.interval_start)} → ${day(params.interval_end)}`;
}
