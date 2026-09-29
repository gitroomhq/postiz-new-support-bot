import type Stripe from "stripe";
import type { SettingsStore } from "../../config/SettingsStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { TicketStore } from "../TicketStore";
import type { StripeDispute } from "../../generated/prisma/client";
import type { DisputeStore } from "./DisputeStore";
import type { DisputeEventStore } from "./DisputeEventStore";
import type { EvidencePack } from "./evidence/EvidencePackBuilder";
import { notCancelledBeforeCharge } from "./evidence/templates/reasons";
import {
  VERDICT_SIGNAL_LABELS,
  VERDICT_VERSION,
  annualFromPeriod,
  decideVerdict,
  hasCancelIntent,
  type Verdict,
  type VerdictInput,
  type VerdictResult,
  type VerdictSignal,
} from "./disputeVerdict";
import { log } from "../../util/logger";

const verdictLog = log.child("dispute-verdict");

// The facts behind a verdict, stored beside it so a page can say "posted 14
// times after the charge" rather than just "posted after the charge", and so
// the backtest can ask which facts the fights we lost actually had.
export interface VerdictDetail {
  result: VerdictResult;
  postsAfterCharge: number | null;
  postsBeforeCharge: number | null;
  channelsInPeriod: number | null;
  queuedPosts: number | null;
  intercomContacts: number | null;
  discordTickets: number;
  priorCharges: number | null;
  cardVerified: boolean | null;
  packScore: number | null;
  minScore: number;
  refundedMinor: number;
  currency: string;
  annual: boolean | null;
  threeDSecure: string | null;
  visaCe3: string | null;
  cancelAskBeforeCharge: boolean | null;
  cancelledBeforeCharge: boolean | null;
}

export interface StoredVerdict {
  verdict: Verdict;
  decisive: VerdictSignal;
  complete: boolean;
  changed: boolean;
  detail: VerdictDetail;
}

// The billing flow's refund ticket is a refund AND a cancellation request in
// one ("Request a refund and cancel your subscription"), and its question text
// is fixed, so it is recognised by that rather than by its wording.
const REFUND_TICKET_QUESTION = "Refund request";

// Decides whether a dispute is worth fighting, from the facts the evidence
// pack already gathered (no second round of Stripe or platform reads), plus
// the one source the pack does not read: the customer's Discord tickets.
export class DisputeVerdictService {
  constructor(
    private settings: SettingsStore,
    private disputeStore: DisputeStore,
    private sessionStore: SessionStore,
    private ticketStore: TicketStore,
    private events?: DisputeEventStore | null
  ) {}

  async evaluate(
    dispute: Stripe.Dispute,
    charge: Stripe.Charge,
    pack: EvidencePack,
    row?: Pick<StripeDispute, "planPeriod"> | null
  ): Promise<VerdictDetail> {
    const facts = pack.facts;
    const customerId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
    const disputeOpenedAt = new Date(dispute.created * 1000);
    const chargeAt = new Date(charge.created * 1000);

    // Discord is local and always answers; a lookup error here is a database
    // problem, and it makes the support feed unanswered rather than empty.
    let discordReached = true;
    const discordIds = customerId
      ? await this.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => {
          discordReached = false;
          return [] as string[];
        })
      : [];
    const tickets = await this.ticketStore.listByCustomerIdsBefore(discordIds, disputeOpenedAt).catch(() => {
      discordReached = false;
      return [] as Array<{ createdAt: Date; categoryId: string | null; question: string | null }>;
    });

    const probe = pack.supportProbe ?? null;
    const canceledClaim = dispute.reason === "subscription_canceled";
    let cancelAsk: boolean | null = null;
    if (canceledClaim) {
      const discordAsk = tickets.some(
        (t) =>
          t.createdAt < chargeAt &&
          ((t.categoryId === "billing" && t.question === REFUND_TICKET_QUESTION) || hasCancelIntent(t.question))
      );
      if (discordAsk || probe?.cancelAskBeforeCharge === true) cancelAsk = true;
      else if (probe && probe.cancelAskBeforeCharge === false && discordReached) cancelAsk = false;
    }

    const annual =
      annualFromPeriod(facts.charge?.paidPeriodStartIso, facts.charge?.paidPeriodEndIso) ??
      (facts.sub?.period === "yearly" ? true : facts.sub?.period === "monthly" ? false : null) ??
      (row?.planPeriod === "YEARLY" ? true : row?.planPeriod === "MONTHLY" ? false : null);

    const cancelledBeforeCharge = facts.sub && facts.charge ? !notCancelledBeforeCharge(facts) : null;
    const visaCe3 = dispute.evidence_details?.enhanced_eligibility?.visa_compelling_evidence_3?.status ?? null;
    const usage = facts.usage;

    const input: VerdictInput = {
      reason: dispute.reason,
      refundedMinor: charge.amount_refunded ?? 0,
      annual,
      threeDSecure: facts.charge?.threeDSecure ?? null,
      visaCe3,
      usage: usage
        ? {
            publishedSinceCharge: usage.publishedSinceCharge,
            publishedBeforeCharge: usage.publishedBeforeCharge,
            channelsDuringPeriod: usage.channelsDuringPeriod,
            queued: usage.queued,
          }
        : null,
      usageReached: pack.usageReached ?? facts.reach.usage,
      supportContacts: tickets.length + (probe?.conversationsBeforeDispute ?? 0),
      supportReached: discordReached && (probe?.reached ?? false),
      cancelAskBeforeCharge: cancelAsk,
      cancelledBeforeCharge,
      priorSucceededCharges: facts.history?.priorSucceeded ?? null,
      cardVerified: facts.history?.cardVerified ?? null,
      packScore: pack.score,
      minScore: this.settings.disputeVerdictMinScore(),
    };
    const result = decideVerdict(input);

    return {
      result,
      postsAfterCharge: usage?.publishedSinceCharge ?? null,
      postsBeforeCharge: usage?.publishedBeforeCharge ?? null,
      channelsInPeriod: usage?.channelsDuringPeriod ?? null,
      queuedPosts: usage?.queued ?? null,
      intercomContacts: probe?.reached ? probe.conversationsBeforeDispute : null,
      discordTickets: tickets.length,
      priorCharges: input.priorSucceededCharges,
      cardVerified: input.cardVerified,
      packScore: input.packScore,
      minScore: input.minScore,
      refundedMinor: input.refundedMinor,
      currency: charge.currency,
      annual,
      threeDSecure: input.threeDSecure,
      visaCe3,
      cancelAskBeforeCharge: cancelAsk,
      cancelledBeforeCharge,
    };
  }

  // Evaluate and persist. A history entry is written only when the verdict or
  // the rule that decided it CHANGED: the looper re-evaluates open disputes
  // every day, and a timeline of identical verdicts hides the one that moved.
  async evaluateAndStore(
    dispute: Stripe.Dispute,
    charge: Stripe.Charge,
    pack: EvidencePack,
    source: "live" | "backtest"
  ): Promise<StoredVerdict | null> {
    const before = await this.disputeStore.get(dispute.id).catch(() => null);
    const detail = await this.evaluate(dispute, charge, pack, before);
    const { result } = detail;
    const stored = await this.disputeStore.recordVerdict(dispute.id, {
      verdict: result.verdict,
      decisive: result.decisive,
      signals: detail,
      complete: result.complete,
      version: VERDICT_VERSION,
      source,
    });
    if (!stored) return null; // not mirrored yet: the looper will get to it

    const changed = before?.verdict !== result.verdict || before?.verdictDecisive !== result.decisive;
    if (changed && source === "live") {
      await this.events?.record({
        disputeId: dispute.id,
        kind: "verdict_changed",
        summary: `Verdict: ${verdictWord(result.verdict)} (${VERDICT_SIGNAL_LABELS[result.decisive].toLowerCase()})${
          result.complete ? "" : ", provisional until every source answers"
        }`,
        detail: {
          verdict: result.verdict,
          decisive: result.decisive,
          signals: result.signals,
          thin: result.thin,
          missing: result.missing,
          previous: before?.verdict ?? null,
          version: VERDICT_VERSION,
        },
      });
    }
    verdictLog.info("dispute verdict evaluated", {
      "stripe.dispute_id": dispute.id,
      "verdict.value": result.verdict,
      "verdict.decisive": result.decisive,
      "verdict.complete": result.complete,
      "verdict.source": source,
    });
    return { verdict: result.verdict, decisive: result.decisive, complete: result.complete, changed, detail };
  }

  // A human disagreeing with the rules. The reason is required by every
  // caller, because the point of recording an override is to compare it with
  // the outcome later.
  async override(
    disputeId: string,
    verdict: Verdict,
    reason: string,
    actor: { id: string; name: string }
  ): Promise<void> {
    await this.disputeStore.recordVerdictOverride(disputeId, {
      verdict,
      by: `${actor.name} (${actor.id})`,
      reason,
    });
    await this.events?.record({
      disputeId,
      kind: "verdict_overridden",
      summary: `Verdict overridden to ${verdictWord(verdict)}: ${reason.slice(0, 300)}`,
      actorId: actor.id,
      actorName: actor.name,
      detail: { verdict, reason: reason.slice(0, 1000) },
    });
  }
}

export function verdictWord(v: Verdict): string {
  return v === "fight" ? "Fight" : "Accept";
}

// Would the rules have this dispute closed as lost without anyone looking?
// True for a human override to Accept, or for a COMPLETE Accept from the rules.
// An incomplete Accept is still a question for a human.
export function quietAccept(row: {
  verdict: string | null;
  verdictOverride: string | null;
  verdictComplete: boolean;
}): boolean {
  if (row.verdictOverride) return row.verdictOverride === "accept";
  return row.verdict === "accept" && row.verdictComplete;
}
