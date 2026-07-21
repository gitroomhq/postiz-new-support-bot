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
import { btn, buttonRow, backRow, selectRow, panelEmbed, textInput } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// /intercom → Automation: the workspace inactivity sweeper (native/unbridged
// conversations + tickets) and the per-tag reminder texts (moved here from
// /config → Workflow → Manage Tags — support reminders post as Intercom
// notes, so they are Intercom-behavioral). Structural tag settings (emoji,
// label, delays, target, closes-thread) stay with the tags in /config.
export class AutomationHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_auto_sweep_toggle", match: "exact", handler: (i) => this.handleSweepToggle(i) },
    { kind: "button", id: "icadmin_auto_sweep_opts", match: "exact", handler: (i) => this.handleSweepOptsOpen(i) },
    { kind: "button", id: "icadmin_auto_sweep_texts", match: "exact", handler: (i) => this.handleSweepTextsOpen(i) },
    { kind: "button", id: "icadmin_auto_sweep_run", match: "exact", handler: (i) => this.handleSweepRun(i) },
    { kind: "button", id: "icadmin_auto_tag_texts:", match: "prefix", handler: (i) => this.handleTagTextsOpen(i) },
    { kind: "select", id: "icadmin_auto_tag_pick", match: "exact", handler: (i) => this.handleTagPick(i) },
    { kind: "modal", id: "icadmin_auto_sweep_opts_m", match: "exact", handler: (i) => this.handleSweepOptsSubmit(i) },
    { kind: "modal", id: "icadmin_auto_sweep_texts_m", match: "exact", handler: (i) => this.handleSweepTextsSubmit(i) },
    { kind: "modal", id: "icadmin_auto_tag_m:", match: "prefix", handler: (i) => this.handleTagTextsSubmit(i) },
  ];

  buildPanel(): Panel {
    const s = this.ctx.settingsStore;
    const customTags = s.tags().filter((t) => t.reminderTextCustomer || t.reminderTextSupport || t.autoCloseMessage);
    const embed = panelEmbed(
      "Intercom Automation",
      [
        "**Inactivity sweeper** (native/unbridged conversations + tickets):",
        `**Status:** ${s.inactivityEnabled() ? "**on** (sweeping every 30 minutes)" : "**off**"}`,
        `**Agent-idle:** after ${s.inactivityAgentWaitDays()} day(s) waiting on an agent → internal note (≤1 per window)`,
        `**Customer-idle:** after ${s.inactivityCustomerWaitDays()} day(s) of customer silence → outbound reply nag`,
        `**Auto-close:** after ${s.inactivityNagsBeforeClose()} unanswered nag(s) → conversation (and its native ticket) closed`,
        `**Texts:** customer nag ${s.inactivityNagText() ? "custom" : "default"} · agent note ${s.inactivityAgentNoteText() ? "custom" : "default"}`,
        "",
        "Covers every open, unsnoozed conversation and open ticket in the workspace EXCEPT Discord-bridged tickets (their per-tag reminder settings below own those). Native tickets only get agent-idle notes, never auto-close.",
        "",
        "**Per-tag reminder texts** (bridged tickets; agent reminders post as Intercom notes):",
        customTags.length
          ? customTags.map((t) => `${t.emoji} ${t.label}: custom`).join(" · ")
          : "_all tags use the built-in default texts_",
        "Pick a tag below to edit its customer reminder, agent note, auto-close farewell and repeat cadence. Structural tag settings (label, delays, target) stay in /config → Workflow → Manage Tags.",
      ].join("\n")
    );

    const sweeperRow = buttonRow(
      btn("icadmin_auto_sweep_toggle", `Sweeper: ${s.inactivityEnabled() ? "on" : "off"}`, s.inactivityEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn("icadmin_auto_sweep_opts", "Set Thresholds", ButtonStyle.Primary),
      btn("icadmin_auto_sweep_texts", "Sweeper Texts", ButtonStyle.Primary),
      btn("icadmin_auto_sweep_run", "Run Now", ButtonStyle.Secondary)
    );

    const tagSelect = new StringSelectMenuBuilder()
      .setCustomId("icadmin_auto_tag_pick")
      .setPlaceholder("Edit reminder texts for a tag…")
      .addOptions(
        this.ctx.settingsStore.tags().slice(0, 25).map((t) => ({
          label: `${t.emoji} ${t.label}`.slice(0, 100),
          value: t.id,
          description: (t.reminderTextCustomer || t.reminderTextSupport || t.autoCloseMessage ? "custom texts" : "default texts").slice(0, 100),
        }))
      );

    return { embeds: [embed], components: [sweeperRow, selectRow(tagSelect), backRow()] };
  }

  private async renderPanel(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    await interaction.update(this.buildPanel());
  }

  // ---- sweeper (verbatim ports) ----

  private async handleSweepToggle(interaction: ButtonInteraction): Promise<void> {
    await this.ctx.settingsStore.updateInactivity({ inactivityEnabled: !this.ctx.settingsStore.inactivityEnabled() });
    this.ctx.auditConfig(interaction, `Inactivity sweeper → ${this.ctx.settingsStore.inactivityEnabled() ? "on" : "off"}`);
    await this.renderPanel(interaction);
  }

  private async handleSweepOptsOpen(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const modal = new ModalBuilder().setCustomId("icadmin_auto_sweep_opts_m").setTitle("Inactivity Thresholds");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("agent_days", "Agent-idle days before a note (1-30)", { required: true, value: String(s.inactivityAgentWaitDays()) })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("customer_days", "Customer-idle days before a nag (1-30)", { required: true, value: String(s.inactivityCustomerWaitDays()) })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("nags", "Unanswered nags before auto-close (1-10)", { required: true, value: String(s.inactivityNagsBeforeClose()) })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleSweepOptsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const agentDays = Number.parseInt(interaction.fields.getTextInputValue("agent_days").trim(), 10);
    const customerDays = Number.parseInt(interaction.fields.getTextInputValue("customer_days").trim(), 10);
    const nags = Number.parseInt(interaction.fields.getTextInputValue("nags").trim(), 10);
    const inRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
    if (!inRange(agentDays, 1, 30) || !inRange(customerDays, 1, 30) || !inRange(nags, 1, 10)) {
      await interaction.reply({ embeds: [makeEmbed("Days must be 1-30 and nags 1-10 (whole numbers).", COLORS.danger)], flags: 64 });
      return;
    }
    await this.ctx.settingsStore.updateInactivity({
      inactivityAgentWaitDays: agentDays,
      inactivityCustomerWaitDays: customerDays,
      inactivityNagsBeforeClose: nags,
    });
    this.ctx.auditConfig(interaction, `Inactivity thresholds → agent ${agentDays}d, customer ${customerDays}d, close after ${nags} nag(s)`);
    await interaction.reply({
      embeds: [
        makeEmbed(
          `Inactivity thresholds saved: agent-idle ${agentDays}d, customer-idle ${customerDays}d, auto-close after ${nags} unanswered nag(s). Applies on the next sweep.`,
          COLORS.success
        ),
      ],
      flags: 64,
    });
  }

  private async handleSweepTextsOpen(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const modal = new ModalBuilder().setCustomId("icadmin_auto_sweep_texts_m").setTitle("Sweeper Texts");
    const nagText = textInput("nag_text", "Customer nag text (blank = default)", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: s.inactivityNagText() ?? undefined,
    });
    const agentNoteText = textInput("agent_note_text", "Agent-idle note, {days}/{team} ok", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: s.inactivityAgentNoteText() ?? undefined,
    });
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(nagText),
      new ActionRowBuilder<TextInputBuilder>().addComponents(agentNoteText)
    );
    await interaction.showModal(modal);
  }

  private async handleSweepTextsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const nagText = interaction.fields.getTextInputValue("nag_text").trim();
    const agentNoteText = interaction.fields.getTextInputValue("agent_note_text").trim();
    await this.ctx.settingsStore.updateInactivity({
      inactivityNagText: nagText || null,
      inactivityAgentNoteText: agentNoteText || null,
    });
    this.ctx.auditConfig(interaction, `Sweeper texts → nag ${nagText ? "custom" : "default"}, agent note ${agentNoteText ? "custom" : "default"}`);
    await interaction.reply({ embeds: [makeEmbed("Sweeper texts saved. Applies on the next sweep.", COLORS.success)], flags: 64 });
  }

  private async handleSweepRun(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const r = await this.ctx.producers.inactivityRunNow();
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
  }

  // ---- per-tag reminder texts (moved from /config → Workflow → Tags) ----

  private async handleTagPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const tag = this.ctx.settingsStore.tagById(interaction.values[0]);
    if (!tag) {
      await interaction.reply({ embeds: [makeEmbed("This tag no longer exists. Reopen /intercom.", COLORS.warn)], flags: 64 });
      return;
    }
    const cadence = tag.reminderEnabled
      ? `every ${tag.reminderDays}d first, then ${tag.reminderRepeatDays ?? tag.reminderDays}d · target ${tag.reminderTarget}`
      : "reminders off for this tag";
    await interaction.update({
      embeds: [
        makeEmbed(
          [
            `**${tag.emoji} ${tag.label}**`,
            `Cadence: ${cadence}${tag.autoCloseAfter != null ? ` · auto-close after ${tag.autoCloseAfter}` : ""}`,
            "",
            `Customer reminder: ${tag.reminderTextCustomer ? "custom" : "default"}`,
            `Agent note ({days}/{team} ok): ${tag.reminderTextSupport ? "custom" : "default"}`,
            `Auto-close farewell: ${tag.autoCloseMessage ? "custom" : "default"}`,
            `Repeat cadence: ${tag.reminderRepeatDays != null ? `${tag.reminderRepeatDays}d` : "= first delay"}`,
          ].join("\n"),
          COLORS.neutral
        ),
      ],
      components: [
        buttonRow(
          btn(`icadmin_auto_tag_texts:${tag.id}`, "Edit Texts", ButtonStyle.Primary),
          btn("icadmin_hub:automation", "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async handleTagTextsOpen(interaction: ButtonInteraction): Promise<void> {
    const tag = this.ctx.settingsStore.tagById(interaction.customId.slice("icadmin_auto_tag_texts:".length));
    if (!tag) {
      await interaction.reply({ embeds: [makeEmbed("This tag no longer exists. Reopen /intercom.", COLORS.warn)], flags: 64 });
      return;
    }
    // Per-tag reminder/close overrides. Blank input = clear back to default.
    const modal = new ModalBuilder().setCustomId(`icadmin_auto_tag_m:${tag.id}`).setTitle("Reminder Texts");
    const customerText = textInput("customer_text", "Customer reminder text (blank = default)", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: tag.reminderTextCustomer ?? undefined,
    });
    const supportText = textInput("support_text", "Agent note text, {days}/{team} ok", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: tag.reminderTextSupport ?? undefined,
    });
    const autocloseMsg = textInput("autoclose_msg", "Auto-close farewell (blank = default)", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: tag.autoCloseMessage ?? undefined,
    });
    const repeatDays = textInput("repeat_days", "Repeat cadence, days (blank = first delay)", {
      required: false,
      value: tag.reminderRepeatDays != null ? String(tag.reminderRepeatDays) : undefined,
    });
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(customerText),
      new ActionRowBuilder<TextInputBuilder>().addComponents(supportText),
      new ActionRowBuilder<TextInputBuilder>().addComponents(autocloseMsg),
      new ActionRowBuilder<TextInputBuilder>().addComponents(repeatDays)
    );
    await interaction.showModal(modal);
  }

  private async handleTagTextsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const tagId = interaction.customId.slice("icadmin_auto_tag_m:".length);
    const tag = this.ctx.settingsStore.tagById(tagId);
    if (!tag) {
      await interaction.reply({ embeds: [makeEmbed("This tag no longer exists. Reopen /intercom.", COLORS.warn)], flags: 64 });
      return;
    }
    const customerText = interaction.fields.getTextInputValue("customer_text").trim();
    const supportText = interaction.fields.getTextInputValue("support_text").trim();
    const autocloseMsg = interaction.fields.getTextInputValue("autoclose_msg").trim();
    const repeatRaw = interaction.fields.getTextInputValue("repeat_days").trim();
    const repeatNum = repeatRaw ? Number(repeatRaw) : null;
    if (repeatRaw && (!Number.isInteger(repeatNum!) || repeatNum! < 1 || repeatNum! > 60)) {
      await interaction.reply({
        embeds: [makeEmbed("Repeat cadence must be 1-60 days (or blank to reuse the first-reminder delay).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await this.ctx.settingsStore.editTag(tag.id, {
      reminderTextCustomer: customerText || null,
      reminderTextSupport: supportText || null,
      autoCloseMessage: autocloseMsg || null,
      reminderRepeatDays: repeatNum,
    });
    this.ctx.auditConfig(
      interaction,
      `Status tag ${tag.emoji} ${tag.label} → reminder texts updated (customer ${customerText ? "custom" : "default"}, agent ${supportText ? "custom" : "default"}, close ${autocloseMsg ? "custom" : "default"}, repeat ${repeatNum ?? "= first"})`
    );
    await interaction.reply({ embeds: [makeEmbed(`Reminder texts for ${tag.emoji} ${tag.label} updated.`, COLORS.success)], flags: 64 });
  }
}
