import {
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { DEFAULT_SETTINGS_SCOPE } from "../../../config/SettingsStore";
import { btn, buttonRow, backRow, selectRow, panelEmbed } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const PAGE_SIZE = 10;
const TEAM_OPTS_MAX = 24; // leave a slot for the "Workspace default" option

// /intercom → Assignment: bot-driven balanced assignment (Intercom Advanced
// lost native workload management), configured PER TEAM. The bot balances a
// conversation within its own team's members; each team's on/off + exclusions
// + rotation come from a per-team override on top of a workspace default.
// Team-picker first: root lists every workspace team + a "Workspace default"
// entry, each opening a scoped settings panel.
export class AssignmentHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "select", id: "icadmin_assign_pick", match: "exact", handler: (i) => this.handleScopePick(i) },
    { kind: "button", id: "icadmin_assign_default", match: "exact", handler: (i) => this.handleScopeOpen(i, DEFAULT_SETTINGS_SCOPE) },
    { kind: "button", id: "icadmin_assign_teams_pg:", match: "prefix", handler: (i) => this.handleTeamsPage(i) },
    { kind: "button", id: "icadmin_assign_scope:", match: "prefix", handler: (i) => this.handleScopeOpen(i, this.scopeFrom(i.customId, 1)) },
    { kind: "button", id: "icadmin_assign_toggle:", match: "prefix", handler: (i) => this.handleToggle(i) },
    { kind: "button", id: "icadmin_assign_pool_pg:", match: "prefix", handler: (i) => this.handlePoolOpen(i) },
    { kind: "button", id: "icadmin_assign_pool:", match: "prefix", handler: (i) => this.handlePoolOpen(i) },
    { kind: "button", id: "icadmin_assign_excl:", match: "prefix", handler: (i) => this.handleExclusionOpen(i) },
    { kind: "select", id: "icadmin_assign_excl_pick:", match: "prefix", handler: (i) => this.handleExclusionPick(i) },
    { kind: "button", id: "icadmin_assign_cursor_clear:", match: "prefix", handler: (i) => this.handleCursorClear(i) },
    { kind: "button", id: "icadmin_assign_reset:", match: "prefix", handler: (i) => this.handleOverrideClear(i) },
    { kind: "button", id: "icadmin_assign_run", match: "exact", handler: (i) => this.handleRunNow(i) },
  ];

  // customId "prefix:a:b" → parts[idx].
  private scopeFrom(customId: string, idx: number): string {
    return customId.split(":")[idx] ?? DEFAULT_SETTINGS_SCOPE;
  }

  private isDefault(scope: string): boolean {
    return scope === DEFAULT_SETTINGS_SCOPE;
  }

  private teamIdOf(scope: string): string | null {
    return this.isDefault(scope) ? null : scope;
  }

  // ---- team-list root ----

  async buildPanel(page = 0): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const teams = await this.ctx.intercomClient.listTeams().catch(() => []);
    const overrides = new Map(s.listTeamOverrides().map((o) => [o.teamId, o.entry]));
    const totalPages = Math.max(1, Math.ceil(teams.length / TEAM_OPTS_MAX));
    const clamped = Math.min(Math.max(0, page), totalPages - 1);
    const slice = teams.slice(clamped * TEAM_OPTS_MAX, (clamped + 1) * TEAM_OPTS_MAX);

    const defOn = s.assignEnabled();
    const embed = panelEmbed(
      "Balanced Assignment",
      [
        `**Workspace default:** assignment ${defOn ? "on" : "off"}${s.assignExcludedAdmins().length ? ` · ${s.assignExcludedAdmins().length} excluded` : ""}`,
        `**Teams with custom settings:** ${overrides.size || "none"}`,
        "",
        "Each conversation is balanced **within its own team**: round-robin over the team's members, skipping anyone above the team's average open load, fewest-open fallback. Away teammates get no new work; a human assignment is never overridden. Teams without custom settings inherit the workspace default.",
        "",
        "Pick a team below (or the workspace default) to configure it.",
      ].join("\n")
    );
    const components: Panel["components"] = [];
    if (slice.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId("icadmin_assign_pick")
            .setPlaceholder("Configure a team…")
            .addOptions(
              slice.map((t) => {
                const ov = overrides.get(t.id);
                const eff = s.resolveAssignEnabled(t.id);
                const badge = ov ? "custom" : "inherits default";
                return {
                  label: t.name.slice(0, 100),
                  value: t.id,
                  description: `assignment ${eff ? "on" : "off"} · ${badge}`.slice(0, 100),
                };
              })
            )
        )
      );
    }
    const nav = [
      btn("icadmin_assign_default", "Workspace Default", ButtonStyle.Primary),
      btn("icadmin_assign_run", "Run Stray Sweep Now", ButtonStyle.Secondary),
      btn("icadmin_root", "Back", ButtonStyle.Secondary),
    ];
    if (totalPages > 1) {
      nav.unshift(
        btn(`icadmin_assign_teams_pg:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_assign_teams_pg:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    components.push(buttonRow(...nav));
    return { embeds: [embed], components };
  }

  private async handleTeamsPage(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const page = Number(interaction.customId.split(":")[1]) || 0;
    await interaction.editReply(await this.buildPanel(page));
  }

  private async handleScopePick(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.renderScope(interaction, interaction.values[0]);
  }

  private async handleScopeOpen(interaction: ButtonInteraction, scope: string): Promise<void> {
    await this.renderScope(interaction, scope);
  }

  // ---- per-scope settings panel ----

  private async scopeName(scope: string): Promise<string> {
    if (this.isDefault(scope)) return "Workspace default";
    const teams = await this.ctx.intercomClient.listTeams().catch(() => []);
    return teams.find((t) => t.id === scope)?.name ?? this.ctx.settingsStore.teamOverride(scope)?.teamName ?? `Team ${scope}`;
  }

  private async buildScopePanel(scope: string): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const teamId = this.teamIdOf(scope);
    const name = await this.scopeName(scope);
    const enabled = s.resolveAssignEnabled(teamId);
    const excluded = s.resolveAssignExcludedAdmins(teamId);
    const override = teamId ? s.teamOverride(teamId) : null;
    const inherits = teamId && !override;
    const embed = panelEmbed(
      `Assignment — ${name}`,
      [
        this.isDefault(scope)
          ? "The default applies to every team that has no custom settings, and is the fallback for conversations with no team."
          : `Settings for the **${name}** team.${inherits ? " _(currently inheriting the workspace default — changing anything here creates a custom override)_" : ""}`,
        "",
        `**Assignment:** ${enabled ? "**on**" : "**off**"}`,
        `**Excluded teammates:** ${excluded.length ? excluded.map((a) => a.name).join(", ") : "none"}`,
      ].join("\n")
    );
    const row1 = [
      btn(`icadmin_assign_toggle:${scope}`, `Assignment: ${enabled ? "on" : "off"}`, enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(`icadmin_assign_excl:${scope}`, "Exclusions", ButtonStyle.Secondary),
    ];
    // The workspace default has no team → no concrete pool to preview.
    if (teamId) row1.splice(1, 0, btn(`icadmin_assign_pool:${scope}`, "View Pool", ButtonStyle.Primary));
    const row2 = [btn("icadmin_hub:assign", "Back to teams", ButtonStyle.Secondary)];
    if (teamId) {
      row2.unshift(btn(`icadmin_assign_cursor_clear:${scope}`, "Reset Rotation", ButtonStyle.Secondary));
      if (override) row2.unshift(btn(`icadmin_assign_reset:${scope}`, "Revert to Default", ButtonStyle.Danger));
    }
    return { embeds: [embed], components: [buttonRow(...row1), buttonRow(...row2)] };
  }

  private async renderScope(interaction: ButtonInteraction | StringSelectMenuInteraction, scope: string): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildScopePanel(scope));
  }

  private async handleToggle(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeFrom(interaction.customId, 1);
    const teamId = this.teamIdOf(scope);
    const next = !this.ctx.settingsStore.resolveAssignEnabled(teamId);
    const name = this.isDefault(scope) ? null : await this.scopeName(scope);
    await this.ctx.settingsStore.updateAssignmentScoped(scope, name, { assignEnabled: next });
    this.ctx.auditConfig(interaction, `Assignment (${name ?? "workspace default"}) → ${next ? "on" : "off"}`);
    await interaction.update(await this.buildScopePanel(scope));
  }

  // Live pool with open counts + away/excluded badges (real teams only).
  private async handlePoolOpen(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const parts = interaction.customId.split(":");
    const scope = parts[1] ?? DEFAULT_SETTINGS_SCOPE;
    const page = Number(parts[2]) || 0;
    const teamId = this.teamIdOf(scope);
    if (!teamId) {
      await interaction.editReply(await this.buildScopePanel(scope));
      return;
    }
    const preview = await this.ctx.assignmentService.poolPreview(teamId).catch(() => null);
    if (!preview) {
      await interaction.editReply({
        embeds: [makeEmbed("Could not build this team's pool — check the Intercom connection and that the team has members.", COLORS.warn)],
        components: [backRow(`icadmin_assign_scope:${scope}`, "Back")],
      });
      return;
    }
    const members = preview.members;
    const eligible = members.filter((m) => !m.away && !m.excluded);
    const avg = eligible.length ? eligible.reduce((sum, m) => sum + m.openCount, 0) / eligible.length : 0;
    const totalPages = Math.max(1, Math.ceil(members.length / PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), totalPages - 1);
    const slice = members.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE);
    const lines = slice.map((m) => {
      const badges = [
        m.away ? "💤 away" : null,
        m.excluded ? "🚫 excluded" : null,
        !m.away && !m.excluded && m.openCount > avg ? "⤴️ above avg" : null,
        m.id === preview.cursor ? "⟳ last assigned" : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `• **${m.name}** — ${m.openCount} open${badges ? `  _(${badges})_` : ""}`;
    });
    const name = await this.scopeName(scope);
    const embed = panelEmbed(
      `Pool — ${name}`,
      [
        `Eligible: **${eligible.length}**/${members.length} · pool average **${avg.toFixed(1)}** open` +
          (preview.countsFresh ? "" : " · ⚠️ _open counts stale (no recent enforcement tick) — run the stray sweep_"),
        "",
        lines.length ? lines.join("\n") : "_pool is empty — check team membership and the exclusion list_",
        ...(totalPages > 1 ? ["", `Page ${clamped + 1}/${totalPages}`] : []),
      ].join("\n")
    );
    const nav = [btn(`icadmin_assign_scope:${scope}`, "Back", ButtonStyle.Secondary)];
    if (totalPages > 1) {
      nav.unshift(
        btn(`icadmin_assign_pool_pg:${scope}:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_assign_pool_pg:${scope}:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    await interaction.editReply({ embeds: [embed], components: [buttonRow(...nav)] });
  }

  // Exclusion editor. For a real team, options = that team's members; for the
  // workspace default, options = every admin (default exclusions apply to any
  // team that inherits them). Operator/Fin is never selectable.
  private async handleExclusionOpen(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const scope = this.scopeFrom(interaction.customId, 1);
    const teamId = this.teamIdOf(scope);
    const operator = this.ctx.settingsStore.intercomOperatorAdminId();
    const admins = await this.ctx.intercomClient.listAdmins().catch(() => null);
    if (!admins) {
      await interaction.editReply({
        embeds: [makeEmbed("Could not list teammates — check the Intercom connection.", COLORS.warn)],
        components: [backRow(`icadmin_assign_scope:${scope}`, "Back")],
      });
      return;
    }
    let candidates = admins.filter((a) => a.id !== operator);
    if (teamId) {
      const team = await this.ctx.intercomClient.getTeam(teamId).catch(() => null);
      const memberSet = new Set(team?.adminIds ?? []);
      candidates = candidates.filter((a) => memberSet.has(a.id));
    }
    candidates = candidates.slice(0, 25);
    if (!candidates.length) {
      await interaction.editReply({
        embeds: [makeEmbed("No assignable teammates found.", COLORS.warn)],
        components: [backRow(`icadmin_assign_scope:${scope}`, "Back")],
      });
      return;
    }
    const excluded = new Set(this.ctx.settingsStore.resolveAssignExcludedAdmins(teamId).map((a) => a.id));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`icadmin_assign_excl_pick:${scope}`)
      .setPlaceholder("Toggle excluded teammates…")
      .setMinValues(0)
      .setMaxValues(candidates.length)
      .addOptions(
        candidates.map((a) => ({
          label: (a.name || `Admin ${a.id}`).slice(0, 100),
          value: a.id,
          description: (a.email ?? `id ${a.id}`).slice(0, 100),
          default: excluded.has(a.id),
        }))
      );
    const name = await this.scopeName(scope);
    await interaction.editReply({
      embeds: [
        makeEmbed(
          `Select the teammates to **exclude** from bot assignment for **${name}** (bench them without touching Intercom team membership). Excluded teammates keep their existing conversations — they just receive no new bot assignments.`,
          COLORS.neutral
        ),
      ],
      components: [selectRow(select), backRow(`icadmin_assign_scope:${scope}`, "Back")],
    });
  }

  private async handleExclusionPick(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    const scope = this.scopeFrom(interaction.customId, 1);
    const chosen = new Set(interaction.values);
    const admins = await this.ctx.intercomClient.listAdmins().catch(() => []);
    const nameOf = (id: string) => admins.find((a) => a.id === id)?.name ?? id;
    const excluded = [...chosen].map((id) => ({ id, name: nameOf(id) }));
    const scopeName = this.isDefault(scope) ? null : await this.scopeName(scope);
    await this.ctx.settingsStore.updateAssignmentScoped(scope, scopeName, { assignExcludedAdmins: excluded });
    this.ctx.auditConfig(
      interaction,
      `Assignment exclusions (${scopeName ?? "workspace default"}) → ${excluded.length ? excluded.map((a) => a.name).join(", ") : "none"}`
    );
    await interaction.editReply(await this.buildScopePanel(scope));
  }

  private async handleCursorClear(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeFrom(interaction.customId, 1);
    const teamId = this.teamIdOf(scope);
    if (teamId) await this.ctx.settingsStore.setTeamRotationCursor(teamId, null);
    this.ctx.auditConfig(interaction, `Assignment rotation cursor reset (${await this.scopeName(scope)})`);
    await interaction.update(await this.buildScopePanel(scope));
  }

  private async handleOverrideClear(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeFrom(interaction.customId, 1);
    const teamId = this.teamIdOf(scope);
    if (teamId) await this.ctx.settingsStore.clearTeamAssignOverride(teamId);
    this.ctx.auditConfig(interaction, `Assignment override reverted to default (${await this.scopeName(scope)})`);
    await interaction.update(await this.buildScopePanel(scope));
  }

  private async handleRunNow(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    try {
      await this.ctx.producers.slaEnforceRunNow();
      await interaction.editReply({
        embeds: [
          makeEmbed(
            "Stray sweep triggered — the enforcement looper will assign any open, unassigned conversation to its team's pool this tick (and run the SLA clocks). Re-open a team's **View Pool** in a few seconds to see updated counts.",
            COLORS.success
          ),
        ],
      });
    } catch (e) {
      await interaction.editReply({
        embeds: [makeEmbed(`Could not trigger the sweep: ${e instanceof Error ? e.message : String(e)} (is the Temporal worker on?)`, COLORS.danger)],
      });
    }
  }
}
