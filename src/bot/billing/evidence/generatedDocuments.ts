import type Stripe from "stripe";
import type { StripeClient } from "../../StripeClient";
import { RESPONDABLE_DISPUTE_STATUSES } from "../DisputeStore";
import type { EvidenceFacts } from "./tokens";
import { redactAuthor, redactForBank } from "./redact";
import { renderTextPdf, wrap, COLUMNS, type PdfLine } from "./pdf/textPdf";
import { log } from "../../../util/logger";

const genLog = log.child("dispute-evidence-docs");
const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

// The two evidence documents that cannot be uploaded ahead of time, because
// they are made of this dispute's own facts: what the account actually did with
// the product, and what the customer actually said to us.
//
// They are built from facts already gathered for the text fields, so producing
// them costs no extra Stripe or Intercom calls. The same rules as every other
// attachment apply: never overwrite a slot a human filled, always submit:false,
// and no document at all rather than one making a claim the facts do not carry.

const SLOT_USAGE = "service_documentation";
const SLOT_TRANSCRIPT = "customer_communication";

export interface GeneratedDocumentsResult {
  attached: string[];
  // Why a document was not produced, for the operator rather than the bank.
  skipped: Array<{ slot: string; why: string }>;
}

function date(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "date unknown";
}

function heading(title: string, subtitle: string[]): PdfLine[] {
  return [
    { text: title, bold: true },
    { text: "=".repeat(Math.min(COLUMNS, title.length)) },
    { text: "" },
    ...subtitle.map((t) => ({ text: t })),
    { text: "" },
  ];
}

// A footer that says what this document is and is not. An analyst who cannot
// tell whether a page is a record or an argument tends to treat it as an
// argument, which is the weaker reading.
function provenance(dispute: Stripe.Dispute, source: string): PdfLine[] {
  return [
    { text: "" },
    { text: "-".repeat(COLUMNS) },
    { text: `Generated from ${source} for dispute ${dispute.id} on ${new Date().toISOString().slice(0, 10)}.` },
    ...wrap(
      "This is an extract of the merchant's own records, reproduced without alteration except where noted. " +
        "Figures are counts held in the platform database, not estimates."
    ).map((text) => ({ text })),
  ];
}

/** The account's real use of the product: what was published, and when. */
export function buildUsageDocument(dispute: Stripe.Dispute, facts: EvidenceFacts): PdfLine[] | null {
  const usage = facts.usage;
  // No usage feed, or an account that genuinely did nothing: in both cases a
  // document would either be empty or would have to hedge, and a hedged
  // document is worth less than none.
  if (!usage || usage.published === 0) return null;

  const chargeDate = date(facts.charge?.dateIso);
  const lines: PdfLine[] = heading("ACCOUNT USAGE RECORD", [
    `Customer: ${facts.customer?.email ?? facts.customer?.id ?? "on file"}`,
    `Disputed charge: ${facts.charge?.amountText ?? facts.dispute.amountText} on ${chargeDate}`,
  ]);

  lines.push({ text: "Summary", bold: true });
  const summary: Array<[string, string]> = [
    ["Posts published in total", String(usage.published)],
    ["Published BEFORE the disputed charge", String(usage.publishedBeforeCharge)],
    ["Published AFTER the disputed charge", String(usage.publishedSinceCharge)],
    ["Social channels connected and live", String(usage.channelsLive)],
    ["Channels connected during the paid period", String(usage.channelsDuringPeriod)],
    ["Posts scheduled and awaiting publication", String(usage.queued)],
  ];
  if (usage.publishedDeleted > 0) {
    // Stated rather than hidden. A post deleted later was still published, and
    // an analyst who finds the discrepancy elsewhere distrusts the whole page.
    summary.push(["Published and later deleted by the account", String(usage.publishedDeleted)]);
  }
  if (usage.deletedAfterDispute > 0) {
    summary.push(["Deleted AFTER this dispute was opened", String(usage.deletedAfterDispute)]);
  }
  for (const [label, value] of summary) lines.push({ text: `  ${label.padEnd(48, ".")} ${value}` });
  lines.push({ text: "" });

  if (usage.firstPublishedIso) {
    lines.push(
      ...wrap(
        `First post published on ${date(usage.firstPublishedIso)}` +
          (usage.lastPublishedIso ? `, most recent on ${date(usage.lastPublishedIso)}.` : ".")
      ).map((text) => ({ text }))
    );
    lines.push({ text: "" });
  }

  if (usage.perPlatform.length) {
    lines.push({ text: "Published per platform", bold: true });
    for (const row of usage.perPlatform) lines.push({ text: `  ${row.platform.padEnd(24, ".")} ${row.count}` });
    lines.push({ text: "" });
  }

  if (usage.channels.length) {
    lines.push({ text: "Connected channels", bold: true });
    for (const c of usage.channels.slice(0, 40)) {
      const state = c.deletedIso ? `removed ${date(c.deletedIso)}` : c.disabled ? "disabled" : "active";
      lines.push({ text: `  ${date(c.connectedIso)}  ${c.platform.padEnd(12)} ${c.name.slice(0, 32).padEnd(34)} ${state}` });
    }
    lines.push({ text: "" });
  }

  const posts = usage.recentPostsSinceCharge.length ? usage.recentPostsSinceCharge : usage.recentPosts;
  if (posts.length) {
    lines.push({
      text: usage.recentPostsSinceCharge.length ? "Posts published after the disputed charge" : "Recent posts published",
      bold: true,
    });
    for (const p of posts.slice(0, 25)) {
      lines.push({ text: `  ${date(p.publishedIso)}  ${p.platform}` });
      // The URL is the verifiable part: an analyst can open it.
      for (const l of wrap(p.url, COLUMNS - 6, "      ")) lines.push({ text: `      ${l.trimStart()}` });
    }
  }

  lines.push(...provenance(dispute, "the Postiz platform database"));
  return lines;
}

/** What the customer actually said to support, and what support said back. */
export function buildTranscriptDocument(dispute: Stripe.Dispute, facts: EvidenceFacts): PdfLine[] | null {
  const support = facts.support;
  if (!support || !support.transcript.length) return null;
  const keepEmail = facts.customer?.email ?? null;

  const lines: PdfLine[] = heading("SUPPORT CORRESPONDENCE", [
    `Customer: ${keepEmail ?? facts.customer?.id ?? "on file"}`,
    `Conversations on record: ${support.conversationCount}` +
      (support.firstContactIso ? `, first contact ${date(support.firstContactIso)}` : ""),
  ]);

  lines.push(
    ...wrap(
      "Personal names of support staff, and any contact details or payment credentials appearing in the text, " +
        "have been replaced with [redacted]. Nothing else has been altered, reordered or removed."
    ).map((text) => ({ text })),
    { text: "" }
  );

  for (const convo of support.transcript) {
    lines.push({ text: `Conversation opened ${date(convo.startedAtIso)}`, bold: true });
    lines.push({ text: "-".repeat(COLUMNS) });
    for (const m of convo.messages) {
      const who = redactAuthor(m.author);
      lines.push({ text: `${date(m.atIso)}  ${who}:`, bold: true });
      const body = redactForBank(m.text.replace(/\s*\n\s*/g, "\n"), { keepEmail });
      for (const l of wrap(body, COLUMNS - 4)) lines.push({ text: `    ${l}` });
      lines.push({ text: "" });
    }
    if (convo.clipped) lines.push({ text: "  (further messages in this conversation are not reproduced)" });
    lines.push({ text: "" });
  }

  lines.push(...provenance(dispute, "the merchant's support system (Intercom)"));
  return lines;
}

// Build, upload and stamp both documents for the slots this dispute has not
// filled. One Stripe update for whatever was produced, mirroring the standing
// documents, and never a slot a human has already used.
export async function attachGeneratedDocuments(
  stripe: StripeClient,
  dispute: Stripe.Dispute,
  facts: EvidenceFacts
): Promise<GeneratedDocumentsResult> {
  const out: GeneratedDocumentsResult = { attached: [], skipped: [] };
  if (!RESPONDABLE.has(dispute.status)) return out;

  const current = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
  const wanted: Array<{ slot: string; name: string; lines: PdfLine[] | null; why: string }> = [
    {
      slot: SLOT_USAGE,
      name: `usage-record-${dispute.id}.pdf`,
      lines: buildUsageDocument(dispute, facts),
      why: "no usage feed, or the account published nothing",
    },
    {
      slot: SLOT_TRANSCRIPT,
      name: `support-correspondence-${dispute.id}.pdf`,
      lines: buildTranscriptDocument(dispute, facts),
      why: "no support conversation was read for this customer",
    },
  ];

  const update: Record<string, string> = {};
  for (const doc of wanted) {
    if (current[doc.slot]) {
      out.skipped.push({ slot: doc.slot, why: "slot already filled" });
      continue;
    }
    if (!doc.lines) {
      out.skipped.push({ slot: doc.slot, why: doc.why });
      continue;
    }
    const pdf = renderTextPdf(doc.lines);
    const file = await stripe.uploadDisputeEvidenceFile(doc.name, pdf, "application/pdf");
    update[doc.slot] = file.id;
    out.attached.push(doc.slot);
  }
  if (!out.attached.length) return out;

  const key = `dp-gendocs-${dispute.id}-${out.attached.map((s) => update[s]).join("-")}`.slice(0, 200);
  await stripe.updateDisputeEvidence(dispute.id, update as Stripe.DisputeUpdateParams.Evidence, false, key);
  genLog.info("generated evidence documents attached", {
    "stripe.dispute_id": dispute.id,
    "evidence.slots": out.attached.join(","),
  });
  return out;
}
