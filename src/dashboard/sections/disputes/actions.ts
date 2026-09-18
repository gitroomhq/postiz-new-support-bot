import { EVIDENCE_GROUPS, EVIDENCE_KEY_SET } from "../../../bot/billing/DisputeEvidenceService";
import { isStandingSlot } from "../../../bot/billing/evidence/EvidenceDocumentStore";
import { NO_INTERNAL_ARTIFACT, tokensIn } from "../../../bot/billing/evidence/renderTemplate";
import { TOKEN_NAMES } from "../../../bot/billing/evidence/tokens";
import { PACK_REASONS, templateFor, type PackReason } from "../../../bot/billing/evidence/templates";
import { exportBillingEvent } from "../../../metrics/MetricsExporter";
import { DashboardCtx, str, validId } from "../types";
import { DisputesDeps, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES } from "./cells";

// Every verb the dispute pages offer, in one place: the workbench edits
// (draft/stage/upload/remove), the two bank-facing ceremonies (submit, accept),
// the pack rebuild, the auto-resolve queue's execute/veto/propose/backfill, the
// template overrides and the standing policy documents. The pages decide which
// buttons to show; this decides what a press does, and re-checks every gate,
// because a button that merely declares a ceremony proves nothing about what
// the browser actually sent.

export async function disputeAction(
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
      // Written as lines rather than one long sentence: this is a report on
      // four separate things (fields, documents, refusals, omissions) and a
      // reader scanning it needs to find the one that concerns them.
      const lines: string[] = [];
      lines.push(
        staged.unchanged
          ? `No change: the staged package already matches the templates and the current facts (${staged.staged.length} field(s), completeness ${staged.pack.score}%).`
          : `Staged ${staged.staged.length} field(s), completeness ${staged.pack.score}%.`
      );
      if (staged.documents.length) {
        lines.push(`Attached: ${staged.documents.map((d: string) => d.replace(/_/g, " ")).join(", ")}.`);
      }
      // Only what a human can act on. "Slot already filled" is the system
      // protecting their own upload, not a problem to report.
      const missing = staged.documentsSkipped.filter((skip: { why: string }) => skip.why !== "slot already filled");
      if (missing.length) {
        lines.push("Not attached:");
        for (const skip of missing) lines.push(`  ${skip.slot.replace(/_/g, " ")}: ${skip.why}`);
      }
      if (staged.omitted.length) {
        lines.push("Fields omitted:");
        for (const o of staged.omitted as Array<{ field: string; why: string }>) lines.push(`  ${o.field}: ${o.why}`);
      }
      if (!staged.unchanged) lines.push("Review the sections below, then submit.");
      return { ok: true, text: lines.join("\n") };
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
          return { ok: false, error: `This dispute already has an auto-resolve row (${r.state.toLowerCase()}); see the Proposals tab.` };
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
