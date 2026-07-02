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
  AuditLogEvent,
  REST,
  Routes,
  TextChannel,
  type Interaction,
  type Message,
  type PartialGuildMember,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type AutocompleteInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type GuildMember,
  type ThreadChannel,
} from "discord.js";
import { BotConfig } from "../config";
import { embed as makeEmbed, COLORS } from "../util/embeds";
import { SettingsStore, isUnicodeEmoji, ReminderTarget } from "../config/SettingsStore";
import { StatusTag } from "../generated/prisma/client";
import { SessionStore } from "../auth/SessionStore";
import { OAuthManager } from "../auth/OAuthManager";
import { PostizApiClient } from "./PostizApiClient";
import { ClaudeCodeRunner } from "./ClaudeCodeRunner";
import { GitHubClient } from "./GitHubClient";
import { CategoryRegistry } from "./CategoryRegistry";
import { TicketStore, ReconcileChanges } from "./TicketStore";
import { StatusService, RESOLVED_EMOJI } from "./StatusService";
import { StatusReportService } from "./StatusReportService";
import { CallbackServer } from "../server/CallbackServer";
import { BillingCategory } from "../categories/BillingCategory";
import { BaseCategory, TicketContext } from "../categories/BaseCategory";

type TicketSearchFilters = {
  categoryId?: string;
  statusTagId?: string;
  closed?: boolean;
  customerIds?: string[];
  text?: string;
  createdAfter?: Date;
  createdBefore?: Date;
};

export class DiscordBot {
  readonly client: Client;
  private rest: REST;

  // /search-tickets pagination state, keyed by the originating interaction id (the token
  // embedded in page-button customIds). Pruned by age so it can't grow unbounded.
  private searchSessions = new Map<
    string,
    { filters: TicketSearchFilters; ownerUserId: string; createdAt: number }
  >();

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
    private categoryRegistry: CategoryRegistry,
    private reportService: StatusReportService
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

    // Reconcile ticket status with actions taken outside the bot's own UI.
    this.client.on("guildMemberRemove", (member) => {
      this.handleMemberLeave(member).catch(console.error);
    });

    this.client.on("messageCreate", (message) => {
      this.handleMessage(message).catch(console.error);
    });

    this.client.on("threadUpdate", (oldThread, newThread) => {
      this.handleThreadUpdate(oldThread, newThread).catch(console.error);
    });
  }

  // A member left the guild: close out every open ticket they own.
  private async handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const closingTag = this.settingsStore.closingTag();
    if (!closingTag) return;

    const tickets = await this.ticketStore.listOpenByCustomerId(member.id);
    for (const ticket of tickets) {
      const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
      if (channel?.isThread()) {
        await this.statusService.applyStatus(channel as ThreadChannel, ticket, closingTag, {
          actorName: "System (member left)",
          silent: true,
        });
      } else {
        // Thread is gone/unreachable — still reconcile the DB.
        await this.ticketStore.close(ticket.threadId).catch(() => {});
      }
    }
  }

  // Human messages in tracked ticket threads drive two things:
  // 1. the first support reply stamps firstResponseAt (response-time metrics),
  // 2. a customer reply to a Resolved ticket reopens it to the initial status.
  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const ticket = await this.ticketStore.getByThreadId(message.channelId);
    if (!ticket) return;

    // First support reply on an open ticket. Only support/admin members count, so
    // another invited human (or the customer) can't skew the metric.
    if (!ticket.closed && !ticket.firstResponseAt && ticket.customerId && message.author.id !== ticket.customerId) {
      const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null)) ?? null;
      const supportRoleId = this.settingsStore.supportRoleId();
      const isSupport =
        !!member &&
        (member.permissions.has(PermissionFlagsBits.Administrator) ||
          (!!supportRoleId && member.roles.cache.has(supportRoleId)));
      if (isSupport) {
        await this.ticketStore.setFirstResponse(ticket.threadId, message.createdAt).catch((e) => {
          console.error("firstResponse stamp failed:", e);
        });
      }
    }

    // Only Resolved tickets are reopenable by a reply (Closed threads are locked).
    if (ticket.statusTag?.emoji !== RESOLVED_EMOJI) return;
    // Only the ticket's own customer reopens it — support/closing notes don't.
    if (message.author.id !== ticket.customerId) return;

    const initialTag = this.settingsStore.initialTag();
    if (!initialTag) return;

    await this.statusService.applyStatus(message.channel as ThreadChannel, ticket, initialTag, {
      actorName: "Customer reply",
    });
  }

  // A thread was manually locked/archived in Discord: mirror it as a status change.
  private async handleThreadUpdate(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
    if (newThread.parentId !== this.settingsStore.threadsChannelId()) return;

    const ticket = await this.ticketStore.getByThreadId(newThread.id);
    if (!ticket) return;

    // Only react to flags being newly set, not cleared (reopen is handled elsewhere).
    const newlyLocked = !oldThread.locked && newThread.locked;
    const newlyArchived = !oldThread.archived && newThread.archived;
    if (!newlyLocked && !newlyArchived) return;

    const target = newlyLocked
      ? this.settingsStore.closingTag()
      : this.settingsStore.tagByEmoji(RESOLVED_EMOJI);
    if (!target) return;

    // Idempotency backstop: applyStatus persists the status BEFORE it locks/archives, so
    // the bot's own edits re-fire this event already at the target status — skip them.
    if (ticket.statusTagId === target.id) return;

    // Only act on actions a human performed. The audit log lets us ignore the bot's own
    // edits and Discord's inactivity auto-archive (which writes no audit entry).
    try {
      const logs = await newThread.guild.fetchAuditLogs({
        type: AuditLogEvent.ThreadUpdate,
        limit: 5,
      });
      const entry = logs.entries.find((e) => e.target?.id === newThread.id);
      if (!entry) return; // auto-archive / no record → not a manual action
      if (entry.executorId === this.client.user?.id) return; // the bot itself
    } catch (error) {
      // Missing "View Audit Log" permission (or transient failure): skip rather than
      // misfire on inactivity auto-archives.
      console.warn("threadUpdate: could not read audit log, skipping status sync:", error);
      return;
    }

    await this.statusService.applyStatus(newThread, ticket, target, {
      actorName: "Manual thread action",
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.handleCommand(interaction);
    } else if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
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
    } else if (interaction.commandName === "report") {
      await this.handleReportCommand(interaction);
    } else if (interaction.commandName === "search-tickets") {
      await this.handleSearchTicketsCommand(interaction);
    }
  }

  private async handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    await interaction.deferReply({ flags: 64 });
    try {
      // Manual checks use a trailing 24h window and never advance the scheduled cadence.
      const { embed, components } = await this.reportService.build({ since: null });
      await interaction.editReply({ embeds: [embed], components });
    } catch (error) {
      console.error("report command failed:", error);
      await interaction.editReply({ embeds: [makeEmbed("Couldn't build the status report.", COLORS.danger)] });
    }
  }

  // Ephemeral drill-downs behind the report's "Overdue Tickets" / "Age Breakdown" buttons.
  // Both recompute live from the ticket store, so they keep working on old report messages.
  private async handleReportDrilldown(interaction: ButtonInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    await interaction.deferReply({ flags: 64 });
    try {
      const embed =
        interaction.customId === "report_overdue"
          ? await this.reportService.buildOverdueEmbed()
          : await this.reportService.buildAgeBreakdownEmbed();
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("report drill-down failed:", error);
      await interaction.editReply({ embeds: [makeEmbed("Couldn't load that breakdown.", COLORS.danger)] });
    }
  }

  // ---- /search-tickets ----

  // Suggest status tags for the `status` option. Tags are runtime-configurable, so this
  // reads the live list rather than relying on static command choices.
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "search-tickets" && interaction.commandName !== "set-status") return;
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "status") {
      await interaction.respond([]);
      return;
    }
    const query = focused.value.toLowerCase();
    const choices = this.settingsStore
      .tags()
      .filter((t) => t.label.toLowerCase().includes(query))
      .slice(0, 25)
      .map((t) => ({ name: `${t.emoji} ${t.label}`, value: t.id }));
    try {
      await interaction.respond(choices);
    } catch {
      // Autocomplete tokens expire quickly; a late response is harmless to drop.
    }
  }

  private async handleSearchTicketsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    await interaction.deferReply({ flags: 64 });

    const type = interaction.options.getString("type");
    const statusTagId = interaction.options.getString("status");
    const state = interaction.options.getString("state");
    const user = interaction.options.getUser("user");
    const postizId = interaction.options.getString("postiz_id");
    const stripeId = interaction.options.getString("stripe_id");
    const text = interaction.options.getString("text");
    const openedAfterRaw = interaction.options.getString("opened_after");
    const openedBeforeRaw = interaction.options.getString("opened_before");

    // Date filters: YYYY-MM-DD, interpreted as UTC days; opened_before includes that whole day.
    const parseDay = (raw: string): Date | null => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const date = new Date(`${raw}T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    let createdAfter: Date | undefined;
    let createdBefore: Date | undefined;
    if (openedAfterRaw) {
      const parsed = parseDay(openedAfterRaw.trim());
      if (!parsed) {
        await interaction.editReply({ embeds: [makeEmbed("`opened_after` must be a valid date like `2026-06-15`.", COLORS.warn)] });
        return;
      }
      createdAfter = parsed;
    }
    if (openedBeforeRaw) {
      const parsed = parseDay(openedBeforeRaw.trim());
      if (!parsed) {
        await interaction.editReply({ embeds: [makeEmbed("`opened_before` must be a valid date like `2026-06-15`.", COLORS.warn)] });
        return;
      }
      createdBefore = new Date(parsed.getTime() + 24 * 60 * 60 * 1000);
    }

    // Resolve the identity filters (Discord user / Postiz id / Stripe id) into a single
    // customerId allow-list by intersecting each provided filter's set of Discord ids.
    const idConstraints: string[][] = [];
    if (user) idConstraints.push([user.id]);
    if (postizId) idConstraints.push(await this.sessionStore.findDiscordIdsByPostizId(postizId));
    if (stripeId) idConstraints.push(await this.sessionStore.findDiscordIdsByStripeId(stripeId));

    let customerIds: string[] | undefined;
    if (idConstraints.length > 0) {
      customerIds = [...new Set(idConstraints.reduce((acc, ids) => acc.filter((id) => ids.includes(id))))];
    }

    const filters: TicketSearchFilters = {
      categoryId: type ?? undefined,
      statusTagId: statusTagId ?? undefined,
      closed: state === "open" ? false : state === "closed" ? true : undefined,
      customerIds,
      text: text?.trim() || undefined,
      createdAfter,
      createdBefore,
    };

    const token = interaction.id;
    this.pruneSearchSessions();
    this.searchSessions.set(token, { filters, ownerUserId: interaction.user.id, createdAt: Date.now() });

    const { embed, components } = await this.buildSearchResult(filters, 0, token);
    await interaction.editReply({ embeds: [embed], components });
  }

  // Builds one page of results (shared by the command and the pagination buttons).
  private async buildSearchResult(
    filters: TicketSearchFilters,
    page: number,
    token: string
  ): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const pageSize = 10;

    // An identity filter that resolved to nobody → no possible matches.
    if (filters.customerIds && filters.customerIds.length === 0) {
      return {
        embed: makeEmbed("No users match that Discord user / Postiz ID / Stripe ID.", COLORS.warn),
        components: [],
      };
    }

    const { tickets, total } = await this.ticketStore.search(filters, page, pageSize);
    if (total === 0) {
      return { embed: makeEmbed("No tickets match those filters.", COLORS.neutral), components: [] };
    }

    const totalPages = Math.ceil(total / pageSize);

    // Resolve the Postiz/Stripe columns and category labels for just this page.
    const customerIds = tickets.map((t) => t.customerId).filter((id): id is string => !!id);
    const sessions = await this.sessionStore.listByDiscordIds(customerIds);
    const sessionByDiscordId = new Map(sessions.map((s) => [s.discordUserId, s]));
    const categoryLabels = new Map(this.categoryRegistry.getAll().map((c) => [c.id, c.label]));

    const lines = tickets.map((t) => {
      const status = t.statusTag ? `${t.statusTag.emoji} ${t.statusTag.label}` : "—";
      const category = t.categoryId ? categoryLabels.get(t.categoryId) ?? t.categoryId : "—";
      const who = t.customerId ? `<@${t.customerId}>` : t.customerDisplayName ?? "unknown user";
      const session = t.customerId ? sessionByDiscordId.get(t.customerId) : undefined;
      const postiz = session?.postizUserId ? ` · Postiz \`${session.postizUserId}\`` : "";
      const stripe = session?.stripeCustomerId ? ` · Stripe \`${session.stripeCustomerId}\`` : "";
      const created = `<t:${Math.floor(t.createdAt.getTime() / 1000)}:R>`;
      const closedMark = t.closed ? " · 🔒 closed" : "";
      // With a free-text filter active, show what actually matched.
      const snippet =
        filters.text && t.question
          ? `\n> ${t.question.replace(/\s+/g, " ").slice(0, 80)}${t.question.length > 80 ? "…" : ""}`
          : "";
      return `${status} — <#${t.threadId}> — ${category}\n${who}${postiz}${stripe} · ${created}${closedMark}${snippet}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Ticket search — ${total} result${total === 1 ? "" : "s"}`)
      .setDescription(lines.join("\n\n").slice(0, 4096))
      .setColor(COLORS.brand)
      .setFooter({ text: `Page ${page + 1}/${totalPages}` });

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (totalPages > 1) {
      const prev = new ButtonBuilder()
        .setCustomId(`search_page:${token}:${page - 1}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0);
      const next = new ButtonBuilder()
        .setCustomId(`search_page:${token}:${page + 1}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1);
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next));
    }

    return { embed, components };
  }

  private async handleSearchPage(interaction: ButtonInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    const [, token, pageStr] = interaction.customId.split(":");
    const stored = this.searchSessions.get(token);
    if (!stored) {
      await interaction.reply({
        embeds: [makeEmbed("This search has expired. Run /search-tickets again.", COLORS.warn)],
        flags: 64,
      });
      return;
    }
    if (stored.ownerUserId !== interaction.user.id) {
      await interaction.reply({
        embeds: [makeEmbed("Only the person who ran this search can page through it.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    const page = Number.parseInt(pageStr, 10);
    await interaction.deferUpdate();
    const { embed, components } = await this.buildSearchResult(stored.filters, page, token);
    await interaction.editReply({ embeds: [embed], components });
  }

  private pruneSearchSessions(): void {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [token, state] of this.searchSessions) {
      if (state.createdAt < cutoff) this.searchSessions.delete(token);
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
    if (interaction.customId.startsWith("search_page:")) {
      await this.handleSearchPage(interaction);
      return;
    }

    if (interaction.customId === "report_overdue" || interaction.customId === "report_age") {
      await this.handleReportDrilldown(interaction);
      return;
    }

    if (interaction.customId.startsWith("config_")) {
      await this.handleConfigButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("feedback_yes:") || interaction.customId.startsWith("feedback_no:")) {
      await this.handleFeedback(interaction);
      return;
    }

    if (interaction.customId.startsWith("csat:")) {
      await this.handleCsatRating(interaction);
      return;
    }

    if (interaction.customId.startsWith("create_issue:")) {
      await this.handleCreateIssue(interaction);
      return;
    }

    if (interaction.customId.startsWith("setstatus_confirm:")) {
      await this.handleSetStatusConfirm(interaction);
      return;
    }
    if (interaction.customId === "setstatus_cancel") {
      await this.handleSetStatusCancel(interaction);
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
        await interaction.reply({ embeds: [makeEmbed("Only the original requester can use this.", COLORS.danger)], flags: 64 });
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
        await interaction.reply({ embeds: [makeEmbed("Only the original requester can use this.", COLORS.danger)], flags: 64 });
        return;
      }
      await this.sessionStore.removeSession(interaction.user.id);
      await interaction.reply({ embeds: [makeEmbed("You've been logged out.", COLORS.success)], flags: 64 });
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
      guardTicketCreate: (userId, guild) => this.ticketCreationBlockReason(userId, guild),
      onTicketCreated: async (thread, customerId, displayName, question) => {
        if (!initial) return;
        await this.ticketStore.create({
          threadId: thread.id,
          channelId: thread.parentId ?? thread.id,
          customerId,
          customerDisplayName: displayName,
          categoryId: category.id,
          statusTagId: initial.id,
          question: question ?? null,
        });
      },
    };
  }

  // Per-user ticket rate limits: open-ticket cap + creation cooldown, both configurable
  // (0 = off). Staff are exempt. Returns the customer-facing rejection, or null to allow.
  private async ticketCreationBlockReason(userId: string, guild: Guild | null): Promise<string | null> {
    const max = this.settingsStore.maxOpenTicketsPerUser();
    const cooldownMin = this.settingsStore.ticketCooldownMinutes();
    if (max <= 0 && cooldownMin <= 0) return null;

    if (guild) {
      const member = await guild.members.fetch(userId).catch(() => null);
      const supportRoleId = this.settingsStore.supportRoleId();
      if (
        member &&
        (member.permissions.has(PermissionFlagsBits.Administrator) ||
          (!!supportRoleId && member.roles.cache.has(supportRoleId)))
      ) {
        return null;
      }
    }

    if (max > 0) {
      const open = await this.ticketStore.listOpenByCustomerId(userId);
      if (open.length >= max) {
        const link = open[0] ? ` Please continue in your existing ticket: <#${open[0].threadId}>` : "";
        return `You already have **${open.length}** open ticket(s) (limit ${max}).${link}`;
      }
    }

    if (cooldownMin > 0) {
      const latest = await this.ticketStore.latestByCustomerId(userId);
      if (latest) {
        const readyAt = latest.createdAt.getTime() + cooldownMin * 60_000;
        if (Date.now() < readyAt) {
          return `You're opening tickets too quickly — you can open another one <t:${Math.floor(readyAt / 1000)}:R>.`;
        }
      }
    }

    return null;
  }

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === "config_tag_pick") {
      await this.handleConfigTagPick(interaction);
      return;
    }

    if (interaction.customId === "billing_suboption") {
      const threadsChannel = await this.getThreadsChannel();
      if (!threadsChannel) {
        await interaction.reply({
          embeds: [makeEmbed("Support threads channel is not configured. Ask an admin to run /config.", COLORS.danger)],
          flags: 64,
        });
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

    if (interaction.customId.startsWith("csat_comment:")) {
      await this.handleCsatCommentModal(interaction);
      return;
    }

    const category = this.categoryRegistry.findByModalId(interaction.customId);
    if (!category) return;

    const session = await this.sessionStore.getSession(interaction.user.id);
    if (!session) {
      await interaction.reply({
        embeds: [makeEmbed("Your session has expired. Please click **Start Here** again.", COLORS.warn)],
        flags: 64,
      });
      return;
    }

    const threadsChannel = await this.getThreadsChannel();
    if (!threadsChannel) {
      await interaction.reply({
        embeds: [makeEmbed("Support threads channel is not configured. Please contact an admin.", COLORS.danger)],
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
      await interaction.reply({ embeds: [makeEmbed("Only the original requester can create this issue.", COLORS.danger)], flags: 64 });
      return;
    }

    await interaction.deferReply();

    try {
      const thread = interaction.channel;
      if (!thread || !thread.isThread()) {
        await interaction.editReply({ embeds: [makeEmbed("Could not find the thread.", COLORS.danger)] });
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
      await interaction.editReply({ embeds: [makeEmbed("Failed to create the GitHub issue. Please try again later.", COLORS.danger)] });
    }
  }

  // ---- CSAT (1-5 star rating on ticket close, usually via DM) ----

  // customId: csat:{threadId}:{customerId}:{score}. The owner check is a pure string
  // comparison and showModal is the FIRST response — no DB work before the ack, because
  // showModal can't follow a defer and the token window is ~3s.
  private async handleCsatRating(interaction: ButtonInteraction): Promise<void> {
    const [, threadId, customerId, scoreRaw] = interaction.customId.split(":");
    if (interaction.user.id !== customerId) {
      await interaction.reply({ embeds: [makeEmbed("Only the ticket owner can rate this ticket.", COLORS.danger)], flags: 64 });
      return;
    }
    const score = Number.parseInt(scoreRaw, 10);
    if (!Number.isInteger(score) || score < 1 || score > 5) return;

    const modal = new ModalBuilder()
      .setCustomId(`csat_comment:${threadId}:${score}`)
      .setTitle(`Thanks for the ${score}-star rating!`);
    const comment = new TextInputBuilder()
      .setCustomId("comment")
      .setLabel("Anything to add about how it went?")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(comment));
    await interaction.showModal(modal);

    // Record after the ack. A dismissed modal still keeps the rating; only the first
    // rating ever wins (recordCsat guards on csatScore null).
    const recorded = await this.ticketStore.recordCsat(threadId, score).catch((e) => {
      console.error("CSAT record failed:", e);
      return false;
    });
    if (recorded) {
      const doneRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("csat_done")
          .setLabel(`Rated ${score} ⭐ — thank you!`)
          .setStyle(ButtonStyle.Success)
          .setDisabled(true)
      );
      // Best-effort: editing can fail on an archived in-thread fallback message.
      await interaction.message.edit({ components: [doneRow] }).catch(() => {});
    }
  }

  private async handleCsatCommentModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [, threadId] = interaction.customId.split(":");
    const comment = interaction.fields.getTextInputValue("comment").trim();

    const ticket = await this.ticketStore.getByThreadId(threadId).catch(() => null);
    if (!ticket || ticket.csatScore == null) {
      await interaction.reply({ embeds: [makeEmbed("This rating prompt has expired — thanks anyway!", COLORS.neutral)], flags: 64 });
      return;
    }

    if (comment) {
      const stored = await this.ticketStore.setCsatComment(threadId, comment).catch(() => false);
      if (!stored) {
        await interaction.reply({ embeds: [makeEmbed("You've already left feedback for this ticket — thank you!", COLORS.warn)], flags: 64 });
        return;
      }
    }
    await interaction.reply({
      embeds: [makeEmbed(`Thanks for the feedback${comment ? " and the comment" : ""}! It helps us improve. ⭐`, COLORS.success)],
      flags: 64,
    });
  }

  // Legacy feedback buttons (only shown when AI solve is on). Yes → closing tag, No → initial tag.
  private async handleFeedback(interaction: ButtonInteraction): Promise<void> {
    const allowedUserId = interaction.customId.split(":")[1];
    if (interaction.user.id !== allowedUserId) {
      await interaction.reply({ embeds: [makeEmbed("Only the original requester can use this.", COLORS.danger)], flags: 64 });
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
      await interaction.reply({ embeds: [makeEmbed("Glad we could help! Closing this ticket.", COLORS.success)] });
      if (thread && ticket && closing) {
        await this.statusService.applyStatus(thread, ticket, closing, { actorName: interaction.user.displayName, actorIconUrl: interaction.user.displayAvatarURL() });
      } else if (thread) {
        await thread.setArchived(true).catch(() => {});
      }
    } else {
      const supportRoleId = this.settingsStore.supportRoleId();
      await interaction.reply({
        content: supportRoleId ? `<@&${supportRoleId}>` : undefined,
        embeds: [makeEmbed("A support team member will follow up here shortly.", COLORS.brand)],
        allowedMentions: supportRoleId ? { roles: [supportRoleId] } : { parse: [] },
      });
      const initial = this.settingsStore.initialTag();
      if (thread && ticket && initial) {
        await this.statusService.applyStatus(thread, ticket, initial, { actorName: interaction.user.displayName, actorIconUrl: interaction.user.displayAvatarURL() });
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

  private isValidTimezone(tz: string): boolean {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }
 
  private formatReportTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
 
  private async requireSupportOrAdmin(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction
  ): Promise<GuildMember | null> {
    const member = await this.fetchMember(interaction);
    const supportRoleId = this.settingsStore.supportRoleId();
    const ok =
      !!member &&
      (member.permissions.has(PermissionFlagsBits.Administrator) ||
        (!!supportRoleId && member.roles.cache.has(supportRoleId)));
    if (!ok) {
      await interaction.reply({ embeds: [makeEmbed("You don't have permission to do that.", COLORS.danger)], flags: 64 });
      return null;
    }
    return member;
  }

  // ---- /set-status ----

  private async handleSetStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    const channel = interaction.channel ?? (await this.client.channels.fetch(interaction.channelId).catch(() => null));
    if (!channel?.isThread()) {
      await interaction.reply({ embeds: [makeEmbed("Use this inside a ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }
    const thread = channel as ThreadChannel;

    let ticket = await this.ticketStore.getByThreadId(thread.id);
    if (!ticket) {
      // Adopt a previously-untracked bot-created support thread.
      const adopted = await this.adoptThread(thread);
      if (!adopted) {
        await interaction.reply({ embeds: [makeEmbed("This thread isn't a tracked support ticket.", COLORS.warn)], flags: 64 });
        return;
      }
      ticket = adopted;
    }

    // Status is chosen as an autocompleted command option; confirm before applying.
    const tagId = interaction.options.getString("status", true);
    const tag = this.settingsStore.tagById(tagId);
    if (!tag) {
      await interaction.reply({ embeds: [makeEmbed("Unknown status — pick one from the list.", COLORS.warn)], flags: 64 });
      return;
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`setstatus_confirm:${tag.id}`).setLabel("Confirm").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("setstatus_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      embeds: [makeEmbed(`Set this ticket's status to **${tag.emoji} ${tag.label}**?`)],
      components: [row],
      flags: 64,
    });
  }

  private async handleSetStatusConfirm(interaction: ButtonInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    // interaction.channel can be null on a cold cache (e.g. right after a restart) — fetch it.
    const channel = interaction.channel ?? (await this.client.channels.fetch(interaction.channelId).catch(() => null));
    if (!channel?.isThread()) {
      await interaction.reply({ embeds: [makeEmbed("This can only be used inside a ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }
    const thread = channel as ThreadChannel;

    const tag = this.settingsStore.tagById(interaction.customId.split(":")[1]);
    const ticket = await this.ticketStore.getByThreadId(thread.id);
    if (!tag || !ticket) {
      await interaction.reply({
        embeds: [makeEmbed("Couldn't apply that status — this thread isn't tracked yet. Run /set-status again.", COLORS.warn)],
        flags: 64,
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      await this.statusService.applyStatus(thread, ticket, tag, {
        actorName: member.displayName,
        actorIconUrl: member.displayAvatarURL(),
      });
      await interaction.editReply({
        embeds: [makeEmbed(`Status set to ${tag.emoji} ${tag.label}.`, COLORS.success)],
        components: [],
      });
    } catch (error) {
      console.error("set-status apply failed:", error);
      await interaction.editReply({
        embeds: [makeEmbed("Something went wrong applying that status.", COLORS.danger)],
        components: [],
      });
    }
  }

  private async handleSetStatusCancel(interaction: ButtonInteraction): Promise<void> {
    await interaction.update({ embeds: [makeEmbed("Status change cancelled.", COLORS.neutral)], components: [] });
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

  // ---- Re-Verify: reconcile DB status/type against Discord thread state ----

  // The category from the thread name's trailing label (after the LAST " — ", matching
  // BaseCategory's "{emoji} {name} — {label}" convention), matched case-insensitively against a
  // registered category. Returns undefined when it can't be determined so callers leave the
  // stored categoryId untouched — we never clobber a good value back to null / "Other".
  private deriveCategoryId(threadName: string): string | undefined {
    const SEP = " — ";
    const idx = threadName.lastIndexOf(SEP);
    if (idx === -1) return undefined;
    const label = threadName.slice(idx + SEP.length).trim();
    if (!label) return undefined;
    return this.categoryRegistry.getAll().find((c) => c.label.toLowerCase() === label.toLowerCase())?.id;
  }

  // The status tag from the thread name's leading emoji, or undefined if it maps to no tag.
  private deriveStatusTag(threadName: string): StatusTag | undefined {
    return this.settingsStore.tagByEmoji(threadName.split(" ")[0]);
  }

  // ---- /config panel ----

  private async handleConfigCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
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
          `**Status report:** ${
            s.reportEnabled() && s.reportChannelId()
              ? `${s.reportHour() != null && s.reportMinute() != null ? `daily at ${this.formatReportTime(s.reportHour()!, s.reportMinute()!)} (${s.reportTimezone()})` : `every ${s.reportIntervalHours()}h`} → <#${s.reportChannelId()}>`
              : "off"
          }`,
          `**Billing audit:** ${s.billingAuditChannelId() ? `<#${s.billingAuditChannelId()}>` : "_in-thread ping_"}`,
          `**Ticket limits:** ${s.maxOpenTicketsPerUser() > 0 ? `max ${s.maxOpenTicketsPerUser()} open` : "no cap"} · ${s.ticketCooldownMinutes() > 0 ? `${s.ticketCooldownMinutes()}m cooldown` : "no cooldown"}`,
        ].join("\n")
      );

    // Discord caps action rows at 5 buttons, so the panel spans two rows.
    const primary = [
      new ButtonBuilder().setCustomId("config_general").setLabel("General Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_tags").setLabel("Manage Tags").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_report").setLabel("Status Report").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_billing").setLabel("Billing").setStyle(ButtonStyle.Primary),
    ];
    const secondary = [
      new ButtonBuilder().setCustomId("config_reverify").setLabel("Re-Verify").setStyle(ButtonStyle.Secondary),
    ];
    if (!s.backfillDone()) {
      secondary.push(
        new ButtonBuilder().setCustomId("config_backfill").setLabel("Backfill existing tickets").setStyle(ButtonStyle.Secondary)
      );
    }

    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(primary),
        new ActionRowBuilder<ButtonBuilder>().addComponents(secondary),
      ],
    };
  }

  private formatMinorAmount(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
    } catch {
      return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
  }

  private buildBillingPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Billing Settings")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Audit channel:** ${s.billingAuditChannelId() ? `<#${s.billingAuditChannelId()}>` : "_not set — audit embeds ping the support role in the refund thread_"}`,
          `**Max self-service refund:** ${
            s.refundMaxAmount() != null
              ? `${this.formatMinorAmount(s.refundMaxAmount()!, s.refundMaxAmountCurrency())} (charges in other currencies go to manual review)`
              : "_no limit_"
          }`,
          `**Max refunds per 24h (all users):** ${s.refundMaxPer24h() ?? "_no limit_"}`,
          `**Min server membership age:** ${s.refundMinMemberAgeDays() != null ? `${s.refundMinMemberAgeDays()} day(s)` : "_no minimum_"}`,
          "",
          "Refunds that trip a limit are not executed — the ticket is handed to the support team for manual review.",
        ].join("\n")
      );

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("config_set_billingauditchannel")
      .setPlaceholder("Billing audit channel")
      .addChannelTypes(ChannelType.GuildText);
    if (s.billingAuditChannelId()) channelSelect.setDefaultChannels(s.billingAuditChannelId()!);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_billing_limits").setLabel("Set Limits").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_billing_clear_channel").setLabel("Clear Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect), buttons],
    };
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
      new ButtonBuilder().setCustomId("config_limits").setLabel("Ticket Limits").setStyle(ButtonStyle.Secondary),
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

  private buildReportPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Status Report")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Channel:** ${s.reportChannelId() ? `<#${s.reportChannelId()}>` : "_not set_"}`,
          `**Enabled:** ${s.reportEnabled() ? "yes" : "no"}`,
          `**Schedule:** ${s.reportHour() != null && s.reportMinute() != null ? `daily at ${this.formatReportTime(s.reportHour()!, s.reportMinute()!)} (${s.reportTimezone()})` : `every ${s.reportIntervalHours()} hour(s)`}`,
          `**Timezone:** ${s.reportTimezone()}`,
          `**Overdue threshold:** ${s.overdueThresholdDays()} day(s)`,
          "",
          "Posts an opened/closed + per-status + per-type summary on the configured schedule. Run `/report` for an instant check anytime.",
        ].join("\n")
      );

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("config_set_reportchannel")
      .setPlaceholder("Report channel")
      .addChannelTypes(ChannelType.GuildText);
    if (s.reportChannelId()) channelSelect.setDefaultChannels(s.reportChannelId()!);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_report_toggle")
        .setLabel(`Reporting: ${s.reportEnabled() ? "on" : "off"}`)
        .setStyle(s.reportEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_report_time").setLabel("Set Time").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_report_tz").setLabel("Set Timezone").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_report_overdue").setLabel("Set Overdue Days").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect), buttons],
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
          `**Auto-close after:** ${
            tag.autoCloseAfter == null
              ? "never"
              : tag.emoji === RESOLVED_EMOJI
                ? `${tag.autoCloseAfter} day(s) of customer silence`
                : `${tag.autoCloseAfter} customer reminder(s)`
          }`,
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
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
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

    if (id === "config_reverify") {
      await this.handleReVerify(interaction);
      return;
    }

    if (id === "config_report") {
      await interaction.update(this.buildReportPanel());
      return;
    }

    if (id === "config_billing") {
      await interaction.update(this.buildBillingPanel());
      return;
    }

    if (id === "config_billing_clear_channel") {
      await this.settingsStore.updateBilling({ billingAuditChannelId: null });
      await interaction.update(this.buildBillingPanel());
      return;
    }

    if (id === "config_billing_limits") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_billing_limits_modal").setTitle("Refund Guardrails");
      const amount = new TextInputBuilder()
        .setCustomId("amount")
        .setLabel("Max refund (whole units, blank = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMaxAmount() != null ? String(s.refundMaxAmount()! / 100) : "");
      const currency = new TextInputBuilder()
        .setCustomId("currency")
        .setLabel("Limit currency (3-letter code)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMaxAmountCurrency());
      const velocity = new TextInputBuilder()
        .setCustomId("velocity")
        .setLabel("Max refunds per 24h (blank = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMaxPer24h() != null ? String(s.refundMaxPer24h()) : "");
      const memberAge = new TextInputBuilder()
        .setCustomId("member_age")
        .setLabel("Min membership age, days (blank = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMinMemberAgeDays() != null ? String(s.refundMinMemberAgeDays()) : "");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
        new ActionRowBuilder<TextInputBuilder>().addComponents(currency),
        new ActionRowBuilder<TextInputBuilder>().addComponents(velocity),
        new ActionRowBuilder<TextInputBuilder>().addComponents(memberAge)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_report_toggle") {
      await this.settingsStore.updateReport({ reportEnabled: !this.settingsStore.reportEnabled() });
      await interaction.update(this.buildReportPanel());
      return;
    }

    if (id === "config_report_time") {
      const modal = new ModalBuilder().setCustomId("config_report_time_modal").setTitle("Report Time");
      const hourInput = new TextInputBuilder()
        .setCustomId("hour")
        .setLabel("Hour (0-23)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.reportHour() ?? 9));
      const minuteInput = new TextInputBuilder()
        .setCustomId("minute")
        .setLabel("Minute (0-59)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.reportMinute() ?? 0));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(hourInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(minuteInput)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_report_tz") {
      const modal = new ModalBuilder().setCustomId("config_report_tz_modal").setTitle("Report Timezone");
      const input = new TextInputBuilder()
        .setCustomId("tz")
        .setLabel("IANA timezone (e.g. Europe/Berlin)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(this.settingsStore.reportTimezone());
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_report_overdue") {
      const modal = new ModalBuilder().setCustomId("config_report_overdue_modal").setTitle("Overdue Threshold");
      const input = new TextInputBuilder()
        .setCustomId("days")
        .setLabel("Days before a ticket counts as overdue")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.overdueThresholdDays()));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_limits") {
      const modal = new ModalBuilder().setCustomId("config_limits_modal").setTitle("Ticket Limits");
      const maxOpen = new TextInputBuilder()
        .setCustomId("max_open")
        .setLabel("Max open tickets per user (0 = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.maxOpenTicketsPerUser()));
      const cooldown = new TextInputBuilder()
        .setCustomId("cooldown")
        .setLabel("Minutes between new tickets (0 = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.ticketCooldownMinutes()));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(maxOpen),
        new ActionRowBuilder<TextInputBuilder>().addComponents(cooldown)
      );
      await interaction.showModal(modal);
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
      await interaction.reply({ embeds: [makeEmbed("That tag no longer exists.", COLORS.warn)], flags: 64 });
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
      // Reminder tags: N reminder rounds. Resolved tag: N days of customer silence.
      .setLabel("Auto-close after N (reminders / days)")
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
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_repo_modal") {
      const repo = interaction.fields.getTextInputValue("repo").trim();
      await this.settingsStore.updateGeneral({ githubRepo: repo || null });
      await interaction.reply({
        embeds: [makeEmbed(repo ? `GitHub repo set to \`${repo}\`.` : "GitHub repo cleared.", COLORS.success)],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_report_time_modal") {
      const hourRaw = interaction.fields.getTextInputValue("hour").trim();
      const minuteRaw = interaction.fields.getTextInputValue("minute").trim();
      const hour = /^\d+$/.test(hourRaw) ? Number(hourRaw) : NaN;
      const minute = /^\d+$/.test(minuteRaw) ? Number(minuteRaw) : NaN;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        await interaction.reply({ embeds: [makeEmbed("Enter a valid hour (0-23) and minute (0-59).", COLORS.danger)], flags: 64 });
        return;
      }
      await this.settingsStore.updateReport({ reportHour: hour, reportMinute: minute });
      await interaction.reply({
        embeds: [makeEmbed(`Status report will publish daily at ${this.formatReportTime(hour, minute)} (${this.settingsStore.reportTimezone()}).`, COLORS.success)],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_report_tz_modal") {
      const tz = interaction.fields.getTextInputValue("tz").trim();
      if (!this.isValidTimezone(tz)) {
        await interaction.reply({ embeds: [makeEmbed("That isn't a valid IANA timezone (e.g. Europe/Berlin, UTC).", COLORS.danger)], flags: 64 });
        return;
      }
      await this.settingsStore.updateReport({ reportTimezone: tz });
      await interaction.reply({ embeds: [makeEmbed(`Report timezone set to ${tz}.`, COLORS.success)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_limits_modal") {
      const maxRaw = interaction.fields.getTextInputValue("max_open").trim();
      const cooldownRaw = interaction.fields.getTextInputValue("cooldown").trim();
      const max = /^\d+$/.test(maxRaw) ? Number(maxRaw) : NaN;
      const cooldown = /^\d+$/.test(cooldownRaw) ? Number(cooldownRaw) : NaN;
      if (!Number.isInteger(max) || max < 0 || max > 100 || !Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) {
        await interaction.reply({
          embeds: [makeEmbed("Enter a valid max (0-100) and cooldown in minutes (0-1440). 0 disables a limit.", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await this.settingsStore.updateGeneral({ maxOpenTicketsPerUser: max, ticketCooldownMinutes: cooldown });
      await interaction.reply({
        embeds: [
          makeEmbed(
            `Ticket limits updated: ${max > 0 ? `max ${max} open ticket(s) per user` : "no open-ticket cap"}, ${cooldown > 0 ? `${cooldown}m cooldown between tickets` : "no cooldown"}.`,
            COLORS.success
          ),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_billing_limits_modal") {
      const amountRaw = interaction.fields.getTextInputValue("amount").trim();
      const currencyRaw = interaction.fields.getTextInputValue("currency").trim().toLowerCase();
      const velocityRaw = interaction.fields.getTextInputValue("velocity").trim();
      const memberAgeRaw = interaction.fields.getTextInputValue("member_age").trim();

      // Whole currency units, stored in minor units (cents).
      const amountNum = amountRaw ? Number(amountRaw) : null;
      if (amountRaw && (!Number.isFinite(amountNum!) || amountNum! <= 0)) {
        await interaction.reply({ embeds: [makeEmbed("Max refund must be a positive number (or blank to disable).", COLORS.danger)], flags: 64 });
        return;
      }
      if (currencyRaw && !/^[a-z]{3}$/.test(currencyRaw)) {
        await interaction.reply({ embeds: [makeEmbed("Currency must be a 3-letter code like `usd` or `eur`.", COLORS.danger)], flags: 64 });
        return;
      }
      const velocityNum = velocityRaw ? Number(velocityRaw) : null;
      if (velocityRaw && (!Number.isInteger(velocityNum!) || velocityNum! < 1)) {
        await interaction.reply({ embeds: [makeEmbed("Max refunds per 24h must be a positive whole number (or blank to disable).", COLORS.danger)], flags: 64 });
        return;
      }
      const memberAgeNum = memberAgeRaw ? Number(memberAgeRaw) : null;
      if (memberAgeRaw && (!Number.isInteger(memberAgeNum!) || memberAgeNum! < 1 || memberAgeNum! > 3650)) {
        await interaction.reply({ embeds: [makeEmbed("Min membership age must be 1-3650 days (or blank to disable).", COLORS.danger)], flags: 64 });
        return;
      }

      await this.settingsStore.updateBilling({
        refundMaxAmount: amountNum != null ? Math.round(amountNum * 100) : null,
        ...(currencyRaw ? { refundMaxAmountCurrency: currencyRaw } : {}),
        refundMaxPer24h: velocityNum,
        refundMinMemberAgeDays: memberAgeNum,
      });
      await interaction.reply({ embeds: [makeEmbed("Refund guardrails updated.", COLORS.success)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_report_overdue_modal") {
      const daysRaw = interaction.fields.getTextInputValue("days").trim();
      const days = /^\d+$/.test(daysRaw) ? Number(daysRaw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        await interaction.reply({ embeds: [makeEmbed("Enter a valid number of days (1-365).", COLORS.danger)], flags: 64 });
        return;
      }
      await this.settingsStore.updateReport({ overdueThresholdDays: days });
      await interaction.reply({
        embeds: [makeEmbed(`Tickets now count as overdue after ${days} day(s).`, COLORS.success)],
        flags: 64,
      });
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
      await interaction.reply({ embeds: [makeEmbed("Emoji must be a single standard (unicode) emoji.", COLORS.danger)], flags: 64 });
      return;
    }
    if (!label) {
      await interaction.reply({ embeds: [makeEmbed("Label is required.", COLORS.danger)], flags: 64 });
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
        await interaction.reply({ embeds: [makeEmbed(`Added ${emoji} ${label}.`, COLORS.success)], flags: 64 });
      } else if (interaction.customId.startsWith("config_tag_edit_modal:")) {
        const tagId = interaction.customId.split(":")[1];
        await this.settingsStore.editTag(tagId, {
          emoji,
          label,
          ...(reminderDays != null ? { reminderDays } : {}),
          autoCloseAfter,
        });
        await interaction.reply({ embeds: [makeEmbed(`Updated ${emoji} ${label}.`, COLORS.success)], flags: 64 });
      }
    } catch (error) {
      await interaction.reply({ embeds: [makeEmbed((error as Error).message || "Failed to save the tag.", COLORS.danger)], flags: 64 });
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
      await interaction.followUp({ embeds: [makeEmbed((error as Error).message || "Failed to delete the tag.", COLORS.danger)], flags: 64 });
    }
  }

  private async handleConfigTagPick(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
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
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    await this.settingsStore.updateGeneral({ supportRoleId: interaction.values[0] });
    await interaction.update(this.buildGeneralPanel());
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (
      interaction.customId !== "config_set_channel" &&
      interaction.customId !== "config_set_reportchannel" &&
      interaction.customId !== "config_set_billingauditchannel"
    )
      return;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    if (interaction.customId === "config_set_reportchannel") {
      await this.settingsStore.updateReport({ reportChannelId: interaction.values[0] });
      await interaction.update(this.buildReportPanel());
      return;
    }
    if (interaction.customId === "config_set_billingauditchannel") {
      await this.settingsStore.updateBilling({ billingAuditChannelId: interaction.values[0] });
      await interaction.update(this.buildBillingPanel());
      return;
    }
    await this.settingsStore.updateGeneral({ threadsChannelId: interaction.values[0] });
    await interaction.update(this.buildGeneralPanel());
  }

  private async handleBackfill(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    if (this.settingsStore.backfillDone()) {
      await interaction.editReply({ embeds: [makeEmbed("Backfill has already been completed.", COLORS.neutral)] });
      return;
    }

    const channel = await this.getThreadsChannel();
    const initial = this.settingsStore.initialTag();
    if (!channel || !initial) {
      await interaction.editReply({ embeds: [makeEmbed("Set the threads channel and at least one initial tag first.", COLORS.warn)] });
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
      await interaction.editReply({ embeds: [makeEmbed(`Backfill complete. Tracked ${created} existing ticket(s).`, COLORS.success)] });
    } catch (error) {
      console.error("Backfill error:", error);
      await interaction.editReply({ embeds: [makeEmbed("Backfill failed; you can try again from /config.", COLORS.danger)] });
    }
  }

  // Re-runnable reconciliation: walk every tracked ticket and repair its DB status/type/closed
  // state to match the live Discord thread. DB-only — never renames threads, posts audit lines,
  // or pings customers (so it's safe to run over old/migrated tickets whose categoryId defaulted
  // to null → "Other"). Idempotent: a second run over an unchanged guild writes ~nothing.
  private async handleReVerify(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });

    const channel = await this.getThreadsChannel();
    if (!channel) {
      await interaction.editReply({
        embeds: [makeEmbed("Set the threads channel first (/config → General Settings).", COLORS.warn)],
      });
      return;
    }

    try {
      // Bulk-fetch threads once (same approach as backfill) so most tickets resolve with no
      // per-ticket REST call.
      const threadsById = new Map<string, ThreadChannel>();
      const active = await channel.threads.fetchActive();
      active.threads.forEach((t) => threadsById.set(t.id, t as ThreadChannel));
      const archived = await channel.threads.fetchArchived({ type: "private", fetchAll: true }).catch(() => null);
      archived?.threads.forEach((t) => threadsById.set(t.id, t as ThreadChannel));

      const tickets = await this.ticketStore.getAllWithTag();

      let checked = 0;
      let fixedStatus = 0;
      let fixedType = 0;
      let fixedClosed = 0;
      let threadsGone = 0;
      let undetermined = 0;

      for (const ticket of tickets) {
        checked++;

        // Prefer the bulk sets; fall back to a direct fetch for threads that weren't paginated
        // (individually archived, or living in another channel).
        let thread = threadsById.get(ticket.threadId) ?? null;
        if (!thread) {
          const fetched = await this.client.channels.fetch(ticket.threadId).catch(() => null);
          thread = fetched?.isThread() ? (fetched as ThreadChannel) : null;
        }

        // Thread gone entirely → reconcile it closed. Never stamp now() (that would spike the
        // report's "closed since" window); createdAt is a safe past timestamp.
        if (!thread) {
          threadsGone++;
          if (!ticket.closed) {
            await this.ticketStore
              .reconcile(ticket.threadId, { closed: true, closedAt: ticket.createdAt })
              .catch((e) => console.error(`reverify: reconcile failed for ${ticket.threadId}:`, e));
            fixedClosed++;
          }
          continue;
        }

        const derivedTag = this.deriveStatusTag(thread.name);
        const derivedCategoryId = this.deriveCategoryId(thread.name);
        const changes: ReconcileChanges = {};
        let isUndetermined = false;

        // Status from the leading emoji.
        if (!derivedTag) {
          isUndetermined = true;
        } else if (derivedTag.id !== ticket.statusTagId) {
          changes.statusTagId = derivedTag.id;
          fixedStatus++;
        }

        // Type from the trailing label.
        if (derivedCategoryId === undefined) {
          isUndetermined = true;
        } else if (derivedCategoryId !== ticket.categoryId) {
          changes.categoryId = derivedCategoryId;
          fixedType++;
        }

        // Closed state — use the derived tag if known, else the ticket's current tag so a stale
        // closed flag can still be repaired on an unknown-emoji thread. Resolved (✅) counts as
        // done even though its thread stays open/unlocked, hence the emoji check.
        const effectiveTag = derivedTag ?? ticket.statusTag;
        const desiredClosed =
          thread.archived ||
          thread.locked ||
          (effectiveTag?.closesThread ?? false) ||
          effectiveTag?.emoji === RESOLVED_EMOJI;
        if (desiredClosed !== ticket.closed) {
          changes.closed = desiredClosed;
          // false→true: safe past timestamp; true→false (reopened): clear it.
          changes.closedAt = desiredClosed ? (thread.archivedAt ?? ticket.createdAt) : null;
          fixedClosed++;
        }

        if (isUndetermined) undetermined++;

        await this.ticketStore
          .reconcile(ticket.threadId, changes)
          .catch((e) => console.error(`reverify: reconcile failed for ${ticket.threadId}:`, e));
      }

      const summary = new EmbedBuilder()
        .setTitle("Re-Verify complete")
        .setColor(COLORS.success)
        .setDescription(
          [
            `Checked **${checked}** ticket(s).`,
            `Fixed status: **${fixedStatus}**`,
            `Fixed type: **${fixedType}**`,
            `Fixed closed-state: **${fixedClosed}**`,
            `Threads gone (marked closed): **${threadsGone}**`,
            `Undetermined (status/type left unchanged): **${undetermined}**`,
          ].join("\n")
        )
        .setFooter({ text: "DB reconciled to match Discord. No threads were modified." });

      await interaction.editReply({ embeds: [summary] });
    } catch (error) {
      console.error("Re-Verify failed:", error);
      await interaction.editReply({
        embeds: [makeEmbed("Re-Verify failed; you can try again from /config.", COLORS.danger)],
      });
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
        options: [
          {
            type: 3, // STRING
            name: "status",
            description: "New status for this ticket",
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: "report",
        description: "Show a support status report (support/admin only)",
      },
      {
        name: "search-tickets",
        description: "Search support tickets by type, status, user, or billing IDs (support/admin only)",
        options: [
          {
            type: 3, // STRING
            name: "type",
            description: "Ticket type",
            required: false,
            choices: this.categoryRegistry.getAll().map((c) => ({ name: c.label, value: c.id })),
          },
          {
            type: 3, // STRING
            name: "status",
            description: "Ticket status",
            required: false,
            autocomplete: true,
          },
          {
            type: 3, // STRING
            name: "state",
            description: "Open or closed tickets",
            required: false,
            choices: [
              { name: "Open", value: "open" },
              { name: "Closed", value: "closed" },
            ],
          },
          {
            type: 6, // USER
            name: "user",
            description: "Discord user who opened the ticket",
            required: false,
          },
          {
            type: 3, // STRING
            name: "postiz_id",
            description: "Postiz user ID",
            required: false,
          },
          {
            type: 3, // STRING
            name: "stripe_id",
            description: "Stripe customer ID",
            required: false,
          },
          {
            type: 3, // STRING
            name: "text",
            description: "Free-text match on the ticket question or customer name",
            required: false,
          },
          {
            type: 3, // STRING
            name: "opened_after",
            description: "Only tickets opened on/after this date (YYYY-MM-DD)",
            required: false,
          },
          {
            type: 3, // STRING
            name: "opened_before",
            description: "Only tickets opened on/before this date (YYYY-MM-DD)",
            required: false,
          },
        ],
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
