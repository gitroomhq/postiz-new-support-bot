import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { AdminPanelGroup, AdminPanelTokens } from "./AdminPanelTokens";
import { AdminPanelSessions } from "./AdminPanelSessions";
import { log } from "../util/logger";

const dLog = log.child("adminpanel:discord");

// The Discord half of the admin web panel: mints the link + runs the passcode
// handshake. Component-button interactions don't expire with the 15-min webhook
// token, so [Activate session] and [Show destructive-action code] keep working
// for the whole 30-min session.
export class AdminPanelDiscord {
  constructor(
    private settings: SettingsStore,
    private tokens: AdminPanelTokens,
    private sessions: AdminPanelSessions
  ) {}

  // Called from the /config (and later /intercom) command / entry button.
  async openPanel(
    interaction: ButtonInteraction | ChatInputCommandInteraction,
    panel: AdminPanelGroup
  ): Promise<void> {
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    if (!interaction.guildId) {
      await interaction.reply({ content: "Run this in a server.", flags: 64 });
      return;
    }
    const base = this.settings.resolvedPublicBaseUrl();
    if (!base) {
      await interaction.reply({
        content: "Set the public URL first (/config → Billing → Webhooks) before opening the web panel.",
        flags: 64,
      });
      return;
    }
    let token: string;
    try {
      token = await this.tokens.mint({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        adminName: interaction.user.globalName ?? interaction.user.username,
        panel,
      });
    } catch (e) {
      dLog.warn("admin panel mint failed", { "error.message": e instanceof Error ? e.message : String(e) });
      await interaction.reply({ content: "Could not create a panel link. Check the bot logs.", flags: 64 });
      return;
    }
    const url = `${base}/admin/panel?t=${encodeURIComponent(token)}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Open panel"),
      new ButtonBuilder().setCustomId("adminpanel_activate").setStyle(ButtonStyle.Primary).setLabel("Activate session"),
      new ButtonBuilder()
        .setCustomId("adminpanel_revcode")
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Show destructive-action code")
    );
    await interaction.reply({
      content:
        `**Configuration panel**: link valid 15 minutes, for you only. Do not share it.\n` +
        `1. Open the panel. It shows a code and stays locked.\n` +
        `2. Press **Activate session** and enter that code to unlock.\n` +
        `Destructive actions ask for a fresh code via **Show destructive-action code**.`,
      components: [row],
      flags: 64,
    });
  }

  // Button router for the adminpanel_* custom ids.
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const id = interaction.customId;
    if (
      id !== "adminpanel_open" &&
      id !== "adminpanel_open_intercom" &&
      id !== "adminpanel_activate" &&
      id !== "adminpanel_revcode"
    )
      return false;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return true;
    }
    if (id === "adminpanel_open") {
      await this.openPanel(interaction, "config");
      return true;
    }
    if (id === "adminpanel_open_intercom") {
      await this.openPanel(interaction, "intercom");
      return true;
    }
    if (id === "adminpanel_activate") {
      const input = new TextInputBuilder()
        .setCustomId("code")
        .setLabel("Code shown on the web page")
        .setStyle(TextInputStyle.Short)
        .setMinLength(8)
        .setMaxLength(9)
        .setPlaceholder("XXXX-XXXX")
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId("adminpanel_activate_modal")
        .setTitle("Activate panel session")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }
    // adminpanel_revcode
    const active = this.sessions.activeForUser(interaction.user.id, this.settings.adminPanelEpoch());
    if (!active) {
      await interaction.reply({
        content: "No active panel session. Open the link and activate it first.",
        flags: 64,
      });
      return true;
    }
    const code = this.sessions.issueDestructiveChallenge(active.session);
    await interaction.reply({
      content: `**Destructive-action code:** \`${code}\`\nEnter it on the web page within 5 minutes. Single use.`,
      flags: 64,
    });
    return true;
  }

  // Modal router for adminpanel_activate_modal.
  async handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    if (interaction.customId !== "adminpanel_activate_modal") return false;
    if (!this.isAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return true;
    }
    const raw = interaction.fields.getTextInputValue("code");
    const res = this.sessions.activate(interaction.user.id, normalizeCode(raw), this.settings.adminPanelEpoch());
    if (res.ok) {
      await interaction.reply({ content: "✅ Panel session activated. Return to your browser.", flags: 64 });
    } else if (res.reason === "locked_out") {
      await interaction.reply({
        content: "Too many incorrect codes. That session was locked. Re-run the command for a fresh link.",
        flags: 64,
      });
    } else {
      await interaction.reply({
        content: "That code didn't match an open panel. Open the link first and type the code exactly as shown.",
        flags: 64,
      });
    }
    return true;
  }

  private isAdmin(interaction: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction): boolean {
    return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  }
}

// Accept the code with or without the hyphen / in any case; re-form as XXXX-XXXX
// to match the stored Crockford code. A non-8-char input is returned as-is so it
// simply fails to match.
function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return raw.toUpperCase();
}
