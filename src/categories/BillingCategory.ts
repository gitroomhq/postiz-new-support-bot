import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  TextChannel,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  ModalBuilder,
} from "discord.js";
import { BaseCategory } from "./BaseCategory";
import { StripeClient } from "../bot/StripeClient";
import { SessionStore } from "../auth/SessionStore";

export class BillingCategory extends BaseCategory {
  readonly id = "billing";
  readonly label = "Billing";
  readonly emoji = "💳";
  readonly description = "Questions about billing and subscriptions";

  constructor(
    private stripeClient: StripeClient,
    private sessionStore: SessionStore
  ) {
    super();
  }

  protected getInputLabel(): string {
    return "What's your billing question?";
  }

  protected getInputPlaceholder(): string {
    return "e.g. How do I upgrade my plan? I was charged twice...";
  }

  protected buildPrompt(userInput: string): string {
    return `The user has a billing question about Postiz: "${userInput}". Provide helpful information about billing, subscriptions, and payments. If the issue requires manual intervention, let them know to contact support directly.`;
  }

  protected getColor(): number {
    return 0x57f287; // Green
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
    threadsChannel: TextChannel
  ): Promise<void> {
    const value = interaction.values[0];

    if (value === "other") {
      await interaction.showModal(this.buildModal());
      return;
    }

    if (value === "refund") {
      await this.handleRefundRequest(interaction, threadsChannel);
    }
  }

  private async handleRefundRequest(
    interaction: StringSelectMenuInteraction,
    threadsChannel: TextChannel
  ): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const session = await this.sessionStore.getSession(interaction.user.id);
    if (!session?.stripeCustomerId) {
      await interaction.editReply({
        content: "No Stripe account linked to your profile. Please contact support directly.",
      });
      return;
    }

    try {
      const invoice = await this.stripeClient.getLastSubscriptionCharge(session.stripeCustomerId);

      if (!invoice) {
        await interaction.editReply({
          content: "No recent subscription charge found in the last month. If you believe this is an error, please contact support directly.",
        });
        return;
      }

      // Check if this charge was already refunded/discounted
      if (await this.sessionStore.hasBillingAction(invoice.chargeId)) {
        await interaction.editReply({
          content: "This invoice has already been processed for a refund or discount. Please contact support directly for further assistance.",
        });
        return;
      }

      // Create a private thread for this refund conversation
      const thread = await threadsChannel.threads.create({
        name: `💳 ${interaction.user.displayName} — Refund Request`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);

      await interaction.editReply({
        content: `Your refund request thread has been created: ${thread}`,
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
        .setCustomId(`billing_accept_discount:${interaction.user.id}:${invoice.subscriptionId}:${invoice.chargeId}`)
        .setLabel("Yes, 50% off next month")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success);

      const declineButton = new ButtonBuilder()
        .setCustomId(`billing_decline_discount:${interaction.user.id}:${invoice.chargeId}:${invoice.subscriptionId}`)
        .setLabel("No thanks, refund & cancel")
        .setEmoji("💰")
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(acceptButton, declineButton);

      await thread.send({ embeds: [invoiceEmbed], components: [row] });
    } catch (error) {
      console.error("Stripe error:", error);
      await interaction.editReply({
        content: "Something went wrong while looking up your billing information. Please try again later.",
      });
    }
  }

  async handleAcceptDiscount(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const subscriptionId = parts[2];
    const chargeId = parts[3];

    await interaction.deferReply();

    try {
      await this.stripeClient.applyDiscountCoupon(subscriptionId);
      await this.sessionStore.recordBillingAction(interaction.user.id, chargeId, "discount");

      await this.disableButtons(interaction);

      const embed = new EmbedBuilder()
        .setTitle("Discount Applied!")
        .setDescription("A **50% discount** has been applied to your next billing cycle. Thank you for staying with us!")
        .setColor(0x57f287);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Stripe discount error:", error);
      await interaction.editReply({
        content: "Failed to apply the discount. Please contact support directly.",
      });
    }
  }

  async handleDeclineDiscount(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const chargeId = parts[2];
    const subscriptionId = parts[3] || "";

    await this.disableButtons(interaction);

    const confirmButton = new ButtonBuilder()
      .setCustomId(`billing_confirm_refund:${interaction.user.id}:${chargeId}:${subscriptionId}`)
      .setLabel("Yes, process my refund and cancel my subscription")
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`billing_cancel_refund:${interaction.user.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

    await interaction.reply({
      content: "Are you sure you want to proceed with the refund and cancel your subscription? This action cannot be undone.",
      components: [row],
    });
  }

  async handleConfirmRefund(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const chargeId = parts[2];
    const subscriptionId = parts[3] || "";

    await interaction.deferReply();

    try {
      const refund = await this.stripeClient.refundCharge(chargeId);

      // Cancel the active subscription
      const session = await this.sessionStore.getSession(interaction.user.id);
      const cancelTarget = subscriptionId || session?.stripeCustomerId;
      if (cancelTarget) {
        await this.stripeClient.cancelSubscription(cancelTarget);
      }

      await this.sessionStore.recordBillingAction(interaction.user.id, chargeId, "refund");
      const amount = this.stripeClient.formatAmount(refund.amount, refund.currency);

      await this.disableConfirmButtons(interaction);

      const embed = new EmbedBuilder()
        .setTitle("Refund & Subscription Cancellation Processed")
        .setDescription(
          `Your refund of **${amount}** has been processed and your subscription has been cancelled.\n\n` +
          `Refund ID: \`${refund.refundId}\`\n\n` +
          `It may take 5-10 business days to appear on your statement.`
        )
        .setColor(0x57f287);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Stripe refund error:", error);
      await interaction.editReply({
        content: "Failed to process the refund and cancellation. Please contact support directly.",
      });
    }
  }

  async handleCancelRefund(interaction: ButtonInteraction): Promise<void> {
    await this.disableConfirmButtons(interaction);
    await interaction.reply({ content: "Refund cancelled. If you change your mind, please start a new request." });
  }

  private async disableConfirmButtons(interaction: ButtonInteraction): Promise<void> {
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("refund_done")
        .setLabel(interaction.customId.startsWith("billing_confirm_refund:") ? "Refund & Cancellation Processed" : "Cancelled")
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
