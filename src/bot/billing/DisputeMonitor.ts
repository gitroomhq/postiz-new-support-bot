import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { StripeClient } from "../StripeClient";
import { DisputeStore, OPEN_DISPUTE_STATUSES, RESPONDABLE_DISPUTE_STATUSES, segmentsOfDispute } from "./DisputeStore";
import type { EvidencePackBuilder } from "./evidence/EvidencePackBuilder";
import type { DisputeEvidenceService } from "./DisputeEvidenceService";
import type { StripeSegmentResolver } from "./StripeSegmentResolver";
import { BlockStore } from "./BlockStore";
import { CachedRatioEngine, describeRatioWindow, ratioLevel, type RatioLevel } from "./disputeRatio";
import { COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import {
  exportBillingEvent,
  exportDisputeEvidencePack,
  exportDisputeOutcome,
  exportDisputeResponse,
  exportDisputeSnapshot,
} from "../../metrics/MetricsExporter";
import { flushInflux, influxActive } from "../../metrics/InfluxWriter";
import type { DisputesTickResult } from "../../temporal/types";
import type Stripe from "stripe";

const monitorLog = log.child("dispute-monitor");

const DAY_S = 24 * 60 * 60;

// The looper ticks hourly; the 90-day Stripe reconcile and the ratio sweeps
// keep their original cadence behind a persisted cursor. A code constant rather
// than a setting: it is a cost decision, not an operator preference.
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

// Evidence packs enrich through Intercom, so a tick handles a bounded number.
const AUTO_EVIDENCE_LIMIT = 10;

const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

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

// One-time all-time history import (/config → Billing → Disputes → Backfill
// History): sweeps EVERY dispute from Stripe into the local mirror (win-rate
// analytics need the full history, not the 90d reconcile window), then emits
// one Influx outcome point per terminal dispute at its historical close time.
// Idempotent: re-runs upsert the same rows and overwrite the same points
// (identical measurement + tags + timestamp).
export interface DisputeBackfillResult {
  swept: number;
  terminal: number;
  points: number;
  truncated: boolean;
}

// Stripe does not expose a closed-at timestamp on disputes. Best available
// estimate: the latest balance transaction (won → funds-reinstatement, most
// closures move funds), else an elapsed evidence deadline, else creation.
function guessClosedAt(d: Stripe.Dispute, now: Date): Date {
  const candidates: number[] = [];
  for (const bt of d.balance_transactions ?? []) {
    if (bt.created) candidates.push(bt.created * 1000);
  }
  const dueBy = d.evidence_details?.due_by ? d.evidence_details.due_by * 1000 : null;
  if (dueBy && dueBy < now.getTime()) candidates.push(dueBy);
  const guess = candidates.length ? Math.max(...candidates) : d.created * 1000;
  return new Date(Math.min(guess, now.getTime()));
}

// Stripe reads the WHOLE history sweep may spend resolving descriptive
// segments — one budget for the entire run, not one per dispute. Disputes are
// low-volume enough that enriching history is worth paying for (unlike the
// money-out ledger, where all-time history is thousands of rows), but it still
// needs a ceiling: an account with a chargeback problem has a lot of them, and
// each one costs up to four reads. Past the cap the rest keep null segments and
// chart as "unknown".
const BACKFILL_SEGMENT_BUDGET = 400;

export async function backfillDisputeHistory(
  stripe: StripeClient,
  disputeStore: DisputeStore,
  segments?: StripeSegmentResolver
): Promise<DisputeBackfillResult> {
  const now = new Date();
  const sweep = await stripe.listAllDisputes();
  // One budget for the run. Letting each upsert open its own would mean the cap
  // never caps: a thousand disputes would each get a fresh allowance.
  segments?.startBatch(BACKFILL_SEGMENT_BUDGET);
  for (const dispute of sweep.disputes) {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const existing = await disputeStore.get(dispute.id);
    const customerId =
      existing?.customerId ??
      (chargeId ? await stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    await disputeStore.upsertFromStripe(dispute, customerId, {
      closedAtHint: guessClosedAt(dispute, now),
      // null = this loop owns the budget opened above.
      enrichBudget: segments ? null : undefined,
    });
  }

  // Emit outcome points for the WHOLE terminal mirror at the stored closedAt.
  // Live transition points used the same closedAt, so re-emission overwrites
  // rather than double-counting.
  let points = 0;
  if (influxActive()) {
    for (const row of await disputeStore.listTerminalForExport()) {
      exportDisputeOutcome({
        outcome: row.status,
        reason: row.reason,
        amountMinor: row.amount,
        currency: row.currency,
        submitted: row.evidenceSubmittedAt != null,
        // Whatever the mirror knows about who disputed us. Re-emitting from the
        // mirror rather than from Stripe is what lets a wiped Influx bucket be
        // rebuilt with its axes intact.
        segments: segmentsOfDispute(row),
        ts: row.closedAt ?? undefined,
      });
      points++;
    }
    await flushInflux();
  }
  const terminal = sweep.disputes.filter((d) => !OPEN_SET.has(d.status)).length;
  return { swept: sweep.disputes.length, terminal, points, truncated: sweep.truncated };
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
    private ratio: CachedRatioEngine,
    // Optional so an instance without them still reconciles and reminds.
    private autoResolve?: { drain(): Promise<{ executed: number; blocked: number; failed: number }> } | null,
    private evidencePack?: EvidencePackBuilder | null,
    private evidence?: DisputeEvidenceService | null
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // The looper ticks HOURLY so due auto-resolves fire close to their configured
  // veto window and near-deadline evidence is noticed in time. The expensive
  // Stripe work does not run hourly: the 90-day reconcile and the ratio sweeps
  // stay on their original 6h cadence behind a persisted cursor, so this change
  // buys timeliness without multiplying Stripe reads by six.
  //
  // Order matters. The auto-resolve drain runs FIRST and unconditionally: it is
  // cheap and time-critical, and a slow reconcile must never push a due refund
  // past the window a human was promised.
  async tick(force: boolean): Promise<DisputesTickResult> {
    const autoResolve = await this.autoResolve?.drain().catch((error) => {
      monitorLog.error("auto-resolve drain failed", error);
      return null;
    });

    // Free to run every tick: the query carries its own 24h damper per dispute
    // and touches no Stripe at all, so hourly simply notices a near-due dispute
    // within an hour instead of within six.
    const reminders = await this.sendReminders().catch((error) => {
      monitorLog.error("dispute reminders failed", error);
      return 0;
    });

    const evidence = await this.runAutoEvidence().catch((error) => {
      monitorLog.error("dispute auto-evidence failed", error);
      return { packed: 0, autoSubmitted: 0, escalated: 0 };
    });

    const last = this.settings.disputeReconcileAt();
    const heavyDue = force || !last || Date.now() - last.getTime() >= RECONCILE_INTERVAL_MS;

    let reconciled = 0;
    let level: DisputesTickResult["ratioLevel"] = "skipped";
    if (heavyDue) {
      try {
        reconciled = (await reconcileDisputes(this.stripe, this.disputeStore)).synced;
      } catch (error) {
        monitorLog.error("dispute reconciliation failed", error);
      }
      level = await this.checkRatio(force).catch((error) => {
        monitorLog.error("dispute ratio check failed", error);
        return "skipped" as const;
      });
      await this.settings.recordDisputeReconcile().catch(() => {
        // A failed stamp only means the heavy pass runs again next hour.
      });
    }

    return {
      reconciled,
      reminders,
      ratioLevel: level,
      autoResolved: autoResolve?.executed ?? 0,
      autoResolveBlocked: autoResolve?.blocked ?? 0,
      autoResolveFailed: autoResolve?.failed ?? 0,
      packed: evidence.packed,
      autoSubmitted: evidence.autoSubmitted,
      escalated: evidence.escalated,
    };
  }

  // Builds (or rebuilds) the templated evidence pack for disputes approaching
  // their deadline, then either submits it or escalates. Capped per tick: this
  // is the expensive path, with Intercom enrichment on every dispute it touches.
  private async runAutoEvidence(): Promise<{ packed: number; autoSubmitted: number; escalated: number }> {
    const out = { packed: 0, autoSubmitted: 0, escalated: 0 };
    const builder = this.evidencePack;
    if (!builder || !this.settings.disputeAutoPackEnabled()) return out;

    // Look a full day beyond the submit window so a pack is built and readable
    // BEFORE the hour it might be submitted in.
    const windowHours = this.settings.disputeAutoSubmitHours() + 24;
    const rows = await this.disputeStore.listNeedingAutoEvidence(windowHours);
    for (const row of rows.slice(0, AUTO_EVIDENCE_LIMIT)) {
      try {
        const dispute = await this.stripe.getDispute(row.id);
        if (!RESPONDABLE.has(dispute.status)) continue;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        if (!chargeId) continue;
        const charge = await this.stripe.getCharge(chargeId);
        const pack = await builder.build(dispute, charge, { enrich: true });
        const staged = await builder.stage(dispute, pack, false);
        out.packed++;

        const decision = await builder.autoSubmitDecision(dispute, row, staged.pack);
        if (decision.kind === "submit") {
          const result = await this.evidence!.submit(dispute.id, "system", row.customerId);
          if (result.kind === "submitted") {
            out.autoSubmitted++;
            exportDisputeEvidencePack({
              reason: dispute.reason,
              source: row.evidenceTouchedAt ? "mixed" : "template",
              fieldsFilled: staged.staged.length,
              fieldsRecommended: staged.staged.length + staged.omitted.length,
              filesAttached: 0,
              autoSubmitted: true,
            });
            exportDisputeResponse({
              reason: dispute.reason,
              currency: dispute.currency,
              hoursToSubmit: (Date.now() - dispute.created * 1000) / 3_600_000,
              // NOT clamped: a negative value means it went past the deadline,
              // which is precisely the signal worth seeing.
              hoursBeforeDeadline: ((dispute.evidence_details?.due_by ?? 0) * 1000 - Date.now()) / 3_600_000,
            });
            await this.postAutoSubmitted(dispute, staged.pack.score);
          }
          continue;
        }

        // Refused. NOTHING is un-staged: the pack stays exactly where it is, so
        // a human only has to press Submit.
        if (this.shouldEscalate(decision.why, dispute)) {
          await this.escalateEvidence(dispute, decision.why, decision.score, staged.omitted);
          exportDisputeEvidencePack({
            reason: dispute.reason,
            source: row.evidenceTouchedAt ? "mixed" : "template",
            fieldsFilled: staged.staged.length,
            fieldsRecommended: staged.staged.length + staged.omitted.length,
            filesAttached: 0,
            autoSubmitted: false,
          });
          out.escalated++;
        }
      } catch (error) {
        monitorLog.error("dispute auto-evidence row failed", error, { "stripe.dispute_id": row.id });
      }
    }
    return out;
  }

  // Only a refusal that a human can still act on is worth a ping. "Not due yet"
  // and "already submitted" are the system working, not a problem.
  private shouldEscalate(why: string, dispute: Stripe.Dispute): boolean {
    if (why === "not_due_yet" || why === "already_submitted" || why === "opted_out") return false;
    const dueBy = dispute.evidence_details?.due_by;
    if (!dueBy) return false;
    return (dueBy * 1000 - Date.now()) / 3_600_000 <= this.settings.disputeAutoSubmitHours();
  }

  private async escalateEvidence(
    dispute: Stripe.Dispute,
    why: string,
    score: number,
    omitted: Array<{ field: string; why: string }>
  ): Promise<void> {
    const dueBy = dispute.evidence_details?.due_by ?? 0;
    const hours = Math.max(0, Math.round((dueBy * 1000 - Date.now()) / 3_600_000));
    const roleId = this.settings.disputeUrgentRoleId();
    const embed = new EmbedBuilder()
      .setTitle("⏳ Evidence needs a human before the deadline")
      .setColor(COLORS.danger)
      .setDescription(
        `The evidence package for \`${dispute.id}\` is staged but was NOT auto-submitted: **${why.replace(/_/g, " ")}**. ` +
          "Nothing was un-staged, so opening it and pressing Submit is all that is required."
      )
      .addFields(
        { name: "Completeness", value: `${score}%`, inline: true },
        { name: "Hours left", value: String(hours), inline: true },
        { name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true },
        ...(omitted.length
          ? [{ name: "Missing", value: omitted.map((o) => `${o.field}: ${o.why}`).join("\n").slice(0, 1024), inline: false }]
          : [])
      )
      .setTimestamp();
    await this.postAlert(embed, [], roleId ? `<@&${roleId}>` : undefined);
    // Share the urgent damper so the ordinary urgent ping does not double-fire
    // in the same hour for the same dispute.
    await this.disputeStore.recordUrgentReminder(dispute.id).catch(() => {});
  }

  private async postAutoSubmitted(dispute: Stripe.Dispute, score: number): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("📤 Evidence auto-submitted")
      .setColor(COLORS.success)
      .setDescription(`The templated evidence package for \`${dispute.id}\` was submitted to the bank at ${score}% completeness.`)
      .addFields({ name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true })
      .setTimestamp();
    await this.postAlert(embed);
  }

  // Respondable disputes with evidence due within N days: one channel ping per
  // dispute per 24h (lastReminderAt damper lives in the store query). Disputes
  // inside the urgent window escalate: red embed, harder wording and a role
  // mention when /config has an urgent dispute role set — with its own 24h
  // damper so entering the window pings even if a normal reminder just fired.
  private async sendReminders(): Promise<number> {
    const withinDays = this.settings.disputeReminderDays();
    const urgentHours = this.settings.disputeUrgentHours();
    const [normal, urgent] = await Promise.all([
      this.disputeStore.listNeedingReminder(withinDays, urgentHours),
      this.disputeStore.listNeedingUrgentReminder(urgentHours),
    ]);
    let sent = 0;
    for (const row of urgent) {
      if (await this.sendReminderAlert(row, true, urgentHours)) {
        await this.disputeStore.recordUrgentReminder(row.id);
        // Keeps the normal damper in step so a shrinking urgent window (config
        // change) can't double-ping the same dispute within 24h.
        await this.disputeStore.recordReminder(row.id);
        sent++;
      }
    }
    for (const row of normal) {
      if (await this.sendReminderAlert(row, false, urgentHours)) {
        await this.disputeStore.recordReminder(row.id);
        sent++;
      }
    }
    return sent;
  }

  private async sendReminderAlert(
    row: { id: string; amount: number; currency: string; reason: string; chargeId: string; customerId: string | null; evidenceDueBy: Date | null },
    isUrgent: boolean,
    urgentHours: number
  ): Promise<boolean> {
    const dueTs = row.evidenceDueBy ? Math.floor(row.evidenceDueBy.getTime() / 1000) : null;
    const linked = row.customerId ? await this.linkedMention(row.customerId) : null;
    const embed = new EmbedBuilder()
      .setTitle(isUrgent ? "🚨 URGENT: dispute evidence deadline imminent" : "⏰ Dispute evidence due soon")
      .setColor(isUrgent ? COLORS.danger : COLORS.warn)
      .addFields(
        { name: "Dispute", value: `\`${row.id}\``, inline: true },
        { name: "Amount", value: this.stripe.formatAmount(row.amount, row.currency), inline: true },
        { name: "Reason", value: row.reason, inline: true },
        ...(dueTs ? [{ name: "Evidence due", value: `<t:${dueTs}:R> (<t:${dueTs}:f>)`, inline: false }] : []),
        ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
      )
      .setTimestamp();
    if (isUrgent) {
      embed.setDescription(
        `Less than **${urgentHours}h** remain and **no evidence has been submitted**. Submit evidence or accept the dispute. After the deadline the bank decides on an empty response.`
      );
    }
    const roleId = isUrgent ? this.settings.disputeUrgentRoleId() : null;
    const posted = await this.postAlert(embed, [this.openButtonRow(row.id)], roleId ? `<@&${roleId}>` : undefined);
    if (posted) {
      exportBillingEvent({ event: "dispute_reminder", amountMinor: row.amount, currency: row.currency, chargeId: row.chargeId });
    }
    return posted;
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

  private async postAlert(
    embed: EmbedBuilder,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
    content?: string
  ): Promise<boolean> {
    const channelId = this.settings.billingAuditChannelId() ?? this.settings.auditLogChannelId();
    if (!this.client || !channelId) return false;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return false;
    return channel
      .send({
        embeds: [embed],
        components,
        ...(content ? { content, allowedMentions: { parse: ["roles" as const] } } : {}),
      })
      .then(() => true)
      .catch(() => false);
  }
}
