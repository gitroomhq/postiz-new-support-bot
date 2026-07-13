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
  type PartialMessage,
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
import { SettingsStore, isUnicodeEmoji, ReminderTarget, type GlobalSecretColumn, type SecretState } from "../config/SettingsStore";
import { EscalationTier, StatusTag } from "../generated/prisma/client";
import { EscalationTierStore } from "../config/EscalationTierStore";
import { SessionStore } from "../auth/SessionStore";
import { OAuthManager } from "../auth/OAuthManager";
import { StripeClient } from "./StripeClient";
import { GitHubClient } from "./GitHubClient";
import { CategoryRegistry } from "./CategoryRegistry";
import { TicketStore, ReconcileChanges, TicketWithTag } from "./TicketStore";
import { StatusService, RECLOSE_DELAY_MS } from "./StatusService";
import { AuditLogger } from "./AuditLogger";
import { KnowledgeBaseScheduler } from "./KnowledgeBaseScheduler";
import { StripeWebhookHandler } from "./StripeWebhookHandler";
import { CallbackServer } from "../server/CallbackServer";
import { BillingCategory } from "../categories/BillingCategory";
import { BaseCategory, TicketContext } from "../categories/BaseCategory";
import { IntercomSyncService, BridgeSourceMessage } from "../intercom/IntercomSyncService";
import { IntercomStore } from "../intercom/IntercomStore";
import { IntercomClient, IntercomHttpError } from "../intercom/IntercomClient";
import { INTERCOM_WEBHOOK_TOPICS, IntercomWebhookHandler } from "../intercom/IntercomWebhookHandler";
import { IntercomInboxApp } from "../intercom/IntercomInboxApp";
import { BillingAdmin } from "./BillingAdmin";
import { RADAR_LISTS, type BlockService } from "./billing/BlockService";
import { backfillDisputeHistory } from "./billing/DisputeMonitor";
import type { DisputeStore } from "./billing/DisputeStore";
import type { BlockKind } from "./billing/BlockStore";
import { TICKET_ATTR_CSAT, TICKET_ATTR_CSAT_COMMENT, TICKET_ATTR_THREAD } from "../intercom/IntercomEventExecutor";
import { IntercomMode, IntercomRegion } from "../config/SettingsStore";
import {
  log,
  appRelease,
  sentryActive,
  reconfigureSentry,
  sendSentryTestEvent,
  SentryReconfigureResult,
} from "../util/logger";
import {
  withDiscordSpan,
  DiscordSpanCtx,
  normalizeCustomId,
  safe,
  wasCaptured,
  setAiRecordContent,
  metricCount,
} from "../util/instrument";
import { reconfigureInflux, pingInflux, influxActive } from "../metrics/InfluxWriter";
import { VaultService, VAULT_INTEGRATIONS, type VaultTestReport } from "../vault/VaultService";
import type { TemporalOpsBinding, TemporalProducers } from "../temporal/producers";
import { describeSaResult } from "../temporal/searchAttributes";
import { buildIdIsDegenerate } from "../temporal/buildId";
import { validateCertPair } from "../temporal/certs";
import { VaultMigrator, COLUMN_LABELS, type MigrateItemResult, type MigrateReport } from "../vault/VaultMigrator";

type TicketSearchFilters = {
  categoryId?: string;
  statusTagId?: string;
  priorityTagId?: string;
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

  // Bound late from index.ts (the Temporal stack is constructed after the bot).
  private temporalProducers: TemporalProducers | null = null;
  private temporalOps: TemporalOpsBinding | null = null;

  private discordLog = log.child("discord");

  constructor(
    private config: BotConfig,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private sessionStore: SessionStore,
    private oauthManager: OAuthManager,
    private githubClient: GitHubClient,
    private categoryRegistry: CategoryRegistry,
    private audit: AuditLogger,
    private tierStore: EscalationTierStore,
    private intercomSync: IntercomSyncService,
    private intercomStore: IntercomStore,
    private intercomClient: IntercomClient,
    private intercomWebhook: IntercomWebhookHandler,
    private billingAdmin: BillingAdmin,
    private kbScheduler: KnowledgeBaseScheduler,
    private stripeWebhook: StripeWebhookHandler,
    private intercomInboxApp?: IntercomInboxApp,
    // Vault secret storage (drives /config → Vault: panel, test, migrations).
    private vault?: {
      service: VaultService;
      migrator: VaultMigrator;
    },
    // Dispute console (drives /config → Billing → Disputes: Radar provisioning
    // + the one-time all-time dispute history backfill).
    private disputes?: {
      blockService: BlockService;
      stripeClient: StripeClient;
      disputeStore: DisputeStore;
    }
  ) {
    this.client = new Client({
      // MessageContent is privileged (enable it in the Dev Portal too) — without it
      // message bodies/attachments of other users are empty, and the Intercom
      // mirror would push blanks.
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.rest = new REST({ version: "10" }).setToken(config.discord.token);
    this.setupEventHandlers();
  }

  // Wires the Temporal stack in after construction (index.ts builds it later)
  // and fans the producers out to the seams that live behind this class.
  bindTemporal(ops: TemporalOpsBinding): void {
    this.temporalProducers = ops.producers;
    this.temporalOps = ops;
    this.getBillingCategory().setTemporalProducers(ops.producers);
  }

  private setupEventHandlers(): void {
    this.client.once("ready", () => {
      this.discordLog.info("bot ready", { "bot.tag": this.client.user?.tag ?? "" });
    });

    this.client.on("interactionCreate", (interaction) => {
      this.handleInteraction(interaction).catch((e) => this.reportHandlerError("interactionCreate", e));
    });

    // Reconcile ticket status with actions taken outside the bot's own UI.
    this.client.on("guildMemberRemove", (member) => {
      this.handleMemberLeave(member).catch((e) => this.reportHandlerError("guildMemberRemove", e));
    });

    this.client.on("messageCreate", (message) => {
      this.handleMessage(message).catch((e) => this.reportHandlerError("messageCreate", e));
    });

    // Edits/deletes in ticket threads mirror to Intercom as appended
    // correction parts (Intercom has no part-edit API). A customer deleting a
    // leaked secret must not leave it silently frozen in the Intercom copy.
    this.client.on("messageUpdate", (_oldMessage, newMessage) => {
      this.handleMessageEdit(newMessage).catch((e) => this.reportHandlerError("messageUpdate", e));
    });

    this.client.on("messageDelete", (message) => {
      this.handleMessageDelete(message).catch((e) => this.reportHandlerError("messageDelete", e));
    });

    this.client.on("threadUpdate", (oldThread, newThread) => {
      this.handleThreadUpdate(oldThread, newThread).catch((e) => this.reportHandlerError("threadUpdate", e));
    });
  }

  // Outermost error boundary for Discord gateway handlers. Errors thrown inside
  // a withDiscordSpan wrapper were already captured there with full interaction
  // context — only log those; capture everything else.
  private reportHandlerError(event: string, e: unknown): void {
    if (wasCaptured(e)) {
      this.discordLog.warn("handler failed (captured in span)", {
        "discord.event": event,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    } else {
      this.discordLog.error("handler crashed", e, { "discord.event": event });
    }
  }

  // A member left the guild: close out every open ticket they own.
  private async handleMemberLeave(member: GuildMember | PartialGuildMember): Promise<void> {
    const closingTag = this.settingsStore.closingTag();
    if (!closingTag) return;

    const tickets = await this.ticketStore.listOpenByCustomerId(member.id);
    if (tickets.length === 0) return;
    await withDiscordSpan(
      {
        op: "discord.event",
        name: "member.leave_cleanup",
        userId: member.id,
        guildId: member.guild?.id,
        attributes: { "tickets.count": tickets.length },
      },
      () => this.closeTicketsForLeaver(member, tickets, closingTag)
    );
  }

  private async closeTicketsForLeaver(
    member: GuildMember | PartialGuildMember,
    tickets: TicketWithTag[],
    closingTag: StatusTag
  ): Promise<void> {
    for (const ticket of tickets) {
      const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
      if (channel?.isThread()) {
        await this.statusService.applyStatus(channel as ThreadChannel, ticket, closingTag, {
          actorName: "System (member left)",
          silent: true,
        });
      } else {
        // Thread is gone/unreachable — still reconcile the DB. This path bypasses
        // StatusService, so the Intercom push needs its own hook.
        await this.ticketStore.close(ticket.threadId).catch(() => {});
        safe(
          this.intercomSync.onStatusChanged(ticket.threadId, ticket.statusTag ?? null, closingTag, "System (member left)"),
          "intercom-sync",
          { "ticket.thread_id": ticket.threadId, "sync.event": "status_changed" }
        );
      }
    }
  }

  // Reduces a discord.js message to the bridge shape (also used by the backfill
  // walker). Embed-only messages (historical AI answers, the "Your question"
  // embed) are flattened to text so they don't mirror as blanks. Mentions are
  // resolved to real names HERE — the renderer downstream only has generic
  // fallbacks (@user/@role/#channel).
  private toBridgeMessage(message: Message, member: GuildMember | null): BridgeSourceMessage {
    const embedText = message.embeds
      .map((e) => [e.title, e.description].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n");
    let content = message.content || embedText || "";
    content = content
      .replace(/<@!?(\d+)>/g, (m, id) => {
        const user = message.mentions.users.get(id);
        const mentionedMember = message.mentions.members?.get(id);
        return user ? `@${mentionedMember?.displayName ?? user.displayName ?? user.username}` : m;
      })
      .replace(/<@&(\d+)>/g, (m, id) => {
        const role = message.mentions.roles.get(id);
        return role ? `@${role.name}` : m;
      })
      .replace(/<#(\d+)>/g, (m, id) => {
        const channel = message.mentions.channels.get(id);
        return channel && "name" in channel && channel.name ? `#${channel.name}` : m;
      });
    return {
      discordMessageId: message.id,
      authorId: message.author.id,
      authorName: member?.displayName ?? message.author.displayName ?? message.author.username,
      authorIsBot: message.author.bot,
      content,
      attachments: message.attachments.map((a) => ({
        url: a.url,
        filename: a.name ?? "attachment",
        size: a.size,
      })),
      createdAt: message.createdAt,
    };
  }

  // Human messages in tracked ticket threads drive two things:
  // 1. the first support reply stamps firstResponseAt (response-time metrics),
  // 2. a customer reply to a Resolved ticket reopens it to the initial status.
  // Guards stay unspanned so ordinary server chatter costs nothing; only
  // messages that belong to a tracked ticket become transactions.
  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const ticket = await this.ticketStore.getByThreadId(message.channelId);
    if (!ticket) return;

    await withDiscordSpan(
      {
        op: "discord.message",
        name: "ticket.message",
        userId: message.author.id,
        username: message.author.username,
        guildId: message.guildId,
        channelId: message.channelId,
        attributes: { "ticket.thread_id": ticket.threadId },
      },
      () => this.processTicketMessage(message, ticket)
    );
  }

  // Human edit in a tracked ticket thread → appended "✏️ edited" part in
  // Intercom. editedAt gate: Discord also fires messageUpdate for embed/link-
  // preview attachment with unchanged content — those carry no editedTimestamp.
  private async handleMessageEdit(newMessage: Message | PartialMessage): Promise<void> {
    const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!message || message.author.bot) return;
    if (!message.editedAt) return;
    if (!message.channel.isThread()) return;
    const ticket = await this.ticketStore.getByThreadId(message.channelId);
    if (!ticket) return;

    const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null)) ?? null;
    const isStaff = !!member && this.isStaffMember(member);
    safe(
      this.intercomSync.onMessageEdited(ticket, this.toBridgeMessage(message, member), isStaff, message.editedAt.toISOString()),
      "intercom-sync",
      { "ticket.thread_id": ticket.threadId, "sync.event": "message_edited" }
    );
  }

  // Human delete in a tracked ticket thread → appended "🗑️ deleted" part.
  // Deleted messages can't be fetched — partials still carry id + channel; an
  // unknown author is safe because the executor only mirrors deletions of
  // messages its delivery ledger confirms were mirrored (bot messages never
  // carry their Discord id there).
  private async handleMessageDelete(message: Message | PartialMessage): Promise<void> {
    if (message.author?.bot) return;
    if (!message.channel.isThread()) return;
    const ticket = await this.ticketStore.getByThreadId(message.channelId);
    if (!ticket) return;

    const author = message.author
      ? {
          id: message.author.id,
          name: message.member?.displayName ?? message.author.displayName ?? message.author.username,
        }
      : null;
    safe(this.intercomSync.onMessageDeleted(ticket, message.id, author), "intercom-sync", {
      "ticket.thread_id": ticket.threadId,
      "sync.event": "message_deleted",
    });
  }

  private async processTicketMessage(message: Message, ticket: TicketWithTag): Promise<void> {
    // Mirror every human message to Intercom (before the early returns below —
    // chatter in closed tickets must mirror too). Fire-and-forget: an Intercom
    // problem never touches the Discord flow.
    const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null)) ?? null;
    const isStaff = !!member && this.isStaffMember(member);
    safe(this.intercomSync.onHumanMessage(ticket, this.toBridgeMessage(message, member), isStaff), "intercom-sync", {
      "ticket.thread_id": ticket.threadId,
      "sync.event": "human_message",
    });

    // Nudge the ticket workflow (re-close deadline push, retention
    // freshness) whenever Temporal is configured — a paused worker just
    // processes the parked signals on resume. The DB stamps below stay —
    // they are the rehydration source when a completed workflow restarts.
    if (this.temporalProducers?.routable()) {
      void this.temporalProducers
        .humanMessage(ticket.threadId, {
          atMs: message.createdTimestamp,
          isCustomer: message.author.id === ticket.customerId,
          isStaff,
        })
        .catch(() => {});
    }

    // Activity in a Closed ticket (staff can post into locked threads; posting un-archives
    // them): don't reopen, just re-close after 30 quiet minutes. Every message — customer
    // or support — pushes the deadline back.
    if (ticket.closed && ticket.statusTag?.closesThread) {
      await this.ticketStore.scheduleReclose(ticket.threadId, new Date(Date.now() + RECLOSE_DELAY_MS));
      return;
    }

    // The customer answered a Waiting-for-Customer ticket: move it back into the team's
    // active queue instead of idling until a reminder fires. Preferred destination is
    // the configured customer-reply target tag (default "Waiting for Developer", set via
    // /config → Tags); when none is configured (or it's unusable) fall back to the status
    // the ticket had before, and finally to the initial status.
    if (
      !ticket.closed &&
      ticket.statusTag?.reminderTarget === "CUSTOMER" &&
      !ticket.statusTag.closesThread &&
      message.author.id === ticket.customerId
    ) {
      const usable = (t: StatusTag | undefined): t is StatusTag =>
        !!t && !t.closesThread && t.reminderTarget !== "CUSTOMER";
      const replyTarget = this.settingsStore.customerReplyTarget();
      const prevTag = ticket.prevStatusTagId ? this.settingsStore.tagById(ticket.prevStatusTagId) : undefined;
      const target = usable(replyTarget) ? replyTarget : usable(prevTag) ? prevTag : this.settingsStore.initialTag();
      if (target && target.id !== ticket.statusTagId) {
        await this.statusService.applyStatus(message.channel as ThreadChannel, ticket, target, {
          actorName: "Customer reply",
        });
      }
    }
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

    // Open or closed only (the resolved state is gone): any manual lock or
    // archive reconciles to the closing tag.
    const target = this.settingsStore.closingTag();
    if (!target) return;

    // Idempotency backstop: applyStatus persists the status BEFORE it locks/archives, so
    // the bot's own edits re-fire this event already at the target status — skip them.
    if (ticket.statusTagId === target.id) return;

    await withDiscordSpan(
      {
        op: "discord.event",
        name: "thread.manual_close",
        guildId: newThread.guildId,
        channelId: newThread.id,
        attributes: { "ticket.thread_id": ticket.threadId },
      },
      async () => {
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
          this.discordLog.warn("threadUpdate: could not read audit log, skipping status sync", {
            "ticket.thread_id": ticket.threadId,
            "error.message": error instanceof Error ? error.message : String(error),
          });
          return;
        }

        await this.statusService.applyStatus(newThread, ticket, target, {
          actorName: "Manual thread action",
        });
      }
    );
  }

  // Root span + isolation scope per interaction: every command, button, select
  // and modal becomes a transaction carrying the acting Discord user, with all
  // downstream work (prisma, fetch, gen_ai, Stripe MCP) nested underneath.
  private interactionSpanCtx(interaction: Interaction): DiscordSpanCtx {
    const base = {
      userId: interaction.user?.id,
      username: interaction.user?.username,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    };
    if (interaction.isChatInputCommand()) {
      const sub = interaction.options.getSubcommand(false);
      return {
        ...base,
        op: "discord.command",
        name: `/${interaction.commandName}${sub ? ` ${sub}` : ""}`,
        attributes: { "discord.command": interaction.commandName, ...(sub ? { "discord.subcommand": sub } : {}) },
      };
    }
    if (interaction.isAutocomplete()) {
      return { ...base, op: "discord.autocomplete", name: `autocomplete /${interaction.commandName}` };
    }
    if (interaction.isButton()) {
      const id = normalizeCustomId(interaction.customId);
      return { ...base, op: "discord.button", name: `button ${id}`, attributes: { "discord.custom_id": id } };
    }
    if (interaction.isModalSubmit()) {
      const id = normalizeCustomId(interaction.customId);
      return { ...base, op: "discord.modal", name: `modal ${id}`, attributes: { "discord.custom_id": id } };
    }
    if (interaction.isAnySelectMenu()) {
      const id = normalizeCustomId(interaction.customId);
      return {
        ...base,
        op: "discord.select",
        name: `select ${id}`,
        attributes: { "discord.custom_id": id, "discord.values_count": interaction.values?.length ?? 0 },
      };
    }
    return { ...base, op: "discord.event", name: "interaction other" };
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    await withDiscordSpan(this.interactionSpanCtx(interaction), async () => {
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
      } else if (interaction.isUserSelectMenu()) {
        // Only /billing uses user-select menus so far.
        if (interaction.customId.startsWith("billadmin_")) {
          await this.billingAdmin.handleUserSelect(interaction);
        }
      } else if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
      }
    });
  }

  // Agent ticket-management commands live in Intercom now (agent-rip); the
  // surviving commands are the customer entry point, admin config, and the
  // Stripe-side staff tooling Intercom doesn't cover.
  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "setup") {
      await this.postSupportPanel(interaction);
    } else if (interaction.commandName === "config") {
      await this.handleConfigCommand(interaction);
    } else if (interaction.commandName === "search-tickets") {
      await this.handleSearchTicketsCommand(interaction);
    } else if (interaction.commandName === "charge") {
      await this.handleChargeCommand(interaction);
    } else if (interaction.commandName === "billing") {
      await this.billingAdmin.handleCommand(interaction);
    }
  }

  // ---- /charge: staff resolution of guardrail-blocked self-service refunds ----

  private async handleChargeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = await this.requireSupportOrAdmin(interaction);
    if (!member) return;

    const billing = this.getBillingCategory();
    if (interaction.options.getSubcommand() === "approve") {
      await billing.approveBlockedCharge(interaction, member);
    } else {
      await billing.denyBlockedCharge(interaction, member);
    }
  }

  // ---- /search-tickets (kept per user decision: cross-ticket lookup by
  // billing ids/text is still useful from Discord even with agents in
  // Intercom) ----

  // Live autocomplete for the status filter (runtime-configurable tags).
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (interaction.commandName === "search-tickets" && focused.name === "status") {
      const query = focused.value.toLowerCase();
      const tags = this.settingsStore
        .tags()
        .filter((t) => !query || t.label.toLowerCase().includes(query))
        .slice(0, 25)
        .map((t) => ({ name: `${t.emoji} ${t.label}`, value: t.id }));
      await interaction.respond(tags).catch(() => {});
      return;
    }
    await interaction.respond([]).catch(() => {});
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
      // Legacy chip: the priority axis is retired, but old tickets keep their
      // stored priority until the follow-up release drops the column.
      const priorityTag = t.priorityTagId ? this.settingsStore.priorityById(t.priorityTagId) : undefined;
      const priority = priorityTag ? ` · ${priorityTag.emoji} ${priorityTag.label}` : "";
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
      return `${status}${priority} — <#${t.threadId}> — ${category}\n${who}${postiz}${stripe} · ${created}${closedMark}${snippet}`;
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

  // Old messages permanently carry components of retired agent features —
  // answer them with a notice instead of Discord's generic "interaction
  // failed". (csat: and create_issue: stay live: legacy customer surfaces.)
  private static readonly DEAD_BUTTON_PREFIXES = [
    "feedback_yes:", // auto-answer "did this help?"
    "feedback_no:",
    "ai_draft_", // /ai draft post/discard
    "report_", // report drill-downs + pagers
    "setstatus_", // /status confirm/cancel
    "setpriority_", // /priority confirm/cancel
  ];

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith("search_page:")) {
      await this.handleSearchPage(interaction);
      return;
    }

    if (DiscordBot.DEAD_BUTTON_PREFIXES.some((p) => interaction.customId.startsWith(p))) {
      await interaction.reply({
        embeds: [
          makeEmbed(
            "This button belongs to a retired bot feature — support now runs through the ticket thread itself.",
            COLORS.neutral
          ),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId.startsWith("config_")) {
      await this.handleConfigButton(interaction);
      return;
    }

    // billadmin_ is the /billing admin panel — distinct from the customer-facing
    // billing_ prefix owned by BillingCategory.
    if (interaction.customId.startsWith("billadmin_")) {
      await this.billingAdmin.handleButton(interaction);
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

    if (
      interaction.customId.startsWith("bill_disc_ok:") ||
      interaction.customId.startsWith("bill_disc_no:") ||
      interaction.customId.startsWith("bill_ref_ok:") ||
      interaction.customId.startsWith("bill_ref_no:")
    ) {
      const allowedUserId = interaction.customId.split(":")[1];
      if (interaction.user.id !== allowedUserId) {
        await interaction.reply({ embeds: [makeEmbed("Only the original requester can use this.", COLORS.danger)], flags: 64 });
        return;
      }
      const billing = this.getBillingCategory();
      if (interaction.customId.startsWith("bill_disc_ok:")) {
        await billing.handleAcceptDiscount(interaction);
      } else if (interaction.customId.startsWith("bill_disc_no:")) {
        await billing.handleDeclineDiscount(interaction);
      } else if (interaction.customId.startsWith("bill_ref_ok:")) {
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
        log.child("ticket").info("ticket.created", {
          "ticket.thread_id": thread.id,
          "ticket.category": category.id,
          "ticket.customer_id": customerId,
          "ticket.has_question": !!question,
        });
        metricCount("tickets.created", 1, { category: category.id });
        void this.audit.log({
          title: "🎫 Ticket opened",
          severity: "success",
          actor: displayName,
          threadId: thread.id,
          fields: [
            { name: "Customer", value: `<@${customerId}>`, inline: true },
            { name: "Category", value: `${category.emoji} ${category.label}`, inline: true },
            ...(question ? [{ name: "Question", value: question }] : []),
          ],
        });
        if (this.temporalProducers?.routable()) {
          // One signal-with-start births the ticket workflow — it enqueues the
          // Intercom ensure and owns the ticket's timers. aiSolve is always
          // false: the auto-answer was retired with the agent-rip (the
          // workflow branch stays dormant for old-history replays).
          void this.temporalProducers
            .ticketCreated(thread.id, {
              categoryId: category.id,
              question: question ?? null,
              customerId,
              displayName,
              aiSolve: false,
            })
            .catch(() => {});
        } else {
          safe(this.intercomSync.onTicketCreated(thread.id, category.label, question ?? null), "intercom-sync", {
            "ticket.thread_id": thread.id,
            "sync.event": "ticket_created",
          });
        }
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
      if (member && this.isStaffMember(member)) {
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

    if (interaction.customId === "config_tier_pick") {
      await this.handleConfigTierPick(interaction);
      return;
    }

    if (interaction.customId.startsWith("config_intercom_")) {
      await this.handleIntercomSelect(interaction);
      return;
    }

    if (interaction.customId.startsWith("billadmin_")) {
      await this.billingAdmin.handleSelectMenu(interaction);
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

    // Must run before the category fall-through below.
    if (interaction.customId.startsWith("billadmin_")) {
      await this.billingAdmin.handleModal(interaction);
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

    await category.handleModalSubmit(interaction, threadsChannel, this.buildTicketContext(category), {
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

      // Prefer the DB-stored verbatim question (nothing else from the thread,
      // so no incidental customer PII lands in the public repo). The AI answer
      // comes from the legacy embed scan — this button only exists on old
      // auto-answer messages (the auto-answer itself was retired).
      const ticket = await this.ticketStore.getByThreadId(thread.id).catch(() => null);
      let userQuestion = ticket?.question ?? "";
      let aiAnswer = "";
      if (!userQuestion || !aiAnswer) {
        const messages = await thread.messages.fetch({ limit: 10 });
        const ordered = [...messages.values()].reverse();
        if (!userQuestion) {
          const q = ordered.find((m) => m.embeds.length > 0 && m.embeds[0].title === "Your question");
          userQuestion = q?.embeds[0].description || "Issue from Discord";
        }
        if (!aiAnswer) {
          aiAnswer = ordered
            .filter((m) => m.embeds.length > 0 && m.embeds[0].title !== "Your question")
            .map((m) => m.embeds[0].description)
            .filter(Boolean)
            .join("\n\n");
        }
      }

      const isBug = issueLabel === "bug";
      const heading = isBug ? "Bug Report" : "Feature Request";
      const titlePrefix = isBug ? "Bug:" : "Feature request:";

      const issueBody = [
        `## ${heading}`,
        ``,
        `**User report:** ${userQuestion}`,
        ``,
        `## AI answer`,
        ``,
        aiAnswer || "No AI answer was recorded.",
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

      log.child("github").info("github.issue.created", {
        "ticket.thread_id": interaction.channel?.isThread() ? interaction.channelId : "",
        "issue.label": issueLabel,
        "issue.url": issueUrl,
      });
      void this.audit.log({
        title: "🐙 GitHub issue created",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        threadId: interaction.channel?.isThread() ? interaction.channelId : undefined,
        fields: [
          { name: "Issue", value: issueUrl, inline: true },
          { name: "Type", value: issueLabel, inline: true },
        ],
      });

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
      log.child("github").error("issue creation failed", error, {
        "ticket.thread_id": interaction.channel?.isThread() ? interaction.channelId : "",
        "issue.label": issueLabel,
      });
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
      log.child("ticket").error("csat record failed", e, { "ticket.thread_id": threadId });
      return false;
    });
    if (recorded) {
      log.child("ticket").info("csat.recorded", {
        "ticket.thread_id": threadId,
        "csat.score": score,
      });
      safe(this.intercomSync.onCsat(threadId, score), "intercom-sync", {
        "ticket.thread_id": threadId,
        "sync.event": "csat",
      });
      void this.audit.log({
        title: "⭐ CSAT rating",
        severity: score >= 4 ? "success" : score === 3 ? "warn" : "danger",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        threadId,
        fields: [{ name: "Score", value: `${score}/5 ⭐`, inline: true }],
      });
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
      safe(this.intercomSync.onCsat(threadId, ticket.csatScore, comment), "intercom-sync", {
        "ticket.thread_id": threadId,
        "sync.event": "csat_comment",
      });
      void this.audit.log({
        title: "💬 CSAT comment",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        threadId,
        fields: [
          { name: "Score", value: `${ticket.csatScore}/5 ⭐`, inline: true },
          { name: "Comment", value: comment },
        ],
      });
    }
    await interaction.reply({
      embeds: [makeEmbed(`Thanks for the feedback${comment ? " and the comment" : ""}! It helps us improve. ⭐`, COLORS.success)],
      flags: 64,
    });
  }

  // ---- Permission helpers ----

  private async fetchMember(interaction: Interaction): Promise<GuildMember | null> {
    if (!interaction.guild) return null;
    return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }

  private isAdmin(interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ChannelSelectMenuInteraction | ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
  }

  // Staff = Administrator or a member of any escalation-tier role (legacy support
  // role while no tiers are configured).
  private isStaffMember(member: GuildMember): boolean {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return this.tierStore
      .staffRoleIds(this.settingsStore.supportRoleId())
      .some((roleId) => member.roles.cache.has(roleId));
  }

  // One audit entry per admin config mutation, e.g. "AI solve → off".
  private auditConfig(
    interaction: { user: { displayName: string; displayAvatarURL(): string } },
    change: string
  ): void {
    void this.audit.log({
      title: "⚙️ Config updated",
      severity: "neutral",
      actor: interaction.user.displayName,
      actorIconUrl: interaction.user.displayAvatarURL(),
      fields: [{ name: "Change", value: change }],
    });
  }

  private async requireSupportOrAdmin(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction
  ): Promise<GuildMember | null> {
    const member = await this.fetchMember(interaction);
    const ok = !!member && this.isStaffMember(member);
    if (!ok) {
      await interaction.reply({ embeds: [makeEmbed("You don't have permission to do that.", COLORS.danger)], flags: 64 });
      return null;
    }
    return member;
  }


  // Best-effort: the customer is the only non-bot human in a private thread who
  // isn't on a staff (escalation-tier) role. Returns nulls when it can't be determined.
  private async deriveCustomerId(thread: ThreadChannel): Promise<{ id: string | null; displayName: string | null }> {
    const staffRoleIds = this.tierStore.staffRoleIds(this.settingsStore.supportRoleId());
    try {
      const members = await thread.members.fetch();
      const candidates: GuildMember[] = [];
      for (const tm of members.values()) {
        if (tm.id === this.client.user?.id) continue;
        const gm = await thread.guild.members.fetch(tm.id).catch(() => null);
        if (!gm || gm.user.bot) continue;
        if (staffRoleIds.some((roleId) => gm.roles.cache.has(roleId))) continue;
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
    const tiers = this.tierStore.list();
    const embed = new EmbedBuilder()
      .setTitle("Support Bot Configuration")
      .setColor(0x5865f2)
      .addFields(
        {
          name: "General",
          value: [
            `Threads channel: ${s.threadsChannelId() ? `<#${s.threadsChannelId()}>` : "_not set_"}`,
            `GitHub repo: ${s.githubRepo() ? `\`${s.githubRepo()}\`` : "_not set_"}`,
            `Ticket limits: ${s.maxOpenTicketsPerUser() > 0 ? `max ${s.maxOpenTicketsPerUser()} open` : "no cap"} · ${s.ticketCooldownMinutes() > 0 ? `${s.ticketCooldownMinutes()}m cooldown` : "no cooldown"}`,
          ].join("\n"),
          inline: true,
        },
        {
          name: "Workflow",
          value: [
            `Status tags: ${s.tags().length}`,
            `Staff roles: ${
              tiers.length
                ? tiers.map((t) => t.name).join(" · ")
                : s.supportRoleId()
                  ? "_legacy support role_"
                  : "_not set_"
            }`,
          ].join("\n"),
          inline: true,
        },
        {
          name: "Audit & Billing",
          value: [
            `Audit log: ${s.auditLogChannelId() ? `<#${s.auditLogChannelId()}>` : "off"}`,
            `Billing audit: ${s.billingAuditChannelId() ? `<#${s.billingAuditChannelId()}>` : "_in-thread ping_"}`,
          ].join("\n"),
          inline: false,
        },
        {
          name: "Integrations",
          value: [
            `Intercom: ${s.intercomMode() === "none" ? "off" : `${s.intercomMode()}${s.intercomConfigured() ? "" : " ⚠️ not configured"}`}`,
            `Inactivity sweeper: ${s.inactivityEnabled() ? `on · agent ${s.inactivityAgentWaitDays()}d · customer ${s.inactivityCustomerWaitDays()}d` : "off"}`,
            `Sentry: ${
              s.sentryDsn()
                ? `${sentryActive() ? "on" : "configured ⚠️ restart pending"} · traces ${s.sentryTracesSampleRate()} · logs ${s.sentryLogsEnabled() ? "on" : "off"}`
                : "off"
            }`,
          ].join("\n"),
          inline: false,
        },
        {
          name: "AI (dispute evidence) & Analytics",
          value: [
            `Model: \`${s.aiModel()}\``,
            `KB refresh: ${s.kbRefreshEnabled() ? `every ${s.kbRefreshIntervalHours()}h` : "off"}${s.kbLastRefreshAt() ? ` · last <t:${Math.floor(s.kbLastRefreshAt()!.getTime() / 1000)}:R>` : ""}`,
            `InfluxDB: ${influxActive() ? `on → \`${s.influxBucket()}\`` : s.influxEnabled() ? "enabled ⚠️ incomplete config" : "off"}`,
          ].join("\n"),
          inline: false,
        },
        {
          name: "Infrastructure",
          value: [
            `Vault: ${this.vaultStatusLine()}`,
            `Temporal: ${
              s.temporalEnabled()
                ? this.temporalOps?.service.state() === "up"
                  ? "on · connected"
                  : "on ⚠️ server unreachable"
                : this.temporalOps?.service.configured()
                  ? "configured · off"
                  : "off"
            }`,
          ].join("\n"),
          inline: false,
        }
      );

    // Nav mirrors the embed fields: three core sections, then three hub
    // buttons that open sub-menus (same pattern as the Workflow and
    // Reporting & Audit hubs), then utilities.
    const core = [
      new ButtonBuilder().setCustomId("config_general").setLabel("General Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_workflow").setLabel("Workflow").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_reporting").setLabel("Audit & Billing").setStyle(ButtonStyle.Primary),
    ];
    const hubs = [
      new ButtonBuilder().setCustomId("config_integrations").setLabel("Integrations").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_aianalytics").setLabel("AI & Analytics").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_infra").setLabel("Infrastructure").setStyle(ButtonStyle.Primary),
    ];
    const utility = [
      new ButtonBuilder().setCustomId("config_reverify").setLabel("Re-Verify").setStyle(ButtonStyle.Secondary),
    ];
    if (!s.backfillDone()) {
      utility.push(
        new ButtonBuilder().setCustomId("config_backfill").setLabel("Backfill existing tickets").setStyle(ButtonStyle.Secondary)
      );
    }

    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(core),
        new ActionRowBuilder<ButtonBuilder>().addComponents(hubs),
        new ActionRowBuilder<ButtonBuilder>().addComponents(utility),
      ],
    };
  }

  private buildWorkflowHubPanel() {
    const s = this.settingsStore;
    const tiers = this.tierStore.list();
    const embed = new EmbedBuilder()
      .setTitle("Workflow")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Status tags:** ${s.tags().length ? s.tags().map((t) => `${t.emoji} ${t.label}`).join(" · ") : "_none_"}`,
          `**Staff roles:** ${
            tiers.length
              ? tiers.map((t) => t.name).join(" · ")
              : s.supportRoleId()
                ? "_legacy support role_"
                : "_not set_"
          }`,
        ].join("\n")
      );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_tags").setLabel("Manage Tags").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_escalation").setLabel("Staff Roles").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [buttons] };
  }

  // id config_reporting kept for Back-button routing from old ephemerals.
  private buildReportingHubPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Audit & Billing")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Audit log:** ${s.auditLogChannelId() ? `<#${s.auditLogChannelId()}>` : "off"}`,
          `**Billing audit:** ${s.billingAuditChannelId() ? `<#${s.billingAuditChannelId()}>` : "_in-thread ping_"}`,
        ].join("\n")
      );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_audit").setLabel("Audit Log").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_billing").setLabel("Billing").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [buttons] };
  }

  // The three right-hand hub panels — same pattern as Workflow / Reporting &
  // Audit: live status lines, one button per sub-panel, Back to main.
  // Sub-panels opened from a hub route their own Back button to the hub.
  private buildIntegrationsHubPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Integrations")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Intercom:** ${s.intercomMode() === "none" ? "off" : `${s.intercomMode()}${s.intercomConfigured() ? "" : " ⚠️ not configured"}`}`,
          `**Sentry:** ${
            s.sentryDsn()
              ? `${sentryActive() ? "on" : "configured ⚠️ restart pending"} · traces ${s.sentryTracesSampleRate()} · logs ${s.sentryLogsEnabled() ? "on" : "off"}`
              : "off"
          }`,
        ].join("\n")
      );
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom").setLabel("Intercom").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_sentry").setLabel("Sentry").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [buttons] };
  }

  private buildAiAnalyticsHubPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("AI (dispute evidence) & Analytics")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**AI model:** \`${s.aiModel()}\``,
          `**KB refresh:** ${s.kbRefreshEnabled() ? `every ${s.kbRefreshIntervalHours()}h` : "off"}${s.kbLastRefreshAt() ? ` · last <t:${Math.floor(s.kbLastRefreshAt()!.getTime() / 1000)}:R>` : ""}`,
          `**InfluxDB:** ${influxActive() ? `on → \`${s.influxBucket()}\`` : s.influxEnabled() ? "enabled ⚠️ incomplete config" : "off"}`,
        ].join("\n")
      );
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_ai").setLabel("AI (dispute evidence)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_analytics").setLabel("Analytics").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [buttons] };
  }

  private buildInfrastructureHubPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Infrastructure")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Vault:** ${this.vaultStatusLine()}`,
          `**Temporal:** ${
            s.temporalEnabled()
              ? this.temporalOps?.service.state() === "up"
                ? "on · connected"
                : "on ⚠️ server unreachable"
              : this.temporalOps?.service.configured()
                ? "configured · off"
                : "off"
          }`,
        ].join("\n")
      );
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_vault").setLabel("Vault").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_temporal").setLabel("Temporal").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [buttons] };
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
          `**Max refunds per 24h (per user):** ${s.refundMaxPer24hPerUser() ?? "_no limit_"}`,
          `**Min server membership age:** ${s.refundMinMemberAgeDays() != null ? `${s.refundMinMemberAgeDays()} day(s)` : "_no minimum_"}`,
          `**Plan allowlist:** ${s.allowedPriceIds().length ? `${s.allowedPriceIds().length} plan(s) offered in /billing pickers` : "_all active plans offered_"}`,
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
      new ButtonBuilder().setCustomId("config_billing_plans").setLabel("Plan Allowlist").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_stripe_webhook").setLabel("Webhooks").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_disputes").setLabel("Disputes").setStyle(ButtonStyle.Primary)
    );
    const buttons2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_billing_clear_channel").setLabel("Clear Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_reporting").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect), buttons, buttons2],
    };
  }

  private buildDisputesConfigPanel() {
    const s = this.settingsStore;
    const listLine = (kind: BlockKind) => {
      const spec = RADAR_LISTS[kind];
      const id = s.radarListId(kind);
      return `• \`@${spec.alias}\` (${kind}) — ${id ? `provisioned \`${id}\`` : "_not provisioned_"}`;
    };
    const embed = new EmbedBuilder()
      .setTitle("Dispute Settings")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Auto-cancel subscriptions on dispute:** ${s.disputeAutoCancelSub() ? "on" : "off"}`,
          `**Auto-block card+email+customer on dispute:** ${s.disputeAutoBlock() ? "on" : "off"}`,
          `**Auto-attach receipt as evidence on dispute:** ${s.disputeAutoAttachReceipt() ? "on" : "off"} — stages the charge's receipt/invoice PDF in the \`receipt\` slot (submit stays manual)`,
          `**Evidence-due reminder lead:** ${s.disputeReminderDays()} day(s) before the deadline (≤1 ping / 24h / dispute)`,
          `**Urgent tier:** < ${s.disputeUrgentHours()}h to deadline with nothing submitted → red alert${
            s.disputeUrgentRoleId() ? ` + <@&${s.disputeUrgentRoleId()}> mention` : " (no role set — select one below to get pinged)"
          }`,
          `**Ratio thresholds:** warn ≥ ${s.disputeRatioWarnPct()}% · critical ≥ ${s.disputeRatioCriticalPct()}% (month VAMP-style figure) — current level: **${s.disputeRatioLastLevel()}**`,
          `**History backfill:** ${
            s.disputeBackfillDoneAt()
              ? `last run <t:${Math.floor(s.disputeBackfillDoneAt()!.getTime() / 1000)}:R>`
              : "_never run_ — /billing → Disputes → Stats only covers disputes seen since the mirror existed"
          }`,
          "",
          "**Radar value lists** (the Stripe half of the blocklist):",
          listLine("card_fingerprint"),
          listLine("email"),
          listLine("customer_id"),
          listLine("ip_address"),
          "",
          "⚠️ Value lists only block payments once a **Radar rule references them** — rules can't be created via API. One-time setup in the Stripe Dashboard → Radar → Rules (needs **Radar for Fraud Teams**), e.g.:",
          "```",
          `Block if :card_fingerprint: in @${RADAR_LISTS.card_fingerprint.alias}`,
          `Block if :email: in @${RADAR_LISTS.email.alias}`,
          `Block if :customer: in @${RADAR_LISTS.customer_id.alias}`,
          `Block if :ip_address: in @${RADAR_LISTS.ip_address.alias}`,
          "```",
          "_Verify the attribute names against the rule editor's autocomplete — Stripe occasionally renames them._",
          "",
          "Reminders + ratio alerts post to the billing audit channel. The dispute looper ticks every 6h (**Run Check Now** forces one).",
        ].join("\n")
      );
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_disputes_toggle_cancel")
        .setLabel(`Auto-cancel: ${s.disputeAutoCancelSub() ? "on" : "off"}`)
        .setStyle(s.disputeAutoCancelSub() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_disputes_toggle_block")
        .setLabel(`Auto-block: ${s.disputeAutoBlock() ? "on" : "off"}`)
        .setStyle(s.disputeAutoBlock() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_disputes_toggle_receipt")
        .setLabel(`Auto-receipt: ${s.disputeAutoAttachReceipt() ? "on" : "off"}`)
        .setStyle(s.disputeAutoAttachReceipt() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_disputes_limits").setLabel("Set Thresholds").setStyle(ButtonStyle.Primary)
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_disputes_radar").setLabel("Provision Radar Lists").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_disputes_backfill").setLabel("Backfill History").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_disputes_run_now").setLabel("Run Check Now").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_disputes_urgent_role_clear")
        .setLabel("Clear Urgent Role")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!s.disputeUrgentRoleId()),
      new ButtonBuilder().setCustomId("config_billing").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId("config_disputes_urgent_role")
      .setPlaceholder("Urgent dispute role (mentioned when < urgent-hours remain)");
    if (s.disputeUrgentRoleId()) roleSelect.setDefaultRoles(s.disputeUrgentRoleId()!);
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect), row1, row2],
    };
  }

  private buildStripeWebhookPanel() {
    const s = this.settingsStore;
    const base = s.resolvedPublicBaseUrl();
    const embed = new EmbedBuilder()
      .setTitle("Stripe Webhooks")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Status:** ${s.stripeWebhookEnabled() ? "on" : "off"}`,
          `**Endpoint URL:** ${base ? `\`${base}/stripe/webhook\`` : "⚠️ _no public URL — set one below_"}`,
          `**Registered endpoint:** ${s.stripeWebhookEndpointId() ? `\`${s.stripeWebhookEndpointId()}\`` : "_none_"}`,
          `**Signing secret:** ${s.stripeWebhookSecret() ? "stored ✅" : "_not set_"}`,
          "",
          "Alerts for **disputes** and **early-fraud warnings** post to the billing audit channel (or the audit log). The endpoint is registered automatically via the Stripe API — no dashboard needed.",
          "The signing secret is returned only once at creation; use **Rotate Secret** if it is ever lost.",
        ].join("\n")
      );
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_stripe_webhook_toggle")
        .setLabel(`Enabled: ${s.stripeWebhookEnabled() ? "on" : "off"}`)
        .setStyle(s.stripeWebhookEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_stripe_webhook_register").setLabel("Register / Reconcile").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_stripe_webhook_rotate").setLabel("Rotate Secret").setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_stripe_webhook_url").setLabel("Set Public URL").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_billing").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row1, row2] };
  }

  private buildAuditPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Audit Log")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Channel:** ${s.auditLogChannelId() ? `<#${s.auditLogChannelId()}>` : "_not set — audit trail disabled_"}`,
          "",
          "Every action is posted here: tickets opened/closed/resolved/reopened, status changes, staff notes, canned responses, CSAT ratings, reminders, GitHub issues, and config changes.",
          "⚠️ Staff notes appear in this channel — make sure it is **staff-only**.",
        ].join("\n")
      );

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("config_set_auditlogchannel")
      .setPlaceholder("Audit log channel")
      .addChannelTypes(ChannelType.GuildText);
    if (s.auditLogChannelId()) channelSelect.setDefaultChannels(s.auditLogChannelId()!);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_audit_clear_channel").setLabel("Clear Channel").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_reporting").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelSelect), buttons],
    };
  }

  private async buildIntercomPanel() {
    const s = this.settingsStore;
    const mode = s.intercomMode();
    const [links, totalTickets] = await Promise.all([
      this.intercomStore.countLinks().catch(() => 0),
      this.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
    ]);

    const mask = (value: string | null) => (value ? `••••${value.slice(-4)}` : "_not set_");
    const modeLine =
      mode === "none"
        ? "**none** — bridge off, tickets stay Discord-only"
        : mode === "push"
          ? "**push** — one-way mirror Discord → Intercom"
          : "**bi** — full sync, agent replies & states come back";

    const operator = s.intercomOperatorAdminId();
    const admin = s.intercomAdminId();
    const authorLine = operator
      ? `Operator/Fin \`${operator}\`${admin ? ` (fallback admin \`${admin}\`)` : " ⚠️ no fallback admin"}`
      : admin
        ? `Admin \`${admin}\``
        : "⚠️ _none — set secrets (auto-detect) or pick an admin_";

    const typeMap = s.intercomTicketTypeMap();
    const categoryIds = [...this.categoryRegistry.getAll().map((c) => c.id), "_default"];
    const typesLine = categoryIds.map((id) => `${id} ${typeMap[id] ? "✓" : "✗"}`).join(" · ");
    const mappedStates = s.tags().filter((t) => t.intercomTicketStateId).length;

    const embed = new EmbedBuilder()
      .setTitle("Intercom Bridge")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Mode:** ${modeLine}`,
          ...(s.intercomConfigured()
            ? []
            : ["⚠️ **Setup incomplete** — the bridge queues events but pushes nothing until token, author and a Default ticket type are set."]),
          "",
          `**Region:** ${s.intercomRegion().toUpperCase()}`,
          `**Access token:** ${mask(s.intercomAccessToken())} · **Client secret:** ${s.intercomClientSecret() ? mask(s.intercomClientSecret()) : "_off_"}`,
          `**Authoring as:** ${authorLine}`,
          `**Ticket types:** ${typesLine}`,
          `**Status states mapped:** ${mappedStates}/${s.tags().length}`,
          `**Team routing:** ${s.intercomTeamId() ? `team \`${s.intercomTeamId()}\`` : "_unassigned_"}`,
          "",
          `**Bridged tickets:** ${links}/${totalTickets}`,
          // Webhook health: without this line a dead Developer-Hub subscription
          // (or rotated secret) is indistinguishable from a quiet inbox.
          `**Last inbound webhook:** ${(() => {
            const at = s.intercomLastInboundAt();
            if (at) return `<t:${Math.floor(at.getTime() / 1000)}:R>`;
            return s.intercomClientSecret() ? "_never — check the Developer Hub subscription + endpoint URL_" : "_n/a (no client secret)_";
          })()}`,
          "**Queues:** per-ticket outbox + per-conversation inbox run as Temporal workflows (live counts in /config → Temporal); failures land as dead-letter audit embeds.",
          `**Snooze tag:** ${
            s.intercomSnoozeStatusTagId()
              ? (() => {
                  const t = s.tagById(s.intercomSnoozeStatusTagId()!);
                  return t ? `${t.emoji} ${t.label}` : "_deleted tag — re-pick_";
                })()
              : "_not set — Intercom snooze is ignored_"
          }`,
          "",
          s.intercomClientSecret()
            ? `Webhook endpoint: \`POST <public-url>/intercom/webhook\` (signed via X-Hub-Signature). Topics needed: ${INTERCOM_WEBHOOK_TOPICS.join(", ")}. Extra subscriptions are ignored at the door — subscribing everything is fine. Canvas inbox app: \`POST <public-url>/intercom/inbox-app/initialize\` + \`/submit\`.`
            : "_No client secret set — the inbound webhook stays disabled (needed for bi mode and the push-mode agent warning)._",
          "",
          "Modes apply to tickets created inside Discord only; Intercom-native conversations are never touched.",
        ].join("\n")
      );

    const modeButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_intercom_mode_none")
        .setLabel("Off")
        .setStyle(mode === "none" ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(mode === "none"),
      new ButtonBuilder()
        .setCustomId("config_intercom_mode_push")
        .setLabel("Push (one-way)")
        .setStyle(mode === "push" ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(mode === "push"),
      new ButtonBuilder()
        .setCustomId("config_intercom_mode_bi")
        .setLabel("Bidirectional")
        .setStyle(mode === "bi" ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(mode === "bi"),
      new ButtonBuilder().setCustomId("config_intercom_reset").setLabel("Reset bridge data").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("config_intercom_wipe").setLabel("Wipe Intercom data").setStyle(ButtonStyle.Danger)
    );

    const setupButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom_secrets").setLabel("Set Secrets").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_admin").setLabel("Pick Admin").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_types").setLabel("Map Ticket Types").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_states").setLabel("Map States").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_attrs").setLabel("Ensure Attributes").setStyle(ButtonStyle.Secondary)
    );

    const actionButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom_team").setLabel("Assign Team").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_backfill").setLabel("Backfill tickets").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_intercom_region")
        .setLabel(`Region: ${s.intercomRegion().toUpperCase()}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_integrations").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    const extraButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom_snooze").setLabel("Snooze Tag").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_inactivity").setLabel("Inactivity").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_intercom_resync").setLabel("Sync Closed Tickets").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [modeButtons, setupButtons, actionButtons, extraButtons] };
  }

  // /config → Intercom → Inactivity: the workspace sweeper for NATIVE
  // (unbridged) conversations/tickets — Intercom's own workflow triggers never
  // fire on API-created objects, so the bot is the automation engine. Bridged
  // tickets keep their per-ticket timers (tag reminder settings).
  private buildInactivityPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("Intercom Inactivity Sweeper")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Status:** ${s.inactivityEnabled() ? "**on** — sweeping every 30 minutes" : "**off**"}`,
          "",
          `**Agent-idle:** after ${s.inactivityAgentWaitDays()} day(s) waiting on an agent → internal note (≤1 per window)`,
          `**Customer-idle:** after ${s.inactivityCustomerWaitDays()} day(s) of customer silence → outbound reply nag`,
          `**Auto-close:** after ${s.inactivityNagsBeforeClose()} unanswered nag(s) → conversation (and its native ticket) closed`,
          "",
          "Covers every open, unsnoozed conversation and open ticket in the workspace EXCEPT Discord-bridged tickets (their per-tag reminder settings under Workflow → Manage Tags own those). Native tickets only get agent-idle notes — never auto-close.",
        ].join("\n")
      );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_inactivity_toggle")
        .setLabel(`Sweeper: ${s.inactivityEnabled() ? "on" : "off"}`)
        .setStyle(s.inactivityEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_inactivity_opts").setLabel("Set Thresholds").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_inactivity_run").setLabel("Run Now").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [buttons] };
  }

  private buildAiPanel() {
    const s = this.settingsStore;
    const last = s.kbLastRefreshAt();
    const embed = new EmbedBuilder()
      .setTitle("AI (dispute evidence)")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Model:** \`${s.aiModel()}\` — dispute-evidence drafts (/billing → Disputes)`,
          `**Speed limits:** effort \`${s.aiEffortAsk()}\`, ≤ $${s.aiMaxBudgetUsdAsk()}/run`,
          "",
          `**Knowledge-base auto-refresh:** ${s.kbRefreshEnabled() ? `on — every ${s.kbRefreshIntervalHours()}h` : "off"}`,
          `**Last refresh:** ${last ? `<t:${Math.floor(last.getTime() / 1000)}:R>` : "_never_"}`,
          "",
          "Evidence drafts ground policy text by searching the Postiz source + docs snapshots in `search/`; the refresh downloads fresh GitHub tarballs so drafts track upstream. The model is free-text — any Claude alias/id the CLI accepts works.",
        ].join("\n")
      );

    const modelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_ai_model").setLabel("Set Model").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_ai_perf").setLabel("Speed Limits").setStyle(ButtonStyle.Secondary)
    );
    const kbRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_toggle_kb")
        .setLabel(`Auto-refresh: ${s.kbRefreshEnabled() ? "on" : "off"}`)
        .setStyle(s.kbRefreshEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_kb_interval").setLabel("Refresh Interval").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_kb_refresh_now").setLabel("Refresh Now").setStyle(ButtonStyle.Secondary)
    );
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_aianalytics").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [modelRow, kbRow, navRow] };
  }

  private buildSentryPanel() {
    const s = this.settingsStore;
    const mask = (value: string | null) => (value ? `••••${value.slice(-8)}` : "_not set_");
    const dsn = s.sentryDsn();
    const statusLine = !dsn
      ? "**off** — no DSN configured"
      : sentryActive()
        ? "**live** — errors, traces, logs, metrics and profiles are being sent"
        : "**configured, not active** ⚠️ — restart the bot to apply";

    const embed = new EmbedBuilder()
      .setTitle("Sentry Observability")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Status:** ${statusLine}`,
          "",
          `**DSN:** ${mask(dsn)}`,
          `**Environment:** \`${s.sentryEnvironment()}\` · **Release:** \`${appRelease()}\``,
          `**Traces sample rate:** ${s.sentryTracesSampleRate()} · **Profiles sample rate:** ${s.sentryProfilesSampleRate()}`,
          `**Logs:** ${s.sentryLogsEnabled() ? "on" : "off"} · **Debug:** ${s.sentryDebug() ? "on" : "off"} · **Default PII:** ${s.sentrySendDefaultPii() ? "on" : "off"}`,
          `**AI content capture:** ${s.sentryAiRecordContent() ? "on — prompts/responses/tool I/O recorded on AI spans" : "off — AI metadata only (tokens, cost, tools)"}`,
          "",
          "First-time enable and rate/environment/logs/PII/AI changes apply live. Changing an **active DSN**, toggling **debug**, and first-enabling **console capture** or **profiling** need a restart.",
          "Traces 0 = keep instrumentation but send nothing; fully off = clear the DSN + restart.",
        ].join("\n")
      );

    const setupButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_sentry_dsn").setLabel("Set DSN").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_sentry_options").setLabel("Rates & Environment").setStyle(ButtonStyle.Primary)
    );

    const toggleButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_sentry_toggle_logs")
        .setLabel(`Logs: ${s.sentryLogsEnabled() ? "on" : "off"}`)
        .setStyle(s.sentryLogsEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_sentry_toggle_debug")
        .setLabel(`Debug: ${s.sentryDebug() ? "on" : "off"}`)
        .setStyle(s.sentryDebug() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_sentry_toggle_pii")
        .setLabel(`Default PII: ${s.sentrySendDefaultPii() ? "on" : "off"}`)
        .setStyle(s.sentrySendDefaultPii() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_sentry_toggle_ai")
        .setLabel(`AI content: ${s.sentryAiRecordContent() ? "on" : "off"}`)
        .setStyle(s.sentryAiRecordContent() ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const actionButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_sentry_test")
        .setLabel("Send test event")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!sentryActive()),
      new ButtonBuilder().setCustomId("config_integrations").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [setupButtons, toggleButtons, actionButtons] };
  }

  // /config → Analytics: InfluxDB export + AI ticket scoring. Async because it
  // shows live pipeline state (unscored count, in-flight batch).
  private async buildAnalyticsPanel() {
    const s = this.settingsStore;
    const mask = (value: string | null) => (value ? `••••${value.slice(-6)}` : "_not set_");
    const tokenLine = s.influxTokenUnreadable()
      ? "⚠️ stored token can't be decrypted (key source rotated) — re-enter it"
      : mask(s.influxToken());

    const embed = new EmbedBuilder()
      .setTitle("Analytics — InfluxDB")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**InfluxDB export:** ${
            influxActive()
              ? `**live** → \`${s.influxUrl()}\` org \`${s.influxOrg()}\` bucket \`${s.influxBucket()}\``
              : s.influxEnabled()
                ? "**enabled but inactive** ⚠️ — set url, org, bucket and token"
                : "**off**"
          }`,
          `**Token:** ${tokenLine}`,
          "",
          "Exports billing/dispute gauges, Intercom bridge health and AI run costs. Settings apply live on save.",
        ].join("\n")
      );

    const influxRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_analytics_influx").setLabel("Influx Settings").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("config_analytics_toggle_influx")
        .setLabel(`Influx: ${s.influxEnabled() ? "on" : "off"}`)
        .setStyle(s.influxEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_analytics_test")
        .setLabel("Send test point")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!influxActive()),
      new ButtonBuilder().setCustomId("config_aianalytics").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [influxRow] };
  }

  // One-line Vault state for the main config panel's Infrastructure field.
  private vaultStatusLine(): string {
    const s = this.settingsStore;
    const service = this.vault?.service;
    if (!service || !s.vaultEnabled()) return "off";
    switch (service.state()) {
      case "denied":
        return "on ⚠️ token rejected";
      case "down":
        return "on ⚠️ unreachable";
      case "unconfigured":
        return "enabled ⚠️ incomplete config";
      default:
        return s.vaultMigratedAt() ? "on → secrets in Vault" : "connected — not migrated";
    }
  }

  // /config → Vault: connection, storage cutover state, per-secret placement,
  // migrate/reverse actions. Async for the session-token envelope census.
  // ---- /config → Temporal (connection status, kill switch, deployment
  // version, schedules, migration import). The only ops window besides the
  // Temporal Web UI — prod has no terminal. ----


  private async buildTemporalPanel() {
    const s = this.settingsStore;
    const ops = this.temporalOps;
    const lines: string[] = [];
    const rel = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;

    if (!ops) {
      lines.push("Temporal stack not wired (worker-only process?).");
    } else {
      const svc = ops.service;
      const cfg = svc.envConfig();
      const state = svc.state();
      const configError = svc.configError();
      lines.push(
        `**Connection:** ${
          state === "up" ? "✅ up" : state === "down" ? `❌ down${svc.downSince() ? ` since ${rel(svc.downSince()!)}` : ""}` : `⚪ not configured${configError ? ` — ${configError}` : ""}`
        }`,
        `**Address / namespace:** \`${cfg.address || "—"}\` · \`${cfg.namespace || "—"}\` · queue \`${cfg.taskQueue}\`${
          cfg.tlsServerName ? ` · SNI \`${cfg.tlsServerName}\`` : ""
        }`
      );
      const cert = svc.certInfo();
      lines.push(
        `**Client cert:** ${
          cert
            ? `SHA-256 \`${cert.fingerprint256.replace(/:/g, "").slice(0, 16).toLowerCase()}…\` · expires ${rel(cert.notAfter)}${cert.daysLeft < 30 ? " ⚠️" : ""}`
            : "_not entered (Certificates below, stored in Vault KV)_"
        }`
      );
      const buf = svc.bufferStats();
      lines.push(`**Retry buffer:** ${buf.size}/${buf.capacity} buffered · ${buf.droppedTotal} dropped`);
      lines.push(`**Search attributes:** ${describeSaResult(svc.searchAttributeStatus())}`);
      const v = ops.workerManager.deploymentVersion();
      const promoted = ops.workerManager.promoted();
      lines.push(
        `**Worker:** ${ops.workerManager.running() ? "✅ polling" : "⏹️ stopped"} · build \`${v.buildId}\` (deployment \`${v.deploymentName}\`)${
          promoted === true ? " · current" : promoted === false ? " · ⚠️ NOT promoted to current" : ""
        }${buildIdIsDegenerate(v.buildId) ? " · ⚠️ degenerate build id (package version — every deploy looks identical; rebuild with the stamped buildInfo.json in dist)" : ""}`,
        `**Background work:** ${s.temporalEnabled() ? "running (worker active)" : "⏸️ paused — signals park server-side until resumed"}`
      );

      // Live readouts, best-effort with a short budget — a down server must
      // not wedge the panel.
      try {
        const report = await Promise.race([
          svc.testConnection(),
          new Promise<null>((r) => setTimeout(() => r(null), 3000)),
        ]);
        if (report?.visibilityOk) lines.push(`**Running workflows:** ${report.runningWorkflows}`);
        if (report?.currentVersion) lines.push(`**Deployment current version:** \`${report.currentVersion}\``);
      } catch {
        // panel stays useful without live counts
      }
    }

    const embed = new EmbedBuilder().setTitle("Temporal").setColor(0x5865f2).setDescription(lines.join("\n"));
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_temporal_toggle")
        .setLabel(s.temporalEnabled() ? "Background work: running" : "Background work: paused")
        .setStyle(s.temporalEnabled() ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("config_temporal_conn").setLabel("Connection").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_temporal_certs").setLabel("Certificates").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_temporal_test").setLabel("Test Connection").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_infra").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_temporal_sa").setLabel("Ensure Search Attributes").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_temporal_pause").setLabel("Pause Schedules").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_temporal_unpause").setLabel("Unpause Schedules").setStyle(ButtonStyle.Secondary)
    );
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_temporal_kb").setLabel("Refresh KB Now").setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [row1, row2, row3] };
  }

  // All config_temporal* buttons (delegated from handleConfigButton; admin was
  // already re-checked there).
  private async handleTemporalConfigButton(interaction: ButtonInteraction, id: string): Promise<void> {
    const s = this.settingsStore;
    const ops = this.temporalOps;
    if (!ops) {
      await interaction.reply({ embeds: [makeEmbed("Temporal stack is not wired in this process.", COLORS.warn)], flags: 64 });
      return;
    }

    if (id === "config_temporal") {
      await interaction.deferUpdate();
      await interaction.editReply(await this.buildTemporalPanel());
      return;
    }

    if (id === "config_temporal_toggle") {
      const enabling = !s.temporalEnabled();
      if (enabling && !ops.service.configured()) {
        await interaction.reply({
          embeds: [
            makeEmbed(
              `Can't enable Temporal: ${ops.service.configError() ?? "not configured"}.\nSet address + namespace via **Connection** and enter the mTLS certs via **Certificates**.`,
              COLORS.danger
            ),
          ],
          flags: 64,
        });
        return;
      }
      await interaction.deferUpdate();
      await s.updateTemporal({ temporalEnabled: enabling });
      try {
        await ops.setEnabled(enabling);
        this.auditConfig(interaction, `Temporal background work → ${enabling ? "running" : "paused (worker drained)"}`);
      } catch (e) {
        await s.updateTemporal({ temporalEnabled: !enabling });
        await interaction.followUp({
          embeds: [
            makeEmbed(
              `Switching failed — the toggle was rolled back: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`,
              COLORS.danger
            ),
          ],
          flags: 64,
        });
      }
      await interaction.editReply(await this.buildTemporalPanel());
      return;
    }

    if (id === "config_temporal_test") {
      await interaction.deferReply({ flags: 64 });
      const r = await ops.service.testConnection();
      const line = (label: string, ok: boolean, err?: string | null, extra?: string) =>
        `**${label}:** ${ok ? `✅ ok${extra ? ` — ${extra}` : ""}` : `❌ ${err ?? "failed"}`}`;
      await interaction.editReply({
        embeds: [
          makeEmbed(
            [
              line("Config", r.configured, r.configError),
              line("gRPC health", r.healthOk, r.healthError),
              line("Namespace", r.namespaceOk, r.namespaceError),
              line("Deployment", r.deploymentFound, r.deploymentError ?? "not found yet (registers on first worker poll)", r.currentVersion ? `current \`${r.currentVersion}\`` : undefined),
              line("Visibility", r.visibilityOk, r.visibilityError, r.runningWorkflows != null ? `${r.runningWorkflows} running` : undefined),
              line("Search attributes", r.searchAttributesOk, r.searchAttributesDetail, r.searchAttributesOk ? (r.searchAttributesDetail ?? undefined) : undefined),
            ].join("\n"),
            r.configured && r.healthOk && r.namespaceOk ? COLORS.success : COLORS.warn
          ),
        ],
      });
      return;
    }

    if (id === "config_temporal_conn") {
      const cfg = ops.service.envConfig();
      const modal = new ModalBuilder().setCustomId("config_temporal_conn_modal").setTitle("Temporal Connection");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("address")
            .setLabel("Address (host:port of the mTLS frontend)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.address)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("namespace")
            .setLabel("Namespace")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.namespace)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("task_queue")
            .setLabel("Task queue")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.taskQueue)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("deployment")
            .setLabel("Deployment name (worker versioning)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.deploymentName)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("tls_server_name")
            .setLabel("TLS server name (SNI; when dialing by IP)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.tlsServerName ?? "")
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_temporal_certs") {
      // Never prefilled — cert/key material must not round-trip through Discord.
      const modal = new ModalBuilder().setCustomId("config_temporal_certs_modal").setTitle("Temporal mTLS Certificates");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("cert").setLabel("Client certificate (PEM)").setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("key").setLabel("Client private key (PEM)").setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("ca").setLabel("Server CA (PEM, optional)").setStyle(TextInputStyle.Paragraph).setRequired(false)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_temporal_sa") {
      await interaction.deferReply({ flags: 64 });
      const r = await ops.service.ensureSearchAttributesNow();
      this.auditConfig(interaction, `Temporal search attributes → ${describeSaResult(r)}`);
      await interaction.editReply({
        embeds: [
          makeEmbed(
            [
              `**Result:** ${describeSaResult(r)}`,
              ...(r.added.length > 0 ? [`Registered: ${r.added.map((n) => `\`${n}\``).join(", ")}`] : []),
              ...(r.present.length > 0 ? [`Already present: ${r.present.map((n) => `\`${n}\``).join(", ")}`] : []),
              ...(r.mismatched.length > 0
                ? [`⚠️ Type mismatch (must be fixed on the server, cannot be re-typed here): ${r.mismatched.map((n) => `\`${n}\``).join(", ")}`]
                : []),
            ].join("\n"),
            r.ok ? COLORS.success : COLORS.warn
          ),
        ],
      });
      return;
    }

    if (id === "config_temporal_pause" || id === "config_temporal_unpause") {
      await interaction.deferReply({ flags: 64 });
      const pause = id === "config_temporal_pause";
      const client = await ops.service.client();
      if (!client) {
        await interaction.editReply({ embeds: [makeEmbed("Temporal is unreachable.", COLORS.danger)] });
        return;
      }
      let touched = 0;
      try {
        for await (const sched of client.schedule.list()) {
          const handle = client.schedule.getHandle(sched.scheduleId);
          if (pause) await handle.pause(`paused via /config by ${interaction.user.username}`);
          else await handle.unpause(`unpaused via /config by ${interaction.user.username}`);
          touched++;
        }
        this.auditConfig(interaction, `Temporal schedules → ${pause ? "paused" : "unpaused"} (${touched})`);
        await interaction.editReply({
          embeds: [makeEmbed(`${pause ? "Paused" : "Unpaused"} ${touched} schedule(s).`, COLORS.success)],
        });
      } catch (e) {
        await interaction.editReply({
          embeds: [makeEmbed(`Schedule update failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, COLORS.danger)],
        });
      }
      return;
    }

    if (id === "config_temporal_kb") {
      await interaction.deferReply({ flags: 64 });
      const r = await ops.producers.kbRefreshNow();
      await interaction.editReply({
        embeds: [
          makeEmbed(
            r.ok ? "Triggered a KB refresh via Temporal." : `Couldn't trigger the KB refresh: ${r.error ?? "Temporal unreachable"}.`,
            r.ok ? COLORS.success : COLORS.danger
          ),
        ],
      });
      return;
    }
  }

  // Certificates modal: validate before storing (Vault KV "temporal" entry);
  // the reply shows fingerprint + expiry ONLY — never any PEM/key material.
  private async handleTemporalCertsModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("You don't have permission to do that.", COLORS.danger)], flags: 64 });
      return;
    }
    const ops = this.temporalOps;
    const vault = this.vault?.service;
    if (!ops || !vault) {
      await interaction.reply({ embeds: [makeEmbed("Temporal/Vault stack is not wired in this process.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferReply({ flags: 64 });
    const cert = interaction.fields.getTextInputValue("cert").trim();
    const key = interaction.fields.getTextInputValue("key").trim();
    const ca = interaction.fields.getTextInputValue("ca").trim();
    let info;
    try {
      info = validateCertPair(cert, key, ca || null);
    } catch (e) {
      await interaction.editReply({
        embeds: [makeEmbed(e instanceof Error ? e.message : "Invalid certificate material.", COLORS.danger)],
      });
      return;
    }
    // Vault-only by design: no local-encryption fallback for mTLS material.
    const ok = await vault.setKvFields("temporal", {
      clientCertPem: cert,
      clientKeyPem: key,
      caPem: ca || null,
    });
    if (!ok) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            "Couldn't write to Vault — the certs are Vault-only (no local fallback). Bring Vault up (/config → Vault) and try again, or enter them directly in the Vault UI (picked up within 10 minutes).",
            COLORS.danger
          ),
        ],
      });
      return;
    }
    await ops.service.reconfigure();
    this.auditConfig(interaction, "Temporal mTLS certificates updated");
    await interaction.editReply({
      embeds: [
        makeEmbed(
          [
            "Certificates stored in Vault KV (`temporal` entry).",
            `Fingerprint: \`${info.fingerprint256.replace(/:/g, "").slice(0, 16).toLowerCase()}…\` · expires <t:${Math.floor(info.notAfter.getTime() / 1000)}:R>.`,
            "Note: the running worker keeps its old connection — toggle Temporal off/on (or restart) to apply a rotation. Long CA chains that exceed the 4000-char modal limit go directly into the Vault UI.",
          ].join("\n"),
          COLORS.success
        ),
      ],
    });
  }

  private async buildVaultPanel() {
    const s = this.settingsStore;
    const service = this.vault?.service;
    const mask = (value: string | null) => (value ? `••••${value.slice(-6)}` : "_not set_");

    const stateLine = !service
      ? "_unavailable in this deployment_"
      : !s.vaultEnabled()
        ? "**off**"
        : service.state() === "up"
          ? "**connected** ✅"
          : service.state() === "denied"
            ? "**token rejected (403)** ⚠️ — check the token/policy, probes keep retrying"
            : service.state() === "down"
              ? `**unreachable** ⚠️${service.downSince() ? ` since <t:${Math.floor(service.downSince()!.getTime() / 1000)}:R>` : ""} — serving cached secrets, retrying every 30s`
              : "**enabled but incomplete** ⚠️ — set address + token";

    const tokenLine = s.vaultTokenUnreadable()
      ? "⚠️ stored token can't be decrypted (key source rotated) — re-enter it"
      : mask(s.vaultToken());

    const stateLabel: Record<SecretState, string> = {
      none: "_not set_",
      local: "local encryption",
      "local-unreadable": "⚠️ local ciphertext unreadable — re-enter",
      vault: "in Vault",
      "vault-unreachable": "in Vault ⚠️ unreachable right now",
    };
    const secretLines = (Object.keys(COLUMN_LABELS) as GlobalSecretColumn[]).map(
      (column) => `${COLUMN_LABELS[column]}: ${stateLabel[s.secretState(column)]}`
    );

    const tokens = await this.sessionStore.countTokensByEnvelope().catch(() => ({ transit: 0, local: 0, legacy: 0 }));
    const migratedAt = s.vaultMigratedAt();
    const cacheAge = service?.kvCacheAgeMs();

    const embed = new EmbedBuilder()
      .setTitle("Vault — Secret Storage")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Connection:** ${stateLine}`,
          `**Address:** ${s.vaultAddr() ? `\`${s.vaultAddr()}\`` : "_not set_"} · **Token:** ${tokenLine}`,
          `**Paths:** KV \`${s.vaultKvMount()}/${s.vaultKvBasePath()}\` · Transit \`${s.vaultTransitMount()}\` key \`${s.vaultTransitKey()}\``,
          `**Probe:** ${service?.lastProbeAt() ? `<t:${Math.floor(service.lastProbeAt()!.getTime() / 1000)}:R>` : "_none yet_"} · **KV cache:** ${
            cacheAge != null ? `warm (${Math.max(0, Math.round(cacheAge / 60_000))}m old)` : "cold"
          }`,
          "",
          `**Storage:** ${
            migratedAt
              ? `**Vault** since <t:${Math.floor(migratedAt.getTime() / 1000)}:d> — globals in KV, user tokens on Transit`
              : "**Postgres columns** (local encryption) — run *Migrate secrets to Vault* to cut over"
          }`,
          ...secretLines.map((l) => `> ${l}`),
          `**User tokens:** ${tokens.transit} on Transit · ${tokens.local} local${tokens.legacy ? ` · ${tokens.legacy} legacy plaintext` : ""}`,
          "",
          "While Vault is down: reads come from the in-memory cache, new secrets fall back to local encryption and are upgraded automatically on recovery. A restart during an outage degrades vault-held secrets until Vault returns.",
        ].join("\n")
      );

    const connRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_vault_conn").setLabel("Connection").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("config_vault_paths").setLabel("Paths").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("config_vault_toggle")
        .setLabel(`Vault: ${s.vaultEnabled() ? "on" : "off"}`)
        .setStyle(s.vaultEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("config_vault_test")
        .setLabel("Test Connection")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!service || !service.configured())
    );

    const migrateRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("config_vault_migrate")
        .setLabel("Migrate secrets to Vault")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!service || service.state() !== "up"),
      new ButtonBuilder()
        .setCustomId("config_vault_reverse")
        .setLabel("Reverse migration")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!service || !service.storageActive() || service.state() !== "up"),
      new ButtonBuilder().setCustomId("config_infra").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [connRow, migrateRow] };
  }

  private buildVaultTestEmbed(report: VaultTestReport) {
    const ttl = report.ttlSeconds;
    const ttlLabel =
      ttl == null ? "?" : ttl === 0 ? "no expiry" : ttl < 86_400 ? `${Math.max(1, Math.round(ttl / 3_600))}h` : `${Math.round(ttl / 86_400)}d`;
    const lines = [
      `**Health:** ${
        report.healthOk
          ? "✅ ok"
          : `❌ ${report.healthError ?? (report.sealed ? "sealed" : !report.initialized ? "not initialized" : "unreachable")}`
      }`,
      `**Token:** ${
        report.tokenOk
          ? `✅ ok${report.displayName ? ` (\`${report.displayName}\`)` : ""} · policies: ${report.policies.join(", ") || "—"} · TTL: ${ttlLabel}`
          : `❌ ${report.tokenError ?? "lookup failed"}`
      }`,
    ];
    if (report.tokenOk) {
      lines.push(
        `**Transit round-trip:** ${report.transitOk ? "✅ ok" : `❌ ${report.transitError ?? "failed"}`}`,
        `**KV entries:** ${
          report.kvOk
            ? `✅ readable — ${report.kvEntriesFound.length}/${VAULT_INTEGRATIONS.length} present${report.kvEntriesFound.length ? ` (${report.kvEntriesFound.join(", ")})` : ""}`
            : `❌ ${report.kvError ?? "read failed"}`
        }`
      );
      if (ttl != null && ttl > 0 && ttl < 7 * 86_400) {
        lines.push("", "⚠️ The token has a finite TTL and will expire — create an orphan token without a TTL for unattended use.");
      }
    }
    const allOk = report.healthOk && report.tokenOk && report.transitOk && report.kvOk;
    return makeEmbed(lines.join("\n"), allOk ? COLORS.success : COLORS.warn);
  }

  private buildMigrateReportEmbed(title: string, report: MigrateReport) {
    if (report.error) return makeEmbed(`**${title}** aborted: ${report.error}`, COLORS.danger);
    const outcomeLabel: Record<MigrateItemResult["outcome"], string> = {
      migrated: "✅ moved",
      already: "✓ already done",
      "skipped-empty": "— not set",
      unreadable: "⚠️ unreadable — re-enter the value, then re-run",
      failed: "❌ failed",
    };
    const lines = report.items.map((i) => `**${i.name}:** ${outcomeLabel[i.outcome]}${i.detail ? ` — ${i.detail}` : ""}`);
    lines.push(
      "",
      `**User tokens:** ${report.sessions.converted} converted${
        report.sessions.failed
          ? ` · ${report.sessions.failed} failed (re-run later, or the affected users re-authenticate)`
          : ""
      }`
    );
    if (!report.ok) lines.push("", "Some items did not move — fix the cause and run the button again (already-moved items are skipped).");
    return makeEmbed([`**${title}**`, "", ...lines].join("\n"), report.ok ? COLORS.success : COLORS.warn);
  }

  // All config_vault* buttons (delegated from handleConfigButton; admin was
  // already re-checked there).
  private async handleVaultConfigButton(interaction: ButtonInteraction, id: string): Promise<void> {
    if (!this.vault) {
      await interaction.reply({ embeds: [makeEmbed("Vault integration is not wired in this deployment.", COLORS.danger)], flags: 64 });
      return;
    }
    const { service, migrator } = this.vault;
    const s = this.settingsStore;

    if (id === "config_vault") {
      await interaction.update(await this.buildVaultPanel());
      return;
    }

    if (id === "config_vault_conn") {
      const modal = new ModalBuilder().setCustomId("config_vault_conn_modal").setTitle("Vault Connection");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("addr")
            .setLabel("Address (https://vault.example.com:8200)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.vaultAddr() ?? "")
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("token")
            .setLabel("Token (blank = keep current)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(s.vaultToken() ? "•••• stored (leave blank to keep)" : "orphan token with the support-bot policy")
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_vault_paths") {
      const modal = new ModalBuilder().setCustomId("config_vault_paths_modal").setTitle("Vault Paths");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("kv_mount")
            .setLabel("KV v2 mount (blank = kv)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.vaultKvMount())
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("kv_base")
            .setLabel("KV base path (blank = support-bot)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.vaultKvBasePath())
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("transit_mount")
            .setLabel("Transit mount (blank = transit)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.vaultTransitMount())
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("transit_key")
            .setLabel("Transit key name (blank = support-bot)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.vaultTransitKey())
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_vault_toggle") {
      const turningOff = s.vaultEnabled();
      await s.updateVault({ vaultEnabled: !s.vaultEnabled() });
      await service.reconfigure();
      this.auditConfig(interaction, `Vault connection → ${s.vaultEnabled() ? "on" : "off"}`);
      await interaction.update(await this.buildVaultPanel());
      if (turningOff && s.vaultMigratedAt()) {
        await interaction.followUp({
          embeds: [
            makeEmbed(
              "⚠️ Secrets still live in Vault. While the connection is off they are unavailable and the affected features degrade. Re-enable Vault, or run **Reverse migration** (with Vault reachable) to move them back to local encryption.",
              COLORS.warn
            ),
          ],
          flags: 64,
        });
      }
      return;
    }

    if (id === "config_vault_test") {
      await interaction.deferReply({ flags: 64 });
      const report = await service.testConnection();
      await interaction.editReply({ embeds: [this.buildVaultTestEmbed(report)] });
      return;
    }

    if (id === "config_vault_migrate") {
      const tokens = await this.sessionStore.countTokensByEnvelope().catch(() => ({ transit: 0, local: 0, legacy: 0 }));
      const pending = (Object.keys(COLUMN_LABELS) as GlobalSecretColumn[]).filter((c) => {
        const st = s.secretState(c);
        return st === "local" || st === "local-unreadable";
      });
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("config_vault_migrate_confirm").setLabel("Yes, migrate to Vault").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("config_vault").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              "This moves the secret storage into Vault:",
              `• **${pending.length}** global secret(s) → KV \`${s.vaultKvMount()}/${s.vaultKvBasePath()}/…\`${pending.length ? ` (${pending.map((c) => COLUMN_LABELS[c]).join(", ")})` : ""}`,
              `• **${tokens.local + tokens.legacy}** user token(s) → Transit ciphertext (rows stay in Postgres)`,
              "",
              "Each value is verified with a read-back before the local copy is replaced. From then on, new secrets are written to Vault (with automatic local fallback while Vault is down). Re-run anytime — finished items are skipped.",
            ].join("\n"),
            COLORS.warn
          ),
        ],
        components: [confirm],
      });
      return;
    }

    if (id === "config_vault_migrate_confirm") {
      await interaction.deferUpdate();
      const report = await migrator.migrate();
      const moved = report.items.filter((i) => i.outcome === "migrated").length;
      this.auditConfig(
        interaction,
        `Vault migration → ${moved} secret(s) moved, ${report.sessions.converted} user token(s) converted${report.ok ? "" : " (partial — re-run pending)"}`
      );
      await interaction.editReply(await this.buildVaultPanel());
      await interaction.followUp({ embeds: [this.buildMigrateReportEmbed("Migration to Vault", report)], flags: 64 });
      return;
    }

    if (id === "config_vault_reverse") {
      const tokens = await this.sessionStore.countTokensByEnvelope().catch(() => ({ transit: 0, local: 0, legacy: 0 }));
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("config_vault_reverse_confirm").setLabel("Yes, move back to local").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("config_vault").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              "This pulls every secret OUT of Vault and back into locally-encrypted Postgres columns:",
              `• global secrets → \`enc:v1\` columns · **${tokens.transit}** user token(s) → local ciphertext`,
              "• on full success the KV entries are **deleted** and the Vault connection is turned **off**",
              "",
              "Use this to decommission Vault. Requires Vault to be reachable.",
            ].join("\n"),
            COLORS.danger
          ),
        ],
        components: [confirm],
      });
      return;
    }

    if (id === "config_vault_reverse_confirm") {
      await interaction.deferUpdate();
      const report = await migrator.reverse();
      const restored = report.items.filter((i) => i.outcome === "migrated").length;
      this.auditConfig(
        interaction,
        `Vault reverse migration → ${restored} secret(s) restored, ${report.sessions.converted} user token(s) converted${report.ok ? ", Vault disabled" : " (partial — re-run pending)"}`
      );
      await interaction.editReply(await this.buildVaultPanel());
      await interaction.followUp({ embeds: [this.buildMigrateReportEmbed("Reverse migration", report)], flags: 64 });
      return;
    }
  }

  // config_vault_conn_modal / config_vault_paths_modal submits (delegated from
  // handleConfigModal; admin already re-checked there).
  private async handleVaultConfigModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.vault) {
      await interaction.reply({ embeds: [makeEmbed("Vault integration is not wired in this deployment.", COLORS.danger)], flags: 64 });
      return;
    }
    const s = this.settingsStore;

    const replyWithState = async (prefix: string) => {
      const state = this.vault!.service.state();
      const note =
        state === "up"
          ? `${prefix} — Vault is **connected**.`
          : state === "denied"
            ? `${prefix}, but the token was **rejected (403)** — check the token/policy. Probes keep retrying.`
            : state === "down"
              ? `${prefix}, but Vault is **unreachable** — the probe loop retries every 30s.`
              : `${prefix}. Turn the Vault toggle on to activate the connection.`;
      await interaction.reply({ embeds: [makeEmbed(note, state === "up" ? COLORS.success : COLORS.warn)], flags: 64 });
    };

    if (interaction.customId === "config_vault_conn_modal") {
      const addr = interaction.fields.getTextInputValue("addr").trim();
      const token = interaction.fields.getTextInputValue("token").trim();
      if (addr && !/^https?:\/\//.test(addr)) {
        await interaction.reply({
          embeds: [makeEmbed("The address must start with `http://` or `https://`.", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await s.updateVault({
        vaultAddr: addr || null,
        // Blank token = leave the stored (encrypted) one unchanged.
        ...(token ? { vaultToken: token } : {}),
      });
      await this.vault.service.reconfigure();
      // The Influx token may be vault-held — a now-working connection revives it.
      await reconfigureInflux(s.influxConfig());
      // Deliberately no token value in the audit line.
      this.auditConfig(interaction, `Vault connection updated (addr ${addr || "—"}${token ? ", token set" : ""})`);
      await replyWithState("Vault connection saved");
      return;
    }

    if (interaction.customId === "config_vault_paths_modal") {
      const kvMount = interaction.fields.getTextInputValue("kv_mount").trim();
      const kvBase = interaction.fields.getTextInputValue("kv_base").trim();
      const transitMount = interaction.fields.getTextInputValue("transit_mount").trim();
      const transitKey = interaction.fields.getTextInputValue("transit_key").trim();
      await s.updateVault({
        vaultKvMount: kvMount || "kv",
        vaultKvBasePath: kvBase || "support-bot",
        vaultTransitMount: transitMount || "transit",
        vaultTransitKey: transitKey || "support-bot",
      });
      await this.vault.service.reconfigure();
      await reconfigureInflux(s.influxConfig());
      this.auditConfig(
        interaction,
        `Vault paths updated (kv ${s.vaultKvMount()}/${s.vaultKvBasePath()}, transit ${s.vaultTransitMount()}/${s.vaultTransitKey()})`
      );
      await replyWithState("Vault paths saved");
      return;
    }
  }

  // Applies the current settings to the running SDK and renders the outcome
  // for the /config reply (which knobs are live vs. waiting on a restart).
  private async applySentrySettings(): Promise<{ result: SentryReconfigureResult; note: string | null }> {
    const result = await reconfigureSentry(this.settingsStore.sentryConfig());
    switch (result.status) {
      case "started":
        return { result, note: "Sentry is now **live** (errors, traces, logs, metrics). Use *Send test event* to verify." };
      case "stopped":
        return { result, note: "Sentry **disabled** — event delivery stopped. Restart to drop residual instrumentation." };
      case "restart-required":
        return { result, note: "⚠️ Saved, but switching the active DSN needs a **bot restart** (traces can't be re-pointed at runtime)." };
      case "updated":
        return {
          result,
          note: result.restartNeeded.length
            ? `Applied live, except: ${result.restartNeeded.join(", ")} — those need a **restart**.`
            : null,
        };
      case "disabled":
        return { result, note: null };
    }
  }

  // All Intercom-panel string selects: admin picker + the two two-step mapping flows.
  private async handleIntercomSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    const id = interaction.customId;
    const value = interaction.values[0];

    if (id === "config_intercom_admin_pick") {
      await this.settingsStore.updateIntercom({ intercomAdminId: value });
      this.auditConfig(interaction, `Intercom fallback admin → ${value}`);
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_team_pick") {
      const teamId = value === "__none__" ? null : value;
      await this.settingsStore.updateIntercom({ intercomTeamId: teamId });
      this.auditConfig(interaction, `Intercom team routing → ${teamId ?? "unassigned"}`);
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_snooze_pick") {
      const tagId = value === "__none__" ? null : value;
      await this.settingsStore.updateIntercom({ intercomSnoozeStatusTagId: tagId });
      const tag = tagId ? this.settingsStore.tagById(tagId) : undefined;
      this.auditConfig(interaction, `Intercom snooze tag → ${tag ? `${tag.emoji} ${tag.label}` : "none"}`);
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_map_cat_pick") {
      await interaction.deferUpdate();
      try {
        const types = await this.intercomClient.listTicketTypes();
        // Both Customer and Back-office types work (back-office avoids the
        // channel gate on Intercom's "ticket created" workflow trigger); list
        // everything, back-office first, category visible in the description.
        const rank = (t: { category?: string | null }) => {
          const c = (t.category ?? "").toLowerCase();
          return c === "back-office" ? 0 : c === "customer" ? 1 : 2;
        };
        const pool = [...types].sort((a, b) => rank(a) - rank(b));
        if (pool.length === 0) {
          await interaction.followUp({
            embeds: [makeEmbed("Intercom returned no ticket types — create one in Intercom first (Back-office recommended).", COLORS.warn)],
            flags: 64,
          });
          return;
        }
        const current = this.settingsStore.intercomTicketTypeMap()[value];
        const select = new StringSelectMenuBuilder()
          .setCustomId(`config_intercom_map_type_pick:${value}`)
          .setPlaceholder(`Ticket type for "${value}"`)
          .addOptions(
            pool.slice(0, 25).map((t) => ({
              label: t.name.slice(0, 100),
              value: t.id,
              description: `${t.category ?? "?"} · id ${t.id}`.slice(0, 100),
              default: t.id === current,
            }))
          );
        const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("config_intercom_types").setLabel("Back").setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          embeds: [makeEmbed(`Pick the Intercom ticket type for **${value}**.`, COLORS.neutral)],
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
        });
      } catch (e) {
        await interaction.followUp({
          embeds: [makeEmbed(`Could not list ticket types: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
          flags: 64,
        });
      }
      return;
    }

    if (id.startsWith("config_intercom_map_type_pick:")) {
      const categoryId = id.slice("config_intercom_map_type_pick:".length);
      const map = { ...this.settingsStore.intercomTicketTypeMap(), [categoryId]: value };
      await this.settingsStore.updateIntercom({ intercomTicketTypeMap: map });
      this.auditConfig(interaction, `Intercom ticket type mapping → ${categoryId} = ${value}`);
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_map_status_pick") {
      await interaction.deferUpdate();
      try {
        const states = (await this.intercomClient.listTicketStates()).filter((s) => !s.archived);
        if (states.length === 0) {
          await interaction.followUp({
            embeds: [makeEmbed("Intercom returned no ticket states — create them in Intercom first (Settings → Ticket states).", COLORS.warn)],
            flags: 64,
          });
          return;
        }
        const tag = this.settingsStore.tagById(value);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`config_intercom_map_state_pick:${value}`)
          .setPlaceholder(`Intercom state for ${tag ? `${tag.emoji} ${tag.label}` : value}`)
          .addOptions([
            { label: "— unmapped —", value: "__none__", description: "Don't touch the Intercom state for this tag", default: !tag?.intercomTicketStateId },
            ...states.slice(0, 24).map((s) => ({
              label: s.internalLabel.slice(0, 100),
              value: s.id,
              description: `${s.category ?? "?"} · id ${s.id}`.slice(0, 100),
              default: s.id === tag?.intercomTicketStateId,
            })),
          ]);
        const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("config_intercom_states").setLabel("Back").setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          embeds: [makeEmbed(`Pick the Intercom ticket state for **${tag ? `${tag.emoji} ${tag.label}` : value}**.`, COLORS.neutral)],
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
        });
      } catch (e) {
        await interaction.followUp({
          embeds: [makeEmbed(`Could not list ticket states: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
          flags: 64,
        });
      }
      return;
    }

    if (id.startsWith("config_intercom_map_state_pick:")) {
      const tagId = id.slice("config_intercom_map_state_pick:".length);
      const stateId = value === "__none__" ? null : value;
      await this.settingsStore.setTagIntercomState(tagId, stateId);
      const tag = this.settingsStore.tagById(tagId);
      this.auditConfig(
        interaction,
        `Intercom state mapping → ${tag ? `${tag.emoji} ${tag.label}` : tagId} = ${stateId ?? "unmapped"}`
      );
      await interaction.update(await this.buildIntercomPanel());
      return;
    }
  }

  // Category → Intercom ticket type mapping, step 1: pick the category.
  private buildIntercomTypePickPanel() {
    const typeMap = this.settingsStore.intercomTicketTypeMap();
    const options = [
      ...this.categoryRegistry.getAll().map((c) => ({
        label: `${c.label} (${c.id})`,
        value: c.id,
        description: typeMap[c.id] ? `mapped → ticket type ${typeMap[c.id]}` : "not mapped",
      })),
      {
        label: "Default (fallback for everything unmapped)",
        value: "_default",
        description: typeMap["_default"] ? `mapped → ticket type ${typeMap["_default"]}` : "not mapped — required",
      },
    ];
    const select = new StringSelectMenuBuilder()
      .setCustomId("config_intercom_map_cat_pick")
      .setPlaceholder("Pick a category to map")
      .addOptions(options.slice(0, 25));
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return {
      embeds: [
        makeEmbed(
          [
            "Map each ticket category to an Intercom **ticket type**. The **Default** mapping is required — it catches tickets with no category-specific mapping.",
            "**Back-office types are recommended**: Intercom's \"ticket created\" workflow trigger channel-gates Customer tickets (API-created ones never match), while back-office tickets trigger without a channel filter — and your customers never see Intercom anyway.",
          ].join("\n"),
          COLORS.neutral
        ),
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
    };
  }

  // Status tag → Intercom ticket state mapping, step 1: pick the tag.
  private buildIntercomStatePickPanel() {
    const options = this.settingsStore.tags().map((t) => ({
      label: `${t.emoji} ${t.label}`,
      value: t.id,
      description: t.intercomTicketStateId ? `mapped → state ${t.intercomTicketStateId}` : "not mapped",
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId("config_intercom_map_status_pick")
      .setPlaceholder("Pick a status tag to map")
      .addOptions(options.slice(0, 25));
    const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
    return {
      embeds: [
        makeEmbed(
          "Map each bot status tag to an Intercom **ticket state**. Unmapped tags leave the Intercom state untouched (the conversation still closes/reopens on closing statuses). In bi mode, agents changing the state in Intercom move the ticket to the mapped tag.",
          COLORS.neutral
        ),
      ],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
    };
  }

  private buildGeneralPanel() {
    const s = this.settingsStore;
    const embed = new EmbedBuilder()
      .setTitle("General Settings")
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Threads channel:** ${s.threadsChannelId() ? `<#${s.threadsChannelId()}>` : "_not set_"}`,
          `**GitHub repo:** ${s.githubRepo() ? `\`${s.githubRepo()}\`` : "_not set_"}`,
          `**Ticket limits:** ${s.maxOpenTicketsPerUser() > 0 ? `max ${s.maxOpenTicketsPerUser()} open` : "no cap"} · ${s.ticketCooldownMinutes() > 0 ? `${s.ticketCooldownMinutes()}m cooldown` : "no cooldown"}`,
          "",
          "Staff roles are managed under Workflow → Staff Roles.",
        ].join("\n")
      );

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId("config_set_channel")
      .setPlaceholder("Threads channel")
      .addChannelTypes(ChannelType.GuildText);
    if (s.threadsChannelId()) channelSelect.setDefaultChannels(s.threadsChannelId()!);

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("config_set_repo").setLabel("Set GitHub Repo").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_limits").setLabel("Ticket Limits").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("config_back_main").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return {
      embeds: [embed],
      components: [
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
                const flags = [
                  t.isInitial ? "initial" : null,
                  t.closesThread ? "closes" : null,
                  t.isCustomerReplyTarget ? "reply target" : null,
                ]
                  .filter(Boolean)
                  .join(", ");
                const reminder = t.reminderEnabled
                  ? `${t.reminderDays}d → ${t.reminderTarget === "CUSTOMER" ? "customer (Discord ping)" : "agents (Intercom note)"}`
                  : "no reminders";
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
        new ButtonBuilder().setCustomId("config_workflow").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )
    );

    return { embeds: [embed], components };
  }

  private buildTagEditPanel(tag: StatusTag) {
    const tags = this.settingsStore.tags();
    const idx = tags.findIndex((t) => t.id === tag.id);
    const atTop = idx <= 0;
    const atBottom = idx === -1 || idx >= tags.length - 1;

    const embed = new EmbedBuilder()
      .setTitle(`Edit ${tag.emoji} ${tag.label}`)
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Initial:** ${tag.isInitial ? "yes" : "no"}`,
          `**Closes + locks thread:** ${tag.closesThread ? "yes" : "no"}`,
          `**Reminders:** ${tag.reminderEnabled ? `every ${tag.reminderDays} day(s) → ${tag.reminderTarget === "CUSTOMER" ? "customer (Discord ping)" : "agents (Intercom note + reopen)"}` : "off"}`,
          `**Auto-close after:** ${tag.autoCloseAfter == null ? "never" : `${tag.autoCloseAfter} unanswered customer reminder(s)`}`,
          `**Customer-reply target:** ${tag.isCustomerReplyTarget ? "yes — a customer reply to a Waiting-for-Customer ticket lands here" : "no"}`,
        ].join("\n")
      );

    const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`config_tag_set_initial:${tag.id}`)
        .setLabel(tag.isInitial ? "Initial ✓" : "Set as Initial")
        .setStyle(tag.isInitial ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tag_toggle_closes:${tag.id}`).setLabel("Toggle Closes").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tag_toggle_reminder:${tag.id}`).setLabel("Toggle Reminder").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`config_tag_target:${tag.id}`)
        .setLabel(`Remind: ${tag.reminderTarget === "CUSTOMER" ? "customer" : "agents"}`)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`config_tag_toggle_reply_target:${tag.id}`)
        .setLabel(tag.isCustomerReplyTarget ? "Reply target ✓" : "Set reply target")
        .setStyle(tag.isCustomerReplyTarget ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const reorder = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config_tag_move_up:${tag.id}`).setLabel("Move Up").setEmoji("⬆️").setStyle(ButtonStyle.Secondary).setDisabled(atTop),
      new ButtonBuilder().setCustomId(`config_tag_move_down:${tag.id}`).setLabel("Move Down").setEmoji("⬇️").setStyle(ButtonStyle.Secondary).setDisabled(atBottom)
    );

    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config_tag_edit_basic:${tag.id}`).setLabel("Edit emoji/label/days").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`config_tag_delete:${tag.id}`).setLabel("Delete").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("config_tags").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [toggles, reorder, actions] };
  }

  private buildEscalationPanel() {
    const tiers = this.tierStore.list();
    const embed = new EmbedBuilder()
      .setTitle("Staff Roles")
      .setColor(0x5865f2)
      .setDescription(
        tiers.length
          ? tiers.map((t) => `${t.name} — <@&${t.roleId}>`).join("\n")
          : "_No roles yet — the legacy support role is used as fallback._"
      )
      .setFooter({
        text: "Members of any role here count as staff: /charge authorization, ticket rate-limit exemption, staff/customer classification for the Intercom bridge, and the blocked-charge review ping (first role).",
      });

    const components: ActionRowBuilder<any>[] = [];
    if (tiers.length) {
      const pick = new StringSelectMenuBuilder()
        .setCustomId("config_tier_pick")
        .setPlaceholder("Edit a staff role")
        .addOptions(tiers.map((t) => ({ label: t.name, value: t.id })));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(pick));
    }
    const addSelect = new RoleSelectMenuBuilder()
      .setCustomId("config_tier_add_role")
      .setPlaceholder("Add staff role: pick its Discord role");
    components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(addSelect));
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("config_workflow").setLabel("Back").setStyle(ButtonStyle.Secondary)
      )
    );

    return { embeds: [embed], components };
  }

  private buildTierEditPanel(tier: EscalationTier) {
    const tiers = this.tierStore.list();
    const position = tiers.findIndex((t) => t.id === tier.id);
    const embed = new EmbedBuilder()
      .setTitle(`Edit staff role: ${tier.name}`)
      .setColor(0x5865f2)
      .setDescription(
        [
          `**Role:** <@&${tier.roleId}>`,
          `**Position:** ${position + 1} of ${tiers.length} — the first role receives the blocked-charge review ping`,
        ].join("\n")
      );

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`config_tier_up:${tier.id}`).setLabel("Move Up").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tier_down:${tier.id}`).setLabel("Move Down").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`config_tier_rename:${tier.id}`).setLabel("Rename").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`config_tier_delete:${tier.id}`).setLabel("Delete").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("config_escalation").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [buttons] };
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
    if (id === "config_workflow") {
      await interaction.update(this.buildWorkflowHubPanel());
      return;
    }
    if (id === "config_reporting") {
      await interaction.update(this.buildReportingHubPanel());
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
    if (id === "config_integrations") {
      await interaction.update(this.buildIntegrationsHubPanel());
      return;
    }
    if (id === "config_aianalytics") {
      await interaction.update(this.buildAiAnalyticsHubPanel());
      return;
    }
    if (id === "config_infra") {
      await interaction.update(this.buildInfrastructureHubPanel());
      return;
    }

    if (id === "config_ai") {
      await interaction.update(this.buildAiPanel());
      return;
    }

    if (id === "config_toggle_kb") {
      await this.settingsStore.updateKnowledge({ kbRefreshEnabled: !this.settingsStore.kbRefreshEnabled() });
      this.auditConfig(interaction, `KB auto-refresh → ${this.settingsStore.kbRefreshEnabled() ? "on" : "off"}`);
      await interaction.update(this.buildAiPanel());
      return;
    }

    if (id === "config_kb_refresh_now") {
      // git pull can take a moment — defer, then report the outcome ephemerally.
      await interaction.deferReply({ flags: 64 });
      const { ok, failed } = await this.kbScheduler.refreshNow();
      this.auditConfig(interaction, `KB manual refresh → ${ok} ok, ${failed} failed`);
      await interaction.editReply({
        embeds: [
          makeEmbed(
            failed === 0
              ? `Knowledge base refreshed (${ok} repo(s) updated).`
              : `Knowledge base refresh: ${ok} updated, ${failed} failed — see logs. Answers continue on the last good checkout.`,
            failed === 0 ? COLORS.success : COLORS.warn
          ),
        ],
      });
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

    if (id === "config_billing") {
      await interaction.update(this.buildBillingPanel());
      return;
    }

    if (id === "config_stripe_webhook") {
      await interaction.update(this.buildStripeWebhookPanel());
      return;
    }

    if (id === "config_stripe_webhook_toggle") {
      await interaction.deferUpdate();
      const turningOn = !this.settingsStore.stripeWebhookEnabled();
      await this.settingsStore.updateStripeWebhook({ stripeWebhookEnabled: turningOn });
      // Register on enable; tear the endpoint down on disable.
      const result = turningOn ? await this.stripeWebhook.ensureEndpoint() : (await this.stripeWebhook.disableEndpoint(), null);
      this.auditConfig(interaction, `Stripe webhooks → ${turningOn ? `on (${result?.status})` : "off"}`);
      await interaction.editReply(this.buildStripeWebhookPanel());
      return;
    }

    if (id === "config_stripe_webhook_register" || id === "config_stripe_webhook_rotate") {
      await interaction.deferUpdate();
      const rotate = id === "config_stripe_webhook_rotate";
      const result = await this.stripeWebhook.ensureEndpoint(rotate);
      this.auditConfig(interaction, `Stripe webhook ${rotate ? "rotate" : "register"} → ${result.status}`);
      await interaction.editReply(this.buildStripeWebhookPanel());
      return;
    }

    if (id === "config_stripe_webhook_url") {
      const modal = new ModalBuilder().setCustomId("config_stripe_webhook_url_modal").setTitle("Public Base URL");
      const input = new TextInputBuilder()
        .setCustomId("url")
        .setLabel("Public origin (blank = use callback URL)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder("https://bot.example.com")
        .setValue(this.settingsStore.publicBaseUrl() ?? "");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_billing_clear_channel") {
      await this.settingsStore.updateBilling({ billingAuditChannelId: null });
      this.auditConfig(interaction, "Billing audit channel → cleared");
      await interaction.update(this.buildBillingPanel());
      return;
    }

    if (id === "config_disputes") {
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_toggle_cancel") {
      const next = !this.settingsStore.disputeAutoCancelSub();
      await this.settingsStore.updateDisputes({ disputeAutoCancelSub: next });
      this.auditConfig(interaction, `Dispute auto-cancel subscriptions → ${next ? "on" : "off"}`);
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_toggle_block") {
      const next = !this.settingsStore.disputeAutoBlock();
      await this.settingsStore.updateDisputes({ disputeAutoBlock: next });
      this.auditConfig(interaction, `Dispute auto-block → ${next ? "on" : "off"}`);
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_toggle_receipt") {
      const next = !this.settingsStore.disputeAutoAttachReceipt();
      await this.settingsStore.updateDisputes({ disputeAutoAttachReceipt: next });
      this.auditConfig(interaction, `Dispute auto-attach receipt → ${next ? "on" : "off"}`);
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_limits") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_disputes_limits_modal").setTitle("Dispute Thresholds");
      const mkInput = (cid: string, label: string, value: string) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId(cid).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setValue(value)
        );
      modal.addComponents(
        mkInput("reminder_days", "Reminder lead (days before due, 1-30)", String(s.disputeReminderDays())),
        mkInput("urgent_hours", "Urgent tier window (hours before due, 1-168)", String(s.disputeUrgentHours())),
        mkInput("warn_pct", "Ratio warn threshold (%)", String(s.disputeRatioWarnPct())),
        mkInput("critical_pct", "Ratio critical threshold (%)", String(s.disputeRatioCriticalPct()))
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_disputes_urgent_role_clear") {
      await this.settingsStore.updateDisputes({ disputeUrgentRoleId: null });
      this.auditConfig(interaction, "Urgent dispute role cleared");
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_backfill") {
      // All-time Stripe sweep into the local mirror + historical Influx outcome
      // points. Idempotent, so re-runs are allowed (e.g. after enabling Influx).
      await interaction.deferReply({ flags: 64 });
      if (!this.disputes) return;
      try {
        const result = await backfillDisputeHistory(this.disputes.stripeClient, this.disputes.disputeStore);
        await this.settingsStore.updateDisputes({ disputeBackfillDoneAt: new Date() });
        this.auditConfig(
          interaction,
          `Dispute history backfilled → ${result.swept} swept, ${result.terminal} closed, ${result.points} Influx point(s)${result.truncated ? " (sweep truncated)" : ""}`
        );
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `✅ Backfill complete — swept **${result.swept}** dispute(s) from Stripe (all-time), **${result.terminal}** closed.` +
                (result.points
                  ? ` Wrote **${result.points}** historical outcome point(s) to InfluxDB.`
                  : " Influx exporter inactive — no analytics points written (re-run after enabling it).") +
                (result.truncated ? "\n⚠️ Sweep hit the page cap — run again to continue." : ""),
              COLORS.success
            ),
          ],
        });
      } catch (error) {
        await interaction.editReply({
          embeds: [makeEmbed(`Backfill failed: ${String(error).slice(0, 500)}`, COLORS.danger)],
        });
      }
      return;
    }

    if (id === "config_disputes_radar") {
      await interaction.deferUpdate();
      if (!this.disputes) return;
      // List ids are plain rsl_… identifiers, not secrets — safe to display.
      const results = await this.disputes.blockService.ensureRadarLists();
      const summary = results
        .map((r) => `${r.kind}: ${r.listId ? `${r.created ? "created" : "ok"} (\`${r.listId}\`)` : `FAILED — ${r.error?.slice(0, 100)}`}`)
        .join(" · ");
      this.auditConfig(interaction, `Radar value lists provisioned → ${summary.slice(0, 400)}`);
      await interaction.editReply(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_disputes_run_now") {
      await interaction.deferUpdate();
      const result = await this.temporalOps?.producers.disputesRunNow();
      this.auditConfig(
        interaction,
        `Dispute check triggered → ${result?.ok ? "signalled" : "not routable (Temporal off?)"}`
      );
      await interaction.editReply(this.buildDisputesConfigPanel());
      return;
    }

    if (id === "config_billing_plans") {
      // Plan allowlist for the /billing subscription pickers — the panel and
      // its flows live in the billing admin; its Back returns to config_billing.
      await this.billingAdmin.openPlanSettings(interaction);
      return;
    }

    if (id === "config_intercom") {
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id.startsWith("config_intercom_mode_confirm_")) {
      // Soft-warning confirm — but the panel can sit open indefinitely, so
      // re-run the HARD checks (a secret could have been cleared meanwhile).
      const mode = id.slice("config_intercom_mode_confirm_".length) as IntercomMode;
      if (mode !== "push" && mode !== "bi") return;
      await interaction.deferUpdate();
      const pf = await this.intercomModePreflight(mode);
      if (pf.hard.length > 0) {
        await interaction.editReply(await this.buildIntercomPanel());
        await interaction.followUp({
          embeds: [
            makeEmbed(
              [`Cannot enable **${mode}** — the configuration changed since the preflight:`, ...pf.hard.map((h) => `• ${h}`)].join("\n"),
              COLORS.danger
            ),
          ],
          flags: 64,
        });
        return;
      }
      await this.applyIntercomMode(interaction, this.settingsStore.intercomMode(), mode);
      await interaction.editReply(await this.buildIntercomPanel());
      return;
    }

    if (id.startsWith("config_intercom_mode_")) {
      const mode = id.slice("config_intercom_mode_".length) as IntercomMode;
      if (mode !== "none" && mode !== "push" && mode !== "bi") return;
      const before = this.settingsStore.intercomMode();
      if (mode === before) {
        await interaction.update(await this.buildIntercomPanel());
        return;
      }

      if (mode === "none") {
        await this.applyIntercomMode(interaction, before, mode);
        await interaction.update(await this.buildIntercomPanel());
        await interaction
          .followUp({
            embeds: [
              makeEmbed(
                "Bridge off — nothing mirrors in either direction. Intercom agent replies posted while off are healed when you re-enable **bi**; Discord messages sent while off are NOT replayable.",
                COLORS.warn
              ),
            ],
            flags: 64,
          })
          .catch(() => {});
        return;
      }

      // Preflight (token probe hits the API — defer first). Hard failures
      // block the flip; soft ones warn and ask for an explicit confirm.
      await interaction.deferUpdate();
      const pf = await this.intercomModePreflight(mode);
      if (pf.hard.length > 0) {
        await interaction.editReply(await this.buildIntercomPanel());
        await interaction.followUp({
          embeds: [
            makeEmbed(
              [`Cannot enable **${mode}** — fix these first:`, ...pf.hard.map((h) => `• ${h}`)].join("\n"),
              COLORS.danger
            ),
          ],
          flags: 64,
        });
        return;
      }
      if (pf.soft.length > 0) {
        const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`config_intercom_mode_confirm_${mode}`)
            .setLabel(`Enable ${mode === "bi" ? "Bidirectional" : "Push"} anyway`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("config_intercom").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          embeds: [
            makeEmbed(
              [`Preflight passed with warnings for **${mode}**:`, ...pf.soft.map((w) => `• ${w}`)].join("\n"),
              COLORS.warn
            ),
          ],
          components: [confirm],
        });
        return;
      }
      await this.applyIntercomMode(interaction, before, mode);
      await interaction.editReply(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_region") {
      const order: IntercomRegion[] = ["us", "eu", "au"];
      const next = order[(order.indexOf(this.settingsStore.intercomRegion()) + 1) % order.length];
      await this.settingsStore.updateIntercom({ intercomRegion: next });
      this.auditConfig(interaction, `Intercom region → ${next.toUpperCase()}`);
      await interaction.update(await this.buildIntercomPanel());
      return;
    }

    if (id === "config_intercom_reset") {
      const links = await this.intercomStore.countLinks();
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("config_intercom_reset_confirm").setLabel("Yes, wipe bridge data").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("config_intercom").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              `This deletes the bot's local bridge state: **${links}** link(s) plus the echo/pending ledgers.`,
              "",
              "Nothing is deleted in Intercom itself. Use this when the Intercom side was cleared or recreated and the bookkeeping is stale — the next **Backfill** rebuilds every ticket from Discord.",
              "⚠️ If the conversations/tickets still exist in Intercom, the next backfill will create duplicates.",
            ].join("\n"),
            COLORS.warn
          ),
        ],
        components: [confirm],
      });
      return;
    }

    if (id === "config_intercom_reset_confirm") {
      // Queued (pre-reset) events in the ticket workflows would resurrect the
      // bridge state being reset — clear their outboxes (targets collected
      // before resetAll, signals sent after; see collectIntercomClearTargets).
      const clearTargets = await this.collectIntercomClearTargets();
      const result = await this.intercomStore.resetAll();
      await this.signalIntercomClear(clearTargets);
      this.auditConfig(
        interaction,
        `Intercom bridge data reset (${result.links} links, ${result.parts} echo/pending rows deleted)`
      );
      await interaction.update(await this.buildIntercomPanel());
      await interaction.followUp({
        embeds: [
          makeEmbed(`Bridge data wiped: ${result.links} link(s). Run **Backfill tickets** to rebuild.`, COLORS.success),
        ],
        flags: 64,
      });
      return;
    }

    if (id === "config_intercom_snooze") {
      const tags = this.settingsStore.tags();
      const current = this.settingsStore.intercomSnoozeStatusTagId();
      const options = [
        { label: "None (ignore Intercom snooze)", value: "__none__", default: !current },
        ...tags.slice(0, 24).map((t) => {
          const warnings = [
            t.reminderEnabled ? "⚠️ has reminders" : null,
            t.closesThread ? "⚠️ closes thread" : null,
            t.intercomTicketStateId ? "⚠️ mapped to an Intercom state" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return {
            label: `${t.emoji} ${t.label}`.slice(0, 100),
            value: t.id,
            description: (warnings || "good fit").slice(0, 100),
            default: t.id === current,
          };
        }),
      ];
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("config_intercom_snooze_pick").setPlaceholder("Status tag applied on Intercom snooze").addOptions(options)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              "Pick the status tag applied in Discord when an agent **snoozes** the conversation in Intercom. Unsnooze restores the previous tag.",
              "",
              "The tag should have **no reminders**, **not close the thread**, and **no Intercom state mapping** (a '💤 Snoozed' tag works well — create one under /config → Tags if needed).",
            ].join("\n"),
            COLORS.neutral
          ),
        ],
        components: [
          row,
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return;
    }

    if (id === "config_intercom_inactivity") {
      await interaction.update(this.buildInactivityPanel());
      return;
    }

    if (id === "config_inactivity_toggle") {
      await this.settingsStore.updateInactivity({ inactivityEnabled: !this.settingsStore.inactivityEnabled() });
      this.auditConfig(interaction, `Inactivity sweeper → ${this.settingsStore.inactivityEnabled() ? "on" : "off"}`);
      await interaction.update(this.buildInactivityPanel());
      return;
    }

    if (id === "config_inactivity_opts") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_inactivity_opts_modal").setTitle("Inactivity Thresholds");
      const agentDays = new TextInputBuilder()
        .setCustomId("agent_days")
        .setLabel("Agent-idle days before a note (1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(s.inactivityAgentWaitDays()));
      const customerDays = new TextInputBuilder()
        .setCustomId("customer_days")
        .setLabel("Customer-idle days before a nag (1-30)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(s.inactivityCustomerWaitDays()));
      const nags = new TextInputBuilder()
        .setCustomId("nags")
        .setLabel("Unanswered nags before auto-close (1-10)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(s.inactivityNagsBeforeClose()));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(agentDays),
        new ActionRowBuilder<TextInputBuilder>().addComponents(customerDays),
        new ActionRowBuilder<TextInputBuilder>().addComponents(nags)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_inactivity_run") {
      await interaction.deferReply({ flags: 64 });
      const r = await this.temporalProducers?.inactivityRunNow();
      await interaction.editReply({
        embeds: [
          makeEmbed(
            r?.ok
              ? "Triggered an inactivity sweep (bypasses the enabled toggle for this one run). Results land in the audit channel."
              : `Couldn't trigger the sweep: ${r?.error ?? "Temporal unreachable"}.`,
            r?.ok ? COLORS.success : COLORS.danger
          ),
        ],
      });
      return;
    }

    if (id === "config_sentry") {
      await interaction.update(this.buildSentryPanel());
      return;
    }

    if (id === "config_sentry_dsn") {
      const modal = new ModalBuilder().setCustomId("config_sentry_dsn_modal").setTitle("Sentry DSN");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("dsn")
            .setLabel("DSN (blank = disable Sentry)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(this.settingsStore.sentryDsn() ?? "")
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_sentry_options") {
      const modal = new ModalBuilder().setCustomId("config_sentry_options_modal").setTitle("Sentry Rates & Environment");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("environment")
            .setLabel("Environment name")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(this.settingsStore.sentryEnvironment())
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("traces_rate")
            .setLabel("Traces sample rate (0.0 – 1.0)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(this.settingsStore.sentryTracesSampleRate()))
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("profiles_rate")
            .setLabel("Profiles sample rate (0.0 – 1.0)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(this.settingsStore.sentryProfilesSampleRate()))
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (
      id === "config_sentry_toggle_logs" ||
      id === "config_sentry_toggle_debug" ||
      id === "config_sentry_toggle_pii" ||
      id === "config_sentry_toggle_ai"
    ) {
      const s = this.settingsStore;
      let change: string;
      if (id === "config_sentry_toggle_logs") {
        await s.updateSentry({ sentryLogsEnabled: !s.sentryLogsEnabled() });
        change = `Sentry logs → ${s.sentryLogsEnabled() ? "on" : "off"}`;
      } else if (id === "config_sentry_toggle_debug") {
        await s.updateSentry({ sentryDebug: !s.sentryDebug() });
        change = `Sentry debug → ${s.sentryDebug() ? "on" : "off"}`;
      } else if (id === "config_sentry_toggle_pii") {
        await s.updateSentry({ sentrySendDefaultPii: !s.sentrySendDefaultPii() });
        change = `Sentry default PII → ${s.sentrySendDefaultPii() ? "on" : "off"}`;
      } else {
        await s.updateSentry({ sentryAiRecordContent: !s.sentryAiRecordContent() });
        setAiRecordContent(s.sentryAiRecordContent());
        change = `Sentry AI content capture → ${s.sentryAiRecordContent() ? "on" : "off"}`;
      }
      const { note } = await this.applySentrySettings();
      this.auditConfig(interaction, change);
      await interaction.update(this.buildSentryPanel());
      if (note) await interaction.followUp({ embeds: [makeEmbed(note, COLORS.brand)], flags: 64 });
      return;
    }

    if (id === "config_sentry_test") {
      await interaction.deferReply({ flags: 64 });
      const res = await sendSentryTestEvent("config_test_button");
      await interaction.editReply({
        embeds: [
          makeEmbed(
            !res
              ? "Sentry is not active in this process. Set a DSN (first-time enable is live), or restart if you changed an existing one."
              : res.flushed
                ? `✅ Test event delivered — id \`${res.eventId}\`. It shows up in Sentry → Issues as an *info* message within seconds.`
                : `⚠️ Test event queued (id \`${res.eventId}\`) but the flush timed out — check the DSN and outbound network.`,
            !res ? COLORS.warn : res.flushed ? COLORS.success : COLORS.danger
          ),
        ],
      });
      return;
    }

    if (id === "config_analytics") {
      await interaction.update(await this.buildAnalyticsPanel());
      return;
    }

    if (id.startsWith("config_vault")) {
      await this.handleVaultConfigButton(interaction, id);
      return;
    }

    if (id.startsWith("config_temporal")) {
      await this.handleTemporalConfigButton(interaction, id);
      return;
    }

    if (id === "config_analytics_influx") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_analytics_influx_modal").setTitle("InfluxDB 2.x Connection");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("url")
            .setLabel("URL (e.g. https://influx.example.com:8086)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.influxUrl() ?? "")
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("org")
            .setLabel("Organization")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.influxOrg() ?? "")
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("bucket")
            .setLabel("Bucket")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(s.influxBucket() ?? "")
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("token")
            .setLabel("API token (blank = keep current)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(s.influxToken() ? "•••• stored (leave blank to keep)" : "write-scoped token for the bucket")
        )
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_analytics_toggle_influx") {
      await this.settingsStore.updateAnalytics({ influxEnabled: !this.settingsStore.influxEnabled() });
      await reconfigureInflux(this.settingsStore.influxConfig());
      this.auditConfig(interaction, `Influx export → ${this.settingsStore.influxEnabled() ? "on" : "off"}`);
      await interaction.update(await this.buildAnalyticsPanel());
      return;
    }

    if (id === "config_analytics_test") {
      await interaction.deferReply({ flags: 64 });
      try {
        await pingInflux();
        await interaction.editReply({
          embeds: [makeEmbed("✅ Test point written and flushed — check the `bot_health` measurement.", COLORS.success)],
        });
      } catch (error) {
        await interaction.editReply({
          embeds: [makeEmbed(`Test write failed: ${error instanceof Error ? error.message : String(error)}`, COLORS.danger)],
        });
      }
      return;
    }

    if (id === "config_intercom_wipe") {
      const links = await this.intercomStore.listAllLinks();
      const contacts = new Set(links.map((l) => l.contactId)).size;
      const tickets = links.filter((l) => l.ticketId).length;
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("config_intercom_wipe_confirm")
          .setLabel("Yes, delete everything from Intercom")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(links.length === 0),
        new ButtonBuilder().setCustomId("config_intercom").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              `⚠️ From Intercom this **permanently deletes** **${links.length}** conversation(s) and **${tickets}** converted ticket(s), and **archives** **${contacts}** bridge-created contact(s) (archiving keeps their external_ids reusable — a permanent contact delete would lock them for 7 days and block re-backfilling).`,
              "",
              "The bot's local bridge state (links + queued events + echo ledger) is wiped too, so a later **Backfill** can rebuild everything cleanly.",
              "Only bridge-created objects are touched — Intercom-native conversations/contacts and all Discord threads stay untouched.",
            ].join("\n"),
            COLORS.danger
          ),
        ],
        components: [confirm],
      });
      return;
    }

    if (id === "config_intercom_wipe_confirm") {
      await interaction.deferReply({ flags: 64 });
      await this.runIntercomWipe(interaction);
      return;
    }

    if (id === "config_intercom_backfill") {
      // Confirm with counts first (matches the Influx/scoring backfills) — a
      // replay of every unbridged ticket is a long, noisy drain.
      const [links, total] = await Promise.all([
        this.intercomStore.countLinks().catch(() => 0),
        this.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
      ]);
      const unbridged = Math.max(0, total - links);
      const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("config_intercom_backfill_confirm")
          .setLabel("Start backfill")
          .setStyle(ButtonStyle.Primary)
          .setDisabled(unbridged === 0),
        new ButtonBuilder().setCustomId("config_intercom").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        embeds: [
          makeEmbed(
            [
              `This replays **${unbridged}** unbridged ticket(s) (open + closed, full transcripts) into Intercom; ${links} already-bridged ticket(s) are skipped.`,
              "",
              "The drain is paced (~1 event / 300ms) and runs in the background via the ticket workflows. Closed tickets are re-closed at the end of each replay.",
            ].join("\n"),
            COLORS.warn
          ),
        ],
        components: [confirm],
      });
      return;
    }

    if (id === "config_intercom_backfill_confirm") {
      await interaction.deferReply({ flags: 64 });
      await this.runIntercomBackfill(interaction);
      return;
    }

    if (id === "config_intercom_resync") {
      // Drift reconcile: every ticket closed/resolved in Discord re-asserts its
      // closed state onto Intercom (damper-bypassing), closing conversations
      // that incident auto-reopens left open. Nothing is deleted; open tickets
      // are untouched.
      await interaction.deferReply({ flags: 64 });
      if (this.settingsStore.intercomMode() === "none") {
        await interaction.editReply({
          embeds: [makeEmbed("The bridge is off — enable Push or Bidirectional first, then run the sync.", COLORS.warn)],
        });
        return;
      }
      const links = await this.intercomStore.listAllLinks();
      let enqueued = 0;
      for (const link of links) {
        const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
        if (!ticket) continue;
        if (await this.intercomSync.resyncClosedStatus(ticket).catch(() => false)) enqueued++;
      }
      const summary = `Re-sync queued for **${enqueued}** closed/resolved ticket(s) (of ${links.length} bridged). Their Intercom conversations close in the background via the normal paced delivery queue.`;
      await interaction.editReply({ embeds: [makeEmbed(summary, COLORS.success)] });
      this.auditConfig(interaction, `Intercom closed-state re-sync (${enqueued} tickets)`);
      return;
    }

    if (id === "config_intercom_secrets") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_intercom_secrets_modal").setTitle("Intercom Secrets");
      const accessToken = new TextInputBuilder()
        .setCustomId("access_token")
        .setLabel("Access token (Developer Hub → your app)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(s.intercomAccessToken() ?? "");
      const clientSecret = new TextInputBuilder()
        .setCustomId("client_secret")
        .setLabel("Client secret (blank = inbound webhook off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.intercomClientSecret() ?? "");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(accessToken),
        new ActionRowBuilder<TextInputBuilder>().addComponents(clientSecret)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_intercom_admin") {
      await interaction.deferUpdate();
      try {
        const [admins, me] = await Promise.all([
          this.intercomClient.listAdmins(),
          this.intercomClient.getMe().catch(() => null),
        ]);
        const current = this.settingsStore.intercomAdminId();
        const options = admins.slice(0, 25).map((a) => ({
          label: (a.name || `Admin ${a.id}`).slice(0, 100),
          value: a.id,
          description: (a.email ?? undefined)?.slice(0, 100),
          default: a.id === current,
        }));
        if (me && !options.some((o) => o.value === me.id)) {
          options.pop();
          options.push({ label: `${me.name ?? "Token owner"} (token owner)`, value: me.id, description: me.email ?? undefined, default: me.id === current });
        }
        if (options.length === 0) {
          await interaction.followUp({ embeds: [makeEmbed("Intercom returned no admins — check the access token.", COLORS.danger)], flags: 64 });
          return;
        }
        const select = new StringSelectMenuBuilder()
          .setCustomId("config_intercom_admin_pick")
          .setPlaceholder("Fallback authoring admin")
          .addOptions(options);
        const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          embeds: [
            makeEmbed(
              [
                "Pick the admin the bridge authors as when the Operator/Fin bot is rejected (or was never detected).",
                "The bridge prefers the auto-detected Operator — this admin is the fallback. Echo suppression is part-id based, so even an admin who actually answers tickets is safe to pick.",
              ].join("\n"),
              COLORS.neutral
            ),
          ],
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
        });
      } catch (e) {
        await interaction.followUp({
          embeds: [makeEmbed(`Could not list Intercom admins: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
          flags: 64,
        });
      }
      return;
    }

    if (id === "config_intercom_team") {
      await interaction.deferUpdate();
      try {
        const teams = await this.intercomClient.listTeams();
        const current = this.settingsStore.intercomTeamId();
        const select = new StringSelectMenuBuilder()
          .setCustomId("config_intercom_team_pick")
          .setPlaceholder("Team for new bridged conversations/tickets")
          .addOptions([
            { label: "— unassigned —", value: "__none__", description: "Don't route; conversations land in the shared inbox", default: !current },
            ...teams.slice(0, 24).map((t) => ({
              label: t.name.slice(0, 100),
              value: t.id,
              description: `id ${t.id}`,
              default: t.id === current,
            })),
          ]);
        const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("config_intercom").setLabel("Back").setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
          embeds: [
            makeEmbed(
              "Every new bridged conversation **and** its ticket get assigned to this team on creation (Intercom workflow triggers can't see API-created conversations, so the bridge routes directly). Agents can reassign afterwards — the bridge never overrides.",
              COLORS.neutral
            ),
          ],
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), back],
        });
      } catch (e) {
        await interaction.followUp({
          embeds: [makeEmbed(`Could not list Intercom teams: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
          flags: 64,
        });
      }
      return;
    }

    if (id === "config_intercom_types") {
      await interaction.update(this.buildIntercomTypePickPanel());
      return;
    }

    if (id === "config_intercom_states") {
      await interaction.update(this.buildIntercomStatePickPanel());
      return;
    }

    if (id === "config_intercom_attrs") {
      await interaction.deferReply({ flags: 64 });
      const typeIds = [...new Set(Object.values(this.settingsStore.intercomTicketTypeMap()))];
      if (typeIds.length === 0) {
        await interaction.editReply({ embeds: [makeEmbed("Map at least one ticket type first.", COLORS.warn)] });
        return;
      }
      const lines: string[] = [];
      const types = await this.intercomClient.listTicketTypes().catch(() => null);
      for (const typeId of typeIds) {
        const existing = types?.find((t) => t.id === typeId)?.attributeNames ?? [];
        const results: string[] = [];
        for (const [name, description] of [
          [TICKET_ATTR_CSAT, "CSAT rating mirrored from the Discord support bot"],
          [TICKET_ATTR_CSAT_COMMENT, "CSAT comment mirrored from the Discord support bot"],
          [TICKET_ATTR_THREAD, "Discord thread id of the bridged ticket"],
        ] as const) {
          if (existing.includes(name)) {
            results.push(`${name} ✓`);
            continue;
          }
          try {
            await this.intercomClient.createTicketTypeAttribute(typeId, name, description);
            results.push(`${name} ✓`);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // "Already exists"-shaped rejections count as success.
            results.push(/exist|taken|unique/i.test(message) ? `${name} ✓` : `${name} ✗`);
          }
        }
        lines.push(`Type \`${typeId}\`: ${results.join(" · ")}`);
      }
      const failed = lines.some((l) => l.includes("✗"));
      await interaction.editReply({
        embeds: [
          makeEmbed(
            [
              ...lines,
              ...(failed
                ? ["", "✗ = could not create via API. Add the attribute manually in Intercom: Settings → Ticket types → add a text attribute with exactly that name."]
                : []),
              "",
              "Conversations are marked with a **Discord** tag automatically. For the optional `Origin` + `Discord Thread` conversation attributes, create them once by hand (Settings → Data → Conversations) — the API can't define conversation attributes.",
            ].join("\n"),
            failed ? COLORS.warn : COLORS.success
          ),
        ],
      });
      return;
    }

    if (id === "config_audit") {
      await interaction.update(this.buildAuditPanel());
      return;
    }

    if (id === "config_audit_clear_channel") {
      // Log before clearing so the "turned off" entry still reaches the channel.
      await this.audit.log({
        title: "⚙️ Config updated",
        severity: "neutral",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        fields: [{ name: "Change", value: "Audit log channel → cleared (audit trail off)" }],
      });
      await this.settingsStore.updateGeneral({ auditLogChannelId: null });
      await interaction.update(this.buildAuditPanel());
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
      const velocityUser = new TextInputBuilder()
        .setCustomId("velocity_user")
        .setLabel("Max refunds/24h per user (blank = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMaxPer24hPerUser() != null ? String(s.refundMaxPer24hPerUser()) : "");
      const memberAge = new TextInputBuilder()
        .setCustomId("member_age")
        .setLabel("Min membership age, days (blank = off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(s.refundMinMemberAgeDays() != null ? String(s.refundMinMemberAgeDays()) : "");
      // 5 inputs = Discord's per-modal ceiling; no further guardrail can be added here.
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
        new ActionRowBuilder<TextInputBuilder>().addComponents(currency),
        new ActionRowBuilder<TextInputBuilder>().addComponents(velocity),
        new ActionRowBuilder<TextInputBuilder>().addComponents(velocityUser),
        new ActionRowBuilder<TextInputBuilder>().addComponents(memberAge)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_ai_model") {
      const modal = new ModalBuilder().setCustomId("config_ai_model_modal").setTitle("AI Model");
      const main = new TextInputBuilder()
        .setCustomId("model")
        .setLabel("Model (dispute-evidence drafts)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(this.settingsStore.aiModel());
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(main));
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_ai_perf") {
      const s = this.settingsStore;
      const modal = new ModalBuilder().setCustomId("config_ai_perf_modal").setTitle("AI Speed Limits");
      const effortAsk = new TextInputBuilder()
        .setCustomId("effort_ask")
        .setLabel("Effort (low/medium/high/max)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(s.aiEffortAsk());
      const budgetAsk = new TextInputBuilder()
        .setCustomId("budget_ask")
        .setLabel("Budget (USD per run)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(s.aiMaxBudgetUsdAsk()));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(effortAsk),
        new ActionRowBuilder<TextInputBuilder>().addComponents(budgetAsk)
      );
      await interaction.showModal(modal);
      return;
    }

    if (id === "config_kb_interval") {
      const modal = new ModalBuilder().setCustomId("config_kb_interval_modal").setTitle("KB Refresh Interval");
      const input = new TextInputBuilder()
        .setCustomId("hours")
        .setLabel("Hours between refreshes (1-168)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(this.settingsStore.kbRefreshIntervalHours()));
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

    if (id === "config_escalation") {
      await interaction.update(this.buildEscalationPanel());
      return;
    }

    // Tier-scoped buttons: customId is `config_tier_<action>:<tierId>`
    if (id.startsWith("config_tier_")) {
      const [tierAction, tierId] = id.split(":");
      const tier = this.tierStore.byId(tierId);
      if (!tier) {
        await interaction.update(this.buildEscalationPanel());
        return;
      }
      if (tierAction === "config_tier_up" || tierAction === "config_tier_down") {
        // "Up" in the displayed list = toward tier 1 (lower position index).
        await this.tierStore.move(tier.id, tierAction === "config_tier_up" ? -1 : 1);
        this.auditConfig(interaction, `Escalation tier ${tier.name} → moved ${tierAction === "config_tier_up" ? "up" : "down"}`);
        const moved = this.tierStore.byId(tier.id);
        await interaction.update(moved ? this.buildTierEditPanel(moved) : this.buildEscalationPanel());
        return;
      }
      if (tierAction === "config_tier_rename") {
        const modal = new ModalBuilder().setCustomId(`config_tier_rename_modal:${tier.id}`).setTitle("Rename Tier");
        const input = new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Tier name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
          .setValue(tier.name);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
        return;
      }
      if (tierAction === "config_tier_delete") {
        await this.tierStore.remove(tier.id);
        this.auditConfig(interaction, `Escalation tier deleted → ${tier.name}`);
        await interaction.update(this.buildEscalationPanel());
        return;
      }
      return;
    }

    // Priority-scoped buttons: customId is `config_priority_<action>:<priorityId>`.
    // Must be handled before the tag fallthrough below, which split(":")-parses
    // any remaining id as a tag action.
    // Tag-scoped buttons: customId is `config_tag_<action>:<tagId>`
    const [action, tagId] = id.split(":");
    const tag = tagId ? this.settingsStore.tagById(tagId) : undefined;
    if (!tag) {
      // Doubles as the tombstone for removed config controls sitting on stale
      // ephemeral panels.
      await interaction.reply({
        embeds: [makeEmbed("This control no longer exists — run /config again.", COLORS.warn)],
        flags: 64,
      });
      return;
    }

    if (action === "config_tag_set_initial") {
      await this.settingsStore.editTag(tag.id, { isInitial: true });
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → set as initial`);
    } else if (action === "config_tag_toggle_closes") {
      await this.settingsStore.editTag(tag.id, { closesThread: !tag.closesThread });
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → closes thread: ${!tag.closesThread ? "on" : "off"}`);
    } else if (action === "config_tag_toggle_reminder") {
      await this.settingsStore.editTag(tag.id, { reminderEnabled: !tag.reminderEnabled });
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → reminders: ${!tag.reminderEnabled ? "on" : "off"}`);
    } else if (action === "config_tag_target") {
      const next: ReminderTarget = tag.reminderTarget === "CUSTOMER" ? "SUPPORT" : "CUSTOMER";
      await this.settingsStore.editTag(tag.id, { reminderTarget: next });
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → reminder target: ${next.toLowerCase()}`);
    } else if (action === "config_tag_toggle_reply_target") {
      const next = !tag.isCustomerReplyTarget;
      await this.settingsStore.editTag(tag.id, { isCustomerReplyTarget: next });
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → customer-reply target: ${next ? "on" : "off"}`);
    } else if (action === "config_tag_move_up" || action === "config_tag_move_down") {
      const dir = action === "config_tag_move_up" ? "up" : "down";
      await this.settingsStore.moveTag(tag.id, dir);
      this.auditConfig(interaction, `Status tag ${tag.emoji} ${tag.label} → moved ${dir}`);
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
      this.auditConfig(interaction, repo ? `GitHub repo → \`${repo}\`` : "GitHub repo → cleared");
      await interaction.reply({
        embeds: [makeEmbed(repo ? `GitHub repo set to \`${repo}\`.` : "GitHub repo cleared.", COLORS.success)],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_sentry_dsn_modal") {
      const dsn = interaction.fields.getTextInputValue("dsn").trim();
      await this.settingsStore.updateSentry({ sentryDsn: dsn || null });
      const { result, note } = await this.applySentrySettings();
      // Deliberately no DSN value in the audit line.
      this.auditConfig(interaction, `Sentry DSN ${dsn ? "set" : "cleared"}`);
      await interaction.reply({
        embeds: [
          makeEmbed(
            note ??
              (result.status === "disabled" ? "Sentry stays off (no DSN)." : "Sentry settings saved."),
            result.status === "restart-required" ? COLORS.warn : COLORS.success
          ),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_sentry_options_modal") {
      const environment = interaction.fields.getTextInputValue("environment").trim();
      const tracesRaw = interaction.fields.getTextInputValue("traces_rate").trim();
      const profilesRaw = interaction.fields.getTextInputValue("profiles_rate").trim();
      const traces = Number.parseFloat(tracesRaw);
      const profiles = Number.parseFloat(profilesRaw);
      const validRate = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
      if (!environment || !validRate(traces) || !validRate(profiles)) {
        await interaction.reply({
          embeds: [makeEmbed("Invalid values — environment must be non-empty and both rates between 0.0 and 1.0.", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await this.settingsStore.updateSentry({
        sentryEnvironment: environment,
        sentryTracesSampleRate: traces,
        sentryProfilesSampleRate: profiles,
      });
      const { note } = await this.applySentrySettings();
      this.auditConfig(interaction, `Sentry options → env \`${environment}\`, traces ${traces}, profiles ${profiles}`);
      await interaction.reply({
        embeds: [makeEmbed(note ?? `Sentry options saved — environment \`${environment}\`, traces ${traces}, profiles ${profiles}.`, COLORS.success)],
        flags: 64,
      });
      return;
    }

    if (interaction.customId.startsWith("config_vault_")) {
      await this.handleVaultConfigModal(interaction);
      return;
    }

    if (interaction.customId === "config_temporal_certs_modal") {
      await this.handleTemporalCertsModal(interaction);
      return;
    }

    if (interaction.customId === "config_temporal_conn_modal") {
      const address = interaction.fields.getTextInputValue("address").trim();
      const namespace = interaction.fields.getTextInputValue("namespace").trim();
      const taskQueue = interaction.fields.getTextInputValue("task_queue").trim() || "support-bot";
      const deployment = interaction.fields.getTextInputValue("deployment").trim() || "support-bot";
      const tlsServerName = interaction.fields.getTextInputValue("tls_server_name").trim();
      if (address && !/^[\w.-]+:\d+$/.test(address)) {
        await interaction.reply({
          embeds: [makeEmbed("Address must be `host:port` (e.g. `10.0.0.5:7233`).", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await interaction.deferReply({ flags: 64 });
      await this.settingsStore.updateTemporal({
        temporalAddress: address || null,
        temporalNamespace: namespace || null,
        temporalTaskQueue: taskQueue,
        temporalDeploymentName: deployment,
        temporalTlsServerName: tlsServerName || null,
      });
      await this.temporalOps?.service.reconfigure();
      this.auditConfig(interaction, `Temporal connection → \`${address || "—"}\` / \`${namespace || "—"}\` (queue \`${taskQueue}\`)`);
      await interaction.editReply({
        embeds: [
          makeEmbed(
            [
              `Connection saved — address \`${address || "—"}\`, namespace \`${namespace || "—"}\`, task queue \`${taskQueue}\`, deployment \`${deployment}\`${tlsServerName ? `, TLS server name \`${tlsServerName}\`` : ""}.`,
              this.settingsStore.temporalEnabled() && this.temporalOps?.workerManager.running()
                ? "⚠️ The running worker keeps its old connection — toggle Temporal off/on to apply the change."
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
            COLORS.success
          ),
        ],
      });
      return;
    }

    if (interaction.customId === "config_analytics_influx_modal") {
      const url = interaction.fields.getTextInputValue("url").trim();
      const org = interaction.fields.getTextInputValue("org").trim();
      const bucket = interaction.fields.getTextInputValue("bucket").trim();
      const token = interaction.fields.getTextInputValue("token").trim();
      if (url && !/^https?:\/\//.test(url)) {
        await interaction.reply({
          embeds: [makeEmbed("The URL must start with `http://` or `https://`.", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await this.settingsStore.updateAnalytics({
        influxUrl: url || null,
        influxOrg: org || null,
        influxBucket: bucket || null,
        // Blank token = leave the stored (encrypted) one unchanged.
        ...(token ? { influxToken: token } : {}),
      });
      await reconfigureInflux(this.settingsStore.influxConfig());
      // Deliberately no token value in the audit line.
      this.auditConfig(
        interaction,
        `Influx connection updated (url ${url || "—"}, org ${org || "—"}, bucket ${bucket || "—"}${token ? ", token set" : ""})`
      );
      await interaction.reply({
        embeds: [
          makeEmbed(
            influxActive()
              ? "InfluxDB connection saved — exporter is **live**. Use *Send test point* to verify end-to-end."
              : "InfluxDB connection saved — exporter still inactive (need url + org + bucket + token, and the Influx toggle on).",
            influxActive() ? COLORS.success : COLORS.warn
          ),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_intercom_secrets_modal") {
      const accessToken = interaction.fields.getTextInputValue("access_token").trim();
      const clientSecret = interaction.fields.getTextInputValue("client_secret").trim();

      await this.settingsStore.updateIntercom({
        intercomAccessToken: accessToken,
        intercomClientSecret: clientSecret || null,
      });
      // Deliberately no secret values in the audit line.
      this.auditConfig(
        interaction,
        `Intercom secrets updated (access token ${accessToken ? "set" : "cleared"}, client secret ${clientSecret ? "set" : "off"})`
      );
      await interaction.reply({
        embeds: [
          makeEmbed(
            [
              "Intercom secrets saved — probing the workspace…",
              clientSecret
                ? `Point the app's webhook at \`POST <public-url>/intercom/webhook\` and subscribe at least: ${INTERCOM_WEBHOOK_TOPICS.join(", ")}. Extra subscriptions are ignored at the door.`
                : "No client secret set — the inbound webhook endpoint stays disabled (needed for bi mode and the push-mode agent warning).",
            ].join("\n"),
            COLORS.success
          ),
        ],
        flags: 64,
      });

      // Post-save probe: verify the token, seed the fallback admin from the
      // token's owner, sanity-check the region, and auto-detect Operator/Fin.
      void (async () => {
        const notes: string[] = [];
        try {
          const me = await this.intercomClient.getMe();
          if (!this.settingsStore.intercomAdminId()) {
            await this.settingsStore.updateIntercom({ intercomAdminId: me.id });
            notes.push(`Fallback admin seeded from the token owner: **${me.name ?? me.id}**.`);
          }
          const region = this.settingsStore.intercomRegion();
          if (me.region && me.region.toLowerCase() !== region) {
            notes.push(`⚠️ Workspace region is **${me.region.toUpperCase()}** but the bridge is set to **${region.toUpperCase()}** — fix it via the Region button.`);
          }
        } catch (e) {
          notes.push(`⚠️ Token check failed: ${e instanceof Error ? e.message : e}`);
        }
        try {
          const admins = await this.intercomClient.listAdmins();
          const operator = admins.find((a) => /^(operator|fin)(\s|$)/i.test(a.name ?? ""));
          if (operator) {
            await this.settingsStore.updateIntercom({ intercomOperatorAdminId: operator.id });
            notes.push(`Operator/Fin detected: **${operator.name}** (\`${operator.id}\`) — the bridge authors as it (no seat needed).`);
          } else {
            notes.push("Operator/Fin bot not found in the admin list — the bridge authors as the fallback admin.");
          }
        } catch {
          // Token check above already reported the failure.
        }
        if (notes.length > 0) {
          await interaction.followUp({ embeds: [makeEmbed(notes.join("\n"), COLORS.neutral)], flags: 64 }).catch(() => {});
        }
      })();
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
      this.auditConfig(interaction, `Ticket limits → max ${max || "∞"} open, ${cooldown || "no"} min cooldown`);
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
      const velocityUserRaw = interaction.fields.getTextInputValue("velocity_user").trim();
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
      const velocityUserNum = velocityUserRaw ? Number(velocityUserRaw) : null;
      if (velocityUserRaw && (!Number.isInteger(velocityUserNum!) || velocityUserNum! < 1)) {
        await interaction.reply({ embeds: [makeEmbed("Max refunds per 24h per user must be a positive whole number (or blank to disable).", COLORS.danger)], flags: 64 });
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
        refundMaxPer24hPerUser: velocityUserNum,
        refundMinMemberAgeDays: memberAgeNum,
      });
      this.auditConfig(interaction, "Refund guardrails updated");
      await interaction.reply({ embeds: [makeEmbed("Refund guardrails updated.", COLORS.success)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_disputes_limits_modal") {
      const daysRaw = interaction.fields.getTextInputValue("reminder_days").trim();
      const urgentRaw = interaction.fields.getTextInputValue("urgent_hours").trim();
      const warnRaw = interaction.fields.getTextInputValue("warn_pct").trim();
      const criticalRaw = interaction.fields.getTextInputValue("critical_pct").trim();

      const days = Number(daysRaw);
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        await interaction.reply({ embeds: [makeEmbed("Reminder lead must be a whole number of days between 1 and 30.", COLORS.danger)], flags: 64 });
        return;
      }
      const urgentHours = Number(urgentRaw);
      if (!Number.isInteger(urgentHours) || urgentHours < 1 || urgentHours > 168) {
        await interaction.reply({ embeds: [makeEmbed("The urgent window must be a whole number of hours between 1 and 168.", COLORS.danger)], flags: 64 });
        return;
      }
      const warn = Number(warnRaw);
      const critical = Number(criticalRaw);
      if (!Number.isFinite(warn) || warn <= 0 || !Number.isFinite(critical) || critical <= 0) {
        await interaction.reply({ embeds: [makeEmbed("Thresholds must be positive percentages, e.g. `0.5` and `0.9`.", COLORS.danger)], flags: 64 });
        return;
      }
      if (warn >= critical) {
        await interaction.reply({ embeds: [makeEmbed("The warn threshold must be LOWER than the critical threshold.", COLORS.danger)], flags: 64 });
        return;
      }

      await this.settingsStore.updateDisputes({
        disputeReminderDays: days,
        disputeUrgentHours: urgentHours,
        disputeRatioWarnPct: warn,
        disputeRatioCriticalPct: critical,
      });
      this.auditConfig(
        interaction,
        `Dispute thresholds updated → remind ${days}d, urgent <${urgentHours}h, warn ${warn}%, critical ${critical}%`
      );
      await interaction.reply({ embeds: [makeEmbed("Dispute thresholds updated.", COLORS.success)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_stripe_webhook_url_modal") {
      const raw = interaction.fields.getTextInputValue("url").trim();
      let origin: string | null = null;
      if (raw) {
        try {
          origin = new URL(raw).origin;
        } catch {
          await interaction.reply({
            embeds: [makeEmbed("Enter a valid URL like `https://bot.example.com`, or leave blank.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
      }
      await interaction.deferReply({ flags: 64 });
      await this.settingsStore.updateStripeWebhook({ publicBaseUrl: origin });
      this.auditConfig(interaction, `Stripe webhook public URL → ${origin ?? "callback-url fallback"}`);
      if (this.settingsStore.stripeWebhookEnabled()) {
        await this.stripeWebhook.ensureEndpoint().catch(() => {});
      }
      await interaction.editReply({
        embeds: [
          makeEmbed(`Public URL ${origin ? `set to \`${origin}\`` : "cleared (using callback URL)"}.`, COLORS.success),
        ],
      });
      return;
    }

    if (interaction.customId.startsWith("config_tier_rename_modal:")) {
      const tierId = interaction.customId.split(":")[1];
      const tier = this.tierStore.byId(tierId);
      if (!tier) {
        await interaction.reply({ embeds: [makeEmbed("That tier no longer exists.", COLORS.warn)], flags: 64 });
        return;
      }
      const name = interaction.fields.getTextInputValue("name").trim();
      if (!name) {
        await interaction.reply({ embeds: [makeEmbed("Tier name is required.", COLORS.danger)], flags: 64 });
        return;
      }
      await this.tierStore.rename(tier.id, name);
      this.auditConfig(interaction, `Escalation tier renamed → ${tier.name} → ${name}`);
      await interaction.reply({ embeds: [makeEmbed(`Tier renamed to **${name}**.`, COLORS.success)], flags: 64 });
      return;
    }

    if (interaction.customId === "config_inactivity_opts_modal") {
      const agentDays = Number.parseInt(interaction.fields.getTextInputValue("agent_days").trim(), 10);
      const customerDays = Number.parseInt(interaction.fields.getTextInputValue("customer_days").trim(), 10);
      const nags = Number.parseInt(interaction.fields.getTextInputValue("nags").trim(), 10);
      const inRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
      if (!inRange(agentDays, 1, 30) || !inRange(customerDays, 1, 30) || !inRange(nags, 1, 10)) {
        await interaction.reply({
          embeds: [makeEmbed("Days must be 1-30 and nags 1-10 (whole numbers).", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await this.settingsStore.updateInactivity({
        inactivityAgentWaitDays: agentDays,
        inactivityCustomerWaitDays: customerDays,
        inactivityNagsBeforeClose: nags,
      });
      this.auditConfig(interaction, `Inactivity thresholds → agent ${agentDays}d, customer ${customerDays}d, close after ${nags} nag(s)`);
      await interaction.reply({
        embeds: [
          makeEmbed(
            `Inactivity thresholds saved — agent-idle ${agentDays}d, customer-idle ${customerDays}d, auto-close after ${nags} unanswered nag(s). Applies on the next sweep.`,
            COLORS.success
          ),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_ai_model_modal") {
      const model = interaction.fields.getTextInputValue("model").trim();
      if (!model) {
        await interaction.reply({ embeds: [makeEmbed("Model name is required.", COLORS.danger)], flags: 64 });
        return;
      }
      await this.settingsStore.updateGeneral({ aiModel: model });
      this.auditConfig(interaction, `AI model → \`${model}\``);
      await interaction.reply({
        embeds: [makeEmbed(`AI model updated — \`${model}\`. Applies to the next evidence draft.`, COLORS.success)],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_ai_perf_modal") {
      const effortAsk = interaction.fields.getTextInputValue("effort_ask").trim().toLowerCase();
      const budgetAsk = Number(interaction.fields.getTextInputValue("budget_ask").trim());
      const validEfforts = ["low", "medium", "high", "max"];
      if (!validEfforts.includes(effortAsk)) {
        await interaction.reply({
          embeds: [makeEmbed("Effort must be one of: low, medium, high, max.", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      const okBudget = (n: number) => Number.isFinite(n) && n >= 0.05 && n <= 50;
      if (!okBudget(budgetAsk)) {
        await interaction.reply({
          embeds: [makeEmbed("Budget must be a number between 0.05 and 50 (USD per run).", COLORS.danger)],
          flags: 64,
        });
        return;
      }
      await this.settingsStore.updateGeneral({
        aiEffortAsk: effortAsk,
        aiMaxBudgetUsdAsk: budgetAsk,
      });
      this.auditConfig(interaction, `AI speed limits → effort ${effortAsk}, ≤ $${budgetAsk}/run`);
      await interaction.reply({
        embeds: [
          makeEmbed(`AI speed limits updated — effort \`${effortAsk}\`, ≤ $${budgetAsk}/run. Applies to the next evidence draft.`, COLORS.success),
        ],
        flags: 64,
      });
      return;
    }

    if (interaction.customId === "config_kb_interval_modal") {
      const hoursRaw = interaction.fields.getTextInputValue("hours").trim();
      const hours = /^\d+$/.test(hoursRaw) ? Number(hoursRaw) : NaN;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
        await interaction.reply({ embeds: [makeEmbed("Enter a valid number of hours (1-168).", COLORS.danger)], flags: 64 });
        return;
      }
      await this.settingsStore.updateKnowledge({ kbRefreshIntervalHours: hours });
      this.auditConfig(interaction, `KB refresh interval → ${hours}h`);
      await interaction.reply({
        embeds: [makeEmbed(`Knowledge base will refresh every ${hours}h.`, COLORS.success)],
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
        this.auditConfig(interaction, `Status tag added → ${emoji} ${label}`);
        await interaction.reply({ embeds: [makeEmbed(`Added ${emoji} ${label}.`, COLORS.success)], flags: 64 });
      } else if (interaction.customId.startsWith("config_tag_edit_modal:")) {
        const tagId = interaction.customId.split(":")[1];
        await this.settingsStore.editTag(tagId, {
          emoji,
          label,
          ...(reminderDays != null ? { reminderDays } : {}),
          autoCloseAfter,
        });
        this.auditConfig(interaction, `Status tag edited → ${emoji} ${label}`);
        await interaction.reply({ embeds: [makeEmbed(`Updated ${emoji} ${label}.`, COLORS.success)], flags: 64 });
      }
    } catch (error) {
      await interaction.reply({ embeds: [makeEmbed((error as Error).message || "Failed to save the tag.", COLORS.danger)], flags: 64 });
    }
  }

  private async handleTagDelete(interaction: ButtonInteraction, tagId: string): Promise<void> {
    await interaction.deferUpdate();
    try {
      const tag = this.settingsStore.tagById(tagId);
      // Tickets on the deleted tag are reassigned to the initial tag inside
      // removeTag; titles no longer encode tags, so no renames.
      await this.settingsStore.removeTag(tagId);
      if (tag) this.auditConfig(interaction, `Status tag deleted → ${tag.emoji} ${tag.label}`);
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

  private async handleConfigTierPick(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    const tier = this.tierStore.byId(interaction.values[0]);
    if (!tier) {
      await interaction.update(this.buildEscalationPanel());
      return;
    }
    await interaction.update(this.buildTierEditPanel(tier));
  }

  private async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "config_tier_add_role" && interaction.customId !== "config_disputes_urgent_role") return;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    const roleId = interaction.values[0];
    if (interaction.customId === "config_disputes_urgent_role") {
      await this.settingsStore.updateDisputes({ disputeUrgentRoleId: roleId });
      this.auditConfig(interaction, `Urgent dispute role → <@&${roleId}>`);
      await interaction.update(this.buildDisputesConfigPanel());
      return;
    }
    const role = await interaction.guild?.roles.fetch(roleId).catch(() => null);
    // The tier name defaults to the Discord role name; rename it afterwards if needed.
    const tier = await this.tierStore.add(role?.name ?? "Tier", roleId);
    this.auditConfig(interaction, `Escalation tier added → ${tier.name} (<@&${roleId}>)`);
    await interaction.update(this.buildEscalationPanel());
  }

  private async handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
    if (
      interaction.customId !== "config_set_channel" &&
      interaction.customId !== "config_set_billingauditchannel" &&
      interaction.customId !== "config_set_auditlogchannel"
    )
      return;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }
    if (interaction.customId === "config_set_billingauditchannel") {
      await this.settingsStore.updateBilling({ billingAuditChannelId: interaction.values[0] });
      this.auditConfig(interaction, `Billing audit channel → <#${interaction.values[0]}>`);
      await interaction.update(this.buildBillingPanel());
      return;
    }
    if (interaction.customId === "config_set_auditlogchannel") {
      await this.settingsStore.updateGeneral({ auditLogChannelId: interaction.values[0] });
      // Naturally the first entry in the newly configured channel.
      this.auditConfig(interaction, `Audit log channel → <#${interaction.values[0]}>`);
      await interaction.update(this.buildAuditPanel());
      return;
    }
    await this.settingsStore.updateGeneral({ threadsChannelId: interaction.values[0] });
    this.auditConfig(interaction, `Threads channel → <#${interaction.values[0]}>`);
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
      log.child("discord:backfill").error("ticket backfill failed", error);
      await interaction.editReply({ embeds: [makeEmbed("Backfill failed; you can try again from /config.", COLORS.danger)] });
    }
  }

  // Intercom backfill: enqueue a full historical replay (ALL tickets, open and
  // closed) into the outbox. Idempotent — tickets that already have a link or a
  // pending ensure are skipped, so re-runs and crash-recovery are safe.
  // Enqueueing is DB-only and fast; the actual pushing happens in the outbox
  // drainer at its own pace. Runs after the mode switch none→push/bi and from
  // the panel's "Backfill tickets" button.
  // Preflight for enabling push/bi. Hard = the bridge cannot work (block);
  // soft = it works but a sync surface is dark (warn + confirm).
  private async intercomModePreflight(mode: "push" | "bi"): Promise<{ hard: string[]; soft: string[] }> {
    const s = this.settingsStore;
    const hard: string[] = [];
    const soft: string[] = [];

    if (!s.intercomAccessToken()) {
      hard.push("No access token (Set Secrets).");
    } else {
      try {
        await this.intercomClient.getMe();
      } catch (e) {
        hard.push(`Token probe failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    }
    if (!s.intercomAuthorAdminId()) hard.push("No authoring admin — Set Secrets auto-detects one, or use Pick Admin.");
    if (!s.intercomTicketTypeIdFor(null)) hard.push("No Default ticket type mapped (Map Ticket Types).");

    if (mode === "bi") {
      if (!s.intercomClientSecret()) {
        hard.push("No client secret — every inbound webhook would be rejected, so agent replies could never reach Discord (Set Secrets).");
      } else if (!s.intercomLastInboundAt()) {
        soft.push("No inbound webhook has ever been received — verify the Developer Hub subscription (topics + endpoint URL) before relying on agent replies reaching Discord.");
      }
      // resolvedPublicBaseUrl falls back to the POSTIZ_CALLBACK_URL origin, so
      // this only warns when the deploy has NO known external origin at all.
      if (!s.resolvedPublicBaseUrl()) {
        soft.push(
          "No public base URL known — set it via /config → Reporting & Audit → Billing → Webhooks → Set Public URL (used in the webhook endpoint instructions)."
        );
      }
      if (s.tags().filter((t) => t.intercomTicketStateId).length === 0) {
        soft.push("No status tags are mapped to Intercom ticket states — state changes will not sync (Map States).");
      }
      if (!s.closingTag()) soft.push("No closing status tag exists — an Intercom-side close cannot map back to Discord.");
      // Agent replies impersonate the agent via a channel webhook; without the
      // permission they degrade to the plainer bot embed.
      const threadsChannelId = s.threadsChannelId();
      if (threadsChannelId) {
        const channel = await this.client.channels.fetch(threadsChannelId).catch(() => null);
        const me = channel && "guild" in channel && channel.guild ? channel.guild.members.me : null;
        if (channel && me && !channel.isDMBased() && !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) {
          soft.push("Bot lacks Manage Webhooks in the threads channel — agent replies will render as plain embeds instead of under the agent's name.");
        }
      }
    }
    return { hard, soft };
  }

  // Applies a preflighted mode change + the transition side effects:
  // push→bi corrective notes, none→bi inbound gap heal.
  private async applyIntercomMode(interaction: ButtonInteraction, before: IntercomMode, mode: IntercomMode): Promise<void> {
    // When `before` began — for none→bi this is the start of the off window.
    const offSince = this.settingsStore.intercomModeChangedAt();
    await this.settingsStore.setIntercomMode(mode);
    this.auditConfig(interaction, `Intercom mode → ${mode}`);

    if (before === "push" && mode === "bi") {
      // Every push-era conversation still shows "replies are NOT delivered" —
      // now false and actively harmful.
      safe(
        this.intercomSync.enqueueBiModeCorrections().then(async (count) => {
          if (count > 0) {
            await interaction
              .followUp({
                embeds: [
                  makeEmbed(
                    `Queued corrective notes for **${count}** open conversation(s) that carry the push-mode "replies don't reach the customer" warning.`,
                    COLORS.success
                  ),
                ],
                flags: 64,
              })
              .catch(() => {});
          }
        }),
        "intercom-sync",
        { "sync.event": "bi_corrections" }
      );
    }

    if (before === "none" && mode === "bi" && offSince) {
      safe(this.runIntercomGapHeal(interaction, offSince), "discord:intercom-gap-heal", {});
    }

    if (before === "none") {
      await interaction
        .followUp({
          embeds: [
            makeEmbed(
              "Bridge enabled. Existing tickets are NOT auto-backfilled — use **Backfill tickets** (it asks for confirmation). Discord messages sent while the bridge was off were never mirrored and cannot be replayed.",
              COLORS.neutral
            ),
          ],
          flags: 64,
        })
        .catch(() => {});
    }
  }

  // none→bi gap heal: agent replies posted in Intercom during the off window
  // were dropped by the webhook handler (and Intercom does not redeliver).
  // Re-fetch parts newer than the off-window start for open bridged tickets and
  // feed them through the normal relay path — the part-id ledger makes anything
  // already relayed a no-op.
  private async runIntercomGapHeal(interaction: ButtonInteraction, offSince: Date): Promise<void> {
    const links = await this.intercomStore.listAllLinks();
    const sinceUnix = Math.floor(offSince.getTime() / 1000);
    const pause = () => new Promise((r) => setTimeout(r, 150));
    let scanned = 0;
    let conversationsWithParts = 0;
    let fetchFailures = 0;
    for (const link of links) {
      const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
      if (!ticket || ticket.closed) continue;
      scanned++;
      await pause(); // politeness pacing — this loop can hit many conversations back-to-back
      const parts = await this.intercomClient.getConversationPartsSince(link.conversationId, sinceUnix).catch(() => {
        fetchFailures++;
        return [];
      });
      if (parts.length === 0) continue;
      conversationsWithParts++;
      // Defer budget passed as exhausted: the bridge was off, so there is no
      // in-flight outbound content these parts could be echoes of.
      await this.intercomWebhook
        .process(
          "conversation.admin.replied",
          {
            topic: "conversation.admin.replied",
            data: { item: { id: link.conversationId, conversation_parts: { conversation_parts: parts } } },
          },
          Number.MAX_SAFE_INTEGER
        )
        .catch((e) => {
          log.child("discord:intercom").warn("gap heal relay failed", {
            "ticket.thread_id": link.ticketThreadId,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        });
    }
    await interaction
      .followUp({
        embeds: [
          makeEmbed(
            [
              `Gap heal: scanned ${scanned} open bridged ticket(s); ${conversationsWithParts} had Intercom activity from the off window (agent replies were relayed into their threads; notes/state changes are not healed).`,
              ...(fetchFailures > 0
                ? [`⚠️ ${fetchFailures} conversation fetch(es) failed — those threads may still be missing agent replies from the off window.`]
                : []),
            ].join("\n"),
            fetchFailures > 0 ? COLORS.warn : COLORS.neutral
          ),
        ],
        flags: 64,
      })
      .catch(() => {});
  }

  // Reset/wipe: queued Intercom events live in workflow state and survive
  // IntercomStore.resetAll(), so they must be cleared by signal. Two phases:
  // collect BEFORE resetAll (it deletes the "b" backfill markers), signal
  // AFTER resetAll (a signal-with-started workflow's state load must see the
  // post-reset DB, or it re-latches hasIntercomLink from a stale link row).
  // Targets: linked threads + backfill-enqueued threads (deepest queues, often
  // link-less) + open tickets (live outboxes) — closed unlinked tickets can't
  // hold meaningful queues.
  private async collectIntercomClearTargets(): Promise<string[]> {
    const targets = new Set<string>();
    for (const link of await this.intercomStore.listAllLinks().catch(() => [])) targets.add(link.ticketThreadId);
    for (const threadId of await this.intercomStore.listBackfillClaimedThreadIds().catch(() => [])) {
      targets.add(threadId);
    }
    for (const ticket of await this.ticketStore.listOpenWithTag().catch(() => [])) targets.add(ticket.threadId);
    return [...targets];
  }

  private async signalIntercomClear(targets: string[]): Promise<void> {
    if (!this.temporalProducers?.routable()) return;
    const CHUNK = 20;
    for (let i = 0; i < targets.length; i += CHUNK) {
      await Promise.allSettled(
        targets.slice(i, i + CHUNK).map((threadId) => this.temporalProducers!.intercomClearOutbox(threadId))
      );
    }
  }

  private async runIntercomBackfill(interaction: ButtonInteraction): Promise<void> {
    // Mode-switch calls arrive after interaction.update(); button calls after
    // deferReply(). followUp works for both.
    const progress = await interaction
      .followUp({ embeds: [makeEmbed("Intercom backfill started…", COLORS.neutral)], flags: 64 })
      .catch(() => null);
    const report = async (text: string, color: number = COLORS.neutral) => {
      if (!progress) return;
      await interaction.webhook.editMessage(progress.id, { embeds: [makeEmbed(text, color)] }).catch(() => {});
    };

    try {
      const tickets = await this.ticketStore.getAllWithTag(); // oldest first
      let enqueuedTickets = 0;
      let enqueuedEvents = 0;
      let skipped = 0;
      let processed = 0;

      for (const ticket of tickets) {
        processed++;
        if (await this.intercomStore.getLink(ticket.threadId)) {
          skipped++;
          continue;
        }

        const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
        const thread = channel?.isThread() ? (channel as ThreadChannel) : null;
        const messages = thread ? await this.fetchAllThreadMessages(thread) : null;

        // Messages-only mirroring: notes/status history stay in Discord.
        const count = await this.intercomSync.backfillTicket(ticket, messages);
        if (count != null) {
          enqueuedTickets++;
          enqueuedEvents += count;
        } else {
          skipped++;
        }

        if (processed % 10 === 0) {
          await report(`Intercom backfill: ${processed}/${tickets.length} tickets scanned, ${enqueuedEvents} events queued…`);
        }
      }

      const summary = `Intercom backfill queued **${enqueuedTickets}** ticket(s) (**${enqueuedEvents}** events), skipped ${skipped} already bridged. The ticket workflows push them in the background — watch the delivery workflows in /config → Temporal.`;
      await report(summary, COLORS.success);
      void this.audit.log({
        title: "🌉 Intercom backfill",
        severity: "info",
        actor: interaction.user.displayName,
        fields: [{ name: "Result", value: summary }],
      });
    } catch (error) {
      log.child("discord:backfill").error("intercom backfill failed", error);
      await report("Intercom backfill failed — check the logs; you can safely run it again from /config → Intercom.", COLORS.danger);
    }
  }

  // Remote wipe: hard-deletes bridge-created tickets and conversations, and
  // ARCHIVES contacts (Intercom's DELETE /contacts is a permanent delete that
  // locks the external_id for a 7-day grace — that would block the next
  // backfill; archiving stays reusable, unarchived on re-backfill). Clears the
  // local bridge state too.
  // Local state goes FIRST so the outbox drainer can't race the wipe (an
  // in-flight event would otherwise 404-self-heal and recreate objects).
  // Failures are collected and reported, never fatal — leftovers can be
  // removed by hand in Intercom.
  private async runIntercomWipe(interaction: ButtonInteraction): Promise<void> {
    const report = async (text: string, color: number = COLORS.neutral) => {
      await interaction.editReply({ embeds: [makeEmbed(text, color)] }).catch(() => {});
    };
    const pause = () => new Promise((r) => setTimeout(r, 150));
    const isGone = (e: unknown) => e instanceof IntercomHttpError && e.status === 404;

    try {
      const links = await this.intercomStore.listAllLinks();
      // Queued pre-wipe events survive resetAll (they live in workflow state)
      // and would otherwise rebuild the bridge while the wipe is deleting —
      // collect targets before resetAll, signal the clears right after.
      const clearTargets = await this.collectIntercomClearTargets();
      const local = await this.intercomStore.resetAll();
      await this.signalIntercomClear(clearTargets);
      await report(`Intercom wipe started — ${links.length} conversation(s) to delete…`);

      let tickets = 0;
      let conversations = 0;
      let contacts = 0;
      const failures: string[] = [];
      let processed = 0;

      for (const link of links) {
        processed++;
        if (link.ticketId) {
          try {
            await this.intercomClient.deleteTicket(link.ticketId);
            tickets++;
          } catch (e) {
            if (!isGone(e)) failures.push(`ticket ${link.ticketId}`);
          }
          await pause();
        }
        try {
          await this.intercomClient.deleteConversation(link.conversationId);
          conversations++;
        } catch (e) {
          if (!isGone(e)) failures.push(`conversation ${link.conversationId}`);
        }
        await pause();
        if (processed % 10 === 0) {
          await report(`Intercom wipe: ${processed}/${links.length} conversations processed…`);
        }
      }

      // Contacts last (deduped — one contact can own several conversations).
      // Archived, not deleted, so their external_ids stay reusable next backfill.
      for (const contactId of [...new Set(links.map((l) => l.contactId))]) {
        try {
          await this.intercomClient.archiveContact(contactId);
          contacts++;
        } catch (e) {
          if (!isGone(e)) failures.push(`contact ${contactId}`);
        }
        await pause();
      }

      const summary = [
        `Intercom wipe done: deleted **${tickets}** ticket(s), **${conversations}** conversation(s); archived **${contacts}** contact(s); local state cleared (${local.links} links).`,
        ...(failures.length > 0
          ? [`⚠️ ${failures.length} deletion(s) failed — remove these in Intercom by hand: ${failures.slice(0, 10).join(", ")}${failures.length > 10 ? ", …" : ""}`]
          : []),
      ].join("\n");
      await report(summary, failures.length > 0 ? COLORS.warn : COLORS.success);
      void this.audit.log({
        title: "🌉 Intercom data wiped",
        severity: "warn",
        actor: interaction.user.displayName,
        fields: [{ name: "Result", value: summary.slice(0, 1024) }],
      });
    } catch (error) {
      log.child("discord:intercom-wipe").error("wipe failed", error);
      await report(
        "Intercom wipe failed — check the logs. Local state may already be cleared; re-running the wipe only affects objects that still have links, so remaining Intercom objects must be removed by hand.",
        COLORS.danger
      );
    }
  }

  // Full history of a thread, oldest first (paged; works on archived threads).
  private async fetchAllThreadMessages(thread: ThreadChannel): Promise<BridgeSourceMessage[]> {
    const collected: BridgeSourceMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch || batch.size === 0) break;
      for (const message of batch.values()) {
        collected.push(this.toBridgeMessage(message, message.member));
      }
      before = batch.last()?.id;
      if (batch.size < 100) break;
    }
    return collected.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
              .catch((e) =>
                log.child("discord:reverify").error("reconcile failed", e, { "ticket.thread_id": ticket.threadId })
              );
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
        // closed flag can still be repaired on an unknown-emoji thread.
        const effectiveTag = derivedTag ?? ticket.statusTag;
        const desiredClosed = thread.archived || thread.locked || (effectiveTag?.closesThread ?? false);
        if (desiredClosed !== ticket.closed) {
          changes.closed = desiredClosed;
          // false→true: safe past timestamp; true→false (reopened): clear it.
          changes.closedAt = desiredClosed ? (thread.archivedAt ?? ticket.createdAt) : null;
          fixedClosed++;
        }

        if (isUndetermined) undetermined++;

        await this.ticketStore
          .reconcile(ticket.threadId, changes)
          .catch((e) =>
            log.child("discord:reverify").error("reconcile failed", e, { "ticket.thread_id": ticket.threadId })
          );
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
      log.child("discord:reverify").error("re-verify failed", error);
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
      {
        name: "charge",
        description: "Approve or deny a blocked self-service refund (support/admin only)",
        options: [
          {
            type: 1, // SUB_COMMAND
            name: "approve",
            description: "Approve the blocked refund in this ticket and execute it",
          },
          {
            type: 1, // SUB_COMMAND
            name: "deny",
            description: "Deny the blocked refund in this ticket",
            options: [
              {
                type: 3, // STRING
                name: "reason",
                description: "Reason shown to the customer",
                required: false,
                max_length: 500,
              },
            ],
          },
        ],
      },
      {
        name: "billing",
        description: "Stripe billing admin panel (admin only)",
        default_member_permissions: "8", // ADMINISTRATOR
      },
    ];

    await this.rest.put(Routes.applicationCommands(this.config.discord.clientId), {
      body: commands,
    });

    this.discordLog.info("slash commands registered", { "commands.count": commands.length });
  }

  async start(options?: { workerOnly?: boolean }): Promise<void> {
    // --worker-only: log in (Temporal activities need a live Discord client)
    // but leave slash-command registration and the HTTP surface to the main
    // bot process — this is the future split-deployment topology.
    if (options?.workerOnly) {
      await this.client.login(this.config.discord.token);
      return;
    }
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
      },
      {
        // Secret is read per request: it lives in BotSettings and can change live.
        getClientSecret: () => this.settingsStore.intercomClientSecret(),
        accept: (body) => this.intercomWebhook.accept(body),
      },
      this.intercomInboxApp
        ? {
            getClientSecret: () => this.settingsStore.intercomClientSecret(),
            initialize: (body) => this.intercomInboxApp!.initialize(body),
            submit: (body) => this.intercomInboxApp!.submit(body),
          }
        : undefined,
      {
        getSecret: () => this.stripeWebhook.getSecret(),
        constructEvent: (raw, sig, secret) => this.stripeWebhook.constructEvent(raw, sig, secret),
        handle: (event) => this.stripeWebhook.handle(event),
      }
    );
    callbackServer.start();
  }
}
