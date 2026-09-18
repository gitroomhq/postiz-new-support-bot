import { ActionButton, Badge, Block, Cell, TableBlock } from "../../renderer/contract";
import { DashboardCtx } from "../types";
import { amount, badgeCell, idCell, isoDateCell, sentence, text } from "../cells";
import { DisputesDeps, PAGE_SIZE } from "./cells";

// Auto-resolve queue: what the engine has proposed, refused and executed.
//
// This exists because the engine moves money without anybody pressing
// anything, and an automation nobody can see is an automation nobody can
// trust. Vetoing carries NO typed confirmation on purpose: the ceremony exists
// to slow down actions that spend money, and this one stops one.
export async function autoResolveBlocks(
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

