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
import { safeFetch } from "../../../util/safeFetch";
import { exportBillingEvent } from "../../../metrics/MetricsExporter";
import { buildDisputeEvidencePrompt, buildDisputeEvidenceReviewPrompt } from "../../aiPrompts";
import type { LightAiAttachment } from "../../LightAiRunner";
import { attachReceiptEvidence } from "../receiptEvidence";
import { btn, buttonRow, selectRow, subPlanLabel, textInput } from "../ui";
import { buildNoteModal, renderNotesPanel } from "../qolUi";
import { showRefundConfirm } from "./ChargesHub";
import { reconcileDisputes } from "../DisputeMonitor";
import { describeRatioWindow } from "../disputeRatio";
import { BLOCK_KIND_LABELS, type BlockKind } from "../BlockStore";
import {
  OPEN_DISPUTE_STATUSES,
  RESPONDABLE_DISPUTE_STATUSES,
  TEXT_EVIDENCE_KEYS,
  type ClosedDisputeFilter,
  type OpenDisputeFilter,
} from "../DisputeStore";
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

// Full Stripe TEXT-evidence coverage, split into ≤5-field groups (Discord's
// modal budget). The evidence editor lists the groups; picking one opens its
// modal. Field keys ARE the Stripe evidence keys (DisputeUpdateParams.Evidence),
// so the modals round-trip 1:1 with what's staged.
interface EvidenceGroup {
  key: string;
  label: string;
  emoji: string;
  fields: EvidenceFieldSpec[];
}

const EVIDENCE_GROUPS: EvidenceGroup[] = [
  {
    key: "core",
    label: "Core response",
    emoji: "📝",
    fields: [
      { key: "product_description", label: "Product / service description", style: TextInputStyle.Paragraph },
      { key: "customer_email_address", label: "Customer email", style: TextInputStyle.Short },
      { key: "service_date", label: "Service date", style: TextInputStyle.Short },
      { key: "access_activity_log", label: "Access / usage activity log", style: TextInputStyle.Paragraph },
      { key: "uncategorized_text", label: "Response narrative", style: TextInputStyle.Paragraph },
    ],
  },
  {
    key: "policy",
    label: "Policies & rebuttal",
    emoji: "📜",
    fields: [
      { key: "refund_policy_disclosure", label: "Refund policy disclosure", style: TextInputStyle.Paragraph },
      { key: "refund_refusal_explanation", label: "Refund refusal explanation", style: TextInputStyle.Paragraph },
      { key: "cancellation_policy_disclosure", label: "Cancellation policy disclosure", style: TextInputStyle.Paragraph },
      { key: "cancellation_rebuttal", label: "Cancellation rebuttal", style: TextInputStyle.Paragraph },
    ],
  },
  {
    key: "customer",
    label: "Customer identity",
    emoji: "👤",
    fields: [
      { key: "customer_name", label: "Customer name", style: TextInputStyle.Short },
      { key: "billing_address", label: "Billing address", style: TextInputStyle.Paragraph },
      { key: "customer_purchase_ip", label: "Customer purchase IP", style: TextInputStyle.Short },
    ],
  },
  {
    key: "duplicate",
    label: "Duplicate charge",
    emoji: "🔁",
    fields: [
      { key: "duplicate_charge_id", label: "Original (non-duplicate) charge id", style: TextInputStyle.Short },
      { key: "duplicate_charge_explanation", label: "Why the charges are distinct", style: TextInputStyle.Paragraph },
    ],
  },
  {
    key: "shipping",
    label: "Shipping (physical goods)",
    emoji: "📦",
    fields: [
      { key: "shipping_carrier", label: "Carrier", style: TextInputStyle.Short },
      { key: "shipping_tracking_number", label: "Tracking number", style: TextInputStyle.Short },
      { key: "shipping_date", label: "Shipping date", style: TextInputStyle.Short },
      { key: "shipping_address", label: "Shipping address", style: TextInputStyle.Paragraph },
    ],
  },
];

const POLICY_REASONS = new Set(["subscription_canceled", "credit_not_processed"]);
const EVIDENCE_KEYS = new Set<string>(TEXT_EVIDENCE_KEYS);

// Which groups matter most for a given dispute reason — the editor lists them
// first with a ⭐ and the AI draft fills exactly their fields.
function recommendedGroupKeys(reason: string | null | undefined): string[] {
  if (POLICY_REASONS.has(reason ?? "")) return ["core", "policy"];
  if (reason === "duplicate") return ["duplicate", "core"];
  if (reason === "product_not_received") return ["core", "shipping"];
  return ["core"];
}

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

// Field keys the AI draft fills: the union of the reason's recommended groups.
function aiDraftFieldsFor(reason: string | null | undefined): string[] {
  const groups = recommendedGroupKeys(reason);
  return EVIDENCE_GROUPS.filter((g) => groups.includes(g.key)).flatMap((g) => g.fields.map((f) => f.key));
}

// Shape guards for the AI draft's structured fields — the model has spilled
// narrative text into duplicate_charge_id and an email into the explanation
// before; values that can't possibly be what the field means are dropped
// instead of saved (a missing field beats a provably wrong one at the bank).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATEISH_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./ ]\d{1,2}[./ ]\d{2,4}/;
const AI_DRAFT_VALIDATORS: Record<string, (v: string) => boolean> = {
  duplicate_charge_id: (v) => CHARGE_ID_RE.test(v),
  // A bare email/id is not an explanation of why two charges are distinct.
  duplicate_charge_explanation: (v) => !EMAIL_RE.test(v) && !CHARGE_ID_RE.test(v),
  customer_email_address: (v) => EMAIL_RE.test(v),
  service_date: (v) => v.length <= 80 && DATEISH_RE.test(v),
  shipping_date: (v) => v.length <= 80 && DATEISH_RE.test(v),
  customer_purchase_ip: (v) => IPV4_RE.test(v) || IPV6ISH_RE.test(v),
};

// Overview filter values round-trip through the select as "all" | "s:<status>"
// | "r:<reason>"; history uses "all" | "o:<outcome>" | "r:<reason>".
function parseOpenFilter(v: string | undefined): OpenDisputeFilter | undefined {
  if (!v || v === "all") return undefined;
  if (v.startsWith("s:")) return { status: v.slice(2) };
  if (v.startsWith("r:")) return { reason: v.slice(2) };
  return undefined;
}

function parseClosedFilter(v: string | undefined): ClosedDisputeFilter | undefined {
  if (!v || v === "all") return undefined;
  if (v.startsWith("o:")) {
    const outcome = v.slice(2);
    return outcome === "won" || outcome === "lost" || outcome === "other" ? { outcome } : undefined;
  }
  if (v.startsWith("r:")) return { reason: v.slice(2) };
  return undefined;
}

const SORT_LABELS: Record<"due" | "amount" | "new", string> = {
  due: "Sort: Deadline",
  amount: "Sort: Amount",
  new: "Sort: Newest",
};
const SORT_CYCLE: Array<"due" | "amount" | "new"> = ["due", "amount", "new"];

const OUTCOME_EMOJI: Record<string, string> = { won: "🏆", lost: "❌", prevented: "🛑", warning_closed: "⚪" };

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
    // ---- evidence editor (group picker → per-group modal) ----
    {
      kind: "button",
      id: "billadmin_dp_ev_edit:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderEvidenceEditor(interaction, token));
      },
    },
    {
      kind: "select",
      id: "billadmin_dp_evgsel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const group = EVIDENCE_GROUPS.find((g) => g.key === interaction.values[0]);
        if (!group) return;
        // No defer — showModal must be the first response. Prefill: local
        // draft wins, else what's already staged at Stripe (so opening a group
        // never blanks server-side text on re-save).
        const [row, dispute] = await Promise.all([
          this.ctx.disputeStore.get(session.disputeId),
          this.ctx.stripe.getDispute(session.disputeId),
        ]);
        const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
        const staged = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
        const modal = new ModalBuilder()
          .setCustomId(`billadmin_dp_evm:${token}`)
          .setTitle(`${group.label} — ${session.disputeId}`.slice(0, 45));
        for (const field of group.fields) {
          const stagedValue = typeof staged[field.key] === "string" ? (staged[field.key] as string) : undefined;
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              textInput(field.key, field.label, {
                required: false,
                style: field.style,
                maxLength: 4000,
                value: draft[field.key] ?? stagedValue,
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
            await this.renderEvidenceEditor(interaction, token, "Nothing to save — all evidence fields were empty.");
            return;
          }
          await this.ctx.disputeStore.mergeEvidenceDraft(disputeId, evidence);
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
          await this.renderEvidenceEditor(interaction, token, "💾 Evidence staged at Stripe (not submitted yet).");
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
    // ---- staged-evidence review (read-back of what the bank will get) ----
    {
      kind: "button",
      id: "billadmin_dp_evrev:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderReviewStaged(interaction, token, page));
      },
    },
    // AI critique of the staged package (cheap model + the evidence files as
    // vision/document input). Read-only: renders a verdict, changes nothing.
    {
      kind: "button",
      id: "billadmin_dp_evai:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, () => this.runAiEvidenceReview(interaction, token));
      },
    },
    {
      kind: "select",
      id: "billadmin_dp_fsel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        await interaction.deferUpdate();
        const slot = interaction.values[0];
        if (!(EVIDENCE_FILE_KEYS as readonly string[]).includes(slot)) return;
        await this.ctx.sessions.tryRender(interaction, async () => {
          const embed = new EmbedBuilder()
            .setTitle("Remove staged evidence file")
            .setColor(COLORS.warn)
            .setDescription(
              `Clear the **${slot}** slot for \`${session.disputeId}\`?\n\nThe uploaded file stays in your Stripe account but is detached from this dispute — it will NOT reach the bank. You can attach a new proof afterwards.`
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_dp_frmx:${token}:${slot}`, "Remove File", ButtonStyle.Danger),
                btn(`billadmin_dp_evrev:${token}:0`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_frmx:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, slot] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.disputeId) return;
        const disputeId = session.disputeId;
        if (!(EVIDENCE_FILE_KEYS as readonly string[]).includes(slot)) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.runExclusive(token, interaction, async () => {
          const fresh = await this.ctx.stripe.getDispute(disputeId);
          if (!RESPONDABLE.has(fresh.status)) {
            await this.renderReviewStaged(interaction, token, 0, `⚠️ Status is **${fresh.status}** — evidence can no longer be changed.`);
            return;
          }
          // Emptyable field: "" detaches the file from the dispute.
          await this.ctx.stripe.updateDisputeEvidence(
            disputeId,
            { [slot]: "" } as Stripe.DisputeUpdateParams.Evidence,
            false,
            `billadmin-dpfrm-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Dispute evidence file removed",
            targetCustomerId: session.customerId,
            objectId: disputeId,
            outcome: `Cleared file slot ${slot} (staged only — nothing was submitted)`,
            severity: "info",
          });
          await this.renderReviewStaged(interaction, token, 0, `🗑️ File slot **${slot}** cleared.`);
        });
      },
    },
    // ---- overview filter + sort ----
    {
      kind: "select",
      id: "billadmin_dp_fil:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.dpFilter = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token, 0));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_sort:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const current = session.dpSort ?? "due";
        session.dpSort = SORT_CYCLE[(SORT_CYCLE.indexOf(current) + 1) % SORT_CYCLE.length];
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token, 0));
      },
    },
    // ---- history browser + analytics ----
    {
      kind: "button",
      id: "billadmin_dp_hist:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderHistory(interaction, token, page));
      },
    },
    {
      kind: "select",
      id: "billadmin_dp_hfil:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.dpHistFilter = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, () => this.renderHistory(interaction, token, 0));
      },
    },
    {
      kind: "select",
      id: "billadmin_dp_hpick:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        pushNav(session, `billadmin_dp_hist:${token}:${page}`);
        session.disputeId = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_dp_stats:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderStats(interaction, token));
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
          const res = await safeFetch(attachment.url, { allowHosts: [".discordapp.com", ".discordapp.net"] });
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

    const filter = parseOpenFilter(session.dpFilter);
    const sort = session.dpSort ?? "due";
    const [{ rows, total }, reasons, closed, ratios] = await Promise.all([
      this.ctx.disputeStore.listOpen(page * PAGE_SIZE, PAGE_SIZE, filter, sort),
      this.ctx.disputeStore.openReasons(),
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
          `**Open disputes (${total})**${filter ? ` · filtered: ${filter.status ?? filter.reason}` : ""}${
            total > PAGE_SIZE ? ` · page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))}` : ""
          }`,
          lines.length ? lines.join("\n") : filter ? "No open disputes match this filter." : "None 🎉",
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
    // Filter select: all open + the four open statuses + the reasons present.
    if (total > 0 || filter) {
      const active = session.dpFilter ?? "all";
      const options = [
        { label: "All open disputes", value: "all", default: active === "all" },
        ...OPEN_DISPUTE_STATUSES.map((s) => ({ label: `Status: ${s}`, value: `s:${s}`, default: active === `s:${s}` })),
        ...reasons.slice(0, 20).map((r) => ({
          label: `Reason: ${r.reason} (${r.count})`.slice(0, 100),
          value: `r:${r.reason}`.slice(0, 100),
          default: active === `r:${r.reason}`,
        })),
      ];
      components.push(
        selectRow(
          new StringSelectMenuBuilder().setCustomId(`billadmin_dp_fil:${token}`).setPlaceholder("Filter…").addOptions(options.slice(0, 25))
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_dp_page:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_dp_page:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * PAGE_SIZE >= total),
        btn(`billadmin_dp_sort:${token}`, SORT_LABELS[sort], ButtonStyle.Secondary, total <= 1),
        btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
      ),
      buttonRow(
        btn(`billadmin_dp_hist:${token}:0`, "History", ButtonStyle.Secondary),
        btn(`billadmin_dp_stats:${token}`, "Stats", ButtonStyle.Secondary),
        btn(`billadmin_blk_list:${token}:0`, "Blocklist", ButtonStyle.Secondary),
        btn(`billadmin_dp_sync:${token}`, "Sync from Stripe", ButtonStyle.Secondary)
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
    // Stage-aware refundable text: a bare "yes/no" hides the two states that
    // matter — "refund now and this never becomes a chargeback" vs "already
    // refunded, the warning just hasn't closed yet" (the bank can take days).
    const warningStage = dispute.status === "warning_needs_response" || dispute.status === "warning_under_review";
    let refundableText: string;
    if (terminal) {
      refundableText = "— dispute closed";
    } else if (dispute.is_charge_refundable) {
      refundableText = warningStage
        ? "yes — a **full refund now** prevents this from becoming a formal chargeback"
        : "yes";
    } else if (warningStage) {
      const detailCharge = chargeId ? await this.ctx.stripe.getCharge(chargeId).catch(() => null) : null;
      refundableText = detailCharge?.refunded
        ? "already fully refunded ✅ — waiting for the bank to close this warning (can take a few days)"
        : "no — Stripe no longer allows a refund on this charge";
    } else {
      refundableText = "no — formal chargeback: Stripe rejects refunds, respond with evidence instead";
    }
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
        { name: "Refundable", value: refundableText.slice(0, 1024), inline: true },
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
          // Review works on any dispute with evidence at Stripe — including
          // closed ones (post-mortem of what was actually sent to the bank).
          btn(`billadmin_dp_evrev:${token}:0`, "Review Evidence", ButtonStyle.Primary, !(ed?.has_evidence || stagedFiles.length > 0)),
          btn(`billadmin_dp_ev_submit:${token}`, "Submit Evidence", ButtonStyle.Danger, !respondable || !(ed?.has_evidence || draftFields > 0))
        ),
        buttonRow(
          btn(`billadmin_dp_accept:${token}`, "Accept Dispute", ButtonStyle.Danger, terminal),
          btn(`billadmin_dp_refund:${token}`, "Refund to Prevent", ButtonStyle.Secondary, !dispute.is_charge_refundable),
          btn(`billadmin_blk_open:${token}:dp`, "Block…", ButtonStyle.Danger),
          btn(`billadmin_dp_notes:${token}`, "Notes", ButtonStyle.Secondary),
          btn(`billadmin_dp_bm:${token}`, bookmarked ? "Remove Bookmark" : "Bookmark", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn(`billadmin_dp_watch:${token}`, watching ? "Unwatch" : "Watch", ButtonStyle.Secondary),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ---- evidence editor (field-group picker) ----

  private async renderEvidenceEditor(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.disputeId) return;
    const [row, dispute] = await Promise.all([
      this.ctx.disputeStore.get(session.disputeId),
      this.ctx.stripe.getDispute(session.disputeId),
    ]);
    const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
    const staged = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
    const recommended = recommendedGroupKeys(dispute.reason);
    const respondable = RESPONDABLE.has(dispute.status);

    const groupLine = (g: EvidenceGroup) => {
      const stagedCount = g.fields.filter((f) => typeof staged[f.key] === "string" && (staged[f.key] as string).trim()).length;
      const draftDiffers = g.fields.filter((f) => {
        const d = draft[f.key]?.trim();
        return d && d !== (typeof staged[f.key] === "string" ? (staged[f.key] as string).trim() : "");
      }).length;
      const star = recommended.includes(g.key) ? " ⭐" : "";
      const parts = [
        `${stagedCount}/${g.fields.length} staged`,
        draftDiffers ? `✏️ ${draftDiffers} draft field(s) not staged yet` : null,
      ].filter(Boolean);
      return `${g.emoji} **${g.label}**${star} — ${parts.join(" · ")}`;
    };

    // Recommended groups first, in their recommendation order.
    const ordered = [...EVIDENCE_GROUPS].sort((a, b) => {
      const ai = recommended.indexOf(a.key);
      const bi = recommended.indexOf(b.key);
      return (ai === -1 ? recommended.length : ai) - (bi === -1 ? recommended.length : bi);
    });

    const embed = new EmbedBuilder()
      .setTitle(`📝 Evidence — \`${dispute.id}\``)
      .setColor(respondable ? COLORS.brand : COLORS.warn)
      .setDescription(
        [
          notice,
          `Reason **${dispute.reason}** — ⭐ marks the sections that matter most for it. Pick a section to edit; **Save stages at Stripe** (submit:false, the bank sees nothing until Submit Evidence).`,
          "",
          ...ordered.map(groupLine),
          "",
          "Empty inputs are left untouched — existing staged text is never cleared by saving a blank field.",
          respondable ? null : `⚠️ Status is **${dispute.status}** — evidence can no longer be changed.`,
        ]
          .filter((line) => line !== null && line !== undefined)
          .join("\n")
          .slice(0, 4096)
      );

    const components: Panel["components"] = [];
    if (respondable) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_dp_evgsel:${token}`)
            .setPlaceholder("Edit a section…")
            .addOptions(
              ordered.map((g) => ({
                label: `${g.label}${recommended.includes(g.key) ? " ⭐" : ""}`.slice(0, 100),
                description: g.fields.map((f) => f.key).join(", ").slice(0, 100),
                value: g.key,
                emoji: g.emoji,
              }))
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_dp_evrev:${token}:0`, "Review Evidence", ButtonStyle.Primary, !(dispute.evidence_details?.has_evidence || false)),
        btn(`billadmin_dp_ai:${token}`, "AI Draft", ButtonStyle.Primary, !respondable),
        btn(`billadmin_dp_proof:${token}`, "Attach Proof", ButtonStyle.Primary, !respondable),
        btn(`billadmin_dp_det:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- staged-evidence review (exactly what the bank will receive) ----

  private async renderReviewStaged(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.disputeId) return;
    const [row, dispute] = await Promise.all([
      this.ctx.disputeStore.get(session.disputeId),
      this.ctx.stripe.getDispute(session.disputeId),
    ]);
    const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
    const staged = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
    const respondable = RESPONDABLE.has(dispute.status);
    const ed = dispute.evidence_details;

    const textFields = TEXT_EVIDENCE_KEYS.filter(
      (key) => typeof staged[key] === "string" && (staged[key] as string).trim()
    );
    const files = EVIDENCE_FILE_KEYS.filter((key) => typeof staged[key] === "string" && staged[key]);

    const FIELDS_PER_PAGE = 4;
    const pageCount = Math.max(1, Math.ceil(textFields.length / FIELDS_PER_PAGE));
    const boundedPage = Math.min(page, pageCount - 1);
    const pageFields = textFields.slice(boundedPage * FIELDS_PER_PAGE, (boundedPage + 1) * FIELDS_PER_PAGE);

    // Draft fields that exist locally but aren't staged (or differ) — the
    // things that would be missing if Submit were pressed right now.
    const unstagedDraft: string[] = TEXT_EVIDENCE_KEYS.filter((key) => {
      const d = draft[key]?.trim();
      return d && d !== (typeof staged[key] === "string" ? (staged[key] as string).trim() : "");
    });

    const fieldBlock = (key: string) => {
      const value = (staged[key] as string).trim();
      const differs = unstagedDraft.includes(key) ? " · ✏️ local draft differs" : "";
      const shown = value.length > 350 ? `${value.slice(0, 350)}… _(${value.length} chars total)_` : value;
      return `**${key}** — ${value.length} chars${differs}\n> ${shown.replace(/\n/g, "\n> ")}`;
    };

    const submissions = ed?.submission_count ?? 0;
    const embed = new EmbedBuilder()
      .setTitle(`🔎 Staged evidence — \`${dispute.id}\``)
      .setColor(respondable ? COLORS.brand : COLORS.warn)
      .setDescription(
        [
          notice,
          `This is what the bank receives on Submit. ${submissions > 0 ? `Already submitted **${submissions}×**.` : "Not submitted yet."}${
            ed?.due_by ? ` Due <t:${ed.due_by}:R>.` : ""
          }`,
          "",
          textFields.length
            ? `**Text fields (${textFields.length})**${pageCount > 1 ? ` · page ${boundedPage + 1}/${pageCount}` : ""}`
            : "**No text evidence staged.**",
          ...pageFields.map(fieldBlock),
          "",
          files.length
            ? `**Files (${files.length})**\n${files.map((key) => `📎 **${key}** — \`${staged[key]}\``).join("\n")}`
            : "**No evidence files attached.**",
          unstagedDraft.length
            ? `\n✏️ **${unstagedDraft.length} local draft field(s) are NOT staged yet** (${unstagedDraft.slice(0, 6).join(", ")}${unstagedDraft.length > 6 ? ", …" : ""}) — open Edit Evidence and save them, or they won't reach the bank.`
            : null,
        ]
          .filter((line) => line !== null && line !== undefined)
          .join("\n")
          .slice(0, 4096)
      );

    const components: Panel["components"] = [];
    if (respondable && files.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_dp_fsel:${token}`)
            .setPlaceholder("Remove a staged file…")
            .addOptions(files.slice(0, 25).map((key) => ({ label: key, description: String(staged[key]).slice(0, 100), value: key })))
        )
      );
    }
    // AI critique of exactly this package — works on closed disputes too
    // (post-mortem), as long as anything is staged to look at.
    components.push(
      buttonRow(btn(`billadmin_dp_evai:${token}`, "AI Review", ButtonStyle.Primary, !(textFields.length || files.length)))
    );
    components.push(
      buttonRow(
        btn(`billadmin_dp_evrev:${token}:${boundedPage - 1}`, "Prev", ButtonStyle.Secondary, boundedPage <= 0),
        btn(`billadmin_dp_evrev:${token}:${boundedPage + 1}`, "Next", ButtonStyle.Secondary, boundedPage + 1 >= pageCount),
        btn(`billadmin_dp_ev_submit:${token}`, "Submit Evidence", ButtonStyle.Danger, !respondable || !(ed?.has_evidence || false)),
        btn(`billadmin_dp_ev_edit:${token}`, "Edit Evidence", ButtonStyle.Secondary, !respondable),
        btn(`billadmin_dp_det:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- closed-dispute history browser ----

  private async renderHistory(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const filter = parseClosedFilter(session.dpHistFilter);
    const [{ rows, total }, reasons] = await Promise.all([
      this.ctx.disputeStore.listClosed(page * PAGE_SIZE, PAGE_SIZE, filter),
      this.ctx.disputeStore.closedReasons(),
    ]);

    const lines = rows.map((d) => {
      const emoji = OUTCOME_EMOJI[d.status] ?? "⚪";
      const closed = d.closedAt ? ` · closed <t:${Math.floor(d.closedAt.getTime() / 1000)}:R>` : "";
      const submitted = d.evidenceSubmittedAt ? " · 📨 responded" : d.status === "lost" ? " · ⚠️ no response" : "";
      return `${emoji} \`${d.id}\` · **${this.ctx.stripe.formatAmount(d.amount, d.currency)}** · ${d.reason} · ${d.status}${closed}${submitted}`;
    });

    const backfilledAt = this.ctx.settingsStore.disputeBackfillDoneAt();
    const embed = new EmbedBuilder()
      .setTitle(`📜 Dispute history (${total})`)
      .setColor(COLORS.brand)
      .setDescription(
        [
          notice,
          `Closed disputes in the local mirror${filter ? ` · filtered: ${filter.outcome ?? filter.reason}` : ""}${
            total > PAGE_SIZE ? ` · page ${page + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))}` : ""
          }`,
          "",
          lines.length ? lines.join("\n") : "No closed disputes recorded yet.",
          backfilledAt
            ? null
            : "\nℹ️ Only disputes seen since the mirror existed are listed — run **/config → Billing → Disputes → Backfill History** to import the full Stripe history.",
        ]
          .filter((line) => line !== null && line !== undefined)
          .join("\n")
          .slice(0, 4096)
      );

    const components: Panel["components"] = [];
    if (rows.length) {
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_dp_hpick:${token}:${page}`)
            .setPlaceholder("Open a dispute…")
            .addOptions(
              rows.slice(0, 25).map((d) => ({
                label: `${this.ctx.stripe.formatAmount(d.amount, d.currency)} · ${d.reason} · ${d.status}`.slice(0, 100),
                description: `${d.id}${d.closedAt ? ` · closed ${d.closedAt.toISOString().slice(0, 10)}` : ""}`.slice(0, 100),
                value: d.id,
              }))
            )
        )
      );
    }
    if (total > 0 || filter) {
      const active = session.dpHistFilter ?? "all";
      components.push(
        selectRow(
          new StringSelectMenuBuilder()
            .setCustomId(`billadmin_dp_hfil:${token}`)
            .setPlaceholder("Filter…")
            .addOptions(
              [
                { label: "All closed disputes", value: "all", default: active === "all" },
                { label: "Won", value: "o:won", default: active === "o:won" },
                { label: "Lost", value: "o:lost", default: active === "o:lost" },
                { label: "Other (prevented / inquiry closed)", value: "o:other", default: active === "o:other" },
                ...reasons.slice(0, 20).map((r) => ({
                  label: `Reason: ${r.reason} (${r.count})`.slice(0, 100),
                  value: `r:${r.reason}`.slice(0, 100),
                  default: active === `r:${r.reason}`,
                })),
              ].slice(0, 25)
            )
        )
      );
    }
    components.push(
      buttonRow(
        btn(`billadmin_dp_hist:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_dp_hist:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * PAGE_SIZE >= total),
        btn(`billadmin_dp_stats:${token}`, "Stats", ButtonStyle.Secondary),
        btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary),
        btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- outcome analytics ----

  private async renderStats(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const [allTime, d90, byReason] = await Promise.all([
      this.ctx.disputeStore.outcomeStats(),
      this.ctx.disputeStore.outcomeStats(90),
      this.ctx.disputeStore.statsByReason(),
    ]);

    const fmtAmounts = (amounts: Record<string, number>) => {
      const parts = Object.entries(amounts).map(([currency, minor]) => this.ctx.stripe.formatAmount(minor, currency));
      return parts.length ? parts.join(" + ") : "—";
    };
    const fmtRate = (pct: number | null) => (pct == null ? "n/a (nothing decided)" : `${pct.toFixed(1)}%`);
    const windowBlock = (label: string, s: typeof allTime) =>
      [
        `**${label}** — ${s.won + s.lost + s.other} closed`,
        `🏆 won **${s.won}** · ❌ lost **${s.lost}** · ⚪ other **${s.other}** · win rate **${fmtRate(s.winRatePct)}**`,
        `recovered ${fmtAmounts(s.wonAmount)} · conceded ${fmtAmounts(s.lostAmount)}`,
        s.lostUnanswered > 0 ? `⚠️ **${s.lostUnanswered}** lost without any evidence response` : null,
      ]
        .filter(Boolean)
        .join("\n");

    const reasonLines = byReason
      .slice(0, 10)
      .map((r) => `• **${r.reason}** — 🏆 ${r.won} / ❌ ${r.lost}${r.other ? ` / ⚪ ${r.other}` : ""} · win rate ${fmtRate(r.winRatePct)}`);

    const backfilledAt = this.ctx.settingsStore.disputeBackfillDoneAt();
    const embed = new EmbedBuilder()
      .setTitle("📊 Dispute outcomes")
      .setColor(COLORS.brand)
      .setDescription(
        [
          windowBlock("All time", allTime),
          "",
          windowBlock("Last 90 days (by close date)", d90),
          "",
          reasonLines.length ? `**By reason (all time)**\n${reasonLines.join("\n")}` : "**By reason** — no closed disputes yet.",
          "",
          backfilledAt
            ? `History backfilled <t:${Math.floor(backfilledAt.getTime() / 1000)}:R>. Win rate = won ÷ (won + lost); "other" (prevented / closed inquiries) doesn't count against you.`
            : "⚠️ Stats only cover disputes seen since the mirror existed — run **/config → Billing → Disputes → Backfill History** for lifetime numbers. Win rate = won ÷ (won + lost).",
        ].join("\n").slice(0, 4096)
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_dp_hist:${token}:0`, "History", ButtonStyle.Secondary),
          btn(`billadmin_dp_home:${token}`, "Disputes Overview", ButtonStyle.Secondary),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
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

    // Real customer-communication material + few-shot exemplars from past
    // wins; both are best-effort — the draft still runs when they're missing.
    const [intercomHistory, wonExemplars] = await Promise.all([
      this.collectIntercomHistory(customerId, customer?.email ?? null).catch((error) => {
        logger.warn("intercom history lookup failed", { error: String(error) });
        return null;
      }),
      this.ctx.disputeStore.wonEvidenceExemplars(dispute.reason || "unknown", 2).catch(() => []),
    ]);

    const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

    // Fields with exactly one correct value come from Stripe, not the model —
    // they're removed from the requested set entirely so there is nothing to
    // hallucinate (the screenshot bug: an email drafted into the duplicate
    // explanation, narrative text into the charge-id field).
    const deterministic: Record<string, string> = {};
    if (customer?.email) deterministic.customer_email_address = customer.email;
    if (charge) deterministic.service_date = iso(charge.created);

    // reason=duplicate: the only truthful duplicate_charge_id is another REAL
    // charge on this customer with the same amount — look it up and hand the
    // candidates to the model (or the explicit "none exist" fact).
    let duplicateCandidates: Array<{ id: string; amountText: string; created: string; description: string | null }> = [];
    if (dispute.reason === "duplicate" && customerId && charge) {
      const { charges } = await this.ctx.stripe.listCharges(customerId, 100).catch(() => ({ charges: [], hasMore: false }));
      duplicateCandidates = charges
        .filter((c) => c.id !== charge.id && c.status === "succeeded" && c.currency === charge.currency && c.amount === charge.amount)
        .slice(0, 3)
        .map((c) => ({
          id: c.id,
          amountText: this.ctx.stripe.formatAmount(c.amount, c.currency),
          created: iso(c.created),
          description: c.description ?? null,
        }));
    }

    const fields = aiDraftFieldsFor(dispute.reason).filter((f) => !(f in deterministic));
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
      intercomHistory,
      wonExemplars,
      duplicateCandidates,
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
    const rejected = new Set<string>();
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
          if (typeof value !== "string" || !value.trim()) continue;
          const trimmed = value.trim();
          // Shape guard: a value that can't be what the field means (text in
          // an id field, an email as an explanation) is dropped, not saved.
          if (AI_DRAFT_VALIDATORS[key] && !AI_DRAFT_VALIDATORS[key](trimmed)) {
            rejected.add(key);
            continue;
          }
          draft[key] = trimmed.slice(0, 3800);
        }
      } catch {
        // keep scanning earlier messages
      }
    }
    if (Object.keys(draft).length === 0 && Object.keys(deterministic).length === 0) {
      draft = { uncategorized_text: (messages[messages.length - 1] ?? "").trim().slice(0, 3800) };
    }
    // Stripe-sourced values overwrite whatever the model produced for them.
    Object.assign(draft, deterministic);

    // Backfill the receipt file slot while we're here (the webhook auto-attach
    // only covers disputes created after the feature) — best-effort, the draft
    // itself must land regardless.
    let receiptNote: string | null = null;
    if (this.ctx.settingsStore.disputeAutoAttachReceipt()) {
      try {
        const receipt = await attachReceiptEvidence(this.ctx.stripe, dispute);
        if (receipt.attached) receiptNote = "🧾 The charge's receipt PDF was staged in the `receipt` evidence slot.";
      } catch (error) {
        logger.warn("receipt auto-attach during AI draft failed", { error: String(error), "stripe.dispute_id": dispute.id });
      }
    }

    await this.ctx.disputeStore.mergeEvidenceDraft(dispute.id, draft);
    this.ctx.audit.log(interaction, {
      action: "Dispute AI evidence draft",
      targetCustomerId: customerId ?? undefined,
      objectId: dispute.id,
      outcome: `Draft saved locally (${Object.keys(draft).length} field(s)${rejected.size ? `, ${rejected.size} invalid value(s) dropped: ${[...rejected].join(", ")}` : ""}${
        intercomHistory ? ", with Intercom history" : ""
      }${wonExemplars.length ? `, ${wonExemplars.length} won-dispute exemplar(s)` : ""}${
        receiptNote ? ", receipt staged" : ""
      }) — draft text not sent to Stripe`,
      severity: "info",
    });
    await this.renderEvidenceEditor(
      interaction,
      token,
      [
        "🤖 AI draft saved **locally** — open the sections below to review/adjust and **Save** to stage, then Submit. No draft text was sent to Stripe.",
        rejected.size
          ? `⚠️ Dropped ${rejected.size} field(s) whose value didn't fit the field's meaning (${[...rejected].join(", ")}) — fill them manually if needed.`
          : null,
        receiptNote,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  // Support-history context for the AI draft: resolve the customer to Intercom
  // contacts (bridge contacts carry the Discord id as external_id and no email,
  // so both lookups run), pull their newest conversations and render bounded
  // plaintext transcripts. Null on any shortfall — the draft works without it.
  private async collectIntercomHistory(customerId: string | null, email: string | null): Promise<string | null> {
    if (this.ctx.settingsStore.intercomMode() === "none") return null;
    const contactIds = new Set<string>();
    if (customerId) {
      const discordIds = await this.ctx.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => []);
      for (const discordId of discordIds.slice(0, 3)) {
        const contact = await this.ctx.intercom.findContactByExternalId(discordId).catch(() => null);
        if (contact) contactIds.add(contact.id);
      }
    }
    if (email) {
      for (const id of await this.ctx.intercom.searchContactIdsByEmail(email).catch(() => [])) contactIds.add(id);
    }
    if (contactIds.size === 0) return null;

    const conversations: Array<{ id: string; createdAt: Date | null }> = [];
    for (const contactId of [...contactIds].slice(0, 3)) {
      conversations.push(...(await this.ctx.intercom.searchConversationsByContact(contactId, 3).catch(() => [])));
    }
    const newest = [...new Map(conversations.map((c) => [c.id, c])).values()]
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, 3);

    const blocks: string[] = [];
    let budget = 5000; // keep the prompt bounded — transcripts can be huge
    for (const convo of newest) {
      const transcript = await this.ctx.intercom.getConversationTranscript(convo.id).catch(() => []);
      if (!transcript.length) continue;
      const lines = transcript
        .slice(0, 12)
        .map(
          (m) =>
            `  - [${m.at ? m.at.toISOString().slice(0, 10) : "?"}] ${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`
        );
      const block = `- Conversation started ${convo.createdAt ? convo.createdAt.toISOString().slice(0, 10) : "?"}:\n${lines.join("\n")}`;
      if (block.length > budget) break;
      budget -= block.length;
      blocks.push(block);
    }
    return blocks.length ? blocks.join("\n") : null;
  }

  // ---- AI evidence review (cheap model, read-only) ----

  // Critiques exactly what the bank would receive: the staged text plus the
  // staged evidence files, downloaded from Stripe and passed to the light
  // model as vision/document blocks. Local draft fields that differ from
  // staged ride along so the review can say "stage this". Renders a verdict
  // panel and changes nothing — works on closed disputes too (post-mortem).
  private async runAiEvidenceReview(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.disputeId) return;
    const [row, dispute] = await Promise.all([
      this.ctx.disputeStore.get(session.disputeId),
      this.ctx.stripe.getDispute(session.disputeId),
    ]);
    const staged = (dispute.evidence ?? {}) as unknown as Record<string, unknown>;
    const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;

    const stagedFields = TEXT_EVIDENCE_KEYS.filter(
      (key) => typeof staged[key] === "string" && (staged[key] as string).trim()
    ).map((key) => ({ key, text: (staged[key] as string).trim().slice(0, 3800) }));
    const fileSlots = EVIDENCE_FILE_KEYS.filter((key) => typeof staged[key] === "string" && staged[key]);
    if (!stagedFields.length && !fileSlots.length) {
      await this.renderReviewStaged(interaction, token, 0, "Nothing staged at Stripe yet — there is nothing to review.");
      return;
    }

    await interaction.editReply({
      embeds: [
        makeEmbed(
          `🤖 Reviewing the staged evidence for \`${dispute.id}\`${fileSlots.length ? ` — downloading ${fileSlots.length} evidence file(s)…` : "…"}`,
          COLORS.brand
        ),
      ],
      components: [],
    });

    // Pull the staged files back from Stripe; a file that can't be fetched or
    // fed to the model is reported to the reviewer instead of failing the run.
    const attachments: LightAiAttachment[] = [];
    const files: Array<{ slot: string; filename: string; attached: boolean; note: string | null }> = [];
    for (const slot of fileSlots) {
      const fileId = staged[slot] as string;
      try {
        const res = await this.ctx.stripe.getEvidenceFileWithContents(fileId, PROOF_MAX_BYTES);
        if (res.data && res.mimeType) {
          attachments.push({ name: res.filename, mediaType: res.mimeType, data: res.data });
          files.push({ slot, filename: res.filename, attached: true, note: null });
        } else {
          files.push({ slot, filename: res.filename, attached: false, note: res.skipped ?? "unavailable" });
        }
      } catch (error) {
        logger.warn("evidence file download for AI review failed", { error: String(error), "stripe.file_id": fileId });
        files.push({ slot, filename: fileId, attached: false, note: "download failed" });
      }
    }

    const unstagedDraft = TEXT_EVIDENCE_KEYS.filter((key) => {
      const d = draft[key]?.trim();
      return d && d !== (typeof staged[key] === "string" ? (staged[key] as string).trim() : "");
    }).map((key) => ({ key, text: draft[key].trim().slice(0, 1500) }));

    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const charge = chargeId ? await this.ctx.stripe.getCharge(chargeId).catch(() => null) : null;
    const customerId = charge
      ? typeof charge.customer === "string"
        ? charge.customer
        : (charge.customer?.id ?? null)
      : (session.customerId ?? null);
    const customer = customerId ? await this.ctx.stripe.getCustomer(customerId).catch(() => null) : null;

    const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
    const prompt = buildDisputeEvidenceReviewPrompt({
      disputeId: dispute.id,
      reason: dispute.reason || "unknown",
      status: dispute.status,
      amountText: this.ctx.stripe.formatAmount(dispute.amount, dispute.currency),
      disputeCreated: iso(dispute.created),
      evidenceDueBy: dispute.evidence_details?.due_by ? iso(dispute.evidence_details.due_by) : null,
      submissionCount: dispute.evidence_details?.submission_count ?? 0,
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
      stagedFields,
      files,
      unstagedDraft,
    });

    const messages = await this.ctx.lightAi.run(prompt, undefined, {
      model: this.ctx.settingsStore.aiModelLight(),
      maxTokens: 1_500,
      timeoutMs: 120_000,
      telemetry: {
        agentName: "ai-dispute-evidence-review",
        kind: "staff_command",
        userId: interaction.user.id,
        username: interaction.user.username,
      },
      attachments,
    });
    const review = messages.join("\n\n").trim();

    this.ctx.audit.log(interaction, {
      action: "Dispute AI evidence review",
      targetCustomerId: customerId ?? undefined,
      objectId: dispute.id,
      outcome: `Reviewed ${stagedFields.length} staged field(s) + ${attachments.length}/${files.length} file(s) on the light model — read-only`,
      severity: "info",
    });

    const skipped = files.filter((f) => !f.attached);
    const embed = new EmbedBuilder()
      .setTitle(`🧐 AI evidence review — \`${dispute.id}\``)
      .setColor(COLORS.brand)
      .setDescription(review.slice(0, 4096) || "The model returned no review text — try again.")
      .setFooter({
        text: `${this.ctx.settingsStore.aiModelLight()} · ${stagedFields.length} field(s) · ${attachments.length}/${files.length} file(s) reviewed${
          skipped.length ? ` · skipped: ${skipped.map((f) => `${f.slot} (${f.note})`).join(", ")}` : ""
        } · advisory only`.slice(0, 2048),
      });
    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_dp_evai:${token}`, "Run Again", ButtonStyle.Secondary),
          btn(`billadmin_dp_evrev:${token}:0`, "Staged Evidence", ButtonStyle.Secondary),
          btn(`billadmin_dp_ev_edit:${token}`, "Edit Evidence", ButtonStyle.Secondary, !RESPONDABLE.has(dispute.status)),
          btn(`billadmin_dp_det:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    });
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
