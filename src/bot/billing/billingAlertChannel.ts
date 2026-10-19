import type { Client, SendableChannels } from "discord.js";
import { log } from "../../util/logger";

const channelLog = log.child("billing-alert-channel");

// One warning per channel and problem per hour: the dispute looper asks every
// hour per deferred row, which buried the cause under the symptom.
const WARN_EVERY_MS = 60 * 60_000;
const warned = new Map<string, number>();

export type BillingChannelProblem = "not_found" | "not_text";

// Where billing alerts post: the billing-audit channel, else the audit-log
// channel. A billing-audit channel that is set but unusable (deleted, the bot
// cannot see it, not a text channel) falls back to the audit log as well,
// and the reason is logged: an auto-resolve proposal that cannot be posted
// never refunds, so a silent miss here deferred refunds for weeks.
export async function billingAlertChannel(
  client: Client | null,
  ids: { billingAuditChannelId: string | null; auditLogChannelId: string | null },
  now: () => number = Date.now
): Promise<{ channel: SendableChannels; channelId: string } | null> {
  if (!client) return null;
  for (const channelId of [ids.billingAuditChannelId, ids.auditLogChannelId]) {
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isSendable()) return { channel, channelId };
    warnOnce(channelId, channel ? "not_text" : "not_found", channelId === ids.billingAuditChannelId ? "billing_audit" : "audit_log", now());
  }
  return null;
}

function warnOnce(channelId: string, problem: BillingChannelProblem, setting: "billing_audit" | "audit_log", nowMs: number): void {
  const key = `${channelId}:${problem}`;
  if (nowMs - (warned.get(key) ?? -Infinity) < WARN_EVERY_MS) return;
  warned.set(key, nowMs);
  channelLog.warn(
    problem === "not_found"
      ? "billing alert channel not found or not visible to the bot"
      : "billing alert channel is not a text channel",
    { "discord.channel_id": channelId, "billing.channel_setting": setting, "billing.channel_problem": problem }
  );
}
