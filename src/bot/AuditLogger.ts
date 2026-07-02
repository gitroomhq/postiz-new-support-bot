import { Client, EmbedBuilder } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { COLORS } from "../util/embeds";

export type AuditSeverity = "info" | "success" | "warn" | "danger" | "neutral";

const SEVERITY_COLORS: Record<AuditSeverity, number> = {
  info: COLORS.brand,
  success: COLORS.success,
  warn: COLORS.warn,
  danger: COLORS.danger,
  neutral: COLORS.neutral,
};

export interface AuditEvent {
  title: string; // e.g. "🎫 Ticket opened"
  actor?: string;
  actorIconUrl?: string;
  threadId?: string; // rendered as a "Ticket" field: <#threadId>
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  severity?: AuditSeverity; // default "info"
}

// Posts one embed per bot action to the configured audit channel. Constructed
// before the Discord client exists (StatusService needs it first), so the
// client is bound late via bindClient(). log() never throws — audit failures
// must not break the action being audited — so call sites can fire-and-forget
// with `void`.
export class AuditLogger {
  private client: Client | null = null;

  constructor(private settings: SettingsStore) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  async log(event: AuditEvent): Promise<void> {
    try {
      const channelId = this.settings.auditLogChannelId();
      if (!this.client || !channelId) return;

      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) return;

      const embed = new EmbedBuilder()
        .setTitle(event.title)
        .setColor(SEVERITY_COLORS[event.severity ?? "info"])
        .setTimestamp();
      if (event.actor) {
        embed.setAuthor({
          name: event.actor,
          ...(event.actorIconUrl ? { iconURL: event.actorIconUrl } : {}),
        });
      }
      if (event.description) embed.setDescription(event.description.slice(0, 4096));
      if (event.threadId) {
        embed.addFields({ name: "Ticket", value: `<#${event.threadId}>`, inline: true });
      }
      for (const field of event.fields ?? []) {
        // Field values are capped at 1024 chars by Discord; notes/comments can exceed it.
        embed.addFields({ ...field, value: field.value.slice(0, 1024) || "—" });
      }

      await channel.send({ embeds: [embed] });
    } catch (e) {
      console.error("Audit log failed:", e);
    }
  }
}
