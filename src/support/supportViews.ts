import type Stripe from "stripe";
import type { BillingActionService } from "../bot/billing/actions/BillingActionService";
import type { ActionActor } from "../bot/billing/actions/ActionRegistry";
import { CUSTOMER_UPDATE_DETAILS } from "../bot/billing/actions/ActionRegistry";
import { REQUESTER_STATUS_GROUPS, type ApprovalStore, type BillingApproval } from "../bot/billing/ApprovalStore";
import {
  type CustomerDetails,
  type DetailField,
  FIELD_LABEL,
  changedFields,
  detailsOf,
  fieldList,
  fieldValue,
  parseDetailsInput,
  parseStoredDetails,
} from "../bot/billing/customerDetails";
import type { ActionButton, Badge, Cell, InputField, TableBlock } from "../dashboard/renderer/contract";
import { amount, cardCell, chargeBadge, dateCell, idCell, invoiceBadge, isoDateCell, text, type AmountFormatter } from "../dashboard/sections/cells";
import { countryName, countryOptions } from "../dashboard/sections/countries";
import { log } from "../util/logger";
import type { SupportActor } from "./SupportAuth";
import type { CustomerSnapshot, LookupHit, PlanSummary, SupportData } from "./SupportData";
import { planOf } from "./SupportData";
import type { LookupVia, SupportLookupLog } from "./SupportStores";
import type { SupportActionResult, SupportBlock, SupportPageView, SupportViewRequest } from "./contract";

const viewLog = log.child("support:views");

const PAGE_SIZE = 10;
const LOOKUP_CACHE_MS = 60_000;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]{1,64}$/;

type LookupBy = "" | "customer" | "postiz" | "card";

interface LookupEntry {
  at: number;
  hits: LookupHit[];
  cards?: Map<string, Stripe.Charge>;
  plans: Map<string, PlanSummary | null>;
}

export interface SupportViewsDeps {
  data: SupportData;
  approvals: ApprovalStore;
  actions: BillingActionService;
  lookups: SupportLookupLog;
  money: AmountFormatter;
  now?: () => number;
}

export class SupportViews {
  private lookupCache = new Map<string, LookupEntry>();
  // One request in flight per customer: the one-at-a-time check and the insert
  // must not interleave.
  private requesting = new Set<string>();
  private now: () => number;

  constructor(private deps: SupportViewsDeps) {
    this.now = deps.now ?? Date.now;
  }

  async build(actor: SupportActor, req: SupportViewRequest): Promise<SupportPageView | null> {
    switch (req.page) {
      case "lookup":
        return this.page(actor, "lookup", "Look up", [], await this.lookupBlocks(req));
      case "customer":
        return this.customerPage(actor, req);
      case "requests":
        return this.page(actor, "requests", "My requests", [], await this.requestBlocks(actor, req));
      default:
        return null;
    }
  }

  private async page(
    actor: SupportActor,
    activeNav: string,
    title: string,
    crumbs: SupportPageView["crumbs"],
    blocks: SupportBlock[]
  ): Promise<SupportPageView> {
    const mine = await this.deps.approvals.countByRequesterStatus("support", actor.id).catch(() => ({}) as Record<string, number>);
    const pending = REQUESTER_STATUS_GROUPS.pending.reduce((n, s) => n + (mine[s] ?? 0), 0);
    return {
      page: activeNav,
      title,
      crumbs,
      nav: [
        { key: "lookup", label: "Look up", page: "lookup" },
        { key: "requests", label: "My requests", page: "requests", ...(pending ? { badge: String(pending) } : {}) },
      ],
      activeNav,
      blocks,
      actorLabel: actor.name,
    };
  }

  // ---- Look up ----

  private async lookupBlocks(req: SupportViewRequest): Promise<SupportBlock[]> {
    const f = req.filters;
    const by: LookupBy = f.by === "customer" || f.by === "postiz" || f.by === "card" ? f.by : "";
    const blocks: SupportBlock[] = [
      { type: "header", title: "Look up" },
      {
        type: "tabs",
        key: "by",
        value: by,
        items: [
          { value: "", label: "Email" },
          { value: "customer", label: "Customer ID" },
          { value: "postiz", label: "Postiz" },
          { value: "card", label: "Card" },
        ],
      },
    ];
    if (by === "card") {
      blocks.push({
        type: "searchform",
        submitLabel: "Search",
        fields: [
          { key: "l4", label: "Last 4", value: f.l4 ?? "", placeholder: "4242", mono: true, narrow: true },
          { key: "exp", label: "Expiry", value: f.exp ?? "", placeholder: "MM/YY", mono: true, narrow: true },
        ],
      });
    } else {
      const field =
        by === "customer"
          ? { key: "q", label: "Customer ID", placeholder: "cus_", mono: true }
          : by === "postiz"
            ? { key: "q", label: "Org ID, user ID or email" }
            : { key: "q", label: "Email", placeholder: "name@example.com" };
      blocks.push({ type: "searchform", submitLabel: "Search", fields: [{ ...field, value: f.q ?? "" }] });
    }

    const ready = by === "card" ? !!(f.l4 || f.exp) : !!f.q;
    if (!ready) return blocks;

    const key = JSON.stringify([by, f.q ?? "", f.l4 ?? "", f.exp ?? ""]);
    const cached = this.lookupCache.get(key);
    let entry: LookupEntry;
    if (cached && this.now() - cached.at <= LOOKUP_CACHE_MS) {
      entry = cached;
    } else {
      const outcome =
        by === "card"
          ? await this.deps.data.lookupCard(f.l4 ?? "", f.exp ?? "")
          : by === "customer"
            ? await this.deps.data.lookupCustomerId(f.q ?? "")
            : by === "postiz"
              ? await this.deps.data.lookupPostiz(f.q ?? "")
              : await this.deps.data.lookupEmail(f.q ?? "");
      if (!outcome.ok) {
        blocks.push({ type: "notice", badge: { kind: "warn", text: "Check the search" }, text: outcome.error });
        return blocks;
      }
      const cards = "lastCharge" in outcome ? (outcome.lastCharge as Map<string, Stripe.Charge> | undefined) : undefined;
      entry = { at: this.now(), hits: outcome.hits, cards, plans: new Map() };
      this.lookupCache.set(key, entry);
      if (this.lookupCache.size > 200) {
        const oldest = this.lookupCache.keys().next().value;
        if (oldest !== undefined) this.lookupCache.delete(oldest);
      }
    }

    const offset = offsetOf(req.cursor);
    const slice = entry.hits.slice(offset, offset + PAGE_SIZE);
    const missing = slice.map((h) => h.customerId).filter((id) => !entry.plans.has(id));
    if (missing.length) for (const [id, plan] of await this.deps.data.plans(missing)) entry.plans.set(id, plan);

    const total = entry.hits.length;
    const cards = entry.cards;
    const via: LookupVia = by === "" ? "email" : by;
    blocks.push({
      type: "table",
      key: "results",
      title: `${total} customer${total === 1 ? "" : "s"}`,
      columns: [
        { key: "customer", label: "Customer" },
        { key: "id", label: "Customer ID" },
        { key: "plan", label: "Plan" },
        { key: "found", label: by === "card" ? "Last charge on this card" : "Found by" },
      ],
      rows: slice.map((h) => {
        const plan = entry.plans.get(h.customerId) ?? null;
        const charge = cards?.get(h.customerId);
        return {
          id: h.customerId,
          ref: { page: "customer", params: { id: h.customerId }, filters: { via } },
          cells: [
            { t: "text", v: h.name || h.email || h.customerId, strong: true, ...(h.name && h.email ? { sub: h.email } : {}) },
            idCell(h.customerId, { copy: true }),
            plan ? ({ t: "badge", b: { kind: plan.badge.kind, text: plan.ended ? plan.badge.text : plan.label } } as Cell) : text("None"),
            charge
              ? text(`${cardBrand(charge.payment_method_details?.card?.brand)}, ${shortDate(charge.created)}`)
              : text(h.foundBy),
          ] as Cell[],
        };
      }),
      empty: "No customers found.",
      nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
      ...(total > PAGE_SIZE ? { footer: rangeFooter(offset, slice.length, total) } : {}),
    });
    return blocks;
  }

  // ---- the customer ----

  private async customerPage(actor: SupportActor, req: SupportViewRequest): Promise<SupportPageView | null> {
    const id = req.params.id ?? "";
    if (!CUSTOMER_ID_RE.test(id)) return null;
    const crumbs = [{ label: "Look up", ref: { page: "lookup" } }, { label: id }];
    const snap = await this.deps.data.customer(id);
    if (!snap) {
      return this.page(actor, "lookup", "Customer", crumbs, [
        { type: "header", title: "Customer not found" },
        { type: "empty", title: "Stripe has no customer with this ID." },
      ]);
    }
    const via = (["email", "customer", "postiz", "card"] as const).find((v) => v === req.filters.via) ?? "link";
    void this.deps.lookups
      .record({ discordUserId: actor.id, actorName: actor.name, customerId: id, customerName: snap.customer.name ?? snap.customer.email ?? null, via })
      .catch((e) => viewLog.warn("lookup log failed", { "error.message": e instanceof Error ? e.message : String(e) }));

    const details = detailsOf(snap.customer, snap.taxIds);
    const plan = planOf(snap.subs);
    const pending = await this.deps.approvals.findActionableFor(CUSTOMER_UPDATE_DETAILS, id);
    const blocks: SupportBlock[] = [];
    const title = snap.customer.name || snap.customer.email || id;

    const org = snap.postiz.orgs.find((o) => o.customerMatches !== false && !o.orgDeleted) ?? null;
    const meta: Array<{ label: string; value: string }> = [];
    if (plan) {
      meta.push({ label: "Plan", value: plan.label });
      if (plan.renews) meta.push({ label: "Renews", value: shortDate(plan.renews) });
      else if (plan.cancelsAt) meta.push({ label: "Cancels", value: shortDate(plan.cancelsAt) });
    }
    if (org) {
      meta.push({ label: "Postiz org", value: org.orgName || org.orgId });
      if (org.ownerEmail) meta.push({ label: "Owner", value: org.ownerEmail });
    }

    blocks.push({
      type: "header",
      title,
      ...(plan ? { badges: [plan.badge] } : {}),
      ...(snap.customer.email && snap.customer.email !== title ? { sub: snap.customer.email } : {}),
      ...(meta.length ? { meta } : {}),
      actions: [this.requestButton(id, title, details, pending)],
    });

    blocks.push({
      type: "strip",
      title: "Billing details",
      items: [
        { label: "Name", value: details.name || "None" },
        { label: "Address", value: addressWithCountry(details) || "None" },
        { label: "VAT ID", value: details.vat?.value || "None", mono: !!details.vat },
      ],
    });

    const change = pending ? changeOf(pending) : null;
    if (pending && change) {
      blocks.push({
        type: "change",
        title: "Change waiting for approval",
        badge: { kind: "warn", text: "Pending" },
        who: pending.requestedByName,
        iso: pending.createdAt.toISOString(),
        ...(change.reason ? { note: change.reason } : {}),
        columns: ["Field", "Now", "Requested"],
        rows: change.fields.map((f) => ({ label: FIELD_LABEL[f], now: fieldValue(change.before, f), next: fieldValue(change.after, f) })),
        ...(pending.requestedById === actor.id && pending.status !== "EXECUTING"
          ? { actions: [{ key: "withdraw", label: "Withdraw", params: { id: pending.id }, confirm: true, submitLabel: "Withdraw", summary: "Take this change request back." }] }
          : {}),
      });
    }

    const tab = req.filters.tab === "charges" ? "charges" : "";
    blocks.push({
      type: "tabs",
      key: "tab",
      value: tab,
      items: [
        { value: "", label: "Invoices", badge: countLabel(snap.invoices.length, snap.invoicesMore) },
        { value: "charges", label: "Charges", badge: countLabel(snap.charges.length, snap.chargesMore) },
      ],
    });
    blocks.push(tab === "charges" ? this.chargesTable(snap, req.cursor) : this.invoicesTable(snap, req.cursor));

    return this.page(actor, "lookup", title, crumbs, blocks);
  }

  private requestButton(customerId: string, customerName: string, d: CustomerDetails, pending: BillingApproval | null): ActionButton {
    const button: ActionButton = { key: "request_change", label: "Request change" };
    if (pending) return { ...button, disabledReason: "A change is already waiting for approval." };
    const inputs: InputField[] = [
      { type: "text", key: "name", label: "Name or company", value: d.name, maxLength: 256 },
      { type: "text", key: "line1", label: "Street", value: d.line1, maxLength: 200 },
      { type: "text", key: "line2", label: "Line 2", value: d.line2, maxLength: 200 },
      { type: "text", key: "postal", label: "Postal code", value: d.postal, maxLength: 40, half: true },
      { type: "text", key: "city", label: "City", value: d.city, maxLength: 200, half: true },
      { type: "text", key: "state", label: "State or region", value: d.state, maxLength: 200, half: true },
      { type: "select", key: "country", label: "Country", value: d.country, options: [{ value: "", label: "None" }, ...countryOptions()], half: true },
      { type: "text", key: "vat", label: "VAT ID", value: d.vat?.value ?? "", maxLength: 40, mono: true },
      { type: "text", key: "reason", label: "Reason", multiline: true, rows: 3, maxLength: 500 },
      { type: "text", key: "intercomRef", label: "Intercom link or ticket ID (optional)", maxLength: 300 },
    ];
    return {
      ...button,
      submitLabel: "Send for approval",
      summary: customerName,
      params: { customerId, seen: d },
      inputs,
    };
  }

  private invoicesTable(snap: CustomerSnapshot, cursor: string | null): TableBlock {
    const offset = offsetOf(cursor);
    const rows = snap.invoices.slice(offset, offset + PAGE_SIZE);
    const total = snap.invoices.length;
    return {
      type: "table",
      key: "invoices",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "number", label: "Number" },
        { key: "status", label: "Status" },
        { key: "date", label: "Date" },
      ],
      rows: rows.map((inv) => ({
        id: inv.id,
        cells: [
          amount(this.deps.money, inv.total ?? 0, inv.currency),
          inv.number ? idCell(inv.number) : text("None"),
          { t: "badge", b: invoiceBadge(inv.status) },
          dateCell(inv.created),
        ] as Cell[],
      })),
      empty: "No invoices.",
      nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
      ...(total ? { footer: rangeFooter(offset, rows.length, total, snap.invoicesMore) } : {}),
    };
  }

  private chargesTable(snap: CustomerSnapshot, cursor: string | null): TableBlock {
    const offset = offsetOf(cursor);
    const rows = snap.charges.slice(offset, offset + PAGE_SIZE);
    const total = snap.charges.length;
    return {
      type: "table",
      key: "charges",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "status", label: "Status" },
        { key: "card", label: "Card" },
        { key: "date", label: "Date" },
      ],
      rows: rows.map((ch) => {
        const card = ch.payment_method_details?.card;
        const badge = chargeBadge(ch);
        return {
          id: ch.id,
          cells: [
            amount(this.deps.money, ch.amount, ch.currency),
            { t: "badge", b: badge.text === "Partial refund" ? { kind: "info", text: "Partially refunded" } : badge },
            card ? cardCell(card.brand ?? "", card.last4 ?? "") : text(sentenceType(ch.payment_method_details?.type)),
            dateCell(ch.created),
          ] as Cell[],
        };
      }),
      empty: "No charges.",
      nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
      ...(total ? { footer: rangeFooter(offset, rows.length, total, snap.chargesMore) } : {}),
    };
  }

  // ---- My requests ----

  private async requestBlocks(actor: SupportActor, req: SupportViewRequest): Promise<SupportBlock[]> {
    const groupKey = req.filters.status ?? "";
    const group = groupKey in REQUESTER_STATUS_GROUPS ? groupKey : null;
    const offset = offsetOf(req.cursor);
    const [counts, list] = await Promise.all([
      this.deps.approvals.countByRequesterStatus("support", actor.id),
      this.deps.approvals.listByRequester("support", actor.id, group, offset, PAGE_SIZE),
    ]);
    const sum = (g: string) => REQUESTER_STATUS_GROUPS[g].reduce((n, s) => n + (counts[s] ?? 0), 0);
    const all = Object.values(counts).reduce((n, c) => n + c, 0);
    return [
      { type: "header", title: "My requests" },
      {
        type: "table",
        key: "requests",
        counts: {
          key: "status",
          items: [
            { value: "", label: "All", count: all },
            { value: "pending", label: "Pending", count: sum("pending") },
            { value: "approved", label: "Approved", count: sum("approved") },
            { value: "rejected", label: "Rejected", count: sum("rejected") },
            { value: "closed", label: "Expired or refused", count: sum("closed") },
          ],
        },
        columns: [
          { key: "customer", label: "Customer" },
          { key: "change", label: "Change" },
          { key: "status", label: "Status" },
          { key: "requested", label: "Requested" },
          { key: "outcome", label: "Outcome" },
        ],
        rows: list.rows.map((a) => {
          const p = paramsOf(a);
          const change = changeOf(a);
          const customerId = a.stripeCustomerId ?? "";
          const name = (typeof p?.customerName === "string" && p.customerName) || customerId || "Unknown";
          const open = a.status === "PENDING" || a.status === "FAILED";
          return {
            id: a.id,
            cells: [
              CUSTOMER_ID_RE.test(customerId) ? ({ t: "link", v: name, ref: { page: "customer", params: { id: customerId } } } as Cell) : text(name),
              text(change ? fieldList(change.fields) : a.summary),
              { t: "badge", b: statusBadge(a.status) },
              isoDateCell(a.createdAt),
              text(outcomeText(a)),
            ] as Cell[],
            ...(open
              ? { actions: [{ key: "withdraw", label: "Withdraw", params: { id: a.id }, confirm: true, submitLabel: "Withdraw", summary: a.summary }] }
              : {}),
          };
        }),
        empty: group ? "No requests here." : "No requests yet.",
        nextCursor: offset + PAGE_SIZE < list.total ? String(offset + PAGE_SIZE) : null,
        ...(list.total > PAGE_SIZE ? { footer: rangeFooter(offset, list.rows.length, list.total) } : {}),
      },
    ];
  }

  // ---- actions ----

  async action(actor: SupportActor, key: string, params: Record<string, unknown>): Promise<SupportActionResult> {
    const who: ActionActor = { kind: "support", id: actor.id, name: actor.name, isAdmin: false };
    if (key === "withdraw") {
      const id = typeof params.id === "string" && /^[a-z0-9]{10,40}$/i.test(params.id) ? params.id : null;
      if (!id) return { ok: false, error: "Bad request." };
      const res = await this.deps.actions.withdraw(id, who);
      if (!res.ok) return res;
      const row = await this.deps.approvals.get(id);
      if (row?.stripeCustomerId) this.deps.data.invalidate(row.stripeCustomerId);
      return { ok: true, text: "Request withdrawn." };
    }
    if (key !== "request_change") return { ok: false, error: "Unknown action." };

    const customerId = typeof params.customerId === "string" && CUSTOMER_ID_RE.test(params.customerId) ? params.customerId : null;
    if (!customerId) return { ok: false, error: "Bad request." };
    if (this.requesting.has(customerId)) return { ok: false, error: "Another request for this customer is being sent." };
    this.requesting.add(customerId);
    try {
      const snap = await this.deps.data.customer(customerId, { fresh: true });
      if (!snap) return { ok: false, error: "That customer no longer exists." };
      const before = detailsOf(snap.customer, snap.taxIds);
      // The dialog opened on what the page showed. If Stripe changed since,
      // the teammate's untouched fields would quietly undo someone's edit.
      const seen = parseStoredDetails(params.seen);
      if (!seen || changedFields(seen, before).length) {
        return { ok: false, error: "The billing details changed while the dialog was open. Reload the page and try again." };
      }
      const parsed = parseDetailsInput(params, before.vat);
      if (!parsed.ok) return { ok: false, error: parsed.error, ...(parsed.field ? { fieldErrors: { [parsed.field]: parsed.error } } : {}) };
      const after = parsed.value;
      if (changedFields(before, after).length === 0) return { ok: false, error: "Nothing changed." };
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (reason.length < 3 || reason.length > 500) return { ok: false, error: "Say why the customer needs this change.", fieldErrors: { reason: "Required." } };
      const intercomRef = typeof params.intercomRef === "string" ? params.intercomRef.trim().slice(0, 300) : "";

      if (await this.deps.approvals.findActionableFor(CUSTOMER_UPDATE_DETAILS, customerId)) {
        return { ok: false, error: "A change for this customer is already waiting for approval." };
      }
      const outcome = await this.deps.actions.requestScoped(
        { stripeCustomerId: customerId, discordCustomerId: null, ticketThreadId: null, conversationId: null, origin: "support" },
        who,
        CUSTOMER_UPDATE_DETAILS,
        { customerId, before, after, reason, intercomRef: intercomRef || null, customerName: snap.customer.name ?? snap.customer.email ?? null }
      );
      this.deps.data.invalidate(customerId);
      if (outcome.kind === "queued") return { ok: true, queued: true, text: "Sent for approval." };
      if (outcome.kind === "denied") return { ok: false, error: "Detail change requests are switched off (/config → Billing → Intercom Actions)." };
      if (outcome.kind === "executed") return { ok: true, text: outcome.text };
      return { ok: false, error: outcome.error };
    } finally {
      this.requesting.delete(customerId);
    }
  }
}

// ---- helpers ----

function offsetOf(cursor: string | null): number {
  return cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0;
}

function rangeFooter(offset: number, shown: number, total: number, more = false): string {
  if (!shown) return `${total}${more ? "+" : ""} items`;
  return `${offset + 1}-${offset + shown} of ${total}${more ? "+" : ""} items`;
}

function countLabel(n: number, more: boolean): string {
  return `${n}${more ? "+" : ""}`;
}

function shortDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function cardBrand(brand: string | null | undefined): string {
  const b = (brand ?? "").toLowerCase();
  const map: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", jcb: "JCB", unionpay: "UnionPay", diners: "Diners" };
  return map[b] ?? (b ? b.charAt(0).toUpperCase() + b.slice(1) : "Card");
}

function sentenceType(type: string | null | undefined): string {
  if (!type) return "None";
  const s = type.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function addressWithCountry(d: CustomerDetails): string {
  return [d.line1, d.line2, [d.postal, d.city].filter(Boolean).join(" "), d.state, countryName(d.country)].filter(Boolean).join(", ");
}

function paramsOf(a: BillingApproval): Record<string, unknown> | null {
  return a.paramsJson && typeof a.paramsJson === "object" && !Array.isArray(a.paramsJson) ? (a.paramsJson as Record<string, unknown>) : null;
}

function changeOf(a: BillingApproval): { before: CustomerDetails; after: CustomerDetails; fields: DetailField[]; reason: string } | null {
  const p = paramsOf(a);
  const before = p ? parseStoredDetails(p.before) : null;
  const after = p ? parseStoredDetails(p.after) : null;
  if (!before || !after) return null;
  return { before, after, fields: changedFields(before, after), reason: typeof p?.reason === "string" ? p.reason : "" };
}

function statusBadge(status: string): Badge {
  switch (status) {
    case "EXECUTED":
      return { kind: "ok", text: "Approved" };
    case "REJECTED":
      return { kind: "error", text: "Rejected" };
    case "EXPIRED":
      return { kind: "neutral", text: "Expired" };
    case "REFUSED":
      return { kind: "neutral", text: "Refused, changed since" };
    case "WITHDRAWN":
      return { kind: "neutral", text: "Withdrawn" };
    default:
      return { kind: "warn", text: "Pending" };
  }
}

function outcomeText(a: BillingApproval): string {
  const when = a.resolvedAt ? shortDate(Math.floor(a.resolvedAt.getTime() / 1000)) : "";
  switch (a.status) {
    case "EXECUTED":
      return [a.reviewerName, when].filter(Boolean).join(", ");
    case "REJECTED":
      return a.reviewNote ? `${a.reviewerName ?? "Admin"}: ${a.reviewNote}` : [a.reviewerName, when].filter(Boolean).join(", ");
    case "REFUSED":
      return a.errorText ?? "The customer changed since the request.";
    case "EXPIRED":
      return "No decision within 7 days";
    case "WITHDRAWN":
      return "You withdrew it";
    case "FAILED":
      return `Stripe refused it, an admin can retry: ${(a.errorText ?? "").slice(0, 120)}`;
    default:
      return "Waiting for an admin";
  }
}
