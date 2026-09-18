import type Stripe from "stripe";
import type { StripeDispute } from "../../../generated/prisma/client";
import {
  EVIDENCE_FILE_SLOTS,
  EVIDENCE_GROUPS,
  PROOF_MAX_BYTES,
  PROOF_TYPES,
  recommendedGroupKeys,
  type StagedPackage,
} from "../../../bot/billing/DisputeEvidenceService";
import { ActionButton, Badge, Block, Cell, EvidenceBlock, HeaderBlock, TableBlock } from "../../renderer/contract";
import { DashboardCtx, SectionPage } from "../types";
import { badgeCell, idCell, isoDateCell, sentence, text } from "../cells";
import { DisputesDeps, dueBadge, dueCells, eventTone, notFound, registryButton, statusBadgeFor } from "./cells";

// The dispute detail page: build the pack, read what it produced, submit.
//
// Those three beats are the whole job, so they are the whole page. The status
// bar carries the state and the two buttons; the pack, exactly as the bank will
// receive it, is the body; everything that merely describes the dispute is a
// rail card or folded away. What this page must never do again is push the
// work below the fold behind a stack of notices about it.

// Field keys are Stripe's; the operator reads the catalog's labels.
const FIELD_LABELS = new Map<string, string>(
  EVIDENCE_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label] as [string, string]))
);

// Which single state the page leads with. Explicit precedence, because the old
// page stacked all four at once and the most urgent one was whichever happened
// to be rendered last.
type LeadState = "terminal" | "past_due" | "unstaged" | "under_review" | "open";

function leadStateOf(pkg: StagedPackage, pastDue: boolean): LeadState {
  if (pkg.terminal) return "terminal";
  if (pastDue) return "past_due";
  if (pkg.respondable && pkg.unstagedDraft.length > 0) return "unstaged";
  if (!pkg.respondable) return "under_review";
  return "open";
}

function agoLabel(d: Date): string {
  const hours = (Date.now() - d.getTime()) / 3_600_000;
  if (hours < 48) return `${Math.max(1, Math.round(hours))}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The one sentence the lead state is owed. A state that can refuse the
// operator something has to say why, so the status bar keeps its notice even
// though the state itself is already a pill.
function leadNotice(state: LeadState, pkg: StagedPackage, status: string): Block | null {
  if (state === "terminal") {
    const won = status === "won" || status === "prevented";
    return {
      type: "notice",
      badge: { kind: won ? "ok" : "error", text: sentence(status.replace(/_/g, " ")) },
      text: won
        ? "This dispute is closed in your favor; everything below is the submitted record."
        : "This dispute is closed. The evidence below is the read-only record of what was (or wasn't) sent.",
    };
  }
  if (state === "past_due") {
    return {
      type: "notice",
      badge: { kind: "error", text: "Past due" },
      text: "The evidence deadline has passed; Stripe may still accept a submission briefly, but the bank can ignore late responses. Submit immediately or accept.",
    };
  }
  if (state === "unstaged") {
    return {
      type: "notice",
      badge: { kind: "warn", text: `${pkg.unstagedDraft.length} draft` },
      text: `Local draft fields not staged at Stripe yet: ${pkg.unstagedDraft.slice(0, 6).join(", ")}${pkg.unstagedDraft.length > 6 ? ", …" : ""}; stage their groups below or they won't reach the bank.`,
    };
  }
  if (state === "under_review") {
    return {
      type: "notice",
      badge: { kind: "info", text: "Under review" },
      text: "The response is with the bank; evidence can no longer be changed. A decision usually takes 60–75 days.",
    };
  }
  return null;
}

// The status bar's facts: the lead state, the deadline with its countdown, and
// what is actually staged. These were four full-width stat tiles.
function statusMeta(
  state: LeadState,
  pkg: StagedPackage,
  row: StripeDispute,
  status: string
): NonNullable<HeaderBlock["meta"]> {
  const meta: NonNullable<HeaderBlock["meta"]> = [];

  if (state === "terminal") {
    meta.push({ label: "Closed", value: sentence(status.replace(/_/g, " ")), badge: statusBadgeFor(status) });
  } else if (state === "past_due") {
    meta.push({
      label: "Past due",
      value: row.evidenceDueBy ? `Deadline passed ${agoLabel(row.evidenceDueBy)}` : "Deadline passed",
      badge: { kind: "error", text: "Submit or accept" },
    });
  } else if (state === "unstaged") {
    meta.push({
      label: "Unstaged drafts",
      value: plural(pkg.unstagedDraft.length, "field"),
      badge: { kind: "warn", text: "not at Stripe" },
    });
  } else if (state === "under_review") {
    meta.push({ label: "Under review", value: "With the bank", badge: { kind: "info", text: "no changes" } });
  } else {
    meta.push({ label: "Needs response", value: sentence(status.replace(/_/g, " ")) });
  }

  meta.push({
    label: "Evidence due",
    value: row.evidenceDueBy ? row.evidenceDueBy.toISOString().slice(0, 10) : "no response window",
    ...(row.evidenceDueBy && state !== "terminal" ? { badge: dueBadge(row.evidenceDueBy) } : {}),
  });

  meta.push({
    label: "Staged",
    value: `${plural(pkg.textFields.length, "field")}, ${plural(pkg.files.length, "file")}`,
  });

  // Drafts already lead the bar when they are the worst thing about this
  // dispute; when something worse leads, they still have to be visible.
  if (state !== "unstaged" && pkg.respondable && pkg.unstagedDraft.length > 0) {
    meta.push({
      label: "Drafts",
      value: `${pkg.unstagedDraft.length} unstaged`,
      badge: { kind: "warn", text: "not sent" },
    });
  }
  if (pkg.submissions > 0) {
    meta.push({ label: "Submitted", value: `${pkg.submissions}×`, badge: { kind: "info", text: "sent" } });
  }
  return meta;
}

// What the last build actually did. The pack refuses to assert things it cannot
// ground, which from the outside is indistinguishable from a button that did
// nothing, so the refusals are reported beside the result rather than buried in
// a flash message that is gone on the next reload.
interface PackProvenance {
  templateVersion?: string;
  staged?: string[];
  omitted?: Array<{ field: string; why: string }>;
  documents?: string[];
  sources?: Record<string, boolean>;
  reached?: Record<string, boolean>;
}

function buildReportBlock(prov: PackProvenance): Block {
  const omitted = prov.omitted ?? [];
  const documents = prov.documents ?? [];
  return {
    type: "kv",
    title: "What the last build produced",
    rows: [
      {
        label: "Fields filled",
        cell: text((prov.staged ?? []).map((f) => FIELD_LABELS.get(f) ?? f).join(", ") || "none"),
      },
      {
        label: "Fields omitted",
        cell: omitted.length
          ? {
              t: "text",
              v: omitted.map((o) => `${FIELD_LABELS.get(o.field) ?? o.field}: ${o.why}`).join("\n"),
              pre: true,
            }
          : text("none: every templated field was grounded"),
      },
      {
        label: "Documents attached",
        cell: text(documents.map((d) => d.replace(/_/g, " ")).join(", ") || "none on that pass"),
      },
    ],
  };
}

// The pack itself, at full length and with its paragraphs intact, because the
// question being asked of this page is "is this what I want a bank to read?"
// and a truncated cell cannot answer it.
function packBlocks(pkg: StagedPackage, disputeId: string, policySlots: Set<string>): Block[] {
  const blocks: Block[] = [];

  if (pkg.textFields.length === 0 && pkg.files.length === 0) {
    blocks.push({
      type: "empty",
      title: "Nothing is staged yet",
      hint: pkg.respondable
        ? "Build evidence assembles the pack from the templates and this account's real facts, then stages it at Stripe without sending anything. Nothing reaches the bank until you submit."
        : "No evidence was ever staged on this dispute.",
    });
    return blocks;
  }

  if (pkg.textFields.length > 0) {
    blocks.push({
      type: "kv",
      title: `Evidence text (${pkg.textFields.length})`,
      rows: pkg.textFields.map((f) => ({
        label: FIELD_LABELS.get(f.key) ?? f.key,
        cell: { t: "text", v: f.value, pre: true, sub: `${f.key} · ${f.value.length} characters` } as Cell,
      })),
    });
  }

  const files: TableBlock = {
    type: "table",
    key: "stagedfiles",
    title: `Files (${pkg.files.length})`,
    columns: [
      { key: "slot", label: "Slot" },
      { key: "source", label: "Source" },
      { key: "file", label: "File ID" },
    ],
    rows: pkg.files.map((f) => ({
      id: f.slot,
      cells: [
        text(sentence(f.slot.replace(/_/g, " "))),
        policySlots.has(f.slot)
          ? badgeCell("info", "Standing policy document")
          : text("Uploaded or built for this dispute"),
        idCell(f.fileId, { copy: true }),
      ] as Cell[],
      actions: [
        {
          key: "section:disputes.file_remove",
          label: "Remove",
          dangerous: true,
          params: { disputeId, slot: f.slot },
          summary:
            "Detaches this staged file from the dispute (the upload stays in your Stripe account). It will NOT reach the bank.",
          ...(pkg.respondable ? {} : { disabledReason: "Evidence can no longer be changed on this dispute." }),
        },
      ],
    })),
    empty: "No evidence files attached.",
  };
  blocks.push(files);
  return blocks;
}

export async function detail(ctx: DashboardCtx, deps: DisputesDeps, id: string): Promise<SectionPage> {
  let dispute: Stripe.Dispute | null = null;
  let missing = false;
  try {
    dispute = await ctx.stripe.getDispute(id);
  } catch (e) {
    if ((e as Stripe.errors.StripeError).code === "resource_missing") missing = true;
  }
  if (!dispute) {
    if (missing) return notFound("This dispute no longer exists at Stripe.");
    // Stripe unreachable: degrade to the mirror, read-only, instead of a 500.
    const row = await ctx.stores.dispute.get(id);
    if (!row) return notFound("Stripe is unreachable and this dispute is not in the local mirror.");
    return mirrorFallback(ctx, row);
  }

  // Keep the mirror fresh exactly like the Discord hub's detail renderer
  // (customerId backfilled from the charge when the mirror lacks it).
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? "");
  const before = await ctx.stores.dispute.get(id);
  const customerId =
    before?.customerId ?? (chargeId ? await ctx.stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
  const row = await ctx.stores.dispute.upsertFromStripe(dispute, customerId);
  const pkg = deps.evidence.packageFrom(dispute, row);

  const [watching, bookmarked, notes, events] = await Promise.all([
    ctx.stores.dispute.isWatching(id, ctx.actor.id),
    ctx.stores.qol.isBookmarked("dispute", id),
    ctx.stores.qol.listNotes("dispute", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
    deps.events ? deps.events.list(id) : Promise.resolve([]),
  ]);

  const ed = dispute.evidence_details;
  const draftFields = Object.keys(pkg.draft).length;
  const pastDue = !!ed?.past_due;
  const state = leadStateOf(pkg, pastDue);

  const lastPack = [...events].reverse().find((e) => e.kind === "pack_staged");
  const prov = (lastPack?.detail ?? undefined) as PackProvenance | undefined;
  const policySlots = new Set(prov?.documents ?? []);

  // ---- beat 1 and beat 3: the two buttons, adjacent, in loop order ----
  const actions: ActionButton[] = [];
  // The same Build Evidence the Discord hub offers, gated the same way (a
  // configured builder + a status that can still be answered). It stages with
  // submit:false, so it is not destructive in the sense the modal means and it
  // fires directly, exactly as the Discord button does.
  if (deps.evidencePack && pkg.respondable) {
    actions.push({
      key: "section:disputes.rebuild_pack",
      label: pkg.textFields.length ? "Rebuild evidence" : "Build evidence",
      style: "secondary",
      params: { disputeId: id },
    });
  }
  actions.push(submitButton(ctx, pkg, draftFields));
  // Only at the inquiry stage, and only while the pipeline is not switched off.
  // On a formal chargeback the engine can only ever answer "out of scope", so
  // offering the button there would be a button that exists to say no.
  if (deps.autoResolve && dispute.status === "warning_needs_response" && ctx.settings.disputeResolveMode() !== "none") {
    actions.push({
      key: "section:disputes.autoresolve_propose",
      label: "Propose auto-resolve",
      params: { disputeId: id },
    });
  }
  if (dispute.is_charge_refundable && chargeId) {
    actions.push(
      registryButton(ctx, {
        key: "charge.refund_full",
        label: "Refund to prevent",
        dangerous: true,
        params: { chargeId },
        summary:
          dispute.status === "warning_needs_response" || dispute.status === "warning_under_review"
            ? `Fully refund ${ctx.stripe.formatAmount(dispute.amount, dispute.currency)} now; at the warning stage this prevents the dispute from becoming a formal chargeback.`
            : `Fully refund the disputed charge (${ctx.stripe.formatAmount(dispute.amount, dispute.currency)}). Stripe still allows a refund on this dispute.`,
      })
    );
  }
  actions.push({
    key: "section:disputes.accept",
    label: "Accept as lost",
    style: "danger",
    dangerous: true,
    reverseConfirm: true,
    params: { disputeId: id },
    summary: `Accept ${id} (${ctx.stripe.formatAmount(dispute.amount, dispute.currency)}, ${dispute.reason}): the dispute closes as LOST immediately, the funds stay withdrawn and no evidence can be submitted afterwards. Irreversible. Needs the Discord reverse code (/billing → Show destructive-action code).`,
    ...(pkg.terminal ? { disabledReason: `Dispute is already ${dispute.status}.` } : {}),
  });
  actions.push({
    key: "section:disputes.watch",
    label: watching ? "Unwatch" : "Watch",
    params: { disputeId: id },
  });
  actions.push({
    key: "section:disputes.bookmark",
    label: bookmarked ? "Remove bookmark" : "Bookmark",
    params: { disputeId: id },
  });
  actions.push({
    key: "section:disputes.note_add",
    label: "Add note",
    params: { disputeId: id },
    inputs: [{ type: "text", key: "text", label: "Team note", multiline: true, maxLength: 1000 }],
  });

  const headBadges: Badge[] = [statusBadgeFor(dispute.status)];
  if (pkg.submissions > 0) headBadges.push({ kind: "info", text: `Submitted ${pkg.submissions}×` });
  if (pastDue) headBadges.push({ kind: "error", text: "Past due" });

  const main: Block[] = [];
  const rail: Block[] = [];

  main.push({
    type: "header",
    title: ctx.stripe.formatAmount(dispute.amount, dispute.currency),
    titleSuffix: dispute.currency.toUpperCase(),
    sub: sentence((dispute.reason || "unknown").replace(/_/g, " ")),
    badges: headBadges,
    meta: statusMeta(state, pkg, row, dispute.status),
    actions,
  });

  const notice = leadNotice(state, pkg, dispute.status);
  if (notice) main.push(notice);

  // ---- beat 2: the pack, as the bank will receive it ----
  if (prov) main.push(buildReportBlock(prov));
  main.push(...packBlocks(pkg, id, policySlots));

  // Editing stays one scroll away, not one click behind a toggle, but it is no
  // longer the first thing the page offers.
  main.push(evidenceBlockFrom(pkg));

  // What actually happened to this dispute, automated and human alike. The pack
  // above says what the evidence IS; this says how it got that way, which is
  // the question an operator asks when a package is already at a bank.
  if (events.length) {
    main.push({
      type: "timeline",
      title: `History (${events.length})`,
      collapsed: true,
      items: events.map((e) => ({
        label: e.actorName ?? (e.actorId ? `Admin ${e.actorId}` : "Automatic"),
        iso: e.at.toISOString(),
        text: e.summary,
        kind: eventTone(e.kind),
      })),
    });
  }

  // The corpus and the feeds behind the last package. Folded: it answers a
  // question nobody has until a package reads wrong months later.
  if (prov) {
    // Three states, not two. A source that answered and was not used was
    // refused on quality, which reads as a broken feed if it is reported the
    // same way as one that said nothing. Entries written before this existed
    // carry no `reached` map and keep the old two-state wording rather than
    // being relabelled with a guess.
    const sources = Object.entries(prov.sources ?? {})
      .map(([name, used]) => {
        const label = sentence(name.replace(/([A-Z])/g, " $1").toLowerCase());
        if (used) return `${label}: used`;
        if (!prov.reached) return `${label}: no data`;
        return `${label}: ${prov.reached[name] ? "answered, not enough to cite" : "no data"}`;
      })
      .join(" · ");
    main.push({
      type: "kv",
      title: "What the last package was built from",
      collapsed: true,
      rows: [
        { label: "Template corpus", cell: text(prov.templateVersion ?? "unknown") },
        { label: "Fields filled", cell: text((prov.staged ?? []).join(", ") || "none") },
        {
          label: "Fields omitted",
          cell: text(
            (prov.omitted ?? []).map((o) => `${o.field} (${o.why})`).join("; ") ||
              "none: every templated field was grounded"
          ),
        },
        { label: "Sources", cell: text(sources || "none") },
      ],
    });
  }

  // ---- rail: two cards, because four was a filing cabinet beside the work ----
  const card = dispute.payment_method_details?.card;
  const fees = (dispute.balance_transactions ?? []).reduce((sum, bt) => sum + (bt.fee ?? 0), 0);
  const refundableText = pkg.terminal
    ? "dispute closed"
    : dispute.is_charge_refundable
      ? "yes, refund prevents/settles this"
      : "no, respond with evidence";
  rail.push({
    type: "kv",
    title: "About this dispute",
    rows: [
      { label: "Dispute ID", cell: idCell(id, { copy: true }) },
      { label: "Reason", cell: text(sentence((dispute.reason || "unknown").replace(/_/g, " "))) },
      ...(card?.case_type ? [{ label: "Case type", cell: text(sentence(card.case_type)) }] : []),
      ...(card?.network_reason_code ? [{ label: "Network code", cell: text(card.network_reason_code) }] : []),
      ...(fees ? [{ label: "Dispute fee", cell: text(ctx.stripe.formatAmount(fees, dispute.currency)) }] : []),
      { label: "Opened", cell: isoDateCell(row.disputeCreatedAt) },
      { label: "Deadline", cell: row.evidenceDueBy ? isoDateCell(row.evidenceDueBy) : text("no response window") },
      { label: "Urgency", cell: dueCells(row) },
      ...(row.evidenceSubmittedAt ? [{ label: "Submitted", cell: isoDateCell(row.evidenceSubmittedAt) }] : []),
      ...(row.closedAt ? [{ label: "Closed", cell: isoDateCell(row.closedAt) }] : []),
      { label: "Draft fields", cell: draftFields ? badgeCell("info", `${draftFields} local`) : text("none") },
      { label: "Refundable", cell: text(refundableText) },
      {
        label: "Customer",
        cell: customerId
          ? idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } })
          : text("No customer on the charge (guest or deleted)."),
      },
      ...(chargeId
        ? [{ label: "Charge", cell: idCell(chargeId, { copy: true, ref: { page: "payments.detail", params: { id: chargeId } } }) }]
        : []),
      ...(row.paymentIntentId
        ? [{ label: "Payment intent", cell: idCell(row.paymentIntentId, { copy: true, ref: { page: "payments.detail", params: { id: row.paymentIntentId } } }) }]
        : []),
    ],
  });
  if (notes.rows.length > 0) {
    rail.push({
      type: "timeline",
      title: `Team notes (${notes.total})`,
      items: notes.rows.map((n) => ({
        label: n.authorName,
        iso: n.createdAt.toISOString(),
        text: n.text,
        kind: "info" as const,
      })),
    });
  }

  return {
    title: ctx.stripe.formatAmount(dispute.amount, dispute.currency),
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: id, copyId: id }],
    blocks: main,
    rail,
  };
}

// The submit ceremony button: a fresh factor, with the staged summary baked
// into the modal text (single-submission warning).
export function submitButton(ctx: DashboardCtx, pkg: StagedPackage, draftFields: number): ActionButton {
  const d = pkg.dispute;
  const dueTs = d.evidence_details?.due_by || null;
  const summary = [
    `Submit the staged evidence for ${d.id} (${ctx.stripe.formatAmount(d.amount, d.currency)}, ${d.reason}) to the bank.`,
    `Staged right now: ${pkg.textFields.length} text field(s) + ${pkg.files.length} file(s).`,
    pkg.unstagedDraft.length
      ? `⚠ ${pkg.unstagedDraft.length} local draft field(s) are NOT staged and will not be sent.`
      : null,
    dueTs ? `Deadline: ${new Date(dueTs * 1000).toISOString().slice(0, 10)}.` : null,
    pkg.submissions > 0
      ? `⚠ Evidence was already submitted ${pkg.submissions}×: banks typically accept only ONE submission; resubmit only if Stripe support advised it.`
      : "Banks typically allow exactly one submission; make sure the staged evidence is complete.",
    "This cannot be recalled, so it asks you to re-assert your passkey first.",
  ]
    .filter(Boolean)
    .join(" ");
  const disabled = !pkg.respondable
    ? `Status is ${d.status}; evidence can no longer be submitted.`
    : !(pkg.hasEvidence || draftFields > 0)
      ? "Nothing staged at Stripe yet; stage evidence first."
      : undefined;
  return {
    key: "section:disputes.submit",
    label: "Submit evidence",
    style: "primary",
    // A fresh-factor re-assert rather than the Discord reverse code plus a
    // typed CONFIRM.
    //
    // This is the one irreversible action on the dispute path that is also
    // ROUTINE: it happens on every dispute we answer, and a ceremony that has
    // to be performed constantly stops being read. The factor is not weaker
    // for being quicker. A passkey is hardware-bound and phishing-resistant
    // and proves someone is physically present at this browser, where the
    // reverse code is a shared secret read off a Discord channel and typed in.
    //
    // The genuinely destructive neighbours, Accept as lost and the refund
    // actions, keep the full ceremony: those are rare, and rarity is what
    // makes a heavy ceremony something an operator still notices.
    stepUp: true,
    params: { disputeId: d.id },
    summary,
    ...(disabled ? { disabledReason: disabled } : {}),
  };
}

// Build the interactive evidence widget from the staged package + catalog.
function evidenceBlockFrom(pkg: StagedPackage): EvidenceBlock {
  const recommended = recommendedGroupKeys(pkg.dispute.reason);
  const ordered = [...EVIDENCE_GROUPS].sort((a, b) => {
    const ai = recommended.indexOf(a.key);
    const bi = recommended.indexOf(b.key);
    return (ai === -1 ? recommended.length : ai) - (bi === -1 ? recommended.length : bi);
  });
  const groups = ordered.map((g) => ({
    key: g.key,
    label: g.label,
    ...(recommended.includes(g.key) ? { recommended: true } : {}),
    fields: g.fields.map((f) => {
      const staged = typeof pkg.staged[f.key] === "string" ? (pkg.staged[f.key] as string).trim() : "";
      const draft = pkg.draft[f.key]?.trim() ?? "";
      const state: "empty" | "draft" | "staged" | "submitted" =
        draft && draft !== staged ? "draft" : staged ? (pkg.submissions > 0 ? "submitted" : "staged") : "empty";
      return {
        key: f.key,
        label: f.label,
        multiline: f.multiline,
        state,
        ...(draft ? { draft } : {}),
        ...(staged ? { staged } : {}),
      };
    }),
  }));
  // The six upload slots, plus any file staged into a non-slot key elsewhere
  // (webhook receipt auto-attach, Stripe Dashboard uploads) so nothing hides.
  const files: EvidenceBlock["files"] = EVIDENCE_FILE_SLOTS.map((s) => ({
    key: s.key,
    label: s.label,
    ...(typeof pkg.staged[s.key] === "string" && pkg.staged[s.key] ? { fileId: String(pkg.staged[s.key]) } : {}),
  }));
  for (const f of pkg.files) {
    if (!EVIDENCE_FILE_SLOTS.some((s) => s.key === f.slot)) {
      files.push({ key: f.slot, label: sentence(f.slot.replace(/_/g, " ")), fileId: f.fileId });
    }
  }
  return {
    type: "evidence",
    disputeId: pkg.dispute.id,
    editable: pkg.respondable,
    submitted: pkg.submissions > 0,
    groups,
    files,
    maxFileBytes: PROOF_MAX_BYTES,
    fileTypes: [...PROOF_TYPES],
  };
}

// Degraded detail when Stripe is unreachable: mirror data, zero actions.
function mirrorFallback(ctx: DashboardCtx, d: StripeDispute): SectionPage {
  return {
    title: ctx.stripe.formatAmount(d.amount, d.currency),
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: d.id, copyId: d.id }],
    blocks: [
      {
        type: "header",
        title: ctx.stripe.formatAmount(d.amount, d.currency),
        titleSuffix: d.currency.toUpperCase(),
        sub: sentence(d.reason.replace(/_/g, " ")),
        badges: [statusBadgeFor(d.status)],
      },
      {
        type: "notice",
        badge: { kind: "warn", text: "Live fetch failed" },
        text: "Stripe is unreachable right now; showing the local mirror, read-only. Reload to retry.",
      },
      {
        type: "kv",
        title: "Mirror",
        rows: [
          { label: "Status", cell: badgeCell(statusBadgeFor(d.status).kind, statusBadgeFor(d.status).text) },
          { label: "Deadline", cell: d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("N/A") },
          { label: "Charge", cell: idCell(d.chargeId, { copy: true, ref: { page: "payments.detail", params: { id: d.chargeId } } }) },
        ],
      },
    ],
  };
}
