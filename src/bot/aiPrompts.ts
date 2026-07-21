// Prompt builders for the dispute-evidence AI drafts (/billing → Disputes).
// The /ai staff-command builders were retired with the agent-rip — agents work
// tickets in Intercom now; only the Stripe dispute console still drafts with
// the CLI runner over the cloned Postiz source + docs in search/.

export interface DisputeEvidenceContext {
  disputeId: string;
  reason: string;
  status: string;
  amountText: string;
  disputeCreated: string; // ISO date
  evidenceDueBy: string | null; // ISO date
  charge: {
    id: string;
    created: string; // ISO date
    amountText: string;
    description: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
  } | null;
  customer: { id: string; email: string | null; name: string | null; created: string | null } | null;
  subscriptions: Array<{ plan: string; status: string; started: string }>;
  // Which evidence fields the staff modal will show — the model fills exactly these.
  fields: string[];
  // Real support-conversation excerpts for THIS customer (Intercom), already
  // plaintext + length-bounded. Null = bridge off / no contact / lookup failed.
  intercomHistory: string | null;
  // Submitted text evidence from past WON disputes (same reason preferred) —
  // style/structure reference only, their customer facts must never leak.
  wonExemplars: Array<{ reason: string; evidence: Record<string, string> }>;
  // For reason=duplicate: this customer's OTHER charges with the same amount —
  // real candidates for the "original" charge. Empty = none exist, in which
  // case duplicate_charge_id must be omitted rather than invented.
  duplicateCandidates: Array<{ id: string; amountText: string; created: string; description: string | null }>;
}

// Drafts dispute-evidence text for staff review — runs on the Claude Code CLI
// with Read/Glob/Grep over the cloned Postiz source + docs, so policy fields
// can quote the REAL published terms instead of staying empty. The output is
// STRICT JSON and is only ever saved as a LOCAL draft — the AI path has no
// route to Stripe; staging/submitting happens through the human-reviewed
// modal + confirm.
export function buildDisputeEvidencePrompt(ctx: DisputeEvidenceContext): string {
  const facts = [
    `Dispute: ${ctx.disputeId} · reason ${ctx.reason} · status ${ctx.status} · amount ${ctx.amountText} · opened ${ctx.disputeCreated}${ctx.evidenceDueBy ? ` · evidence due ${ctx.evidenceDueBy}` : ""}`,
    ctx.charge
      ? `Charge: ${ctx.charge.id} · ${ctx.charge.amountText} · created ${ctx.charge.created}${ctx.charge.description ? ` · description "${ctx.charge.description}"` : ""}${ctx.charge.cardBrand ? ` · ${ctx.charge.cardBrand} •••• ${ctx.charge.cardLast4 ?? "????"}` : ""}`
      : "Charge: unknown",
    ctx.customer
      ? `Customer: ${ctx.customer.id}${ctx.customer.email ? ` · ${ctx.customer.email}` : ""}${ctx.customer.name ? ` · ${ctx.customer.name}` : ""}${ctx.customer.created ? ` · Stripe customer since ${ctx.customer.created}` : ""}`
      : "Customer: unknown",
    ctx.subscriptions.length
      ? `Subscriptions:\n${ctx.subscriptions.map((s) => `- ${s.plan} · ${s.status} · started ${s.started}`).join("\n")}`
      : "Subscriptions: none found",
    ctx.intercomHistory
      ? `Support conversations with this customer (Intercom, real quotes usable as customer_communication evidence):\n${ctx.intercomHistory}`
      : null,
    ctx.reason === "duplicate"
      ? ctx.duplicateCandidates.length
        ? `Other charges on this customer with the SAME amount (real candidates for the original charge in duplicate_charge_id):\n${ctx.duplicateCandidates
            .map((c) => `- ${c.id} · ${c.amountText} · created ${c.created}${c.description ? ` · "${c.description}"` : ""}`)
            .join("\n")}`
        : "Duplicate check: this customer has NO other charge with the same amount. There is no original charge. OMIT duplicate_charge_id entirely and make duplicate_charge_explanation state the factual position: only one charge of this amount exists, so nothing was charged twice."
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const exemplarBlock = ctx.wonExemplars.length
    ? `\nPAST WON DISPUTES (style/structure reference ONLY: these are OTHER customers' cases; never copy their names, emails, dates, plans or any customer-specific detail into this draft):\n${ctx.wonExemplars
        .map(
          (ex, i) =>
            `--- Won dispute ${i + 1} (reason: ${ex.reason}) ---\n${Object.entries(ex.evidence)
              .map(([key, text]) => `${key}: ${text.slice(0, 700)}`)
              .join("\n")}`
        )
        .join("\n")}\n`
    : "";

  return `You draft chargeback-dispute evidence for Postiz (a social-media scheduling SaaS, sold as a subscription; the merchant is the Postiz team).

You are working inside the Postiz knowledge base: Read/Glob/Grep the product source at ./postiz-app and the documentation at ./postiz-docs. Search them for real, quotable material: refund/cancellation/terms policy pages, pricing and plan descriptions, feature docs, subscription/billing behavior in the code.

Write from the merchant's perspective, factual and concise. Evidence text is read by bank analysts who skim.
RULES:
- Fill every field you can ground in the FACTS or the knowledge base with substantive text. OMIT any field you would have to guess. Leave it out of the JSON entirely; a missing field is far better than an invented one (bank analysts reject responses over one provably wrong claim).
- Every field's value must match that field's MEANING. duplicate_charge_id takes ONLY a real Stripe charge id (ch_… / py_…) taken verbatim from the FACTS; service_date and shipping_date take ONLY a date; customer_email_address takes ONLY an email address. Never spill a description, an email, or narrative text into an id/date field.
- The reader is a BANK ANALYST, not a developer. NEVER include internal artifacts in the evidence text: no file paths, repository or folder names, code identifiers, function/variable names, "./postiz-docs/…" style references, or any mention that you searched a codebase. Cite policies by their public location only (e.g. "as published on the Postiz documentation site" or "shown during checkout"), in plain business language.
- Policy fields (refund_policy_disclosure, cancellation_policy_disclosure, cancellation_rebuttal): find the actual published policy/terms in the docs or source and quote or faithfully paraphrase them. If no explicit policy document exists, accurately describe how the product verifiably behaves per the code/docs (e.g. self-service cancellation available anytime from the billing settings, subscriptions bill per period until cancelled). Never present behavior the code doesn't have.
- NEVER invent customer-specific facts: no fabricated order numbers, IP addresses, raw log lines, dates or communications. Customer-specific content comes ONLY from the FACTS below: service_date is the charge date; customer_email_address is the customer's email; access_activity_log describes the factual account/billing history from the FACTS (signup date, subscription plan/status, renewal charges) in prose, not fabricated log lines.
- If the FACTS include real support conversations, they are strong evidence: quote or faithfully summarize the relevant exchanges (what the customer asked, what was delivered/answered, dates), especially where they show the customer actively used the product, acknowledged the subscription, or was helped. Never quote anything from a conversation that isn't in the FACTS.
- If past won disputes are provided, mirror what made them effective (structure, tone, which facts they led with), but every customer-specific detail in this draft must come from THIS dispute's FACTS.
- Each field at most 3500 characters.
${exemplarBlock}
FACTS:
${facts}

FINAL ANSWER: after your research, respond with ONLY a JSON object (no code fences, no commentary before or after it). Allowed keys, in this order: ${ctx.fields.join(", ")}. Include only the keys you could ground in real material; omit the rest.`;
}

export interface DisputeEvidenceReviewContext {
  disputeId: string;
  reason: string;
  status: string;
  amountText: string;
  disputeCreated: string; // ISO date
  evidenceDueBy: string | null; // ISO date
  submissionCount: number;
  charge: {
    id: string;
    created: string; // ISO date
    amountText: string;
    description: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
  } | null;
  customer: { id: string; email: string | null; name: string | null; created: string | null } | null;
  // Text evidence currently staged at Stripe — exactly what Submit would send.
  stagedFields: Array<{ key: string; text: string }>;
  // File evidence slots. `attached` files precede the prompt as vision/document
  // blocks IN THIS ORDER; the rest carry the reason they couldn't be included.
  files: Array<{ slot: string; filename: string; attached: boolean; note: string | null }>;
  // Local draft fields that differ from what's staged — written but not yet
  // part of what the bank would receive.
  unstagedDraft: Array<{ key: string; text: string }>;
}

// Critiques the staged evidence package before submission — a tool-less,
// cheap-model read of exactly what the bank would receive (staged text + the
// attached evidence files passed as vision/document blocks). Output is a
// human-readable verdict for the ephemeral panel; nothing here writes back.
export function buildDisputeEvidenceReviewPrompt(ctx: DisputeEvidenceReviewContext): string {
  const facts = [
    `Dispute: ${ctx.disputeId} · reason ${ctx.reason} · status ${ctx.status} · amount ${ctx.amountText} · opened ${ctx.disputeCreated}${
      ctx.evidenceDueBy ? ` · evidence due ${ctx.evidenceDueBy}` : ""
    } · submitted ${ctx.submissionCount}× so far`,
    ctx.charge
      ? `Charge: ${ctx.charge.id} · ${ctx.charge.amountText} · created ${ctx.charge.created}${ctx.charge.description ? ` · description "${ctx.charge.description}"` : ""}${ctx.charge.cardBrand ? ` · ${ctx.charge.cardBrand} •••• ${ctx.charge.cardLast4 ?? "????"}` : ""}`
      : "Charge: unknown",
    ctx.customer
      ? `Customer: ${ctx.customer.id}${ctx.customer.email ? ` · ${ctx.customer.email}` : ""}${ctx.customer.name ? ` · ${ctx.customer.name}` : ""}${ctx.customer.created ? ` · Stripe customer since ${ctx.customer.created}` : ""}`
      : "Customer: unknown",
  ].join("\n");

  const stagedBlock = ctx.stagedFields.length
    ? ctx.stagedFields.map((f) => `--- ${f.key} ---\n${f.text}`).join("\n")
    : "(no text evidence staged)";

  const filesBlock = ctx.files.length
    ? ctx.files
        .map(
          (f, i) =>
            `${i + 1}. slot ${f.slot} · "${f.filename}" · ${f.attached ? "ATTACHED above (in this order)" : `NOT attached (${f.note ?? "unavailable"}): flag that you could not verify it`}`
        )
        .join("\n")
    : "(no evidence files)";

  const draftBlock = ctx.unstagedDraft.length
    ? `\nLOCAL DRAFT NOT YET STAGED (the bank will NOT see these unless staged first; compare against the staged text and say whether staging them would help):\n${ctx.unstagedDraft
        .map((f) => `--- ${f.key} (draft) ---\n${f.text}`)
        .join("\n")}\n`
    : "";

  return `You are a veteran chargeback-evidence reviewer working for the merchant (Postiz, a social-media scheduling SaaS sold as a subscription). Below is the evidence package currently staged at Stripe for a dispute: exactly what the issuing bank's analyst would receive on Submit. Attached before this text are the evidence files, in the order listed under FILES.

Review it the way a skeptical bank analyst would, and report to the staff member deciding whether to submit:
1. VERDICT. One line: "Ready to submit", "Submit after fixes", or "Not ready", with the single most important reason.
2. FACT CHECK. Anything in the evidence that contradicts the FACTS, sits in the wrong field for its meaning (e.g. narrative text in an id or date field), or reads as invented/unverifiable. This is the top rejection risk; check every field.
3. FILES. For each attached file: what it actually shows and whether it supports the slot it sits in; call out unreadable, irrelevant or mislabeled files. Mention any file you could not see.
4. GAPS. The strongest evidence for a "${ctx.reason}" dispute that is missing or weak, most valuable first.
5. POLISH. Internal artifacts a bank must never see (file paths, repo/code names), unprofessional tone, or filler that dilutes the case.

Be concrete: name the field key or file, quote the offending words. If something is genuinely strong, say so in one line; don't pad. Plain text with short headings, no preamble, UNDER 3200 characters total.

FACTS (source of truth):
${facts}

STAGED TEXT EVIDENCE:
${stagedBlock}

FILES:
${filesBlock}
${draftBlock}`;
}
