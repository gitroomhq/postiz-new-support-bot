import {
  ButtonStyle,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { safe } from "../../../util/instrument";
import { log } from "../../../util/logger";
import type { IntercomMode } from "../../../config/SettingsStore";
import {
  TICKET_ATTR_CSAT,
  TICKET_ATTR_CSAT_COMMENT,
  TICKET_ATTR_THREAD,
} from "../../../intercom/IntercomEventExecutor";
import { btn, buttonRow, backRow, selectRow, panelEmbed } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// /intercom → Bridge: mode (none/push/bi with preflight + confirm), the
// category→ticket-type and tag→state maps, team routing, snooze tag and the
// Ensure Ticket Attributes action. Logic is a verbatim port of the /config
// handlers under new icadmin_bridge_* ids; connection settings (token/secret,
// region, fallback admin, webhook info) stay in /config → Integrations.
export class BridgeHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_bridge_mode_confirm_", match: "prefix", handler: (i) => this.handleModeConfirm(i) },
    { kind: "button", id: "icadmin_bridge_mode_", match: "prefix", handler: (i) => this.handleMode(i) },
    { kind: "button", id: "icadmin_bridge_types", match: "exact", handler: async (i) => void (await i.update(this.buildTypePickPanel())) },
    { kind: "button", id: "icadmin_bridge_states", match: "exact", handler: async (i) => void (await i.update(this.buildStatePickPanel())) },
    { kind: "button", id: "icadmin_bridge_team", match: "exact", handler: (i) => this.handleTeamOpen(i) },
    { kind: "button", id: "icadmin_bridge_snooze", match: "exact", handler: (i) => this.handleSnoozeOpen(i) },
    { kind: "button", id: "icadmin_bridge_attrs", match: "exact", handler: (i) => this.handleEnsureAttrs(i) },
    { kind: "select", id: "icadmin_bridge_cat_pick", match: "exact", handler: (i) => this.handleCatPick(i) },
    { kind: "select", id: "icadmin_bridge_type_pick:", match: "prefix", handler: (i) => this.handleTypePick(i) },
    { kind: "select", id: "icadmin_bridge_status_pick", match: "exact", handler: (i) => this.handleStatusPick(i) },
    { kind: "select", id: "icadmin_bridge_state_pick:", match: "prefix", handler: (i) => this.handleStatePick(i) },
    { kind: "select", id: "icadmin_bridge_team_pick", match: "exact", handler: (i) => this.handleTeamPick(i) },
    { kind: "select", id: "icadmin_bridge_snooze_pick", match: "exact", handler: (i) => this.handleSnoozePick(i) },
  ];

  async buildPanel(): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const mode = s.intercomMode();
    const [links, totalTickets] = await Promise.all([
      this.ctx.intercomStore.countLinks().catch(() => 0),
      this.ctx.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
    ]);

    const modeLine =
      mode === "none"
        ? "**none** — bridge off, tickets stay Discord-only"
        : mode === "push"
          ? "**push** — one-way mirror Discord → Intercom"
          : "**bi** — full sync, agent replies & states come back";

    const typeMap = s.intercomTicketTypeMap();
    const categoryIds = [...this.ctx.categories().map((c) => c.id), "_default"];
    const typesLine = categoryIds.map((id) => `${id} ${typeMap[id] ? "✓" : "✗"}`).join(" · ");
    const mappedStates = s.tags().filter((t) => t.intercomTicketStateId).length;

    const embed = panelEmbed(
      "Intercom Bridge",
      [
        `**Mode:** ${modeLine}`,
        ...(s.intercomConfigured()
          ? []
          : [
              "⚠️ **Setup incomplete** — the bridge queues events but pushes nothing until token, author and a Default ticket type are set (connection settings live in /config → Integrations → Intercom).",
            ]),
        "",
        `**Ticket types:** ${typesLine}`,
        `**Status states mapped:** ${mappedStates}/${s.tags().length}`,
        `**Team routing:** ${s.intercomTeamId() ? `team \`${s.intercomTeamId()}\`` : "_unassigned_"}`,
        `**Snooze tag:** ${
          s.intercomSnoozeStatusTagId()
            ? (() => {
                const t = s.tagById(s.intercomSnoozeStatusTagId()!);
                return t ? `${t.emoji} ${t.label}` : "_deleted tag — re-pick_";
              })()
            : "_not set — Intercom snooze is ignored_"
        }`,
        `**Bridged tickets:** ${links}/${totalTickets}`,
        "",
        "Modes apply to tickets created inside Discord only; Intercom-native conversations are never touched. Connection settings (token, client secret, region, fallback admin, webhook endpoint) stay in **/config → Integrations → Intercom**.",
      ].join("\n")
    );

    const modeButtons = buttonRow(
      btn("icadmin_bridge_mode_none", "Off", mode === "none" ? ButtonStyle.Success : ButtonStyle.Secondary, mode === "none"),
      btn("icadmin_bridge_mode_push", "Push (one-way)", mode === "push" ? ButtonStyle.Success : ButtonStyle.Secondary, mode === "push"),
      btn("icadmin_bridge_mode_bi", "Bidirectional", mode === "bi" ? ButtonStyle.Success : ButtonStyle.Secondary, mode === "bi")
    );
    const setupButtons = buttonRow(
      btn("icadmin_bridge_types", "Map Ticket Types", ButtonStyle.Primary),
      btn("icadmin_bridge_states", "Map States", ButtonStyle.Primary),
      btn("icadmin_bridge_team", "Assign Team", ButtonStyle.Primary),
      btn("icadmin_bridge_snooze", "Snooze Tag", ButtonStyle.Primary),
      btn("icadmin_bridge_attrs", "Ensure Ticket Attributes", ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [modeButtons, setupButtons, backRow()] };
  }

  private async renderPanel(interaction: ButtonInteraction | StringSelectMenuInteraction, deferred = false): Promise<void> {
    const panel = await this.buildPanel();
    if (deferred) await interaction.editReply(panel);
    else await interaction.update(panel);
  }

  // ---- mode flip (verbatim port incl. preflight/confirm/gap-heal) ----

  private async handleModeConfirm(interaction: ButtonInteraction): Promise<void> {
    // Soft-warning confirm — but the panel can sit open indefinitely, so
    // re-run the HARD checks (a secret could have been cleared meanwhile).
    const mode = interaction.customId.slice("icadmin_bridge_mode_confirm_".length) as IntercomMode;
    if (mode !== "push" && mode !== "bi") return;
    await interaction.deferUpdate();
    const pf = await this.modePreflight(mode);
    if (pf.hard.length > 0) {
      await this.renderPanel(interaction, true);
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
    await this.applyMode(interaction, this.ctx.settingsStore.intercomMode(), mode);
    await this.renderPanel(interaction, true);
  }

  private async handleMode(interaction: ButtonInteraction): Promise<void> {
    const mode = interaction.customId.slice("icadmin_bridge_mode_".length) as IntercomMode;
    if (mode !== "none" && mode !== "push" && mode !== "bi") return;
    const before = this.ctx.settingsStore.intercomMode();
    if (mode === before) {
      await this.renderPanel(interaction);
      return;
    }

    if (mode === "none") {
      await this.applyMode(interaction, before, mode);
      await this.renderPanel(interaction);
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

    // Preflight (token probe hits the API — defer first). Hard failures block
    // the flip; soft ones warn and ask for an explicit confirm.
    await interaction.deferUpdate();
    const pf = await this.modePreflight(mode);
    if (pf.hard.length > 0) {
      await this.renderPanel(interaction, true);
      await interaction.followUp({
        embeds: [makeEmbed([`Cannot enable **${mode}** — fix these first:`, ...pf.hard.map((h) => `• ${h}`)].join("\n"), COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if (pf.soft.length > 0) {
      await interaction.editReply({
        embeds: [
          makeEmbed([`Preflight passed with warnings for **${mode}**:`, ...pf.soft.map((w) => `• ${w}`)].join("\n"), COLORS.warn),
        ],
        components: [
          buttonRow(
            btn(`icadmin_bridge_mode_confirm_${mode}`, `Enable ${mode === "bi" ? "Bidirectional" : "Push"} anyway`, ButtonStyle.Primary),
            btn("icadmin_hub:bridge", "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
      return;
    }
    await this.applyMode(interaction, before, mode);
    await this.renderPanel(interaction, true);
  }

  private async modePreflight(mode: "push" | "bi"): Promise<{ hard: string[]; soft: string[] }> {
    const s = this.ctx.settingsStore;
    const hard: string[] = [];
    const soft: string[] = [];

    if (!s.intercomAccessToken()) {
      hard.push("No access token (/config → Integrations → Intercom → Set Secrets).");
    } else {
      try {
        await this.ctx.intercomClient.getMe();
      } catch (e) {
        hard.push(`Token probe failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      }
    }
    if (!s.intercomAuthorAdminId()) {
      hard.push("No authoring admin — Set Secrets auto-detects one, or use Pick Admin (both in /config → Integrations → Intercom).");
    }
    if (!s.intercomTicketTypeIdFor(null)) hard.push("No Default ticket type mapped (Map Ticket Types).");

    if (mode === "bi") {
      if (!s.intercomClientSecret()) {
        hard.push("No client secret — every inbound webhook would be rejected, so agent replies could never reach Discord (Set Secrets in /config).");
      } else if (!s.intercomLastInboundAt()) {
        soft.push("No inbound webhook has ever been received — verify the Developer Hub subscription (topics + endpoint URL) before relying on agent replies reaching Discord.");
      }
      if (!s.resolvedPublicBaseUrl()) {
        soft.push("No public base URL known — set it via /config → Reporting & Audit → Billing → Webhooks → Set Public URL (used in the webhook endpoint instructions).");
      }
      if (s.tags().filter((t) => t.intercomTicketStateId).length === 0) {
        soft.push("No status tags are mapped to Intercom ticket states — state changes will not sync (Map States).");
      }
      if (!s.closingTag()) soft.push("No closing status tag exists — an Intercom-side close cannot map back to Discord.");
      // Agent replies impersonate the agent via a channel webhook; without the
      // permission they degrade to the plainer bot embed.
      const threadsChannelId = s.threadsChannelId();
      const client = this.ctx.discord()?.client;
      if (threadsChannelId && client) {
        const channel = await client.channels.fetch(threadsChannelId).catch(() => null);
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
  private async applyMode(interaction: ButtonInteraction, before: IntercomMode, mode: IntercomMode): Promise<void> {
    // When `before` began — for none→bi this is the start of the off window.
    const offSince = this.ctx.settingsStore.intercomModeChangedAt();
    await this.ctx.settingsStore.setIntercomMode(mode);
    this.ctx.auditConfig(interaction, `Intercom mode → ${mode}`);

    if (before === "push" && mode === "bi") {
      // Every push-era conversation still shows "replies are NOT delivered" —
      // now false and actively harmful.
      safe(
        this.ctx.intercomSync.enqueueBiModeCorrections().then(async (count) => {
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
      safe(this.runGapHeal(interaction, offSince), "intercom-admin:gap-heal", {});
    }

    if (before === "none") {
      await interaction
        .followUp({
          embeds: [
            makeEmbed(
              "Bridge enabled. Existing tickets are NOT auto-backfilled — use **Backfill tickets** in /intercom → Maintenance (it asks for confirmation). Discord messages sent while the bridge was off were never mirrored and cannot be replayed.",
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
  private async runGapHeal(interaction: ButtonInteraction, offSince: Date): Promise<void> {
    const links = await this.ctx.intercomStore.listAllLinks();
    const sinceUnix = Math.floor(offSince.getTime() / 1000);
    const pause = () => new Promise((r) => setTimeout(r, 150));
    let scanned = 0;
    let conversationsWithParts = 0;
    let fetchFailures = 0;
    for (const link of links) {
      const ticket = await this.ctx.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
      if (!ticket || ticket.closed) continue;
      scanned++;
      await pause(); // politeness pacing — this loop can hit many conversations back-to-back
      const parts = await this.ctx.intercomClient.getConversationPartsSince(link.conversationId, sinceUnix).catch(() => {
        fetchFailures++;
        return [];
      });
      if (parts.length === 0) continue;
      conversationsWithParts++;
      // Defer budget passed as exhausted: the bridge was off, so there is no
      // in-flight outbound content these parts could be echoes of.
      await this.ctx.intercomWebhook
        .process(
          "conversation.admin.replied",
          {
            topic: "conversation.admin.replied",
            data: { item: { id: link.conversationId, conversation_parts: { conversation_parts: parts } } },
          },
          Number.MAX_SAFE_INTEGER
        )
        .catch((e) => {
          log.child("intercom-admin").warn("gap heal relay failed", {
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

  // ---- ticket-type map ----

  // Category → Intercom ticket type mapping, step 1: pick the category.
  private buildTypePickPanel(): Panel {
    const typeMap = this.ctx.settingsStore.intercomTicketTypeMap();
    const options = [
      ...this.ctx.categories().map((c) => ({
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
      .setCustomId("icadmin_bridge_cat_pick")
      .setPlaceholder("Pick a category to map")
      .addOptions(options.slice(0, 25));
    return {
      embeds: [
        makeEmbed(
          [
            "Map each ticket category to an Intercom **ticket type**. The **Default** mapping is required — it catches tickets with no category-specific mapping.",
            '**Customer types are recommended**: the conversation is converted *into* the ticket, so agents work one unified thread instead of a back-office ticket + separate conversation. Pick a Back-office type only if you depend on Intercom\'s "ticket created" workflow trigger — it never fires for API-created Customer tickets.',
            "Remapping affects **new** tickets only (existing tickets keep the type they were created with). After switching, re-check **Ticket states** — mapped states must be valid for the new type.",
          ].join("\n"),
          COLORS.neutral
        ),
      ],
      components: [selectRow(select), backRow("icadmin_hub:bridge")],
    };
  }

  private async handleCatPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    await interaction.deferUpdate();
    try {
      const types = await this.ctx.intercomClient.listTicketTypes();
      // Both Customer and Back-office types work. Customer first: convert
      // merges conversation + ticket into ONE inbox object, while back-office
      // means a linked pair agents have to juggle.
      const rank = (t: { category?: string | null }) => {
        const c = (t.category ?? "").toLowerCase();
        return c === "customer" ? 0 : c === "back-office" ? 1 : 2;
      };
      const pool = [...types].sort((a, b) => rank(a) - rank(b));
      if (pool.length === 0) {
        await interaction.followUp({
          embeds: [makeEmbed("Intercom returned no ticket types — create one in Intercom first (Customer recommended).", COLORS.warn)],
          flags: 64,
        });
        return;
      }
      const current = this.ctx.settingsStore.intercomTicketTypeMap()[value];
      const select = new StringSelectMenuBuilder()
        .setCustomId(`icadmin_bridge_type_pick:${value}`)
        .setPlaceholder(`Ticket type for "${value}"`)
        .addOptions(
          pool.slice(0, 25).map((t) => ({
            label: t.name.slice(0, 100),
            value: t.id,
            description: `${t.category ?? "?"} · id ${t.id}`.slice(0, 100),
            default: t.id === current,
          }))
        );
      await interaction.editReply({
        embeds: [makeEmbed(`Pick the Intercom ticket type for **${value}**.`, COLORS.neutral)],
        components: [selectRow(select), backRow("icadmin_bridge_types")],
      });
    } catch (e) {
      await interaction.followUp({
        embeds: [makeEmbed(`Could not list ticket types: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
        flags: 64,
      });
    }
  }

  private async handleTypePick(interaction: StringSelectMenuInteraction): Promise<void> {
    const categoryId = interaction.customId.slice("icadmin_bridge_type_pick:".length);
    const value = interaction.values[0];
    const map = { ...this.ctx.settingsStore.intercomTicketTypeMap(), [categoryId]: value };
    await this.ctx.settingsStore.updateIntercom({ intercomTicketTypeMap: map });
    this.ctx.auditConfig(interaction, `Intercom ticket type mapping → ${categoryId} = ${value}`);
    await this.renderPanel(interaction);
  }

  // ---- state map ----

  // Status tag → Intercom ticket state mapping, step 1: pick the tag.
  private buildStatePickPanel(): Panel {
    const options = this.ctx.settingsStore.tags().map((t) => ({
      label: `${t.emoji} ${t.label}`,
      value: t.id,
      description: t.intercomTicketStateId ? `mapped → state ${t.intercomTicketStateId}` : "not mapped",
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId("icadmin_bridge_status_pick")
      .setPlaceholder("Pick a status tag to map")
      .addOptions(options.slice(0, 25));
    return {
      embeds: [
        makeEmbed(
          "Map each bot status tag to an Intercom **ticket state**. Unmapped tags leave the Intercom state untouched (the conversation still closes/reopens on closing statuses). In bi mode, agents changing the state in Intercom move the ticket to the mapped tag.",
          COLORS.neutral
        ),
      ],
      components: [selectRow(select), backRow("icadmin_hub:bridge")],
    };
  }

  private async handleStatusPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    await interaction.deferUpdate();
    try {
      const states = (await this.ctx.intercomClient.listTicketStates()).filter((s) => !s.archived);
      if (states.length === 0) {
        await interaction.followUp({
          embeds: [makeEmbed("Intercom returned no ticket states — create them in Intercom first (Settings → Ticket states).", COLORS.warn)],
          flags: 64,
        });
        return;
      }
      const tag = this.ctx.settingsStore.tagById(value);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`icadmin_bridge_state_pick:${value}`)
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
      await interaction.editReply({
        embeds: [makeEmbed(`Pick the Intercom ticket state for **${tag ? `${tag.emoji} ${tag.label}` : value}**.`, COLORS.neutral)],
        components: [selectRow(select), backRow("icadmin_bridge_states")],
      });
    } catch (e) {
      await interaction.followUp({
        embeds: [makeEmbed(`Could not list ticket states: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
        flags: 64,
      });
    }
  }

  private async handleStatePick(interaction: StringSelectMenuInteraction): Promise<void> {
    const tagId = interaction.customId.slice("icadmin_bridge_state_pick:".length);
    const value = interaction.values[0];
    const stateId = value === "__none__" ? null : value;
    await this.ctx.settingsStore.setTagIntercomState(tagId, stateId);
    const tag = this.ctx.settingsStore.tagById(tagId);
    this.ctx.auditConfig(interaction, `Intercom state mapping → ${tag ? `${tag.emoji} ${tag.label}` : tagId} = ${stateId ?? "unmapped"}`);
    await this.renderPanel(interaction);
  }

  // ---- team routing ----

  private async handleTeamOpen(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    try {
      const teams = await this.ctx.intercomClient.listTeams();
      const current = this.ctx.settingsStore.intercomTeamId();
      const select = new StringSelectMenuBuilder()
        .setCustomId("icadmin_bridge_team_pick")
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
      await interaction.editReply({
        embeds: [
          makeEmbed(
            "Every new bridged conversation **and** its ticket get assigned to this team on creation (Intercom workflow triggers can't see API-created conversations, so the bridge routes directly). Agents can reassign afterwards — the bridge never overrides.",
            COLORS.neutral
          ),
        ],
        components: [selectRow(select), backRow("icadmin_hub:bridge")],
      });
    } catch (e) {
      await interaction.followUp({
        embeds: [makeEmbed(`Could not list Intercom teams: ${e instanceof Error ? e.message : e}`, COLORS.danger)],
        flags: 64,
      });
    }
  }

  private async handleTeamPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    const teamId = value === "__none__" ? null : value;
    await this.ctx.settingsStore.updateIntercom({ intercomTeamId: teamId });
    this.ctx.auditConfig(interaction, `Intercom team routing → ${teamId ?? "unassigned"}`);
    await this.renderPanel(interaction);
  }

  // ---- snooze tag ----

  private async handleSnoozeOpen(interaction: ButtonInteraction): Promise<void> {
    const tags = this.ctx.settingsStore.tags();
    const current = this.ctx.settingsStore.intercomSnoozeStatusTagId();
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
    const select = new StringSelectMenuBuilder()
      .setCustomId("icadmin_bridge_snooze_pick")
      .setPlaceholder("Status tag applied on Intercom snooze")
      .addOptions(options);
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
      components: [selectRow(select), backRow("icadmin_hub:bridge")],
    });
  }

  private async handleSnoozePick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    const tagId = value === "__none__" ? null : value;
    await this.ctx.settingsStore.updateIntercom({ intercomSnoozeStatusTagId: tagId });
    const tag = tagId ? this.ctx.settingsStore.tagById(tagId) : undefined;
    this.ctx.auditConfig(interaction, `Intercom snooze tag → ${tag ? `${tag.emoji} ${tag.label}` : "none"}`);
    await this.renderPanel(interaction);
  }

  // ---- ensure ticket attributes (CSAT/thread — distinct from the SLA attribute) ----

  private async handleEnsureAttrs(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const typeIds = [...new Set(Object.values(this.ctx.settingsStore.intercomTicketTypeMap()))];
    if (typeIds.length === 0) {
      await interaction.editReply({ embeds: [makeEmbed("Map at least one ticket type first.", COLORS.warn)] });
      return;
    }
    const lines: string[] = [];
    const types = await this.ctx.intercomClient.listTicketTypes().catch(() => null);
    for (const typeId of typeIds) {
      const type = types?.find((t) => t.id === typeId);
      const existing = type?.attributeNames ?? [];
      const results: string[] = [];
      for (const [name, description] of [
        [TICKET_ATTR_CSAT, "CSAT rating mirrored from the Discord support bot"],
        [TICKET_ATTR_CSAT_COMMENT, "CSAT comment mirrored from the Discord support bot"],
        [TICKET_ATTR_THREAD, "Discord thread id of the bridged ticket"],
        // SLA manager: ticket-side mirror of the SLA Target conversation
        // attribute — ticket-context Workflow triggers have no channel gate,
        // so the bridged-ticket SLA Workflow branches on THIS one.
        [this.ctx.settingsStore.slaAttributeName(), "SLA target written by the support bot (SLA rules)"],
      ] as [string, string][]) {
        if (existing.includes(name)) {
          results.push(`${name} ✓`);
          continue;
        }
        try {
          await this.ctx.intercomClient.createTicketTypeAttribute(typeId, name, description);
          results.push(`${name} ✓`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // "Already exists"-shaped rejections count as success.
          results.push(/exist|taken|unique/i.test(message) ? `${name} ✓` : `${name} ✗`);
        }
      }
      // Retired attributes: the manual priority axis is removed — archive the
      // stale "Priority" attribute so old tickets stop surfacing it. Once
      // archived it no longer matches, so re-clicks are no-ops.
      for (const retired of type?.attributes.filter((a) => a.name === "Priority" && !a.archived) ?? []) {
        try {
          await this.ctx.intercomClient.archiveTicketTypeAttribute(typeId, retired.id);
          results.push(`${retired.name} archived ✓`);
        } catch {
          results.push(`${retired.name} archive ✗`);
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
              ? ["", "✗ = API call failed. Fix manually in Intercom: Settings → Ticket types → add a text attribute with exactly that name (or archive it, for retired attributes)."]
              : []),
            "",
            "Conversations are marked with a **Discord** tag automatically. For the optional `Origin` + `Discord Thread` conversation attributes — and the **SLA Target** attribute (see SLA Manager → Verify Setup) — create them once by hand (Settings → Data → Conversations); the API can't define conversation attributes.",
          ].join("\n"),
          failed ? COLORS.warn : COLORS.success
        ),
      ],
    });
  }
}
