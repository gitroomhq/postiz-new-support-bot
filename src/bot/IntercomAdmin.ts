import {
  PermissionFlagsBits,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../util/embeds";
import type { SettingsStore } from "../config/SettingsStore";
import type { EscalationTierStore } from "../config/EscalationTierStore";
import type { TicketStore } from "./TicketStore";
import type { AuditLogger } from "./AuditLogger";
import type { IntercomStore } from "../intercom/IntercomStore";
import type { IntercomClient } from "../intercom/IntercomClient";
import type { IntercomSyncService } from "../intercom/IntercomSyncService";
import type { IntercomWebhookHandler } from "../intercom/IntercomWebhookHandler";
import type { TemporalProducers } from "../temporal/producers";
import type { SlaRuleStore } from "../sla/SlaRuleStore";
import type { SlaService } from "../sla/SlaService";
import type { AssignmentService } from "../intercom/AssignmentService";
import { RouteTable, type AdminGateInteraction, type Panel, type RouteEntry } from "./intercomadmin/types";
import { SessionManager } from "./intercomadmin/SessionManager";
import { btn, buttonRow, panelEmbed } from "./intercomadmin/ui";
import { buildActionLevelsPanel, buildIntercomAdminsPanel } from "./configBillingActionsUi";
import type { DiscordBinding, HubContext } from "./intercomadmin/hubs/HubContext";
import { BridgeHub } from "./intercomadmin/hubs/BridgeHub";
import { SlaHub } from "./intercomadmin/hubs/SlaHub";
import { AssignmentHub } from "./intercomadmin/hubs/AssignmentHub";
import { AutomationHub } from "./intercomadmin/hubs/AutomationHub";
import { MaintenanceHub } from "./intercomadmin/hubs/MaintenanceHub";

// Admin-only /intercom panel: all behavioral Intercom configuration — bridge
// mode/maps, the SLA manager, automation (inactivity sweeper + per-tag
// reminder texts) and maintenance tools. Thin facade over RouteEntry hubs
// (the /billing pattern); connection settings (token/secret/region/fallback
// admin/webhook info) stay in /config → Integrations → Intercom.
export class IntercomAdmin {
  private sessions = new SessionManager();
  private bridge: BridgeHub;
  private sla: SlaHub;
  private assignment: AssignmentHub;
  private automation: AutomationHub;
  private maintenance: MaintenanceHub;
  private discordBinding: DiscordBinding | null = null;

  private buttonRoutes = new RouteTable<ButtonInteraction>();
  private selectRoutes = new RouteTable<StringSelectMenuInteraction>();
  private modalRoutes = new RouteTable<ModalSubmitInteraction>();

  constructor(
    private settingsStore: SettingsStore,
    tierStore: EscalationTierStore,
    categories: () => Array<{ id: string; label: string }>,
    private ticketStore: TicketStore,
    private intercomStore: IntercomStore,
    private intercomClient: IntercomClient,
    intercomSync: IntercomSyncService,
    intercomWebhook: IntercomWebhookHandler,
    private auditLogger: AuditLogger,
    producers: TemporalProducers,
    private slaRules: SlaRuleStore,
    slaService: SlaService,
    assignmentService: AssignmentService
  ) {
    const ctx: HubContext = {
      settingsStore,
      tierStore,
      categories,
      ticketStore,
      intercomStore,
      intercomClient,
      intercomSync,
      intercomWebhook,
      producers,
      slaRules,
      slaService,
      assignmentService,
      sessions: this.sessions,
      auditLogger,
      auditConfig: (interaction, change) => this.auditConfig(interaction, change),
      discord: () => this.discordBinding,
    };
    this.bridge = new BridgeHub(ctx);
    this.sla = new SlaHub(ctx);
    this.assignment = new AssignmentHub(ctx);
    this.automation = new AutomationHub(ctx);
    this.maintenance = new MaintenanceHub(ctx);

    const sources: { routes: RouteEntry[] }[] = [
      this.bridge,
      this.sla,
      this.assignment,
      this.automation,
      this.maintenance,
      { routes: this.facadeRoutes() },
    ];
    for (const source of sources) {
      for (const route of source.routes) this.register(route);
    }
  }

  // The Discord client (and DiscordBot's thread-history fetcher) exist only
  // after the bot is constructed — DiscordBot's constructor binds them here.
  bindDiscord(binding: DiscordBinding): void {
    this.discordBinding = binding;
  }

  private register(route: RouteEntry): void {
    switch (route.kind) {
      case "button":
        this.buttonRoutes.add(route.id, route.match, route.handler);
        return;
      case "select":
        this.selectRoutes.add(route.id, route.match, route.handler);
        return;
      case "modal":
        this.modalRoutes.add(route.id, route.match, route.handler);
        return;
    }
  }

  private facadeRoutes(): RouteEntry[] {
    return [
      {
        kind: "button",
        id: "icadmin_root",
        match: "exact",
        handler: async (interaction) => {
          await interaction.deferUpdate();
          await interaction.editReply(await this.buildRootPanel());
        },
      },
      // Billing-action access panels (canvas/panel authorization) — rendered
      // here with Back → icadmin_root; their INTERNAL config_bact_*/
      // config_badm_* component ids keep routing through DiscordBot's
      // existing /config handlers, so behavior is identical from both homes.
      {
        kind: "button",
        id: "icadmin_access_actions",
        match: "exact",
        handler: async (interaction) => {
          await interaction.update(buildActionLevelsPanel(this.settingsStore, 0, "icadmin_root"));
        },
      },
      {
        kind: "button",
        id: "icadmin_access_admins",
        match: "exact",
        handler: async (interaction) => {
          await interaction.deferUpdate();
          const teammates = await this.intercomClient.listAdmins().catch(() => null);
          await interaction.editReply(buildIntercomAdminsPanel(this.settingsStore, teammates, 0, "icadmin_root"));
        },
      },
      {
        kind: "button",
        id: "icadmin_hub:",
        match: "prefix",
        handler: async (interaction) => {
          const area = interaction.customId.split(":")[1];
          // Hub panels need async data — defer, then render.
          await interaction.deferUpdate();
          const panel = await this.buildHubPanel(area);
          await interaction.editReply(panel);
        },
      },
    ];
  }

  private async buildHubPanel(area: string): Promise<Panel> {
    switch (area) {
      case "bridge":
        return this.bridge.buildPanel();
      case "sla":
        return this.sla.buildPanel();
      case "assign":
        return this.assignment.buildPanel();
      case "automation":
        return this.automation.buildPanel();
      case "maintenance":
        return this.maintenance.buildPanel();
      default:
        return this.buildRootPanel();
    }
  }

  private async buildRootPanel(): Promise<Panel> {
    const s = this.settingsStore;
    const mode = s.intercomMode();
    const [links, total] = await Promise.all([
      this.intercomStore.countLinks().catch(() => 0),
      this.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
    ]);
    const embed = panelEmbed(
      "Intercom Admin",
      [
        `**Bridge mode:** ${mode}${s.intercomConfigured() ? "" : " · ⚠️ setup incomplete (/config → Integrations → Intercom)"}`,
        `**Bridged tickets:** ${links}/${total}`,
        `**SLA:** ${s.slaEnabled() ? "on" : "off"} — ${this.slaRules.count()} rule(s), ${this.slaRules.enabledCount()} enabled → default ${s.slaDefaultTarget() ? `\`${s.slaDefaultTarget()}\`` : "none"}`,
        `**Assignment:** ${s.assignEnabled() ? "on" : "off"}${s.assignExcludedAdmins().length ? ` — ${s.assignExcludedAdmins().length} excluded` : ""} · **Inactivity sweeper:** ${s.inactivityEnabled() ? "on" : "off"}`,
        "",
        "**Bridge** — mode, ticket-type & state maps, team routing, snooze tag.",
        "**SLA Manager** — rules, target clocks (first-reply/next-reply/resolution), office hours; the bot runs the SLAs natively now.",
        "**Assignment** — balanced (hybrid round-robin) assignment across the routing team, exclusions, stray sweep.",
        "**Automation** — inactivity sweeper + per-tag reminder texts.",
        "**Maintenance** — backfill, heal, re-sync, reset/wipe, panel-link revocation.",
        "**Intercom Admins / Actions** — who counts as admin for canvas/panel billing actions, and each action's access level.",
      ].join("\n")
    ).setFooter({ text: "Connection settings (token, client secret, region, fallback admin, webhook) live in /config → Integrations → Intercom" });
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("icadmin_hub:bridge", "Bridge", ButtonStyle.Primary),
          btn("icadmin_hub:sla", "SLA Manager", ButtonStyle.Primary),
          btn("icadmin_hub:assign", "Assignment", ButtonStyle.Primary),
          btn("icadmin_hub:automation", "Automation", ButtonStyle.Primary),
          btn("icadmin_hub:maintenance", "Maintenance", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("icadmin_access_admins", "Intercom Admins", ButtonStyle.Secondary),
          btn("icadmin_access_actions", "Intercom Actions", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- entry points (routed from DiscordBot by the icadmin_ prefix) ----

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    await interaction.deferReply({ flags: 64 });
    await interaction.editReply(await this.buildRootPanel());
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.buttonRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.selectRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.modalRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  // ---- helpers ----

  private auditConfig(interaction: { user: { displayName: string; displayAvatarURL(): string } }, change: string): void {
    void this.auditLogger.log({
      title: "⚙️ Config updated",
      severity: "neutral",
      actor: interaction.user.displayName,
      actorIconUrl: interaction.user.displayAvatarURL(),
      fields: [{ name: "Change", value: change }],
    });
  }

  // Catch-all for stale panels: any icadmin_ component whose id no longer
  // matches a route.
  private async replyUnknownComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<void> {
    if (!interaction.customId.startsWith("icadmin_")) return;
    await interaction
      .reply({
        embeds: [makeEmbed("This button is from an older version of the panel — run /intercom again.", COLORS.warn)],
        flags: 64,
      })
      .catch(() => undefined);
  }

  // default_member_permissions:"8" only hides the command; this runtime
  // re-check on EVERY entry point is the actual gate (channel-level permission
  // overrides can expose components to non-admins — invoker is hostile).
  private async requireAdmin(interaction: AdminGateInteraction): Promise<boolean> {
    // memberPermissions is null in DMs, so DM use is implicitly rejected too.
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    await interaction
      .reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 })
      .catch(() => undefined);
    return false;
  }
}
