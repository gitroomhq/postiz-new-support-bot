import type Stripe from "stripe";
import type { StripeClient } from "../../StripeClient";
import { RESPONDABLE_DISPUTE_STATUSES } from "../DisputeStore";
import { STANDING_DOCUMENT_SLOTS, type EvidenceDocumentStore } from "./EvidenceDocumentStore";
import { log } from "../../../util/logger";

const docLog = log.child("dispute-evidence-docs");
const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

// Individual proofs are held to 4MB, the same bound as every other evidence
// file (receiptEvidence.ts), because Stripe caps combined evidence near 4.5MB.
const MAX_BYTES = 4 * 1024 * 1024;

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
  // Slots whose document exists but could not be copied for this dispute.
  failed: Array<{ slot: string; why: string }>;
}

// A Stripe file with purpose dispute_evidence belongs to ONE dispute.
//
// This is the correction to the design this feature shipped with. Reusing the
// stored file id on a second dispute is refused with "That file is already
// attached to something else", so the first dispute to be answered consumed
// each policy and every dispute afterwards silently got nothing.
//
// So the stored file is a MASTER copy, and each dispute gets its own upload
// taken from it. The bytes are fetched from Stripe once per process and held
// here, which keeps the cost at one upload per slot per dispute rather than a
// download as well.
const masters = new Map<string, { data: Buffer; contentType: string; fileName: string }>();
// Three slots exist, and replacing a policy mints a new id, so a handful of
// entries covers normal life. The bound stops a long-lived process that has
// seen many replacements from holding every one of them.
const MASTER_CACHE_MAX = 6;

async function copyForDispute(
  stripe: StripeClient,
  doc: { stripeFileId: string; fileName: string }
): Promise<{ fileId: string } | { why: string }> {
  let master = masters.get(doc.stripeFileId);
  if (!master) {
    const got = await stripe.getEvidenceFileWithContents(doc.stripeFileId, MAX_BYTES);
    if (!got.data || !got.mimeType) return { why: `master file unreadable (${got.skipped ?? "no contents"})` };
    master = { data: got.data, contentType: got.mimeType, fileName: doc.fileName || got.filename };
    if (masters.size >= MASTER_CACHE_MAX) masters.delete(masters.keys().next().value as string);
    masters.set(doc.stripeFileId, master);
  }
  // An upload that succeeds and is then never stamped leaves an orphan file in
  // the Stripe account. Harmless, unreferenced, and strictly better than the
  // alternative of stamping an id we are not sure exists.
  const file = await stripe.uploadDisputeEvidenceFile(master.fileName, master.data, master.contentType);
  return { fileId: file.id };
}

/** Test seam: the master cache is process-wide, so a test must be able to clear it. */
export function resetStandingDocumentCache(): void {
  masters.clear();
}

// Stamp a copy of every standing document into its slot, for the slots this
// dispute has not filled already.
//
// The rules are the receipt's, for the same reasons (receiptEvidence.ts):
//   - never overwrite a filled slot, so a human's upload always wins
//   - always submit:false, so the bank sees nothing until Submit Evidence
//   - one update call for the whole set, keyed for idempotency on what it writes
export async function attachStandingDocuments(
  stripe: StripeClient,
  store: EvidenceDocumentStore,
  dispute: Stripe.Dispute
): Promise<AttachDocumentsResult> {
  const out: AttachDocumentsResult = { attached: [], occupied: [], empty: [], failed: [] };
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
    // One slot's failure is reported and the rest still go: a missing refund
    // policy is no reason to withhold the terms of service.
    const copy = await copyForDispute(stripe, doc).catch((error) => ({
      why: error instanceof Error ? error.message : String(error),
    }));
    if ("why" in copy) {
      out.failed.push({ slot, why: copy.why });
      continue;
    }
    update[slot] = copy.fileId;
    out.attached.push(slot);
  }
  if (!out.attached.length) return out;

  // The key names the freshly uploaded ids, which are unique per dispute, so a
  // retry after a crash writes a different body under a different key rather
  // than colliding.
  const key = `dp-docs-${dispute.id}-${out.attached.map((s) => update[s]).join("-")}`.slice(0, 200);
  await stripe.updateDisputeEvidence(dispute.id, update as Stripe.DisputeUpdateParams.Evidence, false, key);
  docLog.info("standing evidence documents attached", {
    "stripe.dispute_id": dispute.id,
    "evidence.slots": out.attached.join(","),
  });
  return out;
}
