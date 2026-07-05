import { EmbedBuilder, type Client } from "discord.js";
import type { SettingsStore } from "../../config/SettingsStore";
import type { AuditLogger, AuditSeverity } from "../AuditLogger";
import { COLORS } from "../../util/embeds";
import { Logger } from "../../util/logger";

const logger = new Logger("billing-admin:audit");

const SEVERITY_COLORS: Record<AuditSeverity, number> = {
  info: COLORS.brand,
  success: COLORS.success,
  warn: COLORS.warn,
  danger: COLORS.danger,
  neutral: COLORS.neutral,
};

export interface AdminAuditEntry {
  action: string;
  targetCustomerId?: string;
  objectId?: string;
  amountText?: string;
  outcome: string;
  severity?: AuditSeverity;
}

// The interaction surface needed to attribute and deliver an audit entry —
// satisfied by every discord.js interaction type.
export interface AuditActor {
  user: { tag: string };
  client: Client;
}

// Staff audit trail for every mutating /billing admin action. Posts to the
// billing audit channel (mirroring the channel-send mechanics of
// BillingCategory.notifyBillingAudit) and additionally mirrors to the general
// AuditLogger when that goes to a different channel. Fire-and-forget — an
// audit failure must never break the admin action it describes.
export class AdminAudit {
  constructor(
    private settingsStore: SettingsStore,
    private auditLogger: AuditLogger
  ) {}

  log(interaction: AuditActor, entry: AdminAuditEntry): void {
    void this.send(interaction, entry).catch((error) => {
      logger.error("Billing admin audit failed", error, { action: entry.action });
    });
  }

  private async send(interaction: AuditActor, entry: AdminAuditEntry): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle(`🛠️ Billing Admin: ${entry.action}`)
      .setColor(SEVERITY_COLORS[entry.severity ?? "info"])
      .addFields(
        { name: "Actor", value: interaction.user.tag, inline: true },
        { name: "Target customer", value: entry.targetCustomerId ? `\`${entry.targetCustomerId}\`` : "—", inline: true },
        { name: "Object", value: entry.objectId ? `\`${entry.objectId}\`` : "—", inline: true },
        { name: "Amount", value: entry.amountText ?? "—", inline: true },
        { name: "Outcome", value: entry.outcome.slice(0, 1024) || "—", inline: false }
      )
      .setTimestamp();

    const channelId = this.settingsStore.billingAuditChannelId();
    if (channelId) {
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel?.isSendable()) {
        await channel.send({ embeds: [embed] }).catch((error) => {
          logger.warn("Billing audit channel send failed", { error: String(error) });
        });
      }
    }

    // Mirror into the general audit log unless both land in the same channel.
    if (this.settingsStore.auditLogChannelId() !== this.settingsStore.billingAuditChannelId()) {
      await this.auditLogger.log({
        title: `🛠️ Billing Admin: ${entry.action}`,
        actor: interaction.user.tag,
        fields: [
          { name: "Target customer", value: entry.targetCustomerId ? `\`${entry.targetCustomerId}\`` : "—", inline: true },
          { name: "Object", value: entry.objectId ? `\`${entry.objectId}\`` : "—", inline: true },
          { name: "Amount", value: entry.amountText ?? "—", inline: true },
          { name: "Outcome", value: entry.outcome, inline: false },
        ],
        severity: entry.severity ?? "info",
      });
    }
  }
}
