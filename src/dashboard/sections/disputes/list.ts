import { CachedRatioEngine, RatioWindowNumbers } from "../../../bot/billing/disputeRatio";
import { RESPONDABLE_DISPUTE_STATUSES, type LossAxis } from "../../../bot/billing/DisputeStore";
import { BACKTEST_WINDOW_DAYS } from "../../../bot/billing/DisputeMonitor";
import { VERDICT_VERSION } from "../../../bot/billing/disputeVerdict";
import { ActionButton, Badge, Block, Cell, StatsBlock, TableBlock } from "../../renderer/contract";
import { DashboardCtx, SectionPage } from "../types";
import { amount, badgeCell, idCell, isoDateCell, sentence, strong, text } from "../cells";
import { autoResolveBlocks } from "./proposals";
import { BOARD_WINDOW, DisputesDeps, PAGE_SIZE, disputeRow, signalLabel, statusBadgeFor, verdictCell } from "./cells";

// The disputes overview. One page, five tabs, in the order the work happens:
// what is owed a response, everything, what the engine wants to refund, what
// already closed, and how the closed ones went (Analysis).
//
// "Proposals" is not a fourth list of disputes. It lists what the auto-resolve
// engine has proposed, refused and executed, which is why the ratio strip is
// withheld there: the strip is about the disputes you have, and that tab is
// about decisions the machine made.

type View = "" | "all" | "autoresolve" | "history" | "analysis";

// The analysis table is one paginated table whatever it is grouped by, and a
// grouping can have dozens of rows (network codes), so it pages at ten.
const ANALYSIS_PAGE_SIZE = 10;

export async function list(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const view: View =
    filters.view === "all" || filters.view === "history" || filters.view === "autoresolve" || filters.view === "analysis"
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
      { value: "analysis", label: "Analysis" },
    ],
  });

  // Ratio strip: the number the whole surface exists to keep down, so it rides
  // above the work on the tabs that are ABOUT disputes. It is context, not the
  // headline of the page, so it is dense.
  if (view === "" || view === "history") blocks.push(await ratioStrip(ctx, deps.ratio));

  if (view === "history") blocks.push(...(await historyBlocks(ctx, cursor)));
  else if (view === "analysis") blocks.push(...(await analysisBlocks(ctx, deps, filters, cursor)));
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
      { key: "verdict", label: "Verdict" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No disputes need a response right now.",
    ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
    notice:
      "Sorted by evidence deadline. The verdict says whether a dispute is worth fighting; open one to see why, then submit or accept it.",
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
  const verdict = filters.verdict === "fight" || filters.verdict === "accept" || filters.verdict === "none" ? filters.verdict : undefined;
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;

  const [page, openReasons, closedReasons] = await Promise.all([
    ctx.stores.dispute.listMirror(offset, PAGE_SIZE, { status: status || undefined, reason: reason || undefined, verdict }, sort),
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
      { key: "verdict", label: "Verdict" },
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
        key: "verdict",
        label: "Verdict",
        kind: "select",
        value: verdict,
        options: [
          { value: "fight", label: "Fight" },
          { value: "accept", label: "Accept" },
          { value: "none", label: "Not decided yet" },
        ],
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
    empty: status || reason || verdict ? "No disputes match these filters." : "No disputes mirrored yet.",
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
      { key: "verdict", label: "Verdict" },
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
        verdictCell(d),
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

// ---- Analysis: where the fights were lost, and what the verdict would have done ----

const ANALYSIS_AXES: Array<{ value: LossAxis; label: string }> = [
  { value: "reason", label: "Reason" },
  { value: "networkReason", label: "Network code" },
  { value: "cardBrand", label: "Card brand" },
  { value: "verdict", label: "Verdict" },
  { value: "decisive", label: "Deciding rule" },
];

function axisLabel(axis: LossAxis, key: string): string {
  if (key === "none") return axis === "verdict" || axis === "decisive" ? "No verdict" : "Unknown";
  switch (axis) {
    case "reason":
      return sentence(key.replace(/_/g, " "));
    case "cardBrand":
      return sentence(key);
    case "verdict":
      return key === "fight" ? "Fight" : key === "accept" ? "Accept" : sentence(key);
    case "decisive":
      return signalLabel(key);
    default:
      return key;
  }
}

function pct(won: number, lost: number): Cell {
  const decided = won + lost;
  if (!decided) return text("N/A");
  const rate = (won / decided) * 100;
  return badgeCell(rate >= 50 ? "ok" : "warn", `${rate.toFixed(0)}%`);
}

async function analysisBlocks(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<Block[]> {
  const axis = ANALYSIS_AXES.find((a) => a.value === filters.group)?.value ?? "reason";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const since = new Date(Date.now() - BACKTEST_WINDOW_DAYS * 24 * 60 * 60_000);
  const [groups, byVerdict, progress] = await Promise.all([
    ctx.stores.dispute.lossBreakdown(axis),
    axis === "verdict" ? Promise.resolve(null) : ctx.stores.dispute.lossBreakdown("verdict"),
    ctx.stores.dispute.backtestProgress(VERDICT_VERSION, since),
  ]);
  const verdictGroups = byVerdict ?? groups;
  const fight = verdictGroups.find((g) => g.key === "fight");
  const accept = verdictGroups.find((g) => g.key === "accept");
  const foughtWon = groups.reduce((sum, g) => sum + g.foughtWon, 0);
  const foughtLost = groups.reduce((sum, g) => sum + g.foughtLost, 0);
  const unanswered = groups.reduce((sum, g) => sum + g.unanswered, 0);

  const blocks: Block[] = [];
  blocks.push({
    type: "stats",
    items: [
      { label: "Fought", value: String(foughtWon + foughtLost), sub: `won ${foughtWon}, lost ${foughtLost}` },
      { label: "Win rate when fought", value: foughtWon + foughtLost ? `${((foughtWon / (foughtWon + foughtLost)) * 100).toFixed(0)}%` : "N/A" },
      {
        label: "Verdict Fight",
        value: fight ? `${fight.foughtWon} of ${fight.foughtWon + fight.foughtLost} won` : "none yet",
        sub: fight ? `${fight.unanswered} not fought` : undefined,
      },
      {
        label: "Verdict Accept",
        value: accept ? `${accept.foughtLost} fought and lost` : "none yet",
        // Both sides of the ledger: the losses it would have conceded (and the
        // countered fee each one cost), and the wins it would have given away.
        sub: accept ? `would have been conceded; ${accept.foughtWon} of these were won` : undefined,
        ...(accept && accept.foughtLost > 0 ? { badge: { kind: "warn", text: "fees avoidable" } as Badge } : {}),
      },
      { label: "Lost unanswered", value: String(unanswered) },
    ],
  });

  const requested = ctx.settings.disputeBacktestRequestedAt();
  const complete = progress.eligible > 0 && progress.done >= progress.eligible;
  blocks.push({
    type: "notice",
    badge: requested ? { kind: "info", text: "Backtest running" } : complete ? { kind: "ok", text: "Backtest complete" } : { kind: "neutral", text: "Backtest" },
    text: requested
      ? `${progress.done} of ${progress.eligible} decided chargebacks from the last ${BACKTEST_WINDOW_DAYS} days have a verdict. The disputes looper evaluates a batch every hour (and one right away); results fill in as it goes.`
      : complete
        ? `Every decided chargeback from the last ${BACKTEST_WINDOW_DAYS} days has a verdict under the current rules (${VERDICT_VERSION}). Group by Verdict or Deciding rule to see which fights the rules would have made.`
        : `${progress.done} of ${progress.eligible} decided chargebacks from the last ${BACKTEST_WINDOW_DAYS} days have a verdict. The backtest evaluates the rest as if they had just arrived: posts, support contact and payments are counted up to each dispute's own date.`,
    actions: [
      {
        key: "section:disputes.backtest_run",
        label: requested ? "Backtest running" : complete ? "Re-run backtest" : "Run backtest",
        style: "secondary",
        ...(requested
          ? { disabledReason: "Already running." }
          : !ctx.actor.isAdmin
            ? { disabledReason: "Admins only." }
            : !deps.verdicts || !deps.evidencePack
              ? { disabledReason: "The verdict service is not configured." }
              : {}),
      },
    ],
  });

  const page = groups.slice(offset, offset + ANALYSIS_PAGE_SIZE);
  const fees = deps.moneyOut
    ? await deps.moneyOut.disputeFeesFor(page.flatMap((g) => g.ids)).catch(() => [])
    : [];
  const feeByDispute = new Map<string, Array<{ currency: string; feeMinor: number }>>();
  for (const f of fees) feeByDispute.set(f.disputeId, [...(feeByDispute.get(f.disputeId) ?? []), f]);
  const feeCell = (ids: string[]): Cell => {
    const byCurrency: Record<string, number> = {};
    for (const id of ids) for (const f of feeByDispute.get(id) ?? []) byCurrency[f.currency] = (byCurrency[f.currency] ?? 0) + f.feeMinor;
    const parts = Object.entries(byCurrency).map(([cur, minor]) => ctx.stripe.formatAmount(minor, cur));
    return text(parts.join(" + ") || (deps.moneyOut ? "none recorded" : "N/A"));
  };

  const axisName = ANALYSIS_AXES.find((a) => a.value === axis)!.label;
  blocks.push({
    type: "table",
    key: "analysis",
    title: `Decided chargebacks by ${axisName.toLowerCase()}`,
    filters: [
      {
        key: "group",
        label: "Group by",
        kind: "select",
        value: axis === "reason" ? undefined : axis,
        options: ANALYSIS_AXES.map((a) => ({ value: a.value, label: a.label })),
      },
    ],
    columns: [
      { key: "group", label: axisName },
      { key: "fought", label: "Fought", align: "right" },
      { key: "won", label: "Won", align: "right" },
      { key: "lost", label: "Lost", align: "right" },
      { key: "rate", label: "Win rate", align: "right" },
      { key: "unanswered", label: "Unanswered", align: "right" },
      { key: "fees", label: "Dispute fees", align: "right" },
    ],
    rows: page.map((g) => ({
      id: g.key,
      cells: [
        strong(axisLabel(axis, g.key)),
        text(String(g.foughtWon + g.foughtLost)),
        text(String(g.foughtWon)),
        text(String(g.foughtLost)),
        pct(g.foughtWon, g.foughtLost),
        text(String(g.unanswered)),
        feeCell(g.ids),
      ] as Cell[],
    })),
    nextCursor: offset + ANALYSIS_PAGE_SIZE < groups.length ? String(offset + ANALYSIS_PAGE_SIZE) : null,
    empty: "No decided chargebacks in the mirror yet.",
    ...(page.length ? { footer: `${page.length} of ${groups.length} group${groups.length === 1 ? "" : "s"}` } : {}),
    notice:
      "Fought means evidence reached the bank; unanswered means it closed as lost without a submission. Fees are the dispute fees the money-out ledger recorded against these disputes.",
  });
  return blocks;
}
