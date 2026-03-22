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
  type ModalSubmitInteraction,
  type Message,
  type ThreadChannel,
} from "discord.js";

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
    responder: (prompt: string, onUpdate?: (messages: string[]) => void) => Promise<string | string[]>,
    threadsChannel: TextChannel,
    userInfo?: { postizUserId?: string | null; stripeCustomerId?: string | null }
  ): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const userInput = interaction.fields.getTextInputValue("user_input");
    const prompt = this.buildPrompt(userInput);

    try {
      const thread = await threadsChannel.threads.create({
        name: `${this.emoji} ${interaction.user.displayName} — ${this.label}`,
        type: ChannelType.PrivateThread,
        invitable: false,
      });

      await thread.members.add(interaction.user.id);

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
        content: `Your private support thread has been created: ${thread}`,
      });

      // Thinking animation until first real content arrives
      const thinkingMsg = await thread.send({ content: "Thinking (that might take a while)..." });
      let hasContent = false;

      // One Discord message per assistant message, updated as they stream in
      const discordMessages = new Map<number, Message>();
      let lastEdit = 0;
      const EDIT_INTERVAL = 1500;

      const result = await responder(prompt, (messages: string[]) => {
        if (!hasContent) {
          hasContent = true;
          // Reuse thinking message for the first streamed message
          discordMessages.set(0, thinkingMsg);
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
            thread.send({ content }).then((msg) => {
              discordMessages.set(i, msg);
            }).catch(() => {});
          }
        }
      });

      // If no streaming happened, reuse the thinking message for the final result
      if (!hasContent) {
        discordMessages.set(0, thinkingMsg);
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

        await thread.send({ content: message, components: [row] });
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

        await thread.send({ content: "Did this answer help you?", components: [row] });
      }
    } catch (error) {
      await interaction.editReply({
        content: "Something went wrong while processing your request. Please try again later.",
      });
    }
  }

  protected abstract getInputLabel(): string;
  protected abstract getInputPlaceholder(): string;
  protected abstract buildPrompt(userInput: string): string;
  protected abstract getColor(): number;
}
