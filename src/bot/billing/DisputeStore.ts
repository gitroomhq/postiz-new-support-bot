import type Stripe from "stripe";
import { Prisma, PrismaClient, StripeDispute } from "../../generated/prisma/client";
import { exportDisputeOutcome } from "../../metrics/MetricsExporter";

// Statuses with staff work left to do — everything the overview lists.
export const OPEN_DISPUTE_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
] as const;

// A response can still be submitted only in these two.
export const RESPONDABLE_DISPUTE_STATUSES = ["needs_response", "warning_needs_response"] as const;

// Terminal states never regress: a late-delivered charge.dispute.updated must
// not flip a closed dispute back to under_review (webhooks are unordered).
const TERMINAL_STATUSES = new Set(["won", "lost", "prevented", "warning_closed"]);
export const TERMINAL_DISPUTE_STATUSES = TERMINAL_STATUSES;

// Every TEXT evidence field Stripe accepts on a dispute (file slots excluded —
// those hold file_… ids). Canonical list shared by the evidence editor groups
// and the evidenceFinal snapshot taken once evidence is submitted.
export const TEXT_EVIDENCE_KEYS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy_disclosure",
  "cancellation_rebuttal",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "duplicate_charge_explanation",
  "duplicate_charge_id",
  "product_description",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
  "shipping_address",
  "shipping_carrier",
  "shipping_date",
  "shipping_tracking_number",
  "uncategorized_text",
] as const;

// Overview filter/sort state (kept in the panel session).
export type DisputeSort = "due" | "amount" | "new";
export interface OpenDisputeFilter {
  status?: string; // one of OPEN_DISPUTE_STATUSES
  reason?: string;
}
export type ClosedOutcome = "won" | "lost" | "other";
export interface ClosedDisputeFilter {
  outcome?: ClosedOutcome;
  reason?: string;
}

export interface OutcomeStats {
  won: number;
  lost: number;
  other: number; // prevented + warning_closed
  winRatePct: number | null; // won / (won + lost); null when no decided disputes
  // Minor units per currency — mixed-currency accounts can't be summed as one.
  wonAmount: Record<string, number>;
  lostAmount: Record<string, number>;
  lostUnanswered: number; // lost without any evidence submission
}

export interface ReasonStats {
  reason: string;
  won: number;
  lost: number;
  other: number;
  winRatePct: number | null;
}

const OTHER_CLOSED_STATUSES = ["prevented", "warning_closed"];

function closedStatusFilter(outcome: ClosedOutcome | undefined): string[] {
  if (outcome === "won") return ["won"];
  if (outcome === "lost") return ["lost"];
  if (outcome === "other") return OTHER_CLOSED_STATUSES;
  return [...TERMINAL_STATUSES];
}

// Text evidence as currently visible on the Stripe dispute object — the
// snapshot stored as evidenceFinal once a submission exists, so future AI
// drafts can learn from evidence that actually won.
function snapshotTextEvidence(d: Stripe.Dispute): Record<string, string> | null {
  const evidence = d.evidence as unknown as Record<string, unknown> | null | undefined;
  if (!evidence) return null;
  const out: Record<string, string> = {};
  for (const key of TEXT_EVIDENCE_KEYS) {
    const value = evidence[key];
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// Local mirror of Stripe disputes. Stripe's disputes.list can't filter by
// status, so the open-disputes overview and the reminder looper read from
// here; webhooks and the looper reconciliation keep it fresh.
export class DisputeStore {
  constructor(private prisma: PrismaClient) {}

  // Idempotent upsert from a live Stripe dispute (webhook or reconciliation).
  // due_by can be null or 0 (bank allows no response) — both map to null.
  // closedAtHint: historical close estimate used by the backfill for disputes
  // that closed before the mirror existed (otherwise "first seen closed" = now).
  async upsertFromStripe(
    d: Stripe.Dispute,
    customerId: string | null,
    opts?: { closedAtHint?: Date }
  ): Promise<StripeDispute> {
    const chargeId = typeof d.charge === "string" ? d.charge : (d.charge?.id ?? "");
    const paymentIntentId =
      typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
    const evidenceDueBy = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null;
    const submitted = (d.evidence_details?.submission_count ?? 0) > 0;
    const terminal = TERMINAL_STATUSES.has(d.status);

    const existing = await this.prisma.stripeDispute.findUnique({ where: { id: d.id } });
    if (existing && TERMINAL_STATUSES.has(existing.status) && !terminal) return existing; // stale event

    const finalSnapshot = submitted ? snapshotTextEvidence(d) : null;
    const shared = {
      chargeId,
      paymentIntentId,
      customerId: customerId ?? existing?.customerId ?? null,
      amount: d.amount,
      currency: d.currency,
      reason: d.reason || "unknown",
      status: d.status,
      evidenceDueBy,
      // Evidence submitted outside the bot (Dashboard) still gets stamped here.
      evidenceSubmittedAt: submitted ? (existing?.evidenceSubmittedAt ?? new Date()) : existing?.evidenceSubmittedAt ?? null,
      // Submitted text evidence snapshot — kept once captured (the dispute
      // object stops carrying useful evidence long after closing? it doesn't,
      // but an empty read must not wipe a previous snapshot).
      evidenceFinal: finalSnapshot ?? (existing?.evidenceFinal as Prisma.InputJsonValue | undefined) ?? undefined,
      closedAt: terminal ? (existing?.closedAt ?? opts?.closedAtHint ?? new Date()) : null,
    };
    const row = await this.prisma.stripeDispute.upsert({
      where: { id: d.id },
      update: shared,
      create: { ...shared, id: d.id, disputeCreatedAt: new Date(d.created * 1000) },
    });
    // Outcome analytics point on the tracked open → terminal transition only.
    // Disputes first seen already-closed are covered by the history backfill
    // (which emits at their historical closedAt) — emitting them here would
    // burst a fresh deploy's first reconcile at "now".
    if (existing && !TERMINAL_STATUSES.has(existing.status) && terminal) {
      exportDisputeOutcome({
        outcome: row.status,
        reason: row.reason,
        amountMinor: row.amount,
        currency: row.currency,
        submitted: row.evidenceSubmittedAt != null,
        ts: row.closedAt ?? undefined,
      });
    }
    return row;
  }

  async get(id: string): Promise<StripeDispute | null> {
    return this.prisma.stripeDispute.findUnique({ where: { id } });
  }

  // Overview page: open disputes, defaulting to most urgent (earliest evidence
  // deadline) first; the panel can filter by status/reason and re-sort.
  async listOpen(
    skip: number,
    take: number,
    filter?: OpenDisputeFilter,
    sort: DisputeSort = "due"
  ): Promise<{ rows: StripeDispute[]; total: number }> {
    const where = {
      status: filter?.status ? filter.status : { in: [...OPEN_DISPUTE_STATUSES] },
      ...(filter?.reason ? { reason: filter.reason } : {}),
    };
    const orderBy: Prisma.StripeDisputeOrderByWithRelationInput[] =
      sort === "amount"
        ? [{ amount: "desc" }, { disputeCreatedAt: "desc" }]
        : sort === "new"
          ? [{ disputeCreatedAt: "desc" }]
          : [{ evidenceDueBy: { sort: "asc", nulls: "last" } }, { disputeCreatedAt: "desc" }];
    const [rows, total] = await Promise.all([
      this.prisma.stripeDispute.findMany({ where, orderBy, skip, take }),
      this.prisma.stripeDispute.count({ where }),
    ]);
    return { rows, total };
  }

  // Reasons present among open disputes — feeds the overview's filter select.
  async openReasons(): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.prisma.stripeDispute.groupBy({
      by: ["reason"],
      where: { status: { in: [...OPEN_DISPUTE_STATUSES] } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
    });
    return rows.map((r) => ({ reason: r.reason, count: r._count._all }));
  }

  // History browser: closed disputes, most recently closed first.
  async listClosed(
    skip: number,
    take: number,
    filter?: ClosedDisputeFilter
  ): Promise<{ rows: StripeDispute[]; total: number }> {
    const where = {
      status: { in: closedStatusFilter(filter?.outcome) },
      ...(filter?.reason ? { reason: filter.reason } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stripeDispute.findMany({
        where,
        orderBy: [{ closedAt: { sort: "desc", nulls: "last" } }, { disputeCreatedAt: "desc" }],
        skip,
        take,
      }),
      this.prisma.stripeDispute.count({ where }),
    ]);
    return { rows, total };
  }

  async closedReasons(): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.prisma.stripeDispute.groupBy({
      by: ["reason"],
      where: { status: { in: [...TERMINAL_STATUSES] } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
    });
    return rows.map((r) => ({ reason: r.reason, count: r._count._all }));
  }

  // Outcome aggregates for the analytics panel. closedSince = undefined →
  // all-time; otherwise only disputes closed in the trailing window.
  async outcomeStats(closedSinceDays?: number, now: Date = new Date()): Promise<OutcomeStats> {
    const closedWindow = closedSinceDays
      ? { closedAt: { gte: new Date(now.getTime() - closedSinceDays * DAY_MS) } }
      : {};
    const where = { status: { in: [...TERMINAL_STATUSES] }, ...closedWindow };
    const [byStatusCurrency, lostUnanswered] = await Promise.all([
      this.prisma.stripeDispute.groupBy({
        by: ["status", "currency"],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.stripeDispute.count({ where: { ...where, status: "lost", evidenceSubmittedAt: null } }),
    ]);
    const stats: OutcomeStats = { won: 0, lost: 0, other: 0, winRatePct: null, wonAmount: {}, lostAmount: {}, lostUnanswered };
    for (const row of byStatusCurrency) {
      const count = row._count._all;
      const amount = row._sum.amount ?? 0;
      if (row.status === "won") {
        stats.won += count;
        stats.wonAmount[row.currency] = (stats.wonAmount[row.currency] ?? 0) + amount;
      } else if (row.status === "lost") {
        stats.lost += count;
        stats.lostAmount[row.currency] = (stats.lostAmount[row.currency] ?? 0) + amount;
      } else {
        stats.other += count;
      }
    }
    const decided = stats.won + stats.lost;
    stats.winRatePct = decided > 0 ? (stats.won / decided) * 100 : null;
    return stats;
  }

  // Win rate split by dispute reason (all-time), busiest reasons first.
  async statsByReason(): Promise<ReasonStats[]> {
    const rows = await this.prisma.stripeDispute.groupBy({
      by: ["reason", "status"],
      where: { status: { in: [...TERMINAL_STATUSES] } },
      _count: { _all: true },
    });
    const byReason = new Map<string, ReasonStats>();
    for (const row of rows) {
      const entry = byReason.get(row.reason) ?? { reason: row.reason, won: 0, lost: 0, other: 0, winRatePct: null };
      const count = row._count._all;
      if (row.status === "won") entry.won += count;
      else if (row.status === "lost") entry.lost += count;
      else entry.other += count;
      byReason.set(row.reason, entry);
    }
    const out = [...byReason.values()];
    for (const entry of out) {
      const decided = entry.won + entry.lost;
      entry.winRatePct = decided > 0 ? (entry.won / decided) * 100 : null;
    }
    return out.sort((a, b) => b.won + b.lost + b.other - (a.won + a.lost + a.other));
  }

  // Submitted-evidence snapshots from WON disputes, same reason preferred —
  // few-shot exemplars for the AI evidence draft.
  async wonEvidenceExemplars(reason: string, limit = 2): Promise<Array<{ reason: string; evidence: Record<string, string> }>> {
    const base = { status: "won", evidenceFinal: { not: Prisma.DbNull } } as const;
    const primary = await this.prisma.stripeDispute.findMany({
      where: { ...base, reason },
      orderBy: [{ closedAt: { sort: "desc", nulls: "last" } }],
      take: limit,
    });
    const rows = [...primary];
    if (rows.length < limit) {
      const fill = await this.prisma.stripeDispute.findMany({
        where: { ...base, reason: { not: reason } },
        orderBy: [{ closedAt: { sort: "desc", nulls: "last" } }],
        take: limit - rows.length,
      });
      rows.push(...fill);
    }
    return rows
      .map((r) => ({ reason: r.reason, evidence: (r.evidenceFinal ?? {}) as Record<string, string> }))
      .filter((r) => Object.keys(r.evidence).length > 0);
  }

  // Backfill export work-list: every terminal dispute in the mirror.
  async listTerminalForExport(): Promise<
    Array<Pick<StripeDispute, "id" | "status" | "reason" | "amount" | "currency" | "closedAt" | "evidenceSubmittedAt">>
  > {
    return this.prisma.stripeDispute.findMany({
      where: { status: { in: [...TERMINAL_STATUSES] } },
      select: { id: true, status: true, reason: true, amount: true, currency: true, closedAt: true, evidenceSubmittedAt: true },
      orderBy: { closedAt: "asc" },
    });
  }

  async countOpen(): Promise<number> {
    return this.prisma.stripeDispute.count({ where: { status: { in: [...OPEN_DISPUTE_STATUSES] } } });
  }

  async countDueWithin(days: number, now: Date = new Date()): Promise<number> {
    return this.prisma.stripeDispute.count({
      where: {
        status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
        evidenceSubmittedAt: null,
        evidenceDueBy: { gte: now, lte: new Date(now.getTime() + days * DAY_MS) },
      },
    });
  }

  // Normal reminder work-list: respondable, unsubmitted, due within the lead
  // window but NOT yet inside the urgent window (that tier pings separately),
  // not pinged in the last 24h. Past-due excluded — the response window is over.
  async listNeedingReminder(withinDays: number, urgentHours: number, now: Date = new Date()): Promise<StripeDispute[]> {
    const urgentEdge = new Date(now.getTime() + urgentHours * 3600_000);
    const leadEdge = new Date(now.getTime() + withinDays * DAY_MS);
    if (urgentEdge >= leadEdge) return []; // urgent window swallows the whole lead window
    return this.prisma.stripeDispute.findMany({
      where: {
        status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
        evidenceSubmittedAt: null,
        evidenceDueBy: { gt: urgentEdge, lte: leadEdge },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - DAY_MS) } }],
      },
      orderBy: { evidenceDueBy: "asc" },
    });
  }

  // Urgent work-list: due within urgentHours, still respondable + unsubmitted.
  // Separate 24h damper so a dispute that already got a normal reminder still
  // escalates the moment it enters the urgent window.
  async listNeedingUrgentReminder(urgentHours: number, now: Date = new Date()): Promise<StripeDispute[]> {
    return this.prisma.stripeDispute.findMany({
      where: {
        status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
        evidenceSubmittedAt: null,
        evidenceDueBy: { gte: now, lte: new Date(now.getTime() + urgentHours * 3600_000) },
        OR: [{ lastUrgentReminderAt: null }, { lastUrgentReminderAt: { lt: new Date(now.getTime() - DAY_MS) } }],
      },
      orderBy: { evidenceDueBy: "asc" },
    });
  }

  async recordReminder(id: string): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { lastReminderAt: new Date() } });
  }

  async recordUrgentReminder(id: string): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { lastUrgentReminderAt: new Date() } });
  }

  // Group modals and the AI draft save one field subset at a time — merge into
  // the existing draft so saving "Policies" doesn't wipe the "Core" draft.
  async mergeEvidenceDraft(id: string, patch: Record<string, string>): Promise<void> {
    const row = await this.prisma.stripeDispute.findUnique({ where: { id }, select: { evidenceDraft: true } });
    const merged = { ...((row?.evidenceDraft ?? {}) as Record<string, string>), ...patch };
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { evidenceDraft: merged } });
  }

  async markSubmitted(id: string): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { evidenceSubmittedAt: new Date() } });
  }

  // Reconciliation: local-open ids to re-check against Stripe (catches closes
  // older than the sweep window and missed webhooks).
  async listOpenIds(): Promise<string[]> {
    const rows = await this.prisma.stripeDispute.findMany({
      where: { status: { in: [...OPEN_DISPUTE_STATUSES] } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // Overview footer context: outcome tallies of NON-open disputes created in
  // the trailing window (won / lost / prevented+closed-inquiry).
  async closedSummarySince(days: number, now: Date = new Date()): Promise<{ won: number; lost: number; otherClosed: number }> {
    const rows = await this.prisma.stripeDispute.groupBy({
      by: ["status"],
      where: {
        status: { notIn: [...OPEN_DISPUTE_STATUSES] },
        disputeCreatedAt: { gte: new Date(now.getTime() - days * DAY_MS) },
      },
      _count: { _all: true },
    });
    const summary = { won: 0, lost: 0, otherClosed: 0 };
    for (const row of rows) {
      const count = row._count._all;
      if (row.status === "won") summary.won += count;
      else if (row.status === "lost") summary.lost += count;
      else summary.otherClosed += count;
    }
    return summary;
  }

  // ---- Watch subscriptions (DM on status change) ----

  async watch(disputeId: string, userId: string): Promise<void> {
    try {
      await this.prisma.disputeWatch.create({ data: { disputeId, userId } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error; // already watching
    }
  }

  async unwatch(disputeId: string, userId: string): Promise<void> {
    await this.prisma.disputeWatch.deleteMany({ where: { disputeId, userId } });
  }

  async isWatching(disputeId: string, userId: string): Promise<boolean> {
    return (await this.prisma.disputeWatch.findFirst({ where: { disputeId, userId } })) !== null;
  }

  async watchers(disputeId: string): Promise<string[]> {
    const rows = await this.prisma.disputeWatch.findMany({ where: { disputeId }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }
}
