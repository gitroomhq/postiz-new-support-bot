import {
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { btn, buttonRow, backRow, selectRow, panelEmbed } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const PAGE_SIZE = 10;

// /intercom → Assignment: bot-driven balanced assignment (Intercom Advanced
// lost native workload management). Pool = the routing team's members minus
// Operator/Fin minus the exclusion list; the hybrid balancer (round-robin +
// skip-above-average) routes new/stray conversations. This hub configures the
// exclusion list, shows the live pool with open counts + away badges, and
// exposes the stray-sweep Run Now (the 5-min enforcement looper).
export class AssignmentHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_assign_toggle", match: "exact", handler: (i) => this.handleToggle(i) },
    { kind: "button", id: "icadmin_assign_pool_pg:", match: "prefix", handler: (i) => this.handlePoolOpen(i, this.pageFrom(i.customId)) },
    { kind: "button", id: "icadmin_assign_pool", match: "exact", handler: (i) => this.handlePoolOpen(i, 0) },
    { kind: "button", id: "icadmin_assign_excl", match: "exact", handler: (i) => this.handleExclusionOpen(i) },
    { kind: "select", id: "icadmin_assign_excl_pick", match: "exact", handler: (i) => this.handleExclusionPick(i) },
    { kind: "button", id: "icadmin_assign_run", match: "exact", handler: (i) => this.handleRunNow(i) },
    { kind: "button", id: "icadmin_assign_cursor_clear", match: "exact", handler: (i) => this.handleCursorClear(i) },
  ];

  private pageFrom(customId: string): number {
    const n = Number(customId.split(":")[1]);
    return Number.isFinite(n) ? n : 0;
  }

  async buildPanel(): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const enabled = s.assignEnabled();
    const excluded = s.assignExcludedAdmins();
    const teamId = s.intercomTeamId();
    const embed = panelEmbed(
      "Balanced Assignment",
      [
        `**Assignment:** ${enabled ? "**on**" : "**off**"}`,
        `**Routing team:** ${teamId ? `\`${teamId}\` (set in Bridge → Assign Team)` : "⚠️ _none — set a routing team in Bridge → Assign Team first_"}`,
        `**Excluded teammates:** ${excluded.length ? excluded.map((a) => a.name).join(", ") : "_none_"}`,
        "",
        "The bot assigns new & unassigned conversations to the routing team's members using a **hybrid** rule: round-robin order, skipping anyone whose open count is above the pool average, fewest-open as a fallback. **Away teammates get no new work** (their queue is never drained); a **human assignment is never overridden**. Assignment runs 24/7 (office hours only pause SLA clocks).",
        "Triggers: new conversation/ticket, the 5-minute stray sweep (open + unassigned), and a customer reply landing on an away/removed assignee.",
      ].join("\n")
    );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("icadmin_assign_toggle", `Assignment: ${enabled ? "on" : "off"}`, enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
          btn("icadmin_assign_pool", "View Pool", ButtonStyle.Primary),
          btn("icadmin_assign_excl", "Exclusions", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn("icadmin_assign_run", "Run Stray Sweep Now", ButtonStyle.Secondary),
          btn("icadmin_assign_cursor_clear", "Reset Rotation", ButtonStyle.Secondary),
          btn("icadmin_root", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async handleToggle(interaction: ButtonInteraction): Promise<void> {
    const next = !this.ctx.settingsStore.assignEnabled();
    await this.ctx.settingsStore.updateAssignment({ assignEnabled: next });
    this.ctx.auditConfig(interaction, `Balanced assignment → ${next ? "on" : "off"}`);
    await interaction.update(await this.buildPanel());
  }

  // Live pool with open counts + away/excluded badges. One bounded fetch
  // (admins + team) via the AssignmentService snapshot — defer first.
  private async handlePoolOpen(interaction: ButtonInteraction, page: number): Promise<void> {
    await interaction.deferUpdate();
    const preview = await this.ctx.assignmentService.poolPreview().catch(() => null);
    if (!preview) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            "Could not build the pool — set a routing team in **Bridge → Assign Team** and check the Intercom connection (/config → Integrations → Intercom).",
            COLORS.warn
          ),
        ],
        components: [backRow("icadmin_hub:assign")],
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
    const embed = panelEmbed(
      "Assignment Pool",
      [
        `Eligible: **${eligible.length}**/${members.length} · pool average **${avg.toFixed(1)}** open` +
          (preview.countsFresh ? "" : " · ⚠️ _open counts stale (no recent enforcement tick) — showing 0s; run the stray sweep_"),
        "",
        lines.length ? lines.join("\n") : "_pool is empty — check team membership and the exclusion list_",
        ...(totalPages > 1 ? ["", `Page ${clamped + 1}/${totalPages}`] : []),
      ].join("\n")
    );
    const nav = [btn("icadmin_hub:assign", "Back", ButtonStyle.Secondary)];
    if (totalPages > 1) {
      nav.unshift(
        btn(`icadmin_assign_pool_pg:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_assign_pool_pg:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    await interaction.editReply({ embeds: [embed], components: [buttonRow(...nav)] });
  }

  // Toggle a teammate in/out of the exclusion list. The Operator/Fin bot is
  // never selectable (always excluded from assignment by construction).
  private async handleExclusionOpen(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const teamId = this.ctx.settingsStore.intercomTeamId();
    const [admins, team] = await Promise.all([
      this.ctx.intercomClient.listAdmins().catch(() => null),
      teamId ? this.ctx.intercomClient.getTeam(teamId).catch(() => null) : Promise.resolve(null),
    ]);
    if (!admins || !team) {
      await interaction.editReply({
        embeds: [makeEmbed("Could not list team members — set a routing team in Bridge → Assign Team and check the Intercom connection.", COLORS.warn)],
        components: [backRow("icadmin_hub:assign")],
      });
      return;
    }
    const operator = this.ctx.settingsStore.intercomOperatorAdminId();
    const excluded = new Set(this.ctx.settingsStore.assignExcludedAdmins().map((a) => a.id));
    const byId = new Map(admins.map((a) => [a.id, a]));
    const members = team.adminIds
      .filter((id) => id !== operator)
      .map((id) => byId.get(id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .slice(0, 25);
    if (!members.length) {
      await interaction.editReply({
        embeds: [makeEmbed("The routing team has no assignable members.", COLORS.warn)],
        components: [backRow("icadmin_hub:assign")],
      });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId("icadmin_assign_excl_pick")
      .setPlaceholder("Toggle excluded teammates…")
      .setMinValues(0)
      .setMaxValues(members.length)
      .addOptions(
        members.map((a) => ({
          label: (a.name || `Admin ${a.id}`).slice(0, 100),
          value: a.id,
          description: (a.email ?? `id ${a.id}`).slice(0, 100),
          default: excluded.has(a.id),
        }))
      );
    await interaction.editReply({
      embeds: [
        makeEmbed(
          "Select the teammates to **exclude** from bot assignment (bench them without touching Intercom team membership). Unselect to re-include. Excluded teammates keep their existing conversations — they just receive no new bot assignments.",
          COLORS.neutral
        ),
      ],
      components: [selectRow(select), backRow("icadmin_hub:assign")],
    });
  }

  private async handleExclusionPick(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    const chosen = new Set(interaction.values);
    // Snapshot names from the current admin list for display.
    const admins = await this.ctx.intercomClient.listAdmins().catch(() => []);
    const nameOf = (id: string) => admins.find((a) => a.id === id)?.name ?? id;
    const excluded = [...chosen].map((id) => ({ id, name: nameOf(id) }));
    await this.ctx.settingsStore.updateAssignment({ assignExcludedAdmins: excluded });
    this.ctx.auditConfig(interaction, `Assignment exclusions → ${excluded.length ? excluded.map((a) => a.name).join(", ") : "none"}`);
    await interaction.editReply(await this.buildPanel());
  }

  private async handleRunNow(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    try {
      await this.ctx.producers.slaEnforceRunNow();
      await interaction.editReply({
        embeds: [
          makeEmbed(
            "Stray sweep triggered — the enforcement looper will assign any open, unassigned conversation this tick (and run the SLA clocks). Re-open **View Pool** in a few seconds to see updated counts.",
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

  private async handleCursorClear(interaction: ButtonInteraction): Promise<void> {
    await this.ctx.settingsStore.setAssignRotationCursor(null);
    this.ctx.auditConfig(interaction, "Assignment rotation cursor reset");
    await interaction.update(await this.buildPanel());
  }
}
