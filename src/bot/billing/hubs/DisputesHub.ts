import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { Logger } from "../../../util/logger";
import { exportBillingEvent } from "../../../metrics/MetricsExporter";
import { buildDisputeEvidencePrompt } from "../../aiPrompts";
import { btn, buttonRow, selectRow, subPlanLabel, textInput } from "../ui";
import { buildNoteModal, renderNotesPanel } from "../qolUi";
import { showRefundConfirm } from "./ChargesHub";
import { reconcileDisputes } from "../DisputeMonitor";
import { describeRatioWindow } from "../disputeRatio";
import { BLOCK_KIND_LABELS, type BlockKind } from "../BlockStore";
import { RESPONDABLE_DISPUTE_STATUSES } from "../DisputeStore";
import {
  pushNav,
  type BillAdminSession,
  type Panel,
  type RenderInteraction,
  type RouteEntry,
  type SessionRenderInteraction,
} from "../types";
import type { HubContext } from "./HubContext";

const logger = new Logger("billing-admin:disputes");

const DISPUTE_ID_RE = /^(dp|du)_[A-Za-z0-9]+$/;
const CHARGE_ID_RE = /^(ch|py)_[A-Za-z0-9]+$/;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]+$/;
// Pragmatic IP validation: dotted-quad with octet range, or a colon-bearing
// IPv6-ish token (Radar does its own strict validation on the item anyway).
const IPV4_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6ISH_RE = /^[0-9a-fA-F:]{3,45}$/;

const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);
const TERMINAL = new Set(["won", "lost", "prevented", "warning_closed"]);

const PAGE_SIZE = 10;

interface EvidenceFieldSpec {
  key: string;
  label: string;
  style: TextInputStyle;
}

// 5-input Discord budget, reason-adaptive: the fraud-default set vs. the
// policy set for cancellation/credit disputes. Field keys ARE the Stripe
// evidence keys (DisputeUpdateParams.Evidence), so the modal round-trips 1:1.
const EVIDENCE_FIELDS_DEFAULT: EvidenceFieldSpec[] = [
  { key: "product_description", label: "Product / service description", style: TextInputStyle.Paragraph },
  { key: "customer_email_address", label: "Customer email", style: TextInputStyle.Short },
  { key: "service_date", label: "Service date", style: TextInputStyle.Short },
  { key: "access_activity_log", label: "Access / usage activity log", style: TextInputStyle.Paragraph },
  { key: "uncategorized_text", label: "Response narrative", style: TextInputStyle.Paragraph },
];
const EVIDENCE_FIELDS_POLICY: EvidenceFieldSpec[] = [
  { key: "product_description", label: "Product / service description", style: TextInputStyle.Paragraph },
  { key: "refund_policy_disclosure", label: "Refund policy disclosure", style: TextInputStyle.Paragraph },
  { key: "cancellation_policy_disclosure", label: "Cancellation policy disclosure", style: TextInputStyle.Paragraph },
  { key: "cancellation_rebuttal", label: "Cancellation rebuttal", style: TextInputStyle.Paragraph },
  { key: "uncategorized_text", label: "Response narrative", style: TextInputStyle.Paragraph },
];
const POLICY_REASONS = new Set(["subscription_canceled", "credit_not_processed"]);
const EVIDENCE_KEYS = new Set([...EVIDENCE_FIELDS_DEFAULT, ...EVIDENCE_FIELDS_POLICY].map((f) => f.key));

// FILE evidence slots (Stripe file ids, distinct from the *_disclosure text
// fields) — where an uploaded screenshot/PDF proof lands.
const EVIDENCE_FILE_SLOTS: Array<{ key: string; label: string }> = [
  { key: "uncategorized_file", label: "Uncategorized file (general proof)" },
  { key: "receipt", label: "Receipt" },
  { key: "customer_communication", label: "Customer communication" },
  { key: "service_documentation", label: "Service documentation / usage proof" },
  { key: "refund_policy", label: "Refund policy (file)" },
  { key: "cancellation_policy", label: "Cancellation policy (file)" },
];
const EVIDENCE_FILE_KEYS = [
  "receipt",
  "customer_communication",
  "customer_signature",
  "service_documentation",
  "shipping_documentation",
  "duplicate_charge_documentation",
  "refund_policy",
  "cancellation_policy",
  "uncategorized_file",
] as const;
// Stripe dispute_evidence uploads accept PDF/JPEG/PNG; combined evidence is
// capped around 4.5MB, so individual proofs are held to 4MB.
const PROOF_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);
const PROOF_MAX_BYTES = 4 * 1024 * 1024;

function evidenceFieldsFor(reason: string | null | undefined): EvidenceFieldSpec[] {
  return POLICY_REASONS.has(reason ?? "") ? EVIDENCE_FIELDS_POLICY : EVIDENCE_FIELDS_DEFAULT;
}

// Cross-hub landing points for Jump-to-ID and the bookmark board — bound by
// BillingAdmin (same pattern as TargetResolver.bindHandlers).
export interface DisputesHubHandlers {
  renderCustomerOverview(interaction: RenderInteraction, token: string): Promise<void>;
  renderChargeDetail(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void>;
}

// Disputes hub: account-wide dispute console (overview + ratio, detail,
// evidence, accept, refund-to-prevent), the blocklist flows, and the QoL layer
// (shared bookmarks, notes, watch subscriptions, Jump-to-ID).
export class DisputesHub {
  private handlers: DisputesHubHandlers | null = null;

  constructor(private ctx: HubContext) {}

  bindHandlers(handlers: DisputesHubHandlers): void {
    this.handlers = handlers;
  }

  readonly routes: RouteEntry[] = [
    // ---- entry + overview ----
    {
      kind: "button",
      id: "billadmin_dp_hub",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        const token = this.ctx.sessions.newSession(interaction, { originHub: "pay" });
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token, 0));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_home:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token, 0));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_page:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token, page));
      },
    },
    {
      kind: "select",
      id: "billadmin_dp_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        pushNav(session, `billadmin_dp_page:${token}:${page}`);
        session.disputeId = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_det:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_sync:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          const result = await reconcileDisputes(this.ctx.stripe, this.ctx.disputeStore);
          await this.renderOverview(
            interaction,
            token,
            0,
            `🔄 Synced ${result.synced} dispute(s) from Stripe — ${result.open} open · ${result.won} won · ${result.lost} lost${
              result.otherClosed ? ` · ${result.otherClosed} other closed` : ""
            }${result.truncated ? " (sweep truncated)" : ""}. Only open disputes are listed below.`
          );
        });
      },
    },
    // ---- evidence ----
    {
      kind: "button",
      id: "billadmin_dp_ev_edit:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        // No defer — showModal must be the first response.
        const row = await this.ctx.disputeStore.get(session.disputeId);
        const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
        const fields = evidenceFieldsFor(row?.reason);
        const modal = new ModalBuilder()
          .setCustomId(`billadmin_dp_evm:${token}`)
          .setTitle(`Evidence — ${session.disputeId}`.slice(0, 45));
        for (const field of fields) {
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              textInput(field.key, field.label, {
                required: false,
                style: field.style,
                maxLength: 4000,
                value: draft[field.key],
              })
            )
          );
        }
        await interaction.showModal(modal);
      },
    },
    {
      kind: "modal",
      id: "billadmin_dp_evm:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const disputeId = session.disputeId;
        // Generic field collection: whatever inputs this modal carried. Empty
        // inputs are OMITTED — sending "" would clear evidence already staged
        // at Stripe (Emptyable fields).
        const evidence: Record<string, string> = {};
        for (const [id, component] of interaction.fields.fields) {
          if (!("value" in component) || typeof component.value !== "string") continue;
          const value = component.value.trim();
          if (value && EVIDENCE_KEYS.has(id)) evidence[id] = value;
        }
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (Object.keys(evidence).length === 0) {
            await this.renderDetail(interaction, token, "Nothing to save — all evidence fields were empty.");
            return;
          }
          await this.ctx.disputeStore.saveEvidenceDraft(disputeId, evidence);
          // submit:false stages at Stripe without sending to the bank.
          await this.ctx.stripe.updateDisputeEvidence(
            disputeId,
            evidence as Stripe.DisputeUpdateParams.Evidence,
            false,
            `billadmin-dpstage-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Dispute evidence staged",
            targetCustomerId: session.customerId,
            objectId: disputeId,
            outcome: `${Object.keys(evidence).length} field(s) staged (NOT submitted)`,
            severity: "info",
          });
          await this.renderDetail(interaction, token, "💾 Evidence staged at Stripe (not submitted yet).");
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_ev_submit:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const dispute = await this.ctx.stripe.getDispute(session.disputeId!);
          if (!RESPONDABLE.has(dispute.status)) {
            await this.renderDetail(interaction, token, `⚠️ Status is **${dispute.status}** — evidence can no longer be submitted.`);
            return;
          }
          const submissions = dispute.evidence_details?.submission_count ?? 0;
          const dueTs = dispute.evidence_details?.due_by || null;
          const embed = new EmbedBuilder()
            .setTitle("Submit evidence to the bank")
            .setColor(COLORS.danger)
            .setDescription(
              [
                `Submit the staged evidence for \`${dispute.id}\` (**${this.ctx.stripe.formatAmount(dispute.amount, dispute.currency)}**, ${dispute.reason})?`,
                dueTs ? `Evidence deadline: <t:${dueTs}:R>.` : null,
                submissions > 0
                  ? `⚠️ Evidence was already submitted **${submissions}×** — banks typically accept only ONE submission; resubmit only if Stripe support advised it.`
                  : "Stripe typically allows exactly one submission — make sure the staged evidence is complete (use Edit Evidence first).",
                "This sends everything currently staged at Stripe. It cannot be recalled.",
              ]
                .filter(Boolean)
                .join("\n\n")
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_dp_ev_submitx:${token}`, "Submit Evidence", ButtonStyle.Danger),
                btn(`billadmin_dp_det:${token}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_ev_submitx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const disputeId = session.disputeId;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          // Live re-check right before the irreversible call: another admin (or
          // the Dashboard) may have submitted/closed while the confirm sat open.
          const fresh = await this.ctx.stripe.getDispute(disputeId);
          if (!RESPONDABLE.has(fresh.status)) {
            await this.renderDetail(interaction, token, `⚠️ Status changed to **${fresh.status}** — nothing was submitted.`);
            return;
          }
          // Cross-admin claim (runExclusive only serializes this panel session).
          const claimed = await this.ctx.sessionStore.claimBillingAction(
            interaction.user.id,
            `dispute-submit-${disputeId}`,
            "dispute_submit"
          );
          if (!claimed) {
            await this.renderDetail(interaction, token, "⚠️ Evidence for this dispute was already submitted via the bot.");
            return;
          }
          let result: Stripe.Dispute;
          try {
            result = await this.ctx.stripe.updateDisputeEvidence(disputeId, {}, true, `billadmin-dpsubmit-${disputeId}`);
          } catch (error) {
            await this.ctx.sessionStore.releaseBillingAction(`dispute-submit-${disputeId}`).catch(() => {});
            throw error;
          }
          await this.ctx.disputeStore.markSubmitted(disputeId);
          await this.ctx.disputeStore.upsertFromStripe(result, session.customerId ?? null);
          this.ctx.audit.log(interaction, {
            action: "Dispute evidence submitted",
            targetCustomerId: session.customerId,
            objectId: disputeId,
            amountText: this.ctx.stripe.formatAmount(result.amount, result.currency),
            outcome: `Submitted to the bank — status now ${result.status}`,
            severity: "warn",
          });
          exportBillingEvent({ event: "evidence_submitted", amountMinor: result.amount, currency: result.currency, chargeId: session.chargeId });
          await this.renderDetail(interaction, token, "📨 Evidence submitted to the bank.");
        });
      },
    },
    // ---- AI draft (local-only: this path has no route to Stripe) ----
    {
      kind: "button",
      id: "billadmin_dp_ai:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, () => this.runAiDraft(interaction, token));
      },
    },
    // ---- evidence file proof (screenshots/PDFs → Stripe Files API) ----
    {
      kind: "button",
      id: "billadmin_dp_proof:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`billadmin_dp_proofm:${token}`)
            .setTitle("Attach proof for the bank")
            .addLabelComponents(
              new LabelBuilder()
                .setLabel("Screenshot or PDF (max 4MB)")
                .setFileUploadComponent(
                  new FileUploadBuilder().setCustomId("proof_file").setMinValues(1).setMaxValues(1).setRequired(true)
                ),
              new LabelBuilder()
                .setLabel("Evidence slot it proves")
                .setStringSelectMenuComponent(
                  new StringSelectMenuBuilder()
                    .setCustomId("proof_slot")
                    .addOptions(EVIDENCE_FILE_SLOTS.map((s) => ({ label: s.label, value: s.key })))
                )
            )
        );
      },
    },
    {
      kind: "modal",
      id: "billadmin_dp_proofm:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const disputeId = session.disputeId;
        const attachment = interaction.fields.getUploadedFiles("proof_file", true).first();
        const slot = interaction.fields.getStringSelectValues("proof_slot")[0];
        if (!attachment || !EVIDENCE_FILE_SLOTS.some((s) => s.key === slot)) return;

        const contentType = attachment.contentType?.split(";")[0].toLowerCase() ?? "";
        if (!PROOF_TYPES.has(contentType)) {
          await interaction.reply({
            embeds: [makeEmbed("The bank only accepts **PNG, JPEG or PDF** evidence files.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        if (attachment.size > PROOF_MAX_BYTES) {
          await interaction.reply({
            embeds: [
              makeEmbed(
                "File too large — Stripe caps combined dispute evidence around 4.5MB, so keep each proof under **4MB**.",
                COLORS.danger
              ),
            ],
            flags: 64,
          });
          return;
        }

        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          // Guard: file evidence is rejected by Stripe once the response window
          // closed — re-check live before uploading.
          const fresh = await this.ctx.stripe.getDispute(disputeId);
          if (!RESPONDABLE.has(fresh.status)) {
            await this.renderDetail(interaction, token, `⚠️ Status is **${fresh.status}** — evidence files can no longer be attached.`);
            return;
          }
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`Discord CDN download failed (${res.status})`);
          const data = Buffer.from(await res.arrayBuffer());
          const file = await this.ctx.stripe.uploadDisputeEvidenceFile(attachment.name, data, contentType);
          await this.ctx.stripe.updateDisputeEvidence(
            disputeId,
            { [slot]: file.id } as Stripe.DisputeUpdateParams.Evidence,
            false,
            `billadmin-dpfile-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Dispute evidence file staged",
            targetCustomerId: session.customerId,
            objectId: disputeId,
            outcome: `\`${file.id}\` (${attachment.name}, ${Math.round(attachment.size / 1024)}KB) staged as ${slot} (NOT submitted)`,
            severity: "info",
          });
          await this.renderDetail(
            interaction,
            token,
            `📎 \`${attachment.name}\` uploaded and staged as **${slot}** — it reaches the bank when you Submit Evidence.`
          );
        });
      },
    },
    // ---- accept (close as lost) ----
    {
      kind: "button",
      id: "billadmin_dp_accept:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const dispute = await this.ctx.stripe.getDispute(session.disputeId!);
          if (TERMINAL.has(dispute.status)) {
            await this.renderDetail(interaction, token, `⚠️ Dispute is already **${dispute.status}**.`);
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle("Accept dispute")
            .setColor(COLORS.danger)
            .setDescription(
              `⚠️ Accept \`${dispute.id}\` (**${this.ctx.stripe.formatAmount(dispute.amount, dispute.currency)}**, ${dispute.reason})?\n\n` +
                "The dispute closes as **LOST** immediately, the funds stay withdrawn and no evidence can be submitted afterwards. **Irreversible.**"
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_dp_acceptx:${token}`, "Accept Dispute", ButtonStyle.Danger),
                btn(`billadmin_dp_det:${token}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_acceptx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const disputeId = session.disputeId;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          const claimed = await this.ctx.sessionStore.claimBillingAction(
            interaction.user.id,
            `dispute-accept-${disputeId}`,
            "dispute_accept"
          );
          if (!claimed) {
            await this.renderDetail(interaction, token, "⚠️ This dispute was already accepted via the bot.");
            return;
          }
          let result: Stripe.Dispute;
          try {
            result = await this.ctx.stripe.closeDispute(disputeId, `billadmin-dpclose-${disputeId}`);
          } catch (error) {
            await this.ctx.sessionStore.releaseBillingAction(`dispute-accept-${disputeId}`).catch(() => {});
            throw error;
          }
          await this.ctx.disputeStore.upsertFromStripe(result, session.customerId ?? null);
          this.ctx.audit.log(interaction, {
            action: "Dispute accepted",
            targetCustomerId: session.customerId,
            objectId: disputeId,
            amountText: this.ctx.stripe.formatAmount(result.amount, result.currency),
            outcome: `Closed as ${result.status} (conceded)`,
            severity: "danger",
          });
          exportBillingEvent({ event: "dispute_accepted", amountMinor: result.amount, currency: result.currency, chargeId: session.chargeId });
          await this.renderDetail(interaction, token, "🏳️ Dispute accepted — closed as lost.");
        });
      },
    },
    // ---- refund-to-prevent ----
    {
      kind: "button",
      id: "billadmin_dp_refund:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const dispute = await this.ctx.stripe.getDispute(session.disputeId!);
          if (!dispute.is_charge_refundable) {
            await this.renderDetail(interaction, token, "⚠️ Stripe reports this charge as no longer refundable — a refund can't prevent this dispute.");
            return;
          }
          const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
          if (!chargeId) return;
          const charge = await this.ctx.stripe.getCharge(chargeId);
          session.chargeId = chargeId;
          session.refundAmountMinor = null;
          const cus = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
          if (cus) session.customerId = cus;
          await showRefundConfirm(this.ctx, interaction, token, charge, `billadmin_dp_det:${token}`);
        });
      },
    },
    // ---- watch / notes / bookmark ----
    {
      kind: "button",
      id: "billadmin_dp_watch:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const watching = await this.ctx.disputeStore.isWatching(session.disputeId!, interaction.user.id);
          if (watching) await this.ctx.disputeStore.unwatch(session.disputeId!, interaction.user.id);
          else await this.ctx.disputeStore.watch(session.disputeId!, interaction.user.id);
          await this.renderDetail(
            interaction,
            token,
            watching ? "🔕 Unwatched — no more DMs for this dispute." : "🔔 Watching — you'll get a DM when its status changes."
          );
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_notes:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, npageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () =>
          renderNotesPanel(this.ctx, interaction, {
            type: "dispute",
            objectId: session.disputeId!,
            backId: `billadmin_dp_det:${token}`,
            addNoteId: `billadmin_dp_noteadd:${token}`,
            pageBaseId: `billadmin_dp_notes:${token}`,
            page: Math.max(0, Number.parseInt(npageStr, 10) || 0),
          })
        );
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_noteadd:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.showModal(buildNoteModal(`billadmin_dp_notem:${token}`, session.disputeId));
      },
    },
    {
      kind: "modal",
      id: "billadmin_dp_notem:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const text = interaction.fields.getTextInputValue("note_text").trim();
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (text) {
            await this.ctx.qolStore.addNote(
              "dispute",
              session.disputeId!,
              interaction.user.id,
              interaction.user.displayName ?? interaction.user.username,
              text
            );
          }
          await renderNotesPanel(this.ctx, interaction, {
            type: "dispute",
            objectId: session.disputeId!,
            backId: `billadmin_dp_det:${token}`,
            addNoteId: `billadmin_dp_noteadd:${token}`,
            pageBaseId: `billadmin_dp_notes:${token}`,
            notice: text ? "✅ Note added." : undefined,
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_bm:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const row = await this.ctx.disputeStore.get(session.disputeId!);
          const label = row ? `${this.ctx.stripe.formatAmount(row.amount, row.currency)} · ${row.reason}` : null;
          const { bookmarked } = await this.ctx.qolStore.toggleBookmark(
            "dispute",
            session.disputeId!,
            label,
            interaction.user.id,
            interaction.user.displayName ?? interaction.user.username
          );
          await this.renderDetail(interaction, token, bookmarked ? "🔖 Bookmarked for the team." : "Bookmark removed.");
        });
      },
    },
    // ---- block flow (shared by dispute/charge/customer panels) ----
    {
      kind: "button",
      id: "billadmin_blk_open:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, origin, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.blockReturn =
          origin === "dp"
            ? `billadmin_dp_det:${token}`
            : origin === "ch"
              ? `billadmin_ch_det:${token}:${Math.max(0, Number.parseInt(pageStr, 10) || 0)}`
              : origin === "c360"
                ? `billadmin_c360_refresh:${token}`
                : `billadmin_dp_home:${token}`;
        await this.ctx.sessions.tryRender(interaction, async () => {
          session.blockCandidates = await this.deriveBlockCandidates(session);
          session.blockSel = [];
          await this.renderBlockPanel(interaction, token);
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_blk_sel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates) return;
        await interaction.deferUpdate();
        session.blockSel = interaction.values;
        await this.ctx.sessions.tryRender(interaction, () => this.renderBlockPanel(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_blk_panel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderBlockPanel(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_blk_ip:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates) return;
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`billadmin_blk_ipm:${token}`)
            .setTitle("Add IP address to block")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                textInput("ip", "IP address (IPv4 or IPv6)", {
                  required: true,
                  placeholder: "Stripe never exposes the payment IP via API — enter it manually",
                  maxLength: 45,
                })
              )
            )
        );
      },
    },
    {
      kind: "modal",
      id: "billadmin_blk_ipm:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates) return;
        const ip = interaction.fields.getTextInputValue("ip").trim();
        if (!IPV4_RE.test(ip) && !(ip.includes(":") && IPV6ISH_RE.test(ip))) {
          await interaction.reply({
            embeds: [makeEmbed("That doesn't look like a valid IPv4/IPv6 address.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (!session.blockCandidates!.some((c) => c.kind === "ip_address" && c.value === ip)) {
            session.blockCandidates!.push({ kind: "ip_address", value: ip });
          }
          const idx = session.blockCandidates!.findIndex((c) => c.kind === "ip_address" && c.value === ip);
          session.blockSel = [...new Set([...(session.blockSel ?? []), `i:${idx}`])];
          await this.renderBlockPanel(interaction, token);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_blk_go:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockSel?.length) return;
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`billadmin_blk_rm:${token}`)
            .setTitle("Block reason")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                textInput("reason", "Reason (shown on panels + audit)", {
                  required: true,
                  maxLength: 300,
                  value: session.disputeId ? `Dispute ${session.disputeId}` : undefined,
                })
              )
            )
        );
      },
    },
    {
      kind: "modal",
      id: "billadmin_blk_rm:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates || !session.blockSel?.length) return;
        session.blockReason = interaction.fields.getTextInputValue("reason").trim() || "Blocked via /billing";
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const entries = this.selectedBlockEntries(session);
          const cancelsSubs = entries.some((e) => e.kind === "customer_id");
          const embed = new EmbedBuilder()
            .setTitle("Confirm block")
            .setColor(COLORS.danger)
            .setDescription(
              [
                "These identifiers go on the Radar value lists (blocking future payments once the Dashboard rules reference the lists) AND the bot's local blocklist (self-service refunds denied, panels flagged):",
                "",
                ...entries.map((e) => `• **${BLOCK_KIND_LABELS[e.kind]}** — \`${e.value.slice(0, 90)}\``),
                "",
                `Reason: ${session.blockReason}`,
                cancelsSubs ? "⚠️ Blocking the **customer** also cancels ALL their active subscriptions." : null,
              ]
                .filter((line) => line !== null)
                .join("\n")
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_blk_x:${token}`, "Confirm Block", ButtonStyle.Danger),
                btn(`billadmin_blk_panel:${token}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_blk_x:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.blockCandidates || !session.blockSel?.length) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          const entries = this.selectedBlockEntries(session);
          const results = await this.ctx.blockService.block(entries, {
            reason: session.blockReason ?? "Blocked via /billing",
            source: "manual",
            actorId: interaction.user.id,
            actorName: interaction.user.displayName ?? interaction.user.username,
            customerId: session.customerId ?? entries.find((e) => e.kind === "customer_id")?.value ?? null,
            disputeId: session.disputeId ?? null,
            cancelSubs: true,
          });
          for (const r of results) {
            this.ctx.audit.log(interaction, {
              action: "Block identifier",
              targetCustomerId: session.customerId,
              objectId: `${r.kind}:${r.value.slice(0, 60)}`,
              outcome: r.ok
                ? `${r.alreadyBlocked ? "Already blocked (refreshed)" : "Blocked"}${r.cancelledSubs?.length ? ` · cancelled ${r.cancelledSubs.length} sub(s)` : ""}${r.failedSubs?.length ? ` · ⚠️ ${r.failedSubs.length} cancel(s) FAILED` : ""}`
                : `FAILED — ${r.error?.slice(0, 300)}`,
              severity: r.ok ? "warn" : "danger",
            });
            if (r.ok) exportBillingEvent({ event: "block", chargeId: session.chargeId });
          }
          const lines = results.map((r) =>
            r.ok
              ? `✅ ${BLOCK_KIND_LABELS[r.kind]} \`${r.value.slice(0, 80)}\`${r.alreadyBlocked ? " (was already blocked)" : ""}${
                  r.cancelledSubs?.length ? ` · ${r.cancelledSubs.length} sub(s) cancelled` : ""
                }${r.failedSubs?.length ? ` · ⚠️ ${r.failedSubs.length} sub cancel(s) failed` : ""}`
              : `⚠️ ${BLOCK_KIND_LABELS[r.kind]} \`${r.value.slice(0, 80)}\` — ${r.error?.slice(0, 150)}`
          );
          const embed = new EmbedBuilder()
            .setTitle("Block result")
            .setColor(results.every((r) => r.ok) ? COLORS.success : COLORS.warn)
            .setDescription(
              [...lines, "", "Reminder: Radar value lists only block payments once a Dashboard rule references them (see /config → Billing → Disputes)."].join("\n")
            );
          await interaction.editReply({
            embeds: [embed],
            components: [buttonRow(btn(session.blockReturn ?? `billadmin_dp_home:${token}`, "Back", ButtonStyle.Secondary))],
          });
        });
      },
    },
    // ---- blocklist board ----
    {
      kind: "button",
      id: "billadmin_blk_list:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderBlocklist(interaction, token, page));
      },
    },
    {
      kind: "select",
      id: "billadmin_blk_unsel:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        const rowId = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, async () => {
          const row = await this.ctx.blockStore.get(rowId);
          if (!row) {
            await this.renderBlocklist(interaction, token, page, "That entry no longer exists.");
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle("Confirm unblock")
            .setColor(COLORS.warn)
            .setDescription(
              `Remove **${BLOCK_KIND_LABELS[row.kind as BlockKind] ?? row.kind}** \`${row.value.slice(0, 90)}\` from the Radar value list and the local blocklist?\n\nReason it was blocked: ${row.reason.slice(0, 300)}`
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_blk_unx:${token}:${rowId}:${page}`, "Unblock", ButtonStyle.Danger),
                btn(`billadmin_blk_list:${token}:${page}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_blk_unx:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, rowId, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          const result = await this.ctx.blockService.unblock(rowId);
          if (!result) {
            await this.renderBlocklist(interaction, token, page, "That entry was already removed.");
            return;
          }
          this.ctx.audit.log(interaction, {
            action: "Unblock identifier",
            targetCustomerId: result.removed.customerId ?? undefined,
            objectId: `${result.removed.kind}:${result.removed.value.slice(0, 60)}`,
            outcome: `Removed from blocklist${result.removed.radarItemId ? " + Radar list" : ""}`,
            severity: "info",
          });
          exportBillingEvent({ event: "unblock" });
          await this.renderBlocklist(interaction, token, page, `✅ Unblocked \`${result.removed.value.slice(0, 80)}\`.`);
        });
      },
    },
    // ---- alert-message entry points (no session: ids embedded in customIds) ----
    // These buttons live on SHARED channel messages — always reply ephemerally,
    // never update the alert itself; ids are validated before any Stripe call.
    {
      kind: "button",
      id: "billadmin_dpa_open:",
      match: "prefix",
      handler: async (interaction) => {
        const disputeId = interaction.customId.split(":")[1];
        if (!DISPUTE_ID_RE.test(disputeId)) return;
        await interaction.deferReply({ flags: 64 });
        const token = this.ctx.sessions.newSession(interaction, { disputeId, originHub: "pay" });
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_dpa_block:",
      match: "prefix",
      handler: async (interaction) => {
        const chargeId = interaction.customId.split(":")[1];
        if (!CHARGE_ID_RE.test(chargeId)) return;
        await interaction.deferReply({ flags: 64 });
        const token = this.ctx.sessions.newSession(interaction, { chargeId, originHub: "pay" });
        const session = this.ctx.sessions.get(token)!;
        session.blockReturn = `billadmin_dp_home:${token}`;
        await this.ctx.sessions.tryRender(interaction, async () => {
          session.blockCandidates = await this.deriveBlockCandidates(session);
          session.blockSel = [];
          await this.renderBlockPanel(interaction, token);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dpa_refund:",
      match: "prefix",
      handler: async (interaction) => {
        const chargeId = interaction.customId.split(":")[1];
        if (!CHARGE_ID_RE.test(chargeId)) return;
        await interaction.deferReply({ flags: 64 });
        const token = this.ctx.sessions.newSession(interaction, { chargeId, originHub: "pay" });
        const session = this.ctx.sessions.get(token)!;
        await this.ctx.sessions.tryRender(interaction, async () => {
          const charge = await this.ctx.stripe.getCharge(chargeId);
          if (charge.refunded) {
            await interaction.editReply({
              embeds: [makeEmbed("This charge is already fully refunded.", COLORS.warn)],
              components: [buttonRow(btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary))],
            });
            return;
          }
          const dispute = charge.disputed ? await this.ctx.stripe.getDisputeForCharge(chargeId) : null;
          if (dispute && !dispute.is_charge_refundable) {
            await interaction.editReply({
              embeds: [
                makeEmbed(
                  `Dispute \`${dispute.id}\` is **${dispute.status}** and Stripe reports the charge as no longer refundable — a refund can't prevent it anymore.`,
                  COLORS.warn
                ),
              ],
              components: [buttonRow(btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary))],
            });
            return;
          }
          session.refundAmountMinor = null;
          const cus = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
          if (cus) session.customerId = cus;
          await showRefundConfirm(this.ctx, interaction, token, charge, `billadmin_dp_home:${token}`);
        });
      },
    },
    // ---- shared bookmark board + Jump-to-ID (root panel) ----
    {
      kind: "button",
      id: "billadmin_bm_list",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        const token = this.ctx.sessions.newSession(interaction, {});
        await this.ctx.sessions.tryRender(interaction, () => this.renderBookmarks(interaction, token, 0));
      },
    },
    {
      kind: "button",
      id: "billadmin_bm_page:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderBookmarks(interaction, token, page));
      },
    },
    {
      kind: "select",
      id: "billadmin_bm_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        pushNav(session, `billadmin_bm_page:${token}:${page}`);
        const [type, objectId] = interaction.values[0].split("|");
        await this.ctx.sessions.tryRender(interaction, () => this.jumpTo(interaction, token, type, objectId));
      },
    },
    {
      kind: "button",
      id: "billadmin_jump",
      match: "exact",
      handler: async (interaction) => {
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId("billadmin_jump_modal")
            .setTitle("Jump to a Stripe ID")
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                textInput("target_id", "Stripe id (cus_ / ch_ / py_ / dp_ / du_)", {
                  required: true,
                  placeholder: "e.g. cus_ABC123, ch_3XYZ…, dp_1ABC…",
                  maxLength: 80,
                })
              )
            )
        );
      },
    },
    {
      kind: "modal",
      id: "billadmin_jump_modal",
      match: "exact",
      handler: async (interaction) => {
        const raw = interaction.fields.getTextInputValue("target_id").trim();
        const type = CUSTOMER_ID_RE.test(raw) ? "c" : CHARGE_ID_RE.test(raw) ? "h" : DISPUTE_ID_RE.test(raw) ? "d" : null;
        if (!type) {
          await interaction.reply({
            embeds: [makeEmbed("Unrecognized id — expected `cus_…`, `ch_…`/`py_…`, or `dp_…`/`du_…`.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        await this.ctx.sessions.ackModal(interaction);
        const token = this.ctx.sessions.newSession(interaction, {});
        await this.ctx.sessions.tryRender(interaction, () => this.jumpTo(interaction, token, type, raw));
      },
    },
  ];

  // ---- renderers ----

  async renderOverview(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    session.originHub ??= "pay";

    const [{ rows, total }, closed, ratios] = await Promise.all([
      this.ctx.disputeStore.listOpen(page * PAGE_SIZE, PAGE_SIZE),
      this.ctx.disputeStore.closedSummarySince(90),
      this.ctx.ratio.get().catch((error) => {
        logger.warn("ratio computation failed", { error: String(error) });
        return null;
      }),
    ]);

    const now = Date.now();
    const lines = rows.map((d) => {
      const dueMs = d.evidenceDueBy?.getTime() ?? null;
      const bullet = dueMs == null ? "🔵" : dueMs - now < 48 * 3600_000 ? "🔴" : "🟠";
      const due = d.evidenceDueBy ? ` · due <t:${Math.floor(d.evidenceDueBy.getTime() / 1000)}:R>` : "";
      const submitted = d.evidenceSubmittedAt ? " · 📨 submitted" : "";
      return `${bullet} \`${d.id}\` · **${this.ctx.stripe.formatAmount(d.amount, d.currency)}** · ${d.reason} · ${d.status}${due}${submitted}`;
    });

    const ratioBlock = ratios
      ? [
          describeRatioWindow("This month", ratios.month, ratios.truncated),
          describeRatioWindow("Trailing 30d", ratios.d30, ratios.truncated),
          describeRatioWindow("Trailing 90d", ratios.d90, ratios.truncated),
        ].join("\n")
      : "*Ratio unavailable (charges.search failed — see logs).*";
    const cachedAt = this.ctx.ratio.cachedAt();

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Disputes")
      .setColor(rows.some((d) => d.evidenceDueBy && d.evidenceDueBy.getTime() - now < 48 * 3600_000) ? COLORS.danger : total > 0 ? COLORS.warn : COLORS.brand)
      .setDescription(
        [
          notice,
          ratioBlock,
          "",
          `**Open disputes (${total})**${total > PAGE_SIZE ? ` · page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))}` : ""}`,
          lines.length ? lines.join("\n") : "None 🎉",
          closed.won + closed.lost + closed.otherClosed > 0
            ? `\nClosed in the last 90d: **${closed.won}** won · **${closed.lost}** lost${closed.otherClosed ? ` · **${closed.otherClosed}** other (prevented / inquiry closed)` : ""}`
            : undefined,
        ]
          .filter((line) => line !== undefined)
          .join("\n")
          .slice(0, 4096)
      )
      .setFooter({
        text: `Plain = chargebacks ÷ succeeded charges · VAMP-style = (EFW ∪ chargeback charges) ÷ succeeded, directional${
          cachedAt ? ` · ratio computed <${Math.max(1, Math.round((now - cachedAt) / 60000))}m ago` : ""
        } · local mirror, Sync pulls fresh from Stripe`,
      });

    const components: Panel["components"] = [];
    if (rows.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_dp_pick:${token}:${page}`)
            .setPlaceholder("Open a dispute…")
            .addOptions(
              rows.slice(0, 25).map((d) => ({
                label: `${this.ctx.stripe.formatAmount(d.amount, d.currency)} · ${d.reason} · ${d.status}`.slice(0, 100),
                description: `${d.id}${d.evidenceDueBy ? ` · due ${d.evidenceDueBy.toISOString().slice(0, 10)}` : ""}`.slice(0, 100),
                value: d.id,
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_dp_page:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_dp_page:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * PAGE_SIZE >= total),
        btn(`billadmin_blk_list:${token}:0`, "Blocklist", ButtonStyle.Secondary),
        btn(`billadmin_dp_sync:${token}`, "Sync from Stripe", ButtonStyle.Secondary),
        btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  private async renderDetail(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.disputeId) return;

    let dispute: Stripe.Dispute;
    try {
      dispute = await this.ctx.stripe.getDispute(session.disputeId);
    } catch (error) {
      const code = (error as Stripe.errors.StripeError).code;
      if (code === "resource_missing") {
        await interaction.editReply({
          embeds: [makeEmbed(`Dispute \`${session.disputeId}\` no longer exists at Stripe.`, COLORS.warn)],
          components: [buttonRow(btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary))],
        });
        return;
      }
      throw error;
    }

    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    if (chargeId) session.chargeId = chargeId;

    const localBefore = await this.ctx.disputeStore.get(dispute.id);
    const customerId =
      localBefore?.customerId ??
      (chargeId ? await this.ctx.stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    if (customerId) session.customerId = customerId;
    const local = await this.ctx.disputeStore.upsertFromStripe(dispute, customerId);

    const [linkedIds, watching, bookmarked, latestNote, noteCount] = await Promise.all([
      customerId ? this.ctx.sessionStore.findDiscordIdsByStripeId(customerId) : Promise.resolve([]),
      this.ctx.disputeStore.isWatching(dispute.id, session.ownerUserId),
      this.ctx.qolStore.isBookmarked("dispute", dispute.id),
      this.ctx.qolStore.latestNote("dispute", dispute.id),
      this.ctx.qolStore.countNotes("dispute", dispute.id),
    ]);

    const fmt = (v: number) => this.ctx.stripe.formatAmount(v, dispute.currency);
    const bts = dispute.balance_transactions ?? [];
    const feeText = bts.length
      ? `${this.ctx.stripe.formatAmount(
          bts.reduce((sum, bt) => sum + (bt.fee ?? 0), 0),
          bts[0].currency
        )} fee · net ${this.ctx.stripe.formatAmount(
          bts.reduce((sum, bt) => sum + (bt.net ?? 0), 0),
          bts[0].currency
        )}`
      : "—";
    const ed = dispute.evidence_details;
    const dueText = ed?.due_by ? `<t:${ed.due_by}:R> (<t:${ed.due_by}:f>)${ed.past_due ? " · ⚠️ PAST DUE" : ""}` : "no response window";
    const draftFields = Object.keys((local.evidenceDraft ?? {}) as Record<string, string>).length;
    const stagedFiles = dispute.evidence
      ? EVIDENCE_FILE_KEYS.filter((key) => (dispute.evidence as unknown as Record<string, unknown>)[key])
      : [];
    const evidenceState = [
      draftFields ? `local draft: ${draftFields} field(s)` : "no local draft",
      ed?.has_evidence ? "staged at Stripe" : "nothing staged",
      stagedFiles.length ? `📎 files: ${stagedFiles.join(", ")}` : null,
      local.evidenceSubmittedAt
        ? `submitted <t:${Math.floor(local.evidenceSubmittedAt.getTime() / 1000)}:R>`
        : `submissions: ${ed?.submission_count ?? 0}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const card = dispute.payment_method_details?.card;
    const cardText = card
      ? `${card.brand ?? "card"}${card.case_type ? ` · ${card.case_type}` : ""}${card.network_reason_code ? ` · network code ${card.network_reason_code}` : ""}`
      : "—";
    const linked = linkedIds.length
      ? `${linkedIds.map((id) => `<@${id}>`).join(", ")} (\`${customerId}\`)`
      : customerId
        ? `\`${customerId}\` (no linked Discord user)`
        : "—";
    const respondable = RESPONDABLE.has(dispute.status);
    const terminal = TERMINAL.has(dispute.status);
    const eligibility = ed && "enhanced_eligibility_types" in ed && Array.isArray(ed.enhanced_eligibility_types) && ed.enhanced_eligibility_types.length
      ? ed.enhanced_eligibility_types.join(", ")
      : null;

    const statusEmoji = dispute.status === "won" ? "🏆" : dispute.status === "lost" ? "❌" : dispute.status === "prevented" ? "🛑" : "🚩";
    const embed = new EmbedBuilder()
      .setTitle(`${statusEmoji} Dispute — \`${dispute.id}\``)
      .setColor(terminal ? (dispute.status === "won" || dispute.status === "prevented" ? COLORS.success : COLORS.neutral) : COLORS.danger)
      .addFields(
        { name: "Amount", value: `**${fmt(dispute.amount)}**`, inline: true },
        { name: "Fees / net", value: feeText, inline: true },
        { name: "Status", value: dispute.status, inline: true },
        { name: "Reason", value: dispute.reason || "unknown", inline: true },
        { name: "Opened", value: `<t:${dispute.created}:D>`, inline: true },
        { name: "Evidence due", value: dueText, inline: true },
        { name: "Evidence", value: evidenceState.slice(0, 1024), inline: false },
        { name: "Charge", value: chargeId ? `\`${chargeId}\`` : "—", inline: true },
        { name: "Card", value: cardText.slice(0, 1024), inline: true },
        { name: "Refundable", value: dispute.is_charge_refundable ? "yes — refund can still prevent it" : "no", inline: true },
        { name: "Customer", value: linked.slice(0, 1024), inline: false },
        ...(eligibility
          ? [{ name: "Enhanced eligibility", value: `${eligibility} — compelling-evidence flows live in the Stripe Dashboard`.slice(0, 1024), inline: false }]
          : []),
        ...(latestNote
          ? [
              {
                name: `Latest note (${noteCount})`,
                value: `<t:${Math.floor(latestNote.createdAt.getTime() / 1000)}:R> **${latestNote.authorName}** — ${latestNote.text}`.slice(0, 1024),
                inline: false,
              },
            ]
          : [])
      );
    if (notice) embed.setDescription(notice.slice(0, 4096));

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_dp_ev_edit:${token}`, "Edit Evidence", ButtonStyle.Primary, !respondable),
          btn(`billadmin_dp_ai:${token}`, "AI Draft", ButtonStyle.Primary, !respondable),
          btn(`billadmin_dp_proof:${token}`, "Attach Proof", ButtonStyle.Primary, !respondable),
          btn(`billadmin_dp_ev_submit:${token}`, "Submit Evidence", ButtonStyle.Danger, !respondable || !(ed?.has_evidence || draftFields > 0)),
          btn(`billadmin_dp_accept:${token}`, "Accept Dispute", ButtonStyle.Danger, terminal)
        ),
        buttonRow(
          btn(`billadmin_dp_refund:${token}`, "Refund to Prevent", ButtonStyle.Secondary, !dispute.is_charge_refundable),
          btn(`billadmin_blk_open:${token}:dp`, "Block…", ButtonStyle.Danger),
          btn(`billadmin_dp_notes:${token}`, "Notes", ButtonStyle.Secondary),
          btn(`billadmin_dp_bm:${token}`, bookmarked ? "Remove Bookmark" : "Bookmark", ButtonStyle.Secondary),
          btn(`billadmin_dp_watch:${token}`, watching ? "Unwatch" : "Watch", ButtonStyle.Secondary)
        ),
        buttonRow(btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)),
      ],
    });
  }

  // ---- AI evidence draft (saves a LOCAL draft only) ----

  private async runAiDraft(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.disputeId) return;
    const dispute = await this.ctx.stripe.getDispute(session.disputeId);
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const charge = chargeId ? await this.ctx.stripe.getCharge(chargeId).catch(() => null) : null;
    const customerId = charge
      ? typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null)
      : (session.customerId ?? null);
    const customer = customerId ? await this.ctx.stripe.getCustomer(customerId).catch(() => null) : null;
    const subs = customerId ? await this.ctx.stripe.listSubscriptions(customerId).catch(() => []) : [];

    const fields = evidenceFieldsFor(dispute.reason).map((f) => f.key);
    const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
    const prompt = buildDisputeEvidencePrompt({
      disputeId: dispute.id,
      reason: dispute.reason || "unknown",
      status: dispute.status,
      amountText: this.ctx.stripe.formatAmount(dispute.amount, dispute.currency),
      disputeCreated: iso(dispute.created),
      evidenceDueBy: dispute.evidence_details?.due_by ? iso(dispute.evidence_details.due_by) : null,
      charge: charge
        ? {
            id: charge.id,
            created: iso(charge.created),
            amountText: this.ctx.stripe.formatAmount(charge.amount, charge.currency),
            description: charge.description ?? null,
            cardBrand: charge.payment_method_details?.card?.brand ?? null,
            cardLast4: charge.payment_method_details?.card?.last4 ?? null,
          }
        : null,
      customer: customer
        ? { id: customer.id, email: customer.email ?? null, name: customer.name ?? null, created: iso(customer.created) }
        : null,
      subscriptions: subs.slice(0, 5).map((sub) => ({
        plan: subPlanLabel(this.ctx.stripe, sub),
        status: sub.status,
        started: iso(sub.created),
      })),
      fields,
    });

    // Claude Code CLI run with Read/Glob/Grep over the cloned Postiz source +
    // docs (same knowledge base as /ai), bounded by the /config → AI ask
    // levers. Filling policy fields requires actually finding the terms.
    const effortRaw = this.ctx.settingsStore.aiEffortAsk();
    const effort = effortRaw === "low" || effortRaw === "high" || effortRaw === "max" ? effortRaw : "medium";
    const messages = await this.ctx.claudeRunner.run(prompt, undefined, {
      promptPrefix: null,
      model: this.ctx.settingsStore.aiModel(),
      effort,
      maxBudgetUsd: this.ctx.settingsStore.aiMaxBudgetUsdAsk(),
      timeoutMs: 300_000,
      telemetry: { agentName: "ai-dispute-evidence", kind: "staff_command" },
    });

    // The final message carries the JSON; earlier ones are research narration.
    // Scan backwards for the first parseable object; fall back to the raw tail
    // as the uncategorized narrative rather than losing the run.
    let draft: Record<string, string> = {};
    for (let i = messages.length - 1; i >= 0 && Object.keys(draft).length === 0; i--) {
      const cleaned = messages[i]
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end <= start) continue;
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
        for (const key of fields) {
          const value = parsed[key];
          if (typeof value === "string" && value.trim()) draft[key] = value.trim().slice(0, 3800);
        }
      } catch {
        // keep scanning earlier messages
      }
    }
    if (Object.keys(draft).length === 0) {
      draft = { uncategorized_text: (messages[messages.length - 1] ?? "").trim().slice(0, 3800) };
    }

    await this.ctx.disputeStore.saveEvidenceDraft(dispute.id, draft);
    this.ctx.audit.log(interaction, {
      action: "Dispute AI evidence draft",
      targetCustomerId: customerId ?? undefined,
      objectId: dispute.id,
      outcome: `Draft saved locally (${Object.keys(draft).length} field(s)) — nothing sent to Stripe`,
      severity: "info",
    });
    await this.renderDetail(
      interaction,
      token,
      "🤖 AI draft saved **locally** — open **Edit Evidence** to review/adjust, then Save + Submit. Nothing was sent to Stripe."
    );
  }

  // ---- block flow helpers ----

  private async deriveBlockCandidates(session: BillAdminSession): Promise<{ kind: string; value: string }[]> {
    const candidates: { kind: string; value: string }[] = [];
    const push = (kind: BlockKind, value: string | null | undefined) => {
      if (value && !candidates.some((c) => c.kind === kind && c.value === value)) candidates.push({ kind, value });
    };
    if (session.chargeId) {
      const ids = await this.ctx.stripe.getChargeBlockIdentifiers(session.chargeId);
      push("card_fingerprint", ids.cardFingerprint);
      push("email", ids.email);
      push("customer_id", ids.customerId ?? session.customerId);
      if (ids.customerId) session.customerId = ids.customerId;
    } else if (session.customerId) {
      const customer = await this.ctx.stripe.getCustomer(session.customerId).catch(() => null);
      push("customer_id", session.customerId);
      push("email", customer?.email);
    }
    return candidates;
  }

  private selectedBlockEntries(session: BillAdminSession): { kind: BlockKind; value: string }[] {
    const candidates = session.blockCandidates ?? [];
    return (session.blockSel ?? [])
      .map((sel) => {
        const idx = Number.parseInt(sel.slice(2), 10);
        return candidates[idx];
      })
      .filter((c): c is { kind: string; value: string } => !!c)
      .map((c) => ({ kind: c.kind as BlockKind, value: c.value }));
  }

  private async renderBlockPanel(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.blockCandidates) return;
    const candidates = session.blockCandidates;
    const selected = new Set(session.blockSel ?? []);

    const embed = new EmbedBuilder()
      .setTitle("⛔ Block identifiers")
      .setColor(COLORS.danger)
      .setDescription(
        [
          notice,
          "Pick which identifiers to block. Each goes on a **Stripe Radar value list** (blocks future payments once the Dashboard rules reference the lists — see /config → Billing → Disputes) and the bot's **local blocklist** (self-service refunds denied, staff panels flagged).",
          "",
          candidates.length
            ? candidates
                .map((c, idx) => `${selected.has(`i:${idx}`) ? "☑️" : "▫️"} **${BLOCK_KIND_LABELS[c.kind as BlockKind] ?? c.kind}** — \`${c.value.slice(0, 90)}\``)
                .join("\n")
            : "*No identifiers derivable — add an IP manually or open the flow from a charge.*",
          "",
          "The payment IP is never exposed by Stripe's API — use **Add IP** to enter one manually.",
        ]
          .filter((line) => line !== undefined)
          .join("\n")
      );

    const components: Panel["components"] = [];
    if (candidates.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_blk_sel:${token}`)
            .setPlaceholder("Select identifiers to block…")
            .setMinValues(0)
            .setMaxValues(Math.min(candidates.length, 25))
            .addOptions(
              candidates.slice(0, 25).map((c, idx) => ({
                label: `${BLOCK_KIND_LABELS[c.kind as BlockKind] ?? c.kind}: ${c.value}`.slice(0, 100),
                value: `i:${idx}`,
                default: selected.has(`i:${idx}`),
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_blk_ip:${token}`, "Add IP", ButtonStyle.Secondary),
        btn(`billadmin_blk_go:${token}`, "Block Selected", ButtonStyle.Danger, selected.size === 0),
        btn(session.blockReturn ?? `billadmin_dp_home:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  private async renderBlocklist(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const { rows, total } = await this.ctx.blockStore.listPage(page * PAGE_SIZE, PAGE_SIZE);
    const lines = rows.map(
      (r) =>
        `**${BLOCK_KIND_LABELS[r.kind as BlockKind] ?? r.kind}** \`${r.value.slice(0, 60)}\` · ${r.source === "auto_dispute" ? "🤖 auto" : `by ${r.actorName ?? "?"}`} · <t:${Math.floor(r.createdAt.getTime() / 1000)}:R>\n↳ ${r.reason.slice(0, 150)}`
    );
    const embed = new EmbedBuilder()
      .setTitle(`⛔ Blocklist (${total})`)
      .setColor(total ? COLORS.warn : COLORS.brand)
      .setDescription([notice, lines.length ? lines.join("\n") : "Nothing blocked."].filter(Boolean).join("\n\n").slice(0, 4096))
      .setFooter({ text: `Page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} · unblocking also removes the Radar item` });

    const components: Panel["components"] = [];
    if (rows.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_blk_unsel:${token}:${page}`)
            .setPlaceholder("Unblock an entry…")
            .addOptions(
              rows.slice(0, 25).map((r) => ({
                label: `${BLOCK_KIND_LABELS[r.kind as BlockKind] ?? r.kind}: ${r.value}`.slice(0, 100),
                description: r.reason.slice(0, 100),
                value: r.id,
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_blk_list:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_blk_list:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * PAGE_SIZE >= total),
        btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary),
        btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- bookmark board + jump ----

  private async renderBookmarks(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const { rows, total } = await this.ctx.qolStore.listBookmarks(page * PAGE_SIZE, PAGE_SIZE);
    const typeEmoji: Record<string, string> = { dispute: "🚩", customer: "👤", charge: "💳" };
    const lines = rows.map(
      (b) =>
        `${typeEmoji[b.objectType] ?? "🔖"} \`${b.objectId}\`${b.label ? ` — ${b.label.slice(0, 80)}` : ""} · added by ${b.addedByName} <t:${Math.floor(b.createdAt.getTime() / 1000)}:R>`
    );
    const embed = new EmbedBuilder()
      .setTitle(`🔖 Team Bookmarks (${total})`)
      .setColor(COLORS.brand)
      .setDescription(lines.length ? lines.join("\n").slice(0, 4096) : "Nothing bookmarked yet — use the Bookmark button on a dispute, customer or charge panel.")
      .setFooter({ text: `Page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} · one shared list for the whole team` });

    const components: Panel["components"] = [];
    if (rows.length) {
      const typeKey: Record<string, string> = { dispute: "d", customer: "c", charge: "h" };
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_bm_pick:${token}:${page}`)
            .setPlaceholder("Open a bookmark…")
            .addOptions(
              rows.slice(0, 25).map((b) => ({
                label: `${b.label ?? b.objectId}`.slice(0, 100),
                description: `${b.objectType} · ${b.objectId}`.slice(0, 100),
                value: `${typeKey[b.objectType] ?? "d"}|${b.objectId}`.slice(0, 100),
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_bm_page:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_bm_page:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * PAGE_SIZE >= total),
        btn("billadmin_root", "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // Route a validated Stripe id to its detail panel (Jump-to-ID + bookmarks).
  private async jumpTo(interaction: RenderInteraction, token: string, type: string, objectId: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    if (type === "c" && CUSTOMER_ID_RE.test(objectId)) {
      session.customerId = objectId;
      session.originHub ??= "customers";
      if (!this.handlers) throw new Error("Disputes hub handlers not bound");
      await this.handlers.renderCustomerOverview(interaction, token);
      return;
    }
    if (type === "h" && CHARGE_ID_RE.test(objectId)) {
      session.chargeId = objectId;
      session.originHub ??= "charges";
      if (!this.handlers) throw new Error("Disputes hub handlers not bound");
      await this.handlers.renderChargeDetail(interaction, token, 0);
      return;
    }
    if (type === "d" && DISPUTE_ID_RE.test(objectId)) {
      session.disputeId = objectId;
      session.originHub ??= "pay";
      await this.renderDetail(interaction, token);
      return;
    }
    await interaction.editReply({
      embeds: [makeEmbed("Unrecognized or malformed id.", COLORS.danger)],
      components: [buttonRow(btn("billadmin_root", "Back", ButtonStyle.Secondary))],
    });
  }
}
