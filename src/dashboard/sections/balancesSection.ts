import type Stripe from "stripe";
import { ActionButton, ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, validCursor, validId } from "./types";
import { bookmarkButton, isBookmarkedSafe, toggleBookmarkAction } from "./bookmarks";
import { amount, badgeCell, dateCell, idCell, money, sentence, text } from "./cells";

// Balances: account balance buckets, the payout ledger (paginated) and recent
// balance transactions (fees/refunds/charges), plus a payout detail page with
// the transactions that composed it. Payout WRITES: create lives on
// the Payments → Payouts tab; cancel (pending, T2 fresh-factor) and reverse
// (paid, T3 Discord reverse-code) live here on the detail page.

const PAGE_SIZE = 25;

// Shared with the Payments "All activity" tab view.
export const TX_TYPES = [
  { value: "charge", label: "Charges" },
  { value: "refund", label: "Refunds" },
  { value: "payout", label: "Payouts" },
  { value: "adjustment", label: "Adjustments" },
  { value: "stripe_fee", label: "Stripe fees" },
];

export function makeBalancesSection(): DashboardSectionModule {
  return {
    nav: [{ key: "balances", label: "Balances", page: "balances" }],

    ownsPage(page: string): boolean {
      return page === "balances" || page === "balances.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "balances") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "balances.detail") {
        const id = validId("payout", req.params?.id);
        if (!id) return notFound("That payout id is not valid (po_…).");
        return payoutDetail(ctx, id);
      }
      return null;
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const confirmed = req.confirmWord === "CONFIRM";
      // T1+T2 — payout schedule (no payout id — it targets the account).
      // ⚠ Own-account accounts.update may be Connect-only: attempt, and map
      // Stripe's refusal to a friendly error (the read-only card stays right).
      if (req.key === "section:balances.payout_schedule") {
        if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
        if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
        const p = req.params ?? {};
        const interval =
          p.interval === "manual" || p.interval === "daily" || p.interval === "weekly" || p.interval === "monthly"
            ? p.interval
            : null;
        if (!interval) return { ok: false, fieldErrors: { interval: "Pick an interval." } };
        const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        const weeklyAnchor = typeof p.weeklyAnchor === "string" && WEEKDAYS.includes(p.weeklyAnchor) ? p.weeklyAnchor : undefined;
        if (interval === "weekly" && !weeklyAnchor) {
          return { ok: false, fieldErrors: { weeklyAnchor: "Weekly payouts need an anchor day." } };
        }
        const monthlyAnchor =
          typeof p.monthlyAnchor === "number" && Number.isSafeInteger(p.monthlyAnchor) && p.monthlyAnchor >= 1 && p.monthlyAnchor <= 31
            ? p.monthlyAnchor
            : undefined;
        if (interval === "monthly" && monthlyAnchor == null) {
          return { ok: false, fieldErrors: { monthlyAnchor: "Monthly payouts need an anchor day (1–31)." } };
        }
        const delayDays =
          typeof p.delayDays === "number" && Number.isSafeInteger(p.delayDays) && p.delayDays >= 2 && p.delayDays <= 30
            ? p.delayDays
            : undefined;
        if (interval === "manual" && typeof p.delayDays === "number") {
          return { ok: false, fieldErrors: { delayDays: "Delay days don't apply to manual payouts." } };
        }
        const before = await ctx.stripe.getAccount().catch(() => null);
        const old = before?.settings?.payouts?.schedule;
        try {
          await ctx.stripe.updatePayoutSchedule({
            interval,
            ...(interval === "weekly" && weeklyAnchor ? { weeklyAnchor } : {}),
            ...(interval === "monthly" && monthlyAnchor != null ? { monthlyAnchor } : {}),
            ...(interval !== "manual" && delayDays != null ? { delayDays } : {}),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Stripe refused the update.";
          return {
            ok: false,
            error: `Stripe refused the schedule change (this API can be Connect-only): ${msg.slice(0, 250)}`,
          };
        }
        await ctx.audit(
          `Payout schedule changed ${old ? scheduleLabel(old) : "?"} → ${scheduleLabel({ interval, weekly_anchor: weeklyAnchor, monthly_anchor: monthlyAnchor, delay_days: delayDays ?? old?.delay_days ?? 0 })}`
        );
        return { ok: true, text: "Payout schedule updated." };
      }

      const id = validId("payout", req.params?.id);
      if (!id) return { ok: false, error: "Bad payout id." };
      switch (req.key) {
        // T0 — shared team bookmark toggle.
        case "section:balances.bookmark":
          return toggleBookmarkAction(ctx, "payout", req.params ?? {});
        // T2 — cancel a PENDING payout; the funds return to the available balance.
        case "section:balances.payout_cancel": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
          const payout = await ctx.stripe.getPayout(id).catch(() => null);
          if (!payout) return { ok: false, error: "This payout does not exist." };
          if (payout.status !== "pending") {
            return { ok: false, error: `Payout is ${payout.status}; only pending payouts can be canceled.` };
          }
          await ctx.stripe.cancelPayout(id, `dash-pocancel-${id}`);
          await ctx.audit(`Payout ${id} canceled (${ctx.stripe.formatAmount(payout.amount, payout.currency)})`);
          return { ok: true, text: `Payout ${id} canceled. The funds return to the available balance.` };
        }
        // T3 — reverse a PAID payout (debits the destination bank account).
        // Typed CONFIRM plus the Discord reverse code.
        case "section:balances.payout_reverse": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
          const payout = await ctx.stripe.getPayout(id).catch(() => null);
          if (!payout) return { ok: false, error: "This payout does not exist." };
          if (payout.status !== "paid") {
            return { ok: false, error: `Payout is ${payout.status}; only paid payouts can be reversed.` };
          }
          const reversedBy = typeof payout.reversed_by === "string" ? payout.reversed_by : payout.reversed_by?.id ?? null;
          if (reversedBy) return { ok: false, error: `Payout was already reversed (${reversedBy}).` };
          const reversal = await ctx.stripe.reversePayout(id, `dash-poreverse-${id}`);
          await ctx.audit(`Payout ${id} REVERSED → ${reversal.id} (${ctx.stripe.formatAmount(payout.amount, payout.currency)})`);
          return { ok: true, text: `Payout ${id} reversed. ${reversal.id} debits the destination bank account.` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const txType = TX_TYPES.some((t) => t.value === filters.type) ? filters.type : "";
  // The cursor belongs to the PAYOUTS table only (po_ ids) — the transactions
  // table shows the latest window (one paginating table per page).
  const payoutCursor = validId("payout", validCursor(cursor) ?? "") ?? undefined;

  const [balance, payoutsRes, txRes, account] = await Promise.all([
    ctx.stripe.getBalance().catch(() => null),
    ctx.stripe.listPayouts({ limit: PAGE_SIZE, startingAfter: payoutCursor }),
    ctx.stripe
      .listAccountBalanceTransactions({ limit: PAGE_SIZE, ...(txType ? { type: txType } : {}) })
      .catch(() => ({ transactions: [] as Stripe.BalanceTransaction[], hasMore: false })),
    ctx.stripe.getAccount().catch(() => null),
  ]);
  const schedule = account?.settings?.payouts?.schedule ?? null;

  const blocks: Block[] = [];

  // Explicit page header: the payout-schedule editor lives here. The
  // write may be Connect-only on some accounts — the action degrades to a
  // friendly refusal, the card below stays correct either way.
  blocks.push({
    type: "header",
    title: "Balances",
    actions: [
      {
        key: "section:balances.payout_schedule",
        label: "Edit payout schedule",
        dangerous: true,
        stepUp: true,
        inputs: [
          {
            type: "select",
            key: "interval",
            label: "Interval",
            value: schedule?.interval ?? "daily",
            options: [
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "manual", label: "Manual (API-only payouts)" },
            ],
          },
          {
            type: "select",
            key: "weeklyAnchor",
            label: "Weekly anchor (weekly only)",
            ...(schedule?.weekly_anchor ? { value: schedule.weekly_anchor } : {}),
            options: [
              { value: "", label: "N/A" },
              { value: "monday", label: "Monday" },
              { value: "tuesday", label: "Tuesday" },
              { value: "wednesday", label: "Wednesday" },
              { value: "thursday", label: "Thursday" },
              { value: "friday", label: "Friday" },
              { value: "saturday", label: "Saturday" },
              { value: "sunday", label: "Sunday" },
            ],
          },
          { type: "number", key: "monthlyAnchor", label: "Monthly anchor day 1–31 (monthly only)", min: 1, max: 31 },
          { type: "number", key: "delayDays", label: "Delay days 2–30 (empty = keep current)", min: 2, max: 30 },
        ],
        summary:
          "Changes when Stripe pays your balance out to the bank. Manual stops automatic payouts entirely. Requires a fresh factor.",
      },
    ],
  });

  const buckets = (rows: Array<{ amount: number; currency: string }> | undefined) =>
    (rows ?? []).map((b) => ctx.stripe.formatAmount(b.amount, b.currency)).join(" + ") || "N/A";
  blocks.push({
    type: "stats",
    items: [
      { label: "Available", value: balance ? buckets(balance.available) : "N/A", sub: "settled, ready to pay out" },
      { label: "Pending", value: balance ? buckets(balance.pending) : "N/A", sub: "settling to available" },
      ...(balance?.connect_reserved?.length
        ? [{ label: "Reserved", value: buckets(balance.connect_reserved) }]
        : []),
    ],
  });

  // Read-only schedule card — always renders when the account read worked,
  // even if the write path is unavailable for this account type.
  if (schedule) {
    blocks.push({
      type: "kv",
      title: "Payout schedule",
      rows: [
        { label: "Interval", cell: text(sentence(schedule.interval)) },
        ...(schedule.interval === "weekly" && schedule.weekly_anchor
          ? [{ label: "Anchor", cell: text(sentence(schedule.weekly_anchor)) }]
          : []),
        ...(schedule.interval === "monthly" && schedule.monthly_anchor != null
          ? [{ label: "Anchor", cell: text(`Day ${schedule.monthly_anchor}`) }]
          : []),
        { label: "Delay", cell: text(`${schedule.delay_days} day${schedule.delay_days === 1 ? "" : "s"}`) },
      ],
    });
  }

  blocks.push({
    type: "table",
    key: "payouts",
    title: "Payouts",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "method", label: "Method" },
      { key: "arrival", label: "Arrival" },
      { key: "id", label: "ID" },
    ],
    rows: payoutsRes.payouts.map((p) => ({
      id: p.id,
      ref: { page: "balances.detail", params: { id: p.id } },
      cells: [
        amount(ctx.stripe, p.amount, p.currency, payoutBadge(p.status)),
        text(p.method === "instant" ? "Instant" : "Standard"),
        dateCell(p.arrival_date),
        idCell(p.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor:
      payoutsRes.hasMore && payoutsRes.payouts.length > 0 ? payoutsRes.payouts[payoutsRes.payouts.length - 1].id : null,
    empty: "No payouts yet.",
    ...(payoutsRes.payouts.length
      ? { footer: `${payoutsRes.payouts.length}${payoutsRes.hasMore ? "+" : ""} item${payoutsRes.payouts.length === 1 ? "" : "s"}` }
      : {}),
  });

  blocks.push({
    type: "table",
    key: "transactions",
    title: "Balance transactions",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "fee", label: "Fee", align: "right" },
      { key: "net", label: "Net", align: "right" },
      { key: "type", label: "Type" },
      { key: "available", label: "Available on" },
      { key: "id", label: "Source" },
    ],
    filters: [{ key: "type", label: "Type", kind: "select", value: txType || undefined, options: TX_TYPES }],
    rows: txRes.transactions.map((t) => ({
      id: t.id,
      ...(sourceRef(t) ? { ref: sourceRef(t)! } : {}),
      cells: [
        amount(ctx.stripe, t.amount, t.currency),
        money(ctx.stripe, -t.fee, t.currency, t.fee ? "muted" : undefined),
        money(ctx.stripe, t.net, t.currency, t.net >= 0 ? "pos" : "neg"),
        text(sentence(t.type.replace(/_/g, " "))),
        dateCell(t.available_on),
        typeof t.source === "string" ? idCell(t.source, { copy: true }) : text("N/A"),
      ] as Cell[],
    })),
    empty: "No balance transactions in this window.",
    ...(txRes.transactions.length
      ? {
          footer: `${txRes.transactions.length}${txRes.hasMore ? "+" : ""} item${txRes.transactions.length === 1 ? "" : "s"}`,
        }
      : {}),
    notice: "Latest transactions only; the payout pager above pages independently.",
  });

  return { title: "Balances", crumbs: [{ label: "Balances" }], blocks };
}

async function payoutDetail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const payout = await ctx.stripe.getPayout(id).catch(() => null);
  if (!payout) return notFound("This payout does not exist.");
  const [txRes, bookmarked] = await Promise.all([
    ctx.stripe
      .listAccountBalanceTransactions({ limit: 50, payoutId: id })
      .catch(() => ({ transactions: [] as Stripe.BalanceTransaction[], hasMore: false })),
    isBookmarkedSafe(ctx, "payout", id),
  ]);

  // Status-aware writes: cancel while pending (T2), reverse once paid (T3).
  const reversedBy = typeof payout.reversed_by === "string" ? payout.reversed_by : payout.reversed_by?.id ?? null;
  const originalPayout = typeof payout.original_payout === "string" ? payout.original_payout : payout.original_payout?.id ?? null;
  const actions: ActionButton[] = [];
  if (payout.status === "pending") {
    actions.push({
      key: "section:balances.payout_cancel",
      label: "Cancel payout",
      dangerous: true,
      stepUp: true,
      params: { id: payout.id },
      summary: "Cancels this pending payout; the funds return to the available balance. Requires a fresh factor.",
    });
  }
  if (payout.status === "paid" && !reversedBy && !originalPayout) {
    actions.push({
      key: "section:balances.payout_reverse",
      label: "Reverse payout",
      style: "danger",
      dangerous: true,
      reverseConfirm: true,
      params: { id: payout.id },
      summary:
        "Debits the destination bank account to pull this payout back (US/CA bank accounts only). Requires the Discord reverse code.",
    });
  }
  actions.push(
    bookmarkButton("section:balances.bookmark", bookmarked, payout.id, ctx.stripe.formatAmount(payout.amount, payout.currency))
  );

  const main: Block[] = [
    {
      type: "header",
      title: ctx.stripe.formatAmount(payout.amount, payout.currency),
      titleSuffix: payout.currency.toUpperCase(),
      sub: originalPayout ? "Payout reversal" : "Payout",
      badges: [payoutBadge(payout.status), ...(reversedBy ? [{ kind: "error", text: "Reversed" } as Badge] : [])],
      actions,
    },
    {
      type: "table",
      key: "txs",
      title: "Transactions in this payout",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "fee", label: "Fee", align: "right" },
        { key: "net", label: "Net", align: "right" },
        { key: "type", label: "Type" },
        { key: "id", label: "Source" },
      ],
      rows: txRes.transactions.map((t) => ({
        id: t.id,
        ...(sourceRef(t) ? { ref: sourceRef(t)! } : {}),
        cells: [
          amount(ctx.stripe, t.amount, t.currency),
          money(ctx.stripe, -t.fee, t.currency, t.fee ? "muted" : undefined),
          money(ctx.stripe, t.net, t.currency, t.net >= 0 ? "pos" : "neg"),
          text(sentence(t.type.replace(/_/g, " "))),
          typeof t.source === "string" ? idCell(t.source, { copy: true }) : text("N/A"),
        ] as Cell[],
      })),
      empty: "Stripe has not attached transactions to this payout (yet).",
      ...(txRes.transactions.length
        ? { footer: `${txRes.transactions.length}${txRes.hasMore ? "+" : ""} item${txRes.transactions.length === 1 ? "" : "s"}` }
        : {}),
    },
  ];

  const rail: Block[] = [
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Payout ID", cell: idCell(payout.id, { copy: true }) },
        { label: "Status", cell: badgeCell(payoutBadge(payout.status).kind, sentence(payout.status)) },
        { label: "Method", cell: text(payout.method === "instant" ? "Instant" : "Standard") },
        { label: "Arrival date", cell: dateCell(payout.arrival_date) },
        { label: "Created", cell: dateCell(payout.created) },
        ...(typeof payout.destination === "string"
          ? [{ label: "Destination", cell: idCell(payout.destination, { copy: true }) }]
          : []),
        ...(payout.description ? [{ label: "Description", cell: text(payout.description) }] : []),
        ...(payout.statement_descriptor ? [{ label: "Statement descriptor", cell: text(payout.statement_descriptor) }] : []),
        ...(reversedBy
          ? [{ label: "Reversed by", cell: idCell(reversedBy, { copy: true, ref: { page: "balances.detail", params: { id: reversedBy } } }) }]
          : []),
        ...(originalPayout
          ? [{ label: "Reversal of", cell: idCell(originalPayout, { copy: true, ref: { page: "balances.detail", params: { id: originalPayout } } }) }]
          : []),
        ...(payout.failure_message ? [{ label: "Failure", cell: badgeCell("error", payout.failure_message.slice(0, 120)) }] : []),
      ],
    },
  ];

  return {
    title: ctx.stripe.formatAmount(payout.amount, payout.currency),
    crumbs: [{ label: "Balances", ref: { page: "balances" } }, { label: payout.id, copyId: payout.id }],
    blocks: main,
    rail,
  };
}

// "daily (delay 2d)" / "weekly@monday (delay 7d)" — the audit old→new label.
function scheduleLabel(s: { interval: string; weekly_anchor?: string | null; monthly_anchor?: number | null; delay_days: number | string }): string {
  const anchor = s.interval === "weekly" && s.weekly_anchor ? `@${s.weekly_anchor}` : s.interval === "monthly" && s.monthly_anchor != null ? `@day${s.monthly_anchor}` : "";
  return `${s.interval}${anchor} (delay ${s.delay_days}d)`;
}

export function payoutBadge(status: string): Badge {
  const kind: Badge["kind"] =
    status === "paid" ? "ok" : status === "failed" || status === "canceled" ? "error" : "warn"; // pending / in_transit
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

// Link a balance transaction to its source object when we have a page for it.
// (Also used by the Payments "All activity" tab view.)
export function sourceRef(t: Stripe.BalanceTransaction): { page: string; params: { id: string } } | null {
  const source = typeof t.source === "string" ? t.source : null;
  if (!source) return null;
  if (/^(ch|py)_/.test(source)) return { page: "payments.detail", params: { id: source } };
  if (/^po_/.test(source)) return { page: "balances.detail", params: { id: source } };
  if (/^re_/.test(source)) return null; // refund objects have no page yet
  return null;
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Balances", ref: { page: "balances" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Payout not found", hint }],
  };
}
