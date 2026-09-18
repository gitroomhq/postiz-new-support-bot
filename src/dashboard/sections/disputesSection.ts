import type Stripe from "stripe";
import type { StripeDispute } from "../../generated/prisma/client";
import { CachedRatioEngine, RatioWindowNumbers } from "../../bot/billing/disputeRatio";
import { RESPONDABLE_DISPUTE_STATUSES } from "../../bot/billing/DisputeStore";
import {
  DisputeEvidenceService,
  EVIDENCE_FILE_SLOTS,
  EVIDENCE_GROUPS,
  EVIDENCE_KEY_SET,
  PROOF_MAX_BYTES,
  PROOF_TYPES,
  recommendedGroupKeys,
  type StagedPackage,
} from "../../bot/billing/DisputeEvidenceService";
import type { EvidencePackBuilder } from "../../bot/billing/evidence/EvidencePackBuilder";
import type { AutoResolveStore } from "../../bot/billing/AutoResolveStore";
import {
  STANDING_DOCUMENT_SLOTS,
  isStandingSlot,
  type EvidenceDocumentStore,
} from "../../bot/billing/evidence/EvidenceDocumentStore";
import type { BackfillResult, HandProposeResult } from "../../bot/billing/AutoResolveService";
import type { TemplateStore } from "../../bot/billing/evidence/TemplateStore";
import type { DisputeEventStore } from "../../bot/billing/DisputeEventStore";
import { NO_INTERNAL_ARTIFACT, templateTokens, tokensIn } from "../../bot/billing/evidence/renderTemplate";
import { TOKEN_NAMES } from "../../bot/billing/evidence/tokens";
import {
  PACK_FIELDS_BY_REASON,
  PACK_REASONS,
  TEMPLATE_LIBRARY,
  TEMPLATE_VERSION,
  templateFor,
  type PackReason,
} from "../../bot/billing/evidence/templates";
import { exportBillingEvent } from "../../metrics/MetricsExporter";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, EvidenceBlock, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validId } from "./types";
import { amount, badgeCell, idCell, isoDateCell, sentence, strong, text } from "./cells";

// Disputes: the overview (ratio strip, due-date board, All list,
// History & stats); the detail page is the evidence WORKBENCH —
// the interactive editor widget (draft autosave / stage / proof files), the
// staged-evidence review subpage and every action: submit (typed CONFIRM +
// Discord reverse code), accept-as-lost (same ceremony), refund-to-prevent
// (registry, via the gateway), watch, notes and bookmarks. All evidence
// mutations run through the shared DisputeEvidenceService — the exact code
// behind /billing → Disputes — so both surfaces stay in lockstep.

const PAGE_SIZE = 25;
// The template editor lists one row per evidence field, so it paginates at a
// size a reviewer can actually read rather than the 25-row list default.
const TEMPLATE_PAGE_SIZE = 10;
const BOARD_WINDOW = 50;

const DUE_URGENT_HOURS = 24;
const DUE_WARN_HOURS = 72;

interface DisputesDeps {
  ratio: CachedRatioEngine;
  evidence: DisputeEvidenceService;
  // Deterministic evidence packs. Optional so the section still renders on an
  // instance where the builder is not wired.
  evidencePack?: EvidencePackBuilder | null;
  // The standing policy documents, uploaded once and reused on every dispute.
  evidenceDocuments?: EvidenceDocumentStore | null;
  // Auto-resolve queue, so the money-moving automation is visible and stoppable.
  autoResolveStore?: AutoResolveStore | null;
  // The engine itself: accepting a proposal before its window expires, and
  // making one by hand (single dispute, or a sweep of the open inquiries).
  autoResolve?: {
    executeNow(rowId: string): Promise<{ executed: number; blocked: number; failed: number; superseded: number }>;
    proposeByHand(disputeId: string): Promise<HandProposeResult>;
    backfillOpenInquiries(): Promise<BackfillResult>;
  } | null;
  // Operator overrides for the shipped evidence corpus.
  templateStore?: TemplateStore | null;
  // Per-dispute history, for the detail page's timeline.
  events?: DisputeEventStore | null;
}


export function makeDisputesSection(deps: DisputesDeps): DashboardSectionModule {
  return {
    nav: [{ key: "disputes", label: "Disputes", page: "disputes" }],

    ownsPage(page: string): boolean {
      return (
        page === "disputes" ||
        page === "disputes.detail" ||
        page === "disputes.review" ||
        page === "disputes.templates" ||
        page === "disputes.documents"
      );
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "disputes") return list(ctx, deps, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "disputes.templates") return templatesPage(ctx, deps, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "disputes.documents") return documentsPage(ctx, deps);
      const id = validId("dispute", req.params?.id);
      if (!id) return notFound("That dispute id is not valid (dp_/du_…).");
      if (req.page === "disputes.review") return review(ctx, deps, id);
      return detail(ctx, deps, id);
    },

    async action(ctx: DashboardCtx, req) {
      return disputeAction(ctx, deps, req.key, req.params ?? {}, req.confirmWord);
    },

    async navBadge(ctx: DashboardCtx): Promise<string | null> {
      const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
      const needing = counts
        .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
        .reduce((sum, c) => sum + c.count, 0);
      return needing > 0 ? String(needing) : null;
    },
  };
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button: queue notice or disabled state.
// Execution re-checks server-side regardless.
function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") {
    return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  }
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

// ---- section actions (the workbench verbs) ----

async function disputeAction(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  key: string,
  p: Record<string, unknown>,
  confirmWord: string | undefined
): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  needsReverse?: boolean;
  needsStepUp?: boolean;
}> {
  const confirmed = confirmWord === "CONFIRM";

  // Template edits are keyed on (reason, field), not on a dispute, so they also
  // run before the dispute-id guard.
  if (key === "section:disputes.template_save" || key === "section:disputes.template_reset") {
    const store = deps.templateStore;
    if (!store) return { ok: false, error: "The template store is not configured." };
    const reason = str(p.reason, 40);
    const field = str(p.field, 64);
    if (!(PACK_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "Unknown dispute reason." };
    if (!EVIDENCE_KEY_SET.has(field)) return { ok: false, error: "Unknown evidence field." };

    if (key === "section:disputes.template_reset") {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to restore the shipped text." };
      const removed = await store.reset(reason, field);
      await ctx.audit(`Dispute template override reset: ${reason}/${field}`);
      return { ok: true, text: removed ? "Override removed; the shipped text is back in use." : "There was no override." };
    }

    const body = str(p.body, 3600).trim();
    if (body.length < 20) return { ok: false, fieldErrors: { body: "Too short to be evidence." } };
    if (body.length > 3500) return { ok: false, fieldErrors: { body: "Longer than Stripe accepts for one field." } };
    // An unknown token would render as a literal {{...}} at the bank, which is
    // the single worst thing this editor could allow.
    const unknown = tokensIn(body).filter((t) => !TOKEN_NAMES.includes(t));
    if (unknown.length) {
      return {
        ok: false,
        fieldErrors: { body: `Unknown token(s): ${unknown.map((t) => `{{${t}}}`).join(", ")}. Available: ${TOKEN_NAMES.join(", ")}` },
      };
    }
    if (NO_INTERNAL_ARTIFACT.test(body)) {
      return { ok: false, fieldErrors: { body: "That mentions an internal file or repository. The reader is a bank analyst." } };
    }
    const hadDash = body.includes("\u2014");
    await store.save(reason, field, body.replace(/\u2014/g, ", "), ctx.actor.id, ctx.actor.name);
    await ctx.audit(`Dispute template override saved: ${reason}/${field} (${body.length} chars)`);
    // A shipped `requires` gate is not the operator's to remove, so a reworded
    // field that drops its grounding token is flagged rather than silently
    // allowed to assert something we cannot prove.
    const shipped = templateFor(reason as PackReason, field);
    const lostGate = (shipped?.requires ?? []).filter((t) => !tokensIn(body).includes(t));
    return {
      ok: true,
      text:
        `Saved.${hadDash ? " Em-dashes were replaced with commas." : ""}` +
        (lostGate.length ? ` Note: the shipped version referenced ${lostGate.join(", ")}; the gate on that claim still applies.` : ""),
    };
  }

  // Handled BEFORE the dispute-id guard: an auto-resolve row is keyed on its
  // own id, and a fraud-warning row has no dispute at all.
  //
  // No typed confirmation on purpose: the ceremony exists to slow down actions
  // that spend money, and this one stops a spend.
  if (key === "section:disputes.autoresolve_execute") {
    const service = deps.autoResolve;
    if (!service) return { ok: false, error: "Auto-resolve is not configured." };
    if (!confirmed) return { ok: false, error: "Type CONFIRM to refund this charge now." };
    const rowId = str(p.id, 40);
    if (!/^c[a-z0-9]{20,32}$/.test(rowId)) return { ok: false, error: "That auto-resolve id is not valid." };
    // executeNow re-runs every live guardrail before it moves anything, so a
    // proposal that went stale during the window still blocks rather than
    // firing because a human clicked.
    const result = await service.executeNow(rowId);
    await ctx.audit(`Auto-resolve executed by hand: ${rowId}`);
    if (result.executed) return { ok: true, text: "Refunded. The dispute should close as prevented." };
    if (result.blocked) return { ok: false, error: "A guardrail refused it on re-check; open the row to see which." };
    if (result.superseded) return { ok: false, error: "Someone already refunded this charge." };
    if (result.failed) return { ok: false, error: "Stripe refused the refund; the alert carries the error." };
    return { ok: false, error: "Nothing to execute: it is no longer pending." };
  }

  // A sweep of every open inquiry that has no verdict yet. Lives here with the
  // other row-keyed actions because it is keyed on nothing: it is the cutover
  // tool for the moment the engine is switched on and the backlog predates it.
  if (key === "section:disputes.autoresolve_backfill") {
    const service = deps.autoResolve;
    if (!service) return { ok: false, error: "Auto-resolve is not configured." };
    const r = await service.backfillOpenInquiries();
    if (!r.scanned) return { ok: true, text: "No open inquiries to evaluate." };
    await ctx.audit(`Auto-resolve backfill: ${r.scanned} inquiry(s) evaluated, ${r.proposed} proposed`);
    const why = Object.entries(r.guardrails)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `${g.replace(/_/g, " ")} ${n}`)
      .join(", ");
    const parts = [`Evaluated ${r.scanned}: proposed ${r.proposed}, declined ${r.blocked}, already decided ${r.duplicate}.`];
    if (why) parts.push(`Declined for: ${why}.`);
    if (r.unalerted) parts.push(`${r.unalerted} could not be alerted in Discord and cannot fire until they are.`);
    if (r.unavailable) parts.push(`${r.unavailable} could not be read from Stripe.`);
    if (r.remaining) parts.push(`${r.remaining} more are waiting; press again to continue.`);
    return { ok: true, text: parts.join(" ") };
  }

  // The standing policy documents. Keyed on a slot, not a dispute, so they are
  // handled before the dispute-id guard.
  if (key === "section:disputes.document_put") {
    const store = deps.evidenceDocuments;
    if (!store) return { ok: false, error: "The document store is not configured." };
    if (!deps.evidencePack) return { ok: false, error: "The evidence pack builder is not configured." };
    const slot = str(p.slot, 40);
    if (!isStandingSlot(slot)) return { ok: false, error: "That is not a policy document slot." };
    const fileName = str(p.docName, 200).replace(/[/\\]/g, "_") || "policy";
    const contentType = str(p.docType, 60).toLowerCase();
    if (!DOCUMENT_TYPES.includes(contentType)) return { ok: false, error: "The bank accepts PDF, PNG or JPEG only." };
    const dataB64 = typeof p.docB64 === "string" ? p.docB64 : "";
    // ~5.6MB of base64 covers the 4MB cap; anything beyond that is hostile.
    if (!dataB64 || dataB64.length > 6_000_000) return { ok: false, error: "Bad or oversized file payload." };
    let data: Buffer;
    try {
      data = Buffer.from(dataB64, "base64");
    } catch {
      return { ok: false, error: "Bad file payload." };
    }
    if (!data.length || data.length > DOCUMENT_MAX_BYTES) return { ok: false, error: "Bad or oversized file payload." };

    const file = await ctx.stripe.uploadDisputeEvidenceFile(fileName, data, contentType);
    await store.put({
      slot,
      stripeFileId: file.id,
      fileName,
      sizeBytes: data.length,
      contentType,
      uploadedById: ctx.actor.id,
      uploadedByName: ctx.actor.name,
    });
    await ctx.audit(`Standing evidence document set for ${slot}: ${fileName} (${file.id})`);
    return {
      ok: true,
      text: `${fileName} will be attached as ${slot} on every dispute whose slot is empty, from the next pack build. Nothing reaches a bank until evidence is submitted.`,
    };
  }

  if (key === "section:disputes.document_remove") {
    const store = deps.evidenceDocuments;
    if (!store) return { ok: false, error: "The document store is not configured." };
    if (!confirmed) return { ok: false, error: "Type CONFIRM to stop attaching this document." };
    const slot = str(p.slot, 40);
    if (!isStandingSlot(slot)) return { ok: false, error: "That is not a policy document slot." };
    const removed = await store.remove(slot);
    if (!removed) return { ok: false, error: "There was no document in that slot." };
    await ctx.audit(`Standing evidence document cleared for ${slot}`);
    return { ok: true, text: `Future disputes will not receive a ${slot.replace(/_/g, " ")}. Nothing already staged changed.` };
  }

  if (key === "section:disputes.autoresolve_veto") {
    const store = deps.autoResolveStore;
    if (!store) return { ok: false, error: "Auto-resolve is not configured." };
    const rowId = str(p.id, 40);
    if (!/^c[a-z0-9]{20,32}$/.test(rowId)) return { ok: false, error: "That auto-resolve id is not valid." };
    const outcome = await store.veto(rowId, ctx.actor.id, ctx.actor.name);
    if (outcome.kind === "vetoed") {
      await ctx.audit(`Auto-resolve cancelled: ${rowId}`);
      return { ok: true, text: "Cancelled. No refund will be made for this one." };
    }
    if (outcome.kind === "already_vetoed") {
      return { ok: false, error: `Already cancelled${outcome.byName ? ` by ${outcome.byName}` : ""}.` };
    }
    if (outcome.kind === "too_late") {
      return { ok: false, error: `Too late: this is already ${outcome.state.toLowerCase()} and the refund is in flight.` };
    }
    return { ok: false, error: "That auto-resolve no longer exists." };
  }

  const disputeId = validId("dispute", p.disputeId);
  if (!disputeId) return { ok: false, error: "Bad dispute id." };

  switch (key) {
    // T0 — autosave one field into the LOCAL draft (empty never wipes).
    case "section:disputes.draft_save": {
      const fieldKey = str(p.key, 64);
      const value = str(p.value, 4000);
      if (!EVIDENCE_KEY_SET.has(fieldKey)) return { ok: false, error: "Unknown evidence field." };
      const { saved, rejected } = await deps.evidence.saveDraft(disputeId, { [fieldKey]: value });
      if (rejected.length) {
        return { ok: false, error: `That value cannot be what ${rejected[0]} means, so it was not saved.` };
      }
      if (!saved) return { ok: false, error: "Nothing to save: the field was empty." };
      // A human has typed into this dispute, so auto-submit stands down.
      await ctx.stores.dispute.markEvidenceTouched(disputeId, ctx.actor.id, ctx.actor.name);
      return { ok: true, text: "Draft saved." };
    }

    // T1 — stage one group's saved draft fields at Stripe (submit:false).
    case "section:disputes.stage_group": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const groupKey = str(p.group, 20);
      const group = EVIDENCE_GROUPS.find((g) => g.key === groupKey);
      if (!group) return { ok: false, error: "Unknown evidence group." };
      const live = await ctx.stripe.getDispute(disputeId);
      if (!deps.evidence.respondable(live.status)) {
        return { ok: false, error: `Status is ${live.status}; evidence can no longer be changed.` };
      }
      const row = await ctx.stores.dispute.get(disputeId);
      const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
      const evidence: Record<string, string> = {};
      for (const field of group.fields) {
        const value = draft[field.key]?.trim();
        if (value) evidence[field.key] = value;
      }
      if (Object.keys(evidence).length === 0) {
        return { ok: false, error: "Nothing drafted in this group yet; fill fields first (they autosave)." };
      }
      await deps.evidence.stageFields(disputeId, evidence, `dash-${Date.now().toString(36)}`);
      await ctx.audit(`Dispute evidence staged on ${disputeId}: ${Object.keys(evidence).length} field(s) from ${group.label} (NOT submitted)`);
      return { ok: true, text: `Staged ${Object.keys(evidence).length} field(s) at Stripe (not submitted).` };
    }

    // T1 — upload a proof (base64 JSON body) and stage it into a slot.
    case "section:disputes.file_upload": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const slot = str(p.slot, 40);
      const filename = str(p.filename, 200).replace(/[/\\]/g, "_") || "proof";
      const contentType = str(p.contentType, 60);
      const dataB64 = typeof p.dataB64 === "string" ? p.dataB64 : "";
      // ~5.6MB of base64 covers the 4MB proof cap; anything bigger is hostile.
      if (!dataB64 || dataB64.length > 6_000_000) return { ok: false, error: "Bad or oversized file payload." };
      let data: Buffer;
      try {
        data = Buffer.from(dataB64, "base64");
      } catch {
        return { ok: false, error: "Bad file payload." };
      }
      const outcome = await deps.evidence.uploadProof(disputeId, slot, filename, data, contentType, `dash-${Date.now().toString(36)}`);
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status}; evidence files can no longer be attached.` };
      }
      if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
      await ctx.audit(`Dispute evidence file staged on ${disputeId}: ${outcome.file!.id} (${filename}) as ${slot} (NOT submitted)`);
      return { ok: true, text: `${filename} staged as ${slot}; it reaches the bank when you submit evidence.` };
    }

    // T1 — detach a staged file (stays in the Stripe account).
    case "section:disputes.file_remove": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const slot = str(p.slot, 40);
      const outcome = await deps.evidence.removeFile(disputeId, slot, `dash-${Date.now().toString(36)}`);
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status}; evidence can no longer be changed.` };
      }
      if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
      await ctx.audit(`Dispute evidence file removed on ${disputeId}: cleared slot ${slot} (staged only)`);
      return { ok: true, text: `File slot ${slot} cleared.` };
    }

    // T2: submit the staged evidence to the bank. Irreversible, and the
    // cross-surface claim in the service keeps it single-shot.
    case "section:disputes.submit": {
      // Enforced HERE as well as in the modal, because the client is hostile:
      // a button that merely declares stepUp proves nothing about what the
      // browser actually sent.
      if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
      const outcome = await deps.evidence.submit(disputeId, ctx.actor.id, await customerHint(ctx, disputeId));
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status}; evidence can no longer be submitted.` };
      }
      if (outcome.kind === "already_claimed") {
        return { ok: false, error: "Evidence for this dispute was already submitted via the bot." };
      }
      const d = outcome.dispute;
      await ctx.audit(`Dispute evidence SUBMITTED on ${disputeId} (${ctx.stripe.formatAmount(d.amount, d.currency)}); status now ${d.status}`);
      exportBillingEvent({
        event: "evidence_submitted",
        amountMinor: d.amount,
        currency: d.currency,
        chargeId: typeof d.charge === "string" ? d.charge : d.charge?.id,
      });
      return { ok: true, text: "Evidence submitted to the bank." };
    }

    // T1 + T3 — accept the dispute (closes as LOST, irreversible).
    case "section:disputes.accept": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
      const live = await ctx.stripe.getDispute(disputeId);
      if (deps.evidence.terminal(live.status)) {
        return { ok: false, error: `Dispute is already ${live.status}.` };
      }
      const outcome = await deps.evidence.accept(disputeId, ctx.actor.id, await customerHint(ctx, disputeId));
      if (outcome.kind === "already_claimed") {
        return { ok: false, error: "This dispute was already accepted via the bot." };
      }
      const d = outcome.dispute;
      await ctx.audit(`Dispute ACCEPTED on ${disputeId} (${ctx.stripe.formatAmount(d.amount, d.currency)}); closed as ${d.status} (conceded)`);
      exportBillingEvent({
        event: "dispute_accepted",
        amountMinor: d.amount,
        currency: d.currency,
        chargeId: typeof d.charge === "string" ? d.charge : d.charge?.id,
      });
      return { ok: true, text: "Dispute accepted; closed as lost." };
    }

    // T0 — rebuild the templated evidence pack and re-stage it. Deterministic:
    // template text interpolated with real Stripe, platform and support facts,
    // with no model involved. Staging uses submit:false, so Submit stays a
    // separate, human action.
    case "section:disputes.rebuild_pack": {
      const live = await ctx.stripe.getDispute(disputeId);
      if (!deps.evidence.respondable(live.status)) {
        return { ok: false, error: `Status is ${live.status}; there is nothing left to answer.` };
      }
      if (!deps.evidencePack) return { ok: false, error: "The evidence pack builder is not configured." };
      const chargeId = typeof live.charge === "string" ? live.charge : live.charge?.id;
      if (!chargeId) return { ok: false, error: "This dispute has no charge to build a package from." };
      const charge = await ctx.stripe.getCharge(chargeId);
      // The panel always enriches: a human waiting on a page can afford the
      // Intercom round trips that the Stripe webhook cannot.
      const pack = await deps.evidencePack.build(live, charge, { enrich: true });
      const staged = await deps.evidencePack.stage(live, pack, false);
      await ctx.audit(
        `Dispute evidence pack rebuilt on ${disputeId}: ${staged.staged.length} field(s), score ${staged.pack.score}%`
      );
      const omitted = staged.omitted.length
        ? ` Omitted ${staged.omitted.length}: ${staged.omitted.map((o: { field: string; why: string }) => `${o.field} (${o.why})`).join(", ")}.`
        : "";
      // The templates are deterministic, so an untouched dispute rebuilds to
      // the same text. Saying so beats reporting a write that did not happen.
      // Only the reasons a human can act on. "Slot already filled" is the
      // system protecting their own upload, not a problem to report.
      const missing = staged.documentsSkipped
        .filter((skip: { why: string }) => skip.why !== "slot already filled")
        .map((skip: { slot: string; why: string }) => `${skip.slot.replace(/_/g, " ")} (${skip.why})`);
      const notMade = missing.length ? ` No ${missing.join(", no ")}.` : "";
      if (staged.unchanged) {
        return {
          ok: true,
          text: `No change: the staged package already matches what the templates and the current facts produce (${staged.staged.length} field(s), completeness ${staged.pack.score}%).${notMade}${omitted}`,
        };
      }
      const docs = staged.documents.length
        ? ` Attached ${staged.documents.length} document(s): ${staged.documents.map((d: string) => d.replace(/_/g, " ")).join(", ")}.`
        : "";
      return {
        ok: true,
        text: `Staged ${staged.staged.length} field(s), completeness ${staged.pack.score}%.${docs}${notMade}${omitted} Review the sections below, then submit.`,
      };
    }

    // T0: ask the auto-resolve engine about THIS dispute, instead of waiting
    // for a webhook that already came and went. A decision that refuses is
    // reported and not recorded: the operator is standing right here being told
    // why, so a Declined row would add nothing and could never be told apart
    // from a verdict the engine reached on its own.
    case "section:disputes.autoresolve_propose": {
      const service = deps.autoResolve;
      if (!service) return { ok: false, error: "Auto-resolve is not configured." };
      const r = await service.proposeByHand(disputeId);
      switch (r.kind) {
        case "proposed": {
          await ctx.audit(`Auto-resolve proposed by hand on ${disputeId}: ${r.rowId}`);
          const money = ctx.stripe.formatAmount(r.amountMinor, r.currency);
          // An unalerted proposal is inert by design, so say so plainly rather
          // than reporting a success the operator cannot act on.
          return r.alerted
            ? {
                ok: true,
                text: `Proposed: refund ${money}. It is alerted in the billing channel, where it waits for Execute now unless the phase is set to auto.`,
              }
            : {
                ok: true,
                text: `Proposed: refund ${money}. The billing channel could not be reached, and a proposal with no alert never fires, so fix the channel in /config and it will be alerted on the next pass.`,
              };
        }
        case "blocked":
          return { ok: false, error: `A guardrail refuses this one: ${r.guardrail.replace(/_/g, " ")}. Nothing was recorded.` };
        case "duplicate":
          return { ok: false, error: `This dispute already has an auto-resolve row (${r.state.toLowerCase()}); see the Auto-resolve tab.` };
        case "out_of_scope":
          return { ok: false, error: `Refunding cannot prevent a dispute at status ${r.status}; only an inquiry can be prevented.` };
        case "off":
          return { ok: false, error: "The resolve phase is off. Raise it in /config to at least Manual." };
        default:
          return { ok: false, error: "Stripe could not be read just now; try again." };
      }
    }

    // T0 — DM-on-status-change subscription (actor ids ARE Discord ids).
    case "section:disputes.watch": {
      const watching = await ctx.stores.dispute.isWatching(disputeId, ctx.actor.id);
      if (watching) await ctx.stores.dispute.unwatch(disputeId, ctx.actor.id);
      else await ctx.stores.dispute.watch(disputeId, ctx.actor.id);
      return { ok: true, text: watching ? "Unwatched: no more DMs for this dispute." : "Watching: you'll get a DM when its status changes." };
    }

    case "section:disputes.note_add": {
      const body = str(p.text, 1000);
      if (!body) return { ok: false, fieldErrors: { text: "Write something first." } };
      await ctx.stores.qol.addNote("dispute", disputeId, ctx.actor.id, ctx.actor.name, body);
      await ctx.audit(`Note added on ${disputeId}`);
      return { ok: true, text: "Note added." };
    }

    case "section:disputes.bookmark": {
      const row = await ctx.stores.dispute.get(disputeId);
      const label = row ? `${ctx.stripe.formatAmount(row.amount, row.currency)} · ${row.reason}` : null;
      const r = await ctx.stores.qol.toggleBookmark("dispute", disputeId, label, ctx.actor.id, ctx.actor.name);
      return { ok: true, text: r.bookmarked ? "Bookmarked for the team." : "Bookmark removed." };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

// customerId for the mirror upsert after submit/accept — mirror first, charge
// lookup as fallback (same derivation the hub session carries around).
async function customerHint(ctx: DashboardCtx, disputeId: string): Promise<string | null> {
  const row = await ctx.stores.dispute.get(disputeId).catch(() => null);
  return row?.customerId ?? null;
}

// ---- LIST (tabs: Needs response / All / History & stats) ----

async function list(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const view =
    filters.view === "all" || filters.view === "history" || filters.view === "autoresolve" ? filters.view : "";
  const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
  const needingCount = counts
    .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + c.count, 0);

  const blocks: Block[] = [];
  blocks.push({
    type: "header",
    title: "Disputes",
    sub: "Evidence is written from templates and real account facts, with no model involved.",
    actions: [
      // Only on the tab it acts on: elsewhere it would be an unexplained sweep
      // button over a page that shows none of what it touches.
      ...(view === "autoresolve" && deps.autoResolve && ctx.settings.disputeResolveMode() !== "none"
        ? ([
            {
              key: "section:disputes.autoresolve_backfill",
              label: "Evaluate open inquiries",
              style: "primary",
            },
          ] as ActionButton[])
        : []),
      { key: "nav.documents", label: "Policy documents", style: "secondary", ref: { page: "disputes.documents" } },
      { key: "nav.templates", label: "Evidence templates", style: "secondary", ref: { page: "disputes.templates" } },
    ],
  });
  blocks.push({
    type: "tabs",
    key: "view",
    value: view || undefined,
    items: [
      { value: "", label: "Needs response", ...(needingCount ? { badge: String(needingCount) } : {}) },
      { value: "all", label: "All disputes" },
      { value: "autoresolve", label: "Auto-resolve" },
      { value: "history", label: "History & stats" },
    ],
  });

  // Ratio strip — plain + VAMP over the three windows, level-tinted.
  blocks.push(await ratioStrip(ctx, deps.ratio));

  if (view === "history") blocks.push(...(await historyBlocks(ctx, cursor)));
  else if (view === "autoresolve") blocks.push(...(await autoResolveBlocks(ctx, deps, filters, cursor)));
  else if (view === "all") blocks.push(...(await allBlocks(ctx, filters, cursor, counts)));
  else blocks.push(await boardBlock(ctx));

  return { title: "Disputes", crumbs: [{ label: "Disputes" }], blocks };
}

async function ratioStrip(ctx: DashboardCtx, ratio: CachedRatioEngine): Promise<Block> {
  const warnPct = ctx.settings.disputeRatioWarnPct();
  const criticalPct = ctx.settings.disputeRatioCriticalPct();
  const level = (pct: number | null): Badge | undefined => {
    if (pct == null) return undefined;
    if (pct >= criticalPct) return { kind: "error", text: "critical" };
    if (pct >= warnPct) return { kind: "warn", text: "warn" };
    return { kind: "ok", text: "ok" };
  };
  const fmt = (pct: number | null): string => (pct == null ? "N/A" : `${pct.toFixed(2)}%`);
  try {
    const r = await ratio.get();
    const ge = r.truncated ? "≥" : "";
    const win = (label: string, w: RatioWindowNumbers) => ({
      label,
      value: fmt(w.plainPct),
      sub: `VAMP ${fmt(w.vampPct)} · ${ge}${w.chargebacks}/${w.succeeded} charges`,
      badge: level(w.plainPct),
    });
    return {
      type: "stats",
      items: [win("This month", r.month), win("Last 30 days", r.d30), win("Last 90 days", r.d90)],
    };
  } catch {
    return {
      type: "stats",
      items: [{ label: "Dispute ratio", value: "N/A", sub: "ratio engine unavailable right now" }],
    };
  }
}

function dueCells(d: { evidenceDueBy: Date | null }): Cell {
  if (!d.evidenceDueBy) return text("N/A");
  const hoursLeft = (d.evidenceDueBy.getTime() - Date.now()) / 3_600_000;
  const badge: Badge =
    hoursLeft < 0
      ? { kind: "error", text: "OVERDUE" }
      : hoursLeft <= DUE_URGENT_HOURS
        ? { kind: "error", text: `${Math.max(1, Math.round(hoursLeft))}h left` }
        : hoursLeft <= DUE_WARN_HOURS
          ? { kind: "warn", text: `${Math.round(hoursLeft / 24)}d left` }
          : { kind: "neutral", text: `${Math.round(hoursLeft / 24)}d left` };
  return { t: "flags", badges: [badge] };
}

function statusBadgeFor(status: string): Badge {
  const kind: Badge["kind"] = status.includes("needs_response")
    ? "error"
    : status === "won" || status === "prevented"
      ? "ok"
      : status === "lost"
        ? "error"
        : status.includes("under_review")
          ? "info"
          : "neutral";
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

function disputeRow(ctx: DashboardCtx, d: StripeDispute): TableBlock["rows"][number] {
  return {
    id: d.id,
    ref: { page: "disputes.detail", params: { id: d.id } },
    cells: [
      amount(ctx.stripe, d.amount, d.currency, statusBadgeFor(d.status)),
      text(sentence(d.reason.replace(/_/g, " "))),
      d.customerId
        ? ({ t: "link", v: d.customerId, ref: { page: "customers.detail", params: { id: d.customerId } } } as Cell)
        : text("N/A"),
      d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("N/A"),
      dueCells(d),
      idCell(d.id, { copy: true }),
    ] as Cell[],
  };
}

// Needs-response due-date board: the two respondable statuses, most urgent first.
async function boardBlock(ctx: DashboardCtx): Promise<Block> {
  const open = await ctx.stores.dispute.listOpen(0, BOARD_WINDOW, undefined, "due");
  const rows = open.rows
    .filter((d) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(d.status))
    .map((d) => disputeRow(ctx, d));
  return {
    type: "table",
    key: "board",
    title: "Evidence due",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No disputes need a response right now.",
    ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
    notice: "Sorted by evidence deadline. Open a dispute to work its evidence in the workbench.",
  };
}

// All disputes: status count-cards + reason/sort pills over the full mirror.
async function allBlocks(
  ctx: DashboardCtx,
  filters: Record<string, string>,
  cursor: string | null,
  counts: Array<{ status: string; count: number }>
): Promise<Block[]> {
  const status = /^[a-z_]{1,32}$/.test(filters.status ?? "") ? filters.status : "";
  const reason = /^[a-z_.]{1,40}$/.test(filters.reason ?? "") ? filters.reason : "";
  const sort = filters.sort === "due" || filters.sort === "amount" ? filters.sort : "new";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;

  const [page, openReasons, closedReasons] = await Promise.all([
    ctx.stores.dispute.listMirror(offset, PAGE_SIZE, { status: status || undefined, reason: reason || undefined }, sort),
    ctx.stores.dispute.openReasons().catch(() => []),
    ctx.stores.dispute.closedReasons().catch(() => []),
  ]);
  const reasons = [...new Set([...openReasons, ...closedReasons].map((r) => r.reason))].sort();
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  const table: TableBlock = {
    type: "table",
    key: "all",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    counts: {
      key: "status",
      items: [
        { value: "", label: "All", count: total },
        ...counts
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((c) => ({ value: c.status, label: sentence(c.status.replace(/_/g, " ")), count: c.count })),
      ],
    },
    filters: [
      {
        key: "reason",
        label: "Reason",
        kind: "select",
        value: reason || undefined,
        options: reasons.map((r) => ({ value: r, label: sentence(r.replace(/_/g, " ")) })),
      },
      {
        key: "sort",
        label: "Sort",
        kind: "select",
        value: sort === "new" ? undefined : sort,
        options: [
          { value: "due", label: "Evidence deadline" },
          { value: "amount", label: "Amount" },
        ],
      },
    ],
    rows: page.rows.map((d) => disputeRow(ctx, d)),
    nextCursor: offset + PAGE_SIZE < page.total ? String(offset + PAGE_SIZE) : null,
    empty: status || reason ? "No disputes match these filters." : "No disputes mirrored yet.",
    ...(page.rows.length
      ? { footer: `${page.rows.length} of ${page.total} item${page.total === 1 ? "" : "s"}` }
      : {}),
    notice: "Local mirror kept fresh by the dispute monitor and Stripe webhooks.",
  };
  return [table];
}

// Auto-resolve queue: what the engine has proposed, refused and executed.
//
// This exists because the engine moves money without anybody pressing
// anything, and an automation nobody can see is an automation nobody can
// trust. Vetoing carries NO typed confirmation on purpose: the ceremony exists
// to slow down actions that spend money, and this one stops one.
async function autoResolveBlocks(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<Block[]> {
  const store = deps.autoResolveStore;
  if (!store) {
    return [{ type: "notice", badge: { kind: "info", text: "Off" }, text: "Auto-resolve is not configured on this instance." }];
  }
  const state = /^[A-Z]{1,12}$/.test(filters.state ?? "") ? filters.state : "";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const [page, byState] = await Promise.all([
    store.list(offset, PAGE_SIZE, { state: (state || undefined) as never }),
    store.countsByState().catch(() => ({}) as Record<string, number>),
  ]);
  const total = Object.values(byState).reduce((sum, n) => sum + n, 0);

  const table: TableBlock = {
    type: "table",
    key: "autoresolve",
    columns: [
      { key: "state", label: "State" },
      { key: "stage", label: "Stage" },
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "fires", label: "Fires / fired" },
      { key: "who", label: "Outcome" },
      { key: "charge", label: "Charge" },
    ],
    counts: {
      key: "state",
      items: [
        { value: "", label: "All", count: total },
        { value: "PENDING", label: "Pending", count: byState.PENDING ?? 0 },
        { value: "EXECUTED", label: "Executed", count: byState.EXECUTED ?? 0 },
        { value: "BLOCKED", label: "Declined", count: byState.BLOCKED ?? 0 },
        { value: "VETOED", label: "Cancelled", count: byState.VETOED ?? 0 },
      ],
    },
    rows: page.rows.map((r) => {
      const pending = r.state === "PENDING";
      // An executed row whose side effects never landed is a real loose end:
      // the money moved but the subscription may still be billing.
      const stuck = r.state === "EXECUTED" && (!r.subsCancelledAt || !r.intercomNotedAt);
      const badgeKind: Badge["kind"] =
        r.state === "EXECUTED" ? (stuck ? "warn" : "ok") : pending ? "warn" : r.state === "FAILED" ? "error" : "neutral";
      return {
        id: r.id,
        cells: [
          badgeCell(badgeKind, r.state.toLowerCase()),
          text(r.stage === "efw" ? "Fraud warning" : "Inquiry"),
          amount(ctx.stripe, r.amountMinor, r.currency),
          text(sentence(r.reason.replace(/_/g, " "))),
          isoDateCell(r.executedAt ?? r.fireAt),
          text(
            r.state === "BLOCKED"
              ? (r.guardrail ?? "blocked").replace(/_/g, " ")
              : r.state === "VETOED"
                ? `cancelled by ${r.vetoedByName ?? "an admin"}`
                : stuck
                  ? "refunded, follow-up incomplete"
                  : (r.refundId ?? "")
          ),
          idCell(r.chargeId, { copy: true }),
        ] as Cell[],
        ...(pending
          ? {
              actions: [
                // Accepting a proposal moves real money, so it carries the
                // typed confirmation that cancelling deliberately does not.
                {
                  key: "section:disputes.autoresolve_execute",
                  label: "Execute now",
                  style: "primary",
                  dangerous: true,
                  params: { id: r.id },
                  summary: `Refund ${ctx.stripe.formatAmount(r.amountMinor, r.currency)} on ${r.chargeId} now, without waiting for the veto window. Every guardrail is re-checked against live Stripe state first, so this accepts the proposal rather than overriding it.`,
                },
                { key: "section:disputes.autoresolve_veto", label: "Cancel", style: "danger", params: { id: r.id } },
              ] as ActionButton[],
            }
          : {}),
      };
    }),
    nextCursor: offset + PAGE_SIZE < page.total ? String(offset + PAGE_SIZE) : null,
    empty:
      "Nothing proposed yet. Proposals are made when a dispute arrives, so a backlog from before the engine was switched on needs Evaluate open inquiries above.",
    notice:
      "Refunding an inquiry-stage dispute closes it as prevented, so it never counts toward the dispute ratio. Cancelling stops the refund; it does not close the dispute.",
  };
  return [table];
}

// The standing policy documents: uploaded once here, stamped into every
// dispute that has an empty slot for them.
//
// Three rows, so no pagination: Stripe has exactly these file slots a published
// policy can occupy, and inventing more would only produce slots a bank does
// not read.
const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"];

async function documentsPage(ctx: DashboardCtx, deps: DisputesDeps): Promise<SectionPage> {
  const crumbs = [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Policy documents" }];
  const store = deps.evidenceDocuments;
  if (!store) {
    return {
      title: "Policy documents",
      crumbs,
      blocks: [{ type: "notice", badge: { kind: "info", text: "Off" }, text: "The document store is not configured." }],
    };
  }

  const held = await store.bySlot();
  const table: TableBlock = {
    type: "table",
    key: "documents",
    columns: [
      { key: "slot", label: "Slot" },
      { key: "file", label: "Document" },
      { key: "size", label: "Size", align: "right" },
      { key: "who", label: "Uploaded" },
    ],
    rows: STANDING_DOCUMENT_SLOTS.map((spec) => {
      const doc = held.get(spec.slot);
      const upload: ActionButton = {
        key: "section:disputes.document_put",
        label: doc ? "Replace" : "Upload",
        style: doc ? "secondary" : "primary",
        params: { slot: spec.slot },
        summary: `${doc ? "Replaces" : "Sets"} the ${spec.label.toLowerCase()} attached to every dispute from now on. PDF, PNG or JPEG, up to 4MB. Disputes already staged keep the file they were given.`,
        inputs: [
          { type: "file", key: "doc", label: `${spec.label} (PDF, PNG or JPEG)`, accept: DOCUMENT_TYPES, maxBytes: DOCUMENT_MAX_BYTES },
        ],
      };
      return {
        id: spec.slot,
        cells: [
          strong(spec.label),
          doc ? text(doc.fileName) : ({ t: "badge", b: { kind: "warn", text: "none" } } as Cell),
          text(doc ? `${Math.max(1, Math.round(doc.sizeBytes / 1024))}KB` : ""),
          text(doc ? `${doc.uploadedByName}, ${doc.uploadedAt.toISOString().slice(0, 10)}` : spec.help),
        ] as Cell[],
        actions: [
          upload,
          ...(doc
            ? ([
                {
                  key: "section:disputes.document_remove",
                  label: "Stop attaching",
                  style: "danger",
                  dangerous: true,
                  params: { slot: spec.slot },
                  summary: `Future disputes stop receiving the ${spec.label.toLowerCase()}. Nothing already staged is touched and the file stays in the Stripe account.`,
                },
              ] as ActionButton[])
            : []),
        ] as ActionButton[],
      };
    }),
    nextCursor: null,
    empty: "No document slots.",
    notice:
      "Uploaded once and reused: a dispute_evidence file can be referenced by any number of disputes, so these cost nothing per dispute. They attach whenever a pack is built, never overwrite a slot a human has filled, and reach the bank only when you submit evidence.",
  };

  return {
    title: "Policy documents",
    crumbs,
    blocks: [
      {
        type: "notice",
        badge: { kind: "info", text: "Which document" },
        text: "Attach the policy exactly as published. An analyst is checking whether what you assert in the text is a real, published rule, so a document written for the dispute argues less than the page the customer could have read.",
      },
      table,
    ],
  };
}

// Evidence template editor.
//
// The shipped corpus is reviewed text in the repository; a row here overrides
// exactly one (reason, field) pair so wording can be fixed without a deploy.
// The per-field fallback means most fields show as inherited from "general",
// which is what keeps the corpus small enough to maintain.
async function templatesPage(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const store = deps.templateStore;
  if (!store) {
    return {
      title: "Evidence templates",
      crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Templates" }],
      blocks: [{ type: "notice", badge: { kind: "info", text: "Off" }, text: "The template store is not configured." }],
    };
  }

  const reason = (PACK_REASONS as readonly string[]).includes(filters.reason ?? "")
    ? (filters.reason as PackReason)
    : "general";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const overrides = await store.overrides();

  const fields = PACK_FIELDS_BY_REASON[reason];
  const shown = fields.slice(offset, offset + TEMPLATE_PAGE_SIZE);

  const blocks: Block[] = [
    {
      type: "tabs",
      key: "reason",
      value: reason === "general" ? undefined : reason,
      items: PACK_REASONS.map((r) => ({ value: r === "general" ? "" : r, label: sentence(r.replace(/_/g, " ")) })),
    },
  ];

  const table: TableBlock = {
    type: "table",
    key: "templates",
    columns: [
      { key: "field", label: "Evidence field" },
      { key: "source", label: "Source" },
      { key: "length", label: "Length" },
      { key: "tokens", label: "Tokens used" },
    ],
    rows: shown.map((field) => {
      const own = overrides.get(`${reason}:${field}`);
      const general = overrides.get(`general:${field}`);
      const template = templateFor(reason, field, overrides);
      const body = (template?.blocks ?? []).map((b) => b.text).join("\n\n");
      const tokens = template ? templateTokens(template) : [];
      const source: Badge = own
        ? { kind: "warn", text: "Override" }
        : general
          ? { kind: "warn", text: "Override (general)" }
          : TEMPLATE_LIBRARY[reason]?.[field]
            ? { kind: "ok", text: "Shipped" }
            : { kind: "neutral", text: "Inherited" };
      return {
        id: field,
        cells: [
          strong(field),
          { t: "badge", b: source } as Cell,
          text(`${body.length} chars`),
          text(tokens.slice(0, 4).join(", ") + (tokens.length > 4 ? ` +${tokens.length - 4}` : "")),
        ] as Cell[],
        actions: [
          {
            key: "section:disputes.template_save",
            label: "Edit",
            style: "secondary",
            params: { reason, field },
            inputs: [
              {
                type: "text",
                key: "body",
                label: "Template text (paragraphs separated by a blank line)",
                multiline: true,
                rows: 14,
                maxLength: 3500,
                value: body,
              },
            ],
          },
          ...(own
            ? ([
                {
                  key: "section:disputes.template_reset",
                  label: "Reset to shipped",
                  style: "danger",
                  dangerous: true,
                  params: { reason, field },
                },
              ] as ActionButton[])
            : []),
        ] as ActionButton[],
      };
    }),
    nextCursor: offset + TEMPLATE_PAGE_SIZE < fields.length ? String(offset + TEMPLATE_PAGE_SIZE) : null,
    empty: "No templated fields for this reason.",
    footer: `${shown.length} of ${fields.length} field${fields.length === 1 ? "" : "s"} · corpus ${TEMPLATE_VERSION}`,
    notice:
      "A field renders only when every token in it resolves. Anything unresolved drops that paragraph, or the whole field, rather than reaching a bank with a gap in it.",
  };
  blocks.push(table);
  blocks.push({
    type: "notice",
    badge: { kind: "info", text: "Tokens" },
    text: `Available tokens: ${TOKEN_NAMES.join(", ")}`,
  });

  return {
    title: "Evidence templates",
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Templates" }],
    blocks,
  };
}

// History & stats: outcome tiles + win-rate by reason + closed list.
async function historyBlocks(ctx: DashboardCtx, cursor: string | null): Promise<Block[]> {
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const [stats, byReason, closed] = await Promise.all([
    ctx.stores.dispute.outcomeStats(),
    ctx.stores.dispute.statsByReason().catch(() => []),
    ctx.stores.dispute.listClosed(offset, PAGE_SIZE),
  ]);
  const fmtAmounts = (buckets: Record<string, number>): string => {
    const parts = Object.entries(buckets).map(([cur, minor]) => ctx.stripe.formatAmount(minor, cur));
    return parts.join(" + ") || "N/A";
  };

  const blocks: Block[] = [];
  blocks.push({
    type: "stats",
    items: [
      { label: "Won", value: String(stats.won), sub: fmtAmounts(stats.wonAmount) },
      { label: "Lost", value: String(stats.lost), sub: fmtAmounts(stats.lostAmount) },
      {
        label: "Win rate",
        value: stats.winRatePct == null ? "N/A" : `${stats.winRatePct.toFixed(0)}%`,
        sub: `${stats.won + stats.lost} decided`,
      },
      {
        label: "Lost unanswered",
        value: String(stats.lostUnanswered),
        ...(stats.lostUnanswered > 0 ? { badge: { kind: "error", text: "evidence never sent" } as Badge } : {}),
      },
    ],
  });

  if (byReason.length > 0) {
    blocks.push({
      type: "table",
      key: "byreason",
      title: "Win rate by reason",
      columns: [
        { key: "reason", label: "Reason" },
        { key: "won", label: "Won", align: "right" },
        { key: "lost", label: "Lost", align: "right" },
        { key: "rate", label: "Win rate", align: "right" },
      ],
      rows: byReason.map((r) => ({
        id: r.reason,
        cells: [
          strong(sentence(r.reason.replace(/_/g, " "))),
          text(String(r.won)),
          text(String(r.lost)),
          r.winRatePct == null
            ? text("N/A")
            : badgeCell(r.winRatePct >= 50 ? "ok" : "warn", `${r.winRatePct.toFixed(0)}%`),
        ] as Cell[],
      })),
    });
  }

  blocks.push({
    type: "table",
    key: "closed",
    title: "Closed disputes",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "closed", label: "Closed" },
      { key: "id", label: "ID" },
    ],
    rows: closed.rows.map((d) => ({
      id: d.id,
      ref: { page: "disputes.detail", params: { id: d.id } },
      cells: [
        amount(ctx.stripe, d.amount, d.currency, statusBadgeFor(d.status)),
        text(sentence(d.reason.replace(/_/g, " "))),
        d.customerId
          ? ({ t: "link", v: d.customerId, ref: { page: "customers.detail", params: { id: d.customerId } } } as Cell)
          : text("N/A"),
        d.closedAt ? isoDateCell(d.closedAt) : text("N/A"),
        idCell(d.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: offset + PAGE_SIZE < closed.total ? String(offset + PAGE_SIZE) : null,
    empty: "No closed disputes yet.",
    ...(closed.rows.length
      ? { footer: `${closed.rows.length} of ${closed.total} item${closed.total === 1 ? "" : "s"}` }
      : {}),
  });

  return blocks;
}

// ---- DETAIL: the evidence workbench ----

async function detail(ctx: DashboardCtx, deps: DisputesDeps, id: string): Promise<SectionPage> {
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

  const [watching, bookmarked, notes] = await Promise.all([
    ctx.stores.dispute.isWatching(id, ctx.actor.id),
    ctx.stores.qol.isBookmarked("dispute", id),
    ctx.stores.qol.listNotes("dispute", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
  ]);

  const ed = dispute.evidence_details;
  const draftFields = Object.keys(pkg.draft).length;
  const pastDue = !!ed?.past_due;

  // Header actions: submit + refund-to-prevent inline, the rest in "···".
  const actions: ActionButton[] = [];
  actions.push(submitButton(ctx, pkg, draftFields));
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
    actions,
  });

  if (pkg.terminal) {
    const won = dispute.status === "won" || dispute.status === "prevented";
    main.push({
      type: "notice",
      badge: { kind: won ? "ok" : "error", text: sentence(dispute.status.replace(/_/g, " ")) },
      text: won
        ? "This dispute is closed in your favor; everything below is the submitted record."
        : "This dispute is closed. The evidence below is the read-only record of what was (or wasn't) sent.",
    });
  } else if (!pkg.respondable) {
    main.push({
      type: "notice",
      badge: { kind: "info", text: "Under review" },
      text: "The response is with the bank; evidence can no longer be changed. A decision usually takes 60–75 days.",
    });
  } else if (pastDue) {
    main.push({
      type: "notice",
      badge: { kind: "error", text: "Past due" },
      text: "The evidence deadline has passed; Stripe may still accept a submission briefly, but the bank can ignore late responses. Submit immediately or accept.",
    });
  }
  if (pkg.respondable && pkg.unstagedDraft.length > 0) {
    main.push({
      type: "notice",
      badge: { kind: "warn", text: `${pkg.unstagedDraft.length} draft` },
      text: `Local draft fields not staged at Stripe yet: ${pkg.unstagedDraft.slice(0, 6).join(", ")}${pkg.unstagedDraft.length > 6 ? ", …" : ""}; stage their groups below or they won't reach the bank.`,
    });
  }

  // Evidence at a glance; the staged counts click through to the review page.
  main.push({
    type: "stats",
    items: [
      {
        label: "Staged fields",
        value: String(pkg.textFields.length),
        sub: "view exactly what the bank gets",
        ref: { page: "disputes.review", params: { id } },
      },
      {
        label: "Files",
        value: String(pkg.files.length),
        sub: "staged proof documents",
        ref: { page: "disputes.review", params: { id } },
      },
      { label: "Submissions", value: String(pkg.submissions), ...(pkg.submissions > 0 ? { badge: { kind: "info", text: "sent" } as Badge } : {}) },
      {
        label: "Evidence due",
        value: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10) : "N/A",
        ...(row.evidenceDueBy ? { badge: dueBadge(row.evidenceDueBy) } : {}),
      },
    ],
  });

  main.push(evidenceBlockFrom(pkg));

  const timeline: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"] }> = [];
  if (row.closedAt)
    timeline.push({
      label: `Closed: ${sentence(row.status.replace(/_/g, " "))}`,
      iso: row.closedAt.toISOString(),
      kind: row.status === "won" ? "ok" : row.status === "lost" ? "error" : "info",
    });
  if (row.evidenceSubmittedAt)
    timeline.push({ label: "Evidence submitted", iso: row.evidenceSubmittedAt.toISOString(), kind: "info" });
  if (row.evidenceDueBy)
    timeline.push({
      label: "Evidence deadline",
      iso: row.evidenceDueBy.toISOString(),
      kind: row.evidenceDueBy.getTime() < Date.now() && !row.evidenceSubmittedAt && !row.closedAt ? "error" : "warn",
    });
  timeline.push({ label: "Dispute opened", iso: row.disputeCreatedAt.toISOString(), kind: "error" });
  main.push({ type: "timeline", title: "Timeline", items: timeline });

  // ---- rail ----
  const card = dispute.payment_method_details?.card;
  const fees = (dispute.balance_transactions ?? []).reduce((sum, bt) => sum + (bt.fee ?? 0), 0);
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Dispute ID", cell: idCell(id, { copy: true }) },
      { label: "Status", cell: badgeCell(statusBadgeFor(dispute.status).kind, statusBadgeFor(dispute.status).text) },
      { label: "Reason", cell: text(sentence((dispute.reason || "unknown").replace(/_/g, " "))) },
      ...(card?.case_type ? [{ label: "Case type", cell: text(sentence(card.case_type)) }] : []),
      ...(card?.network_reason_code ? [{ label: "Network code", cell: text(card.network_reason_code) }] : []),
      ...(fees ? [{ label: "Dispute fee", cell: text(ctx.stripe.formatAmount(fees, dispute.currency)) }] : []),
      { label: "Opened", cell: isoDateCell(row.disputeCreatedAt) },
      ...(chargeId
        ? [{ label: "Charge", cell: idCell(chargeId, { copy: true, ref: { page: "payments.detail", params: { id: chargeId } } }) }]
        : []),
      ...(row.paymentIntentId
        ? [{ label: "Payment intent", cell: idCell(row.paymentIntentId, { copy: true, ref: { page: "payments.detail", params: { id: row.paymentIntentId } } }) }]
        : []),
    ],
  });
  rail.push({
    type: "kv",
    title: "Customer",
    rows: customerId
      ? [{ label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) }]
      : [{ label: "Customer", cell: text("No customer on the charge (guest or deleted).") }],
  });
  const refundableText = pkg.terminal
    ? "dispute closed"
    : dispute.is_charge_refundable
      ? "yes, refund prevents/settles this"
      : "no, respond with evidence";
  rail.push({
    type: "kv",
    title: "Response",
    rows: [
      { label: "Deadline", cell: row.evidenceDueBy ? isoDateCell(row.evidenceDueBy) : text("no response window") },
      { label: "Urgency", cell: dueCells(row) },
      { label: "Draft fields", cell: draftFields ? badgeCell("info", `${draftFields} local`) : text("none") },
      { label: "Refundable", cell: text(refundableText) },
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

  // What actually happened to this dispute, automated and human alike. The
  // mirror above says what the evidence IS; this says how it got that way,
  // which is the question an operator asks when a package is already at a bank.
  const events = deps.events ? await deps.events.list(id) : [];
  if (events.length) {
    main.push({
      type: "timeline",
      title: `History (${events.length})`,
      items: events.map((e) => ({
        label: e.actorName ?? (e.actorId ? `Admin ${e.actorId}` : "Automatic"),
        iso: e.at.toISOString(),
        text: e.summary,
        kind: eventTone(e.kind),
      })),
    });

    // The provenance of the last package built: which fields it filled, which
    // it deliberately left out and why, and which external sources answered.
    const lastPack = [...events].reverse().find((e) => e.kind === "pack_staged");
    const detail = lastPack?.detail as
      | {
          staged?: string[];
          omitted?: Array<{ field: string; why: string }>;
          sources?: Record<string, boolean>;
          reached?: Record<string, boolean>;
          templateVersion?: string;
        }
      | undefined;
    if (detail) {
      // Three states, not two. A source that answered and was not used was
      // refused on quality, which reads as a broken feed if it is reported the
      // same way as one that said nothing. Entries written before this existed
      // carry no `reached` map and keep the old two-state wording rather than
      // being relabelled with a guess.
      const sources = Object.entries(detail.sources ?? {})
        .map(([name, used]) => {
          const label = sentence(name.replace(/([A-Z])/g, " $1").toLowerCase());
          if (used) return `${label}: used`;
          if (!detail.reached) return `${label}: no data`;
          return `${label}: ${detail.reached[name] ? "answered, not enough to cite" : "no data"}`;
        })
        .join(" · ");
      main.push({
        type: "kv",
        title: "What the last package was built from",
        rows: [
          { label: "Template corpus", cell: text(detail.templateVersion ?? "unknown") },
          { label: "Fields filled", cell: text((detail.staged ?? []).join(", ") || "none") },
          {
            label: "Fields omitted",
            cell: text(
              (detail.omitted ?? []).map((o) => `${o.field} (${o.why})`).join("; ") ||
                "none: every templated field was grounded"
            ),
          },
          { label: "Sources", cell: text(sources || "none") },
        ],
      });
    }
  }

  return {
    title: ctx.stripe.formatAmount(dispute.amount, dispute.currency),
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: id, copyId: id }],
    blocks: main,
    rail,
  };
}

// Colour by what the entry MEANS, so a timeline can be skimmed for trouble:
// money moved and failures stand out, routine automation does not.
function eventTone(kind: string): "info" | "ok" | "warn" | "error" {
  if (kind === "resolve_executed" || kind === "evidence_submitted") return "ok";
  if (kind === "resolve_failed" || kind === "escalated" || kind === "auto_submit_refused") return "error";
  if (kind === "resolve_blocked" || kind === "resolve_vetoed" || kind === "accepted") return "warn";
  return "info";
}

function dueBadge(dueBy: Date): Badge {
  const hoursLeft = (dueBy.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return { kind: "error", text: "OVERDUE" };
  if (hoursLeft <= DUE_URGENT_HOURS) return { kind: "error", text: `${Math.max(1, Math.round(hoursLeft))}h left` };
  if (hoursLeft <= DUE_WARN_HOURS) return { kind: "warn", text: `${Math.round(hoursLeft / 24)}d left` };
  return { kind: "neutral", text: `${Math.round(hoursLeft / 24)}d left` };
}

// The submit ceremony button: typed CONFIRM + Discord reverse code, with the
// staged summary baked into the modal text (single-submission warning).
function submitButton(ctx: DashboardCtx, pkg: StagedPackage, draftFields: number): ActionButton {
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

// ---- REVIEW: staged-evidence read-back (exactly what the bank receives) ----

async function review(ctx: DashboardCtx, deps: DisputesDeps, id: string): Promise<SectionPage> {
  let pkg: StagedPackage;
  try {
    pkg = await deps.evidence.stagedPackage(id);
  } catch (e) {
    if ((e as Stripe.errors.StripeError).code === "resource_missing") {
      return notFound("This dispute no longer exists at Stripe.");
    }
    throw e;
  }
  const d = pkg.dispute;
  const draftFields = Object.keys(pkg.draft).length;

  const main: Block[] = [];
  main.push({
    type: "header",
    title: "Staged evidence",
    sub: `${d.id} · ${ctx.stripe.formatAmount(d.amount, d.currency)} · ${sentence((d.reason || "unknown").replace(/_/g, " "))}`,
    badges: [
      statusBadgeFor(d.status),
      ...(pkg.submissions > 0 ? [{ kind: "info", text: `Submitted ${pkg.submissions}×` } as Badge] : []),
    ],
    actions: [submitButton(ctx, pkg, draftFields)],
  });
  main.push({
    type: "notice",
    badge: { kind: "info", text: "Read-back" },
    text:
      pkg.submissions > 0
        ? "This is what the bank received (and would receive again on a resubmission)."
        : "This is exactly what the bank receives when you submit. Nothing here has been sent yet.",
  });

  main.push({
    type: "table",
    key: "stagedfields",
    title: `Text fields (${pkg.textFields.length})`,
    columns: [
      { key: "field", label: "Field" },
      { key: "len", label: "Length", align: "right" },
      { key: "value", label: "Content" },
    ],
    rows: pkg.textFields.map((f) => ({
      id: f.key,
      cells: [
        idCell(f.key),
        text(`${f.value.length}`),
        text(f.value.length > 300 ? `${f.value.slice(0, 300)}…` : f.value),
      ] as Cell[],
    })),
    empty: "No text evidence staged.",
    ...(pkg.textFields.length ? { footer: `${pkg.textFields.length} field${pkg.textFields.length === 1 ? "" : "s"}` } : {}),
  });

  main.push({
    type: "table",
    key: "stagedfiles",
    title: `Files (${pkg.files.length})`,
    columns: [
      { key: "slot", label: "Slot" },
      { key: "file", label: "File ID" },
    ],
    rows: pkg.files.map((f) => ({
      id: f.slot,
      cells: [text(sentence(f.slot.replace(/_/g, " "))), idCell(f.fileId, { copy: true })] as Cell[],
      actions: [
        {
          key: "section:disputes.file_remove",
          label: "Remove",
          dangerous: true,
          params: { disputeId: id, slot: f.slot },
          summary: "Detaches this staged file from the dispute (the upload stays in your Stripe account). It will NOT reach the bank.",
          ...(pkg.respondable ? {} : { disabledReason: "Evidence can no longer be changed on this dispute." }),
        },
      ],
    })),
    empty: "No evidence files attached.",
  });

  if (pkg.unstagedDraft.length > 0) {
    main.push({
      type: "notice",
      badge: { kind: "warn", text: `${pkg.unstagedDraft.length} unstaged` },
      text: `Local draft field(s) NOT staged yet: ${pkg.unstagedDraft.slice(0, 8).join(", ")}${pkg.unstagedDraft.length > 8 ? ", …" : ""}; go back to the workbench and stage their groups, or they won't reach the bank.`,
    });
  }

  // AI critique of exactly this package (works on closed disputes too —
  // post-mortem of what was actually sent), plus the last verdict if fresh.

  return {
    title: "Staged evidence",
    crumbs: [
      { label: "Disputes", ref: { page: "disputes" } },
      { label: d.id, ref: { page: "disputes.detail", params: { id } } },
      { label: "Staged evidence", copyId: d.id },
    ],
    blocks: main,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Dispute not found", hint }],
  };
}
