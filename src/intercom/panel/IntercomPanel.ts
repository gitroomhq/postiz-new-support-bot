import type Stripe from "stripe";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { TicketStore } from "../../bot/TicketStore";
import { StripeClient } from "../../bot/StripeClient";
import { IntercomStore } from "../IntercomStore";
import { DisputeStore } from "../../bot/billing/DisputeStore";
import { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import { actionByKey, ActionActor } from "../../bot/billing/actions/ActionRegistry";
import { PanelTokens, PanelTokenPayload } from "./PanelTokens";
import { renderPanelShell } from "./panelHtml";
import { log } from "../../util/logger";

const panelLog = log.child("intercom:panel");

// Sliding-window rate limit per teammate id (and the page route per token).
const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;

interface PanelActionButton {
  label: string;
  actionKey?: string;
  params?: Record<string, unknown>;
  dangerous: boolean;
  mode: "direct" | "queue";
  inputs: Array<{ key: string; label: string; type: "text" | "number"; placeholder?: string }>;
  summary?: string;
  // approval buttons route to the approval-act endpoint instead
  approvalId?: string;
  decision?: "approve" | "reject";
}

interface PanelRow {
  cells: string[];
  actions: PanelActionButton[];
}

interface PanelSection {
  columns: string[];
  rows: PanelRow[];
  hasRowActions: boolean;
  sectionActions: PanelActionButton[];
  nextCursor: string | null;
  notice?: string;
}

// The server half of the Stripe panel page: token verification, per-request
// authorization, section data and the action dispatch. Everything the page
// renders — including which buttons exist — is decided HERE; the client is a
// generic table renderer. The Stripe customer is always re-derived from the
// token's conversation scope, never accepted from the client.
export class IntercomPanel {
  private rate = new Map<string, number[]>();

  constructor(
    private settingsStore: SettingsStore,
    private intercomStore: IntercomStore,
    private ticketStore: TicketStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private billingActions: BillingActionService,
    private tokens: PanelTokens
  ) {}

  // GET /intercom/panel?t=…
  async page(token: string): Promise<{ html: string } | { status: number; message: string }> {
    const payload = this.tokens.verify(token);
    if (!payload) return { status: 401, message: "This panel link is invalid or expired. Reopen it from Intercom." };
    if (!this.allow(`page:${payload.aid}`)) return { status: 429, message: "Too many requests." };
    const scope = await this.resolveScope(payload);
    const actor = this.actorFor(payload);
    return {
      html: renderPanelShell({
        adminName: payload.an,
        isAdmin: actor.isAdmin,
        customerLabel: scope?.stripeCustomerId ?? "no linked Stripe customer",
        hasCustomer: !!scope?.stripeCustomerId,
      }),
    };
  }

  // POST /intercom/panel/api/:endpoint
  async api(endpoint: string, token: string, body: unknown): Promise<{ status: number; json: object }> {
    const payload = this.tokens.verify(token);
    if (!payload) return { status: 401, json: { error: "expired" } };
    if (!this.allow(`api:${payload.aid}`)) return { status: 429, json: { error: "rate limited" } };
    const request = (body ?? {}) as Record<string, unknown>;
    const actor = this.actorFor(payload);

    try {
      switch (endpoint) {
        case "list": {
          const section = typeof request.section === "string" ? request.section : "overview";
          const cursor = typeof request.cursor === "string" ? request.cursor : null;
          const json = await this.buildSection(payload, actor, section, cursor);
          return { status: 200, json };
        }
        case "action": {
          const actionKey = typeof request.actionKey === "string" ? request.actionKey : "";
          const params = this.shapeParams(actionKey, request.params);
          const outcome = await this.billingActions.request(payload.cid, actor, actionKey, params);
          if (outcome.kind === "executed") return { status: 200, json: { ok: true, text: outcome.text } };
          if (outcome.kind === "queued") return { status: 200, json: { ok: true, text: "Queued for admin approval." } };
          return { status: 200, json: { ok: false, error: outcome.error } };
        }
        case "approval-act": {
          const approvalId = typeof request.approvalId === "string" ? request.approvalId : "";
          const decision = request.decision === "approve" ? "approve" : "reject";
          const outcome = await this.billingActions.actOnApproval(approvalId, actor, decision);
          if (outcome.kind === "executed") return { status: 200, json: { ok: true, text: outcome.text } };
          if (outcome.kind === "rejected") return { status: 200, json: { ok: true, text: "Approval rejected." } };
          return { status: 200, json: { ok: false, error: outcome.error } };
        }
        default:
          return { status: 404, json: { error: "unknown endpoint" } };
      }
    } catch (e) {
      panelLog.warn("panel api error", {
        "panel.endpoint": endpoint,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return { status: 200, json: { ok: false, error: e instanceof Error ? e.message : "Internal error" } };
    }
  }

  // ---- auth/scope helpers ----

  // The admin bit is re-read from settings on EVERY call — marking/unmarking
  // a teammate in /config applies to in-flight tokens immediately.
  private actorFor(payload: PanelTokenPayload): ActionActor {
    return {
      kind: "intercom",
      id: payload.aid,
      name: payload.an,
      isAdmin: this.settingsStore.isIntercomPanelAdmin(payload.aid),
    };
  }

  private async resolveScope(
    payload: PanelTokenPayload
  ): Promise<{ ticketThreadId: string; discordCustomerId: string | null; stripeCustomerId: string | null } | null> {
    const link = await this.intercomStore.getLinkByConversationId(payload.cid).catch(() => null);
    if (!link) return null;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
    const session = ticket?.customerId ? await this.sessionStore.getSession(ticket.customerId).catch(() => null) : null;
    return {
      ticketThreadId: link.ticketThreadId,
      discordCustomerId: ticket?.customerId ?? null,
      stripeCustomerId: session?.stripeCustomerId ?? null,
    };
  }

  private allow(key: string): boolean {
    const now = Date.now();
    const hits = (this.rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_PER_MIN) {
      this.rate.set(key, hits);
      return false;
    }
    hits.push(now);
    this.rate.set(key, hits);
    return true;
  }

  // Client convenience shaping: the generic modal collects flat inputs, but
  // invoice.create_draft wants an items array — rebuild it server-side.
  private shapeParams(actionKey: string, raw: unknown): unknown {
    if (actionKey !== "invoice.create_draft" || !raw || typeof raw !== "object") return raw;
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.items)) return raw;
    return {
      items: [{ description: o.description, amountMinor: o.amountMinor, currency: o.currency }],
      daysUntilDue: o.daysUntilDue,
      finalize: o.finalize === true,
    };
  }

  // Action-button factory: resolves the actor's CURRENT mode; returns null
  // when the action is disabled (or unknown) so the button never renders.
  private button(
    actor: ActionActor,
    actionKey: string,
    label: string,
    params: Record<string, unknown>,
    inputs: PanelActionButton["inputs"] = [],
    summary?: string
  ): PanelActionButton | null {
    const def = actionByKey(actionKey);
    if (!def) return null;
    const mode = this.billingActions.effectiveMode(actionKey, actor);
    if (mode === "denied") return null;
    return { label, actionKey, params, dangerous: def.dangerous, mode, inputs, summary };
  }

  // ---- sections ----

  private async buildSection(
    payload: PanelTokenPayload,
    actor: ActionActor,
    section: string,
    cursor: string | null
  ): Promise<PanelSection> {
    const scope = await this.resolveScope(payload);
    if (!scope) return this.empty("Not a Discord-bridged conversation.");
    const cus = scope.stripeCustomerId;

    switch (section) {
      case "overview":
        return this.overviewSection(actor, scope, cus);
      case "charges":
        return cus ? this.chargesSection(actor, cus, cursor) : this.empty("No linked Stripe customer.");
      case "subscriptions":
        return cus ? this.subscriptionsSection(actor, cus) : this.empty("No linked Stripe customer.");
      case "invoices":
        return cus ? this.invoicesSection(actor, cus, cursor) : this.empty("No linked Stripe customer.");
      case "payment_methods":
        return cus ? this.paymentMethodsSection(actor, cus) : this.empty("No linked Stripe customer.");
      case "balance":
        return cus ? this.balanceSection(actor, cus, cursor) : this.empty("No linked Stripe customer.");
      case "disputes":
        return cus ? this.disputesSection(cus) : this.empty("No linked Stripe customer.");
      case "approvals":
        return this.approvalsSection(actor, cursor);
      default:
        return this.empty("Unknown section.");
    }
  }

  private empty(notice: string): PanelSection {
    return { columns: [], rows: [], hasRowActions: false, sectionActions: [], nextCursor: null, notice };
  }

  private async overviewSection(
    actor: ActionActor,
    scope: { ticketThreadId: string },
    cus: string | null
  ): Promise<PanelSection> {
    const rows: PanelRow[] = [];
    rows.push({ cells: ["Acting as", `${actor.name} (${actor.isAdmin ? "admin" : "support agent"})`], actions: [] });
    if (cus) {
      const customer = await this.stripe.getCustomer(cus).catch(() => null);
      rows.push({ cells: ["Stripe customer", cus], actions: [] });
      if (customer && !customer.deleted) {
        rows.push(
          { cells: ["Email", customer.email ?? "—"], actions: [] },
          { cells: ["Created", new Date(customer.created * 1000).toISOString().slice(0, 10)], actions: [] },
          {
            cells: [
              "Balance",
              customer.currency ? this.stripe.formatAmount(customer.balance, customer.currency) : String(customer.balance),
            ],
            actions: [],
          },
          { cells: ["Delinquent", customer.delinquent ? "YES" : "no"], actions: [] }
        );
      }
    } else {
      rows.push({ cells: ["Stripe customer", "not linked"], actions: [] });
    }

    // Pending charge review (guardrail-blocked self-service refund).
    const review = await this.sessionStore.getPendingChargeReview(scope.ticketThreadId).catch(() => null);
    if (review) {
      const actions = [
        this.button(actor, "charge_review", "Approve refund", { decision: "approve" }, [],
          `Approve the blocked refund of ${this.stripe.formatAmount(review.amount, review.currency)} on ${review.chargeId} (refund + cancel subscription).`),
        this.button(actor, "charge_review", "Deny refund", { decision: "deny" }, [],
          "Deny the blocked refund — the thread stays open for follow-up."),
      ].filter((b): b is PanelActionButton => b != null);
      rows.push({
        cells: [
          "⚠️ Refund review pending",
          `${this.stripe.formatAmount(review.amount, review.currency)} on ${review.chargeId} — blocked by: ${review.reason}`,
        ],
        actions,
      });
    }

    const sectionActions = cus
      ? [
          this.button(
            actor,
            "invoice.create_draft",
            "Create draft invoice",
            { finalize: false },
            [
              { key: "description", label: "Item description", type: "text" },
              { key: "amountMinor", label: "Amount (minor units, e.g. cents)", type: "number" },
              { key: "currency", label: "Currency (3 letters)", type: "text", placeholder: "usd" },
              { key: "daysUntilDue", label: "Days until due", type: "number", placeholder: "7" },
            ],
            "Creates a draft invoice with one item (finalize it from the Invoices tab flow by re-creating with finalize, or in Stripe)."
          ),
          this.button(
            actor,
            "customer.balance",
            "Adjust balance",
            {},
            [
              { key: "deltaMinor", label: "Delta (minor units; NEGATIVE = credit)", type: "number" },
              { key: "currency", label: "Currency (3 letters)", type: "text", placeholder: "usd" },
              { key: "note", label: "Note", type: "text" },
            ],
            "Adjusts the customer's invoice balance. Negative credits the customer."
          ),
          this.button(
            actor,
            "customer.block",
            "Blocklist customer",
            { cancelSubs: false },
            [{ key: "reason", label: "Reason", type: "text" }],
            "Blocks the customer id + email via Stripe Radar and the local blocklist."
          ),
          this.button(
            actor,
            "customer.block",
            "Blocklist + cancel all subs",
            { cancelSubs: true },
            [{ key: "reason", label: "Reason", type: "text" }],
            "Blocks the customer AND cancels every active subscription."
          ),
        ].filter((b): b is PanelActionButton => b != null)
      : [];

    return {
      columns: ["Field", "Value"],
      rows,
      hasRowActions: rows.some((r) => r.actions.length > 0),
      sectionActions,
      nextCursor: null,
    };
  }

  private async chargesSection(actor: ActionActor, cus: string, cursor: string | null): Promise<PanelSection> {
    const { charges, hasMore } = await this.stripe.listCharges(cus, 10, cursor ?? undefined);
    const rows: PanelRow[] = charges.map((charge) => {
      const state = charge.refunded ? "refunded" : (charge.amount_refunded ?? 0) > 0 ? `partial refund (${charge.amount_refunded})` : charge.status;
      const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      const actions = [
        this.button(actor, "charge.refund_full", "Full refund", { chargeId: charge.id }, [],
          `Fully refund ${this.stripe.formatAmount(charge.amount, charge.currency)} and cancel the subscription.`),
        this.button(actor, "charge.refund_partial", "Partial refund", { chargeId: charge.id },
          [{ key: "amountMinor", label: `Amount (minor units, max ${charge.amount - (charge.amount_refunded ?? 0)})`, type: "number" }],
          "Refund part of this charge."),
        this.button(actor, "charge.refund_fraud", "Refund as fraud", { chargeId: charge.id },
          [{ key: "amountMinor", label: "Amount (minor units)", type: "number" }],
          "Refund with reason=fraudulent — feeds Stripe Radar."),
        ...(piId && charge.status === "pending"
          ? [this.button(actor, "payment_intent.cancel", "Cancel PI", { paymentIntentId: piId }, [], "Cancel the open payment intent.")]
          : []),
      ].filter((b): b is PanelActionButton => b != null);
      return {
        cells: [
          new Date(charge.created * 1000).toISOString().slice(0, 10),
          this.stripe.formatAmount(charge.amount, charge.currency),
          state,
          charge.id,
        ],
        actions,
      };
    });
    return {
      columns: ["Date", "Amount", "Status", "Charge"],
      rows,
      hasRowActions: true,
      sectionActions: [],
      nextCursor: hasMore && charges.length > 0 ? charges[charges.length - 1].id : null,
    };
  }

  private async subscriptionsSection(actor: ActionActor, cus: string): Promise<PanelSection> {
    const subs = await this.stripe.listSubscriptions(cus);
    const rows: PanelRow[] = subs.slice(0, 25).map((sub) => {
      const item = sub.items.data[0];
      const price = item?.price;
      const plan = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
      const periodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10) : "—";
      const flags = [sub.pause_collection ? "paused" : null, sub.cancel_at_period_end ? "cancels at period end" : null]
        .filter(Boolean)
        .join(" · ");
      const active = sub.status !== "canceled";
      const actions = active
        ? [
            this.button(actor, "subscription.cancel", "Cancel now", { subscriptionId: sub.id, when: "now" }, [],
              "Cancel this subscription immediately."),
            ...(!sub.cancel_at_period_end
              ? [this.button(actor, "subscription.cancel", "Cancel at period end", { subscriptionId: sub.id, when: "period_end" }, [],
                  "Let the current period finish, then cancel.")]
              : []),
            ...(sub.pause_collection
              ? [this.button(actor, "subscription.pause_resume", "Resume", { subscriptionId: sub.id, op: "resume" }, [], "Resume collection.")]
              : [this.button(actor, "subscription.pause_resume", "Pause", { subscriptionId: sub.id, op: "pause" }, [], "Pause collection (invoices void while paused).")]),
            this.button(actor, "subscription.change_plan", "Change plan", { subscriptionId: sub.id },
              [{ key: "priceId", label: "New price id (price_…)", type: "text" }],
              "Swap the plan with prorations."),
            this.button(actor, "subscription.terms", "Trial end", { subscriptionId: sub.id },
              [{ key: "trialEndUnix", label: "Trial end (unix seconds)", type: "number" }],
              "Move the trial end."),
            this.button(actor, "subscription.terms", "Quantity", { subscriptionId: sub.id },
              [{ key: "quantity", label: "New quantity", type: "number" }],
              "Set the seat/quantity."),
            this.button(actor, "customer.coupon", "Apply promo", { subscriptionId: sub.id },
              [{ key: "promoCode", label: "Promo code", type: "text" }],
              "Apply a promotion code to this subscription."),
          ].filter((b): b is PanelActionButton => b != null)
        : [];
      return {
        cells: [plan, sub.status, periodEnd, flags || "—", sub.id],
        actions,
      };
    });
    return {
      columns: ["Plan", "Status", "Period end", "Flags", "Subscription"],
      rows,
      hasRowActions: true,
      sectionActions: [],
      nextCursor: null,
      ...(subs.length > 25 ? { notice: `Showing 25 of ${subs.length} subscriptions.` } : {}),
    };
  }

  private async invoicesSection(actor: ActionActor, cus: string, cursor: string | null): Promise<PanelSection> {
    const { invoices, hasMore } = await this.stripe.listInvoices(cus, 10, cursor ?? undefined);
    const rows: PanelRow[] = invoices.map((invoice) => {
      const id = invoice.id!;
      const actions: Array<PanelActionButton | null> = [];
      if (invoice.status === "open") {
        actions.push(
          this.button(actor, "invoice.collect", "Send", { invoiceId: id, op: "send" }, [], "Email the invoice to the customer."),
          this.button(actor, "invoice.collect", "Pay", { invoiceId: id, op: "pay" }, [], "Attempt collection with the default payment method."),
          this.button(actor, "invoice.void", "Void", { invoiceId: id, op: "void" }, [], "Void the invoice."),
          this.button(actor, "invoice.void", "Uncollectible", { invoiceId: id, op: "uncollectible" }, [], "Write the invoice off as uncollectible.")
        );
      }
      if (invoice.status === "draft") {
        actions.push(this.button(actor, "invoice.void", "Delete draft", { invoiceId: id, op: "delete_draft" }, [], "Delete the draft invoice."));
      }
      if (invoice.status === "paid" || invoice.status === "open") {
        actions.push(
          this.button(actor, "invoice.credit_note", "Credit note", { invoiceId: id },
            [
              { key: "amountMinor", label: "Amount (minor units)", type: "number" },
              { key: "memo", label: "Memo (optional shows to customer)", type: "text", placeholder: "-" },
            ],
            "Issue a credit-mode credit note against this invoice.")
        );
      }
      return {
        cells: [
          invoice.number ?? id,
          invoice.status ?? "—",
          this.stripe.formatAmount(invoice.total, invoice.currency),
          new Date(invoice.created * 1000).toISOString().slice(0, 10),
        ],
        actions: actions.filter((b): b is PanelActionButton => b != null),
      };
    });
    return {
      columns: ["Invoice", "Status", "Total", "Date"],
      rows,
      hasRowActions: true,
      sectionActions: [],
      nextCursor: hasMore && invoices.length > 0 ? invoices[invoices.length - 1].id! : null,
    };
  }

  private async paymentMethodsSection(actor: ActionActor, cus: string): Promise<PanelSection> {
    const [methods, customer] = await Promise.all([
      this.stripe.listAllPaymentMethods(cus),
      this.stripe.getCustomer(cus).catch(() => null),
    ]);
    const defaultPm =
      customer && !customer.deleted && typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : null;
    const rows: PanelRow[] = methods.slice(0, 25).map((pm) => {
      const label =
        pm.type === "card" && pm.card
          ? `${pm.card.brand} •••• ${pm.card.last4} (exp ${pm.card.exp_month}/${pm.card.exp_year})`
          : pm.type;
      const actions = [
        this.button(actor, "customer.payment_method", "Detach", { paymentMethodId: pm.id, op: "detach" }, [],
          "Remove this payment method from the customer."),
        ...(pm.id !== defaultPm
          ? [this.button(actor, "customer.payment_method", "Set default", { paymentMethodId: pm.id, op: "set_default" }, [],
              "Make this the default payment method.")]
          : []),
      ].filter((b): b is PanelActionButton => b != null);
      return { cells: [label, pm.id === defaultPm ? "default" : "—", pm.id], actions };
    });
    return {
      columns: ["Method", "Default", "Id"],
      rows,
      hasRowActions: true,
      sectionActions: [],
      nextCursor: null,
    };
  }

  private async balanceSection(actor: ActionActor, cus: string, cursor: string | null): Promise<PanelSection> {
    const list = await this.stripe.listBalanceTransactions(cus, 10, cursor ?? undefined);
    const rows: PanelRow[] = list.data.map((txn) => ({
      cells: [
        new Date(txn.created * 1000).toISOString().slice(0, 10),
        this.stripe.formatAmount(txn.amount, txn.currency),
        txn.description ?? "—",
      ],
      actions: [],
    }));
    const adjust = this.button(
      actor,
      "customer.balance",
      "Adjust balance",
      {},
      [
        { key: "deltaMinor", label: "Delta (minor units; NEGATIVE = credit)", type: "number" },
        { key: "currency", label: "Currency (3 letters)", type: "text", placeholder: "usd" },
        { key: "note", label: "Note", type: "text" },
      ],
      "Adjusts the customer's invoice balance. Negative credits the customer."
    );
    return {
      columns: ["Date", "Amount", "Description"],
      rows,
      hasRowActions: false,
      sectionActions: adjust ? [adjust] : [],
      nextCursor: list.has_more && list.data.length > 0 ? list.data[list.data.length - 1].id : null,
    };
  }

  private async disputesSection(cus: string): Promise<PanelSection> {
    const disputes = await this.disputeStore.listByCustomer(cus, 10);
    const rows: PanelRow[] = disputes.map((d) => ({
      cells: [
        d.disputeCreatedAt ? d.disputeCreatedAt.toISOString().slice(0, 10) : "—",
        this.stripe.formatAmount(d.amount, d.currency),
        d.status,
        d.reason,
        d.evidenceDueBy ? `due ${d.evidenceDueBy.toISOString().slice(0, 10)}` : "—",
      ],
      actions: [],
    }));
    return {
      columns: ["Opened", "Amount", "Status", "Reason", "Evidence"],
      rows,
      hasRowActions: false,
      sectionActions: [],
      nextCursor: null,
      ...(rows.length === 0 ? { notice: "No disputes on record for this customer (local mirror)." } : { notice: "Read-only — manage disputes in Discord /billing → Disputes." }),
    };
  }

  private async approvalsSection(actor: ActionActor, cursor: string | null): Promise<PanelSection> {
    const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
    const { rows: approvals, total } = await this.billingActions.pendingPage(offset, 10);
    const rows: PanelRow[] = approvals.map((approval) => {
      const canReject = actor.isAdmin || approval.requestedById === actor.id;
      const actions: PanelActionButton[] = [];
      if (actor.isAdmin) {
        actions.push({
          label: approval.status === "FAILED" ? "Retry" : "Approve",
          dangerous: true,
          mode: "direct",
          inputs: [],
          approvalId: approval.id,
          decision: "approve",
          summary: approval.summary,
        });
      }
      if (canReject) {
        actions.push({
          label: "Reject",
          dangerous: false,
          mode: "direct",
          inputs: [],
          approvalId: approval.id,
          decision: "reject",
          summary: approval.summary,
        });
      }
      const state = approval.status === "FAILED" ? `FAILED: ${approval.errorText ?? "error"}` : approval.status;
      return {
        cells: [
          approval.createdAt.toISOString().slice(0, 16).replace("T", " "),
          approval.summary,
          approval.requestedByName,
          state,
        ],
        actions,
      };
    });
    return {
      columns: ["Queued", "Action", "Requested by", "Status"],
      rows,
      hasRowActions: true,
      sectionActions: [],
      nextCursor: offset + 10 < total ? String(offset + 10) : null,
      ...(rows.length === 0 ? { notice: "No pending approvals." } : {}),
      ...(actor.isAdmin ? {} : { notice: rows.length ? "Only configured admins can approve." : "No pending approvals." }),
    };
  }
}
