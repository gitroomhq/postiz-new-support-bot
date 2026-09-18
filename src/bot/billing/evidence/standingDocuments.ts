import type Stripe from "stripe";
import type { StripeClient } from "../../StripeClient";
import { RESPONDABLE_DISPUTE_STATUSES } from "../DisputeStore";
import { STANDING_DOCUMENT_SLOTS, type EvidenceDocumentStore } from "./EvidenceDocumentStore";
import { log } from "../../../util/logger";

const docLog = log.child("dispute-evidence-docs");
const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

export interface AttachDocumentsResult {
  attached: string[];
  // Slots that already held a file. Reported rather than silently skipped: a
  // policy that never attaches because a proof is sitting in its slot is worth
  // seeing.
  occupied: string[];
  // Slots with no document in the library. This is the state that reads as a
  // broken feature: an operator who believes they uploaded a policy and sees
  // nothing attached has no way to tell a failed upload from a working one.
  empty: string[];
}

// Stamp every standing document into its slot, for the slots this dispute has
// not filled already.
//
// The rules are the receipt's, for the same reasons (receiptEvidence.ts):
//   - never overwrite a filled slot, so a human's upload always wins
//   - always submit:false, so the bank sees nothing until Submit Evidence
//   - one update call for the whole set, keyed for idempotency on what it writes
//
// Unlike the receipt there is no upload here. The file was uploaded once when
// the operator added the document, and a dispute_evidence file can be
// referenced by any number of disputes, so this is a pure field write.
export async function attachStandingDocuments(
  stripe: StripeClient,
  store: EvidenceDocumentStore,
  dispute: Stripe.Dispute
): Promise<AttachDocumentsResult> {
  const out: AttachDocumentsResult = { attached: [], occupied: [], empty: [] };
  if (!RESPONDABLE.has(dispute.status)) return out;

  const documents = await store.bySlot();
  // Walk the slots this panel offers rather than only the rows that exist, so
  // an empty library reports itself instead of returning quietly.
  for (const spec of STANDING_DOCUMENT_SLOTS) if (!documents.has(spec.slot)) out.empty.push(spec.slot);
  if (!documents.size) return out;

  const current = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
  const update: Record<string, string> = {};
  for (const [slot, doc] of documents) {
    if (current[slot]) {
      out.occupied.push(slot);
      continue;
    }
    update[slot] = doc.stripeFileId;
    out.attached.push(slot);
  }
  if (!out.attached.length) return out;

  // The key names the file ids: replacing a policy and re-attaching writes a
  // different body, which reusing a key would make a Stripe idempotency_error.
  const key = `dp-docs-${dispute.id}-${out.attached.map((s) => update[s]).join("-")}`.slice(0, 200);
  await stripe.updateDisputeEvidence(dispute.id, update as Stripe.DisputeUpdateParams.Evidence, false, key);
  docLog.info("standing evidence documents attached", {
    "stripe.dispute_id": dispute.id,
    "evidence.slots": out.attached.join(","),
  });
  return out;
}
