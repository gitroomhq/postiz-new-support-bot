import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { DashboardTokens } from "./DashboardTokens";
import { StandingDashboardAuth, LoginNotifier } from "./DashboardAuth";
import { COLORS } from "../util/embeds";
import { log } from "../util/logger";

const dLog = log.child("dashboard:discord");

// The Discord half of the dashboard's auth: mints break-glass links, runs the
// activation-code modal, issues reverse codes, and PUSHES the login DM (with
// [Activate session] + [This wasn't me — lock down]) whenever a standing
// login creates a locked session. Reached via buttons on the /billing root
// panel and via the DM itself — no dedicated slash command by user decision.
//
// Gating: guild buttons require the Discord Administrator permission (as
// everywhere). The DM buttons have no memberPermissions — there the gate is
// dashboard-allowlist membership, which is strictly narrower than "can see
// this DM" (only the bot DMs it, only to allowlisted admins).
export class DashboardDiscord implements LoginNotifier {
  private client: Client | null = null;

  constructor(
    private settings: SettingsStore,
    private tokens: DashboardTokens,
    private auth: StandingDashboardAuth
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // ---- LoginNotifier (DM push on standing login) ----

  async notifyLogin(
    discordUserId: string,
    info: { method: string; ip?: string; ua?: string; pending: boolean }
  ): Promise<void> {
    if (!this.client) return;
    try {
      const user = await this.client.users.fetch(discordUserId);
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .addFields(
          { name: "Method", value: info.method, inline: true },
          { name: "IP", value: info.ip ?? "unknown", inline: true },
          { name: "Device", value: (info.ua ?? "unknown").slice(0, 100), inline: false }
        )
        .setTimestamp(new Date());
      const row = new ActionRowBuilder<ButtonBuilder>();
      if (info.pending) {
        embed
          .setTitle("Dashboard sign-in: confirm to unlock")
          .setDescription(
            "A dashboard sign-in with your credentials is waiting for activation.\n" +
              "**If this was you:** press **Activate session** and enter the code shown in your browser.\n" +
              "**If this was NOT you:** press **This wasn't me, lock down** immediately."
          );
        row.addComponents(
          new ButtonBuilder().setCustomId("dashpanel_activate").setStyle(ButtonStyle.Primary).setLabel("Activate session")
        );
      } else {
        embed
          .setTitle("New dashboard sign-in")
          .setDescription(
            "A dashboard session was opened with one of your trusted factors.\n" +
              "**If this was NOT you:** press **This wasn't me, lock down** immediately."
          );
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("dashpanel_lockdown")
          .setStyle(ButtonStyle.Danger)
          .setLabel("This wasn't me, lock down")
      );
      await user.send({ embeds: [embed], components: [row] });
    } catch (e) {
      // DMs closed / user unreachable — the /billing Activate button remains.
      dLog.warn("login DM failed", {
        "discord.user_id": discordUserId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  async notifyLockout(discordUserId: string, fails: number): Promise<void> {
    if (!this.client) return;
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(
        `⚠️ **${fails} failed dashboard sign-in attempts** against your account. ` +
          "If this isn't you probing your own login, consider LOCKDOWN from /config → Open Web Panel → Dashboard."
      );
    } catch {
      // best-effort
    }
  }

  // ---- /billing entry button ----

  async openDashboard(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
    if (!this.isGuildAdmin(interaction)) {
      await interaction.reply({ content: "Administrator permission required.", flags: 64 });
      return;
    }
    if (!this.settings.dashboardEnabled()) {
      await interaction.reply({
        content: "The web dashboard is disabled. Enable it in /config → Open Web Panel → Dashboard.",
        flags: 64,
      });
      return;
    }
    if (!this.settings.dashboardAdminRole(interaction.user.id)) {
      await interaction.reply({
        content: "You are not on the dashboard allowlist. Add yourself in /config → Open Web Panel → Dashboard.",
        flags: 64,
      });
      return;
    }
    const base = this.settings.resolvedPublicBaseUrl();
    if (!base) {
      await interaction.reply({
        content: "Set the public URL first (/config → Billing → Webhooks) before opening the dashboard.",
        flags: 64,
      });
      return;
    }
    let token: string;
    try {
      token = await this.tokens.mint({
        kind: "open",
        userId: interaction.user.id,
        adminName: interaction.user.globalName ?? interaction.user.username,
      });
    } catch (e) {
      dLog.warn("dashboard mint failed", { "error.message": e instanceof Error ? e.message : String(e) });
      await interaction.reply({ content: "Could not create a dashboard link. Check the bot logs.", flags: 64 });
      return;
    }
    const url = `${base}/billing?t=${encodeURIComponent(token)}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Open dashboard"),
      new ButtonBuilder().setCustomId("dashpanel_activate").setStyle(ButtonStyle.Primary).setLabel("Activate session"),
      new ButtonBuilder()
        .setCustomId("dashpanel_revcode")
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Show destructive-action code")
    );
    await interaction.reply({
      content:
        `**Billing dashboard**: ${base}/billing\n` +
        `Once you've enrolled a passkey (dashboard → Security), just open that URL and sign in; ` +
        `this one-time link is the break-glass/bootstrap path.\n` +
        `1. Open the dashboard. It shows a code and stays locked.\n` +
        `2. Press **Activate session** and enter that code to unlock.\n` +
        `Destructive actions ask for a fresh code via **Show destructive-action code**.`,
      components: [row],
      flags: 64,
    });
  }

  // ---- button router (guild ephemerals + DMs) ----

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const id = interaction.customId;
    if (id !== "dashpanel_open" && id !== "dashpanel_activate" && id !== "dashpanel_revcode" && id !== "dashpanel_lockdown")
      return false;

    if (id === "dashpanel_open") {
      // Guild-only entry (the /billing panel).
      if (!this.isGuildAdmin(interaction)) {
        await interaction.reply({ content: "Administrator permission required.", flags: 64 });
        return true;
      }
      await this.openDashboard(interaction);
      return true;
    }

    // activate / revcode / lockdown also arrive from DMs (the login push).
    if (!this.isAuthorized(interaction)) {
      await interaction.reply({ content: "You are not on the dashboard allowlist.", flags: 64 });
      return true;
    }

    if (id === "dashpanel_activate") {
      const input = new TextInputBuilder()
        .setCustomId("code")
        .setLabel("Code shown on the dashboard page")
        .setStyle(TextInputStyle.Short)
        .setMinLength(8)
        .setMaxLength(9)
        .setPlaceholder("XXXX-XXXX")
        .setRequired(true);
      const modal = new ModalBuilder()
        .setCustomId("dashpanel_activate_modal")
        .setTitle("Activate dashboard session")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (id === "dashpanel_lockdown") {
      // Emergency: disable + revoke everything. Always available to the DM'd
      // account — a hijacked web session can never stop this.
      await this.settings.updateDashboardEnabled(false);
      const epoch = await this.settings.bumpDashboardEpoch();
      dLog.warn("dashboard LOCKDOWN triggered", { "discord.user_id": interaction.user.id });
      await interaction.reply({
        content:
          `🚨 **Dashboard locked down**: disabled and all links/sessions revoked (epoch ${epoch}).\n` +
          "Re-enable it later in /config → Open Web Panel → Dashboard.",
        flags: 64,
      });
      return true;
    }

    // dashpanel_revcode
    const code = await this.auth.issueReverseForUser(interaction.user.id);
    if (!code) {
      await interaction.reply({
        content: "No active dashboard session. Open the dashboard and sign in first.",
        flags: 64,
      });
      return true;
    }
    await interaction.reply({
      content: `**Destructive-action code:** \`${code}\`\nEnter it on the dashboard within 5 minutes. Single use.`,
      flags: 64,
    });
    return true;
  }

  // ---- modal router ----

  async handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    if (interaction.customId !== "dashpanel_activate_modal") return false;
    if (!this.isAuthorized(interaction)) {
      await interaction.reply({ content: "You are not on the dashboard allowlist.", flags: 64 });
      return true;
    }
    const raw = interaction.fields.getTextInputValue("code");
    const res = await this.auth.activate(interaction.user.id, normalizeCode(raw), this.settings.dashboardEpoch());
    if (res.ok) {
      await interaction.reply({ content: "✅ Dashboard session activated. Return to your browser.", flags: 64 });
    } else if (res.reason === "locked_out") {
      await interaction.reply({
        content: "Too many incorrect codes; that session was locked. Sign in again for a fresh one.",
        flags: 64,
      });
    } else {
      await interaction.reply({
        content: "That code didn't match a pending dashboard session. Sign in first, then type the code exactly as shown.",
        flags: 64,
      });
    }
    return true;
  }

  // Guild surface: the Administrator permission bit.
  private isGuildAdmin(interaction: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction): boolean {
    return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  }

  // Guild Administrator OR (DM context) dashboard-allowlist membership.
  private isAuthorized(interaction: ButtonInteraction | ModalSubmitInteraction): boolean {
    if (this.isGuildAdmin(interaction)) return true;
    return !interaction.inGuild() && this.settings.dashboardAdminRole(interaction.user.id) != null;
  }
}

// Accept the code with or without the hyphen / in any case; re-form as
// XXXX-XXXX to match the stored Crockford code.
function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4)}`;
  return raw.toUpperCase();
}
