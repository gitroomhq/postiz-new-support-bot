import {
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  TextChannel,
  type Guild,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../util/embeds";
import { log } from "../util/logger";

const ticketLog = log.child("ticket");

export interface TicketContext {
  // Per-user rate limiting. Returns a customer-facing rejection message, or null when
  // the user may open a ticket. Must run before any thread is created.
  guardTicketCreate: (userId: string, guild: Guild | null) => Promise<string | null>;
  onTicketCreated: (
    thread: ThreadChannel,
    customerId: string,
    displayName: string,
    question?: string,
    opts?: { intercomExempt?: boolean }
  ) => Promise<void>;
}

// Customer ticket categories. Agent-facing extras (auto-answer, staff pings,
// thread membership, title emojis) were retired with the Intercom migration —
// a new ticket is just: private thread, customer added, question embed,
// bridged to Intercom where agents work it.
export abstract class BaseCategory {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly emoji: string;
  abstract readonly description: string;

  get modalId(): string {
    return `modal_${this.id}`;
  }

  buildModal(): ModalBuilder {
    const modal = new ModalBuilder()
      .setCustomId(this.modalId)
      .setTitle(this.label);

    const input = new TextInputBuilder()
      .setCustomId("user_input")
      .setLabel(this.getInputLabel())
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(this.getInputPlaceholder())
      .setRequired(true)
      .setMaxLength(2000);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);
    return modal;
  }

  async handleButtonPress(interaction: { showModal: (modal: ModalBuilder) => Promise<void> }): Promise<boolean> {
    await interaction.showModal(this.buildModal());
    return false; // false = caller should still reset the select menu
  }

  async handleModalSubmit(
    interaction: ModalSubmitInteraction,
    threadsChannel: TextChannel,
    ctx: TicketContext,
    userInfo?: { postizUserId?: string | null; stripeCustomerId?: string | null }
  ): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const blockReason = await ctx.guardTicketCreate(interaction.user.id, interaction.guild);
    if (blockReason) {
      await interaction.editReply({ embeds: [makeEmbed(blockReason, COLORS.warn)] });
      return;
    }

    const userInput = interaction.fields.getTextInputValue("user_input");

    let thread: ThreadChannel | null = null;
    try {
      // The trailing " — {label}" is load-bearing: deriveCategoryId parses it
      // during Re-Verify/adoption, so truncation (100-char thread-name cap)
      // may only eat into the display name, never the suffix. No emoji
      // prefixes — titles no longer encode status.
      const suffix = ` — ${this.label}`;
      thread = await threadsChannel.threads.create({
        name: `${interaction.user.displayName.slice(0, 100 - suffix.length)}${suffix}`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);

      await ctx.onTicketCreated(thread, interaction.user.id, interaction.user.displayName, userInput);

      const questionEmbed = new EmbedBuilder()
        .setTitle("Your question")
        .setDescription(userInput)
        .setColor(0x2b2d31);

      if (userInfo?.postizUserId || userInfo?.stripeCustomerId) {
        const fields: { name: string; value: string; inline: boolean }[] = [];
        if (userInfo.postizUserId) {
          fields.push({ name: "Postiz ID", value: `\`${userInfo.postizUserId}\``, inline: true });
        }
        if (userInfo.stripeCustomerId) {
          fields.push({ name: "Stripe ID", value: `\`${userInfo.stripeCustomerId}\``, inline: true });
        }
        questionEmbed.addFields(fields);
      }

      await thread.send({ embeds: [questionEmbed] });

      await interaction.editReply({
        embeds: [makeEmbed(`Your private support thread has been created: ${thread}`, COLORS.success)],
      });
    } catch (error) {
      // Thread creation or post-creation setup (member add, ticket row,
      // question embed) failed — keep the customer-facing fallback, but the
      // failure itself must be debuggable.
      ticketLog.error("ticket creation failed", error, {
        "ticket.category": this.id,
        "ticket.customer_id": interaction.user.id,
        "ticket.thread_id": thread?.id ?? "",
      });
      const ephemeralEmbed = thread
        ? makeEmbed(
            `Your support thread ${thread} was created, but something went wrong — a support member will help you there shortly.`,
            COLORS.warn
          )
        : makeEmbed("Something went wrong while processing your request. Please try again later.", COLORS.danger);
      await interaction.editReply({ embeds: [ephemeralEmbed] }).catch(() => {});
    }
  }

  protected abstract getInputLabel(): string;
  protected abstract getInputPlaceholder(): string;
}
