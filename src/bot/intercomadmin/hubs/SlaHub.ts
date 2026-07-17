import {
  ActionRowBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { parseExpression } from "../../../sla/expression";
import { FIELD_DESCRIPTORS, conditionFor, descriptorFor, type DescriptorDeps, type DescriptorOption } from "../../../sla/descriptors";
import { SlaValidationError } from "../../../sla/SlaRuleStore";
import type { SlaSubjectRef } from "../../../sla/SlaService";
import { hasClockDurations, type ExpressionError, type SlaTargetEntry } from "../../../sla/types";
import { WEEKDAYS, isValidTimeZone, type OfficeHoursSchedule, type Weekday } from "../../../sla/businessTime";
import { SINGLETONS } from "../../../temporal/types";
import { formatDuration } from "../../../util/format";
import { DEFAULT_SETTINGS_SCOPE, type SettingsStore } from "../../../config/SettingsStore";
import { btn, buttonRow, backRow, selectRow, panelEmbed, textInput } from "../ui";
import type { IcAdminSession, Panel, RouteEntry, SlaRuleDraft } from "../types";
import type { HubContext } from "./HubContext";

const PAGE_SIZE = 10;

// /intercom → SLA Manager: the SLA engine's admin surface. Rules are a
// priority-ordered list (first match wins) whose winning target is written to
// the "SLA Target" conversation attribute; the bot IS the SLA engine
// (Advanced tier has no native SLAs): targets carry business-minute clock
// durations and the 5-min enforcement looper runs them — at-risk flips the
// "SLA Status" attribute, breach adds the tag + one internal note. Office
// hours (weekly schedule + holidays) pause the clocks. Authoring: guided
// builder (selects/modals) AND a text-expression escape hatch with a
// validation-error re-prompt loop.
export class SlaHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    // rules list + detail
    { kind: "button", id: "icadmin_sla_rules_pg:", match: "prefix", handler: (i) => this.handleRulesPage(i) },
    { kind: "button", id: "icadmin_sla_rules", match: "exact", handler: (i) => this.handleRulesOpen(i) },
    { kind: "button", id: "icadmin_sla_rule_toggle:", match: "prefix", handler: (i) => this.handleRuleToggle(i) },
    { kind: "button", id: "icadmin_sla_rule_up:", match: "prefix", handler: (i) => this.handleRuleMove(i, -1) },
    { kind: "button", id: "icadmin_sla_rule_dn:", match: "prefix", handler: (i) => this.handleRuleMove(i, 1) },
    { kind: "button", id: "icadmin_sla_rule_edit:", match: "prefix", handler: (i) => this.handleRuleEdit(i) },
    { kind: "button", id: "icadmin_sla_rule_expr:", match: "prefix", handler: (i) => this.handleExprOpen(i) },
    { kind: "button", id: "icadmin_sla_rule_del_go:", match: "prefix", handler: (i) => this.handleRuleDeleteGo(i) },
    { kind: "button", id: "icadmin_sla_rule_del:", match: "prefix", handler: (i) => this.handleRuleDeleteConfirm(i) },
    { kind: "button", id: "icadmin_sla_rule:", match: "prefix", handler: (i) => this.handleRuleDetail(i) },
    { kind: "select", id: "icadmin_sla_rule_pick:", match: "prefix", handler: (i) => this.handleRulePick(i) },
    // guided builder
    { kind: "button", id: "icadmin_sla_new", match: "exact", handler: (i) => this.handleNewRule(i) },
    { kind: "button", id: "icadmin_sla_b_meta:", match: "prefix", handler: (i) => this.handleMetaOpen(i) },
    { kind: "button", id: "icadmin_sla_b_expr:", match: "prefix", handler: (i) => this.handleExprOpen(i) },
    { kind: "button", id: "icadmin_sla_b_save:", match: "prefix", handler: (i) => this.handleSave(i) },
    { kind: "button", id: "icadmin_sla_b_op:", match: "prefix", handler: (i) => this.handleOpPick(i) },
    { kind: "button", id: "icadmin_sla_b_bool:", match: "prefix", handler: (i) => this.handleBoolPick(i) },
    { kind: "button", id: "icadmin_sla_b:", match: "prefix", handler: (i) => this.handleBuilderRender(i) },
    { kind: "select", id: "icadmin_sla_b_dim:", match: "prefix", handler: (i) => this.handleDimPick(i) },
    { kind: "select", id: "icadmin_sla_b_val:", match: "prefix", handler: (i) => this.handleValuePick(i) },
    { kind: "select", id: "icadmin_sla_b_attr:", match: "prefix", handler: (i) => this.handleAttrNamePick(i) },
    { kind: "select", id: "icadmin_sla_b_rm:", match: "prefix", handler: (i) => this.handleConditionRemove(i) },
    { kind: "modal", id: "icadmin_sla_b_meta_m:", match: "prefix", handler: (i) => this.handleMetaSubmit(i) },
    { kind: "modal", id: "icadmin_sla_b_vm:", match: "prefix", handler: (i) => this.handleValueModal(i) },
    { kind: "modal", id: "icadmin_sla_expr_m:", match: "prefix", handler: (i) => this.handleExprSubmit(i) },
    // targets + default
    { kind: "button", id: "icadmin_sla_targets_pg:", match: "prefix", handler: (i) => this.handleTargetsOpen(i, this.pageFrom(i.customId)) },
    { kind: "button", id: "icadmin_sla_targets", match: "exact", handler: (i) => this.handleTargetsOpen(i, 0) },
    { kind: "button", id: "icadmin_sla_tgt_add", match: "exact", handler: (i) => this.handleTargetAddOpen(i) },
    { kind: "select", id: "icadmin_sla_tgt_rm", match: "exact", handler: (i) => this.handleTargetRemove(i) },
    { kind: "select", id: "icadmin_sla_tgt_edit", match: "exact", handler: (i) => this.handleTargetEditPick(i) },
    { kind: "modal", id: "icadmin_sla_tgt_add_m", match: "exact", handler: (i) => this.handleTargetAddSubmit(i) },
    { kind: "modal", id: "icadmin_sla_tgt_edit_m:", match: "prefix", handler: (i) => this.handleTargetEditSubmit(i) },
    { kind: "button", id: "icadmin_sla_default", match: "exact", handler: (i) => this.handleDefaultOpen(i) },
    { kind: "select", id: "icadmin_sla_default_pick", match: "exact", handler: (i) => this.handleDefaultPick(i) },
    // toggles + warn% + verify
    { kind: "button", id: "icadmin_sla_toggle", match: "exact", handler: (i) => this.handleToggle(i) },
    { kind: "button", id: "icadmin_sla_warnpct", match: "exact", handler: (i) => this.handleWarnPctOpen(i) },
    { kind: "modal", id: "icadmin_sla_warnpct_m", match: "exact", handler: (i) => this.handleWarnPctSubmit(i) },
    { kind: "button", id: "icadmin_sla_verify", match: "exact", handler: (i) => this.handleVerify(i) },
    // office hours (per-team: picker → scoped panel)
    { kind: "select", id: "icadmin_sla_hours_pick", match: "exact", handler: (i) => this.handleHoursScopePick(i) },
    { kind: "button", id: "icadmin_sla_hours_default", match: "exact", handler: (i) => this.handleHoursScopeOpen(i, DEFAULT_SETTINGS_SCOPE) },
    { kind: "button", id: "icadmin_sla_hours_teams_pg:", match: "prefix", handler: (i) => this.handleHoursTeamsPage(i) },
    { kind: "button", id: "icadmin_sla_hours_s:", match: "prefix", handler: (i) => this.handleHoursScopeOpen(i, this.scopeSeg(i.customId, 1)) },
    { kind: "button", id: "icadmin_sla_hours_toggle:", match: "prefix", handler: (i) => this.handleHoursToggle(i) },
    { kind: "button", id: "icadmin_sla_hours_tz:", match: "prefix", handler: (i) => this.handleHoursTzOpen(i) },
    { kind: "modal", id: "icadmin_sla_hours_tz_m:", match: "prefix", handler: (i) => this.handleHoursTzSubmit(i) },
    { kind: "select", id: "icadmin_sla_hours_day:", match: "prefix", handler: (i) => this.handleHoursDayPick(i) },
    { kind: "modal", id: "icadmin_sla_hours_day_m:", match: "prefix", handler: (i) => this.handleHoursDaySubmit(i) },
    { kind: "button", id: "icadmin_sla_hours_hol_add:", match: "prefix", handler: (i) => this.handleHolidayAddOpen(i) },
    { kind: "modal", id: "icadmin_sla_hours_hol_add_m:", match: "prefix", handler: (i) => this.handleHolidayAddSubmit(i) },
    { kind: "select", id: "icadmin_sla_hours_hol_rm:", match: "prefix", handler: (i) => this.handleHolidayRemove(i) },
    { kind: "button", id: "icadmin_sla_hours_hol_pg:", match: "prefix", handler: (i) => this.handleHoursScopedPage(i) },
    { kind: "button", id: "icadmin_sla_hours_reset:", match: "prefix", handler: (i) => this.handleHoursOverrideClear(i) },
    { kind: "button", id: "icadmin_sla_hours", match: "exact", handler: (i) => this.handleHoursTeamsOpen(i, 0) },
    // pin + preview
    { kind: "button", id: "icadmin_sla_pin", match: "exact", handler: (i) => this.handlePinOpen(i) },
    { kind: "button", id: "icadmin_sla_unpin:", match: "prefix", handler: (i) => this.handleUnpin(i) },
    { kind: "button", id: "icadmin_sla_reval:", match: "prefix", handler: (i) => this.handleReval(i) },
    { kind: "select", id: "icadmin_sla_pin_set:", match: "prefix", handler: (i) => this.handlePinSet(i) },
    { kind: "modal", id: "icadmin_sla_pin_m", match: "exact", handler: (i) => this.handlePinSubmit(i) },
    { kind: "button", id: "icadmin_sla_test", match: "exact", handler: (i) => this.handlePreviewOpen(i) },
    { kind: "modal", id: "icadmin_sla_test_m", match: "exact", handler: (i) => this.handlePreviewSubmit(i) },
  ];

  // ---- hub panel ----

  async buildPanel(): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const status = this.ctx.slaService.status();
    const pinned = await this.ctx.slaService.pinnedCount().catch(() => 0);
    const targets = s.slaTargets();
    const withClocks = targets.filter(hasClockDurations).length;
    const oh = s.officeHoursEnabled() ? s.officeHours() : undefined;
    const teamHours = s.listTeamOverrides().filter((o) => o.entry.officeHoursJson || o.entry.officeHoursEnabled !== undefined).length;
    const ohLine =
      (oh === undefined
        ? "default off — clocks run 24/7"
        : oh === null
          ? "⚠️ default enabled but INVALID — clocks run 24/7 until fixed"
          : `default on — ${oh.tz}${oh.holidays.length ? ` · ${oh.holidays.length} holiday(s)` : ""}`) +
      (teamHours ? ` · ${teamHours} team override(s)` : "");
    const embed = panelEmbed(
      "SLA Manager",
      [
        `**SLA:** ${status.enabled ? "**on**" : "**off**"} (covers bridged tickets AND native conversations)`,
        `**Rules:** ${status.ruleCount} (${status.enabledRuleCount} enabled, first match wins)`,
        `**Default target:** ${status.defaultTarget ? `\`${status.defaultTarget}\`` : "_none — no-match clears the attribute_"}`,
        `**Targets:** ${targets.length} (${withClocks} with clock durations) · **Pinned:** ${pinned}`,
        `**Attributes:** \`${status.attributeName}\` (target) · \`${s.slaStatusAttributeName()}\` (ok/at_risk/breached)`,
        `**At-risk threshold:** ${s.slaWarnPct()}% of target · **Breach tag:** \`${s.slaBreachTagName()}\``,
        `**Office hours:** ${ohLine}`,
        "",
        "The bot IS the SLA engine (Advanced tier has no native SLAs): rules pick a target, targets carry business-minute clocks (first reply / next reply / resolution), and a **5-minute enforcement sweep** runs them. **At-risk** flips the status attribute only; **breach** adds the tag + one internal note per clock. All signals stay in Intercom — no Discord pings.",
        "Triggers: ticket created/mirrored, status change, customer reply, assignee change, Stripe/billing events, native conversation webhooks — plus the 30-min target sweep and the 5-min clock sweep.",
      ].join("\n")
    );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("icadmin_sla_rules", "Rules", ButtonStyle.Primary),
          btn("icadmin_sla_new", "New Rule", ButtonStyle.Primary),
          btn("icadmin_sla_default", "Default Target", ButtonStyle.Primary),
          btn("icadmin_sla_targets", "Targets", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("icadmin_sla_toggle", `SLA: ${status.enabled ? "on" : "off"}`, status.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
          btn("icadmin_sla_warnpct", `Warn at ${s.slaWarnPct()}%`, ButtonStyle.Secondary),
          btn("icadmin_sla_hours", "Office Hours", ButtonStyle.Secondary),
          btn("icadmin_sla_verify", "Verify Setup", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn("icadmin_sla_pin", "Pin Lookup", ButtonStyle.Secondary),
          btn("icadmin_sla_test", "Preview Match", ButtonStyle.Secondary),
          btn("icadmin_root", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async renderHub(interaction: ButtonInteraction | StringSelectMenuInteraction, deferred = false): Promise<void> {
    const panel = await this.buildPanel();
    if (deferred) await interaction.editReply(panel);
    else await interaction.update(panel);
  }

  // ---- rules list ----

  private buildRulesListPanel(token: string, page: number): Panel {
    const rules = this.ctx.slaRules.list();
    const totalPages = Math.max(1, Math.ceil(rules.length / PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), totalPages - 1);
    const slice = rules.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE);

    const lines = slice.map((r, i) => {
      const idx = clamped * PAGE_SIZE + i + 1;
      const expr = (r.expression || "").slice(0, 90);
      return `**${idx}.** [${r.enabled ? "ON" : "off"}] ${r.name} → \`${r.target}\`\n   \`${expr}${(r.expression?.length ?? 0) > 90 ? "…" : ""}\``;
    });
    const embed = panelEmbed(
      "SLA Rules",
      rules.length
        ? [`Priority order — the first enabled match wins. Page ${clamped + 1}/${totalPages}.`, "", ...lines].join("\n")
        : "No rules yet — use **New Rule**."
    ).setFooter({ text: `Page ${clamped + 1}/${totalPages} · ${rules.length} rule(s)` });

    const components: Panel["components"] = [];
    if (slice.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`icadmin_sla_rule_pick:${token}`)
            .setPlaceholder("Open a rule…")
            .addOptions(
              slice.map((r, i) => ({
                label: `${clamped * PAGE_SIZE + i + 1}. ${r.name}`.slice(0, 100),
                value: r.id,
                description: `→ ${r.target}${r.enabled ? "" : " (disabled)"}`.slice(0, 100),
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`icadmin_sla_rules_pg:${token}:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_sla_rules_pg:${token}:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1),
        btn("icadmin_sla_new", "New Rule", ButtonStyle.Primary),
        btn("icadmin_hub:sla", "Back", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private async handleRulesOpen(interaction: ButtonInteraction): Promise<void> {
    const token = this.ctx.sessions.newSession(interaction, { page: 0 });
    await interaction.update(this.buildRulesListPanel(token, 0));
  }

  private async handleRulesPage(interaction: ButtonInteraction): Promise<void> {
    const [token, pageRaw] = interaction.customId.slice("icadmin_sla_rules_pg:".length).split(":");
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    session.page = Math.max(0, parseInt(pageRaw, 10) || 0);
    await interaction.update(this.buildRulesListPanel(token, session.page));
  }

  // ---- rule detail ----

  private buildRuleDetailPanel(token: string, ruleId: string): Panel {
    const rules = this.ctx.slaRules.list();
    const rule = rules.find((r) => r.id === ruleId);
    if (!rule) {
      return {
        embeds: [makeEmbed("This rule no longer exists.", COLORS.warn)],
        components: [backRow("icadmin_sla_rules", "Back to rules")],
      };
    }
    const pos = rules.indexOf(rule);
    const embed = panelEmbed(
      `SLA Rule: ${rule.name}`,
      [
        `**Priority:** #${pos + 1} of ${rules.length} · **Enabled:** ${rule.enabled ? "yes" : "no"}`,
        `**Target:** \`${rule.target}\``,
        "",
        "```",
        rule.expression || "(no conditions)",
        "```",
        `Updated <t:${Math.floor(rule.updatedAt.getTime() / 1000)}:R>`,
      ].join("\n")
    );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`icadmin_sla_rule_toggle:${token}`, rule.enabled ? "Disable" : "Enable", rule.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
          btn(`icadmin_sla_rule_edit:${token}`, "Edit (Builder)", ButtonStyle.Primary),
          btn(`icadmin_sla_rule_expr:${token}`, "Edit as Expression", ButtonStyle.Primary)
        ),
        buttonRow(
          btn(`icadmin_sla_rule_up:${token}`, "Up", ButtonStyle.Secondary, pos === 0),
          btn(`icadmin_sla_rule_dn:${token}`, "Down", ButtonStyle.Secondary, pos >= rules.length - 1),
          btn(`icadmin_sla_rule_del:${token}`, "Delete", ButtonStyle.Danger),
          btn(`icadmin_sla_rules_pg:${token}:${Math.floor(pos / PAGE_SIZE)}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async handleRulePick(interaction: StringSelectMenuInteraction): Promise<void> {
    const token = interaction.customId.slice("icadmin_sla_rule_pick:".length);
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    session.ruleId = interaction.values[0];
    await interaction.update(this.buildRuleDetailPanel(token, session.ruleId));
  }

  private async handleRuleDetail(interaction: ButtonInteraction): Promise<void> {
    const token = interaction.customId.slice("icadmin_sla_rule:".length);
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.ruleId) return;
    await interaction.update(this.buildRuleDetailPanel(token, session.ruleId));
  }

  private async withRule(
    interaction: ButtonInteraction,
    prefix: string,
    work: (token: string, session: IcAdminSession, ruleId: string) => Promise<void>
  ): Promise<void> {
    const token = interaction.customId.slice(prefix.length);
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    if (!session.ruleId || !this.ctx.slaRules.byId(session.ruleId)) {
      await interaction.update(this.buildRulesListPanel(token, session.page ?? 0)).catch(() => undefined);
      return;
    }
    await work(token, session, session.ruleId);
  }

  private async handleRuleToggle(interaction: ButtonInteraction): Promise<void> {
    await this.withRule(interaction, "icadmin_sla_rule_toggle:", async (token, _s, ruleId) => {
      const rule = this.ctx.slaRules.byId(ruleId)!;
      await this.ctx.slaRules.setEnabled(ruleId, !rule.enabled);
      this.ctx.auditConfig(interaction, `SLA rule "${rule.name}" → ${!rule.enabled ? "enabled" : "disabled"}`);
      await interaction.update(this.buildRuleDetailPanel(token, ruleId));
    });
  }

  private async handleRuleMove(interaction: ButtonInteraction, dir: -1 | 1): Promise<void> {
    const prefix = dir === -1 ? "icadmin_sla_rule_up:" : "icadmin_sla_rule_dn:";
    await this.withRule(interaction, prefix, async (token, _s, ruleId) => {
      const rule = this.ctx.slaRules.byId(ruleId)!;
      await this.ctx.slaRules.move(ruleId, dir);
      this.ctx.auditConfig(interaction, `SLA rule "${rule.name}" → moved ${dir === -1 ? "up" : "down"}`);
      await interaction.update(this.buildRuleDetailPanel(token, ruleId));
    });
  }

  private async handleRuleDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
    await this.withRule(interaction, "icadmin_sla_rule_del:", async (token, _s, ruleId) => {
      const rule = this.ctx.slaRules.byId(ruleId)!;
      await interaction.update({
        embeds: [makeEmbed(`Delete SLA rule **${rule.name}** (→ \`${rule.target}\`)? Open subjects converge to the remaining rules on the next evaluation/sweep.`, COLORS.warn)],
        components: [
          buttonRow(
            btn(`icadmin_sla_rule_del_go:${token}`, "Yes, delete", ButtonStyle.Danger),
            btn(`icadmin_sla_rule:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private async handleRuleDeleteGo(interaction: ButtonInteraction): Promise<void> {
    await this.withRule(interaction, "icadmin_sla_rule_del_go:", async (token, session, ruleId) => {
      const rule = this.ctx.slaRules.byId(ruleId)!;
      await this.ctx.slaRules.remove(ruleId);
      this.ctx.auditConfig(interaction, `SLA rule "${rule.name}" deleted`);
      session.ruleId = undefined;
      await interaction.update(this.buildRulesListPanel(token, session.page ?? 0));
    });
  }

  // ---- guided builder ----

  private descriptorDeps(): DescriptorDeps {
    return {
      categories: () => this.ctx.categories().map((c) => ({ label: c.label, value: c.id })),
      statusTags: () => this.ctx.settingsStore.tags().map((t) => ({ label: `${t.emoji} ${t.label}`, value: t.id })),
      intercomTeams: async () =>
        (await this.ctx.intercomClient.listTeams().catch(() => [])).map((t) => ({ label: t.name, value: t.id, description: `id ${t.id}` })),
      intercomTicketTypes: async () =>
        (await this.ctx.intercomClient.listTicketTypes().catch(() => [])).map((t) => ({
          label: t.name,
          value: t.id,
          description: `${t.category ?? "?"} · id ${t.id}`,
        })),
      intercomTags: async () =>
        (await this.ctx.intercomClient.listTags().catch(() => [])).map((t) => ({ label: t.name, value: t.name, description: `id ${t.id}` })),
      intercomAdmins: async () =>
        (await this.ctx.intercomClient.listAdmins().catch(() => [])).map((a) => ({
          label: (a.name || `Admin ${a.id}`).slice(0, 100),
          value: a.id,
          description: (a.email ?? `id ${a.id}`).slice(0, 100),
        })),
      intercomAttributes: async () =>
        (await this.ctx.intercomClient.listConversationDataAttributes().catch(() => []))
          .filter((a) => !a.archived)
          .map((a) => ({ label: a.name.slice(0, 100), value: a.name.slice(0, 100), description: (a.dataType ?? "attribute").slice(0, 100) })),
    };
  }

  private buildBuilderPanel(token: string, draft: SlaRuleDraft, notice?: string): Panel {
    const problems: string[] = [];
    if (!draft.name.trim()) problems.push("set a name (Name & Target)");
    if (!draft.target) problems.push("pick a target (Name & Target)");
    else if (!this.ctx.settingsStore.slaTargetExists(draft.target)) problems.push(`target \`${draft.target}\` is not in the registry`);
    if (draft.conditions.length === 0) problems.push("add at least one condition");

    const conditionLines = draft.conditions.map((c, i) => `**${i + 1}.** \`${this.ctx.slaRules.renderExpression([c])}\``);
    const embed = panelEmbed(
      draft.ruleId ? `Edit Rule: ${draft.name || "(unnamed)"}` : "New SLA Rule",
      [
        `**Name:** ${draft.name.trim() || "_not set_"} · **Target:** ${draft.target ? `\`${draft.target}\`` : "_not set_"} · **Enabled:** ${draft.enabled ? "yes" : "no"}`,
        "",
        "**Conditions (AND-ed):**",
        conditionLines.length ? conditionLines.join("\n") : "_none yet_",
        ...(notice ? ["", notice] : []),
        ...(problems.length ? ["", `⚠️ Before saving: ${problems.join("; ")}.`] : []),
      ].join("\n")
    );

    const components: Panel["components"] = [
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(`icadmin_sla_b_dim:${token}`)
          .setPlaceholder("Add condition…")
          .addOptions(
            FIELD_DESCRIPTORS.map((d) => ({
              label: d.label.slice(0, 100),
              value: d.key,
              description: (d.hint ?? d.kind).slice(0, 100),
            }))
          )
      ),
    ];
    if (draft.conditions.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`icadmin_sla_b_rm:${token}`)
            .setPlaceholder("Remove condition…")
            .addOptions(
              draft.conditions.slice(0, 25).map((c, i) => ({
                label: `${i + 1}. ${this.ctx.slaRules.renderExpression([c])}`.slice(0, 100),
                value: String(i),
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`icadmin_sla_b_meta:${token}`, "Name & Target", ButtonStyle.Primary),
        btn(`icadmin_sla_b_expr:${token}`, "Edit as Expression", ButtonStyle.Secondary),
        btn(`icadmin_sla_b_save:${token}`, draft.ruleId ? "Save Changes" : "Create Rule", ButtonStyle.Success),
        btn(draft.ruleId ? `icadmin_sla_rule:${token}` : "icadmin_hub:sla", "Cancel", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private async handleNewRule(interaction: ButtonInteraction): Promise<void> {
    const targets = this.ctx.settingsStore.slaTargets();
    if (targets.length === 0) {
      await interaction.reply({
        embeds: [makeEmbed("Register at least one SLA target first (SLA Manager → Targets) — each target needs a matching Workflow branch in Intercom.", COLORS.warn)],
        flags: 64,
      });
      return;
    }
    const draft: SlaRuleDraft = { ruleId: null, name: "", target: "", enabled: true, conditions: [] };
    const token = this.ctx.sessions.newSession(interaction, { draft });
    await interaction.update(this.buildBuilderPanel(token, draft));
  }

  private async handleRuleEdit(interaction: ButtonInteraction): Promise<void> {
    await this.withRule(interaction, "icadmin_sla_rule_edit:", async (token, session, ruleId) => {
      const rule = this.ctx.slaRules.byId(ruleId)!;
      session.draft = {
        ruleId: rule.id,
        name: rule.name,
        target: rule.target,
        enabled: rule.enabled,
        conditions: (rule.conditions as SlaRuleDraft["conditions"]) ?? [],
      };
      await interaction.update(this.buildBuilderPanel(token, session.draft));
    });
  }

  private async withDraft(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    prefix: string,
    work: (token: string, session: IcAdminSession, draft: SlaRuleDraft) => Promise<void>
  ): Promise<void> {
    const token = interaction.customId.slice(prefix.length).split(":")[0];
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    if (!session.draft) {
      await interaction
        .reply({ embeds: [makeEmbed("This builder session expired — reopen the rule.", COLORS.warn)], flags: 64 })
        .catch(() => undefined);
      return;
    }
    await work(token, session, session.draft);
  }

  private async handleBuilderRender(interaction: ButtonInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b:", async (token, _s, draft) => {
      await interaction.update(this.buildBuilderPanel(token, draft));
    });
  }

  // Step 1: dimension picked → ops (single op skips ahead to the value step).
  private async handleDimPick(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_dim:", async (token, session, draft) => {
      const descriptor = descriptorFor(interaction.values[0]);
      if (!descriptor) return;
      session.pendingKey = descriptor.key;
      if (descriptor.ops.length === 1) {
        session.pendingOp = descriptor.ops[0].op;
        await this.renderValueStep(interaction, token, session);
        return;
      }
      await interaction.update({
        embeds: [makeEmbed(`**${descriptor.label}** — pick the comparison:`, COLORS.neutral)],
        components: [
          buttonRow(
            ...descriptor.ops.slice(0, 5).map((op) => btn(`icadmin_sla_b_op:${token}:${op.op}`, op.label, ButtonStyle.Primary))
          ),
          backRow(`icadmin_sla_b:${token}`, "Cancel"),
        ],
      });
    });
  }

  // Step 2: operator picked (button) → value step.
  private async handleOpPick(interaction: ButtonInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_op:", async (token, session) => {
      session.pendingOp = interaction.customId.split(":")[2];
      await this.renderValueStep(interaction, token, session);
    });
  }

  // Step 3: value UI by descriptor kind. showModal must be the FIRST response
  // for modal kinds — both button and select interactions support it.
  private async renderValueStep(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    token: string,
    session: IcAdminSession
  ): Promise<void> {
    const descriptor = descriptorFor(session.pendingKey ?? "");
    if (!descriptor || !session.pendingOp) return;

    if (descriptor.kind === "boolean") {
      await interaction.update({
        embeds: [makeEmbed(`**${descriptor.label}** — true or false?`, COLORS.neutral)],
        components: [
          buttonRow(
            btn(`icadmin_sla_b_bool:${token}:true`, "true", ButtonStyle.Success),
            btn(`icadmin_sla_b_bool:${token}:false`, "false", ButtonStyle.Secondary)
          ),
          backRow(`icadmin_sla_b:${token}`, "Cancel"),
        ],
      });
      return;
    }

    if (descriptor.kind === "number" || descriptor.kind === "text") {
      const modal = new ModalBuilder().setCustomId(`icadmin_sla_b_vm:${token}`).setTitle(descriptor.label.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("value", descriptor.kind === "number" ? "Value (number)" : "Value", {
            required: true,
            placeholder: descriptor.hint,
            maxLength: 200,
          })
        )
      );
      await interaction.showModal(modal);
      // The abandoned panel keeps its buttons; the modal submit re-renders it.
      return;
    }

    // enum kind: options may need an API call — defer, then render the select.
    await interaction.deferUpdate();
    let options: DescriptorOption[] = [];
    try {
      options = descriptor.options ? await descriptor.options(this.descriptorDeps()) : [];
    } catch {
      options = [];
    }
    if (options.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`No options available for **${descriptor.label}** (Intercom unreachable or nothing configured).`, COLORS.warn)],
        components: [backRow(`icadmin_sla_b:${token}`, "Back")],
      });
      return;
    }
    // intercom.attribute is two-step: this select picks the attribute NAME
    // (its own route), then set/not-set completes immediately while the value
    // ops open a modal.
    const isAttribute = descriptor.key === "intercom.attribute";
    await interaction.editReply({
      embeds: [
        makeEmbed(
          isAttribute ? `**${descriptor.label}** — pick the attribute:` : `**${descriptor.label}** — pick the value:`,
          COLORS.neutral
        ),
      ],
      components: [
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`${isAttribute ? "icadmin_sla_b_attr" : "icadmin_sla_b_val"}:${token}`)
            .setPlaceholder(isAttribute ? "Pick an attribute" : "Pick a value")
            .addOptions(
              options.slice(0, 25).map((o) => ({
                label: o.label.slice(0, 100),
                value: o.value.slice(0, 100),
                ...(o.description ? { description: o.description.slice(0, 100) } : {}),
              }))
            )
        ),
        backRow(`icadmin_sla_b:${token}`, "Cancel"),
      ],
    });
  }

  // intercom.attribute step 2: name picked. set/not-set needs no value; the
  // comparison ops collect it via the shared value modal.
  private async handleAttrNamePick(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_attr:", async (token, session, draft) => {
      const name = interaction.values[0];
      const op = session.pendingOp;
      if (op === "set" || op === "not_set") {
        draft.conditions.push({ dim: "intercom.attribute", name, op });
        session.pendingKey = undefined;
        session.pendingOp = undefined;
        session.pendingAttrName = undefined;
        await interaction.update(this.buildBuilderPanel(token, draft));
        return;
      }
      session.pendingAttrName = name;
      const modal = new ModalBuilder().setCustomId(`icadmin_sla_b_vm:${token}`).setTitle(`Attribute: ${name}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("value", op === "matches" ? "Regex (case-insensitive)" : "Value", { required: true, maxLength: 200 })
        )
      );
      await interaction.showModal(modal);
    });
  }

  private async appendCondition(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    token: string,
    session: IcAdminSession,
    draft: SlaRuleDraft,
    value: string
  ): Promise<void> {
    try {
      const condition = conditionFor(session.pendingKey ?? "", session.pendingOp ?? "", value);
      draft.conditions.push(condition);
      session.pendingKey = undefined;
      session.pendingOp = undefined;
      const panel = this.buildBuilderPanel(token, draft);
      if (interaction.isModalSubmit()) {
        await this.ctx.sessions.ackModal(interaction);
        await interaction.editReply(panel);
      } else {
        await interaction.update(panel);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await interaction
        .reply({ embeds: [makeEmbed(`Invalid value: ${message}`, COLORS.danger)], flags: 64 })
        .catch(() => undefined);
    }
  }

  private async handleBoolPick(interaction: ButtonInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_bool:", async (token, session, draft) => {
      await this.appendCondition(interaction, token, session, draft, interaction.customId.split(":")[2]);
    });
  }

  private async handleValuePick(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_val:", async (token, session, draft) => {
      await this.appendCondition(interaction, token, session, draft, interaction.values[0]);
    });
  }

  private async handleValueModal(interaction: ModalSubmitInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_vm:", async (token, session, draft) => {
      const value = interaction.fields.getTextInputValue("value").trim();
      if (session.pendingKey === "intercom.attribute" && session.pendingAttrName) {
        draft.conditions.push({
          dim: "intercom.attribute",
          name: session.pendingAttrName,
          op: (session.pendingOp ?? "eq") as "eq" | "neq" | "matches",
          value,
        });
        session.pendingKey = undefined;
        session.pendingOp = undefined;
        session.pendingAttrName = undefined;
        await this.ctx.sessions.ackModal(interaction);
        await interaction.editReply(this.buildBuilderPanel(token, draft));
        return;
      }
      await this.appendCondition(interaction, token, session, draft, value);
    });
  }

  private async handleConditionRemove(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_rm:", async (token, _s, draft) => {
      const idx = parseInt(interaction.values[0], 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < draft.conditions.length) draft.conditions.splice(idx, 1);
      await interaction.update(this.buildBuilderPanel(token, draft));
    });
  }

  private async handleMetaOpen(interaction: ButtonInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_meta:", async (token, _s, draft) => {
      const targets = this.ctx.settingsStore.slaTargets();
      const modal = new ModalBuilder().setCustomId(`icadmin_sla_b_meta_m:${token}`).setTitle("Rule Name & Target");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("name", "Rule name", { required: true, value: draft.name || undefined, maxLength: 100 })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("target", "SLA target (registered value)", {
            required: true,
            value: draft.target || undefined,
            placeholder: targets.map((t) => t.value).join(", ").slice(0, 100) || "add targets first",
            maxLength: 60,
          })
        )
      );
      await interaction.showModal(modal);
    });
  }

  private async handleMetaSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_meta_m:", async (token, _s, draft) => {
      const name = interaction.fields.getTextInputValue("name").trim();
      const target = interaction.fields.getTextInputValue("target").trim();
      if (!this.ctx.settingsStore.slaTargetExists(target)) {
        await interaction.reply({
          embeds: [
            makeEmbed(
              `Unknown target \`${target}\` — registered: ${this.ctx.settingsStore.slaTargets().map((t) => `\`${t.value}\``).join(", ") || "none"}. Add it under SLA Manager → Targets first.`,
              COLORS.danger
            ),
          ],
          flags: 64,
        });
        return;
      }
      draft.name = name;
      draft.target = target;
      await this.ctx.sessions.ackModal(interaction);
      await interaction.editReply(this.buildBuilderPanel(token, draft));
    });
  }

  private async handleSave(interaction: ButtonInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_b_save:", async (token, session, draft) => {
      try {
        if (draft.ruleId) {
          const updated = await this.ctx.slaRules.update(draft.ruleId, {
            name: draft.name,
            target: draft.target,
            enabled: draft.enabled,
            conditions: draft.conditions,
          });
          this.ctx.auditConfig(interaction, `SLA rule "${updated.name}" updated → \`${updated.expression}\` → ${updated.target}`);
          session.ruleId = updated.id;
          session.draft = undefined;
          await interaction.update(this.buildRuleDetailPanel(token, updated.id));
        } else {
          const created = await this.ctx.slaRules.create({
            name: draft.name,
            target: draft.target,
            enabled: draft.enabled,
            conditions: draft.conditions,
          });
          this.ctx.auditConfig(interaction, `SLA rule "${created.name}" created → \`${created.expression}\` → ${created.target}`);
          session.ruleId = created.id;
          session.draft = undefined;
          await interaction.update(this.buildRuleDetailPanel(token, created.id));
        }
      } catch (e) {
        if (e instanceof SlaValidationError) {
          await interaction.reply({ embeds: [makeEmbed(this.formatErrors(e.errors), COLORS.danger)], flags: 64 });
          return;
        }
        throw e;
      }
    });
  }

  // ---- expression escape hatch ----

  // Opens the expression modal — from the builder (draft) or straight from the
  // rule detail (seeds a draft first). Pre-fills the last failed attempt when
  // re-opened via the "Fix Expression" button.
  private async handleExprOpen(interaction: ButtonInteraction): Promise<void> {
    const prefix = interaction.customId.startsWith("icadmin_sla_rule_expr:") ? "icadmin_sla_rule_expr:" : "icadmin_sla_b_expr:";
    const token = interaction.customId.slice(prefix.length);
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session) return;
    if (!session.draft) {
      const rule = session.ruleId ? this.ctx.slaRules.byId(session.ruleId) : undefined;
      if (!rule) return;
      session.draft = {
        ruleId: rule.id,
        name: rule.name,
        target: rule.target,
        enabled: rule.enabled,
        conditions: (rule.conditions as SlaRuleDraft["conditions"]) ?? [],
      };
    }
    const current =
      session.lastExprAttempt ??
      (session.draft.conditions.length ? this.ctx.slaRules.renderExpression(session.draft.conditions) : "");
    const modal = new ModalBuilder().setCustomId(`icadmin_sla_expr_m:${token}`).setTitle("Edit Conditions as Expression");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("expression", "Conditions (AND-ed)", {
          required: true,
          style: TextInputStyle.Paragraph,
          value: current || undefined,
          placeholder: 'category=billing AND stripe.paying=true AND keyword~"refund"',
          maxLength: 2000,
        })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleExprSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    await this.withDraft(interaction, "icadmin_sla_expr_m:", async (token, session, draft) => {
      const text = interaction.fields.getTextInputValue("expression");
      const parsed = parseExpression(text, this.ctx.slaRules.buildParseContext());
      if (!parsed.ok) {
        // A modal submit cannot open another modal — store the failed text and
        // offer a "Fix Expression" button that re-opens the modal pre-filled.
        session.lastExprAttempt = text;
        await interaction.reply({
          embeds: [makeEmbed(this.formatErrors(parsed.errors, text), COLORS.danger)],
          components: [buttonRow(btn(`icadmin_sla_b_expr:${token}`, "Fix Expression", ButtonStyle.Primary))],
          flags: 64,
        });
        return;
      }
      session.lastExprAttempt = undefined;
      draft.conditions = parsed.conditions;
      await this.ctx.sessions.ackModal(interaction);
      await interaction.editReply(this.buildBuilderPanel(token, draft, "✅ Expression parsed."));
    });
  }

  private formatErrors(errors: ExpressionError[], text?: string): string {
    const lines = errors.slice(0, 8).map((e) => {
      const where = text && e.len > 0 ? ` — near \`${text.slice(e.pos, e.pos + Math.min(e.len, 30))}\`` : "";
      return `• ${e.message}${where}${e.hint ? `\n  ↳ ${e.hint}` : ""}`;
    });
    return ["Expression has problems:", ...lines].join("\n").slice(0, 4000);
  }

  // ---- target registry ----

  private pageFrom(customId: string): number {
    const raw = customId.split(":").pop() ?? "0";
    return Math.max(0, parseInt(raw, 10) || 0);
  }

  private clockSummary(t: SlaTargetEntry): string {
    const parts: string[] = [];
    if (t.firstReplyMins != null) parts.push(`FR ${formatDuration(t.firstReplyMins * 60_000)}`);
    if (t.nextReplyMins != null) parts.push(`NRT ${formatDuration(t.nextReplyMins * 60_000)}`);
    if (t.resolveMins != null) parts.push(`RES ${formatDuration(t.resolveMins * 60_000)}`);
    if (!parts.length) return "⚠️ no clocks";
    return parts.join(" · ") + (t.warnPct != null ? ` · warn ${t.warnPct}%` : "");
  }

  private buildTargetsPanel(page: number): Panel {
    const targets = this.ctx.settingsStore.slaTargets();
    const totalPages = Math.max(1, Math.ceil(targets.length / PAGE_SIZE));
    const clamped = Math.min(page, totalPages - 1);
    const slice = targets.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE);
    const defaultTarget = this.ctx.settingsStore.slaDefaultTarget();

    const lines = slice.map((t) => {
      const uses = this.ctx.slaRules.list().filter((r) => r.target === t.value).length;
      const marks = [uses ? `${uses} rule(s)` : null, defaultTarget === t.value ? "default" : null].filter(Boolean).join(" · ");
      return `• \`${t.value}\`${t.note ? ` — ${t.note}` : ""}\n   ⏱️ ${this.clockSummary(t)}${marks ? `  _(${marks})_` : ""}`;
    });
    const embed = panelEmbed(
      "SLA Targets",
      [
        "Every value the rules can write to the `SLA Target` attribute. Durations are **business minutes** for the bot-native clocks (a clock left blank is disabled for that target; a target with no clocks gets no SLA timing). Pick a target below to edit its durations.",
        "",
        lines.length ? lines.join("\n") : "_no targets yet_",
        ...(totalPages > 1 ? ["", `Page ${clamped + 1}/${totalPages}`] : []),
      ].join("\n")
    );
    const components: Panel["components"] = [];
    if (targets.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId("icadmin_sla_tgt_edit")
            .setPlaceholder("Edit a target's clocks…")
            .addOptions(slice.map((t) => ({ label: t.value, value: t.value, description: this.clockSummary(t).slice(0, 100) })))
        )
      );
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId("icadmin_sla_tgt_rm")
            .setPlaceholder("Remove a target…")
            .addOptions(slice.map((t) => ({ label: t.value, value: t.value, description: (t.note || "remove").slice(0, 100) })))
        )
      );
    }
    const nav = [
      btn("icadmin_sla_tgt_add", "Add Target", ButtonStyle.Primary),
      btn("icadmin_hub:sla", "Back", ButtonStyle.Secondary),
    ];
    if (totalPages > 1) {
      nav.unshift(
        btn(`icadmin_sla_targets_pg:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_sla_targets_pg:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    components.push(buttonRow(...nav));
    return { embeds: [embed], components };
  }

  private async handleTargetsOpen(interaction: ButtonInteraction, page: number): Promise<void> {
    await interaction.update(this.buildTargetsPanel(page));
  }

  // Discord modals cap at 5 rows — value + note + the 3 clock durations.
  private targetModalRows(prefill?: SlaTargetEntry): ActionRowBuilder<TextInputBuilder>[] {
    const minStr = (n?: number) => (n != null ? String(n) : "");
    return [
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("note", "Note (optional)", { required: false, placeholder: "VIP customers", maxLength: 100, value: prefill?.note ?? "" })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("fr", "First-reply target (business minutes, blank=off)", { required: false, placeholder: "240", maxLength: 7, value: minStr(prefill?.firstReplyMins) })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("nr", "Next-reply target (business minutes, blank=off)", { required: false, placeholder: "480", maxLength: 7, value: minStr(prefill?.nextReplyMins) })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("res", "Resolution target (business minutes, blank=off)", { required: false, placeholder: "2880", maxLength: 7, value: minStr(prefill?.resolveMins) })
      ),
    ];
  }

  // Parses a blank-or-positive-integer duration field. Returns { ok:false } on
  // a non-blank non-integer/negative value.
  private parseMins(raw: string): { ok: true; value: number | undefined } | { ok: false } {
    const s = raw.trim();
    if (!s) return { ok: true, value: undefined };
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) return { ok: false };
    return { ok: true, value: n };
  }

  private async handleTargetAddOpen(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId("icadmin_sla_tgt_add_m").setTitle("Add SLA Target");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("value", "Value (a-z A-Z 0-9 - _, max 60)", { required: true, placeholder: "VIP-4h", maxLength: 60 })
      ),
      ...this.targetModalRows()
    );
    await interaction.showModal(modal);
  }

  private async handleTargetAddSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    // Case preserved: the value must EXACTLY match the Intercom List-attribute
    // option.
    const value = interaction.fields.getTextInputValue("value").trim();
    const note = interaction.fields.getTextInputValue("note").trim();
    if (!/^[A-Za-z0-9-_]{1,60}$/.test(value)) {
      await interaction.reply({ embeds: [makeEmbed("Target values are 1-60 chars of a-z, A-Z, 0-9, - and _ (case-sensitive — must match the Intercom list option exactly).", COLORS.danger)], flags: 64 });
      return;
    }
    const targets = this.ctx.settingsStore.slaTargets();
    if (targets.some((t) => t.value === value)) {
      await interaction.reply({ embeds: [makeEmbed(`\`${value}\` is already registered.`, COLORS.warn)], flags: 64 });
      return;
    }
    const durations = this.readDurations(interaction);
    if (!durations) {
      await interaction.reply({ embeds: [makeEmbed("Durations must be blank or a whole number of minutes greater than 0.", COLORS.danger)], flags: 64 });
      return;
    }
    await this.ctx.settingsStore.updateSlaTargets([...targets, { value, note, ...durations }]);
    this.ctx.auditConfig(interaction, `SLA target added: \`${value}\` (${this.clockSummary({ value, note, ...durations })})`);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(this.buildTargetsPanel(0));
  }

  // Shared duration reader for add + edit. Returns null on any invalid field.
  private readDurations(interaction: ModalSubmitInteraction): Pick<SlaTargetEntry, "firstReplyMins" | "nextReplyMins" | "resolveMins"> | null {
    const fr = this.parseMins(interaction.fields.getTextInputValue("fr"));
    const nr = this.parseMins(interaction.fields.getTextInputValue("nr"));
    const res = this.parseMins(interaction.fields.getTextInputValue("res"));
    if (!fr.ok || !nr.ok || !res.ok) return null;
    return { firstReplyMins: fr.value, nextReplyMins: nr.value, resolveMins: res.value };
  }

  private async handleTargetEditPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    const target = this.ctx.settingsStore.slaTargets().find((t) => t.value === value);
    if (!target) {
      await interaction.reply({ embeds: [makeEmbed(`\`${value}\` no longer exists.`, COLORS.warn)], flags: 64 });
      return;
    }
    const modal = new ModalBuilder().setCustomId(`icadmin_sla_tgt_edit_m:${value}`).setTitle(`Edit ${value}`.slice(0, 45));
    modal.addComponents(...this.targetModalRows(target));
    await interaction.showModal(modal);
  }

  private async handleTargetEditSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const value = interaction.customId.slice("icadmin_sla_tgt_edit_m:".length);
    const targets = this.ctx.settingsStore.slaTargets();
    const existing = targets.find((t) => t.value === value);
    if (!existing) {
      await interaction.reply({ embeds: [makeEmbed(`\`${value}\` no longer exists.`, COLORS.warn)], flags: 64 });
      return;
    }
    const note = interaction.fields.getTextInputValue("note").trim();
    const durations = this.readDurations(interaction);
    if (!durations) {
      await interaction.reply({ embeds: [makeEmbed("Durations must be blank or a whole number of minutes greater than 0.", COLORS.danger)], flags: 64 });
      return;
    }
    const updated: SlaTargetEntry = { value, note, ...durations, ...(existing.warnPct != null ? { warnPct: existing.warnPct } : {}) };
    await this.ctx.settingsStore.updateSlaTargets(targets.map((t) => (t.value === value ? updated : t)));
    this.ctx.auditConfig(interaction, `SLA target \`${value}\` clocks → ${this.clockSummary(updated)}`);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(this.buildTargetsPanel(0));
  }

  private async handleTargetRemove(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0];
    if (this.ctx.slaRules.targetInUse(value)) {
      await interaction.reply({
        embeds: [makeEmbed(`\`${value}\` is used by a rule — repoint or delete those rules first.`, COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if (this.ctx.settingsStore.slaDefaultTarget() === value) {
      await interaction.reply({
        embeds: [makeEmbed(`\`${value}\` is the default target — change the default first.`, COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await this.ctx.settingsStore.updateSlaTargets(this.ctx.settingsStore.slaTargets().filter((t) => t.value !== value));
    this.ctx.auditConfig(interaction, `SLA target removed: \`${value}\``);
    await interaction.update(this.buildTargetsPanel(0));
  }

  // ---- default target ----

  private async handleDefaultOpen(interaction: ButtonInteraction): Promise<void> {
    const targets = this.ctx.settingsStore.slaTargets();
    const current = this.ctx.settingsStore.slaDefaultTarget();
    const select = new StringSelectMenuBuilder()
      .setCustomId("icadmin_sla_default_pick")
      .setPlaceholder("Default target when no rule matches")
      .addOptions([
        { label: "— none —", value: "__none__", description: "No match clears a previously-written value", default: !current },
        ...targets.slice(0, 24).map((t) => ({
          label: t.value,
          value: t.value,
          description: (t.note || undefined)?.slice(0, 100),
          default: t.value === current,
        })),
      ]);
    await interaction.update({
      embeds: [
        makeEmbed(
          "Written when **no rule matches** a subject. \"None\" clears a previously-written value instead (your Workflow then has no branch to apply — the current SLA stays until it finishes or an agent removes it).",
          COLORS.neutral
        ),
      ],
      components: [selectRow(select), backRow("icadmin_hub:sla")],
    });
  }

  private async handleDefaultPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const value = interaction.values[0] === "__none__" ? null : interaction.values[0];
    await this.ctx.settingsStore.updateSla({ slaDefaultTarget: value });
    this.ctx.auditConfig(interaction, `SLA default target → ${value ? `\`${value}\`` : "none"}`);
    this.ctx.slaService.onRulesChanged();
    await this.renderHub(interaction);
  }

  // ---- toggles + warn% + verify ----

  private async handleToggle(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const next = !s.slaEnabled();
    await s.updateSla({ slaEnabled: next });
    this.ctx.auditConfig(interaction, `SLA manager → ${next ? "on" : "off"}`);
    if (next) this.ctx.slaService.onRulesChanged(); // converge open subjects soon
    await this.renderHub(interaction);
  }

  private async handleWarnPctOpen(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId("icadmin_sla_warnpct_m").setTitle("At-risk threshold");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("pct", "Warn at % of target (1-99)", {
          required: true,
          placeholder: "80",
          maxLength: 2,
          value: String(this.ctx.settingsStore.slaWarnPct()),
        })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleWarnPctSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const raw = interaction.fields.getTextInputValue("pct").trim();
    const pct = Number(raw);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
      await interaction.reply({ embeds: [makeEmbed("Enter a whole number between 1 and 99.", COLORS.danger)], flags: 64 });
      return;
    }
    await this.ctx.settingsStore.updateSla({ slaWarnPct: pct });
    this.ctx.auditConfig(interaction, `SLA at-risk threshold → ${pct}% of target`);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(await this.buildPanel());
  }

  private async handleVerify(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const result = await this.ctx.slaService.verifySetup();
    // Enforcement-looper liveness — checked here because the hub has the
    // Temporal producers (SlaService deliberately doesn't).
    let looperLine = "▫️ Enforcement looper: Temporal not routable — clocks run only while the worker is active.";
    try {
      if (this.ctx.producers.routable()) {
        const client = await this.ctx.producers.service().client();
        if (client) {
          const desc = await client.workflow.getHandle(SINGLETONS.slaEnforce).describe();
          looperLine =
            desc.status.name === "RUNNING"
              ? "✅ Enforcement looper `sla-enforce` is running (5-min cadence)."
              : `❌ Enforcement looper \`sla-enforce\` status: ${desc.status.name} — toggle the Temporal worker off/on to restart it.`;
        }
      }
    } catch {
      looperLine = "❌ Enforcement looper `sla-enforce` not found — toggle the Temporal worker off/on to start it.";
    }
    const ok = result.attributeExists && result.statusAttributeExists;
    await interaction.editReply({
      embeds: [
        makeEmbed([`**SLA engine setup check:**`, "", ...result.runbook, looperLine].join("\n"), ok ? COLORS.success : COLORS.warn),
      ],
    });
  }

  // ---- office hours (per-team: picker → scoped schedule editor) ----
  // Expert's team office hours: each team can pause SLA clocks on its own
  // schedule; teams without one inherit the workspace default, which is also
  // the fallback for conversations with no team. customId scope = a team id or
  // DEFAULT_SETTINGS_SCOPE.

  private scopeSeg(customId: string, idx: number): string {
    return customId.split(":")[idx] ?? DEFAULT_SETTINGS_SCOPE;
  }

  private hoursTeamId(scope: string): string | null {
    return scope === DEFAULT_SETTINGS_SCOPE ? null : scope;
  }

  private emptyWeek(): NonNullable<ReturnType<SettingsStore["officeHours"]>>["week"] {
    return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  }

  // The schedule to EDIT for a scope: its own stored schedule, else the
  // workspace default as a starting template, else an empty UTC schedule.
  private scheduleForScope(scope: string): OfficeHoursSchedule {
    const teamId = this.hoursTeamId(scope);
    if (teamId) {
      const ov = this.ctx.settingsStore.teamOverride(teamId);
      if (ov?.officeHoursJson) return ov.officeHoursJson;
    }
    return this.ctx.settingsStore.officeHours() ?? { tz: "UTC", week: this.emptyWeek(), holidays: [] };
  }

  private enabledForScope(scope: string): boolean {
    const teamId = this.hoursTeamId(scope);
    return teamId ? this.ctx.settingsStore.resolveOfficeHoursEnabled(teamId) : this.ctx.settingsStore.officeHoursEnabled();
  }

  private async saveScopeSchedule(scope: string, schedule: OfficeHoursSchedule): Promise<void> {
    const name = scope === DEFAULT_SETTINGS_SCOPE ? null : await this.scopeTeamName(scope);
    await this.ctx.settingsStore.updateOfficeHoursScoped(scope, name, { officeHoursJson: schedule });
  }

  private async scopeTeamName(scope: string): Promise<string> {
    if (scope === DEFAULT_SETTINGS_SCOPE) return "Workspace default";
    const teams = await this.ctx.intercomClient.listTeams().catch(() => []);
    return teams.find((t) => t.id === scope)?.name ?? this.ctx.settingsStore.teamOverride(scope)?.teamName ?? `Team ${scope}`;
  }

  private formatWindows(windows: Array<{ start: string; end: string }>): string {
    if (!windows.length) return "_closed_";
    return windows.map((w) => `${w.start}–${w.end}${w.end <= w.start ? " (+1d)" : ""}`).join(", ");
  }

  // Team-picker root for office hours.
  private async buildHoursTeamsPanel(page: number): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const teams = await this.ctx.intercomClient.listTeams().catch(() => []);
    const TEAM_OPTS_MAX = 24;
    const totalPages = Math.max(1, Math.ceil(teams.length / TEAM_OPTS_MAX));
    const clamped = Math.min(Math.max(0, page), totalPages - 1);
    const slice = teams.slice(clamped * TEAM_OPTS_MAX, (clamped + 1) * TEAM_OPTS_MAX);
    const defEnabled = s.officeHoursEnabled();
    const overrides = new Set(s.listTeamOverrides().filter((o) => o.entry.officeHoursJson || o.entry.officeHoursEnabled !== undefined).map((o) => o.teamId));
    const embed = panelEmbed(
      "Office Hours",
      [
        `**Workspace default:** ${defEnabled ? `on — \`${(s.officeHours()?.tz) ?? "?"}\`` : "off (clocks run 24/7)"}`,
        `**Teams with custom hours:** ${overrides.size || "none"}`,
        "",
        "SLA clocks count business time only. Each conversation uses **its own team's** office hours; teams without custom hours inherit the workspace default (also the fallback for conversations with no team). Only SLA clocks pause — assignment runs 24/7.",
        "",
        "Pick a team below (or the workspace default) to edit its schedule.",
      ].join("\n")
    );
    const components: Panel["components"] = [];
    if (slice.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId("icadmin_sla_hours_pick")
            .setPlaceholder("Edit a team's office hours…")
            .addOptions(
              slice.map((t) => ({
                label: t.name.slice(0, 100),
                value: t.id,
                description: (overrides.has(t.id) ? "custom hours" : `inherits default (${s.resolveOfficeHoursEnabled(t.id) ? "on" : "off"})`).slice(0, 100),
              }))
            )
        )
      );
    }
    const nav = [
      btn("icadmin_sla_hours_default", "Workspace Default", ButtonStyle.Primary),
      btn("icadmin_hub:sla", "Back", ButtonStyle.Secondary),
    ];
    if (totalPages > 1) {
      nav.unshift(
        btn(`icadmin_sla_hours_teams_pg:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_sla_hours_teams_pg:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    components.push(buttonRow(...nav));
    return { embeds: [embed], components };
  }

  private async handleHoursTeamsOpen(interaction: ButtonInteraction, page: number): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildHoursTeamsPanel(page));
  }

  private async handleHoursTeamsPage(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildHoursTeamsPanel(Number(interaction.customId.split(":")[1]) || 0));
  }

  private async handleHoursScopePick(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildHoursPanel(interaction.values[0], 0));
  }

  private async handleHoursScopeOpen(interaction: ButtonInteraction, scope: string): Promise<void> {
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildHoursPanel(scope, 0));
  }

  private async buildHoursPanel(scope: string, page: number): Promise<Panel> {
    const teamId = this.hoursTeamId(scope);
    const name = await this.scopeTeamName(scope);
    const enabled = this.enabledForScope(scope);
    const schedule = this.scheduleForScope(scope);
    const hasOwn = teamId ? !!this.ctx.settingsStore.teamOverride(teamId)?.officeHoursJson : true;
    const dayLines = WEEKDAYS.map((d) => `**${d[0].toUpperCase()}${d.slice(1)}:** ${this.formatWindows(schedule.week[d])}`);
    const holidays = [...schedule.holidays].sort();
    const totalPages = Math.max(1, Math.ceil(holidays.length / PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), totalPages - 1);
    const slice = holidays.slice(clamped * PAGE_SIZE, (clamped + 1) * PAGE_SIZE);
    const embed = panelEmbed(
      `Office Hours — ${name}`,
      [
        teamId && !hasOwn ? "_This team currently inherits the workspace-default schedule shown below — editing anything creates a custom schedule._" : "",
        `**Status:** ${enabled ? "**on** — SLA clocks count business time only" : "off — clocks run 24/7"}`,
        `**Timezone:** \`${schedule.tz}\``,
        "",
        ...dayLines,
        "",
        `**Holidays** (${holidays.length}) — full-day closed:`,
        slice.length ? slice.map((h) => `• ${h}`).join("\n") : "_none_",
        ...(totalPages > 1 ? [`Page ${clamped + 1}/${totalPages}`] : []),
        "",
        "Windows are `HH:MM-HH:MM` in the schedule timezone; `22:00-06:00` crosses midnight; multiple windows per day are comma-separated.",
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
    const components: Panel["components"] = [
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(`icadmin_sla_hours_day:${scope}`)
          .setPlaceholder("Edit a weekday's windows…")
          .addOptions(
            WEEKDAYS.map((d) => ({
              label: d[0].toUpperCase() + d.slice(1),
              value: d,
              description: this.formatWindows(schedule.week[d]).replace(/_/g, "").slice(0, 100),
            }))
          )
      ),
    ];
    if (holidays.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`icadmin_sla_hours_hol_rm:${scope}`)
            .setPlaceholder("Remove a holiday…")
            .addOptions(slice.map((h) => ({ label: h, value: h })))
        )
      );
    }
    const row1 = [
      btn(`icadmin_sla_hours_toggle:${scope}`, `Office hours: ${enabled ? "on" : "off"}`, enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn(`icadmin_sla_hours_tz:${scope}`, "Timezone", ButtonStyle.Secondary),
      btn(`icadmin_sla_hours_hol_add:${scope}`, "Add Holiday", ButtonStyle.Secondary),
    ];
    const row2 = [btn("icadmin_sla_hours", "Back to teams", ButtonStyle.Secondary)];
    if (teamId && this.ctx.settingsStore.teamOverride(teamId)) {
      row2.unshift(btn(`icadmin_sla_hours_reset:${scope}`, "Revert to Default", ButtonStyle.Danger));
    }
    if (totalPages > 1) {
      row2.unshift(
        btn(`icadmin_sla_hours_hol_pg:${scope}:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped === 0),
        btn(`icadmin_sla_hours_hol_pg:${scope}:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= totalPages - 1)
      );
    }
    components.push(buttonRow(...row1), buttonRow(...row2));
    return { embeds: [embed], components };
  }

  private async handleHoursScopedPage(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const parts = interaction.customId.split(":");
    await interaction.editReply(await this.buildHoursPanel(parts[1] ?? DEFAULT_SETTINGS_SCOPE, Number(parts[2]) || 0));
  }

  private async handleHoursToggle(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const next = !this.enabledForScope(scope);
    const name = scope === DEFAULT_SETTINGS_SCOPE ? null : await this.scopeTeamName(scope);
    await this.ctx.settingsStore.updateOfficeHoursScoped(scope, name, { officeHoursEnabled: next });
    this.ctx.auditConfig(interaction, `Office hours (${name ?? "workspace default"}) → ${next ? "on" : "off"}`);
    await interaction.update(await this.buildHoursPanel(scope, 0));
  }

  private async handleHoursTzOpen(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const modal = new ModalBuilder().setCustomId(`icadmin_sla_hours_tz_m:${scope}`).setTitle("Office hours timezone");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("tz", "IANA timezone", { required: true, placeholder: "Europe/Berlin", maxLength: 60, value: this.scheduleForScope(scope).tz })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleHoursTzSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const tz = interaction.fields.getTextInputValue("tz").trim();
    if (!isValidTimeZone(tz)) {
      await interaction.reply({
        embeds: [makeEmbed(`\`${tz}\` is not a valid IANA timezone (e.g. \`Europe/Berlin\`, \`America/New_York\`, \`UTC\`).`, COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await this.saveScopeSchedule(scope, { ...this.scheduleForScope(scope), tz });
    this.ctx.auditConfig(interaction, `Office hours timezone (${await this.scopeTeamName(scope)}) → \`${tz}\``);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(await this.buildHoursPanel(scope, 0));
  }

  private async handleHoursDayPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const day = interaction.values[0] as Weekday;
    const current = this.scheduleForScope(scope).week[day] ?? [];
    const modal = new ModalBuilder().setCustomId(`icadmin_sla_hours_day_m:${scope}:${day}`).setTitle(`${day[0].toUpperCase()}${day.slice(1)} windows`);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("windows", "HH:MM-HH:MM, comma-separated (empty=closed)", {
          required: false,
          placeholder: "09:00-17:00, 18:00-20:00",
          maxLength: 200,
          value: current.map((w) => `${w.start}-${w.end}`).join(", "),
        })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleHoursDaySubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const parts = interaction.customId.split(":"); // icadmin_sla_hours_day_m:<scope>:<day>
    const scope = parts[1] ?? DEFAULT_SETTINGS_SCOPE;
    const day = parts[2] as Weekday;
    if (!WEEKDAYS.includes(day)) return;
    const raw = interaction.fields.getTextInputValue("windows").trim();
    const windows: Array<{ start: string; end: string }> = [];
    if (raw) {
      for (const piece of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
        const m = piece.match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
        if (!m) {
          await interaction.reply({
            embeds: [makeEmbed(`\`${piece}\` is not \`HH:MM-HH:MM\` (24h). Example: \`09:00-17:00, 18:00-20:00\`; \`22:00-06:00\` crosses midnight.`, COLORS.danger)],
            flags: 64,
          });
          return;
        }
        const start = `${m[1]}:${m[2]}`;
        const end = `${m[3]}:${m[4]}`;
        if (start === end) {
          await interaction.reply({ embeds: [makeEmbed("A window's start and end must differ.", COLORS.danger)], flags: 64 });
          return;
        }
        windows.push({ start, end });
      }
    }
    const schedule = this.scheduleForScope(scope);
    schedule.week = { ...schedule.week, [day]: windows };
    await this.saveScopeSchedule(scope, schedule);
    this.ctx.auditConfig(interaction, `Office hours ${day} (${await this.scopeTeamName(scope)}) → ${windows.length ? windows.map((w) => `${w.start}-${w.end}`).join(", ") : "closed"}`);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(await this.buildHoursPanel(scope, 0));
  }

  private async handleHolidayAddOpen(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const modal = new ModalBuilder().setCustomId(`icadmin_sla_hours_hol_add_m:${scope}`).setTitle("Add holiday(s)");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("dates", "YYYY-MM-DD, comma-separated", { required: true, placeholder: "2026-12-25, 2026-12-26", maxLength: 300 })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleHolidayAddSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const raw = interaction.fields.getTextInputValue("dates").trim();
    const dates = raw.split(",").map((p) => p.trim()).filter(Boolean);
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
        await interaction.reply({ embeds: [makeEmbed(`\`${d}\` is not a valid \`YYYY-MM-DD\` date.`, COLORS.danger)], flags: 64 });
        return;
      }
    }
    const schedule = this.scheduleForScope(scope);
    schedule.holidays = [...new Set([...schedule.holidays, ...dates])].sort();
    await this.saveScopeSchedule(scope, schedule);
    this.ctx.auditConfig(interaction, `Office hours holiday(s) added (${await this.scopeTeamName(scope)}): ${dates.join(", ")}`);
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(await this.buildHoursPanel(scope, 0));
  }

  private async handleHolidayRemove(interaction: StringSelectMenuInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const date = interaction.values[0];
    const schedule = this.scheduleForScope(scope);
    schedule.holidays = schedule.holidays.filter((h) => h !== date);
    await this.saveScopeSchedule(scope, schedule);
    this.ctx.auditConfig(interaction, `Office hours holiday removed (${await this.scopeTeamName(scope)}): ${date}`);
    await interaction.update(await this.buildHoursPanel(scope, 0));
  }

  private async handleHoursOverrideClear(interaction: ButtonInteraction): Promise<void> {
    const scope = this.scopeSeg(interaction.customId, 1);
    const teamId = this.hoursTeamId(scope);
    if (teamId) await this.ctx.settingsStore.clearTeamOfficeHoursOverride(teamId);
    this.ctx.auditConfig(interaction, `Office hours reverted to default (${await this.scopeTeamName(scope)})`);
    await interaction.update(await this.buildHoursTeamsPanel(0));
  }

  // ---- pin lookup ----

  private async handlePinOpen(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId("icadmin_sla_pin_m").setTitle("SLA Pin Lookup");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("ref", "Thread link/id or conv:<conversation id>", {
          required: true,
          placeholder: "https://discord.com/channels/…/123… or conv:456",
          maxLength: 200,
        })
      )
    );
    await interaction.showModal(modal);
  }

  private parseRef(raw: string): SlaSubjectRef | null {
    const text = raw.trim();
    if (/^conv:\d+$/i.test(text)) return { conversationId: text.slice(5) };
    const link = text.match(/channels\/\d+\/(\d+)/);
    if (link) return { threadId: link[1] };
    if (/^\d{15,21}$/.test(text)) return { threadId: text };
    return null;
  }

  private async buildPinPanel(token: string, ref: SlaSubjectRef): Promise<Panel> {
    const state = await this.ctx.slaService.getPinState(ref);
    const preview = await this.ctx.slaService.preview(ref).catch(() => null);
    const subjectLine = "threadId" in ref ? `Ticket <#${ref.threadId}>` : `Conversation \`${ref.conversationId}\``;
    const ruleLine = preview?.evaluation.winner
      ? `rule **${preview.evaluation.winner.name}** → \`${preview.evaluation.winner.target}\``
      : `no rule match → ${this.ctx.settingsStore.slaDefaultTarget() ? `default \`${this.ctx.settingsStore.slaDefaultTarget()}\`` : "none"}`;
    const embed = panelEmbed(
      "SLA Pin",
      [
        subjectLine,
        `**Pinned:** ${state?.pinnedTarget ? `\`${state.pinnedTarget}\` by ${state.pinnedByName ?? "?"} ${state.pinnedAt ? `<t:${Math.floor(state.pinnedAt.getTime() / 1000)}:R>` : ""}` : "_no — rules apply_"}`,
        `**Rules would apply:** ${ruleLine}`,
        `**Last written:** ${preview?.lastWrittenTarget ? `\`${preview.lastWrittenTarget}\`` : "_nothing yet_"}`,
        "",
        "Pinning writes the target immediately and makes rules skip this subject until unpinned (audit-logged).",
      ].join("\n")
    );
    const targets = this.ctx.settingsStore.slaTargets();
    const components: Panel["components"] = [];
    if (targets.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`icadmin_sla_pin_set:${token}`)
            .setPlaceholder("Pin to target…")
            .addOptions(targets.slice(0, 25).map((t) => ({ label: t.value, value: t.value, description: (t.note || undefined)?.slice(0, 100) })))
        )
      );
    }
    components.push(
      buttonRow(
        btn(`icadmin_sla_unpin:${token}`, "Unpin", ButtonStyle.Secondary, !state?.pinnedTarget),
        btn(`icadmin_sla_reval:${token}`, "Re-evaluate Now", ButtonStyle.Secondary),
        btn("icadmin_hub:sla", "Back", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private async handlePinSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const ref = this.parseRef(interaction.fields.getTextInputValue("ref"));
    if (!ref) {
      await interaction.reply({
        embeds: [makeEmbed("Couldn't parse that — paste a thread link, a thread id, or `conv:<conversation id>`.", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if ("threadId" in ref) {
      const ticket = await this.ctx.ticketStore.getByThreadId(ref.threadId).catch(() => null);
      if (!ticket) {
        await interaction.reply({ embeds: [makeEmbed("No ticket found for that thread.", COLORS.warn)], flags: 64 });
        return;
      }
    }
    await interaction.deferReply({ flags: 64 });
    const token = this.ctx.sessions.newSession(interaction, { pinRef: ref });
    await this.ctx.sessions.tryRender(interaction, async () => {
      await interaction.editReply(await this.buildPinPanel(token, ref));
    });
  }

  private async withPinRef(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    prefix: string,
    work: (token: string, ref: SlaSubjectRef) => Promise<void>
  ): Promise<void> {
    const token = interaction.customId.slice(prefix.length);
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.pinRef) return;
    await work(token, session.pinRef);
  }

  private async handlePinSet(interaction: StringSelectMenuInteraction): Promise<void> {
    await this.withPinRef(interaction, "icadmin_sla_pin_set:", async (token, ref) => {
      await interaction.deferUpdate();
      const actor = { id: interaction.user.id, name: interaction.user.displayName };
      const result = await this.ctx.slaService.pin(ref, interaction.values[0], actor);
      await interaction.editReply(await this.buildPinPanel(token, ref));
      if (result.outcome === "error") {
        await interaction.followUp({ embeds: [makeEmbed(`Pin write failed: ${result.reason ?? "unknown"}`, COLORS.warn)], flags: 64 }).catch(() => undefined);
      }
    });
  }

  private async handleUnpin(interaction: ButtonInteraction): Promise<void> {
    await this.withPinRef(interaction, "icadmin_sla_unpin:", async (token, ref) => {
      await interaction.deferUpdate();
      await this.ctx.slaService.unpin(ref, { id: interaction.user.id, name: interaction.user.displayName });
      await interaction.editReply(await this.buildPinPanel(token, ref));
    });
  }

  private async handleReval(interaction: ButtonInteraction): Promise<void> {
    await this.withPinRef(interaction, "icadmin_sla_reval:", async (token, ref) => {
      await interaction.deferUpdate();
      const result =
        "threadId" in ref
          ? await this.ctx.slaService.applyForBridged(ref.threadId, "manual").catch((e) => ({ outcome: "error" as const, target: null, ruleId: null, reason: String(e) }))
          : await this.ctx.slaService.applyForNative(ref.conversationId, "manual").catch((e) => ({ outcome: "error" as const, target: null, ruleId: null, reason: String(e) }));
      await interaction.editReply(await this.buildPinPanel(token, ref));
      await interaction
        .followUp({
          embeds: [
            makeEmbed(
              `Re-evaluated: **${result.outcome}**${result.target ? ` → \`${result.target}\`` : ""}${result.reason ? ` (${result.reason})` : ""}`,
              result.outcome === "error" ? COLORS.warn : COLORS.success
            ),
          ],
          flags: 64,
        })
        .catch(() => undefined);
    });
  }

  // ---- preview match ----

  private async handlePreviewOpen(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder().setCustomId("icadmin_sla_test_m").setTitle("Preview Rule Match");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("ref", "Thread link/id or conv:<conversation id>", { required: true, maxLength: 200 })
      )
    );
    await interaction.showModal(modal);
  }

  private async handlePreviewSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const ref = this.parseRef(interaction.fields.getTextInputValue("ref"));
    if (!ref) {
      await interaction.reply({
        embeds: [makeEmbed("Couldn't parse that — paste a thread link, a thread id, or `conv:<conversation id>`.", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await interaction.deferReply({ flags: 64 });
    const preview = await this.ctx.slaService.preview(ref).catch(() => null);
    if (!preview) {
      await interaction.editReply({ embeds: [makeEmbed("Subject not found (ticket/conversation gone?).", COLORS.warn)] });
      return;
    }
    const traceLines = preview.evaluation.trace.slice(0, 10).map((t) => {
      if (t.skipped === "disabled") return `▫️ ~~${t.name}~~ (disabled)`;
      const mark = t.matched ? "✅" : "❌";
      const failed = t.conditions.filter((c) => !c.pass).slice(0, 3);
      const detail = failed.length ? ` — ${failed.map((c) => `${this.ctx.slaRules.renderExpression([c.condition])}: ${c.reason}`).join("; ")}` : "";
      return `${mark} **${t.name}** → \`${t.target}\`${detail}`;
    });
    const effective = preview.pinned
      ? `📌 pinned \`${preview.pinned.target}\` (rules bypassed)`
      : preview.effectiveTarget
        ? `\`${preview.effectiveTarget}\`${preview.evaluation.winner ? ` (rule **${preview.evaluation.winner.name}**)` : " (default)"}`
        : "_none — attribute would be cleared_";
    await interaction.editReply({
      embeds: [
        makeEmbed(
          [
            `**Effective target:** ${effective}`,
            `**Last written:** ${preview.lastWrittenTarget ? `\`${preview.lastWrittenTarget}\`` : "_nothing yet_"}`,
            "",
            "**Rule trace:**",
            ...(traceLines.length ? traceLines : ["_no rules defined_"]),
            ...(preview.evaluation.trace.length > 10 ? [`… ${preview.evaluation.trace.length - 10} more rule(s)`] : []),
          ].join("\n").slice(0, 4000),
          COLORS.neutral
        ),
      ],
    });
  }
}
