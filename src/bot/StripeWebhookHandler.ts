import { Client, EmbedBuilder } from "discord.js";
import type Stripe from "stripe";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { StripeClient } from "./StripeClient";
import { COLORS } from "../util/embeds";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";
import { exportBillingEvent } from "../metrics/MetricsExporter";
import { TemporalBufferedError, type TemporalProducers } from "../temporal/producers";

const hookLog = log.child("stripe-webhook");

// Only these two events are ingested (chosen in /config). Both are high-severity,
// time-sensitive billing signals that don't require any dashboard configuration.
const EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "charge.dispute.created",
  "radar.early_fraud_warning.created",
];

// Programmatically registers a Stripe webhook endpoint (the full-access key can
// create it, so no dashboard access is needed) and turns dispute / early-fraud
// events into staff alerts in the billing audit channel. Constructed before the
// Discord client exists; the client is bound late via bindClient().
export class StripeWebhookHandler {
  private client: Client | null = null;

  constructor(
    private settings: SettingsStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
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

    // A working, still-present endpoint whose secret we hold — keep it (just fix
    // the URL if the public base changed).
    if (!force && storedId && haveSecret) {
      const existing = endpoints.find((e) => e.id === storedId);
      if (existing) {
        if (existing.url !== url) {
          await this.stripe.updateWebhookEndpoint(storedId, { url, enabled_events: EVENTS });
          hookLog.info("stripe webhook endpoint url updated", { "stripe.webhook_endpoint": storedId });
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

  // The actual processing (dedup claim + dispute/fraud alerts) — the body of
  // the Temporal handleStripeEvent activity and of the legacy path.
  async handleDirect(event: Stripe.Event): Promise<void> {
    if (!this.settings.stripeWebhookEnabled()) return; // toggled off after an event was in flight
    if (!(await this.sessionStore.claimStripeEvent(event.id, event.type))) {
      metricCount("stripe.webhook_events", 1, { type: event.type, deduped: true });
      return;
    }
    metricCount("stripe.webhook_events", 1, { type: event.type, deduped: false });
    try {
      if (event.type === "charge.dispute.created") {
        await this.onDispute(event.data.object as Stripe.Dispute);
      } else if (event.type === "radar.early_fraud_warning.created") {
        await this.onFraudWarning(event.data.object as Stripe.Radar.EarlyFraudWarning);
      }
    } catch (e) {
      hookLog.error("stripe webhook handler failed", e, { "stripe.event_type": event.type });
    }
  }

  private async onDispute(dispute: Stripe.Dispute): Promise<void> {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
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
        ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
      )
      .setTimestamp();
    await this.postAlert(embed);
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
    await this.postAlert(embed);
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

  private async postAlert(embed: EmbedBuilder): Promise<void> {
    const channelId =
      this.settings.billingAuditChannelId() ?? (this.auditChannelFallback ? this.settings.auditLogChannelId() : null);
    if (!this.client || !channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return;
    await channel.send({ embeds: [embed] }).catch(() => {});
  }
}
