import type Stripe from "stripe";
import type { StripeClient } from "../StripeClient";
import type { SessionStore } from "../../auth/SessionStore";
import { Logger } from "../../util/logger";
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

// Shape guards for the structured evidence fields. These are no longer
// anti-hallucination guards, because there is no model any more: they are the
// safety net for an operator's template override and for anything typed into
// an editor by hand. A value that cannot possibly be what its field means is
// dropped rather than saved, because a missing field beats a provably wrong
// one at the bank.
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATEISH_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./ ]\d{1,2}[./ ]\d{2,4}/;
const IPV4_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6ISH_RE = /^[0-9a-fA-F:]{3,45}$/;
export const EVIDENCE_FIELD_VALIDATORS: Record<string, (v: string) => boolean> = {
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

export class DisputeEvidenceService {
  constructor(
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private sessionStore: SessionStore
  ) {}

  respondable(status: string): boolean {
    return RESPONDABLE.has(status);
  }

  terminal(status: string): boolean {
    return TERMINAL.has(status);
  }

  // Merge non-empty known-key values into the LOCAL draft. Empty values are
  // omitted — a blank input must never wipe text already drafted or staged.
  // Rejected keys come back so a caller can flag the field instead of silently
  // discarding what somebody typed. The shape guards run here because this is
  // the one door every manual edit comes through, and an id or a date that
  // cannot be what its field means is worth more to a bank left empty.
  async saveDraft(disputeId: string, patch: Record<string, string>): Promise<{ saved: number; rejected: string[] }> {
    const clean: Record<string, string> = {};
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || !EVIDENCE_KEY_SET.has(key)) continue;
      const validator = EVIDENCE_FIELD_VALIDATORS[key];
      if (validator && !validator(trimmed)) {
        rejected.push(key);
        continue;
      }
      clean[key] = trimmed;
    }
    if (Object.keys(clean).length > 0) await this.disputeStore.mergeEvidenceDraft(disputeId, clean);
    return { saved: Object.keys(clean).length, rejected };
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
        error: "File too large: Stripe caps combined dispute evidence around 4.5MB, so keep each proof under 4MB.",
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
}
