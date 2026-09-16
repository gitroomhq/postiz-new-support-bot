import { Prisma, PrismaClient, DisputeAutoResolve } from "../../generated/prisma/client";
import type { AutoResolveStage, Guardrail } from "./autoResolvePolicy";

// Prisma mirror for dispute auto-resolve proposals. The ROW is the durable
// state of the decision: the webhook writes it, the hourly disputes looper
// drains it, and a human can cancel it in between.
//
// Every transition that matters is a compare-and-set through updateMany's
// count, never a read-then-write. A veto landing in the same second as the
// drain must lose or win cleanly; a read-then-write would let both proceed and
// refund a charge somebody just cancelled.

export const AUTO_RESOLVE_STATES = [
  "PENDING",
  "EXECUTING",
  "EXECUTED",
  "VETOED",
  "BLOCKED",
  "FAILED",
  "SUPERSEDED",
] as const;
export type AutoResolveState = (typeof AUTO_RESOLVE_STATES)[number];

// A row still holding a place in the queue, for the snapshot gauge.
const PENDING_STATES: AutoResolveState[] = ["PENDING", "EXECUTING"];

// How long an EXECUTING row may sit before the drain assumes the process that
// claimed it died and takes it back. Longer than any single Stripe call chain,
// shorter than the shortest sensible veto window.
export const EXECUTING_LEASE_MS = 15 * 60_000;

export interface ProposeInput {
  stage: AutoResolveStage;
  sourceId: string;
  disputeId: string | null;
  chargeId: string;
  customerId: string | null;
  amountMinor: number;
  currency: string;
  usdMinor: number;
  reason: string;
  fireAt: Date;
}

export interface BlockedInput extends Omit<ProposeInput, "fireAt"> {
  guardrail: Guardrail;
}

export type VetoOutcome =
  | { kind: "vetoed" }
  | { kind: "too_late"; state: string }
  | { kind: "already_vetoed"; byName: string | null }
  | { kind: "missing" };

export interface AutoResolveFilter {
  state?: AutoResolveState;
  stage?: AutoResolveStage;
}

export class AutoResolveStore {
  constructor(private prisma: PrismaClient) {}

  // Records a proposal. The unique index on sourceId IS the idempotency lock,
  // so a redelivered webhook returns the existing row rather than creating a
  // second one or throwing. No claim is needed here: nothing external happens
  // until the drain runs.
  async propose(input: ProposeInput): Promise<{ created: boolean; row: DisputeAutoResolve }> {
    try {
      const row = await this.prisma.disputeAutoResolve.create({
        data: { ...input, state: "PENDING" },
      });
      return { created: true, row };
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === "P2002") {
        const row = await this.prisma.disputeAutoResolve.findUnique({ where: { sourceId: input.sourceId } });
        if (row) return { created: false, row };
      }
      throw error;
    }
  }

  // Records a case the engine wanted to act on but could not. Kept as a row so
  // the guardrail is auditable and so a repeat-offender check can see it, and
  // so a redelivery does not re-alert.
  async recordBlocked(input: BlockedInput): Promise<{ created: boolean; row: DisputeAutoResolve }> {
    try {
      const row = await this.prisma.disputeAutoResolve.create({
        data: { ...input, state: "BLOCKED", fireAt: new Date() },
      });
      return { created: true, row };
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === "P2002") {
        const row = await this.prisma.disputeAutoResolve.findUnique({ where: { sourceId: input.sourceId } });
        if (row) return { created: false, row };
      }
      throw error;
    }
  }

  async byId(id: string): Promise<DisputeAutoResolve | null> {
    return this.prisma.disputeAutoResolve.findUnique({ where: { id } });
  }

  async bySourceId(sourceId: string): Promise<DisputeAutoResolve | null> {
    return this.prisma.disputeAutoResolve.findUnique({ where: { sourceId } });
  }

  // The drain's work list, in three parts:
  //   1. proposals whose veto window has expired
  //   2. rows left EXECUTING by a crashed process, past their lease
  //   3. executed rows whose side effects have not all landed yet
  // Capped by the caller so one tick cannot outrun the activity timeout.
  async claimDue(now: Date, limit: number): Promise<DisputeAutoResolve[]> {
    return this.prisma.disputeAutoResolve.findMany({
      where: {
        OR: [
          { state: "PENDING", fireAt: { lte: now } },
          { state: "EXECUTING", updatedAt: { lt: new Date(now.getTime() - EXECUTING_LEASE_MS) } },
          { state: "EXECUTED", OR: [{ subsCancelledAt: null }, { intercomNotedAt: null }] },
        ],
      },
      orderBy: { fireAt: "asc" },
      take: limit,
    });
  }

  // PENDING -> EXECUTING. False means a veto (or another worker) got there
  // first, and the caller must not touch Stripe.
  async casExecuting(id: string): Promise<boolean> {
    const res = await this.prisma.disputeAutoResolve.updateMany({
      where: { id, state: "PENDING" },
      data: { state: "EXECUTING", attempts: { increment: 1 } },
    });
    return res.count === 1;
  }

  // Reclaims a row whose lease expired, without touching a healthy one.
  async casReclaim(id: string, now: Date): Promise<boolean> {
    const res = await this.prisma.disputeAutoResolve.updateMany({
      where: { id, state: "EXECUTING", updatedAt: { lt: new Date(now.getTime() - EXECUTING_LEASE_MS) } },
      data: { attempts: { increment: 1 } },
    });
    return res.count === 1;
  }

  // A human pressing Cancel. Only a PENDING row can be vetoed: once the drain
  // has moved it to EXECUTING the refund is already in flight, and saying so is
  // more honest than pretending the cancel worked.
  async veto(id: string, actorId: string, actorName: string): Promise<VetoOutcome> {
    const res = await this.prisma.disputeAutoResolve.updateMany({
      where: { id, state: "PENDING" },
      data: { state: "VETOED", vetoedById: actorId, vetoedByName: actorName, vetoedAt: new Date() },
    });
    if (res.count === 1) return { kind: "vetoed" };
    const row = await this.byId(id);
    if (!row) return { kind: "missing" };
    if (row.state === "VETOED") return { kind: "already_vetoed", byName: row.vetoedByName };
    return { kind: "too_late", state: row.state };
  }

  // Money moved. Persisted BEFORE any side effect runs, so a crash in a side
  // effect can never cause a second refund.
  async markExecuted(id: string, refundId: string): Promise<void> {
    await this.prisma.disputeAutoResolve.update({
      where: { id },
      data: { state: "EXECUTED", refundId, executedAt: new Date(), lastError: null },
    });
  }

  async markBlocked(id: string, guardrail: Guardrail): Promise<void> {
    await this.prisma.disputeAutoResolve.update({ where: { id }, data: { state: "BLOCKED", guardrail } });
  }

  // A human refunded inside the veto window, so the engine's work is already
  // done. Distinct from BLOCKED because nothing was prevented from happening.
  async markSuperseded(id: string): Promise<void> {
    await this.prisma.disputeAutoResolve.update({ where: { id }, data: { state: "SUPERSEDED" } });
  }

  // Back to PENDING for another attempt, or FAILED once attempts run out.
  async markRetryable(id: string, error: string, maxAttempts: number): Promise<"retry" | "failed"> {
    const row = await this.byId(id);
    const failed = (row?.attempts ?? 0) >= maxAttempts;
    await this.prisma.disputeAutoResolve.update({
      where: { id },
      data: { state: failed ? "FAILED" : "PENDING", lastError: error.slice(0, 500) },
    });
    return failed ? "failed" : "retry";
  }

  // Stamped once the alert is actually on a channel. The drain refuses to
  // execute a row where alertedAt is null, so an unreachable billing channel
  // fails closed instead of refunding silently.
  async recordAlert(id: string, channelId: string, messageId: string, fireAt: Date): Promise<void> {
    await this.prisma.disputeAutoResolve.update({
      where: { id },
      data: { alertedAt: new Date(), alertChannelId: channelId, alertMessageId: messageId, fireAt },
    });
  }

  async stampSideEffect(id: string, effect: "subs" | "intercom"): Promise<void> {
    await this.prisma.disputeAutoResolve.update({
      where: { id },
      data: effect === "subs" ? { subsCancelledAt: new Date() } : { intercomNotedAt: new Date() },
    });
  }

  // Queue depth for the dispute_snapshot gauge. Never throws: the metrics tick
  // must degrade to a missing gauge rather than fail.
  async countPending(): Promise<number> {
    return this.prisma.disputeAutoResolve
      .count({ where: { state: { in: PENDING_STATES } } })
      .catch(() => 0);
  }

  // The repeat-offender half of the guardrail: has this customer already had an
  // auto-resolve inside the window. Blocked and superseded rows do not count,
  // because neither spent anything.
  async recentExecutedForCustomer(customerId: string, since: Date): Promise<number> {
    return this.prisma.disputeAutoResolve.count({
      where: {
        customerId,
        createdAt: { gte: since },
        state: { in: ["PENDING", "EXECUTING", "EXECUTED"] },
      },
    });
  }

  // Row counts per state, for the queue tab's filter chips.
  async countsByState(): Promise<Record<string, number>> {
    const grouped = await this.prisma.disputeAutoResolve.groupBy({ by: ["state"], _count: { _all: true } });
    return Object.fromEntries(grouped.map((g) => [g.state, g._count._all]));
  }

  async list(skip: number, take: number, filter: AutoResolveFilter = {}): Promise<{ rows: DisputeAutoResolve[]; total: number }> {
    const where = {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.stage ? { stage: filter.stage } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.disputeAutoResolve.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
      this.prisma.disputeAutoResolve.count({ where }),
    ]);
    return { rows, total };
  }
}
