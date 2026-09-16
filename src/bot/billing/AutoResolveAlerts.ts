import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import type { SettingsStore } from "../../config/SettingsStore";
import type { StripeClient } from "../StripeClient";
import type { SessionStore } from "../../auth/SessionStore";
import type { IntercomClient } from "../../intercom/IntercomClient";
import type { DisputeAutoResolve } from "../../generated/prisma/client";
import type { AutoResolveAlerts, AutoResolveSideEffects } from "./AutoResolveService";
import { COLORS } from "../../util/embeds";
import { RATES_SAMPLED_AT } from "./fx";
import { log } from "../../util/logger";

const alertLog = log.child("dispute-auto-resolve-alerts");

// Discord and Intercom adapters for the auto-resolve engine, kept out of the
// service so the drain itself stays testable without discord.js.
//
// The proposal alert is the ONLY thing standing between a proposal and money
// leaving the account, so the drain refuses to execute any row this class has
// not successfully posted.
export class DiscordAutoResolveAlerts implements AutoResolveAlerts {
  private client: Client | null = null;

  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  private async send(
    embed: EmbedBuilder,
    components: ActionRowBuilder<ButtonBuilder>[] = []
  ): Promise<{ channelId: string; messageId: string } | null> {
    const channelId = this.settings.billingAuditChannelId() ?? this.settings.auditLogChannelId();
    if (!this.client || !channelId) return null;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return null;
    const message = await channel.send({ embeds: [embed], components }).catch((error) => {
      alertLog.warn("auto-resolve alert send failed", { "error.message": String(error) });
      return null;
    });
    return message ? { channelId, messageId: message.id } : null;
  }

  private common(row: DisputeAutoResolve): Array<{ name: string; value: string; inline: boolean }> {
    return [
      { name: "Stage", value: row.stage === "efw" ? "Early fraud warning" : "Dispute inquiry", inline: true },
      { name: "Amount", value: this.stripe.formatAmount(row.amountMinor, row.currency), inline: true },
      // Worded so nobody mistakes the comparison figure for real money.
      {
        name: "Approx. USD",
        value: `~$${(row.usdMinor / 100).toFixed(2)} (rates sampled ${RATES_SAMPLED_AT})`,
        inline: true,
      },
      { name: "Reason", value: row.reason.replace(/_/g, " "), inline: true },
      { name: "Charge", value: `\`${row.chargeId}\``, inline: true },
      ...(row.disputeId ? [{ name: "Dispute", value: `\`${row.disputeId}\``, inline: true }] : []),
    ];
  }

  async postProposal(row: DisputeAutoResolve): Promise<{ channelId: string; messageId: string } | null> {
    const fires = Math.floor(row.fireAt.getTime() / 1000);
    const embed = new EmbedBuilder()
      .setTitle("🤝 Auto-resolve proposed")
      .setColor(COLORS.warn)
      .setDescription(
        "Refunding this charge now closes the case as prevented, so it never becomes a chargeback and never counts toward the dispute ratio. " +
          "Cancel below if this one should be fought instead."
      )
      .addFields(
        ...this.common(row),
        { name: "Refunds", value: `<t:${fires}:R>`, inline: false },
        {
          name: "Also happens",
          value: "Active subscriptions are cancelled and a note is left on the customer in Intercom. No blocklist entry is added.",
          inline: false,
        }
      )
      .setTimestamp();

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`billadmin_dpa_veto:${row.id}`).setLabel("Cancel auto-resolve").setStyle(ButtonStyle.Danger)
    );
    if (row.disputeId) {
      buttons.addComponents(
        new ButtonBuilder().setCustomId(`billadmin_dpa_open:${row.disputeId}`).setLabel("Open dispute").setStyle(ButtonStyle.Secondary)
      );
    }
    return this.send(embed, [buttons]);
  }

  // A blocked case still reaches a human: the engine wanted to act and could
  // not, which is exactly when somebody should look.
  async postBlocked(row: DisputeAutoResolve): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("🛑 Auto-resolve declined")
      .setColor(COLORS.danger)
      .setDescription(`A guardrail stopped this one: **${(row.guardrail ?? "unknown").replace(/_/g, " ")}**. It needs a human.`)
      .addFields(...this.common(row))
      .setTimestamp();
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`billadmin_dpa_refund:${row.chargeId}`).setLabel("Refund to Prevent").setStyle(ButtonStyle.Secondary)
    );
    if (row.disputeId) {
      buttons.addComponents(
        new ButtonBuilder().setCustomId(`billadmin_dpa_open:${row.disputeId}`).setLabel("Open dispute").setStyle(ButtonStyle.Secondary)
      );
    }
    await this.send(embed, [buttons]);
  }

  async postExecuted(row: DisputeAutoResolve, refundText: string): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("✅ Auto-resolve executed")
      .setColor(COLORS.success)
      .setDescription(`Refunded ${refundText}. The case should close as prevented, keeping it off the dispute ratio.`)
      .addFields(...this.common(row), { name: "Refund", value: `\`${row.refundId ?? "unknown"}\``, inline: true })
      .setTimestamp();
    await this.send(embed);
  }

  async postFailed(row: DisputeAutoResolve, error: string): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Auto-resolve failed")
      .setColor(COLORS.danger)
      .setDescription(`The refund could not be made after repeated attempts, so this one needs a human.\n\`\`\`${error.slice(0, 500)}\`\`\``)
      .addFields(...this.common(row))
      .setTimestamp();
    await this.send(embed);
  }
}

// Cancel the subscription and tell support what happened. Deliberately does NOT
// blocklist: auto-resolve is not allowed to block anyone, and the Stripe refund
// reason is chosen to avoid Stripe's own native block lists for the same reason.
export class StripeIntercomSideEffects implements AutoResolveSideEffects {
  constructor(
    private stripe: StripeClient,
    private sessionStore: SessionStore,
    private settings: SettingsStore,
    private intercom?: IntercomClient | null
  ) {}

  async cancelSubscriptions(customerId: string, idemKey: string): Promise<void> {
    const result = await this.stripe.cancelAllActiveSubscriptions(customerId, idemKey);
    if (result.failed.length) throw new Error(`cancel failed for: ${result.failed.join(", ")}`);
  }

  async noteOnCustomer(customerId: string, body: string): Promise<void> {
    if (!this.intercom || this.settings.intercomMode() === "none") return;
    const adminId = this.settings.intercomAdminId();
    if (!adminId) return;
    // The customer is reached through their linked Discord id, which is the
    // external id the bridge writes onto the Intercom contact.
    const discordIds = await this.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => []);
    for (const discordId of discordIds.slice(0, 3)) {
      const contact = await this.intercom.findContactByExternalId(discordId).catch(() => null);
      if (contact && (await this.intercom.addContactNote(contact.id, body, adminId).catch(() => false))) return;
    }
    // No contact resolved. Not an error: plenty of paying customers have never
    // opened a conversation, and there is nothing to attach a note to.
  }
}
