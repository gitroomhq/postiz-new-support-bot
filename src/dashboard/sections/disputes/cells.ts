import type { StripeDispute } from "../../../generated/prisma/client";
import type { CachedRatioEngine } from "../../../bot/billing/disputeRatio";
import type { DisputeEvidenceService } from "../../../bot/billing/DisputeEvidenceService";
import type { EvidencePackBuilder } from "../../../bot/billing/evidence/EvidencePackBuilder";
import type { AutoResolveStore } from "../../../bot/billing/AutoResolveStore";
import type { EvidenceDocumentStore } from "../../../bot/billing/evidence/EvidenceDocumentStore";
import type { BackfillResult, HandProposeResult } from "../../../bot/billing/AutoResolveService";
import type { TemplateStore } from "../../../bot/billing/evidence/TemplateStore";
import type { DisputeEventStore } from "../../../bot/billing/DisputeEventStore";
import type { ActionActor } from "../../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Cell, TableBlock } from "../../renderer/contract";
import { DashboardCtx, SectionPage } from "../types";
import { amount, idCell, isoDateCell, sentence, text } from "../cells";

// The vocabulary every dispute page shares: the deps bundle, the page sizes,
// and the handful of atoms (status pill, deadline urgency, one list row) that
// have to look identical whether you meet them on the board, the All list or
// the closed-dispute history.

export const PAGE_SIZE = 25;
// The template editor lists one row per evidence field, so it paginates at a
// size a reviewer can actually read rather than the 25-row list default.
export const TEMPLATE_PAGE_SIZE = 10;
export const BOARD_WINDOW = 50;

export const DUE_URGENT_HOURS = 24;
export const DUE_WARN_HOURS = 72;

export const DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"];

export interface DisputesDeps {
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

export function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button: queue notice or disabled state.
// Execution re-checks server-side regardless.
export function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") {
    return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  }
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

export function statusBadgeFor(status: string): Badge {
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

// How much time is left, as a pill. The same scale everywhere a deadline is
// shown, so "3d left" means the same thing in the list as in the status bar.
export function dueBadge(dueBy: Date): Badge {
  const hoursLeft = (dueBy.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return { kind: "error", text: "OVERDUE" };
  if (hoursLeft <= DUE_URGENT_HOURS) return { kind: "error", text: `${Math.max(1, Math.round(hoursLeft))}h left` };
  if (hoursLeft <= DUE_WARN_HOURS) return { kind: "warn", text: `${Math.round(hoursLeft / 24)}d left` };
  return { kind: "neutral", text: `${Math.round(hoursLeft / 24)}d left` };
}

export function dueCells(d: { evidenceDueBy: Date | null }): Cell {
  if (!d.evidenceDueBy) return text("N/A");
  return { t: "flags", badges: [dueBadge(d.evidenceDueBy)] };
}

export function disputeRow(ctx: DashboardCtx, d: StripeDispute): TableBlock["rows"][number] {
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

// Colour by what the entry MEANS, so a timeline can be skimmed for trouble:
// money moved and failures stand out, routine automation does not.
export function eventTone(kind: string): "info" | "ok" | "warn" | "error" {
  if (kind === "resolve_executed" || kind === "evidence_submitted") return "ok";
  if (kind === "resolve_failed" || kind === "escalated" || kind === "auto_submit_refused") return "error";
  if (kind === "resolve_blocked" || kind === "resolve_vetoed" || kind === "accepted") return "warn";
  return "info";
}

export function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Dispute not found", hint }],
  };
}
