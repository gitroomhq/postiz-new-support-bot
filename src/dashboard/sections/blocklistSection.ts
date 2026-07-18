import { BLOCK_KIND_LABELS, type BlockKind } from "../../bot/billing/BlockStore";
import type { BlockService } from "../../bot/billing/BlockService";
import { exportBillingEvent } from "../../metrics/MetricsExporter";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, ActionResult, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validId } from "./types";
import { badgeCell, idCell, isoDateCell, sentence, text } from "./cells";

// Blocklist (#/blocklist, Operate group): every blocked identifier (Radar
// value lists + the bot's local ledger) with add/remove. Customer-shaped
// blocks go through the REGISTRY action customer.block (T2 fresh-factor via
// Dashboard.ts, cancels subs, derives email) — raw value blocks
// (email/fingerprint/IP) run BlockService directly as T1 section actions.
// Unblock = T1. Radar reminder: the value lists only block payments once a
// Radar rule references them.

const PAGE_SIZE = 25;

const IPV4_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6ISH_RE = /^[0-9a-fA-F:]{3,45}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FINGERPRINT_RE = /^[A-Za-z0-9]{8,64}$/;

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") {
    return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  }
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

export function makeBlocklistSection(deps: { blockService: BlockService }): DashboardSectionModule {
  return {
    nav: [{ key: "blocklist", label: "Blocklist", page: "blocklist", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "blocklist";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      return list(ctx, req.cursor ?? null);
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T1 — block a raw value (email / card fingerprint / IP). Customer
        // blocks are NOT accepted here — they must ride the registry action
        // (T2 + sub-cancel semantics).
        case "section:blocklist.add": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const kind = str(p.kind, 20);
          const value = str(p.value, 200).trim();
          const reason = str(p.reason, 300).trim();
          if (!reason) return { ok: false, fieldErrors: { reason: "A reason is required (shown on panels + audit)." } };
          if (kind === "email" && !EMAIL_RE.test(value)) return { ok: false, fieldErrors: { value: "That doesn't look like an email address." } };
          if (kind === "card_fingerprint" && !FINGERPRINT_RE.test(value)) {
            return { ok: false, fieldErrors: { value: "That doesn't look like a card fingerprint (8-64 letters/digits)." } };
          }
          if (kind === "ip_address" && !IPV4_RE.test(value) && !(value.includes(":") && IPV6ISH_RE.test(value))) {
            return { ok: false, fieldErrors: { value: "That doesn't look like a valid IPv4/IPv6 address." } };
          }
          if (kind !== "email" && kind !== "card_fingerprint" && kind !== "ip_address") {
            return { ok: false, error: "Unknown kind — customers are blocked via the Block customer action." };
          }
          const results = await deps.blockService.block([{ kind: kind as BlockKind, value }], {
            reason,
            source: "manual",
            actorId: ctx.actor.id,
            actorName: ctx.actor.name,
            customerId: null,
            disputeId: null,
            cancelSubs: false,
          });
          const r = results[0];
          if (!r?.ok) return { ok: false, error: `Block failed — ${r?.error?.slice(0, 200) ?? "unknown error"}` };
          await ctx.audit(`Blocked ${kind} ${value.slice(0, 60)}${r.alreadyBlocked ? " (was already blocked)" : ""} — ${reason.slice(0, 120)}`);
          exportBillingEvent({ event: "block" });
          return { ok: true, text: `${BLOCK_KIND_LABELS[kind as BlockKind]} blocked${r.alreadyBlocked ? " (was already blocked — refreshed)" : ""}.` };
        }

        // T1 — remove an entry (also removes the Radar list item).
        case "section:blocklist.remove": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const id = str(p.id, 64);
          if (!id) return { ok: false, error: "Bad entry id." };
          const result = await deps.blockService.unblock(id);
          if (!result) return { ok: false, error: "That entry was already removed." };
          await ctx.audit(
            `Unblocked ${result.removed.kind} ${result.removed.value.slice(0, 60)}${result.removed.radarItemId ? " (+ Radar item)" : ""}`
          );
          exportBillingEvent({ event: "unblock" });
          return { ok: true, text: `Unblocked ${result.removed.value.slice(0, 80)}.` };
        }

        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

async function list(ctx: DashboardCtx, cursor: string | null): Promise<SectionPage> {
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const { rows, total } = await ctx.stores.block.listPage(offset, PAGE_SIZE);

  const headerActions: ActionButton[] = [
    registryButton(ctx, {
      key: "customer.block",
      label: "Block customer",
      style: "primary",
      dangerous: true,
      stepUp: true,
      inputs: [
        { type: "text", key: "customerId", label: "Customer id (cus_…)" },
        { type: "text", key: "reason", label: "Reason (shown on panels + audit)", maxLength: 300 },
        { type: "toggle", key: "cancelSubs", label: "Also cancel ALL their active subscriptions", value: true },
      ],
      params: {},
      summary:
        "Blocks the customer id + their email on the Radar value lists AND the local blocklist (self-service refunds denied, panels flagged). Requires a fresh factor (passkey/TOTP).",
    }),
    {
      key: "section:blocklist.add",
      label: "Block value",
      dangerous: true,
      inputs: [
        {
          type: "select",
          key: "kind",
          label: "What to block",
          options: [
            { value: "email", label: "Email address" },
            { value: "card_fingerprint", label: "Card fingerprint" },
            { value: "ip_address", label: "IP address" },
          ],
        },
        { type: "text", key: "value", label: "Value" },
        { type: "text", key: "reason", label: "Reason (shown on panels + audit)", maxLength: 300 },
      ],
      summary: "Adds the value to the matching Radar value list and the local blocklist. The payment IP is never exposed by Stripe's API — enter it from your own logs.",
    },
  ];

  const table: TableBlock = {
    type: "table",
    key: "blocklist",
    columns: [
      { key: "kind", label: "Kind" },
      { key: "value", label: "Value" },
      { key: "reason", label: "Reason" },
      { key: "source", label: "Blocked by" },
      { key: "when", label: "When" },
    ],
    rows: rows.map((r) => ({
      id: r.id,
      cells: [
        badgeCell("neutral", BLOCK_KIND_LABELS[r.kind as BlockKind] ?? sentence(r.kind.replace(/_/g, " "))),
        r.kind === "customer_id"
          ? idCell(r.value, { copy: true, ref: { page: "customers.detail", params: { id: r.value } } })
          : { t: "id", v: r.value.slice(0, 40), copy: true } as Cell,
        text(r.reason.slice(0, 120)),
        text(r.source === "auto_dispute" ? "auto (dispute)" : (r.actorName ?? "?")),
        isoDateCell(r.createdAt),
      ] as Cell[],
      actions: [
        {
          key: "section:blocklist.remove",
          label: "Unblock",
          dangerous: true,
          params: { id: r.id },
          summary: `Remove ${BLOCK_KIND_LABELS[r.kind as BlockKind] ?? r.kind} ${r.value.slice(0, 60)} from the Radar value list and the local blocklist. Reason it was blocked: ${r.reason.slice(0, 200)}`,
        },
      ],
    })),
    nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
    empty: "Nothing blocked.",
    ...(rows.length ? { footer: `${rows.length} of ${total} entr${total === 1 ? "y" : "ies"}` } : {}),
    notice:
      "Radar value lists only block payments once a Radar rule references them (see /config → Billing → Disputes). Blocking a customer also denies their self-service refunds.",
  };

  const blocks: Block[] = [
    { type: "header", title: "Blocklist", actions: headerActions },
    table,
  ];
  return { title: "Blocklist", crumbs: [{ label: "Blocklist" }], blocks };
}
