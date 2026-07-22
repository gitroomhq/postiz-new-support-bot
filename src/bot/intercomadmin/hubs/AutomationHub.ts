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
import { isLikelyEmail } from "../../../intercom/forwardedEmailParse";
import { btn, buttonRow, backRow, selectRow, panelEmbed, textInput } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// /intercom → Automation: the workspace customer-idle sweeper (native/unbridged
// conversations) and the per-tag customer reminder texts (moved here from
// /config → Workflow → Manage Tags). Agent nags are no longer here — the SLA
// enforcer owns them (SLA Manager → Nag Cadence). Structural tag settings
// (emoji, label, delays, target, closes-thread) stay with the tags in /config.
export class AutomationHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_auto_sweep_toggle", match: "exact", handler: (i) => this.handleSweepToggle(i) },
    { kind: "button", id: "icadmin_auto_sweep_opts", match: "exact", handler: (i) => this.handleSweepOptsOpen(i) },
    { kind: "button", id: "icadmin_auto_sweep_texts", match: "exact", handler: (i) => this.handleSweepTextsOpen(i) },
    { kind: "button", id: "icadmin_auto_sweep_run", match: "exact", handler: (i) => this.handleSweepRun(i) },
    { kind: "button", id: "icadmin_auto_tag_texts:", match: "prefix", handler: (i) => this.handleTagTextsOpen(i) },
    { kind: "select", id: "icadmin_auto_tag_pick", match: "exact", handler: (i) => this.handleTagPick(i) },
    { kind: "button", id: "icadmin_auto_fwd_toggle", match: "exact", handler: (i) => this.handleFwdToggle(i) },
    { kind: "button", id: "icadmin_auto_fwd_opts", match: "exact", handler: (i) => this.handleFwdOptsOpen(i) },
    { kind: "button", id: "icadmin_auto_fwd_list", match: "exact", handler: (i) => this.handleFwdList(i) },
    { kind: "modal", id: "icadmin_auto_sweep_opts_m", match: "exact", handler: (i) => this.handleSweepOptsSubmit(i) },
    { kind: "modal", id: "icadmin_auto_sweep_texts_m", match: "exact", handler: (i) => this.handleSweepTextsSubmit(i) },
    { kind: "modal", id: "icadmin_auto_tag_m:", match: "prefix", handler: (i) => this.handleTagTextsSubmit(i) },
    { kind: "modal", id: "icadmin_auto_fwd_opts_m", match: "exact", handler: (i) => this.handleFwdOptsSubmit(i) },
  ];

  buildPanel(): Panel {
    const s = this.ctx.settingsStore;
    const customTags = s.tags().filter((t) => t.reminderTextCustomer || t.autoCloseMessage);
    const embed = panelEmbed(
      "Intercom Automation",
      [
        "**Customer-idle sweeper** (native/unbridged conversations):",
        `**Status:** ${s.inactivityEnabled() ? "**on** (runs on the 5-minute SLA enforce tick)" : "**off**"}`,
        `**Customer-idle:** after ${s.inactivityCustomerWaitDays()} day(s) of customer silence → outbound reply nag`,
        `**Auto-close:** after ${s.inactivityNagsBeforeClose()} unanswered nag(s) → conversation (and its native ticket) closed`,
        `**Nag text:** ${s.inactivityNagText() ? "custom" : "default"}`,
        "",
        "Covers every open, unsnoozed native conversation EXCEPT Discord-bridged tickets (their per-tag customer reminders below own those) and imported Sentry feedback. Agent nags are SLA-driven now: see **SLA Manager → Nag Cadence**.",
        "",
        "**Per-tag customer reminder texts** (bridged tickets):",
        customTags.length
          ? customTags.map((t) => `${t.emoji} ${t.label}: custom`).join(" · ")
          : "_all tags use the built-in default texts_",
        "Pick a tag below to edit its customer reminder, auto-close farewell and repeat cadence. Structural tag settings (label, delays, target) stay in /config → Workflow → Manage Tags.",
        "",
        "**Forwarded-email conversion** (lite-seat forwards → ticket for the original sender):",
        `**Status:** ${s.forwardConvertEnabled() ? "**on**" : "**off**"} · tag: ${s.forwardConvertTagName()}`,
        `**Close note:** ${s.forwardConvertCloseNote() ? "custom" : "default"} · **extra forwarders:** ${s.forwardConvertExtraEmails().length || "none"}`,
        "New conversations authored by a lite-seat teammate (or a listed extra address) with a Fwd: subject are recreated for the parsed original sender and closed (Intercom's own detection skips lite seats). A forward the parser misses stays attributed to the forwarder; re-forwarding with the standard Fwd: block retries it.",
      ].join("\n")
    );

    const sweeperRow = buttonRow(
      btn("icadmin_auto_sweep_toggle", `Sweeper: ${s.inactivityEnabled() ? "on" : "off"}`, s.inactivityEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn("icadmin_auto_sweep_opts", "Set Thresholds", ButtonStyle.Primary),
      btn("icadmin_auto_sweep_texts", "Nag Text", ButtonStyle.Primary),
      btn("icadmin_auto_sweep_run", "Run Now", ButtonStyle.Secondary)
    );

    const tagSelect = new StringSelectMenuBuilder()
      .setCustomId("icadmin_auto_tag_pick")
      .setPlaceholder("Edit reminder texts for a tag…")
      .addOptions(
        this.ctx.settingsStore.tags().slice(0, 25).map((t) => ({
          label: `${t.emoji} ${t.label}`.slice(0, 100),
          value: t.id,
          description: (t.reminderTextCustomer || t.autoCloseMessage ? "custom texts" : "default texts").slice(0, 100),
        }))
      );

    const fwdRow = buttonRow(
      btn(
        "icadmin_auto_fwd_toggle",
        `Fwd Convert: ${s.forwardConvertEnabled() ? "on" : "off"}`,
        s.forwardConvertEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary
      ),
      btn("icadmin_auto_fwd_opts", "Tag & Note", ButtonStyle.Primary),
      btn("icadmin_auto_fwd_list", "List Forwarders", ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [sweeperRow, fwdRow, selectRow(tagSelect), backRow()] };
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
    const modal = new ModalBuilder().setCustomId("icadmin_auto_sweep_opts_m").setTitle("Customer-idle Thresholds");
    modal.addComponents(
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
    const customerDays = Number.parseInt(interaction.fields.getTextInputValue("customer_days").trim(), 10);
    const nags = Number.parseInt(interaction.fields.getTextInputValue("nags").trim(), 10);
    const inRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
    if (!inRange(customerDays, 1, 30) || !inRange(nags, 1, 10)) {
      await interaction.reply({ embeds: [makeEmbed("Days must be 1-30 and nags 1-10 (whole numbers).", COLORS.danger)], flags: 64 });
      return;
    }
    await this.ctx.settingsStore.updateInactivity({
      inactivityCustomerWaitDays: customerDays,
      inactivityNagsBeforeClose: nags,
    });
    this.ctx.auditConfig(interaction, `Customer-idle thresholds → customer ${customerDays}d, close after ${nags} nag(s)`);
    await interaction.reply({
      embeds: [
        makeEmbed(
          `Customer-idle thresholds saved: ${customerDays}d of silence before a nag, auto-close after ${nags} unanswered nag(s). Applies on the next sweep.`,
          COLORS.success
        ),
      ],
      flags: 64,
    });
  }

  private async handleSweepTextsOpen(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const modal = new ModalBuilder().setCustomId("icadmin_auto_sweep_texts_m").setTitle("Customer Nag Text");
    const nagText = textInput("nag_text", "Customer nag text, {days} ok (blank = default)", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: s.inactivityNagText() ?? undefined,
    });
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nagText));
    await interaction.showModal(modal);
  }

  private async handleSweepTextsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const nagText = interaction.fields.getTextInputValue("nag_text").trim();
    await this.ctx.settingsStore.updateInactivity({ inactivityNagText: nagText || null });
    this.ctx.auditConfig(interaction, `Customer nag text → ${nagText ? "custom" : "default"}`);
    await interaction.reply({ embeds: [makeEmbed("Customer nag text saved. Applies on the next sweep.", COLORS.success)], flags: 64 });
  }

  private async handleSweepRun(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const r = await this.ctx.producers.slaEnforceRunNow();
    await interaction.editReply({
      embeds: [
        makeEmbed(
          r?.ok
            ? "Triggered the merged SLA/customer-idle sweep (bypasses the enabled toggles for this one run). Results land in the audit channel."
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
            `Auto-close farewell: ${tag.autoCloseMessage ? "custom" : "default"}`,
            `Repeat cadence: ${tag.reminderRepeatDays != null ? `${tag.reminderRepeatDays}d` : "= first delay"}`,
            "",
            "_Agent (SUPPORT) reminders are SLA-driven now (SLA Manager → Nag Cadence)._",
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
    // Per-tag customer reminder/close overrides. Blank input = clear back to
    // default. (Agent/SUPPORT reminders are SLA-driven now — no field here.)
    const modal = new ModalBuilder().setCustomId(`icadmin_auto_tag_m:${tag.id}`).setTitle("Reminder Texts");
    const customerText = textInput("customer_text", "Customer reminder text (blank = default)", {
      required: false,
      style: TextInputStyle.Paragraph,
      maxLength: 1000,
      value: tag.reminderTextCustomer ?? undefined,
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
      autoCloseMessage: autocloseMsg || null,
      reminderRepeatDays: repeatNum,
    });
    this.ctx.auditConfig(
      interaction,
      `Status tag ${tag.emoji} ${tag.label} → reminder texts updated (customer ${customerText ? "custom" : "default"}, close ${autocloseMsg ? "custom" : "default"}, repeat ${repeatNum ?? "= first"})`
    );
    await interaction.reply({ embeds: [makeEmbed(`Reminder texts for ${tag.emoji} ${tag.label} updated.`, COLORS.success)], flags: 64 });
  }

  // ---- forwarded-email conversion ----

  private async handleFwdToggle(interaction: ButtonInteraction): Promise<void> {
    const next = !this.ctx.settingsStore.forwardConvertEnabled();
    await this.ctx.settingsStore.updateForwardConvert({ forwardConvertEnabled: next });
    this.ctx.auditConfig(interaction, `Forwarded-email conversion → ${next ? "on" : "off"}`);
    await this.renderPanel(interaction);
  }

  private async handleFwdOptsOpen(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const modal = new ModalBuilder().setCustomId("icadmin_auto_fwd_opts_m").setTitle("Forwarded-email Conversion");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("tag_name", "Tag on the recreated conversation", { required: true, maxLength: 40, value: s.forwardConvertTagName() })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("close_note", "Close note on the original, {email} ok (blank = default)", {
          required: false,
          style: TextInputStyle.Paragraph,
          maxLength: 1000,
          value: s.forwardConvertCloseNote() ?? undefined,
        })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("extra_emails", "Extra forwarder emails, comma-separated (blank = none)", {
          required: false,
          style: TextInputStyle.Paragraph,
          maxLength: 1000,
          value: s.forwardConvertExtraEmails().join(", ") || undefined,
        })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleFwdOptsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const tagName = interaction.fields.getTextInputValue("tag_name").trim();
    const closeNote = interaction.fields.getTextInputValue("close_note").trim();
    const extraRaw = interaction.fields.getTextInputValue("extra_emails").trim();
    if (!tagName) {
      await interaction.reply({ embeds: [makeEmbed("Tag name cannot be empty.", COLORS.danger)], flags: 64 });
      return;
    }
    const extras = [...new Set(extraRaw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const invalid = extras.filter((e) => !isLikelyEmail(e));
    if (invalid.length) {
      await interaction.reply({
        embeds: [makeEmbed(`These entries are not email addresses: ${invalid.join(", ")}`, COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await this.ctx.settingsStore.updateForwardConvert({
      forwardConvertTagName: tagName,
      forwardConvertCloseNote: closeNote || null,
      forwardConvertExtraEmails: extras.join(","),
    });
    this.ctx.auditConfig(
      interaction,
      `Forwarded-email conversion → tag "${tagName}", close note ${closeNote ? "custom" : "default"}, ${extras.length} extra forwarder(s)`
    );
    await interaction.reply({
      embeds: [
        makeEmbed(
          `Forwarded-email settings saved: tag "${tagName}", close note ${closeNote ? "custom" : "default"}, extra forwarders: ${extras.length ? extras.join(", ") : "none"}.`,
          COLORS.success
        ),
      ],
      flags: 64,
    });
  }

  // The auto path's forwarder set: lite-seat teammates (live from Intercom)
  // plus the configured extra addresses. Ephemeral one-shot list; a workspace
  // with more than 20 lite seats shows a documented remainder count.
  private async handleFwdList(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    const extras = this.ctx.settingsStore.forwardConvertExtraEmails();
    const extrasBlock = extras.length
      ? `\n\nExtra addresses (Tag & Note modal):\n${extras.map((e) => `• ${e}`).join("\n")}`
      : "";
    try {
      const admins = await this.ctx.intercomClient.listAdmins();
      const lite = admins.filter((a) => !a.hasInboxSeat && a.email);
      const shown = lite.slice(0, 20).map((a) => `• ${a.name ?? "unnamed"} — ${a.email}`);
      const more = lite.length > shown.length ? `\n… and ${lite.length - shown.length} more (Intercom → Settings → Teammates).` : "";
      await interaction.editReply({
        embeds: [
          makeEmbed(
            (lite.length
              ? `Lite-seat teammates whose forwards auto-convert (${lite.length}):\n${shown.join("\n")}${more}`
              : "No lite-seat teammates found.") + (extrasBlock || (lite.length ? "" : "\n\nNo extra addresses configured either — the auto path has nothing to match against.")),
            COLORS.neutral
          ),
        ],
      });
    } catch (e) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            `Couldn't fetch the teammate list: ${e instanceof Error ? e.message : String(e)}${extrasBlock}`,
            COLORS.danger
          ),
        ],
      });
    }
  }
}
