import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { StripeClient } from "../StripeClient";
import { DisputeStore, OPEN_DISPUTE_STATUSES } from "./DisputeStore";
import { BlockStore } from "./BlockStore";
import { CachedRatioEngine, describeRatioWindow, ratioLevel, type RatioLevel } from "./disputeRatio";
import { COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import { exportBillingEvent, exportDisputeSnapshot } from "../../metrics/MetricsExporter";
import type { DisputesTickResult } from "../../temporal/types";

const monitorLog = log.child("dispute-monitor");

const DAY_S = 24 * 60 * 60;

// Stripe → local table reconciliation: upserts every dispute created in the
// last 90 days, then re-checks any locally-open dispute the sweep missed
// (closes older than the window, missed webhooks). Shared by the looper tick
// and the /billing "Sync from Stripe" button. The status breakdown feeds the
// sync notice — most synced disputes are usually already closed, and a bare
// total reads like "sync did nothing" when the open list doesn't change.
export interface ReconcileResult {
  synced: number;
  open: number;
  won: number;
  lost: number;
  otherClosed: number;
  truncated: boolean;
}

const OPEN_SET = new Set<string>(OPEN_DISPUTE_STATUSES);

export async function reconcileDisputes(stripe: StripeClient, disputeStore: DisputeStore): Promise<ReconcileResult> {
  const since = Math.floor(Date.now() / 1000) - 90 * DAY_S;
  const sweep = await stripe.listDisputesSince(since);
  const seen = new Set<string>();
  const result: ReconcileResult = { synced: 0, open: 0, won: 0, lost: 0, otherClosed: 0, truncated: sweep.truncated };
  const tally = (status: string) => {
    if (OPEN_SET.has(status)) result.open++;
    else if (status === "won") result.won++;
    else if (status === "lost") result.lost++;
    else result.otherClosed++; // prevented, warning_closed
  };
  for (const dispute of sweep.disputes) {
    seen.add(dispute.id);
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const existing = await disputeStore.get(dispute.id);
    const customerId =
      existing?.customerId ??
      (chargeId ? await stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    await disputeStore.upsertFromStripe(dispute, customerId);
    tally(dispute.status);
    result.synced++;
  }
  // Locally open but absent from the sweep — fetch individually to catch up.
  for (const id of await disputeStore.listOpenIds()) {
    if (seen.has(id)) continue;
    try {
      const fresh = await stripe.getDispute(id);
      const existing = await disputeStore.get(id);
      await disputeStore.upsertFromStripe(fresh, existing?.customerId ?? null);
      tally(fresh.status);
      result.synced++;
    } catch (error) {
      monitorLog.warn("dispute re-check failed", { "stripe.dispute_id": id, error: String(error) });
    }
  }
  return result;
}

// The disputes-looper tick body: reconcile → evidence-due reminders → ratio
// threshold check. Constructed before the Discord client (bindClient idiom,
// same as StripeWebhookHandler).
export class DisputeMonitor {
  private client: Client | null = null;

  constructor(
    private settings: SettingsStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private blockStore: BlockStore,
    private ratio: CachedRatioEngine
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  async tick(force: boolean): Promise<DisputesTickResult> {
    let reconciled = 0;
    try {
      reconciled = (await reconcileDisputes(this.stripe, this.disputeStore)).synced;
    } catch (error) {
      monitorLog.error("dispute reconciliation failed", error);
    }

    const reminders = await this.sendReminders().catch((error) => {
      monitorLog.error("dispute reminders failed", error);
      return 0;
    });

    const level = await this.checkRatio(force).catch((error) => {
      monitorLog.error("dispute ratio check failed", error);
      return "skipped" as const;
    });

    return { reconciled, reminders, ratioLevel: level };
  }

  // Respondable disputes with evidence due within N days: one channel ping per
  // dispute per 24h (lastReminderAt damper lives in the store query).
  private async sendReminders(): Promise<number> {
    const withinDays = this.settings.disputeReminderDays();
    const due = await this.disputeStore.listNeedingReminder(withinDays);
    let sent = 0;
    for (const row of due) {
      const dueTs = row.evidenceDueBy ? Math.floor(row.evidenceDueBy.getTime() / 1000) : null;
      const linked = row.customerId ? await this.linkedMention(row.customerId) : null;
      const embed = new EmbedBuilder()
        .setTitle("⏰ Dispute evidence due soon")
        .setColor(COLORS.warn)
        .addFields(
          { name: "Dispute", value: `\`${row.id}\``, inline: true },
          { name: "Amount", value: this.stripe.formatAmount(row.amount, row.currency), inline: true },
          { name: "Reason", value: row.reason, inline: true },
          ...(dueTs ? [{ name: "Evidence due", value: `<t:${dueTs}:R> (<t:${dueTs}:f>)`, inline: false }] : []),
          ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
        )
        .setTimestamp();
      const posted = await this.postAlert(embed, [this.openButtonRow(row.id)]);
      if (posted) {
        await this.disputeStore.recordReminder(row.id);
        exportBillingEvent({ event: "dispute_reminder", amountMinor: row.amount, currency: row.currency, chargeId: row.chargeId });
        sent++;
      }
    }
    return sent;
  }

  // Alert only on level TRANSITIONS (including recovery back to ok), never on
  // every tick — the last alerted level is persisted in bot_settings.
  private async checkRatio(force: boolean): Promise<RatioLevel> {
    const ratios = await this.ratio.get(force);
    const warnPct = this.settings.disputeRatioWarnPct();
    const criticalPct = this.settings.disputeRatioCriticalPct();
    const level = ratioLevel(ratios, warnPct, criticalPct);
    const last = this.settings.disputeRatioLastLevel();

    const [open, dueSoon, blocked] = await Promise.all([
      this.disputeStore.countOpen(),
      this.disputeStore.countDueWithin(this.settings.disputeReminderDays()),
      this.blockStore.count(),
    ]);
    exportDisputeSnapshot({
      open,
      dueSoon,
      blocked,
      plain30dPct: ratios.d30.plainPct,
      vamp30dPct: ratios.d30.vampPct,
      vampMonthPct: ratios.month.vampPct,
    });

    if (level !== last) {
      const color = level === "critical" ? COLORS.danger : level === "warn" ? COLORS.warn : COLORS.success;
      const title =
        level === "ok"
          ? "✅ Dispute ratio recovered"
          : level === "warn"
            ? "⚠️ Dispute ratio above warn threshold"
            : "🚨 Dispute ratio CRITICAL";
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setDescription(
          [
            describeRatioWindow("This month", ratios.month, ratios.truncated),
            describeRatioWindow("Trailing 30d", ratios.d30, ratios.truncated),
            describeRatioWindow("Trailing 90d", ratios.d90, ratios.truncated),
            "",
            `Thresholds: warn ≥ ${warnPct}% · critical ≥ ${criticalPct}% (month VAMP-style figure). Was **${last}**, now **${level}**.`,
          ].join("\n")
        )
        .setTimestamp();
      await this.postAlert(embed);
      await this.settings.setDisputeRatioLevel(level);
    }
    return level;
  }

  private openButtonRow(disputeId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`billadmin_dpa_open:${disputeId}`).setLabel("Open Dispute").setStyle(ButtonStyle.Primary)
    );
  }

  private async linkedMention(customerId: string): Promise<string | null> {
    try {
      const ids = await this.sessionStore.findDiscordIdsByStripeId(customerId);
      return ids.length
        ? `${ids.map((id) => `<@${id}>`).join(", ")} (\`${customerId}\`)`
        : `\`${customerId}\` (no linked Discord user)`;
    } catch {
      return null;
    }
  }

  private async postAlert(embed: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[] = []): Promise<boolean> {
    const channelId = this.settings.billingAuditChannelId() ?? this.settings.auditLogChannelId();
    if (!this.client || !channelId) return false;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return false;
    return channel
      .send({ embeds: [embed], components })
      .then(() => true)
      .catch(() => false);
  }
}
