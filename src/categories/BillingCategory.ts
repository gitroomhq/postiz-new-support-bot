import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ThreadChannel,
  ModalBuilder,
} from "discord.js";
import { BaseCategory, TicketContext } from "./BaseCategory";
import { embed as makeEmbed, COLORS } from "../util/embeds";
import { StripeClient } from "../bot/StripeClient";
import { SessionStore } from "../auth/SessionStore";
import { SettingsStore } from "../config/SettingsStore";
import { StatusService } from "../bot/StatusService";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { EscalationTierStore } from "../config/EscalationTierStore";
import { BlockStore } from "../bot/billing/BlockStore";
import { log } from "../util/logger";
import { metricCount, metricDistribution } from "../util/instrument";
import { exportBillingEvent } from "../metrics/MetricsExporter";
import type { TemporalProducers } from "../temporal/producers";
import type { RefundOutcome, RefundWorkflowInput } from "../temporal/types";

const billingLog = log.child("billing");

const DAY_MS = 24 * 60 * 60 * 1000;

export class BillingCategory extends BaseCategory {
  readonly id = "billing";
  readonly label = "Billing";
  readonly emoji = "💳";
  readonly description = "Questions about billing and subscriptions";

  constructor(
    private stripeClient: StripeClient,
    private sessionStore: SessionStore,
    private settingsStore: SettingsStore,
    private statusService: StatusService,
    private ticketStore: TicketStore,
    private audit: AuditLogger,
    private tierStore: EscalationTierStore,
    private blockStore: BlockStore
  ) {
    super();
  }

  // Temporal seam: when active, the money movement runs inside the
  // refundWorkflow (workflowId refund-{chargeId} = one more idempotency layer)
  // via the executeRefundCore activity below. Interactive wrappers stay here.
  private temporalProducers: TemporalProducers | null = null;

  setTemporalProducers(producers: TemporalProducers): void {
    this.temporalProducers = producers;
  }

  // Routes the refund core through Temporal when active (null result =
  // Temporal unreachable → run in-process, exactly the legacy behavior).
  private async runRefundCore(input: RefundWorkflowInput): Promise<RefundOutcome> {
    if (this.temporalProducers?.enabled()) {
      const viaWorkflow = await this.temporalProducers.executeRefund(input);
      if (viaWorkflow != null) return viaWorkflow;
    }
    return this.executeRefundCore(input);
  }

  // The money movement shared by the self-service confirm and /charge approve
  // — ALSO the body of the Temporal refundWorkflow's activity. Idempotency:
  // the BillingAction unique-index claim (first, before any Stripe call) and
  // Stripe idempotency keys; "money moved → lock stays" is preserved verbatim.
  async executeRefundCore(input: RefundWorkflowInput): Promise<RefundOutcome> {
    const { customerId, chargeId, subscriptionId, threadId } = input;
    // Claim the charge BEFORE calling Stripe — the unique index on the
    // billing-action row makes exactly one confirm win.
    if (!(await this.sessionStore.claimBillingAction(customerId, chargeId, "refund"))) {
      return { outcome: "already_processed" };
    }

    let refund: { refundId: string; amount: number; currency: string };
    try {
      refund = await this.stripeClient.refundCharge(chargeId, `refund-${chargeId}`);
    } catch (error) {
      billingLog.error("refund failed", error, { "stripe.charge_id": chargeId });
      metricCount("billing.refunds", 1, { outcome: "failed" });
      // Release the lock so the flow can retry; the idempotency key makes a
      // succeeded-at-Stripe retry return the original refund, not a second one.
      await this.sessionStore.releaseBillingAction(chargeId).catch(() => {});
      return { outcome: "refund_failed", error: error instanceof Error ? error.message : String(error) };
    }

    // Money has moved: from here on the lock stays no matter what.
    let cancelFailed = false;
    let cancelledSubscriptionId: string | null = null;
    try {
      if (subscriptionId) {
        await this.stripeClient.cancelSubscription(subscriptionId);
        cancelledSubscriptionId = subscriptionId;
      } else {
        const session = await this.sessionStore.getSession(customerId);
        if (session?.stripeCustomerId) {
          const cancelled = await this.stripeClient.cancelSoleActiveSubscription(session.stripeCustomerId);
          if (cancelled && "ambiguous" in cancelled) {
            // The charge couldn't be tied to a subscription and the customer
            // has several active — don't guess which to cancel; hand to staff.
            cancelFailed = true;
          } else {
            cancelledSubscriptionId = cancelled?.subscriptionId ?? null;
          }
        }
      }
    } catch (error) {
      // Money moved but the cancel didn't — error level: staff must follow up.
      billingLog.error("subscription cancel failed after refund", error, {
        "stripe.charge_id": chargeId,
        "stripe.subscription_id": subscriptionId ?? "",
      });
      cancelFailed = true;
    }

    billingLog.info("billing.refund.processed", {
      "stripe.charge_id": chargeId,
      "stripe.refund_id": refund.refundId,
      "refund.amount": refund.amount,
      "refund.currency": refund.currency,
      "stripe.subscription_id": cancelledSubscriptionId ?? "",
      "refund.cancel_failed": cancelFailed,
      "discord.user_id": customerId,
    });
    metricCount("billing.refunds", 1, { outcome: "processed" });
    metricDistribution("billing.refund_amount", refund.amount, { currency: refund.currency });
    exportBillingEvent({
      event: "refund",
      amountMinor: refund.amount,
      currency: refund.currency,
      chargeId,
      threadId,
    });

    return { outcome: "ok", ...refund, cancelFailed, cancelledSubscriptionId };
  }

  // Staff role for the blocked-charge review ping — the ONE surviving Discord
  // staff ping: refund tickets are never mirrored to Intercom, and the mention
  // is also what pulls staff into the private thread so /charge works.
  private staffPingRoleFor(): string | null {
    return this.tierStore.newTicketRoleId(this.settingsStore.supportRoleId());
  }

  protected getInputLabel(): string {
    return "What's your billing question?";
  }

  protected getInputPlaceholder(): string {
    return "e.g. How do I upgrade my plan? I was charged twice...";
  }

  override async handleButtonPress(interaction: { showModal: (modal: ModalBuilder) => Promise<void> }): Promise<boolean> {
    // Cast to the actual interaction type to access reply()
    const selectInteraction = interaction as unknown as StringSelectMenuInteraction;

    const menu = new StringSelectMenuBuilder()
      .setCustomId("billing_suboption")
      .setPlaceholder("What do you need help with?")
      .addOptions([
        {
          label: "Refund & Cancel Subscription",
          value: "refund",
          description: "Request a refund and cancel your subscription",
          emoji: "💰",
        },
        {
          label: "Other Billing Question",
          value: "other",
          description: "Ask a general billing question",
          emoji: "❓",
        },
      ]);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await selectInteraction.reply({ components: [row], flags: 64 });
    return true;
  }

  async handleBillingSubOption(
    interaction: StringSelectMenuInteraction,
    threadsChannel: TextChannel,
    ctx: TicketContext
  ): Promise<void> {
    const value = interaction.values[0];

    if (value === "other") {
      await interaction.showModal(this.buildModal());
      return;
    }

    if (value === "refund") {
      await this.handleRefundRequest(interaction, threadsChannel, ctx);
    }
  }

  private async handleRefundRequest(
    interaction: StringSelectMenuInteraction,
    threadsChannel: TextChannel,
    ctx: TicketContext
  ): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const blockReason = await ctx.guardTicketCreate(interaction.user.id, interaction.guild);
    if (blockReason) {
      await interaction.editReply({ embeds: [makeEmbed(blockReason, COLORS.warn)] });
      return;
    }

    const session = await this.sessionStore.getSession(interaction.user.id);
    if (!session?.stripeCustomerId) {
      await interaction.editReply({
        embeds: [makeEmbed("No Stripe account linked to your profile. Please contact support directly.", COLORS.danger)],
      });
      return;
    }

    try {
      const invoice = await this.stripeClient.getLastSubscriptionCharge(session.stripeCustomerId);

      if (!invoice) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              "No recent subscription charge found in the last month. If you believe this is an error, please contact support directly.",
              COLORS.warn
            ),
          ],
        });
        return;
      }

      // Check if this charge was already refunded/discounted
      if (await this.sessionStore.hasBillingAction(invoice.chargeId)) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              "This invoice has already been processed for a refund or discount. Please contact support directly for further assistance.",
              COLORS.warn
            ),
          ],
        });
        return;
      }

      // Create a private thread for this refund conversation. Truncation
      // (100-char thread-name cap) may only eat into the display name — the
      // trailing suffix stays intact, mirroring BaseCategory's ticket titles.
      const refundSuffix = " — Refund Request";
      const thread = await threadsChannel.threads.create({
        name: `${interaction.user.displayName.slice(0, 100 - refundSuffix.length)}${refundSuffix}`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);
      // intercomExempt: refund threads live Discord-only (self-service +
      // /charge) — the exact question string doubles as the legacy-ticket
      // match in ensureSchema's backfill, so keep both in sync.
      await ctx.onTicketCreated(thread, interaction.user.id, interaction.user.displayName, "Refund request", {
        intercomExempt: true,
      });

      await interaction.editReply({
        embeds: [makeEmbed(`Your refund request thread has been created: ${thread}`, COLORS.success)],
      });

      const amount = this.stripeClient.formatAmount(invoice.amountPaid, invoice.currency);
      const date = invoice.created.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const invoiceEmbed = new EmbedBuilder()
        .setTitle("Subscription Charge Found")
        .setDescription(
          `We found your most recent subscription charge:\n\n` +
          `**Amount:** ${amount}\n` +
          `**Date:** ${date}\n\n` +
          `Before processing a refund and cancelling your subscription, we'd like to offer you **50% off your next month** instead. Would you like that?`
        )
        .setColor(0x5865f2);

      const acceptButton = new ButtonBuilder()
        .setCustomId(`bill_disc_ok:${interaction.user.id}:${invoice.subscriptionId}:${invoice.chargeId}`)
        .setLabel("Yes, 50% off next month")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success);

      const declineButton = new ButtonBuilder()
        .setCustomId(`bill_disc_no:${interaction.user.id}:${invoice.chargeId}:${invoice.subscriptionId}`)
        .setLabel("No thanks, refund & cancel")
        .setEmoji("💰")
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(acceptButton, declineButton);

      await thread.send({ embeds: [invoiceEmbed], components: [row] });
    } catch (error) {
      billingLog.error("billing lookup failed", error, { "discord.user_id": interaction.user.id });
      await interaction.editReply({
        embeds: [makeEmbed("Something went wrong while looking up your billing information. Please try again later.", COLORS.danger)],
      });
    }
  }

  async handleAcceptDiscount(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const subscriptionId = parts[2];
    const chargeId = parts[3];

    await interaction.deferReply();

    // Claim the charge BEFORE calling Stripe — the unique index on the billing-action row
    // is the lock, so a second confirm (even from a parallel refund thread) loses here.
    if (!(await this.sessionStore.claimBillingAction(interaction.user.id, chargeId, "discount"))) {
      await this.disableButtons(interaction);
      await interaction.editReply({
        embeds: [makeEmbed("This charge has already been processed for a refund or discount.", COLORS.warn)],
      });
      return;
    }

    try {
      await this.stripeClient.applyDiscountCoupon(subscriptionId, `discount-${chargeId}`);
    } catch (error) {
      billingLog.error("discount apply failed", error, {
        "stripe.charge_id": chargeId,
        "stripe.subscription_id": subscriptionId,
      });
      // Release the lock so the customer can retry; the idempotency key makes a
      // succeeded-at-Stripe retry safe.
      await this.sessionStore.releaseBillingAction(chargeId).catch(() => {});
      await interaction.editReply({
        embeds: [makeEmbed("Failed to apply the discount. Please contact support directly.", COLORS.danger)],
      });
      return;
    }

    billingLog.info("billing.discount.applied", {
      "stripe.charge_id": chargeId,
      "stripe.subscription_id": subscriptionId,
      "discord.user_id": interaction.user.id,
    });
    exportBillingEvent({ event: "discount", chargeId, threadId: interaction.channel?.isThread() ? interaction.channelId : null });

    await this.disableButtons(interaction);

    const embed = new EmbedBuilder()
      .setTitle("Discount Applied!")
      .setDescription("A **50% discount** has been applied to your next billing cycle. Thank you for staying with us!")
      .setColor(0x57f287);

    await interaction.editReply({ embeds: [embed] });

    await this.notifyBillingAudit(interaction, {
      action: "Discount",
      outcome: "50% discount applied to the next billing cycle",
      amountText: "50% off next cycle",
      chargeId,
      customerId: interaction.user.id,
    });

    await this.closeTicketThread(interaction);
  }

  async handleDeclineDiscount(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const chargeId = parts[2];
    const subscriptionId = parts[3] || "";

    await this.disableButtons(interaction);

    const confirmButton = new ButtonBuilder()
      .setCustomId(`bill_ref_ok:${interaction.user.id}:${chargeId}:${subscriptionId}`)
      .setLabel("Yes, process my refund and cancel my subscription")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`bill_ref_no:${interaction.user.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

    await interaction.reply({
      embeds: [
        makeEmbed(
          "Are you sure you want to proceed with the refund and cancel your subscription? This action cannot be undone.",
          COLORS.warn
        ),
      ],
      components: [row],
    });
  }

  async handleConfirmRefund(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const chargeId = parts[2];
    const subscriptionId = parts[3] || "";

    await interaction.deferReply();

    // Fresh charge state: drives the amount/age guardrails and catches already-refunded charges.
    let charge: { amount: number; currency: string; refunded: boolean; created: Date; customerId: string | null };
    try {
      charge = await this.stripeClient.getChargeAmount(chargeId);
    } catch (error) {
      billingLog.error("charge lookup failed", error, { "stripe.charge_id": chargeId });
      await interaction.editReply({
        embeds: [makeEmbed("Something went wrong while looking up your charge. Please try again later.", COLORS.danger)],
      });
      return;
    }

    if (charge.refunded) {
      await this.disableConfirmButtons(interaction);
      await interaction.editReply({ embeds: [makeEmbed("This charge has already been refunded.", COLORS.warn)] });
      return;
    }

    const amountText = this.stripeClient.formatAmount(charge.amount, charge.currency);

    // Guardrails: on breach, no Stripe call and no lock row — a human takes over.
    const breach = await this.checkRefundGuardrails(interaction, charge, chargeId);
    if (breach) {
      billingLog.warn("billing.refund.blocked", {
        "stripe.charge_id": chargeId,
        "refund.reason": breach,
        "refund.amount": charge.amount,
        "refund.currency": charge.currency,
        "discord.user_id": interaction.user.id,
      });
      metricCount("billing.refunds", 1, { outcome: "blocked" });
      await this.convertToManualReview(interaction, breach, charge, chargeId, subscriptionId);
      return;
    }

    // Money movement via the shared core (Temporal refundWorkflow when active,
    // in-process otherwise): claim → refund → cancel, triple-idempotent.
    const result = await this.runRefundCore({
      customerId: interaction.user.id,
      chargeId,
      subscriptionId: subscriptionId || null,
      threadId: interaction.channel?.isThread() ? interaction.channelId : null,
    });

    if (result.outcome === "already_processed") {
      await this.disableConfirmButtons(interaction);
      await interaction.editReply({
        embeds: [makeEmbed("This charge has already been processed for a refund or discount.", COLORS.warn)],
      });
      return;
    }
    if (result.outcome === "refund_failed") {
      await interaction.editReply({
        embeds: [makeEmbed("Failed to process the refund and cancellation. Please contact support directly.", COLORS.danger)],
      });
      return;
    }

    const { cancelFailed, cancelledSubscriptionId } = result;
    const refund = { refundId: result.refundId, amount: result.amount, currency: result.currency };
    const amount = this.stripeClient.formatAmount(refund.amount, refund.currency);

    await this.disableConfirmButtons(interaction);

    const embed = new EmbedBuilder()
      .setTitle(cancelFailed ? "Refund Processed" : "Refund & Subscription Cancellation Processed")
      .setDescription(
        `Your refund of **${amount}** has been processed${cancelFailed ? "" : " and your subscription has been cancelled"}.\n\n` +
        `Refund ID: \`${refund.refundId}\`\n\n` +
        (cancelFailed
          ? `We couldn't cancel your subscription automatically — a support member will take care of it shortly.\n\n`
          : "") +
        `It may take 5-10 business days to appear on your statement.`
      )
      .setColor(0x57f287);

    await interaction.editReply({ embeds: [embed] });

    await this.notifyBillingAudit(interaction, {
      action: "Refund",
      outcome: cancelFailed
        ? "⚠️ Refund processed, but subscription cancellation FAILED — manual action needed"
        : cancelledSubscriptionId
          ? `Refund processed, subscription \`${cancelledSubscriptionId}\` cancelled`
          : "Refund processed, subscription cancelled",
      amountText: amount,
      chargeId,
      customerId: interaction.user.id,
    });

    // Keep manual-follow-up threads open so staff actually handle the cancellation.
    if (!cancelFailed) {
      await this.closeTicketThread(interaction);
    }
  }

  // First tripped guardrail as a human-readable reason, or null when all pass.
  private async checkRefundGuardrails(
    interaction: ButtonInteraction,
    charge: { amount: number; currency: string; created: Date; customerId: string | null },
    chargeId: string
  ): Promise<string | null> {
    // Blocklisted customers never self-serve money movement — straight to
    // manual review. Both identities are checked: the invoker's linked Stripe
    // customer AND the charge's customer (they can differ on stale links).
    const sessionCustomer = (await this.sessionStore.getSession(interaction.user.id))?.stripeCustomerId ?? null;
    const chargeCustomer = charge.customerId;
    let blockHit = sessionCustomer ? await this.blockStore.anyBlocked({ customerId: sessionCustomer }) : null;
    if (!blockHit && chargeCustomer && chargeCustomer !== sessionCustomer) {
      blockHit = await this.blockStore.anyBlocked({ customerId: chargeCustomer });
    }
    if (blockHit) {
      return `Customer is on the billing block list (${blockHit.kind}): ${blockHit.reason}`;
    }

    const maxAmount = this.settingsStore.refundMaxAmount();
    if (maxAmount != null) {
      const capCurrency = this.settingsStore.refundMaxAmountCurrency().toLowerCase();
      // Minor units are per-currency (JPY has no decimals), so the cap only compares
      // within its own currency; anything else fails safe to manual review.
      if (charge.currency.toLowerCase() !== capCurrency) {
        return `Charge currency (${charge.currency.toUpperCase()}) differs from the self-service limit currency (${capCurrency.toUpperCase()}).`;
      }
      if (charge.amount > maxAmount) {
        return `Charge amount ${this.stripeClient.formatAmount(charge.amount, charge.currency)} exceeds the self-service limit of ${this.stripeClient.formatAmount(maxAmount, capCurrency)}.`;
      }
    }

    // Charges must be young: "less than N days ago" — age >= N days breaches.
    const maxAgeDays = this.settingsStore.refundMaxChargeAgeDays();
    if (maxAgeDays != null && Date.now() - charge.created.getTime() >= maxAgeDays * DAY_MS) {
      return `Charge is older than the self-service refund window of ${maxAgeDays} day(s).`;
    }

    const maxPer24h = this.settingsStore.refundMaxPer24h();
    if (maxPer24h != null) {
      const count = await this.sessionStore.countRefundsSince(new Date(Date.now() - DAY_MS));
      if (count >= maxPer24h) {
        return `Self-service refund velocity limit reached (${count} refund(s) in the last 24h, limit ${maxPer24h}).`;
      }
    }

    // Per-user cap, applied alongside the global one so a single abuser can't
    // exhaust the global budget for everyone else.
    const maxPer24hPerUser = this.settingsStore.refundMaxPer24hPerUser();
    if (maxPer24hPerUser != null) {
      const userCount = await this.sessionStore.countRefundsSinceForUser(
        interaction.user.id,
        new Date(Date.now() - DAY_MS)
      );
      if (userCount >= maxPer24hPerUser) {
        return `Per-user refund velocity limit reached (${userCount} refund(s) by you in the last 24h, limit ${maxPer24hPerUser}).`;
      }
    }

    const minAgeDays = this.settingsStore.refundMinMemberAgeDays();
    if (minAgeDays != null) {
      const member = interaction.guild
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      const joinedAt = member?.joinedAt ?? null;
      // Unknown membership age fails safe to manual review.
      if (!joinedAt) return "Server membership age could not be verified.";
      if (Date.now() - joinedAt.getTime() < minAgeDays * DAY_MS) {
        return `Server membership is younger than ${minAgeDays} day(s).`;
      }
    }

    // First-refund-only: cheap local ledger check before the Stripe sweep.
    if (await this.sessionStore.hasEverBeenRefunded(interaction.user.id)) {
      return "User has already received a refund via the bot (self-service refunds are first-time only).";
    }

    // Stripe-side refund history — catches dashboard/pre-bot/admin refunds the
    // local ledger can't see. Both identities are swept (stale links, same as
    // the blocklist above). Errors, truncated sweeps and missing identities all
    // fail safe to manual review.
    const historyCustomers = [...new Set([chargeCustomer, sessionCustomer].filter((c): c is string => !!c))];
    if (historyCustomers.length === 0) return "Refund history could not be verified.";
    try {
      for (const customerId of historyCustomers) {
        const history = await this.stripeClient.customerHasAnyRefund(customerId);
        if (history.hasRefund) {
          return "Customer has already received a refund on Stripe (self-service refunds are first-time only).";
        }
        if (history.truncated) return "Refund history could not be verified.";
      }
    } catch (error) {
      billingLog.error("refund history lookup failed", error, { "stripe.charge_id": chargeId });
      return "Refund history could not be verified.";
    }

    return null;
  }

  // A guardrail tripped: hand the thread to a human instead of touching Stripe.
  // The block is persisted so staff can later run /charge approve|deny in the thread.
  private async convertToManualReview(
    interaction: ButtonInteraction,
    reason: string,
    charge: { amount: number; currency: string },
    chargeId: string,
    subscriptionId: string
  ): Promise<void> {
    const amountText = this.stripeClient.formatAmount(charge.amount, charge.currency);
    await this.disableConfirmButtons(interaction, "Pending Manual Review");

    await interaction.editReply({
      embeds: [
        makeEmbed(
          "Your refund request needs a manual review by our team — a support member will follow up here shortly.",
          COLORS.warn
        ),
      ],
    });

    const thread = interaction.channel?.isThread() ? interaction.channel : null;
    if (thread) {
      await this.sessionStore
        .createPendingChargeReview({
          threadId: thread.id,
          chargeId,
          subscriptionId: subscriptionId || null,
          customerId: interaction.user.id,
          amount: charge.amount,
          currency: charge.currency,
          reason,
        })
        .catch((e) => billingLog.error("pending charge review persist failed", e, { "stripe.charge_id": chargeId }));
      exportBillingEvent({
        event: "charge_review_created",
        amountMinor: charge.amount,
        currency: charge.currency,
        chargeId,
        threadId: thread.id,
      });
    }

    const pingRoleId = this.staffPingRoleFor();
    if (thread) {
      await thread
        .send({
          content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
          embeds: [
            makeEmbed(
              `Self-service refund blocked — manual review needed.\n\n**Reason:** ${reason}\n**Amount:** ${amountText}\n**Charge:** \`${chargeId}\`\n\nStaff: run \`/charge approve\` or \`/charge deny\` in this thread.`,
              COLORS.warn
            ),
          ],
          allowedMentions: pingRoleId ? { roles: [pingRoleId] } : { parse: [] },
        })
        .catch(() => {});
    }

    await this.notifyBillingAudit(interaction, {
      action: "Refund",
      outcome: `Blocked — manual review. ${reason}`,
      amountText,
      chargeId,
      customerId: interaction.user.id,
    });
  }

  // Staff audit trail for every executed or blocked billing action. Goes to the configured
  // audit channel; falls back to an in-thread support-role ping (staff are thread members
  // since addSupportMembers). Best-effort — never breaks the customer flow.
  private async notifyBillingAudit(
    interaction: ButtonInteraction | ChatInputCommandInteraction,
    payload: { action: string; outcome: string; amountText: string; chargeId: string; customerId: string }
  ): Promise<void> {
    try {
      const thread = interaction.channel?.isThread() ? interaction.channel : null;
      const embed = new EmbedBuilder()
        .setTitle(`Billing: ${payload.action}`)
        .setColor(COLORS.brand)
        .addFields(
          { name: "Customer", value: `<@${payload.customerId}>`, inline: true },
          { name: "Amount", value: payload.amountText, inline: true },
          { name: "Charge", value: `\`${payload.chargeId}\``, inline: true },
          { name: "Ticket", value: thread ? `<#${thread.id}>` : "—", inline: true },
          { name: "Outcome", value: payload.outcome, inline: false }
        )
        .setTimestamp();

      const channelId = this.settingsStore.billingAuditChannelId();
      if (channelId) {
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (channel?.isSendable()) {
          await channel.send({ embeds: [embed] });
          return;
        }
      }

      const pingRoleId = this.staffPingRoleFor();
      if (thread) {
        await thread.send({
          content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
          embeds: [embed],
          allowedMentions: pingRoleId ? { roles: [pingRoleId] } : { parse: [] },
        });
      }
    } catch (error) {
      billingLog.warn("billing audit notification failed", {
        "error.message": error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Mirror into the general audit trail, unless both settings point at the
      // same channel (the billing embed above already landed there).
      if (this.settingsStore.auditLogChannelId() !== this.settingsStore.billingAuditChannelId()) {
        void this.audit.log({
          title: `💳 Billing: ${payload.action}`,
          severity: "warn",
          threadId: interaction.channel?.isThread() ? interaction.channel.id : undefined,
          fields: [
            { name: "Customer", value: `<@${payload.customerId}>`, inline: true },
            { name: "Amount", value: payload.amountText, inline: true },
            { name: "Charge", value: `\`${payload.chargeId}\``, inline: true },
            { name: "Outcome", value: payload.outcome },
          ],
        });
      }
    }
  }

  // ---- /charge approve|deny: staff resolution of guardrail-blocked refunds ----

  // The pending review for the current thread. Blocks recorded before this feature
  // existed only live as bot messages — recover those by parsing the bot's own
  // "refund blocked" embed and re-fetching the charge from Stripe.
  private async findBlockedCharge(thread: ThreadChannel) {
    const review = await this.sessionStore.getPendingChargeReview(thread.id);
    if (review) return review;

    // Never resurrect a resolved review from the old message.
    if (await this.sessionStore.hasChargeReview(thread.id)) return null;

    const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return null;
    for (const message of messages.values()) {
      if (message.author.id !== thread.client.user?.id) continue;
      const description = message.embeds[0]?.description ?? "";
      if (!description.startsWith("Self-service refund blocked")) continue;

      const chargeId = /\*\*Charge:\*\* `([^`]+)`/.exec(description)?.[1];
      if (!chargeId) continue;
      const reason = /\*\*Reason:\*\* (.+)/.exec(description)?.[1] ?? "Recovered from thread message";

      const ticket = await this.ticketStore.getByThreadId(thread.id).catch(() => null);
      if (!ticket?.customerId) return null;
      const charge = await this.stripeClient.getChargeAmount(chargeId).catch(() => null);
      if (!charge) return null;

      await this.sessionStore.createPendingChargeReview({
        threadId: thread.id,
        chargeId,
        subscriptionId: null, // unknown for old blocks; cancel falls back to the customer's Stripe account
        customerId: ticket.customerId,
        amount: charge.amount,
        currency: charge.currency,
        reason,
      });
      return this.sessionStore.getPendingChargeReview(thread.id);
    }
    return null;
  }

  async approveBlockedCharge(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
    const thread = interaction.channel?.isThread() ? interaction.channel : null;
    if (!thread) {
      await interaction.reply({ embeds: [makeEmbed("Use this inside a refund ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }

    // Recovery can hit Stripe + message history; ack first.
    await interaction.deferReply();

    const review = await this.findBlockedCharge(thread);
    if (!review) {
      await interaction.editReply({ embeds: [makeEmbed("No blocked charge is pending review in this ticket.", COLORS.warn)] });
      return;
    }

    // Fresh charge state: it may have been refunded in the Stripe dashboard meanwhile.
    let charge: { amount: number; currency: string; refunded: boolean };
    try {
      charge = await this.stripeClient.getChargeAmount(review.chargeId);
    } catch (error) {
      billingLog.error("charge lookup failed", error, { "stripe.charge_id": review.chargeId });
      await interaction.editReply({ embeds: [makeEmbed("Couldn't look up the charge on Stripe. Please try again later.", COLORS.danger)] });
      return;
    }

    if (charge.refunded) {
      await this.sessionStore.resolvePendingChargeReview(thread.id, "ALREADY_PROCESSED", member.id);
      await interaction.editReply({ embeds: [makeEmbed("This charge has already been refunded on Stripe — nothing to do.", COLORS.warn)] });
      return;
    }

    // Same lock as the self-service flow (inside the shared core): exactly one
    // refund per charge, ever. Runs through the Temporal refundWorkflow when
    // the regime is active.
    const result = await this.runRefundCore({
      customerId: review.customerId,
      chargeId: review.chargeId,
      subscriptionId: review.subscriptionId ?? null,
      threadId: thread.id,
    });

    if (result.outcome === "already_processed") {
      await this.sessionStore.resolvePendingChargeReview(thread.id, "ALREADY_PROCESSED", member.id);
      await interaction.editReply({ embeds: [makeEmbed("This charge has already been processed for a refund or discount.", COLORS.warn)] });
      return;
    }
    if (result.outcome === "refund_failed") {
      await interaction.editReply({ embeds: [makeEmbed("Failed to process the refund. Please try again or handle it in the Stripe dashboard.", COLORS.danger)] });
      return;
    }

    const { cancelFailed, cancelledSubscriptionId } = result;
    const refund = { refundId: result.refundId, amount: result.amount, currency: result.currency };
    billingLog.info("billing.refund.approved", {
      "stripe.charge_id": review.chargeId,
      "refund.approved_by": member.id,
      "refund.cancel_failed": cancelFailed,
      "stripe.subscription_id": cancelledSubscriptionId ?? "",
    });
    exportBillingEvent({
      event: "charge_review_approved",
      amountMinor: refund.amount,
      currency: refund.currency,
      chargeId: review.chargeId,
      threadId: thread.id,
    });

    await this.sessionStore.resolvePendingChargeReview(thread.id, "APPROVED", member.id);

    const amount = this.stripeClient.formatAmount(refund.amount, refund.currency);
    await interaction.editReply({
      content: `<@${review.customerId}>`,
      embeds: [
        new EmbedBuilder()
          .setTitle(cancelFailed ? "Refund Approved" : "Refund Approved & Subscription Cancelled")
          .setDescription(
            `After manual review, your refund of **${amount}** has been approved and processed${cancelFailed ? "" : ", and your subscription has been cancelled"}.\n\n` +
              `Refund ID: \`${refund.refundId}\`\n\n` +
              (cancelFailed ? "We couldn't cancel your subscription automatically — a support member will take care of it shortly.\n\n" : "") +
              `It may take 5-10 business days to appear on your statement.`
          )
          .setColor(0x57f287),
      ],
      allowedMentions: { users: [review.customerId] },
    });

    await this.notifyBillingAudit(interaction, {
      action: "Refund (manual approval)",
      outcome: `Approved by ${member.displayName}${
        cancelFailed
          ? " — ⚠️ subscription cancellation FAILED, manual action needed"
          : cancelledSubscriptionId
            ? `, subscription \`${cancelledSubscriptionId}\` cancelled`
            : ", subscription cancelled"
      }`,
      amountText: amount,
      chargeId: review.chargeId,
      customerId: review.customerId,
    });

    // Keep manual-follow-up threads open so staff actually handle the cancellation.
    if (!cancelFailed) {
      await this.closeTicketThread(interaction);
    }
  }

  async denyBlockedCharge(interaction: ChatInputCommandInteraction, member: GuildMember): Promise<void> {
    const thread = interaction.channel?.isThread() ? interaction.channel : null;
    if (!thread) {
      await interaction.reply({ embeds: [makeEmbed("Use this inside a refund ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }

    await interaction.deferReply();

    const review = await this.findBlockedCharge(thread);
    if (!review) {
      await interaction.editReply({ embeds: [makeEmbed("No blocked charge is pending review in this ticket.", COLORS.warn)] });
      return;
    }

    const reason = interaction.options.getString("reason")?.trim() || null;
    await this.sessionStore.resolvePendingChargeReview(thread.id, "DENIED", member.id);
    exportBillingEvent({
      event: "charge_review_denied",
      amountMinor: review.amount,
      currency: review.currency,
      chargeId: review.chargeId,
      threadId: thread.id,
    });

    const amountText = this.stripeClient.formatAmount(review.amount, review.currency);
    // The thread stays open so the conversation can continue; staff close it via /status set.
    await interaction.editReply({
      content: `<@${review.customerId}>`,
      embeds: [
        makeEmbed(
          `After manual review, we're unable to process this refund automatically.${reason ? `\n\n**Reason:** ${reason}` : ""}\n\nA support member can help you further here.`,
          COLORS.warn
        ),
      ],
      allowedMentions: { users: [review.customerId] },
    });

    await this.notifyBillingAudit(interaction, {
      action: "Refund (manual review)",
      outcome: `Denied by ${member.displayName}${reason ? ` — ${reason}` : ""}`,
      amountText,
      chargeId: review.chargeId,
      customerId: review.customerId,
    });
  }

  async handleCancelRefund(interaction: ButtonInteraction): Promise<void> {
    await this.disableConfirmButtons(interaction);
    await interaction.reply({ embeds: [makeEmbed("Refund cancelled. If you change your mind, please start a new request.", COLORS.neutral)] });
  }

  // Closes the refund/discount thread once the action succeeds. Routed through
  // StatusService so the Ticket row is marked closed too (it used to bypass the DB and
  // leave refund tickets open in reports forever). silent: the result embed already
  // explains the outcome, and self-service closures shouldn't trigger follow-up prompts.
  private async closeTicketThread(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
    const thread = interaction.channel;
    if (!thread?.isThread()) return;

    const ticket = await this.ticketStore.getByThreadId(thread.id).catch(() => null);
    const closing = this.settingsStore.closingTag();
    if (ticket && closing) {
      await this.statusService
        .applyStatus(thread, ticket, closing, { actorName: interaction.user.displayName, silent: true })
        .catch(() => {});
      return;
    }

    // No closing tag configured or untracked thread — still close what we can.
    if (ticket) await this.ticketStore.close(thread.id).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }

  private async disableConfirmButtons(interaction: ButtonInteraction, label?: string): Promise<void> {
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("refund_done")
        .setLabel(
          label ??
            (interaction.customId.startsWith("bill_ref_ok:") ? "Refund & Cancellation Processed" : "Cancelled")
        )
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });
  }

  private async disableButtons(interaction: ButtonInteraction): Promise<void> {
    const components = interaction.message.components[0];
    if (!components || !("components" in components)) return;

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      (components.components as any[]).map((btn: any) =>
        new ButtonBuilder()
          .setCustomId(btn.customId || "disabled")
          .setLabel(btn.label || "")
          .setStyle(btn.style || ButtonStyle.Secondary)
          .setDisabled(true)
      )
    );

    await interaction.message.edit({ components: [disabledRow] });
  }
}
