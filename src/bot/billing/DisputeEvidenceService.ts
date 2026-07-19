import type Stripe from "stripe";
import type { StripeClient } from "../StripeClient";
import type { SessionStore } from "../../auth/SessionStore";
import type { SettingsStore } from "../../config/SettingsStore";
import type { ClaudeCodeRunner } from "../ClaudeCodeRunner";
import type { LightAiRunner, LightAiAttachment } from "../LightAiRunner";
import type { IntercomClient } from "../../intercom/IntercomClient";
import { Logger } from "../../util/logger";
import { buildDisputeEvidencePrompt, buildDisputeEvidenceReviewPrompt } from "../aiPrompts";
import { subPlanLabel } from "./ui";
import { attachReceiptEvidence } from "./receiptEvidence";
import { DisputeStore, RESPONDABLE_DISPUTE_STATUSES, TEXT_EVIDENCE_KEYS } from "./DisputeStore";
import type { StripeDispute } from "../../generated/prisma/client";

const logger = new Logger("billing:dispute-evidence");

// Dispute evidence domain core, extracted from DisputesHub so the Discord hub
// and the web dashboard share ONE implementation of the catalog, draft
// handling, Stripe staging (submit:false), file proofs, the staged read-back,
// submission and accept-as-lost — including the cross-admin claim that makes
// submit/accept single-shot across every surface. Rendering, ceremony and
// audit logging stay with the callers; this file is transport-free.

// Neutral field spec (no Discord types): multiline maps to a Paragraph input
// on Discord and a <textarea> on the web.
export interface EvidenceFieldSpec {
  key: string;
  label: string;
  multiline: boolean;
}

// Full Stripe TEXT-evidence coverage, split into ≤5-field groups (Discord's
// modal budget; the web renders them as collapsible sections). Field keys ARE
// the Stripe evidence keys (DisputeUpdateParams.Evidence), so editors
// round-trip 1:1 with what's staged.
export interface EvidenceGroup {
  key: string;
  label: string;
  emoji: string;
  fields: EvidenceFieldSpec[];
}

export const EVIDENCE_GROUPS: EvidenceGroup[] = [
  {
    key: "core",
    label: "Core response",
    emoji: "📝",
    fields: [
      { key: "product_description", label: "Product / service description", multiline: true },
      { key: "customer_email_address", label: "Customer email", multiline: false },
      { key: "service_date", label: "Service date", multiline: false },
      { key: "access_activity_log", label: "Access / usage activity log", multiline: true },
      { key: "uncategorized_text", label: "Response narrative", multiline: true },
    ],
  },
  {
    key: "policy",
    label: "Policies & rebuttal",
    emoji: "📜",
    fields: [
      { key: "refund_policy_disclosure", label: "Refund policy disclosure", multiline: true },
      { key: "refund_refusal_explanation", label: "Refund refusal explanation", multiline: true },
      { key: "cancellation_policy_disclosure", label: "Cancellation policy disclosure", multiline: true },
      { key: "cancellation_rebuttal", label: "Cancellation rebuttal", multiline: true },
    ],
  },
  {
    key: "customer",
    label: "Customer identity",
    emoji: "👤",
    fields: [
      { key: "customer_name", label: "Customer name", multiline: false },
      { key: "billing_address", label: "Billing address", multiline: true },
      { key: "customer_purchase_ip", label: "Customer purchase IP", multiline: false },
    ],
  },
  {
    key: "duplicate",
    label: "Duplicate charge",
    emoji: "🔁",
    fields: [
      { key: "duplicate_charge_id", label: "Original (non-duplicate) charge id", multiline: false },
      { key: "duplicate_charge_explanation", label: "Why the charges are distinct", multiline: true },
    ],
  },
  {
    key: "shipping",
    label: "Shipping (physical goods)",
    emoji: "📦",
    fields: [
      { key: "shipping_carrier", label: "Carrier", multiline: false },
      { key: "shipping_tracking_number", label: "Tracking number", multiline: false },
      { key: "shipping_date", label: "Shipping date", multiline: false },
      { key: "shipping_address", label: "Shipping address", multiline: true },
    ],
  },
];

const POLICY_REASONS = new Set(["subscription_canceled", "credit_not_processed"]);
export const EVIDENCE_KEY_SET = new Set<string>(TEXT_EVIDENCE_KEYS);

// Which groups matter most for a given dispute reason — editors list them
// first with a ⭐ and the AI draft fills exactly their fields.
export function recommendedGroupKeys(reason: string | null | undefined): string[] {
  if (POLICY_REASONS.has(reason ?? "")) return ["core", "policy"];
  if (reason === "duplicate") return ["duplicate", "core"];
  if (reason === "product_not_received") return ["core", "shipping"];
  return ["core"];
}

// FILE evidence slots (Stripe file ids, distinct from the *_disclosure text
// fields) — where an uploaded screenshot/PDF proof lands. SLOTS = the six
// offered for upload; KEYS = every file field a dispute can carry (review and
// removal must also cover slots filled by webhooks/the Stripe Dashboard).
export const EVIDENCE_FILE_SLOTS: Array<{ key: string; label: string }> = [
  { key: "uncategorized_file", label: "Uncategorized file (general proof)" },
  { key: "receipt", label: "Receipt" },
  { key: "customer_communication", label: "Customer communication" },
  { key: "service_documentation", label: "Service documentation / usage proof" },
  { key: "refund_policy", label: "Refund policy (file)" },
  { key: "cancellation_policy", label: "Cancellation policy (file)" },
];
export const EVIDENCE_FILE_KEYS = [
  "receipt",
  "customer_communication",
  "customer_signature",
  "service_documentation",
  "shipping_documentation",
  "duplicate_charge_documentation",
  "refund_policy",
  "cancellation_policy",
  "uncategorized_file",
] as const;
// Stripe dispute_evidence uploads accept PDF/JPEG/PNG; combined evidence is
// capped around 4.5MB, so individual proofs are held to 4MB.
export const PROOF_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);
export const PROOF_MAX_BYTES = 4 * 1024 * 1024;

// Field keys the AI draft fills: the union of the reason's recommended groups.
export function aiDraftFieldsFor(reason: string | null | undefined): string[] {
  const groups = recommendedGroupKeys(reason);
  return EVIDENCE_GROUPS.filter((g) => groups.includes(g.key)).flatMap((g) => g.fields.map((f) => f.key));
}

// Shape guards for the AI draft's structured fields — the model has spilled
// narrative text into duplicate_charge_id and an email into the explanation
// before; values that can't possibly be what the field means are dropped
// instead of saved (a missing field beats a provably wrong one at the bank).
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATEISH_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./ ]\d{1,2}[./ ]\d{2,4}/;
const IPV4_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6ISH_RE = /^[0-9a-fA-F:]{3,45}$/;
export const AI_DRAFT_VALIDATORS: Record<string, (v: string) => boolean> = {
  duplicate_charge_id: (v) => CHARGE_ID_RE.test(v),
  // A bare email/id is not an explanation of why two charges are distinct.
  duplicate_charge_explanation: (v) => !EMAIL_RE.test(v) && !CHARGE_ID_RE.test(v),
  customer_email_address: (v) => EMAIL_RE.test(v),
  service_date: (v) => v.length <= 80 && DATEISH_RE.test(v),
  shipping_date: (v) => v.length <= 80 && DATEISH_RE.test(v),
  customer_purchase_ip: (v) => IPV4_RE.test(v) || IPV6ISH_RE.test(v),
};

const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);
const TERMINAL = new Set(["won", "lost", "prevented", "warning_closed"]);

// Everything the staged-evidence read-back (and the web workbench) needs in
// one shape: the live dispute, the local draft, what's staged at Stripe, and
// which local draft fields would be missing if Submit were pressed right now.
export interface StagedPackage {
  dispute: Stripe.Dispute;
  row: StripeDispute | null;
  draft: Record<string, string>;
  staged: Record<string, unknown>;
  textFields: Array<{ key: string; value: string }>;
  files: Array<{ slot: string; fileId: string }>;
  unstagedDraft: string[];
  respondable: boolean;
  terminal: boolean;
  submissions: number;
  hasEvidence: boolean;
}

export type SubmitResult =
  | { kind: "submitted"; dispute: Stripe.Dispute }
  | { kind: "not_respondable"; status: string }
  | { kind: "already_claimed" };

export type AcceptResult = { kind: "accepted"; dispute: Stripe.Dispute } | { kind: "already_claimed" };

export type FileOpResult =
  | { kind: "ok"; file?: Stripe.File }
  | { kind: "not_respondable"; status: string }
  | { kind: "invalid"; error: string };

// AI runner seams: injected here so both surfaces share the draft and
// review pipelines once they move in; unused until then.
export interface DisputeAiDeps {
  claudeRunner: ClaudeCodeRunner;
  lightAi: LightAiRunner;
  intercom: IntercomClient;
  settingsStore: SettingsStore;
}

export class DisputeEvidenceService {
  constructor(
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private sessionStore: SessionStore,
    protected ai?: DisputeAiDeps
  ) {}

  respondable(status: string): boolean {
    return RESPONDABLE.has(status);
  }

  terminal(status: string): boolean {
    return TERMINAL.has(status);
  }

  // Merge non-empty known-key values into the LOCAL draft. Empty values are
  // omitted — a blank input must never wipe text already drafted or staged.
  async saveDraft(disputeId: string, patch: Record<string, string>): Promise<{ saved: number }> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed && EVIDENCE_KEY_SET.has(key)) clean[key] = trimmed;
    }
    if (Object.keys(clean).length > 0) await this.disputeStore.mergeEvidenceDraft(disputeId, clean);
    return { saved: Object.keys(clean).length };
  }

  // Stage text evidence at Stripe WITHOUT submitting (submit:false) — the bank
  // sees nothing until submit(). Values must already be filtered to known keys
  // (saveDraft's clean pass); callers pass a unique idempotency suffix.
  async stageFields(
    disputeId: string,
    evidence: Record<string, string>,
    idemSuffix: string
  ): Promise<Stripe.Dispute> {
    return this.stripe.updateDisputeEvidence(
      disputeId,
      evidence as Stripe.DisputeUpdateParams.Evidence,
      false,
      `billadmin-dpstage-${idemSuffix}`
    );
  }

  // Upload a proof file and stage it into a slot. Validates slot/type/size
  // here (both surfaces feed hostile input) and re-checks the live status —
  // Stripe rejects file evidence once the response window closed.
  async uploadProof(
    disputeId: string,
    slot: string,
    filename: string,
    data: Buffer,
    contentType: string,
    idemSuffix: string
  ): Promise<FileOpResult> {
    if (!EVIDENCE_FILE_SLOTS.some((s) => s.key === slot)) return { kind: "invalid", error: "Unknown evidence slot." };
    const normalizedType = contentType.split(";")[0].trim().toLowerCase();
    if (!PROOF_TYPES.has(normalizedType)) {
      return { kind: "invalid", error: "The bank only accepts PNG, JPEG or PDF evidence files." };
    }
    if (data.length === 0) return { kind: "invalid", error: "The file is empty." };
    if (data.length > PROOF_MAX_BYTES) {
      return {
        kind: "invalid",
        error: "File too large — Stripe caps combined dispute evidence around 4.5MB, so keep each proof under 4MB.",
      };
    }
    const fresh = await this.stripe.getDispute(disputeId);
    if (!RESPONDABLE.has(fresh.status)) return { kind: "not_respondable", status: fresh.status };
    const file = await this.stripe.uploadDisputeEvidenceFile(filename, data, normalizedType);
    await this.stripe.updateDisputeEvidence(
      disputeId,
      { [slot]: file.id } as Stripe.DisputeUpdateParams.Evidence,
      false,
      `billadmin-dpfile-${idemSuffix}`
    );
    return { kind: "ok", file };
  }

  // Detach a staged file from the dispute ("" is Stripe's Emptyable clear).
  // The uploaded file stays in the Stripe account, it just won't reach the
  // bank. Covers every file KEY, not just the upload slots.
  async removeFile(disputeId: string, slot: string, idemSuffix: string): Promise<FileOpResult> {
    if (!(EVIDENCE_FILE_KEYS as readonly string[]).includes(slot)) return { kind: "invalid", error: "Unknown evidence slot." };
    const fresh = await this.stripe.getDispute(disputeId);
    if (!RESPONDABLE.has(fresh.status)) return { kind: "not_respondable", status: fresh.status };
    await this.stripe.updateDisputeEvidence(
      disputeId,
      { [slot]: "" } as Stripe.DisputeUpdateParams.Evidence,
      false,
      `billadmin-dpfrm-${idemSuffix}`
    );
    return { kind: "ok" };
  }

  // Read back exactly what the bank would receive, plus the local-draft diff.
  async stagedPackage(disputeId: string): Promise<StagedPackage> {
    const [row, dispute] = await Promise.all([this.disputeStore.get(disputeId), this.stripe.getDispute(disputeId)]);
    return this.packageFrom(dispute, row);
  }

  // Same computation when the caller already holds the live dispute (detail
  // pages fetch it once and reuse it — no second Stripe call).
  packageFrom(dispute: Stripe.Dispute, row: StripeDispute | null): StagedPackage {
    const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
    const staged = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
    const textFields = TEXT_EVIDENCE_KEYS.filter(
      (key) => typeof staged[key] === "string" && (staged[key] as string).trim()
    ).map((key) => ({ key, value: (staged[key] as string).trim() }));
    const files = EVIDENCE_FILE_KEYS.filter((key) => typeof staged[key] === "string" && staged[key]).map((key) => ({
      slot: key,
      fileId: staged[key] as string,
    }));
    const unstagedDraft = TEXT_EVIDENCE_KEYS.filter((key) => {
      const d = draft[key]?.trim();
      return !!d && d !== (typeof staged[key] === "string" ? (staged[key] as string).trim() : "");
    });
    const ed = dispute.evidence_details;
    return {
      dispute,
      row,
      draft,
      staged,
      textFields,
      files,
      unstagedDraft,
      respondable: RESPONDABLE.has(dispute.status),
      terminal: TERMINAL.has(dispute.status),
      submissions: ed?.submission_count ?? 0,
      hasEvidence: ed?.has_evidence ?? false,
    };
  }

  // Submit the staged evidence to the bank (submit:true, usually allowed
  // exactly once). Live status re-check + cross-admin claim: whichever
  // surface's confirm lands first wins, everyone else gets already_claimed.
  // The claim is released on Stripe failure so a retry stays possible.
  async submit(disputeId: string, actorId: string, customerIdHint: string | null): Promise<SubmitResult> {
    const fresh = await this.stripe.getDispute(disputeId);
    if (!RESPONDABLE.has(fresh.status)) return { kind: "not_respondable", status: fresh.status };
    const claimed = await this.sessionStore.claimBillingAction(actorId, `dispute-submit-${disputeId}`, "dispute_submit");
    if (!claimed) return { kind: "already_claimed" };
    let result: Stripe.Dispute;
    try {
      result = await this.stripe.updateDisputeEvidence(disputeId, {}, true, `billadmin-dpsubmit-${disputeId}`);
    } catch (error) {
      await this.sessionStore.releaseBillingAction(`dispute-submit-${disputeId}`).catch(() => {});
      throw error;
    }
    await this.disputeStore.markSubmitted(disputeId);
    await this.disputeStore.upsertFromStripe(result, customerIdHint);
    return { kind: "submitted", dispute: result };
  }

  // Accept the dispute — closes as LOST immediately, irreversible. Callers
  // gate on terminal status before offering the ceremony; the claim keeps the
  // close single-shot across surfaces.
  async accept(disputeId: string, actorId: string, customerIdHint: string | null): Promise<AcceptResult> {
    const claimed = await this.sessionStore.claimBillingAction(actorId, `dispute-accept-${disputeId}`, "dispute_accept");
    if (!claimed) return { kind: "already_claimed" };
    let result: Stripe.Dispute;
    try {
      result = await this.stripe.closeDispute(disputeId, `billadmin-dpclose-${disputeId}`);
    } catch (error) {
      await this.sessionStore.releaseBillingAction(`dispute-accept-${disputeId}`).catch(() => {});
      throw error;
    }
    await this.disputeStore.upsertFromStripe(result, customerIdHint);
    return { kind: "accepted", dispute: result };
  }

  // ---- AI pipelines: shared by /billing → Disputes and the web workbench ----

  private aiDeps(): DisputeAiDeps {
    if (!this.ai) throw new Error("Dispute AI dependencies are not wired.");
    return this.ai;
  }

  // AI evidence DRAFT: Claude Code CLI over the cloned Postiz source + docs
  // (policy fields must cite real terms), grounded with the live charge/
  // customer/subscription context, Intercom history and won-dispute exemplars.
  // Saves a LOCAL draft only — nothing is sent to Stripe except the optional
  // receipt auto-attach backfill. Deterministic fields (email, service date)
  // come from Stripe, not the model, and shape validators drop provably-wrong
  // values instead of saving them.
  async aiDraft(disputeId: string, customerIdHint: string | null): Promise<AiDraftResult> {
    const ai = this.aiDeps();
    const dispute = await this.stripe.getDispute(disputeId);
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const charge = chargeId ? await this.stripe.getCharge(chargeId).catch(() => null) : null;
    const customerId = charge
      ? typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null)
      : customerIdHint;
    const customer = customerId ? await this.stripe.getCustomer(customerId).catch(() => null) : null;
    const subs = customerId ? await this.stripe.listSubscriptions(customerId).catch(() => []) : [];

    // Real customer-communication material + few-shot exemplars from past
    // wins; both are best-effort — the draft still runs when they're missing.
    const [intercomHistory, wonExemplars] = await Promise.all([
      this.collectIntercomHistory(customerId, customer?.email ?? null).catch((error) => {
        logger.warn("intercom history lookup failed", { error: String(error) });
        return null;
      }),
      this.disputeStore.wonEvidenceExemplars(dispute.reason || "unknown", 2).catch(() => []),
    ]);

    const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

    // Fields with exactly one correct value come from Stripe, not the model —
    // they're removed from the requested set entirely so there is nothing to
    // hallucinate (the screenshot bug: an email drafted into the duplicate
    // explanation, narrative text into the charge-id field).
    const deterministic: Record<string, string> = {};
    if (customer?.email) deterministic.customer_email_address = customer.email;
    if (charge) deterministic.service_date = iso(charge.created);

    // reason=duplicate: the only truthful duplicate_charge_id is another REAL
    // charge on this customer with the same amount — look it up and hand the
    // candidates to the model (or the explicit "none exist" fact).
    let duplicateCandidates: Array<{ id: string; amountText: string; created: string; description: string | null }> = [];
    if (dispute.reason === "duplicate" && customerId && charge) {
      const { charges } = await this.stripe.listCharges(customerId, 100).catch(() => ({ charges: [], hasMore: false }));
      duplicateCandidates = charges
        .filter((c) => c.id !== charge.id && c.status === "succeeded" && c.currency === charge.currency && c.amount === charge.amount)
        .slice(0, 3)
        .map((c) => ({
          id: c.id,
          amountText: this.stripe.formatAmount(c.amount, c.currency),
          created: iso(c.created),
          description: c.description ?? null,
        }));
    }

    const fields = aiDraftFieldsFor(dispute.reason).filter((f) => !(f in deterministic));
    const prompt = buildDisputeEvidencePrompt({
      disputeId: dispute.id,
      reason: dispute.reason || "unknown",
      status: dispute.status,
      amountText: this.stripe.formatAmount(dispute.amount, dispute.currency),
      disputeCreated: iso(dispute.created),
      evidenceDueBy: dispute.evidence_details?.due_by ? iso(dispute.evidence_details.due_by) : null,
      charge: charge
        ? {
            id: charge.id,
            created: iso(charge.created),
            amountText: this.stripe.formatAmount(charge.amount, charge.currency),
            description: charge.description ?? null,
            cardBrand: charge.payment_method_details?.card?.brand ?? null,
            cardLast4: charge.payment_method_details?.card?.last4 ?? null,
          }
        : null,
      customer: customer
        ? { id: customer.id, email: customer.email ?? null, name: customer.name ?? null, created: iso(customer.created) }
        : null,
      subscriptions: subs.slice(0, 5).map((sub) => ({
        plan: subPlanLabel(this.stripe, sub),
        status: sub.status,
        started: iso(sub.created),
      })),
      fields,
      intercomHistory,
      wonExemplars,
      duplicateCandidates,
    });

    // Claude Code CLI run with Read/Glob/Grep over the cloned Postiz source +
    // docs (same knowledge base as /ai), bounded by the /config → AI ask
    // levers. Filling policy fields requires actually finding the terms.
    const effortRaw = ai.settingsStore.aiEffortAsk();
    const effort = effortRaw === "low" || effortRaw === "high" || effortRaw === "max" ? effortRaw : "medium";
    const messages = await ai.claudeRunner.run(prompt, undefined, {
      promptPrefix: null,
      model: ai.settingsStore.aiModel(),
      effort,
      maxBudgetUsd: ai.settingsStore.aiMaxBudgetUsdAsk(),
      timeoutMs: 300_000,
      telemetry: { agentName: "ai-dispute-evidence", kind: "staff_command" },
    });

    // The final message carries the JSON; earlier ones are research narration.
    // Scan backwards for the first parseable object; fall back to the raw tail
    // as the uncategorized narrative rather than losing the run.
    let draft: Record<string, string> = {};
    const rejected = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && Object.keys(draft).length === 0; i--) {
      const cleaned = messages[i]
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        for (const key of fields) {
          const value = parsed[key];
          if (typeof value !== "string" || !value.trim()) continue;
          const trimmed = value.trim();
          // Shape guard: a value that can't be what the field means (text in
          // an id field, an email as an explanation) is dropped, not saved.
          if (AI_DRAFT_VALIDATORS[key] && !AI_DRAFT_VALIDATORS[key](trimmed)) {
            rejected.add(key);
            continue;
          }
          draft[key] = trimmed.slice(0, 3800);
        }
      } catch {
        // keep scanning earlier messages
      }
    }
    if (Object.keys(draft).length === 0 && Object.keys(deterministic).length === 0) {
      draft = { uncategorized_text: (messages[messages.length - 1] ?? "").trim().slice(0, 3800) };
    }
    // Stripe-sourced values overwrite whatever the model produced for them.
    Object.assign(draft, deterministic);

    // Backfill the receipt file slot while we're here (the webhook auto-attach
    // only covers disputes created after the feature) — best-effort, the draft
    // itself must land regardless.
    let receiptStaged = false;
    if (ai.settingsStore.disputeAutoAttachReceipt()) {
      try {
        const receipt = await attachReceiptEvidence(this.stripe, dispute);
        receiptStaged = receipt.attached;
      } catch (error) {
        logger.warn("receipt auto-attach during AI draft failed", { error: String(error), "stripe.dispute_id": dispute.id });
      }
    }

    await this.disputeStore.mergeEvidenceDraft(dispute.id, draft);
    return {
      kind: "ok",
      fields: Object.keys(draft).length,
      rejected: [...rejected],
      usedIntercomHistory: !!intercomHistory,
      exemplars: wonExemplars.length,
      receiptStaged,
      customerId,
      model: ai.settingsStore.aiModel(),
    };
  }

  // Support-history context for the AI draft: resolve the customer to Intercom
  // contacts (bridge contacts carry the Discord id as external_id and no email,
  // so both lookups run), pull their newest conversations and render bounded
  // plaintext transcripts. Null on any shortfall — the draft works without it.
  private async collectIntercomHistory(customerId: string | null, email: string | null): Promise<string | null> {
    const ai = this.aiDeps();
    if (ai.settingsStore.intercomMode() === "none") return null;
    const contactIds = new Set<string>();
    if (customerId) {
      const discordIds = await this.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => []);
      for (const discordId of discordIds.slice(0, 3)) {
        const contact = await ai.intercom.findContactByExternalId(discordId).catch(() => null);
        if (contact) contactIds.add(contact.id);
      }
    }
    if (email) {
      for (const id of await ai.intercom.searchContactIdsByEmail(email).catch(() => [])) contactIds.add(id);
    }
    if (contactIds.size === 0) return null;

    const conversations: Array<{ id: string; createdAt: Date | null }> = [];
    for (const contactId of [...contactIds].slice(0, 3)) {
      conversations.push(...(await ai.intercom.searchConversationsByContact(contactId, 3).catch(() => [])));
    }
    const newest = [...new Map(conversations.map((c) => [c.id, c])).values()]
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, 3);

    const blocks: string[] = [];
    let budget = 5000; // keep the prompt bounded — transcripts can be huge
    for (const convo of newest) {
      const transcript = await ai.intercom.getConversationTranscript(convo.id).catch(() => []);
      if (!transcript.length) continue;
      const lines = transcript
        .slice(0, 12)
        .map(
          (m) =>
            `  - [${m.at ? m.at.toISOString().slice(0, 10) : "?"}] ${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`
        );
      const block = `- Conversation started ${convo.createdAt ? convo.createdAt.toISOString().slice(0, 10) : "?"}:\n${lines.join("\n")}`;
      if (block.length > budget) break;
      budget -= block.length;
      blocks.push(block);
    }
    return blocks.length ? blocks.join("\n") : null;
  }

  // AI evidence REVIEW: critiques exactly what the bank would receive — the
  // staged text plus the staged files, downloaded from Stripe and passed to
  // the light model as vision/document blocks. Local draft fields that differ
  // from staged ride along so the review can say "stage this". Read-only;
  // works on closed disputes too (post-mortem). Callers may pass a pre-fetched
  // package to skip the second dispute read (the hub shows a progress message
  // from it first).
  async aiReview(
    disputeId: string,
    opts: { pkg?: StagedPackage; telemetry?: { userId?: string; username?: string } } = {}
  ): Promise<AiReviewResult> {
    const ai = this.aiDeps();
    const pkg = opts.pkg ?? (await this.stagedPackage(disputeId));
    const dispute = pkg.dispute;
    const stagedFields = pkg.textFields.map((f) => ({ key: f.key, text: f.value.slice(0, 3800) }));
    if (!stagedFields.length && !pkg.files.length) return { kind: "nothing_staged" };

    // Pull the staged files back from Stripe; a file that can't be fetched or
    // fed to the model is reported to the reviewer instead of failing the run.
    const attachments: LightAiAttachment[] = [];
    const files: Array<{ slot: string; filename: string; attached: boolean; note: string | null }> = [];
    for (const { slot, fileId } of pkg.files) {
      try {
        const res = await this.stripe.getEvidenceFileWithContents(fileId, PROOF_MAX_BYTES);
        if (res.data && res.mimeType) {
          attachments.push({ name: res.filename, mediaType: res.mimeType, data: res.data });
          files.push({ slot, filename: res.filename, attached: true, note: null });
        } else {
          files.push({ slot, filename: res.filename, attached: false, note: res.skipped ?? "unavailable" });
        }
      } catch (error) {
        logger.warn("evidence file download for AI review failed", { error: String(error), "stripe.file_id": fileId });
        files.push({ slot, filename: fileId, attached: false, note: "download failed" });
      }
    }

    const unstagedDraft = pkg.unstagedDraft.map((key) => ({ key, text: pkg.draft[key].trim().slice(0, 1500) }));

    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const charge = chargeId ? await this.stripe.getCharge(chargeId).catch(() => null) : null;
    const customerId = charge
      ? typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null)
      : (pkg.row?.customerId ?? null);
    const customer = customerId ? await this.stripe.getCustomer(customerId).catch(() => null) : null;

    const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
    const prompt = buildDisputeEvidenceReviewPrompt({
      disputeId: dispute.id,
      reason: dispute.reason || "unknown",
      status: dispute.status,
      amountText: this.stripe.formatAmount(dispute.amount, dispute.currency),
      disputeCreated: iso(dispute.created),
      evidenceDueBy: dispute.evidence_details?.due_by ? iso(dispute.evidence_details.due_by) : null,
      submissionCount: pkg.submissions,
      charge: charge
        ? {
            id: charge.id,
            created: iso(charge.created),
            amountText: this.stripe.formatAmount(charge.amount, charge.currency),
            description: charge.description ?? null,
            cardBrand: charge.payment_method_details?.card?.brand ?? null,
            cardLast4: charge.payment_method_details?.card?.last4 ?? null,
          }
        : null,
      customer: customer
        ? { id: customer.id, email: customer.email ?? null, name: customer.name ?? null, created: iso(customer.created) }
        : null,
      stagedFields,
      files,
      unstagedDraft,
    });

    const messages = await ai.lightAi.run(prompt, undefined, {
      model: ai.settingsStore.aiModelLight(),
      maxTokens: 1_500,
      timeoutMs: 120_000,
      telemetry: {
        agentName: "ai-dispute-evidence-review",
        kind: "staff_command",
        ...(opts.telemetry?.userId ? { userId: opts.telemetry.userId } : {}),
        ...(opts.telemetry?.username ? { username: opts.telemetry.username } : {}),
      },
      attachments,
    });
    const review = messages.join("\n\n").trim();

    return {
      kind: "ok",
      review,
      stagedFieldCount: stagedFields.length,
      filesAttached: attachments.length,
      filesTotal: files.length,
      skipped: files.filter((f) => !f.attached).map((f) => ({ slot: f.slot, note: f.note ?? "unavailable" })),
      customerId,
      model: ai.settingsStore.aiModelLight(),
    };
  }
}

export type AiDraftResult = {
  kind: "ok";
  fields: number;
  rejected: string[];
  usedIntercomHistory: boolean;
  exemplars: number;
  receiptStaged: boolean;
  customerId: string | null;
  model: string;
};

export type AiReviewResult =
  | { kind: "nothing_staged" }
  | {
      kind: "ok";
      review: string;
      stagedFieldCount: number;
      filesAttached: number;
      filesTotal: number;
      skipped: Array<{ slot: string; note: string }>;
      customerId: string | null;
      model: string;
    };
