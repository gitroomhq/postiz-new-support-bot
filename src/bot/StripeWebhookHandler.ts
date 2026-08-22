import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import type Stripe from "stripe";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { StripeClient } from "./StripeClient";
import { DisputeStore } from "./billing/DisputeStore";
import type { MoneyOutService } from "./billing/MoneyOutService";
import { BlockService } from "./billing/BlockService";
import { attachReceiptEvidence } from "./billing/receiptEvidence";
import { COLORS } from "../util/embeds";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";
import { exportBillingEvent } from "../metrics/MetricsExporter";
import { TemporalBufferedError, type TemporalProducers } from "../temporal/producers";

const hookLog = log.child("stripe-webhook");

// Ingested events (chosen in /config): the full dispute lifecycle + early
// fraud warnings. All are high-severity, time-sensitive billing signals that
// don't require any dashboard configuration. Changing this array requires
// ensureEndpoint() to reconcile enabled_events on the existing endpoint —
// which it does (see below) — so a deploy converges on next boot.
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "radar.early_fraud_warning.created",
  "radar.early_fraud_warning.updated",
  // SLA manager triggers only (no alerts): plan changes re-run the SLA rules
  // for the customer's open tickets. ensureEndpoint reconciles enabled_events
  // on next boot, so the addition converges without dashboard access.
  "customer.subscription.updated",
  "customer.subscription.deleted",
  // Money-out ledger. These are what make an outflow visible no matter WHERE it
  // was made — a refund issued straight from the Stripe Dashboard reaches us
  // only through these. The refund/charge events trigger a targeted sweep of
  // the object's balance transactions (the ledger stays the single writer of
  // cash rows); the rest are concessions, which have no balance transaction at
  // all and are recorded directly.
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.refunded",
  "credit_note.created",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "customer.discount.created",
];

// Programmatically registers a Stripe webhook endpoint (the full-access key can
// create it, so no dashboard access is needed) and turns dispute / early-fraud
// events into staff alerts in the billing audit channel, persists the dispute
// mirror, runs the (default-off) auto-actions and DMs dispute watchers.
// Constructed before the Discord client exists; the client is bound late via
// bindClient().
export class StripeWebhookHandler {
  private client: Client | null = null;
  // SLA manager — bound late from index.ts; billing events re-run the SLA
  // rules for the affected customer's open tickets (fire-and-forget).
  private slaService: { onStripeCustomerTrigger(stripeCustomerId: string): Promise<void> } | null = null;

  constructor(
    private settings: SettingsStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private blockService: BlockService,
    private auditChannelFallback = true
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  setSlaService(service: { onStripeCustomerTrigger(stripeCustomerId: string): Promise<void> }): void {
    this.slaService = service;
  }

  // Money-out ledger — bound late (it depends on the Prisma-backed store built
  // after this handler). Absent until then, which simply means an outflow waits
  // for the reconcile tick instead of landing in seconds.
  private moneyOut: MoneyOutService | null = null;

  setMoneyOutService(service: MoneyOutService): void {
    this.moneyOut = service;
  }

  // Read per request — the secret lives in BotSettings and can rotate live.
  getSecret(): string | null {
    return this.settings.stripeWebhookSecret();
  }

  constructEvent(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
    return this.stripe.constructWebhookEvent(rawBody, signature, secret);
  }

  // Idempotent reconciliation, run on boot (when enabled) and from the /config
  // buttons. force=true always recreates (used by "Rotate secret", the only way
  // to obtain a fresh signing secret). Returns a short status for the UI.
  async ensureEndpoint(force = false): Promise<{ status: string; detail?: string }> {
    if (!this.settings.stripeWebhookEnabled()) return { status: "disabled" };
    const base = this.settings.resolvedPublicBaseUrl();
    if (!base) {
      hookLog.warn("stripe webhook: no public base URL configured; registration skipped");
      return { status: "no-url" };
    }
    const url = `${base}/stripe/webhook`;
    const endpoints = await this.stripe.listWebhookEndpoints();
    const storedId = this.settings.stripeWebhookEndpointId();
    // Raw-column check, NOT the resolved value: a secret held in Vault while
    // Vault is unreachable must count as "have" — resolving to null here would
    // recreate the endpoint (rotating the secret) on every boot of an outage.
    const haveSecret = this.settings.stripeWebhookSecretConfigured();

    // A working, still-present endpoint whose secret we hold — keep it, but
    // converge BOTH the URL and the subscribed event set: a deploy that adds
    // event types would otherwise silently never receive them.
    if (!force && storedId && haveSecret) {
      const existing = endpoints.find((e) => e.id === storedId);
      if (existing) {
        const eventsMatch =
          existing.enabled_events.length === EVENTS.length &&
          EVENTS.every((event) => existing.enabled_events.includes(event));
        if (existing.url !== url || !eventsMatch) {
          await this.stripe.updateWebhookEndpoint(storedId, { url, enabled_events: EVENTS });
          hookLog.info("stripe webhook endpoint reconciled", {
            "stripe.webhook_endpoint": storedId,
            "stripe.webhook_url_changed": existing.url !== url,
            "stripe.webhook_events_changed": !eventsMatch,
          });
          return { status: "updated", detail: url };
        }
        return { status: "ok", detail: url };
      }
    }

    // (Re)create with a fresh secret (unique idempotency key so a rotate isn't
    // served the cached prior response), then delete any other endpoint pointing
    // at our URL so exactly one remains.
    const created = await this.stripe.createWebhookEndpoint(url, EVENTS, `stripe-webhook-${Date.now()}`);
    await this.settings.updateStripeWebhook({
      stripeWebhookEndpointId: created.id,
      stripeWebhookSecret: created.secret ?? null,
    });
    for (const e of endpoints) {
      if (e.url === url && e.id !== created.id) {
        await this.stripe.deleteWebhookEndpoint(e.id).catch(() => {});
      }
    }
    hookLog.info("stripe webhook endpoint created", { "stripe.webhook_endpoint": created.id });
    return { status: created.secret ? "created" : "created-no-secret", detail: created.id };
  }

  // Deletes the registered endpoint and clears its stored id/secret (toggle off).
  async disableEndpoint(): Promise<void> {
    const id = this.settings.stripeWebhookEndpointId();
    if (id) await this.stripe.deleteWebhookEndpoint(id).catch(() => {});
    await this.settings.updateStripeWebhook({ stripeWebhookEndpointId: null, stripeWebhookSecret: null });
  }

  // Verified event → dedup → dispatch. Best-effort: a handler failure never
  // rethrows out of the HTTP route (we already 200'd).
  // Temporal seam: each verified event becomes a stripeEventWorkflow
  // (workflowId = event id ⇒ server-side dedup on top of the claim below)
  // whenever Temporal is configured — a paused worker just parks the workflow
  // until resume. A buffered start (Temporal down) throws
  // TemporalBufferedError so the route answers 503 and Stripe redelivers;
  // handleDirect stays as the unconfigured-bootstrap fallback.
  private temporalProducers: TemporalProducers | null = null;

  setTemporalProducers(producers: TemporalProducers): void {
    this.temporalProducers = producers;
  }

  async handle(event: Stripe.Event): Promise<void> {
    if (this.temporalProducers?.routable()) {
      const r = await this.temporalProducers.stripeEvent(event.id, JSON.stringify(event), event.type);
      if (!r.ok && r.buffered) throw new TemporalBufferedError("stripe event buffered; Stripe should redeliver");
      return;
    }
    await this.handleDirect(event);
  }

  // The actual processing — the body of the Temporal handleStripeEvent
  // activity (retry: 5 attempts) and of the legacy path. Idempotency layout:
  //  - claimStripeEvent gates the ALERT only (at-most-once noise),
  //  - the dispute-mirror upsert is idempotent and runs on every delivery,
  //  - auto-actions carry their own per-(dispute, action) claims and STABLE
  //    Stripe idempotency keys, and their failures RETHROW — that's what makes
  //    the activity retry actually re-run them (redeliveries no-op via the
  //    claims; a crash after money moved keeps the claim, so no double cancel).
  async handleDirect(event: Stripe.Event): Promise<void> {
    if (!this.settings.stripeWebhookEnabled()) return; // toggled off after an event was in flight
    const firstDelivery = await this.sessionStore.claimStripeEvent(event.id, event.type);
    metricCount("stripe.webhook_events", 1, { type: event.type, deduped: !firstDelivery });

    switch (event.type) {
      case "charge.dispute.created":
        await this.onDisputeCreated(event.data.object as Stripe.Dispute, firstDelivery);
        return;
      case "charge.dispute.updated":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated": {
        const dispute = event.data.object as Stripe.Dispute;
        await this.onDisputeUpdated(event.type, dispute, firstDelivery);
        // Funds events are the moment dispute money (and the chargeback fee)
        // actually moves — sweep so both land in the ledger. The fee exists
        // ONLY on the balance transaction, which is why the webhook payload
        // alone can never tell us what a dispute cost.
        //
        // Sweep by the DISPUTE id, not the charge: a balance transaction's
        // `source` is the object that produced it (dp_…), so filtering by ch_…
        // would return the original charge's transaction and nothing else.
        if (event.type === "charge.dispute.funds_withdrawn" || event.type === "charge.dispute.funds_reinstated") {
          await this.syncMoneyOut(dispute.id, event.type);
        }
        return;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // SLA-only: plan/subscription changes re-run the SLA rules for the
        // customer's open tickets. No alert, no mirror.
        const sub = event.data.object as Stripe.Subscription;
        const cus = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        if (cus) void this.slaService?.onStripeCustomerTrigger(cus);
        return;
      }
      case "radar.early_fraud_warning.created":
        if (!firstDelivery) return;
        try {
          await this.onFraudWarning(event.data.object as Stripe.Radar.EarlyFraudWarning);
        } catch (e) {
          hookLog.error("stripe webhook handler failed", e, { "stripe.event_type": event.type });
        }
        return;
      case "radar.early_fraud_warning.updated":
        // State-freshness only (actionable flips when the EFW gets disputed or
        // refunded) — nothing local mirrors EFWs, so this is just a metric.
        return;
      case "refund.created":
      case "refund.updated":
      case "refund.failed": {
        // Targeted sweep of THIS refund's balance transactions. Deliberately
        // not a direct write: the ledger sweep stays the single writer of cash
        // rows, which is what makes webhook / reconcile / backfill idempotent.
        // Runs on retries too — upsert-by-id makes that free.
        const refund = event.data.object as Stripe.Refund;
        await this.syncMoneyOut(refund.id, event.type);
        return;
      }
      case "charge.refunded": {
        // Belt to refund.created's braces: a Stripe-Dashboard refund may reach
        // us here first. Sweep each REFUND, not the charge — a balance
        // transaction's `source` is the object that produced it (re_…), so
        // filtering by ch_… returns the original charge's transaction and
        // misses every refund on it.
        const charge = event.data.object as Stripe.Charge;
        for (const refund of charge.refunds?.data ?? []) {
          await this.syncMoneyOut(refund.id, event.type);
        }
        return;
      }
      case "credit_note.created": {
        if (!firstDelivery) return;
        const note = event.data.object as Stripe.CreditNote;
        await this.moneyOut?.recordCreditNote(note, "webhook").catch((e) => {
          hookLog.warn("money-out credit note failed", { "error.message": String(e) });
        });
        exportBillingEvent({
          event: "credit_note",
          amountMinor: note.total,
          currency: note.currency,
        });
        return;
      }
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        if (!firstDelivery) return;
        const invoice = event.data.object as Stripe.Invoice;
        await this.moneyOut?.recordWriteOff(invoice, "webhook").catch((e) => {
          hookLog.warn("money-out write-off failed", { "error.message": String(e) });
        });
        exportBillingEvent({
          event: "write_off",
          amountMinor: invoice.amount_due - (invoice.amount_paid ?? 0),
          currency: invoice.currency,
          reason: event.type,
        });
        return;
      }
      case "customer.discount.created": {
        if (!firstDelivery) return;
        await this.onDiscountCreated(event.data.object as Stripe.Discount);
        return;
      }
      default:
        return;
    }
  }

  // Targeted money-out sweep. Best-effort by construction: a metrics gap must
  // never fail webhook processing, because a thrown error here would make
  // Stripe redeliver an event whose ALERTING half already ran.
  private async syncMoneyOut(sourceId: string, eventType: string): Promise<void> {
    if (!this.moneyOut) return;
    try {
      await this.moneyOut.syncForObject(sourceId);
    } catch (e) {
      hookLog.warn("money-out sync failed", {
        "stripe.event_type": eventType,
        "stripe.source_id": sourceId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  // A discount's cost is only knowable against what it will be applied to, so
  // resolve the base from the subscription it landed on (or the customer's
  // upcoming invoice). No base = no row: an unquantified concession is worse
  // than a missing one, because it would silently read as zero.
  private async onDiscountCreated(discount: Stripe.Discount): Promise<void> {
    if (!this.moneyOut) return;
    const customerId = typeof discount.customer === "string" ? discount.customer : (discount.customer?.id ?? null);
    // SDK v20 moved the coupon behind discount.source; it can still arrive
    // unexpanded as a bare id, which carries no percent/amount to price.
    const rawCoupon = discount.source?.coupon ?? null;
    const coupon = rawCoupon && typeof rawCoupon !== "string" ? rawCoupon : null;
    if (!coupon) return;

    let baseMinor = 0;
    let currency = coupon.currency ?? "usd";
    // A flat amount_off prices itself; only a percentage needs a base.
    if (coupon.percent_off != null) {
      const subscriptionId = typeof discount.subscription === "string" ? discount.subscription : null;
      const priced = await this.moneyOut.priceDiscountBase(customerId, subscriptionId).catch((e) => {
        hookLog.warn("money-out discount base lookup failed", { "error.message": String(e) });
        return null;
      });
      if (!priced) {
        // Better a loud gap than a silent zero: a discount booked at 0 would
        // read as "this concession cost nothing", which is worse than absent.
        hookLog.warn("money-out discount not priced", {
          "stripe.discount_id": discount.id,
          "stripe.customer_id": customerId ?? "",
          "money_out.reason": "no subscription line items or upcoming invoice to price the percentage against",
        });
        return;
      }
      baseMinor = priced.baseMinor;
      currency = priced.currency;
    }

    await this.moneyOut
      .recordDiscount({
        discountId: discount.id,
        customerId,
        currency,
        baseMinor,
        percentOff: coupon.percent_off,
        amountOffMinor: coupon.amount_off,
        // Duration matters for reading the number later: this books ONE billing
        // cycle, so a repeating/forever coupon is worth more than recorded.
        reason: `${coupon.name ?? coupon.id}${coupon.duration ? ` (${coupon.duration})` : ""}`,
        occurredAt: new Date((discount.start ?? Math.floor(Date.now() / 1000)) * 1000),
        source: "webhook",
      })
      .catch((e) => {
        hookLog.warn("money-out discount record failed", { "error.message": String(e) });
      });
  }

  private async onDisputeCreated(dispute: Stripe.Dispute, firstDelivery: boolean): Promise<void> {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const customerId = chargeId ? await this.stripe.getChargeCustomerId(chargeId).catch(() => null) : null;

    // Mirror first (idempotent; runs on retries too).
    try {
      await this.disputeStore.upsertFromStripe(dispute, customerId);
    } catch (e) {
      hookLog.error("dispute mirror upsert failed", e, { "stripe.dispute_id": dispute.id });
    }

    // SLA manager: a fresh dispute may flip stripe.dispute-conditioned rules.
    if (customerId) void this.slaService?.onStripeCustomerTrigger(customerId);

    // Auto-actions (default-off toggles). Each holds its own claim so a
    // redelivery or activity retry converges; failures rethrow AFTER the alert
    // so Temporal retries the actions.
    const notes: string[] = [];
    let autoActionError: unknown = null;

    if (this.settings.disputeAutoCancelSub() && customerId) {
      const claimed = await this.sessionStore
        .claimBillingAction("system", `dispute-autocancel-${dispute.id}`, "dispute_autocancel")
        .catch(() => false);
      if (claimed) {
        try {
          const result = await this.stripe.cancelAllActiveSubscriptions(customerId, `dp-autocancel-${dispute.id}`);
          if (result.cancelled.length || result.failed.length) {
            notes.push(
              `🔚 Auto-cancel: ${result.cancelled.length} subscription(s) cancelled${result.failed.length ? `, ⚠️ ${result.failed.length} FAILED` : ""}`
            );
          } else {
            notes.push("🔚 Auto-cancel: no active subscriptions");
          }
          if (result.failed.length) throw new Error(`auto-cancel failed for: ${result.failed.join(", ")}`);
        } catch (e) {
          await this.sessionStore.releaseBillingAction(`dispute-autocancel-${dispute.id}`).catch(() => {});
          notes.push("⚠️ Auto-cancel subscriptions FAILED. Will retry");
          autoActionError = e;
        }
      }
    }

    if (this.settings.disputeAutoBlock() && chargeId) {
      const claimed = await this.sessionStore
        .claimBillingAction("system", `dispute-autoblock-${dispute.id}`, "dispute_autoblock")
        .catch(() => false);
      if (claimed) {
        try {
          const results = await this.blockService.autoBlockFromCharge(chargeId, dispute.id, customerId);
          const ok = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);
          if (ok.length) {
            notes.push(`⛔ Auto-block: ${ok.map((r) => r.kind).join(", ")} blocked`);
            for (const r of ok) exportBillingEvent({ event: "block", chargeId });
          }
          if (failed.length) throw new Error(`auto-block failed for: ${failed.map((r) => `${r.kind} (${r.error})`).join("; ")}`);
        } catch (e) {
          await this.sessionStore.releaseBillingAction(`dispute-autoblock-${dispute.id}`).catch(() => {});
          notes.push("⚠️ Auto-block FAILED. Will retry");
          autoActionError = autoActionError ?? e;
        }
      }
    }

    // Receipt auto-attach (defaults ON — stages with submit:false, nothing
    // reaches the bank). "No receipt available" keeps the claim: retrying
    // won't conjure one; genuine failures release + rethrow like the others.
    if (this.settings.disputeAutoAttachReceipt() && chargeId) {
      const claimed = await this.sessionStore
        .claimBillingAction("system", `dispute-receipt-${dispute.id}`, "dispute_receipt")
        .catch(() => false);
      if (claimed) {
        try {
          const result = await attachReceiptEvidence(this.stripe, dispute);
          if (result.attached) {
            notes.push("🧾 Receipt auto-staged in the `receipt` evidence slot (submit still manual)");
          } else if (result.reason === "no_receipt") {
            notes.push("🧾 Receipt auto-attach: no receipt PDF available for this charge");
          }
        } catch (e) {
          await this.sessionStore.releaseBillingAction(`dispute-receipt-${dispute.id}`).catch(() => {});
          notes.push("⚠️ Receipt auto-attach FAILED. Will retry");
          autoActionError = autoActionError ?? e;
        }
      }
    }

    // Alert exactly once per event id.
    if (firstDelivery) {
      try {
        exportBillingEvent({ event: "dispute", amountMinor: dispute.amount, currency: dispute.currency, chargeId });
        const linked = chargeId ? await this.linkedCustomer(chargeId) : null;
        const embed = new EmbedBuilder()
          .setTitle("⚠️ Stripe dispute opened")
          .setColor(COLORS.danger)
          .addFields(
            { name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true },
            { name: "Reason", value: dispute.reason || "unknown", inline: true },
            { name: "Status", value: dispute.status || "unknown", inline: true },
            ...(chargeId ? [{ name: "Charge", value: `\`${chargeId}\``, inline: true }] : []),
            ...(dispute.evidence_details?.due_by
              ? [{ name: "Evidence due", value: `<t:${dispute.evidence_details.due_by}:R>`, inline: true }]
              : []),
            ...(linked ? [{ name: "Customer", value: linked, inline: false }] : []),
            ...(notes.length ? [{ name: "Auto-actions", value: notes.join("\n").slice(0, 1024), inline: false }] : [])
          )
          .setTimestamp();

        const buttons: ButtonBuilder[] = [
          new ButtonBuilder().setCustomId(`billadmin_dpa_open:${dispute.id}`).setLabel("Open Dispute").setStyle(ButtonStyle.Primary),
        ];
        if (chargeId && !this.settings.disputeAutoBlock()) {
          buttons.push(
            new ButtonBuilder().setCustomId(`billadmin_dpa_block:${chargeId}`).setLabel("Block").setStyle(ButtonStyle.Danger)
          );
        }
        if (chargeId && dispute.is_charge_refundable) {
          buttons.push(
            new ButtonBuilder().setCustomId(`billadmin_dpa_refund:${chargeId}`).setLabel("Refund to Prevent").setStyle(ButtonStyle.Secondary)
          );
        }
        await this.postAlert(embed, [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)]);
      } catch (e) {
        hookLog.error("dispute alert failed", e, { "stripe.dispute_id": dispute.id });
      }
    }

    if (autoActionError) throw autoActionError;
  }

  private async onDisputeUpdated(eventType: string, dispute: Stripe.Dispute, firstDelivery: boolean): Promise<void> {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const before = await this.disputeStore.get(dispute.id).catch(() => null);
    const customerId =
      before?.customerId ?? (chargeId ? await this.stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    try {
      await this.disputeStore.upsertFromStripe(dispute, customerId);
    } catch (e) {
      hookLog.error("dispute mirror upsert failed", e, { "stripe.dispute_id": dispute.id });
    }

    // SLA manager: a closing/reopening dispute may flip stripe.dispute rules.
    if (customerId) void this.slaService?.onStripeCustomerTrigger(customerId);

    if (!firstDelivery) return;

    try {
      const statusChanged = before?.status !== dispute.status;
      const isClosed = eventType === "charge.dispute.closed";
      const isFunds = eventType === "charge.dispute.funds_withdrawn" || eventType === "charge.dispute.funds_reinstated";

      if (isClosed) {
        const kind = dispute.status === "won" ? "dispute_won" : dispute.status === "lost" ? "dispute_lost" : "dispute_updated";
        exportBillingEvent({ event: kind, amountMinor: dispute.amount, currency: dispute.currency, chargeId });
      } else if (statusChanged) {
        exportBillingEvent({ event: "dispute_updated", amountMinor: dispute.amount, currency: dispute.currency, chargeId });
      }

      // Alerts only for real state changes — evidence staging from our own
      // panel fires charge.dispute.updated too, and that would just be noise.
      if (isClosed || isFunds || (statusChanged && eventType === "charge.dispute.updated")) {
        const won = dispute.status === "won" || dispute.status === "prevented";
        const title = isClosed
          ? won
            ? "🏆 Stripe dispute WON"
            : dispute.status === "lost"
              ? "❌ Stripe dispute LOST"
              : `Stripe dispute closed (${dispute.status})`
          : eventType === "charge.dispute.funds_withdrawn"
            ? "💸 Dispute funds withdrawn"
            : eventType === "charge.dispute.funds_reinstated"
              ? "💰 Dispute funds reinstated"
              : `🚩 Dispute status: ${dispute.status}`;
        const linked = chargeId ? await this.linkedCustomer(chargeId) : null;
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setColor(isClosed ? (won ? COLORS.success : COLORS.danger) : COLORS.warn)
          .addFields(
            { name: "Dispute", value: `\`${dispute.id}\``, inline: true },
            { name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true },
            { name: "Status", value: dispute.status, inline: true },
            ...(chargeId ? [{ name: "Charge", value: `\`${chargeId}\``, inline: true }] : []),
            ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
          )
          .setTimestamp();
        await this.postAlert(embed, [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`billadmin_dpa_open:${dispute.id}`).setLabel("Open Dispute").setStyle(ButtonStyle.Primary)
          ),
        ]);
      }

      // Watch DMs on status transitions and funds movement.
      if (statusChanged || isFunds) {
        await this.notifyWatchers(dispute, eventType);
      }
    } catch (e) {
      hookLog.error("dispute update handling failed", e, { "stripe.event_type": eventType });
    }
  }

  // DM every admin watching this dispute. Buttons don't work in DMs (the admin
  // gate needs guild permissions), so the DM is informational with ids to jump
  // to via /billing → Jump to ID.
  private async notifyWatchers(dispute: Stripe.Dispute, eventType: string): Promise<void> {
    if (!this.client) return;
    const watchers = await this.disputeStore.watchers(dispute.id).catch(() => []);
    if (watchers.length === 0) return;
    const what =
      eventType === "charge.dispute.funds_withdrawn"
        ? "funds were withdrawn"
        : eventType === "charge.dispute.funds_reinstated"
          ? "funds were reinstated"
          : `status is now **${dispute.status}**`;
    const text =
      `🔔 Watched dispute \`${dispute.id}\` (${this.stripe.formatAmount(dispute.amount, dispute.currency)}, ${dispute.reason}): ${what}.\n` +
      `Open it via **/billing → Disputes** or **Jump to ID**.`;
    for (const userId of watchers) {
      const user = await this.client.users.fetch(userId).catch(() => null);
      await user?.send(text).catch(() => {}); // closed DMs are fine
    }
  }

  private async onFraudWarning(efw: Stripe.Radar.EarlyFraudWarning): Promise<void> {
    const chargeId = typeof efw.charge === "string" ? efw.charge : (efw.charge?.id ?? null);
    exportBillingEvent({ event: "fraud_warning", chargeId });
    const linked = chargeId ? await this.linkedCustomer(chargeId) : null;
    const embed = new EmbedBuilder()
      .setTitle("🚨 Stripe early fraud warning")
      .setColor(COLORS.danger)
      .addFields(
        { name: "Fraud type", value: efw.fraud_type || "unknown", inline: true },
        { name: "Actionable", value: efw.actionable ? "yes (may lead to a dispute)" : "no", inline: true },
        ...(chargeId ? [{ name: "Charge", value: `\`${chargeId}\``, inline: true }] : []),
        ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
      )
      .setTimestamp();
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (chargeId) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`billadmin_dpa_block:${chargeId}`).setLabel("Block").setStyle(ButtonStyle.Danger)
      );
      if (efw.actionable) {
        row.addComponents(
          new ButtonBuilder().setCustomId(`billadmin_dpa_refund:${chargeId}`).setLabel("Refund to Prevent").setStyle(ButtonStyle.Secondary)
        );
      }
      components.push(row);
    }
    await this.postAlert(embed, components);
  }

  // Best-effort: the charge's customer → any linked Discord users. Mentions live
  // in an embed field so they inform staff without pinging the customer.
  private async linkedCustomer(chargeId: string): Promise<string | null> {
    try {
      const customerId = await this.stripe.getChargeCustomerId(chargeId);
      if (!customerId) return null;
      const ids = await this.sessionStore.findDiscordIdsByStripeId(customerId);
      return ids.length ? `${ids.map((id) => `<@${id}>`).join(", ")} (\`${customerId}\`)` : `\`${customerId}\` (no linked Discord user)`;
    } catch {
      return null;
    }
  }

  private async postAlert(embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []): Promise<void> {
    const channelId =
      this.settings.billingAuditChannelId() ?? (this.auditChannelFallback ? this.settings.auditLogChannelId() : null);
    if (!this.client || !channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;
    await channel.send({ embeds: [embed], components }).catch(() => {});
  }
}
