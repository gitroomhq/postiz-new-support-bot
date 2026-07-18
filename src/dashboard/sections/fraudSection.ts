import type Stripe from "stripe";
import { FraudHuntService } from "../../bot/billing/FraudHuntService";
import { Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { amount, cardCell, dateCell, idCell, sentence, text } from "./cells";

// Fraud tools (#/fraud, Operate group): the recent early-fraud-warning feed
// plus the three account-wide hunts extracted into FraudHuntService — by card
// fingerprint (multi-account picture), by last4+brand (grouped by fingerprint)
// and by amount (PaymentIntents — catches DECLINED attempts that never became
// a charge). Hunt inputs ride the hash filters, validated hard server-side;
// everything is read-only and NEVER runs inside revalidators (the Search API
// lags ~1 min and must not gate money movement).

const SEARCH_LAG_NOTICE = "Stripe Search data can lag ~1 minute behind reality.";

export function makeFraudSection(deps: { hunts: FraudHuntService }): DashboardSectionModule {
  return {
    nav: [{ key: "fraud", label: "Fraud tools", page: "fraud", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "fraud";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const filters = req.filters ?? {};
      const view = filters.view === "card" || filters.view === "amount" ? filters.view : "";
      const blocks: Block[] = [];
      blocks.push({
        type: "tabs",
        key: "view",
        value: view || undefined,
        items: [
          { value: "", label: "Early fraud warnings" },
          { value: "card", label: "Hunt by card" },
          { value: "amount", label: "Hunt by amount" },
        ],
      });
      if (view === "card") blocks.push(...(await cardHunts(ctx, deps, filters)));
      else if (view === "amount") blocks.push(...(await amountHunt(ctx, deps, filters)));
      else blocks.push(await efwTable(ctx));
      return { title: "Fraud tools", crumbs: [{ label: "Fraud tools" }], blocks };
    },
  };
}

// ---- EFW feed ----

async function efwTable(ctx: DashboardCtx): Promise<Block> {
  const efws = await ctx.stripe.listRecentEarlyFraudWarnings(100).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]);
  const rows = efws.map((w) => {
    const chargeId = typeof w.charge === "string" ? w.charge : w.charge.id;
    return {
      id: w.id,
      ref: { page: "payments.detail", params: { id: chargeId } },
      cells: [
        { t: "badge", b: { kind: w.actionable ? "error" : "neutral", text: w.actionable ? "Actionable" : "Not actionable" } as Badge } as Cell,
        text(sentence((w.fraud_type ?? "unknown").replace(/_/g, " "))),
        idCell(chargeId, { ref: { page: "payments.detail", params: { id: chargeId } } }),
        dateCell(w.created),
        idCell(w.id, { copy: true }),
      ] as Cell[],
    };
  });
  return {
    type: "table",
    key: "efws",
    title: "Early fraud warnings",
    columns: [
      { key: "actionable", label: "" },
      { key: "type", label: "Fraud type" },
      { key: "charge", label: "Charge" },
      { key: "created", label: "Reported" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No early fraud warnings in the recent window. 🎉",
    ...(rows.length ? { footer: `${rows.length} warning${rows.length === 1 ? "" : "s"}` } : {}),
    notice: `Latest ${efws.length || 100} EFWs from the card networks. Actionable = a refund can still prevent the dispute. Open the charge to refund or block.`,
  };
}

// ---- card hunts (fingerprint exact + last4 grouped) ----

async function cardHunts(ctx: DashboardCtx, deps: { hunts: FraudHuntService }, filters: Record<string, string>): Promise<Block[]> {
  const fingerprint = str(filters.fp, 64);
  const last4 = str(filters.last4, 4);
  const brand = str(filters.brand, 20);
  const blocks: Block[] = [];

  // Fingerprint hunt: exact card identity across every customer.
  const fpTable: TableBlock = {
    type: "table",
    key: "fphunt",
    title: "Same card, every account",
    filters: [{ key: "fp", label: "Card fingerprint", kind: "search", value: fingerprint || undefined, placeholder: "Card fingerprint (e.g. Xt5EWLLDS7FJjR1c) — exact match across all customers" }],
    columns: [
      { key: "customer", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "charges", label: "Charges", align: "right" },
      { key: "discord", label: "Discord link" },
    ],
    rows: [],
    empty: fingerprint ? "No charges match that fingerprint." : "Enter a card fingerprint — you'll find it on any payment's detail rail.",
    notice: SEARCH_LAG_NOTICE,
  };
  if (fingerprint) {
    const result = await deps.hunts.usersByFingerprint(fingerprint);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      fpTable.rows = result.rows.map((r) => ({
        id: r.customerId,
        ...(r.customerId.startsWith("cus_") ? { ref: { page: "customers.detail", params: { id: r.customerId } } } : {}),
        cells: [
          r.customerId.startsWith("cus_")
            ? idCell(r.customerId, { ref: { page: "customers.detail", params: { id: r.customerId } } })
            : text(r.customerId),
          text(r.email ?? "—"),
          text(String(r.count)),
          r.discordIds.length ? text(r.discordIds.map((d) => `@${d}`).join(", ")) : text("no Discord link"),
        ] as Cell[],
      }));
      fpTable.footer = `${result.rows.length} account${result.rows.length === 1 ? "" : "s"} · from the ${result.scanned} most recent matching charges${result.hasMore ? " — more exist" : ""}`;
    }
  }
  blocks.push(fpTable);

  // last4 hunt: grouped by fingerprint (the exact id for the hunt above).
  const l4Table: TableBlock = {
    type: "table",
    key: "l4hunt",
    title: "Cards by last 4 digits",
    filters: [
      { key: "last4", label: "Last 4", kind: "text", value: last4 || undefined, placeholder: "4242" },
      { key: "brand", label: "Brand", kind: "text", value: brand || undefined, placeholder: "visa / mastercard / amex" },
    ],
    columns: [
      { key: "card", label: "Card" },
      { key: "exp", label: "Expires" },
      { key: "charges", label: "Charges", align: "right" },
      { key: "customers", label: "Customers" },
      { key: "fp", label: "Fingerprint" },
    ],
    rows: [],
    empty: last4 ? "No settled charges for that card. Declined attempts never become charges — hunt by amount instead." : "Enter the last 4 digits (brand narrows it).",
    notice: `last4 is not unique — rows are grouped by fingerprint; feed one into the exact hunt above. ${SEARCH_LAG_NOTICE}`,
  };
  if (last4) {
    const result = await deps.hunts.cardsByLast4(last4, brand || undefined);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      l4Table.rows = result.rows.map((g, i) => ({
        id: g.fingerprint ?? `nofp-${i}`,
        cells: [
          cardCell(g.brand, g.last4),
          text(g.exp),
          text(String(g.count)),
          text(
            g.customers
              .slice(0, 3)
              .map((c) => c.email ?? c.id)
              .join(", ") + (g.customers.length > 3 ? ` +${g.customers.length - 3}` : "") || "—"
          ),
          g.fingerprint ? idCell(g.fingerprint, { copy: true }) : text("—"),
        ] as Cell[],
      }));
      l4Table.footer = `${result.rows.length} card${result.rows.length === 1 ? "" : "s"} · from the ${result.scanned} most recent matching charges${result.hasMore ? " — more exist" : ""}`;
    }
  }
  blocks.push(l4Table);
  return blocks;
}

// ---- amount hunt (PaymentIntents — includes declined attempts) ----

async function amountHunt(ctx: DashboardCtx, deps: { hunts: FraudHuntService }, filters: Record<string, string>): Promise<Block[]> {
  const amountRaw = str(filters.amount, 20);
  const currency = str(filters.currency, 3);
  const blocks: Block[] = [];
  const table: TableBlock = {
    type: "table",
    key: "amthunt",
    title: "Payment attempts by amount",
    filters: [
      { key: "amount", label: "Amount", kind: "text", value: amountRaw || undefined, placeholder: "25.39" },
      { key: "currency", label: "Currency", kind: "text", value: currency || undefined, placeholder: "eur (blank = any)" },
    ],
    columns: [
      { key: "amount", label: "Amount" },
      { key: "customer", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "card", label: "Card" },
      { key: "created", label: "When" },
      { key: "reason", label: "Failure reason" },
    ],
    rows: [],
    empty: amountRaw
      ? "No payment attempts for that amount (declined ones included). Different currency, or a different Stripe account?"
      : "Enter the exact amount the customer sees on their statement — declined and issuer-blocked attempts show up here.",
    notice: `Searches PaymentIntents, so DECLINED / incomplete attempts are included — the ones charge searches are blind to. ${SEARCH_LAG_NOTICE}`,
  };
  if (amountRaw) {
    const result = await deps.hunts.paymentsByAmount(amountRaw, currency || undefined);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      table.rows = result.rows.map((r) => {
        const badge: Badge =
          r.status === "succeeded" ? { kind: "ok", text: "Succeeded" } : r.status === "canceled" ? { kind: "neutral", text: "Canceled" } : { kind: "error", text: sentence(r.status.replace(/_/g, " ")) };
        return {
          id: r.id,
          ref: { page: "payments.detail", params: { id: r.id } },
          cells: [
            amount(ctx.stripe, r.amount, r.currency, badge),
            r.customerId ? idCell(r.customerId, { ref: { page: "customers.detail", params: { id: r.customerId } } }) : text("—"),
            text(r.email ?? "—"),
            r.cardBrand ? cardCell(r.cardBrand, r.cardLast4 ?? "") : text("—"),
            dateCell(r.created),
            text(r.failureReason ?? "—"),
          ] as Cell[],
        };
      });
      table.footer = `${result.rows.length} attempt${result.rows.length === 1 ? "" : "s"}${result.hasMore ? " — more exist" : ""}`;
    }
  }
  blocks.push(table);
  return blocks;
}
