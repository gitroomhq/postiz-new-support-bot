import type Stripe from "stripe";
import type { StripeClient } from "../../StripeClient";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { SessionStore } from "../../../auth/SessionStore";
import type { DisputeStore } from "../DisputeStore";
import type { DisputeEvidenceService } from "../DisputeEvidenceService";
import { confirmedOrgFor, type PostizIdentityService } from "../../../postiz/PostizIdentityService";
import type { IntercomClient } from "../../../intercom/IntercomClient";
import { FactCache, gatherFacts } from "./EvidenceFacts";
import { collectSupportFacts } from "./intercomHistory";
import { renderField, type RenderedField } from "./renderTemplate";
import { resolveTokens, type EvidenceFacts, type UsageFacts } from "./tokens";
import type { PostizActivitySource } from "../../../postiz/PostizActivitySource";
import type { DisputeEventStore } from "../DisputeEventStore";
import {
  FIELD_WEIGHTS,
  PACK_FIELDS_BY_REASON,
  TEMPLATE_VERSION,
  packReasonFor,
  templateFor,
  type PackReason,
} from "./templates";
import { TemplateStore } from "./TemplateStore";
import { attachStandingDocuments } from "./standingDocuments";
import { attachGeneratedDocuments } from "./generatedDocuments";
import type { EvidenceDocumentStore } from "./EvidenceDocumentStore";
import { exportDisputeEvidenceSource, exportDisputePackBuild } from "../../../metrics/MetricsExporter";
import { log } from "../../../util/logger";

const packLog = log.child("dispute-evidence-pack");

// Assembles a dispute evidence package from templates and real facts, stages it
// at Stripe with submit:false, and decides whether it is strong enough to
// submit itself at the deadline.
//
// Staging is not submitting. Everything this builder does on the webhook path
// is reversible by a human opening the dispute and editing it; only
// autoSubmitDecision plus DisputeEvidenceService.submit reaches the bank.

export interface EvidencePack {
  reason: PackReason;
  fields: Record<string, string>;
  rendered: RenderedField[];
  score: number;
  templateVersion: string;
  facts: EvidenceFacts;
}

export interface StageResult {
  pack: EvidencePack;
  staged: string[];
  omitted: Array<{ field: string; why: string }>;
  // True when every field the pack would stage is already staged at Stripe with
  // exactly this text, so nothing was written and no history entry was made.
  unchanged: boolean;
  // Standing policy documents attached to empty file slots on this pass.
  documents: string[];
  // Why the others were not. A document refuses to exist when the facts behind
  // it do not, which from the outside looks exactly like a button that does
  // nothing, so the reason has to travel back to whoever pressed it.
  documentsSkipped: Array<{ slot: string; why: string }>;
}

export type AutoSubmitRefusal =
  | "disabled"
  | "not_respondable"
  | "already_submitted"
  | "no_deadline"
  | "not_due_yet"
  | "past_deadline"
  | "low_score"
  | "thin_narrative"
  | "human_touched"
  | "opted_out"
  | "over_amount"
  | "already_claimed";

export type AutoSubmitDecision = { kind: "submit" } | { kind: "refuse"; why: AutoSubmitRefusal; score: number };

// Independent of the score: a package can reach 70 on cheap scalar fields
// (an email, a date, a name) while saying nothing that argues the case. These
// two fields ARE the argument, so both must be present and substantial before
// anything goes to a bank unattended.
const NARRATIVE_FIELDS = ["product_description", "uncategorized_text"];
const NARRATIVE_MIN_CHARS = 200;
// A staged receipt is worth a few points but cannot carry a package alone.
const RECEIPT_BONUS = 5;

export class EvidencePackBuilder {
  private facts = new FactCache();

  constructor(
    private stripe: StripeClient,
    private settings: SettingsStore,
    private sessionStore: SessionStore,
    private disputeStore: DisputeStore,
    private evidence: DisputeEvidenceService,
    private templates: TemplateStore,
    private intercom?: IntercomClient | null,
    // Real product usage, read from the platform's Post and Integration tables.
    private activity?: PostizActivitySource | null,
    private events?: DisputeEventStore | null,
    // The standing policy documents. Absent simply means none are attached.
    private documents?: EvidenceDocumentStore | null
  ) {}

  // Bound late: the identity service is built after the billing stack, and an
  // unbound one simply means the platform paragraphs are omitted rather than
  // rendered from guesses.
  private postiz: PostizIdentityService | null = null;

  bindPostiz(service: PostizIdentityService): void {
    this.postiz = service;
  }

  // `enrich` adds the Intercom pass. It costs up to ten round trips, so the
  // webhook never asks for it and the looper always does.
  async build(dispute: Stripe.Dispute, charge: Stripe.Charge, opts: { enrich?: boolean } = {}): Promise<EvidencePack> {
    const reason = packReasonFor(dispute.reason);
    const customerId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);

    const support =
      opts.enrich && this.intercom && this.settings.disputeTemplateIntercomEnabled()
        ? await collectSupportFacts(
            { intercom: this.intercom, sessionStore: this.sessionStore, settings: this.settings },
            customerId,
            typeof charge.billing_details?.email === "string" ? charge.billing_details.email : null
          ).catch(() => null)
        : null;

    // The platform org id is what the usage tables are keyed on, so it has to
    // be resolved before the posts can be counted.
    const usage = await this.usageFor(customerId, dispute, charge).catch(() => null);

    const facts = await gatherFacts(
      { stripe: this.stripe, postiz: this.postiz, support, usage },
      dispute,
      charge,
      {
        needDuplicates: reason === "duplicate",
        // The fraud-shaped reasons argue from card identity, so they need the
        // charge history even though they are not duplicate claims.
        needCardHistory: reason === "fraudulent" || reason === "unrecognized" || reason === "duplicate",
      }
    );
    this.facts.set(dispute.id, facts);
    return this.render(reason, facts, await this.templates.overrides(), opts.enrich === true);
  }

  // Pure once the facts exist, so a preview can re-render from cache for free.
  private render(
    reason: PackReason,
    facts: EvidenceFacts,
    overrides: Awaited<ReturnType<TemplateStore["overrides"]>>,
    enrich: boolean
  ): EvidencePack {
    const tokens = resolveTokens(facts);
    const fields: Record<string, string> = {};
    const rendered: RenderedField[] = [];

    for (const field of PACK_FIELDS_BY_REASON[reason]) {
      const template = templateFor(reason, field, overrides);
      if (!template) continue;
      // Templates that need support facts are simply absent from the fast path
      // rather than rendering a weaker version of themselves.
      if (template.stage === "enrich" && !enrich) continue;
      const out = renderField(template, tokens, facts);
      rendered.push(out);
      if (out.text) fields[field] = out.text;
    }

    return { reason, fields, rendered, score: scorePack(reason, fields, false), templateVersion: TEMPLATE_VERSION, facts };
  }

  // Resolves the Stripe customer to a platform organisation, then reads that
  // organisation's real posting activity. Returns null at every step it cannot
  // complete: a missing usage feed removes those paragraphs, it never weakens
  // the ones that remain.
  private async usageFor(
    customerId: string | null,
    dispute: Stripe.Dispute,
    charge: Stripe.Charge
  ): Promise<UsageFacts | null> {
    if (!customerId || !this.activity?.configured() || !this.postiz) return null;
    const lookup = await this.postiz.resolveOrgsForCustomer(customerId).catch(() => null);
    if (!lookup) return null;
    // The same proof the platform paragraphs demand. Counting a stranger's
    // posts and calling them this customer's use of the product is the single
    // most damaging thing this pack could tell a bank.
    const orgId = confirmedOrgFor(lookup)?.orgId;
    if (!orgId) return null;
    const activity = await this.activity.forOrganization(
      orgId,
      new Date(charge.created * 1000),
      new Date(dispute.created * 1000)
    );
    if (!activity) return null;
    return { ...activity, lastSignInIso: null };
  }

  cachedFacts(disputeId: string): EvidenceFacts | null {
    return this.facts.get(disputeId);
  }

  // Stages the pack at Stripe with submit:false and records what happened on
  // the mirror. Fields already staged are overwritten by this pack ONLY where
  // the pack has something to say; a field a human wrote and the pack omits is
  // left exactly as it is.
  async stage(dispute: Stripe.Dispute, pack: EvidencePack, receiptStaged: boolean): Promise<StageResult> {
    const staged = Object.keys(pack.fields);
    const omitted = pack.rendered
      .filter((r) => r.text == null)
      .map((r) => ({
        field: r.field,
        why: r.missing.length ? `missing ${[...new Set(r.missing)].join(", ")}` : (r.dropped ?? "unknown"),
      }));

    // The standing policy documents go in FIRST, and before the unchanged check
    // below, because they are independent of the text: a policy uploaded after
    // this dispute was last staged must still reach it, even though the
    // templates produce exactly the same words they did yesterday.
    const documents: string[] = [];
    const documentsSkipped: Array<{ slot: string; why: string }> = [];
    if (this.documents) {
      const result = await attachStandingDocuments(this.stripe, this.documents, dispute).catch((error) => {
        // A policy that could not be attached must never sink the text pack:
        // the fields are the argument, the documents corroborate it.
        packLog.warn("standing evidence documents could not be attached", {
          "stripe.dispute_id": dispute.id,
          "error.message": error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      documents.push(...(result?.attached ?? []));
      for (const slot of result?.occupied ?? []) documentsSkipped.push({ slot, why: "slot already filled" });
    }
    // The two built from this dispute's own facts. Each is produced only when
    // its slot is empty, so a dispute uploads them once and the hourly rebuild
    // never touches Stripe's file API again.
    const generated = await attachGeneratedDocuments(this.stripe, dispute, pack.facts).catch((error) => {
      packLog.warn("generated evidence documents could not be attached", {
        "stripe.dispute_id": dispute.id,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    documents.push(...(generated?.attached ?? []));
    documentsSkipped.push(...(generated?.skipped ?? []));

    // The templates are deterministic, so rebuilding an untouched dispute
    // produces byte-identical text. The looper rebuilds hourly to pick up facts
    // that arrive late, which means without this guard a dispute collects one
    // Stripe write, one history entry and one build metric EVERY HOUR until its
    // deadline, all of them saying the same thing. A timeline of two dozen
    // identical lines hides the entries that matter.
    // A pass that attached a policy is never "unchanged": it fills the whole
    // path below so the history records what landed, which happens at most once
    // per slot and is exactly the entry worth keeping.
    const current = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
    const unchanged =
      documents.length === 0 &&
      staged.length > 0 &&
      staged.every((field) => String(current[field] ?? "") === String(pack.fields[field] ?? ""));
    const score = scorePack(pack.reason, pack.fields, receiptStaged);
    if (unchanged) {
      packLog.debug("evidence pack unchanged; nothing re-staged", {
        "stripe.dispute_id": dispute.id,
        "pack.fields": staged.length,
      });
      return { pack: { ...pack, score }, staged, omitted, unchanged: true, documents, documentsSkipped };
    }

    if (staged.length) {
      await this.evidence.stageFields(dispute.id, pack.fields, `pack-${dispute.id}`);
    }
    await this.disputeStore.recordAutoPack(dispute.id, {
      score,
      templateVersion: pack.templateVersion,
      fields: { staged, omitted },
    });
    // The provenance record: which fields the pack filled, which it left out
    // and why, and which external sources actually answered. This is what makes
    // a package explicable months later.
    await this.events?.record({
      disputeId: dispute.id,
      kind: "pack_staged",
      summary: `Evidence pack staged: ${staged.length} field(s), completeness ${score}%${
        documents.length ? `, ${documents.length} policy document(s) attached` : ""
      }`,
      detail: {
        templateVersion: pack.templateVersion,
        reason: pack.reason,
        staged,
        omitted,
        ...(documents.length ? { documents } : {}),
        // Kept as-is so every pack_staged entry ever written still reads the
        // same way. `used` is the claim; `reached` is the feed.
        sources: {
          stripe: pack.facts.charge != null,
          subscription: pack.facts.sub != null,
          paymentHistory: pack.facts.billing != null,
          postizAccount: pack.facts.postiz != null,
          productUsage: pack.facts.usage != null,
          cardHistory: pack.facts.cards != null,
          supportHistory: pack.facts.support != null,
        },
        // Which of those answered at all. A source that answered and was not
        // used was refused on quality (one invoice is not a history, an
        // unproven organisation is not this customer), which is a completely
        // different thing from a feed that said nothing.
        reached: {
          stripe: pack.facts.reach.charge,
          subscription: pack.facts.reach.sub,
          paymentHistory: pack.facts.reach.billing,
          postizAccount: pack.facts.reach.postiz,
          productUsage: pack.facts.reach.usage,
          cardHistory: pack.facts.reach.cards,
          supportHistory: pack.facts.reach.support,
        },
      },
    });
    // Per-source coverage, so a silent feed is visible in Grafana long before
    // it shows up as a run of weak packages.
    const sources: Array<[string, boolean, boolean]> = [
      ["stripe_charge", pack.facts.charge != null, pack.facts.reach.charge],
      ["subscription", pack.facts.sub != null, pack.facts.reach.sub],
      ["payment_history", pack.facts.billing != null, pack.facts.reach.billing],
      ["postiz_account", pack.facts.postiz != null, pack.facts.reach.postiz],
      ["product_usage", pack.facts.usage != null, pack.facts.reach.usage],
      ["card_history", pack.facts.cards != null, pack.facts.reach.cards],
      ["support_history", pack.facts.support != null, pack.facts.reach.support],
    ];
    for (const [source, answered, reached] of sources) {
      exportDisputeEvidenceSource({ source, answered, reached, reason: pack.reason });
    }
    exportDisputePackBuild({
      reason: pack.reason,
      score,
      fieldsFilled: staged.length,
      fieldsOmitted: omitted.length,
      sourcesUsed: sources.filter(([, answered]) => answered).length,
      sourcesPossible: sources.length,
      postsAfterCharge: pack.facts.usage?.publishedSinceCharge,
      postUrls: pack.facts.usage?.recentPostsSinceCharge.length,
      channelsConnected: pack.facts.usage?.channelsLive,
      threeDSecure: pack.facts.charge?.threeDSecure === "authenticated",
      cvcMatched: pack.facts.charge?.cvcCheck === "pass",
      sameCardPriorCharges: pack.facts.cards?.sameCardPriorCount,
    });
    packLog.info("evidence pack staged", {
      "stripe.dispute_id": dispute.id,
      "pack.fields": staged.length,
      "pack.score": score,
    });
    return { pack: { ...pack, score }, staged, omitted, unchanged: false, documents, documentsSkipped };
  }

  // Every gate that must hold before a machine-written package is sent to a
  // bank. Returns the first failure, so the operator sees the reason that
  // actually blocked it rather than a list.
  async autoSubmitDecision(
    dispute: Stripe.Dispute,
    row: { evidenceTouchedAt: Date | null; evidenceAutoOptOut: boolean; evidenceSubmittedAt: Date | null },
    pack: { score: number; fields: Record<string, string> },
    now: Date = new Date()
  ): Promise<AutoSubmitDecision> {
    const refuse = (why: AutoSubmitRefusal): AutoSubmitDecision => ({ kind: "refuse", why, score: pack.score });

    if (!this.settings.disputeAutoSubmitEnabled()) return refuse("disabled");
    if (dispute.status !== "needs_response" && dispute.status !== "warning_needs_response") return refuse("not_respondable");
    if (row.evidenceSubmittedAt || (dispute.evidence_details?.submission_count ?? 0) > 0) return refuse("already_submitted");
    if (row.evidenceAutoOptOut) return refuse("opted_out");
    // A human who opened this dispute and typed anything owns it now.
    if (row.evidenceTouchedAt) return refuse("human_touched");

    const dueBy = dispute.evidence_details?.due_by;
    if (!dueBy) return refuse("no_deadline");
    const hoursLeft = (dueBy * 1000 - now.getTime()) / 3_600_000;
    if (hoursLeft <= 0) return refuse("past_deadline");
    if (hoursLeft > this.settings.disputeAutoSubmitHours()) return refuse("not_due_yet");

    const ceiling = this.settings.disputeAutoSubmitMaxMinor();
    if (ceiling != null && dispute.amount > ceiling) return refuse("over_amount");

    if (pack.score < this.settings.disputeAutoSubmitMinScore()) return refuse("low_score");
    for (const field of NARRATIVE_FIELDS) {
      if ((pack.fields[field] ?? "").length < NARRATIVE_MIN_CHARS) return refuse("thin_narrative");
    }
    return { kind: "submit" };
  }
}

// Weighted completeness, 0 to 100. Shared by the operator-facing score, the
// auto-submit gate and the Grafana ratio, so those three can never disagree.
export function scorePack(reason: PackReason, fields: Record<string, string>, receiptStaged: boolean): number {
  const packed = PACK_FIELDS_BY_REASON[reason];
  const total = packed.reduce((sum, f) => sum + (FIELD_WEIGHTS[f] ?? 0), 0);
  if (total <= 0) return 0;
  const filled = packed.reduce((sum, f) => sum + (fields[f] ? (FIELD_WEIGHTS[f] ?? 0) : 0), 0);
  return Math.min(100, Math.round((100 * filled) / total) + (receiptStaged ? RECEIPT_BONUS : 0));
}
