import { CachedRatioEngine, RatioWindowNumbers } from "../../../bot/billing/disputeRatio";
import { RESPONDABLE_DISPUTE_STATUSES } from "../../../bot/billing/DisputeStore";
import { ActionButton, Badge, Block, Cell, StatsBlock, TableBlock } from "../../renderer/contract";
import { DashboardCtx, SectionPage } from "../types";
import { amount, badgeCell, idCell, isoDateCell, sentence, strong, text } from "../cells";
import { autoResolveBlocks } from "./proposals";
import { BOARD_WINDOW, DisputesDeps, PAGE_SIZE, disputeRow, statusBadgeFor } from "./cells";

// The disputes overview. One page, four tabs, in the order the work happens:
// what is owed a response, everything, what the engine wants to refund, and
// what already closed.
//
// "Proposals" is not a fourth list of disputes. It lists what the auto-resolve
// engine has proposed, refused and executed, which is why the ratio strip is
// withheld there: the strip is about the disputes you have, and that tab is
// about decisions the machine made.

type View = "" | "all" | "autoresolve" | "history";

export async function list(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const view: View =
    filters.view === "all" || filters.view === "history" || filters.view === "autoresolve"
      ? (filters.view as View)
      : "";
  const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
  const needingCount = counts
    .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + c.count, 0);

  const blocks: Block[] = [];
  blocks.push({
    type: "header",
    title: "Disputes",
    sub: "Evidence is written from templates and real account facts, with no model involved.",
    actions: [
      // Only on the tab it acts on: elsewhere it would be an unexplained sweep
      // button over a page that shows none of what it touches.
      ...(view === "autoresolve" && deps.autoResolve && ctx.settings.disputeResolveMode() !== "none"
        ? ([
            {
              key: "section:disputes.autoresolve_backfill",
              label: "Evaluate open inquiries",
              style: "primary",
            },
          ] as ActionButton[])
        : []),
      { key: "nav.library", label: "Evidence library", style: "secondary", ref: { page: "disputes.library" } },
    ],
  });
  blocks.push({
    type: "tabs",
    key: "view",
    value: view || undefined,
    items: [
      { value: "", label: "Needs response", ...(needingCount ? { badge: String(needingCount) } : {}) },
      { value: "all", label: "All" },
      { value: "autoresolve", label: "Proposals" },
      { value: "history", label: "History" },
    ],
  });

  // Ratio strip: the number the whole surface exists to keep down, so it rides
  // above the work on the tabs that are ABOUT disputes. It is context, not the
  // headline of the page, so it is dense.
  if (view === "" || view === "history") blocks.push(await ratioStrip(ctx, deps.ratio));

  if (view === "history") blocks.push(...(await historyBlocks(ctx, cursor)));
  else if (view === "autoresolve") blocks.push(...(await autoResolveBlocks(ctx, deps, filters, cursor)));
  else if (view === "all") blocks.push(...(await allBlocks(ctx, filters, cursor, counts)));
  else blocks.push(await boardBlock(ctx));

  return { title: "Disputes", crumbs: [{ label: "Disputes" }], blocks };
}

async function ratioStrip(ctx: DashboardCtx, ratio: CachedRatioEngine): Promise<StatsBlock> {
  const warnPct = ctx.settings.disputeRatioWarnPct();
  const criticalPct = ctx.settings.disputeRatioCriticalPct();
  const level = (pct: number | null): Badge | undefined => {
    if (pct == null) return undefined;
    if (pct >= criticalPct) return { kind: "error", text: "critical" };
    if (pct >= warnPct) return { kind: "warn", text: "warn" };
    return { kind: "ok", text: "ok" };
  };
  const fmt = (pct: number | null): string => (pct == null ? "N/A" : `${pct.toFixed(2)}%`);
  try {
    const r = await ratio.get();
    const ge = r.truncated ? "≥" : "";
    const win = (label: string, w: RatioWindowNumbers) => ({
      label,
      value: fmt(w.plainPct),
      sub: `VAMP ${fmt(w.vampPct)} · ${ge}${w.chargebacks}/${w.succeeded} charges`,
      badge: level(w.plainPct),
    });
    return {
      type: "stats",
      dense: true,
      items: [win("This month", r.month), win("Last 30 days", r.d30), win("Last 90 days", r.d90)],
    };
  } catch {
    return {
      type: "stats",
      dense: true,
      items: [{ label: "Dispute ratio", value: "N/A", sub: "ratio engine unavailable right now" }],
    };
  }
}

// Needs-response due-date board: the two respondable statuses, most urgent first.
async function boardBlock(ctx: DashboardCtx): Promise<Block> {
  const open = await ctx.stores.dispute.listOpen(0, BOARD_WINDOW, undefined, "due");
  const rows = open.rows
    .filter((d) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(d.status))
    .map((d) => disputeRow(ctx, d));
  return {
    type: "table",
    key: "board",
    title: "Evidence due",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No disputes need a response right now.",
    ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
    notice: "Sorted by evidence deadline. Open a dispute to build its evidence pack and submit it.",
  };
}

// All disputes: status count-cards + reason/sort pills over the full mirror.
async function allBlocks(
  ctx: DashboardCtx,
  filters: Record<string, string>,
  cursor: string | null,
  counts: Array<{ status: string; count: number }>
): Promise<Block[]> {
  const status = /^[a-z_]{1,32}$/.test(filters.status ?? "") ? filters.status : "";
  const reason = /^[a-z_.]{1,40}$/.test(filters.reason ?? "") ? filters.reason : "";
  const sort = filters.sort === "due" || filters.sort === "amount" ? filters.sort : "new";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;

  const [page, openReasons, closedReasons] = await Promise.all([
    ctx.stores.dispute.listMirror(offset, PAGE_SIZE, { status: status || undefined, reason: reason || undefined }, sort),
    ctx.stores.dispute.openReasons().catch(() => []),
    ctx.stores.dispute.closedReasons().catch(() => []),
  ]);
  const reasons = [...new Set([...openReasons, ...closedReasons].map((r) => r.reason))].sort();
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  const table: TableBlock = {
    type: "table",
    key: "all",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    counts: {
      key: "status",
      items: [
        { value: "", label: "All", count: total },
        ...counts
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((c) => ({ value: c.status, label: sentence(c.status.replace(/_/g, " ")), count: c.count })),
      ],
    },
    filters: [
      {
        key: "reason",
        label: "Reason",
        kind: "select",
        value: reason || undefined,
        options: reasons.map((r) => ({ value: r, label: sentence(r.replace(/_/g, " ")) })),
      },
      {
        key: "sort",
        label: "Sort",
        kind: "select",
        value: sort === "new" ? undefined : sort,
        options: [
          { value: "due", label: "Evidence deadline" },
          { value: "amount", label: "Amount" },
        ],
      },
    ],
    rows: page.rows.map((d) => disputeRow(ctx, d)),
    nextCursor: offset + PAGE_SIZE < page.total ? String(offset + PAGE_SIZE) : null,
    empty: status || reason ? "No disputes match these filters." : "No disputes mirrored yet.",
    ...(page.rows.length
      ? { footer: `${page.rows.length} of ${page.total} item${page.total === 1 ? "" : "s"}` }
      : {}),
    notice: "Local mirror kept fresh by the dispute monitor and Stripe webhooks.",
  };
  return [table];
}

// History: outcome tiles + win-rate by reason + closed list.
async function historyBlocks(ctx: DashboardCtx, cursor: string | null): Promise<Block[]> {
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const [stats, byReason, closed] = await Promise.all([
    ctx.stores.dispute.outcomeStats(),
    ctx.stores.dispute.statsByReason().catch(() => []),
    ctx.stores.dispute.listClosed(offset, PAGE_SIZE),
  ]);
  const fmtAmounts = (buckets: Record<string, number>): string => {
    const parts = Object.entries(buckets).map(([cur, minor]) => ctx.stripe.formatAmount(minor, cur));
    return parts.join(" + ") || "N/A";
  };

  const blocks: Block[] = [];
  blocks.push({
    type: "stats",
    items: [
      { label: "Won", value: String(stats.won), sub: fmtAmounts(stats.wonAmount) },
      { label: "Lost", value: String(stats.lost), sub: fmtAmounts(stats.lostAmount) },
      {
        label: "Win rate",
        value: stats.winRatePct == null ? "N/A" : `${stats.winRatePct.toFixed(0)}%`,
        sub: `${stats.won + stats.lost} decided`,
      },
      {
        label: "Lost unanswered",
        value: String(stats.lostUnanswered),
        ...(stats.lostUnanswered > 0 ? { badge: { kind: "error", text: "evidence never sent" } as Badge } : {}),
      },
    ],
  });

  if (byReason.length > 0) {
    blocks.push({
      type: "table",
      key: "byreason",
      title: "Win rate by reason",
      columns: [
        { key: "reason", label: "Reason" },
        { key: "won", label: "Won", align: "right" },
        { key: "lost", label: "Lost", align: "right" },
        { key: "rate", label: "Win rate", align: "right" },
      ],
      rows: byReason.map((r) => ({
        id: r.reason,
        cells: [
          strong(sentence(r.reason.replace(/_/g, " "))),
          text(String(r.won)),
          text(String(r.lost)),
          r.winRatePct == null
            ? text("N/A")
            : badgeCell(r.winRatePct >= 50 ? "ok" : "warn", `${r.winRatePct.toFixed(0)}%`),
        ] as Cell[],
      })),
    });
  }

  blocks.push({
    type: "table",
    key: "closed",
    title: "Closed disputes",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "closed", label: "Closed" },
      { key: "id", label: "ID" },
    ],
    rows: closed.rows.map((d) => ({
      id: d.id,
      ref: { page: "disputes.detail", params: { id: d.id } },
      cells: [
        amount(ctx.stripe, d.amount, d.currency, statusBadgeFor(d.status)),
        text(sentence(d.reason.replace(/_/g, " "))),
        d.customerId
          ? ({ t: "link", v: d.customerId, ref: { page: "customers.detail", params: { id: d.customerId } } } as Cell)
          : text("N/A"),
        d.closedAt ? isoDateCell(d.closedAt) : text("N/A"),
        idCell(d.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: offset + PAGE_SIZE < closed.total ? String(offset + PAGE_SIZE) : null,
    empty: "No closed disputes yet.",
    ...(closed.rows.length
      ? { footer: `${closed.rows.length} of ${closed.total} item${closed.total === 1 ? "" : "s"}` }
      : {}),
  });

  return blocks;
}
