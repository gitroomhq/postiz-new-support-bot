import type Stripe from "stripe";
import { StripeClient } from "../bot/StripeClient";
import type { BillingActionService, RequestOutcome } from "../bot/billing/actions/BillingActionService";
import type { ActionActor } from "../bot/billing/actions/ActionRegistry";
import { CUSTOMER_UPDATE_DETAILS } from "../bot/billing/actions/ActionRegistry";
import type { ApprovalStore, BillingApproval } from "../bot/billing/ApprovalStore";
import {
  type CustomerDetails,
  type DetailField,
  FIELD_LABEL,
  changedFields,
  detailsOf,
  fieldPhrase,
  fieldValue,
  parseDetailsInput,
  parseStoredDetails,
} from "../bot/billing/customerDetails";
import { describeSuppression, originLabel, type DeliveryStatus, type EmailDeliverabilityService } from "../resend/EmailDeliverabilityService";
import type { ActionButton, Badge, Cell, InputField, TableBlock } from "../dashboard/renderer/contract";
import { amount, cardCell, chargeBadge, dateCell, idCell, invoiceBadge, isoDateCell, text, type AmountFormatter } from "../dashboard/sections/cells";
import { countryName, countryOptions } from "../dashboard/sections/countries";
import { log } from "../util/logger";
import type { SupportActor } from "./SupportAuth";
import type { ChargeLookupOutcome, CustomerSnapshot, LookupHit, PlanSummary, SupportData } from "./SupportData";
import { liveSubs, planOf } from "./SupportData";
import { ACTIVITY_GROUPS, type LookupVia, type SupportActionKind, type SupportActionLog, type SupportLookupLog } from "./SupportStores";
import type { StripBlock, SupportActionResult, SupportBlock, SupportPageView, SupportViewRequest } from "./contract";

const viewLog = log.child("support:views");

const PAGE_SIZE = 10;
const LOOKUP_CACHE_MS = 60_000;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]{1,64}$/;
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9]{1,64}$/;
const SUB_ID_RE = /^sub_[A-Za-z0-9]{1,64}$/;

// Registry actions support runs. A support refund is always a partial refund
// in the registry (a full one is the whole remainder): the full-refund action
// goes through the Discord refund core, which always cancels.
const REFUND_KEY = "charge.refund_partial";
const CANCEL_KEY = "subscription.cancel";

type LookupBy = "" | "customer" | "postiz" | "card" | "reference";
const LOOKUP_BY: LookupBy[] = ["customer", "postiz", "card", "reference"];
const VIA: LookupVia[] = ["email", "customer", "postiz", "card", "reference", "recent"];

interface LookupEntry {
  at: number;
  hits: LookupHit[];
  charges?: Map<string, Stripe.Charge>;
  window?: { from: number; to: number };
  plans: Map<string, PlanSummary | null>;
}

export interface SupportViewsDeps {
  data: SupportData;
  approvals: ApprovalStore;
  actions: BillingActionService;
  lookups: SupportLookupLog;
  activity: SupportActionLog;
  settings: { supportDashApproval(): boolean };
  // Resend suppression status and removal; absent or off hides it.
  email?: EmailDeliverabilityService | null;
  money: AmountFormatter;
  now?: () => number;
}

interface Why {
  reason: string;
  intercomRef: string | null;
}

export class SupportViews {
  private lookupCache = new Map<string, LookupEntry>();
  // One action in flight per customer: the checks and the write must not
  // interleave with a second press.
  private busy = new Set<string>();
  private now: () => number;

  constructor(private deps: SupportViewsDeps) {
    this.now = deps.now ?? Date.now;
  }

  async build(actor: SupportActor, req: SupportViewRequest): Promise<SupportPageView | null> {
    switch (req.page) {
      case "lookup":
        return this.page(actor, "lookup", "Look up", [], await this.lookupBlocks(actor, req));
      case "customer":
        return this.customerPage(actor, req);
      // "requests" was this page's name before it listed every action.
      case "activity":
      case "requests":
        return this.page(actor, "activity", "My activity", [], await this.activityBlocks(actor, req));
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
    const counts = await this.deps.activity.counts(actor.id).catch(() => ({}) as Record<string, number>);
    const pending = counts.pending ?? 0;
    return {
      page: activeNav,
      title,
      crumbs,
      nav: [
        { key: "lookup", label: "Look up", page: "lookup" },
        { key: "activity", label: "My activity", page: "activity", ...(pending ? { badge: String(pending) } : {}) },
      ],
      activeNav,
      blocks,
      actorLabel: actor.name,
    };
  }

  // ---- Look up ----

  private async lookupBlocks(actor: SupportActor, req: SupportViewRequest): Promise<SupportBlock[]> {
    const f = req.filters;
    const by: LookupBy = LOOKUP_BY.find((b) => b === f.by) ?? "";
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
          { value: "reference", label: "Reference" },
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
    } else if (by === "reference") {
      blocks.push({
        type: "searchform",
        submitLabel: "Search",
        fields: [
          { key: "ref", label: "Bank reference", value: f.ref ?? "", placeholder: "FT26307B8P5M", mono: true },
          { key: "l4", label: "Last 4", value: f.l4 ?? "", placeholder: "4242", mono: true, narrow: true },
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

    const ready = by === "card" ? !!(f.l4 || f.exp) : by === "reference" ? !!(f.ref || f.l4) : !!f.q;
    if (!ready) return [...blocks, ...(await this.recentBlocks(actor, req.cursor))];

    const key = JSON.stringify([by, f.q ?? "", f.l4 ?? "", f.exp ?? "", f.ref ?? ""]);
    const cached = this.lookupCache.get(key);
    let entry: LookupEntry;
    if (cached && this.now() - cached.at <= LOOKUP_CACHE_MS) {
      entry = cached;
    } else {
      const outcome: ChargeLookupOutcome =
        by === "card"
          ? await this.deps.data.lookupCard(f.l4 ?? "", f.exp ?? "")
          : by === "reference"
            ? await this.deps.data.lookupReference(f.ref ?? "", f.l4 ?? "")
            : by === "customer"
              ? await this.deps.data.lookupCustomerId(f.q ?? "")
              : by === "postiz"
                ? await this.deps.data.lookupPostiz(f.q ?? "")
                : await this.deps.data.lookupEmail(f.q ?? "");
      if (!outcome.ok) {
        blocks.push({ type: "notice", badge: { kind: "warn", text: "Check the search" }, text: outcome.error });
        return blocks;
      }
      entry = { at: this.now(), hits: outcome.hits, charges: outcome.charges, window: outcome.window, plans: new Map() };
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
    const charges = entry.charges;
    const via: LookupVia = by === "" ? "email" : by;
    const win = entry.window;
    blocks.push({
      type: "table",
      key: "results",
      title: `${total} customer${total === 1 ? "" : "s"}` + (win ? `, charged ${shortDate(win.from)} to ${shortDate(win.to - 1)}` : ""),
      columns: [
        { key: "customer", label: "Customer" },
        { key: "id", label: "Customer ID" },
        { key: "plan", label: "Plan" },
        { key: "found", label: by === "card" ? "Last charge on this card" : by === "reference" ? "Charge" : "Found by" },
      ],
      rows: slice.map((h) => {
        const charge = charges?.get(h.customerId);
        return {
          id: h.customerId,
          ref: { page: "customer", params: { id: h.customerId }, filters: { via } },
          cells: [
            { t: "text", v: h.name || h.email || h.customerId, strong: true, ...(h.name && h.email ? { sub: h.email } : {}) },
            idCell(h.customerId, { copy: true }),
            planCell(entry.plans.get(h.customerId) ?? null),
            charge
              ? text(
                  by === "reference"
                    ? `${this.deps.money.formatAmount(charge.amount, charge.currency)}, ${shortDate(charge.created)}`
                    : `${cardBrand(charge.payment_method_details?.card?.brand)}, ${shortDate(charge.created)}`
                )
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

  // The customers this teammate opened lately, under an empty search.
  private async recentBlocks(actor: SupportActor, cursor: string | null): Promise<SupportBlock[]> {
    const offset = offsetOf(cursor);
    const recent = await this.deps.lookups.recentCustomers(actor.id, offset, PAGE_SIZE).catch((e) => {
      viewLog.warn("recent lookups failed", { "error.message": e instanceof Error ? e.message : String(e) });
      return { rows: [], total: 0 };
    });
    if (!recent.total) return [];
    const ids = recent.rows.map((r) => r.customerId);
    const [briefs, plans] = await Promise.all([this.deps.data.brief(ids), this.deps.data.plans(ids)]);
    const byId = new Map(briefs.map((b) => [b.customerId, b]));
    return [
      {
        type: "table",
        key: "recent",
        title: "Recently opened",
        columns: [
          { key: "customer", label: "Customer" },
          { key: "id", label: "Customer ID" },
          { key: "plan", label: "Plan" },
          { key: "opened", label: "Opened" },
        ],
        rows: recent.rows.map((r) => {
          const b = byId.get(r.customerId);
          const name = b?.name || r.customerName || b?.email || r.customerId;
          return {
            id: r.customerId,
            ref: { page: "customer", params: { id: r.customerId }, filters: { via: "recent" } },
            cells: [
              { t: "text", v: name, strong: true, ...(b?.email && b.email !== name ? { sub: b.email } : {}) },
              idCell(r.customerId, { copy: true }),
              planCell(plans.get(r.customerId) ?? null),
              isoDateCell(r.openedAt),
            ] as Cell[],
          };
        }),
        empty: "",
        nextCursor: offset + PAGE_SIZE < recent.total ? String(offset + PAGE_SIZE) : null,
        ...(recent.total > PAGE_SIZE ? { footer: rangeFooter(offset, recent.rows.length, recent.total) } : {}),
      },
    ];
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
    const via = VIA.find((v) => v === req.filters.via) ?? "link";
    void this.deps.lookups
      .record({ discordUserId: actor.id, actorName: actor.name, customerId: id, customerName: snap.customer.name ?? snap.customer.email ?? null, via })
      .catch((e) => viewLog.warn("lookup log failed", { "error.message": e instanceof Error ? e.message : String(e) }));

    const who = actorOf(actor);
    const queue = this.deps.settings.supportDashApproval();
    const details = detailsOf(snap.customer, snap.taxIds);
    const plan = planOf(snap.subs);
    const live = liveSubs(snap.subs);
    const [pending, refundRequests, cancelRequests, delivery] = await Promise.all([
      this.deps.approvals.findActionableFor(CUSTOMER_UPDATE_DETAILS, id),
      this.deps.approvals.listActionableFor(REFUND_KEY, id).catch(() => [] as BillingApproval[]),
      this.deps.approvals.listActionableFor(CANCEL_KEY, id).catch(() => [] as BillingApproval[]),
      this.deliveryFor(snap),
    ]);
    const blocks: SupportBlock[] = [];
    const title = snap.customer.name || snap.customer.email || id;

    const meta: Array<{ label: string; value: string }> = [];
    if (plan) {
      meta.push({ label: "Plan", value: plan.label });
      if (plan.renews) meta.push({ label: "Renews", value: shortDate(plan.renews) });
      else if (plan.cancelsAt) meta.push({ label: "Cancels", value: shortDate(plan.cancelsAt) });
    }

    const canCancel = this.allowed(CANCEL_KEY, who);
    const actions: ActionButton[] = [];
    if (canCancel && plan && !plan.ended) actions.push(...this.subscriptionButtons(id, plan, live.length, cancelRequests.length > 0, queue));
    if (this.allowed(CUSTOMER_UPDATE_DETAILS, who)) actions.push(this.detailsButton(id, title, details, pending, queue));

    blocks.push({
      type: "header",
      title,
      ...(plan ? { badges: [plan.badge] } : {}),
      ...(snap.customer.email && snap.customer.email !== title ? { sub: snap.customer.email } : {}),
      ...(meta.length ? { meta } : {}),
      ...(actions.length ? { actions } : {}),
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

    const postiz = this.postizStrip(snap, delivery);
    if (postiz) blocks.push(postiz);

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
    if (tab === "charges") {
      const refundCtx = this.allowed(REFUND_KEY, who)
        ? {
            customerId: id,
            queue,
            waiting: new Set(refundRequests.map((a) => chargeIdOf(a)).filter((c): c is string => !!c)),
            // "Also cancel" needs one subscription to name and the cancel level.
            offerCancel: canCancel && live.length === 1 && cancelRequests.length === 0,
          }
        : null;
      blocks.push(this.chargesTable(snap, req.cursor, refundCtx));
    } else {
      blocks.push(this.invoicesTable(snap, req.cursor));
    }

    return this.page(actor, "lookup", title, crumbs, blocks);
  }

  private allowed(actionKey: string, who: ActionActor): boolean {
    return this.deps.actions.effectiveMode(actionKey, who) !== "denied";
  }

  private subscriptionButtons(customerId: string, plan: PlanSummary, liveCount: number, waiting: boolean, queue: boolean): ActionButton[] {
    const cancel: ActionButton = { key: "cancel_sub", label: "Cancel subscription", cancelLabel: "Close" };
    if (liveCount > 1) return [{ ...cancel, disabledReason: "This customer has more than one live subscription." }];
    if (waiting) return [{ ...cancel, disabledReason: "A cancellation is waiting for approval." }];
    const params = { customerId, subscriptionId: plan.subscriptionId };
    const submit = queue ? "Send for approval" : undefined;
    if (plan.cancelsAt) {
      const summary = `${plan.label}, cancels ${shortDate(plan.cancelsAt)}`;
      return [
        { ...cancel, label: "Cancel now", params: { ...params, when: "now" }, inputs: whyInputs(), submitLabel: submit ?? "Cancel now", summary },
        { key: "keep_sub", label: "Undo cancel", params, inputs: whyInputs(), submitLabel: submit ?? "Keep subscription", summary },
      ];
    }
    return [
      {
        ...cancel,
        params,
        inputs: [
          {
            type: "choice",
            key: "when",
            label: "When",
            value: "period_end",
            options: [
              { value: "period_end", label: plan.renews ? `At period end, ${shortDate(plan.renews)}` : "At period end" },
              { value: "now", label: "Now" },
            ],
          },
          ...whyInputs(),
        ],
        submitLabel: submit ?? "Cancel subscription",
        summary: plan.renews ? `${plan.label}, renews ${shortDate(plan.renews)}` : plan.label,
      },
    ];
  }

  private detailsButton(customerId: string, customerName: string, d: CustomerDetails, pending: BillingApproval | null, queue: boolean): ActionButton {
    const button: ActionButton = { key: "request_change", label: queue ? "Request change" : "Change details" };
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
      ...whyInputs(),
    ];
    return {
      ...button,
      submitLabel: queue ? "Send for approval" : "Save",
      summary: customerName,
      params: { customerId, seen: d },
      inputs,
    };
  }

  // Org, its ids and owner, and the suppression of the owner's or the
  // customer's address.
  private postizStrip(snap: CustomerSnapshot, delivery: DeliveryStatus[]): StripBlock | null {
    const customerId = snap.customer.id;
    const org = snap.postiz.orgs.find((o) => o.customerMatches !== false && !o.orgDeleted) ?? null;
    const statusOf = (email: string) => delivery.find((s) => s.email.toLowerCase() === email.toLowerCase()) ?? null;
    const items: StripBlock["items"] = [];
    if (org) {
      items.push({ label: "Organisation", value: org.orgName || "None" });
      items.push({ label: "Org ID", value: org.orgId, mono: true, copy: true });
      if (org.ownerEmail) items.push({ label: "Owner", value: org.ownerEmail, ...suppressionLine(customerId, statusOf(org.ownerEmail)) });
      if (org.ownerMembershipId) items.push({ label: "Impersonate id", value: org.ownerMembershipId, mono: true, copy: true });
    }
    const email = snap.customer.email;
    if (email && email.toLowerCase() !== org?.ownerEmail?.toLowerCase()) {
      const st = statusOf(email);
      if (st?.state === "suppressed") items.push({ label: "Customer email", value: email, ...suppressionLine(customerId, st) });
    }
    if (!items.length) return null;
    return { type: "strip", title: org ? "Postiz" : "Email", items };
  }

  private async deliveryFor(snap: CustomerSnapshot): Promise<DeliveryStatus[]> {
    const svc = this.deps.email;
    if (!svc?.enabled()) return [];
    return svc.statusFor(knownEmails(snap)).catch(() => []);
  }

  private invoicesTable(snap: CustomerSnapshot, cursor: string | null): TableBlock {
    const offset = offsetOf(cursor);
    const rows = snap.invoices.slice(offset, offset + PAGE_SIZE);
    const total = snap.invoices.length;
    return {
      type: "table",
      key: "invoices",
      inlineActions: true,
      columns: [
        { key: "amount", label: "Amount" },
        { key: "number", label: "Number" },
        { key: "status", label: "Status" },
        { key: "date", label: "Date" },
      ],
      rows: rows.map((inv) => {
        const actions: ActionButton[] = [];
        if (inv.hosted_invoice_url) actions.push({ key: "copy_link", label: "Copy link", copyText: inv.hosted_invoice_url });
        if (inv.invoice_pdf) actions.push({ key: "pdf", label: "PDF", href: inv.invoice_pdf });
        return {
          id: inv.id,
          cells: [
            amount(this.deps.money, inv.total ?? 0, inv.currency),
            inv.number ? idCell(inv.number) : text("None"),
            { t: "badge", b: invoiceBadge(inv.status) },
            dateCell(inv.created),
          ] as Cell[],
          ...(actions.length ? { actions } : {}),
        };
      }),
      empty: "No invoices.",
      nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
      ...(total ? { footer: rangeFooter(offset, rows.length, total, snap.invoicesMore) } : {}),
    };
  }

  private chargesTable(
    snap: CustomerSnapshot,
    cursor: string | null,
    refund: { customerId: string; queue: boolean; waiting: Set<string>; offerCancel: boolean } | null
  ): TableBlock {
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
        const decline = declineReason(ch);
        const button = refund ? this.refundButton(ch, refund) : null;
        return {
          id: ch.id,
          cells: [
            amount(this.deps.money, ch.amount, ch.currency),
            { t: "badge", b: badge.text === "Partial refund" ? { kind: "info", text: "Partially refunded" } : badge, ...(decline ? { sub: decline } : {}) },
            card ? cardCell(card.brand ?? "", card.last4 ?? "") : text(sentenceType(ch.payment_method_details?.type)),
            dateCell(ch.created),
          ] as Cell[],
          ...(button ? { actions: [button] } : {}),
        };
      }),
      empty: "No charges.",
      nextCursor: offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null,
      ...(total ? { footer: rangeFooter(offset, rows.length, total, snap.chargesMore) } : {}),
    };
  }

  private refundButton(ch: Stripe.Charge, ctx: { customerId: string; queue: boolean; waiting: Set<string>; offerCancel: boolean }): ActionButton | null {
    const remaining = ch.amount - (ch.amount_refunded ?? 0);
    if (ch.status !== "succeeded" || !ch.captured || ch.refunded || remaining <= 0) return null;
    const button: ActionButton = { key: "refund", label: "Refund" };
    if (ch.disputed) return { ...button, disabledReason: "Disputed charges cannot be refunded." };
    if (ctx.waiting.has(ch.id)) return { ...button, disabledReason: "A refund for this charge is waiting for approval." };
    const zero = StripeClient.isZeroDecimal(ch.currency);
    const major = zero ? remaining : remaining / 100;
    const shown = zero ? String(major) : major.toFixed(2);
    const card = ch.payment_method_details?.card;
    const paidWith = card ? `${cardBrand(card.brand)} ···· ${card.last4 ?? ""}` : sentenceType(ch.payment_method_details?.type);
    return {
      ...button,
      params: { customerId: ctx.customerId, chargeId: ch.id },
      inputs: [
        { type: "number", key: "amountMajor", label: `Amount (${ch.currency.toUpperCase()}, up to ${shown})`, value: shown, min: zero ? 1 : 0.01, max: major, step: zero ? 1 : 0.01 },
        ...whyInputs(),
        ...(ctx.offerCancel ? [{ type: "toggle" as const, key: "cancelSub", label: "Also cancel the subscription now", value: false }] : []),
      ],
      submitLabel: ctx.queue ? "Send for approval" : "Refund",
      summary: `${this.deps.money.formatAmount(ch.amount, ch.currency)} on ${shortDate(ch.created)}, ${paidWith}`,
    };
  }

  // ---- My activity ----

  private async activityBlocks(actor: SupportActor, req: SupportViewRequest): Promise<SupportBlock[]> {
    const groupKey = req.filters.status ?? "";
    const group = groupKey in ACTIVITY_GROUPS ? groupKey : null;
    const offset = offsetOf(req.cursor);
    const counts = await this.deps.activity.counts(actor.id);
    const list = await this.deps.activity.list(actor.id, group, offset, PAGE_SIZE);
    return [
      { type: "header", title: "My activity" },
      {
        type: "table",
        key: "activity",
        counts: {
          key: "status",
          items: [
            { value: "", label: "All", count: counts.all ?? 0 },
            { value: "done", label: "Done", count: counts.done ?? 0 },
            { value: "pending", label: "Waiting for approval", count: counts.pending ?? 0 },
            { value: "failed", label: "Failed", count: counts.failed ?? 0 },
            { value: "closed", label: "Rejected or expired", count: counts.closed ?? 0 },
          ],
        },
        columns: [
          { key: "customer", label: "Customer" },
          { key: "action", label: "Action" },
          { key: "status", label: "Status" },
          { key: "when", label: "When" },
          { key: "outcome", label: "Outcome" },
        ],
        rows: list.rows.map((a) => {
          const name = a.customerName || a.customerId || "Unknown";
          return {
            id: a.id,
            cells: [
              CUSTOMER_ID_RE.test(a.customerId) ? ({ t: "link", v: name, ref: { page: "customer", params: { id: a.customerId } } } as Cell) : text(name),
              text(a.status === "done" ? pastTense(a.summary) : a.summary),
              { t: "badge", b: activityBadge(a.status) },
              isoDateCell(a.createdAt),
              text(a.outcome ?? ""),
            ] as Cell[],
            ...(a.status === "queued" && a.approvalId
              ? { actions: [{ key: "withdraw", label: "Withdraw", params: { id: a.approvalId }, confirm: true, submitLabel: "Withdraw", summary: a.summary }] }
              : {}),
          };
        }),
        empty: group ? "Nothing here." : "Nothing yet.",
        nextCursor: offset + PAGE_SIZE < list.total ? String(offset + PAGE_SIZE) : null,
        ...(list.total > PAGE_SIZE ? { footer: rangeFooter(offset, list.rows.length, list.total) } : {}),
      },
    ];
  }

  // ---- actions ----

  async action(actor: SupportActor, key: string, params: Record<string, unknown>): Promise<SupportActionResult> {
    if (key === "withdraw") return this.withdraw(actor, params);
    const customerId = typeof params.customerId === "string" && CUSTOMER_ID_RE.test(params.customerId) ? params.customerId : null;
    if (!customerId) return { ok: false, error: "Bad request." };
    const run =
      key === "request_change"
        ? () => this.changeDetails(actor, customerId, params)
        : key === "refund"
          ? () => this.refund(actor, customerId, params)
          : key === "cancel_sub" || key === "keep_sub"
            ? () => this.cancel(actor, customerId, params, key === "keep_sub")
            : key === "unsuppress"
              ? () => this.unsuppress(actor, customerId, params)
              : null;
    if (!run) return { ok: false, error: "Unknown action." };
    if (this.busy.has(customerId)) return { ok: false, error: "Another action for this customer is running." };
    this.busy.add(customerId);
    try {
      return await run();
    } finally {
      this.busy.delete(customerId);
      this.deps.data.invalidate(customerId);
    }
  }

  private async withdraw(actor: SupportActor, params: Record<string, unknown>): Promise<SupportActionResult> {
    const id = typeof params.id === "string" && /^[a-z0-9]{10,40}$/i.test(params.id) ? params.id : null;
    if (!id) return { ok: false, error: "Bad request." };
    const res = await this.deps.actions.withdraw(id, actorOf(actor));
    if (!res.ok) return res;
    const row = await this.deps.approvals.get(id);
    if (row?.stripeCustomerId) this.deps.data.invalidate(row.stripeCustomerId);
    await this.deps.activity.settle(actor.id).catch(() => undefined);
    return { ok: true, text: "Request withdrawn." };
  }

  private async changeDetails(actor: SupportActor, customerId: string, params: Record<string, unknown>): Promise<SupportActionResult> {
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
    const fields = changedFields(before, after);
    if (fields.length === 0) return { ok: false, error: "Nothing changed." };
    const why = whyOf(params, "Say why the customer needs this change.");
    if ("error" in why) return why.error;

    if (await this.deps.approvals.findActionableFor(CUSTOMER_UPDATE_DETAILS, customerId)) {
      return { ok: false, error: "A change for this customer is already waiting for approval." };
    }
    const customerName = snap.customer.name ?? snap.customer.email ?? null;
    const outcome = await this.deps.actions.requestScoped(
      bindingFor(customerId),
      actorOf(actor),
      CUSTOMER_UPDATE_DETAILS,
      { customerId, before, after, reason: why.reason, intercomRef: why.intercomRef, customerName },
      why
    );
    return this.settleOutcome(actor, { customerId, customerName, kind: "details", summary: `Change ${fieldPhrase(fields)}`, ...why }, outcome, "Detail changes", "Saved.");
  }

  private async refund(actor: SupportActor, customerId: string, params: Record<string, unknown>): Promise<SupportActionResult> {
    const chargeId = typeof params.chargeId === "string" && CHARGE_ID_RE.test(params.chargeId) ? params.chargeId : null;
    if (!chargeId) return { ok: false, error: "Bad request." };
    const why = whyOf(params, "Say why the customer gets this refund.");
    if ("error" in why) return why.error;
    const charge = await this.deps.data.charge(chargeId);
    const owner = typeof charge?.customer === "string" ? charge.customer : charge?.customer?.id ?? null;
    if (!charge || owner !== customerId) return { ok: false, error: "That charge does not belong to this customer." };
    if (charge.disputed) return { ok: false, error: "Disputed charges cannot be refunded." };
    if (charge.status !== "succeeded" || !charge.captured) return { ok: false, error: "Only succeeded charges can be refunded." };
    const remaining = charge.amount - (charge.amount_refunded ?? 0);
    if (charge.refunded || remaining <= 0) return { ok: false, error: "This charge is already fully refunded." };

    const factor = StripeClient.isZeroDecimal(charge.currency) ? 1 : 100;
    const major = typeof params.amountMajor === "number" && Number.isFinite(params.amountMajor) ? params.amountMajor : null;
    const amountMinor = major == null ? null : Math.round(major * factor);
    const fmt = (minor: number) => this.deps.money.formatAmount(minor, charge.currency);
    if (amountMinor == null || amountMinor <= 0) return { ok: false, error: "Enter the amount to refund.", fieldErrors: { amountMajor: "Required." } };
    if (amountMinor > remaining) return { ok: false, error: `At most ${fmt(remaining)} is left to refund.`, fieldErrors: { amountMajor: `Up to ${fmt(remaining)}.` } };

    if (this.deps.settings.supportDashApproval()) {
      const open = await this.deps.approvals.listActionableFor(REFUND_KEY, customerId);
      if (open.some((a) => chargeIdOf(a) === chargeId)) return { ok: false, error: "A refund for this charge is already waiting for approval." };
    }

    const snap = await this.deps.data.customer(customerId);
    const customerName = snap?.customer.name ?? snap?.customer.email ?? null;
    const card = charge.payment_method_details?.card;
    const paidWith = card ? `, ${cardBrand(card.brand)} ${card.last4 ?? ""}`.trimEnd() : "";
    const summary = amountMinor === charge.amount ? `Refund ${fmt(amountMinor)}${paidWith}` : `Refund ${fmt(amountMinor)} of ${fmt(charge.amount)}${paidWith}`;
    const outcome = await this.deps.actions.requestScoped(bindingFor(customerId), actorOf(actor), REFUND_KEY, { chargeId, amountMinor }, why);
    const result = await this.settleOutcome(actor, { customerId, customerName, kind: "refund", summary, ...why }, outcome, "Refunds", `Refunded ${fmt(amountMinor)}.`);
    if (!result.ok || params.cancelSub !== true) return result;

    // The refund went through (or is queued): now the subscription.
    const fresh = await this.deps.data.customer(customerId, { fresh: true });
    const live = fresh ? liveSubs(fresh.subs) : [];
    if (live.length !== 1) return { ...result, text: `${result.text} The subscription was not cancelled: ${live.length ? "there is more than one" : "there is none left"}.` };
    const cancelled = await this.cancelNow(actor, customerId, customerName, live[0].id, why);
    return cancelled.ok ? { ...result, text: `${result.text} ${cancelled.text}` } : { ...result, text: `${result.text} The cancel failed: ${cancelled.error}` };
  }

  private async cancelNow(actor: SupportActor, customerId: string, customerName: string | null, subscriptionId: string, why: Why): Promise<SupportActionResult> {
    const outcome = await this.deps.actions.requestScoped(bindingFor(customerId), actorOf(actor), CANCEL_KEY, { subscriptionId, when: "now" }, why);
    return this.settleOutcome(
      actor,
      { customerId, customerName, kind: "cancel", summary: "Cancel the subscription now", ...why },
      outcome,
      "Cancellations",
      "The subscription is cancelled."
    );
  }

  private async cancel(actor: SupportActor, customerId: string, params: Record<string, unknown>, keep: boolean): Promise<SupportActionResult> {
    const subscriptionId = typeof params.subscriptionId === "string" && SUB_ID_RE.test(params.subscriptionId) ? params.subscriptionId : null;
    if (!subscriptionId) return { ok: false, error: "Bad request." };
    const when = keep ? "never" : params.when === "now" ? "now" : params.when === "period_end" ? "period_end" : null;
    if (!when) return { ok: false, error: "Pick when the subscription ends." };
    const why = whyOf(params, keep ? "Say why the subscription stays." : "Say why the subscription ends.");
    if ("error" in why) return why.error;
    const snap = await this.deps.data.customer(customerId, { fresh: true });
    if (!snap) return { ok: false, error: "That customer no longer exists." };
    if (!snap.subs.some((s) => s.id === subscriptionId)) return { ok: false, error: "That subscription does not belong to this customer." };
    if (this.deps.settings.supportDashApproval() && (await this.deps.approvals.listActionableFor(CANCEL_KEY, customerId)).length) {
      return { ok: false, error: "A cancellation is already waiting for approval." };
    }
    const customerName = snap.customer.name ?? snap.customer.email ?? null;
    if (when === "now") return this.cancelNow(actor, customerId, customerName, subscriptionId, why);
    const outcome = await this.deps.actions.requestScoped(bindingFor(customerId), actorOf(actor), CANCEL_KEY, { subscriptionId, when }, why);
    return keep
      ? this.settleOutcome(actor, { customerId, customerName, kind: "uncancel", summary: "Undo the scheduled cancel", ...why }, outcome, "Cancellations", "The subscription keeps renewing.")
      : this.settleOutcome(actor, { customerId, customerName, kind: "cancel", summary: "Cancel at period end", ...why }, outcome, "Cancellations", "The subscription ends at the end of the period.");
  }

  private async unsuppress(actor: SupportActor, customerId: string, params: Record<string, unknown>): Promise<SupportActionResult> {
    const svc = this.deps.email;
    if (!svc?.enabled()) return { ok: false, error: "Resend is not set up." };
    const email = typeof params.email === "string" ? params.email.trim().slice(0, 254) : "";
    const snap = await this.deps.data.customer(customerId);
    if (!snap) return { ok: false, error: "That customer no longer exists." };
    // Only an address this customer is known by, re-derived here.
    const match = knownEmails(snap).find((e) => e.toLowerCase() === email.toLowerCase());
    if (!match) return { ok: false, error: "That address does not belong to this customer." };
    const res = await svc.remove(match, { surface: "support", id: actor.id, name: actor.name });
    const ok = res.kind === "removed" || res.kind === "not_suppressed";
    await this.deps.activity
      .record({
        discordUserId: actor.id,
        actorName: actor.name,
        customerId,
        customerName: snap.customer.name ?? snap.customer.email ?? null,
        kind: "unsuppress",
        summary: `Remove ${match} from suppression`,
        status: ok ? "done" : "failed",
        outcome: res.kind === "not_suppressed" ? "It was not suppressed" : res.kind === "error" || res.kind === "invalid" ? res.error : null,
      })
      .catch((e) => viewLog.warn("activity log failed", { "error.message": e instanceof Error ? e.message : String(e) }));
    switch (res.kind) {
      case "removed":
        return { ok: true, text: `${match} is off the suppression list.` };
      case "not_suppressed":
        return { ok: true, text: `${match} was not suppressed.` };
      case "disabled":
        return { ok: false, error: "Resend is not set up." };
      default:
        return { ok: false, error: res.error };
    }
  }

  // The registry's answer becomes an activity row and the page's reply.
  private async settleOutcome(
    actor: SupportActor,
    entry: { customerId: string; customerName: string | null; kind: SupportActionKind; summary: string; reason: string; intercomRef: string | null },
    outcome: RequestOutcome,
    what: string,
    doneText: string
  ): Promise<SupportActionResult> {
    if (outcome.kind === "denied") return { ok: false, error: `${what} are switched off for support.` };
    if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
    const status = outcome.kind === "queued" ? "queued" : outcome.kind === "executed" ? "done" : "failed";
    await this.deps.activity
      .record({
        discordUserId: actor.id,
        actorName: actor.name,
        ...entry,
        status,
        approvalId: outcome.kind === "queued" ? outcome.approvalId : null,
        outcome: outcome.kind === "failed" ? outcome.error : null,
      })
      .catch((e) => viewLog.warn("activity log failed", { "error.message": e instanceof Error ? e.message : String(e) }));
    if (outcome.kind === "queued") return { ok: true, queued: true, text: "Sent for approval." };
    if (outcome.kind === "executed") return { ok: true, text: doneText };
    return { ok: false, error: outcome.error };
  }
}

// ---- helpers ----

function actorOf(actor: SupportActor): ActionActor {
  return { kind: "support", id: actor.id, name: actor.name, isAdmin: false };
}

function bindingFor(customerId: string) {
  return { stripeCustomerId: customerId, discordCustomerId: null, ticketThreadId: null, conversationId: null, origin: "support" as const };
}

function whyInputs(): InputField[] {
  return [
    { type: "text", key: "reason", label: "Reason", multiline: true, rows: 3, maxLength: 500 },
    { type: "text", key: "intercomRef", label: "Intercom link or ticket ID (optional)", maxLength: 300 },
  ];
}

function whyOf(params: Record<string, unknown>, missing: string): Why | { error: SupportActionResult } {
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return { error: { ok: false, error: missing, fieldErrors: { reason: "Required." } } };
  const ref = typeof params.intercomRef === "string" ? params.intercomRef.trim().slice(0, 300) : "";
  return { reason, intercomRef: ref || null };
}

// Every address this customer is known by: the Stripe email and the owner of
// each Postiz organisation that is theirs.
function knownEmails(snap: CustomerSnapshot): string[] {
  const out: string[] = [];
  for (const e of [snap.customer.email, ...snap.postiz.orgs.filter((o) => o.customerMatches !== false && !o.orgDeleted).map((o) => o.ownerEmail)]) {
    if (e && !out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
  }
  return out;
}

function suppressionLine(customerId: string, st: DeliveryStatus | null): { badge?: Badge; action?: ActionButton } {
  if (st?.state !== "suppressed") return {};
  return {
    badge: { kind: "warn", text: `Suppressed, ${originLabel(st.suppression.origin)}` },
    action: {
      key: "unsuppress",
      label: "Remove",
      params: { customerId, email: st.email },
      confirm: true,
      submitLabel: "Remove",
      summary: `${st.email}: ${describeSuppression(st.suppression, st.source)}`,
    },
  };
}

function chargeIdOf(a: BillingApproval): string | null {
  const p = paramsOf(a);
  return typeof p?.chargeId === "string" ? p.chargeId : null;
}

function planCell(plan: PlanSummary | null): Cell {
  return plan ? ({ t: "badge", b: { kind: plan.badge.kind, text: plan.ended ? plan.badge.text : plan.label } } as Cell) : text("None");
}

// What the bank or Radar said about a failed charge, in a few words.
const DECLINES: Record<string, string> = {
  insufficient_funds: "Insufficient funds",
  expired_card: "Expired card",
  incorrect_cvc: "Incorrect CVC",
  invalid_cvc: "Incorrect CVC",
  incorrect_number: "Incorrect card number",
  invalid_number: "Incorrect card number",
  incorrect_zip: "Incorrect postal code",
  invalid_expiry_month: "Incorrect expiry",
  invalid_expiry_year: "Incorrect expiry",
  lost_card: "Card reported lost",
  pickup_card: "Card reported lost",
  stolen_card: "Card reported stolen",
  do_not_honor: "Declined by the bank",
  generic_decline: "Declined by the bank",
  card_declined: "Declined by the bank",
  call_issuer: "Declined by the bank",
  fraudulent: "Declined by the bank as fraud",
  card_velocity_exceeded: "Card limit reached",
  withdrawal_count_limit_exceeded: "Card limit reached",
  authentication_required: "Needs 3D Secure",
  processing_error: "Processing error",
  card_not_supported: "Card does not support this purchase",
  transaction_not_allowed: "Card does not support this purchase",
  currency_not_supported: "Card does not support this currency",
  highest_risk_level: "Blocked by Radar",
  elevated_risk_level: "Held by Radar",
  rule: "Blocked by a Radar rule",
  merchant_blacklist: "Blocked by Radar",
};

export function declineReason(ch: Stripe.Charge): string | null {
  if (ch.status !== "failed") return null;
  const codes = [ch.outcome?.reason, ch.failure_code].filter((c): c is string => !!c);
  for (const c of codes) if (DECLINES[c]) return DECLINES[c];
  if (codes[0]) return sentenceType(codes[0]);
  return ch.failure_message ? ch.failure_message.slice(0, 120) : null;
}

const PAST: Record<string, string> = { Refund: "Refunded", Cancel: "Cancelled", Change: "Changed", Remove: "Removed", Undo: "Undid" };

export function pastTense(summary: string): string {
  const space = summary.indexOf(" ");
  const verb = space < 0 ? summary : summary.slice(0, space);
  return PAST[verb] ? PAST[verb] + summary.slice(verb.length) : summary;
}

function activityBadge(status: string): Badge {
  switch (status) {
    case "done":
      return { kind: "ok", text: "Done" };
    case "queued":
      return { kind: "warn", text: "Waiting for approval" };
    case "failed":
      return { kind: "error", text: "Failed" };
    case "rejected":
      return { kind: "neutral", text: "Rejected" };
    case "refused":
      return { kind: "neutral", text: "Not applied" };
    case "expired":
      return { kind: "neutral", text: "Expired" };
    default:
      return { kind: "neutral", text: "Withdrawn" };
  }
}

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
