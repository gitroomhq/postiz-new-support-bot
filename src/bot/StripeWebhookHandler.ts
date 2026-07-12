import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import type Stripe from "stripe";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { StripeClient } from "./StripeClient";
import { DisputeStore } from "./billing/DisputeStore";
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
];

// Programmatically registers a Stripe webhook endpoint (the full-access key can
// create it, so no dashboard access is needed) and turns dispute / early-fraud
// events into staff alerts in the billing audit channel, persists the dispute
// mirror, runs the (default-off) auto-actions and DMs dispute watchers.
// Constructed before the Discord client exists; the client is bound late via
// bindClient().
export class StripeWebhookHandler {
  private client: Client | null = null;

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
      hookLog.warn("stripe webhook: no public base URL configured — registration skipped");
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
      if (!r.ok && r.buffered) throw new TemporalBufferedError("stripe event buffered — Stripe should redeliver");
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
      case "charge.dispute.funds_reinstated":
        await this.onDisputeUpdated(event.type, event.data.object as Stripe.Dispute, firstDelivery);
        return;
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
      default:
        return;
    }
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
          notes.push("⚠️ Auto-cancel subscriptions FAILED — will retry");
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
          notes.push("⚠️ Auto-block FAILED — will retry");
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
          notes.push("⚠️ Receipt auto-attach FAILED — will retry");
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
        { name: "Actionable", value: efw.actionable ? "yes — may lead to a dispute" : "no", inline: true },
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
