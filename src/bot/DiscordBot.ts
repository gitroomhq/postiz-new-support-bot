import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  WebhookClient,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  REST,
  Routes,
  TextChannel,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type ChannelSelectMenuInteraction,
  type GuildMember,
  type ThreadChannel,
} from "discord.js";
import { BotConfig } from "../config";
import { SettingsStore, isUnicodeEmoji, ReminderTarget } from "../config/SettingsStore";
import { StatusTag } from "../generated/prisma/client";
import { SessionStore } from "../auth/SessionStore";
import { OAuthManager } from "../auth/OAuthManager";
import { PostizApiClient } from "./PostizApiClient";
import { ClaudeCodeRunner } from "./ClaudeCodeRunner";
import { GitHubClient } from "./GitHubClient";
import { CategoryRegistry } from "./CategoryRegistry";
import { TicketStore } from "./TicketStore";
import { StatusService } from "./StatusService";
import { CallbackServer } from "../server/CallbackServer";
import { BillingCategory } from "../categories/BillingCategory";
import { BaseCategory, TicketContext } from "../categories/BaseCategory";

export class DiscordBot {
  readonly client: Client;
  private rest: REST;

  constructor(
    private config: BotConfig,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private sessionStore: SessionStore,
    private oauthManager: OAuthManager,
    private apiClient: PostizApiClient,
    private claudeRunner: ClaudeCodeRunner,
    private githubClient: GitHubClient,
    private categoryRegistry: CategoryRegistry
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.token);
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once("ready", () => {
      console.log(`Bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("interactionCreate", (interaction) => {
      this.handleInteraction(interaction).catch(console.error);
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
    } else if (interaction.isButton()) {
      await this.handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenu(interaction);
    } else if (interaction.isRoleSelectMenu()) {
      await this.handleRoleSelect(interaction);
    } else if (interaction.isChannelSelectMenu()) {
      await this.handleChannelSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.handleModal(interaction);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "setup") {
      await this.postSupportPanel(interaction);
    } else if (interaction.commandName === "config") {
      await this.handleConfigCommand(interaction);
    } else if (interaction.commandName === "set-status") {
      await this.handleSetStatusCommand(interaction);
    }
  }

  private async postSupportPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("Postiz Support")
      .setDescription("Need help? Click the button below to get started.")
      .setColor(0x5865f2);

    const startButton = new ButtonBuilder()
      .setCustomId("start_here")
      .setLabel("Start Here")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(startButton);

    await interaction.reply({ embeds: [embed], components: [row] });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("config_")) {
      await this.handleConfigButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("feedback_yes:") || interaction.customId.startsWith("feedback_no:")) {
      await this.handleFeedback(interaction);
      return;
    }

    if (interaction.customId.startsWith("create_issue:")) {
      await this.handleCreateIssue(interaction);
      return;
    }

    if (
      interaction.customId.startsWith("billing_accept_discount:") ||
      interaction.customId.startsWith("billing_decline_discount:") ||
      interaction.customId.startsWith("billing_confirm_refund:") ||
      interaction.customId.startsWith("billing_cancel_refund:")
    ) {
      const allowedUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
        return;
      }
      const billing = this.getBillingCategory();
      if (interaction.customId.startsWith("billing_accept_discount:")) {
        await billing.handleAcceptDiscount(interaction);
      } else if (interaction.customId.startsWith("billing_decline_discount:")) {
        await billing.handleDeclineDiscount(interaction);
      } else if (interaction.customId.startsWith("billing_confirm_refund:")) {
        await billing.handleConfirmRefund(interaction);
      } else {
        await billing.handleCancelRefund(interaction);
      }
      return;
    }

    if (interaction.customId.startsWith("auth_logout:")) {
      const allowedUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
        return;
      }
      await this.sessionStore.removeSession(interaction.user.id);
      await interaction.reply({ content: "You've been logged out.", flags: 64 });
      return;
    }

    if (interaction.customId !== "start_here") return;

    // Not logged in → prompt login
    if (!(await this.sessionStore.isAuthenticated(interaction.user.id))) {
      const authUrl = await this.oauthManager.generateAuthUrl(
        interaction.user.id,
        interaction.channelId,
        interaction.token
      );

      const embed = new EmbedBuilder()
        .setTitle("Connect your Postiz account")
        .setDescription(
          `You need to log in first.\n\n[Click here to authenticate](${authUrl})\n\nOnce done, come back and click **Start Here** again.`
        )
        .setColor(0x5865f2)
        .setFooter({ text: "This link expires in 10 minutes." });

      await interaction.reply({ embeds: [embed], flags: 64 });
      return;
    }

    // Logged in → show category select menu + logout button
    const selectMenu = this.buildCategorySelectMenu();
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const logoutButton = new ButtonBuilder()
      .setCustomId(`auth_logout:${interaction.user.id}`)
      .setLabel("Logout")
      .setEmoji("🚪")
      .setStyle(ButtonStyle.Danger);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(logoutButton);

    await interaction.reply({ components: [selectRow, buttonRow], flags: 64 });
  }

  private getBillingCategory(): BillingCategory {
    return this.categoryRegistry.getAll().find((c) => c.id === "billing") as BillingCategory;
  }

  private buildCategorySelectMenu(): StringSelectMenuBuilder {
    return new StringSelectMenuBuilder()
      .setCustomId("category_select")
      .setPlaceholder("What do you need help with?")
      .addOptions(
        this.categoryRegistry.getAll().map((category) => ({
          label: category.label,
          value: category.id,
          description: category.description,
          emoji: category.emoji,
        }))
      );
  }

  private async getThreadsChannel(): Promise<TextChannel | null> {
    const channelId = this.settingsStore.threadsChannelId();
    if (!channelId) return null;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    return channel instanceof TextChannel ? channel : null;
  }

  private buildTicketContext(category: BaseCategory): TicketContext {
    const initial = this.settingsStore.initialTag();
    return {
      supportRoleId: this.settingsStore.supportRoleId(),
      aiSolveEnabled: this.settingsStore.aiSolveEnabled(),
      initialEmoji: initial?.emoji ?? "🟢",
      onTicketCreated: async (thread, customerId, displayName) => {
        if (!initial) return;
        await this.ticketStore.create({
          threadId: thread.id,
          channelId: thread.parentId ?? thread.id,
          customerId,
          customerDisplayName: displayName,
          categoryId: category.id,
          statusTagId: initial.id,
        });
      },
    };
  }

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "config_tag_pick") {
      await this.handleConfigTagPick(interaction);
      return;
    }

    if (interaction.customId === "setstatus_select") {
      await this.handleSetStatusSelect(interaction);
      return;
    }

    if (interaction.customId === "billing_suboption") {
      const threadsChannel = await this.getThreadsChannel();
      if (!threadsChannel) {
        await interaction.reply({ content: "Support threads channel is not configured. Ask an admin to run /config.", flags: 64 });
        return;
      }
      const billing = this.getBillingCategory();
      await billing.handleBillingSubOption(interaction, threadsChannel, this.buildTicketContext(billing));
      return;
    }

    if (interaction.customId !== "category_select") return;

    const categoryId = interaction.values[0];
    const category = this.categoryRegistry.getAll().find((c) => c.id === categoryId);
    if (!category) return;

    const handled = await category.handleButtonPress(interaction);

    // If the category handled the interaction itself (e.g. billing), don't reset
    if (handled) return;

    // Reset the select menu back to placeholder so it can be used again
    const freshMenu = this.buildCategorySelectMenu();
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(freshMenu);
    await interaction.editReply({ components: [row] });
  }

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith("config_")) {
      await this.handleConfigModal(interaction);
      return;
    }

    const category = this.categoryRegistry.findByModalId(interaction.customId);
    if (!category) return;

    const session = await this.sessionStore.getSession(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "Your session has expired. Please click **Start Here** again.",
        flags: 64,
      });
      return;
    }

    const threadsChannel = await this.getThreadsChannel();
    if (!threadsChannel) {
      await interaction.reply({
        content: "Support threads channel is not configured. Please contact an admin.",
        flags: 64,
      });
      return;
    }

    const responder = (prompt: string, onUpdate?: (messages: string[]) => void) =>
      this.claudeRunner.run(prompt, onUpdate);

    await category.handleModalSubmit(interaction, responder, threadsChannel, this.buildTicketContext(category), {
      postizUserId: session.postizUserId,
      stripeCustomerId: session.stripeCustomerId,
    });
  }

  private async handleCreateIssue(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const allowedUserId = parts[1];
    const issueLabel = parts[2] || "feature-request";

    if (interaction.user.id !== allowedUserId) {
      await interaction.reply({ content: "Only the original requester can create this issue.", flags: 64 });
      return;
    }

    await interaction.deferReply();

    try {
      const thread = interaction.channel;
      if (!thread || !thread.isThread()) {
        await interaction.editReply({ content: "Could not find the thread." });
        return;
      }

      const messages = await thread.messages.fetch({ limit: 10 });
      const questionMsg = messages.reverse().find(
        (m) => m.embeds.length > 0 && m.embeds[0].title === "Your question"
      );

      const userQuestion = questionMsg?.embeds[0].description || "Issue from Discord";

      const responseTexts = messages
        .filter((m) => m.embeds.length > 0 && m.embeds[0].title !== "Your question")
        .map((m) => m.embeds[0].description)
        .filter(Boolean)
        .join("\n\n");

      const isBug = issueLabel === "bug";
      const heading = isBug ? "Bug Report" : "Feature Request";
      const titlePrefix = isBug ? "Bug:" : "Feature request:";

      const issueBody = [
        `## ${heading}`,
        ``,
        `**User report:** ${userQuestion}`,
        ``,
        `## Context from support bot`,
        ``,
        responseTexts || "No additional context.",
        ``,
        `---`,
        `*Created from Discord support bot by <@${interaction.user.id}>*`,
      ].join("\n");

      const issueUrl = await this.githubClient.createIssue(
        `${titlePrefix} ${userQuestion.slice(0, 100)}`,
        issueBody,
        [issueLabel],
        this.settingsStore.githubRepo()
      );

      // Disable the button after use
      const disabledButton = new ButtonBuilder()
        .setCustomId(interaction.customId)
        .setLabel("Issue Created")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);
      await interaction.message.edit({ components: [row] });

      const embed = new EmbedBuilder()
        .setTitle("GitHub Issue Created")
        .setDescription(`Your ${isBug ? "bug report" : "feature request"} has been submitted!\n\n[View Issue](${issueUrl})`)
        .setColor(0x57f287);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("GitHub issue creation error:", error);
      await interaction.editReply({ content: "Failed to create the GitHub issue. Please try again later." });
    }
  }

  // Legacy feedback buttons (only shown when AI solve is on). Yes → closing tag, No → initial tag.
  private async handleFeedback(interaction: ButtonInteraction): Promise<void> {
    const allowedUserId = interaction.customId.split(":")[1];
    if (interaction.user.id !== allowedUserId) {
      await interaction.reply({ content: "Only the original requester can use this.", flags: 64 });
      return;
    }

    const isPositive = interaction.customId.startsWith("feedback_yes:");
    const channel = interaction.channel;

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("feedback_done")
        .setLabel(isPositive ? "Resolved" : "Escalated")
        .setStyle(isPositive ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });

    const thread = channel?.isThread() ? (channel as ThreadChannel) : null;
    const ticket = thread ? await this.ticketStore.getByThreadId(thread.id) : null;

    if (isPositive) {
      const closing = this.settingsStore.closingTag();
      await interaction.reply("Glad we could help! Closing this ticket.");
      if (thread && ticket && closing) {
        await this.statusService.applyStatus(thread, ticket, closing, { actorLabel: "the bot" });
      } else if (thread) {
        await thread.setArchived(true).catch(() => {});
      }
    } else {
      const supportRoleId = this.settingsStore.supportRoleId();
      const mention = supportRoleId ? `<@&${supportRoleId}>` : "A support team member";
      await interaction.reply(`${mention} will follow up here shortly.`);
      const initial = this.settingsStore.initialTag();
      if (thread && ticket && initial) {
        await this.statusService.applyStatus(thread, ticket, initial, { actorLabel: "the bot" });
      }
    }
  }

  // ---- Permission helpers ----

  private async fetchMember(interaction: Interaction): Promise<GuildMember | null> {
    if (!interaction.guild) return null;
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }

  private isAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ChannelSelectMenuInteraction | ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  }

  private async requireSupportOrAdmin(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction
  ): Promise<GuildMember | null> {
    const member = await this.fetchMember(interaction);
    const supportRoleId = this.settingsStore.supportRoleId();
    const ok =
      !!member &&
      (member.permissions.has(PermissionFlagsBits.Administrator) ||
        (!!supportRoleId && member.roles.cache.has(supportRoleId)));
    if (!ok) {
      await interaction.reply({ content: "You don't have permission to do that.", flags: 64 });
      return null;
    }
    return member;
  }

  // ---- /set-status ----

  private async handleSetStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    const channel = interaction.channel;
    if (!channel?.isThread()) {
      await interaction.reply({ content: "Use this inside a ticket thread.", flags: 64 });
      return;
    }
    const thread = channel as ThreadChannel;

    let ticket = await this.ticketStore.getByThreadId(thread.id);
    if (!ticket) {
      // Adopt a previously-untracked bot-created support thread.
      const adopted = await this.adoptThread(thread);
      if (!adopted) {
        await interaction.reply({ content: "This thread isn't a tracked support ticket.", flags: 64 });
        return;
      }
      ticket = adopted;
    }

    const tags = this.settingsStore.tags();
    if (tags.length === 0) {
      await interaction.reply({ content: "No status tags are configured. Ask an admin to run /config.", flags: 64 });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("setstatus_select")
      .setPlaceholder("Select a status")
      .addOptions(tags.map((t) => ({ label: t.label, value: t.id, emoji: t.emoji })));

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await interaction.reply({ content: "Set this ticket's status:", components: [row], flags: 64 });
  }

  private async handleSetStatusSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    const channel = interaction.channel;
    if (!channel?.isThread()) return;
    const thread = channel as ThreadChannel;

    const tag = this.settingsStore.tagById(interaction.values[0]);
    const ticket = await this.ticketStore.getByThreadId(thread.id);
    if (!tag || !ticket) {
      await interaction.reply({ content: "Couldn't apply that status.", flags: 64 });
      return;
    }

    await interaction.deferUpdate();
    await this.statusService.applyStatus(thread, ticket, tag, { actorLabel: `<@${member.id}>`, actorId: member.id });
    await interaction.editReply({ content: `Status set to ${tag.emoji} ${tag.label}.`, components: [] });
  }

  private async adoptThread(thread: ThreadChannel) {
    const initial = this.settingsStore.initialTag();
    if (!initial) return null;
    if (thread.parentId !== this.settingsStore.threadsChannelId()) return null;
    if (thread.ownerId !== this.client.user?.id) return null;

    const leadingEmoji = thread.name.split(" ")[0];
    const tag = this.settingsStore.tagByEmoji(leadingEmoji) ?? initial;
    const customer = await this.deriveCustomerId(thread);

    await this.ticketStore.create({
      threadId: thread.id,
      channelId: thread.parentId ?? thread.id,
      customerId: customer.id,
      customerDisplayName: customer.displayName,
      statusTagId: tag.id,
    });
    return this.ticketStore.getByThreadId(thread.id);
  }

  // Best-effort: the customer is the only non-bot human in a private thread who
  // isn't on the support role. Returns nulls when it can't be determined.
  private async deriveCustomerId(thread: ThreadChannel): Promise<{ id: string | null; displayName: string | null }> {
    const supportRoleId = this.settingsStore.supportRoleId();
    try {
      const members = await thread.members.fetch();
      const candidates: GuildMember[] = [];
      for (const tm of members.values()) {
        if (tm.id === this.client.user?.id) continue;
        const gm = await thread.guild.members.fetch(tm.id).catch(() => null);
        if (!gm || gm.user.bot) continue;
        if (supportRoleId && gm.roles.cache.has(supportRoleId)) continue;
        candidates.push(gm);
      }
      if (candidates.length === 1) {
        return { id: candidates[0].id, displayName: candidates[0].displayName };
      }
    } catch {
      // fall through
    }
    return { id: null, displayName: null };
  }

  // ---- /config panel ----

  private async handleConfigCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    await interaction.reply({ ...this.buildConfigMainPanel(), flags: 64 });
  }

  private buildConfigMainPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Support Bot Configuration")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Threads channel:** ${s.threadsChannelId() ? `<#${s.threadsChannelId()}>` : "_not set_"}`,
          `**Support role:** ${s.supportRoleId() ? `<@&${s.supportRoleId()}>` : "_not set_"}`,
          `**GitHub repo:** ${s.githubRepo() ? `\`${s.githubRepo()}\`` : "_not set_"}`,
          `**AI solve:** ${s.aiSolveEnabled() ? "on" : "off"}`,
          `**Status tags:** ${s.tags().length}`,
        ].join("\n")
      );

    const buttons = [
      new ButtonBuilder().setCustomId("config_general").setLabel("General Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_tags").setLabel("Manage Tags").setStyle(ButtonStyle.Primary),
    ];
    if (!s.backfillDone()) {
      buttons.push(
        new ButtonBuilder().setCustomId("config_backfill").setLabel("Backfill existing tickets").setStyle(ButtonStyle.Secondary)
      );
    }

    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] };
  }

  private buildGeneralPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("General Settings")
      .setColor(0x5865f2)
      .setDescription("Pick the support role and threads channel, toggle AI, or set the GitHub repo.");

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId("config_set_supportrole")
      .setPlaceholder("Support role");
    if (s.supportRoleId()) roleSelect.setDefaultRoles(s.supportRoleId()!);

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("config_set_channel")
      .setPlaceholder("Threads channel")
      .addChannelTypes(ChannelType.GuildText);
    if (s.threadsChannelId()) channelSelect.setDefaultChannels(s.threadsChannelId()!);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_toggle_ai")
        .setLabel(`AI solve: ${s.aiSolveEnabled() ? "on" : "off"}`)
        .setStyle(s.aiSolveEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_set_repo").setLabel("Set GitHub Repo").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect),
        new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect),
        buttons,
      ],
    };
  }

  private buildTagsPanel() {
    const s = this.settingsStore;
    const tags = s.tags();
    const embed = new EmbedBuilder()
      .setTitle("Status Tags")
      .setColor(0x5865f2)
      .setDescription(
        tags.length
          ? tags
              .map((t) => {
                const flags = [t.isInitial ? "initial" : null, t.closesThread ? "closes" : null].filter(Boolean).join(", ");
                const reminder = t.reminderEnabled ? `${t.reminderDays}d → ${t.reminderTarget.toLowerCase()}` : "no reminders";
                return `${t.emoji} **${t.label}** — ${reminder}${flags ? ` (${flags})` : ""}`;
              })
              .join("\n")
          : "_No tags yet._"
      );

    const components: ActionRowBuilder<any>[] = [];
    if (tags.length) {
      const pick = new StringSelectMenuBuilder()
        .setCustomId("config_tag_pick")
        .setPlaceholder("Edit a tag")
        .addOptions(tags.map((t) => ({ label: t.label, value: t.id, emoji: t.emoji })));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pick));
    }
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("config_tag_add").setLabel("Add Tag").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )
    );

    return { embeds: [embed], components };
  }

  private buildTagEditPanel(tag: StatusTag) {
    const embed = new EmbedBuilder()
      .setTitle(`Edit ${tag.emoji} ${tag.label}`)
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Initial:** ${tag.isInitial ? "yes" : "no"}`,
          `**Closes + locks thread:** ${tag.closesThread ? "yes" : "no"}`,
          `**Reminders:** ${tag.reminderEnabled ? `every ${tag.reminderDays} day(s) → ${tag.reminderTarget.toLowerCase()}` : "off"}`,
          `**Auto-close after:** ${tag.autoCloseAfter ?? "never"}`,
        ].join("\n")
      );

    const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`config_tag_set_initial:${tag.id}`)
        .setLabel(tag.isInitial ? "Initial ✓" : "Set as Initial")
        .setStyle(tag.isInitial ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tag_toggle_closes:${tag.id}`).setLabel("Toggle Closes").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tag_toggle_reminder:${tag.id}`).setLabel("Toggle Reminder").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tag_target:${tag.id}`).setLabel(`Target: ${tag.reminderTarget.toLowerCase()}`).setStyle(ButtonStyle.Secondary)
    );

    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config_tag_edit_basic:${tag.id}`).setLabel("Edit emoji/label/days").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`config_tag_delete:${tag.id}`).setLabel("Delete").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("config_tags").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [toggles, actions] };
  }

  private async handleConfigButton(interaction: ButtonInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }

    const id = interaction.customId;

    if (id === "config_general") {
      await interaction.update(this.buildGeneralPanel());
      return;
    }
    if (id === "config_tags") {
      await interaction.update(this.buildTagsPanel());
      return;
    }
    if (id === "config_back_main") {
      await interaction.update(this.buildConfigMainPanel());
      return;
    }

    if (id === "config_toggle_ai") {
      await this.settingsStore.updateGeneral({ aiSolveEnabled: !this.settingsStore.aiSolveEnabled() });
      await interaction.update(this.buildGeneralPanel());
      return;
    }

    if (id === "config_backfill") {
      await this.handleBackfill(interaction);
      return;
    }

    if (id === "config_set_repo") {
      const modal = new ModalBuilder().setCustomId("config_repo_modal").setTitle("GitHub Repo");
      const input = new TextInputBuilder()
        .setCustomId("repo")
        .setLabel("owner/repo")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(this.settingsStore.githubRepo() ?? "");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_tag_add") {
      await interaction.showModal(this.buildTagModal());
      return;
    }

    // Tag-scoped buttons: customId is `config_tag_<action>:<tagId>`
    const [action, tagId] = id.split(":");
    const tag = tagId ? this.settingsStore.tagById(tagId) : undefined;
    if (!tag) {
      await interaction.reply({ content: "That tag no longer exists.", flags: 64 });
      return;
    }

    if (action === "config_tag_set_initial") {
      await this.settingsStore.editTag(tag.id, { isInitial: true });
    } else if (action === "config_tag_toggle_closes") {
      await this.settingsStore.editTag(tag.id, { closesThread: !tag.closesThread });
    } else if (action === "config_tag_toggle_reminder") {
      await this.settingsStore.editTag(tag.id, { reminderEnabled: !tag.reminderEnabled });
    } else if (action === "config_tag_target") {
      const next: ReminderTarget = tag.reminderTarget === "CUSTOMER" ? "SUPPORT" : "CUSTOMER";
      await this.settingsStore.editTag(tag.id, { reminderTarget: next });
    } else if (action === "config_tag_edit_basic") {
      await interaction.showModal(this.buildTagModal(tag));
      return;
    } else if (action === "config_tag_delete") {
      await this.handleTagDelete(interaction, tag.id);
      return;
    } else {
      return;
    }

    const updated = this.settingsStore.tagById(tag.id);
    if (updated) await interaction.update(this.buildTagEditPanel(updated));
  }

  private buildTagModal(tag?: StatusTag): ModalBuilder {
    const modal = new ModalBuilder()
      .setCustomId(tag ? `config_tag_edit_modal:${tag.id}` : "config_tag_add_modal")
      .setTitle(tag ? "Edit Tag" : "Add Tag");

    const emoji = new TextInputBuilder().setCustomId("emoji").setLabel("Emoji").setStyle(TextInputStyle.Short).setRequired(true);
    const label = new TextInputBuilder().setCustomId("label").setLabel("Label").setStyle(TextInputStyle.Short).setRequired(true);
    const days = new TextInputBuilder()
      .setCustomId("days")
      .setLabel("Reminder days (blank = disabled)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    const autoclose = new TextInputBuilder()
      .setCustomId("autoclose")
      .setLabel("Auto-close after N customer reminders")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    if (tag) {
      emoji.setValue(tag.emoji);
      label.setValue(tag.label);
      if (tag.reminderEnabled) days.setValue(String(tag.reminderDays));
      if (tag.autoCloseAfter != null) autoclose.setValue(String(tag.autoCloseAfter));
    }

    const rows = [
      new ActionRowBuilder<TextInputBuilder>().addComponents(emoji),
      new ActionRowBuilder<TextInputBuilder>().addComponents(label),
      new ActionRowBuilder<TextInputBuilder>().addComponents(days),
      new ActionRowBuilder<TextInputBuilder>().addComponents(autoclose),
    ];

    // Only the Add modal asks for target up-front; editing uses the Target button.
    if (!tag) {
      const target = new TextInputBuilder()
        .setCustomId("target")
        .setLabel("Reminder target (support or customer)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      rows.push(new ActionRowBuilder<TextInputBuilder>().addComponents(target));
    }

    modal.addComponents(...rows);
    return modal;
  }

  private async handleConfigModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }

    if (interaction.customId === "config_repo_modal") {
      const repo = interaction.fields.getTextInputValue("repo").trim();
      await this.settingsStore.updateGeneral({ githubRepo: repo || null });
      await interaction.reply({ content: repo ? `GitHub repo set to \`${repo}\`.` : "GitHub repo cleared.", flags: 64 });
      return;
    }

    const emoji = interaction.fields.getTextInputValue("emoji").trim();
    const label = interaction.fields.getTextInputValue("label").trim();
    const daysRaw = interaction.fields.getTextInputValue("days").trim();
    const autoRaw = interaction.fields.getTextInputValue("autoclose").trim();
    let targetRaw = "";
    try {
      targetRaw = interaction.fields.getTextInputValue("target").trim().toLowerCase();
    } catch {
      // edit modal has no target field
    }

    if (!isUnicodeEmoji(emoji)) {
      await interaction.reply({ content: "Emoji must be a single standard (unicode) emoji.", flags: 64 });
      return;
    }
    if (!label) {
      await interaction.reply({ content: "Label is required.", flags: 64 });
      return;
    }

    const daysNum = daysRaw ? parseInt(daysRaw, 10) : NaN;
    const autoNum = autoRaw ? parseInt(autoRaw, 10) : NaN;
    const reminderDays = Number.isFinite(daysNum) && daysNum > 0 ? daysNum : undefined;
    const autoCloseAfter = Number.isFinite(autoNum) && autoNum > 0 ? autoNum : null;
    const reminderTarget: ReminderTarget | undefined =
      targetRaw === "customer" ? "CUSTOMER" : targetRaw === "support" ? "SUPPORT" : undefined;

    try {
      if (interaction.customId === "config_tag_add_modal") {
        await this.settingsStore.addTag({
          emoji,
          label,
          reminderEnabled: reminderDays != null,
          reminderDays: reminderDays ?? 3,
          reminderTarget,
          autoCloseAfter,
        });
        await interaction.reply({ content: `Added ${emoji} ${label}.`, flags: 64 });
      } else if (interaction.customId.startsWith("config_tag_edit_modal:")) {
        const tagId = interaction.customId.split(":")[1];
        await this.settingsStore.editTag(tagId, {
          emoji,
          label,
          ...(reminderDays != null ? { reminderDays } : {}),
          autoCloseAfter,
        });
        await interaction.reply({ content: `Updated ${emoji} ${label}.`, flags: 64 });
      }
    } catch (error) {
      await interaction.reply({ content: (error as Error).message || "Failed to save the tag.", flags: 64 });
    }
  }

  private async handleTagDelete(interaction: ButtonInteraction, tagId: string): Promise<void> {
    await interaction.deferUpdate();
    try {
      const { reassignedThreadIds, initial } = await this.settingsStore.removeTag(tagId);
      // Rename reassigned threads to the initial tag's emoji (best-effort).
      for (const threadId of reassignedThreadIds) {
        const channel = await this.client.channels.fetch(threadId).catch(() => null);
        if (channel?.isThread()) {
          const thread = channel as ThreadChannel;
          await thread.setName(this.statusService.buildThreadName(thread.name, initial.emoji)).catch(() => {});
        }
      }
      await interaction.editReply(this.buildTagsPanel());
    } catch (error) {
      await interaction.followUp({ content: (error as Error).message || "Failed to delete the tag.", flags: 64 });
    }
  }

  private async handleConfigTagPick(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    const tag = this.settingsStore.tagById(interaction.values[0]);
    if (!tag) {
      await interaction.update(this.buildTagsPanel());
      return;
    }
    await interaction.update(this.buildTagEditPanel(tag));
  }

  private async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config_set_supportrole") return;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    await this.settingsStore.updateGeneral({ supportRoleId: interaction.values[0] });
    await interaction.update(this.buildGeneralPanel());
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config_set_channel") return;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    await this.settingsStore.updateGeneral({ threadsChannelId: interaction.values[0] });
    await interaction.update(this.buildGeneralPanel());
  }

  private async handleBackfill(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    if (this.settingsStore.backfillDone()) {
      await interaction.editReply({ content: "Backfill has already been completed." });
      return;
    }

    const channel = await this.getThreadsChannel();
    const initial = this.settingsStore.initialTag();
    if (!channel || !initial) {
      await interaction.editReply({ content: "Set the threads channel and at least one initial tag first." });
      return;
    }

    try {
      const threads = new Map<string, ThreadChannel>();
      const active = await channel.threads.fetchActive();
      active.threads.forEach((t) => threads.set(t.id, t as ThreadChannel));
      const archived = await channel.threads.fetchArchived({ type: "private", fetchAll: true }).catch(() => null);
      archived?.threads.forEach((t) => threads.set(t.id, t as ThreadChannel));

      let created = 0;
      for (const thread of threads.values()) {
        if (thread.ownerId !== this.client.user?.id) continue;
        if (await this.ticketStore.existsForThread(thread.id)) continue;

        const leadingEmoji = thread.name.split(" ")[0];
        const tag = this.settingsStore.tagByEmoji(leadingEmoji) ?? initial;
        const customer = await this.deriveCustomerId(thread);

        await this.ticketStore.create({
          threadId: thread.id,
          channelId: thread.parentId ?? thread.id,
          customerId: customer.id,
          customerDisplayName: customer.displayName,
          statusTagId: tag.id,
        });
        if (thread.archived || thread.locked || tag.closesThread) {
          await this.ticketStore.close(thread.id);
        }
        created++;
      }

      await this.settingsStore.markBackfillDone();
      await interaction.editReply({ content: `Backfill complete. Tracked ${created} existing ticket(s).` });
    } catch (error) {
      console.error("Backfill error:", error);
      await interaction.editReply({ content: "Backfill failed; you can try again from /config." });
    }
  }

  async registerCommands(): Promise<void> {
    const commands = [
      {
        name: "setup",
        description: "Post the support panel in this channel (admin only)",
        default_member_permissions: "8", // ADMINISTRATOR
      },
      {
        name: "config",
        description: "Configure the support bot (admin only)",
        default_member_permissions: "8", // ADMINISTRATOR
      },
      {
        name: "set-status",
        description: "Set the status of this support ticket (support/admin only)",
      },
    ];

    await this.rest.put(Routes.applicationCommands(this.config.discord.clientId), {
      body: commands,
    });

    console.log("Slash commands registered");
  }

  async start(): Promise<void> {
    await this.registerCommands();
    await this.client.login(this.config.discord.token);

    const callbackServer = new CallbackServer(
      this.config,
      this.oauthManager,
      async (discordUserId: string, interactionToken: string | null) => {
        if (!interactionToken) return;

        const selectMenu = this.buildCategorySelectMenu();
        const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

        const logoutButton = new ButtonBuilder()
          .setCustomId(`auth_logout:${discordUserId}`)
          .setLabel("Logout")
          .setEmoji("🚪")
          .setStyle(ButtonStyle.Danger);

        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(logoutButton);

        const webhook = new WebhookClient({ id: this.config.discord.clientId, token: interactionToken });
        await webhook.editMessage("@original", {
          embeds: [],
          components: [selectRow, buttonRow],
        });
      }
    );
    callbackServer.start();
  }
}
