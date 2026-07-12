import type Stripe from "stripe";
import type { StripeClient } from "../StripeClient";
import { RESPONDABLE_DISPUTE_STATUSES } from "./DisputeStore";

const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

// Individual proofs are held to 4MB — Stripe caps combined dispute evidence
// around 4.5MB (same bound as the manual Attach Proof flow).
const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

export type ReceiptAttachResult =
  | { attached: true; fileId: string }
  | { attached: false; reason: "not_respondable" | "slot_filled" | "no_charge" | "no_receipt" };

// Stage the disputed charge's receipt PDF into the dispute's `receipt` FILE
// evidence slot. Always submit:false — the bank sees nothing until Submit
// Evidence. Never overwrites an already-filled slot, so a manual upload (or a
// previous run) wins. Used by the dispute-created webhook auto-action and as
// a backfill when staff run AI Draft; callers own claims/error policy.
export async function attachReceiptEvidence(stripe: StripeClient, dispute: Stripe.Dispute): Promise<ReceiptAttachResult> {
  if (!RESPONDABLE.has(dispute.status)) return { attached: false, reason: "not_respondable" };
  if (dispute.evidence?.receipt) return { attached: false, reason: "slot_filled" };
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
  if (!chargeId) return { attached: false, reason: "no_charge" };

  const pdf = await stripe.downloadChargeReceiptPdf(chargeId, RECEIPT_MAX_BYTES);
  if (!pdf) return { attached: false, reason: "no_receipt" };

  const file = await stripe.uploadDisputeEvidenceFile(`receipt-${chargeId}.pdf`, pdf, "application/pdf");
  // Key includes the file id: a retry after a crash between upload and update
  // uploads a fresh file, and reusing the old key with a new body would be a
  // Stripe idempotency_error. The slot-filled guard above prevents duplicates.
  await stripe.updateDisputeEvidence(
    dispute.id,
    { receipt: file.id } as Stripe.DisputeUpdateParams.Evidence,
    false,
    `dp-receipt-${dispute.id}-${file.id}`
  );
  return { attached: true, fileId: file.id };
}
