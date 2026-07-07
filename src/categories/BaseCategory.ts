import {
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
  type Guild,
  type ModalSubmitInteraction,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { ClaudeApiLimitError } from "../bot/ClaudeCodeRunner";
import { embed as makeEmbed, COLORS } from "../util/embeds";

export interface TicketContext {
  // Lowest escalation tier's role (legacy support role as fallback): pinged on
  // new tickets and its members are added to the thread.
  staffPingRoleId: string | null;
  aiSolveEnabled: boolean;
  initialEmoji: string;
  // Emoji of the initial priority, or null when none is configured (title then
  // carries only the status emoji).
  initialPriorityEmoji: string | null;
  // Per-user rate limiting. Returns a customer-facing rejection message, or null when
  // the user may open a ticket. Must run before any thread is created.
  guardTicketCreate: (userId: string, guild: Guild | null) => Promise<string | null>;
  onTicketCreated: (thread: ThreadChannel, customerId: string, displayName: string, question?: string) => Promise<void>;
  // Fired once with the complete AI answer after streaming finishes (Intercom mirror).
  onAiAnswer?: (thread: ThreadChannel, finalText: string) => Promise<void>;
}

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

  // Add support role members so staff can see ticket content. Best-effort:
  // never blocks ticket creation.
  protected async addSupportMembers(
    thread: ThreadChannel,
    supportRoleId: string | null,
    excludeUserId: string
  ): Promise<void> {
    if (!supportRoleId) return;
    try {
      const role = await thread.guild.roles.fetch(supportRoleId);
      if (!role) return;
      for (const [memberId] of role.members) {
        if (memberId !== excludeUserId) {
          await thread.members.add(memberId).catch(() => {});
        }
      }
    } catch {
      // Don't block ticket creation if adding support members fails
    }
  }

  async handleModalSubmit(
    interaction: ModalSubmitInteraction,
    responder: (prompt: string, onUpdate?: (messages: string[]) => void) => Promise<string | string[]>,
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
    const prompt = this.buildPrompt(userInput);

    let thread: ThreadChannel | null = null;
    let thinkingMsg: Message | null = null;
    try {
      thread = await threadsChannel.threads.create({
        name: `${ctx.initialEmoji}${ctx.initialPriorityEmoji ? ` ${ctx.initialPriorityEmoji}` : ""} ${interaction.user.displayName} — ${this.label}`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);

      await this.addSupportMembers(thread, ctx.staffPingRoleId, interaction.user.id);

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

      if (!ctx.aiSolveEnabled) {
        if (ctx.staffPingRoleId) {
          await thread.send({
            content: `<@&${ctx.staffPingRoleId}>`,
            embeds: [makeEmbed("A new support ticket has been opened and needs attention.")],
            allowedMentions: { roles: [ctx.staffPingRoleId] },
          });
        }
        return;
      }

      // Thinking animation until first real content arrives
      thinkingMsg = await thread.send({ content: "Thinking (that might take a while)..." });
      let hasContent = false;

      // One Discord message per assistant message, updated as they stream in
      const discordMessages = new Map<number, Message>();
      let lastEdit = 0;
      const EDIT_INTERVAL = 1500;

      const result = await responder(prompt, (messages: string[]) => {
        if (!hasContent) {
          hasContent = true;
          // Reuse thinking message for the first streamed message
          discordMessages.set(0, thinkingMsg!);
        }

        const now = Date.now();
        if (now - lastEdit < EDIT_INTERVAL) return;
        lastEdit = now;

        for (let i = 0; i < messages.length; i++) {
          const text = messages[i].slice(0, 4000);
          const isLatest = i === messages.length - 1;
          const content = isLatest ? text + "\n\n⏳ *Generating...*" : text;

          const existing = discordMessages.get(i);
          if (existing) {
            existing.edit({ content }).catch(() => {});
          } else {
            thread!.send({ content }).then((msg) => {
              discordMessages.set(i, msg);
            }).catch(() => {});
          }
        }
      });

      // If no streaming happened, reuse the thinking message for the final result
      if (!hasContent) {
        discordMessages.set(0, thinkingMsg!);
      }

      // Final state: convert all messages to embeds
      const finalMessages = Array.isArray(result) ? result : [result];

      // Check for actionable markers (strip from display)
      const lastMsg = finalMessages[finalMessages.length - 1];
      const featureNotFound = lastMsg.includes("[FEATURE_NOT_FOUND]");
      const bugConfirmed = lastMsg.includes("[BUG_CONFIRMED]");
      finalMessages[finalMessages.length - 1] = lastMsg
        .replace("[FEATURE_NOT_FOUND]", "")
        .replace("[BUG_CONFIRMED]", "")
        .trim();

      // Wait a moment for any pending message sends to complete
      await new Promise((r) => setTimeout(r, 500));

      for (let i = 0; i < finalMessages.length; i++) {
        const embed = new EmbedBuilder()
          .setDescription(finalMessages[i].slice(0, 4096))
          .setColor(this.getColor());

        // Add title/footer only to the last message
        if (i === finalMessages.length - 1) {
          embed
            .setTitle(`${this.emoji} ${this.label}`)
            .setFooter({ text: "Powered by Postiz" })
            .setTimestamp();
        }

        const existing = discordMessages.get(i);
        if (existing) {
          await existing.edit({ content: "", embeds: [embed] });
        } else {
          await thread.send({ embeds: [embed] });
        }
      }

      // One push with the complete answer (not per stream edit).
      void ctx.onAiAnswer?.(thread, finalMessages.join("\n\n")).catch(() => {});

      // Offer to create a GitHub issue
      if (featureNotFound || bugConfirmed) {
        const label = featureNotFound ? "feature-request" : "bug";
        const buttonLabel = featureNotFound ? "Create Feature Request on GitHub" : "Create Bug Report on GitHub";
        const message = featureNotFound
          ? "This feature doesn't seem to exist yet. Would you like to create a GitHub issue for it?"
          : "This looks like a real bug. Would you like to create a GitHub issue for it?";

        const issueButton = new ButtonBuilder()
          .setCustomId(`create_issue:${interaction.user.id}:${label}`)
          .setLabel(buttonLabel)
          .setEmoji("📝")
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(issueButton);

        await thread.send({ embeds: [makeEmbed(message, this.getColor())], components: [row] });
      } else {
        // No CTA — ask if the answer helped
        const yesButton = new ButtonBuilder()
          .setCustomId(`feedback_yes:${interaction.user.id}`)
          .setLabel("Yes, this helped!")
          .setStyle(ButtonStyle.Success);

        const noButton = new ButtonBuilder()
          .setCustomId(`feedback_no:${interaction.user.id}`)
          .setLabel("No, I need more help")
          .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(yesButton, noButton);

        await thread.send({ embeds: [makeEmbed("Did this answer help you?", this.getColor())], components: [row] });
      }
    } catch (error) {
      const isLimit = error instanceof ClaudeApiLimitError;
      const publicMsg = isLimit
        ? "The automated AI response is currently not available — a support member will assist you shortly."
        : "Something went wrong while generating an answer — a support member will take a look shortly.";
      const publicEmbed = makeEmbed(publicMsg, COLORS.warn);

      // Repair the public thread: the "Thinking (that might take a while)..."
      // placeholder must never be left hanging. Overwrite it (it may already
      // hold partial API-error text) or post fresh if it was never sent. This
      // now runs for ANY failure, not just API limits — previously a generic
      // error only touched the ephemeral reply and left the thread stuck.
      if (thinkingMsg) {
        await thinkingMsg.edit({ content: "", embeds: [publicEmbed] }).catch(() => {});
      } else if (thread) {
        await thread.send({ embeds: [publicEmbed] }).catch(() => {});
      }

      // Ping staff in-thread so a human picks the ticket up (both failure paths).
      if (thread && ctx.staffPingRoleId) {
        await thread
          .send({
            content: `<@&${ctx.staffPingRoleId}>`,
            embeds: [makeEmbed("This ticket needs a human — the automated answer failed.", COLORS.warn)],
            allowedMentions: { roles: [ctx.staffPingRoleId] },
          })
          .catch(() => {});
      }

      // Update the ephemeral reply. When the thread exists the failure is already
      // surfaced there; otherwise this is the only thing the user sees.
      const ephemeralEmbed = thread
        ? makeEmbed(
            `Your support thread ${thread} was created, but the automated answer failed — a support member will help you there shortly.`,
            COLORS.warn
          )
        : makeEmbed("Something went wrong while processing your request. Please try again later.", COLORS.danger);
      await interaction.editReply({ embeds: [ephemeralEmbed] }).catch(() => {});
    }
  }

  protected abstract getInputLabel(): string;
  protected abstract getInputPlaceholder(): string;
  protected abstract buildPrompt(userInput: string): string;
  protected abstract getColor(): number;
}
