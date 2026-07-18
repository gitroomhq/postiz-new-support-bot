import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { amount, badgeCell, idCell, isoDateCell, text } from "./cells";

// Approvals: the BillingApproval queue (queued canvas/panel/dashboard actions)
// + PendingChargeReview rows (guardrail-tripped self-service refunds). Both
// work cross-surface: an Intercom-queued action can be approved here and a
// dashboard-queued one from the Intercom panel — BillingActionService rebuilds
// the execution ctx from the approval's origin.

const PAGE_SIZE = 25;

export function makeApprovalsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "approvals", label: "Approvals", page: "approvals", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "approvals";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const offset = /^\d{1,6}$/.test(req.cursor ?? "") ? Number(req.cursor) : 0;
      const [approvals, reviews] = await Promise.all([
        ctx.billing.actions.pendingPage(offset, PAGE_SIZE),
        ctx.stores.session.listPendingChargeReviews(0, PAGE_SIZE),
      ]);

      const blocks: Block[] = [];

      blocks.push({
        type: "table",
        key: "approvals",
        title: "Queued actions",
        columns: [
          { key: "summary", label: "Action" },
          { key: "origin", label: "Origin" },
          { key: "customer", label: "Customer" },
          { key: "age", label: "Requested" },
          { key: "status", label: "Status" },
        ],
        rows: approvals.rows.map((a) => {
          return {
            id: a.id,
            cells: [
              {
                t: "text",
                v: a.summary,
                sub: `by ${a.requestedByName} · ${a.actionKey} · ${JSON.stringify(a.paramsJson).slice(0, 100)}`,
              },
              badgeCell(a.origin === "dashboard" ? "info" : "neutral", a.origin),
              a.stripeCustomerId
                ? idCell(a.stripeCustomerId, { ref: { page: "customers.detail", params: { id: a.stripeCustomerId } } })
                : text("—"),
              isoDateCell(a.createdAt),
              a.status === "FAILED"
                ? ({ t: "text", v: "Failed — retryable", sub: (a.errorText ?? "").slice(0, 100) } as Cell)
                : ({ t: "badge", b: { kind: "warn", text: "Pending" } } as Cell),
            ] as Cell[],
            actions: [
              {
                key: "section:approvals.act",
                label: "Approve",
                style: "primary" as const,
                dangerous: true,
                params: { id: a.id, decision: "approve" },
                summary: `${a.summary}\nRequested by ${a.requestedByName} (${a.origin}). Approval revalidates against live Stripe state before executing.`,
              },
              {
                key: "section:approvals.act",
                label: "Reject",
                params: { id: a.id, decision: "reject" },
              },
              {
                key: "section:approvals.preview",
                label: "Check",
                params: { id: a.id },
              },
            ],
          };
        }),
        nextCursor: offset + PAGE_SIZE < approvals.total ? String(offset + PAGE_SIZE) : null,
        empty: "No queued actions.",
        ...(approvals.rows.length
          ? { footer: `${approvals.rows.length} of ${approvals.total} item${approvals.total === 1 ? "" : "s"}` }
          : {}),
        notice: "Queued actions expire after 7 days. Approving revalidates against live Stripe state — a stale request refuses instead of executing.",
      });

      blocks.push({
        type: "table",
        key: "reviews",
        title: "Charge reviews",
        columns: [
          { key: "amount", label: "Amount" },
          { key: "reason", label: "Blocked because" },
          { key: "customer", label: "Discord user" },
          { key: "ticket", label: "Ticket thread" },
          { key: "age", label: "Requested" },
        ],
        rows: reviews.rows.map((r) => ({
          id: r.id,
          cells: [
            amount(ctx.stripe, r.amount, r.currency, { kind: "warn", text: "Needs review" }),
            text(r.reason),
            idCell(r.customerId, { copy: true }),
            idCell(r.threadId, { copy: true }),
            isoDateCell(r.createdAt),
          ] as Cell[],
          actions: [
            {
              key: "charge_review",
              label: "Approve refund",
              style: "primary" as const,
              dangerous: true,
              params: { threadId: r.threadId, decision: "approve" },
              summary: `Refund ${ctx.stripe.formatAmount(r.amount, r.currency)} (${r.chargeId}) and cancel the linked subscription — the guardrail-blocked self-service path, executed via the refund core.`,
            },
            {
              key: "charge_review",
              label: "Deny",
              style: "danger" as const,
              dangerous: true,
              params: { threadId: r.threadId, decision: "deny" },
              inputs: [{ type: "text", key: "reason", label: "Reason (optional)", maxLength: 400 }],
              summary: "Deny the blocked refund request.",
            },
          ],
        })),
        empty: "No pending charge reviews.",
        ...(reviews.rows.length
          ? { footer: `${reviews.rows.length} of ${reviews.total} item${reviews.total === 1 ? "" : "s"}` }
          : {}),
        notice: "Guardrail-tripped self-service refunds. Approve runs the same refund core as Discord /charge approve (idempotent, subscription cancel included).",
      });

      return { title: "Approvals", crumbs: [{ label: "Approvals" }], blocks };
    },

    async action(ctx: DashboardCtx, req) {
      const p = req.params ?? {};
      switch (req.key) {
        case "section:approvals.act": {
          const id = str(p.id, 40);
          const decision = p.decision === "approve" ? "approve" : p.decision === "reject" ? "reject" : null;
          if (!id || !decision) return { ok: false, error: "Bad request." };
          // T1 belt server-side: approving moves money.
          if (decision === "approve" && req.confirmWord !== "CONFIRM") {
            return { ok: false, error: "Type CONFIRM to approve." };
          }
          const outcome = await ctx.billing.actions.actOnApproval(id, actor(ctx), decision);
          switch (outcome.kind) {
            case "executed":
              await ctx.audit(`Approval ${id} approved`);
              return { ok: true, text: outcome.text };
            case "rejected":
              await ctx.audit(`Approval ${id} rejected`);
              return { ok: true, text: "Approval rejected." };
            case "already_handled":
            case "denied":
            case "failed":
              return { ok: false, error: outcome.error };
          }
          return { ok: false, error: "Unexpected outcome." };
        }
        case "section:approvals.preview": {
          const id = str(p.id, 40);
          if (!id) return { ok: false, error: "Bad request." };
          const approval = await ctx.billing.actions.getApproval(id);
          if (!approval) return { ok: false, error: "Approval not found (already handled?)." };
          const refusal = await ctx.billing.actions.previewRevalidation(approval);
          return { ok: true, text: refusal ? `Would refuse: ${refusal}` : "Would still execute — live revalidation passes." };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },

    async navBadge(ctx: DashboardCtx): Promise<string | null> {
      const [approvals, reviews] = await Promise.all([
        ctx.billing.actions.pendingPage(0, 1).then((r) => r.total),
        ctx.stores.session.countPendingChargeReviews(),
      ]);
      const total = approvals + reviews;
      return total > 0 ? String(total) : null;
    },
  };
}

function actor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}
