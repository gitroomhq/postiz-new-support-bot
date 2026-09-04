import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { StripeClient } from "../../StripeClient";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { Logger } from "../../../util/logger";
import { exportBillingEvent } from "../../../metrics/MetricsExporter";
import { backRow, btn, buttonRow, chargeLine, invoiceLine, selectRow, textInput } from "../ui";
import { buildNoteModal, renderNotesPanel } from "../qolUi";
import { pushNav, type BillAdminSession, type Panel, type RenderInteraction, type RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const logger = new Logger("billing-admin:charges");

// Statuses in which Stripe allows paymentIntents.cancel.
const PI_CANCELABLE = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
]);

// The customer's chargeless PaymentIntents (attempts that never reached the
// card network), fetched once per panel session and interleaved into the first
// charges page. Keyed on the session object so the cache dies with the session.
const chargelessPiCache = new WeakMap<BillAdminSession, Stripe.PaymentIntent[]>();

// List row for a PaymentIntent that never produced a charge — visually distinct
// from charge rows and carrying the decline info when Stripe recorded one.
function piLine(stripe: StripeClient, pi: Stripe.PaymentIntent): string {
  const parts = [
    `⛔ **${stripe.formatAmount(pi.amount, pi.currency)}** · ${pi.status} (never reached card network)`,
    `<t:${pi.created}:R>`,
  ];
  const decline = pi.last_payment_error?.decline_code ?? pi.last_payment_error?.code;
  if (decline) parts.push(`decline: \`${decline}\``);
  return parts.join(" · ");
}

// One pager for the three list views; the session records which view is active
// and the cursor chain discovered so far (forward-only, so Prev re-uses stored cursors).
// Standalone so the cards hub (fingerprint charge lists) can share it without a
// hub-to-hub dependency.
export async function renderListPage(
  ctx: HubContext,
  interaction: RenderInteraction,
  token: string,
  page: number
): Promise<void> {
  const session = ctx.sessions.get(token);
  if (!session?.view || !session.cursors) return;

  let title: string;
  let lines: string[];
  let hasNext = false;
  let footerExtra = "";
  let pageCharges: Stripe.Charge[] = [];
  let pagePis: Stripe.PaymentIntent[] = [];

  if (session.view === "invoices") {
    session.originHub ??= "charges";
    const { invoices, hasMore } = await ctx.stripe.listInvoices(session.customerId!, 10, session.cursors[page]);
    const last = invoices[invoices.length - 1];
    if (hasMore && last?.id) session.cursors[page + 1] = last.id;
    hasNext = hasMore;
    title = `Invoices: \`${session.customerId}\``;
    lines = invoices.map((inv) => invoiceLine(ctx.stripe, inv));
  } else if (session.view === "fpcharges") {
    session.originHub ??= "cards";
    const { charges, nextPage } = await ctx.stripe.searchChargesByCardFingerprint(
      session.fingerprint!,
      10,
      session.cursors[page]
    );
    if (nextPage) session.cursors[page + 1] = nextPage;
    hasNext = !!nextPage;
    title = `Charges: card \`${session.fingerprint}\``;
    lines = charges.map((c) => chargeLine(ctx.stripe, c, true));
    footerExtra = " · Search data can lag ~1 min";
  } else {
    session.originHub ??= "charges";
    const { charges, hasMore } = await ctx.stripe.listCharges(session.customerId!, 10, session.cursors[page]);
    const last = charges[charges.length - 1];
    if (hasMore && last) session.cursors[page + 1] = last.id;
    hasNext = hasMore;
    title = `Charges: \`${session.customerId}\``;
    pageCharges = charges;

    // PaymentIntents that died before creating a charge (declined at confirm,
    // abandoned 3DS, canceled, awaiting confirmation) are invisible to
    // charges.list — fetch them once per session and interleave them into the
    // FIRST page; later pages stay charges-only (see footer note).
    let chargelessPis = chargelessPiCache.get(session);
    if (!chargelessPis) {
      const intents = await ctx.stripe.listPaymentIntents(session.customerId!, 100);
      // latest_charge is expandable (string | Charge | null) — anything
      // non-null means a charge exists and charges.list already shows it.
      chargelessPis = intents.filter((pi) => pi.latest_charge == null);
      chargelessPiCache.set(session, chargelessPis);
    }
    pagePis = page === 0 ? chargelessPis : [];

    lines = [
      ...charges.map((c) => ({ created: c.created, line: chargeLine(ctx.stripe, c, false) })),
      ...pagePis.map((pi) => ({ created: pi.created, line: piLine(ctx.stripe, pi) })),
    ]
      .sort((a, b) => b.created - a.created)
      .map((row) => row.line);
    if (chargelessPis.length > 0) footerExtra = " · ⛔ incomplete attempts shown on first page";
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.brand)
    .setDescription(lines.join("\n").slice(0, 4096) || "Nothing here.")
    .setFooter({ text: `Page ${page + 1}${footerExtra}` });

  const components: Panel["components"] = [];
  if (session.view === "charges" && (pageCharges.length > 0 || pagePis.length > 0)) {
    // One merged picker: ch_ values open the charge detail, pi_ values the
    // PaymentIntent detail — the id prefix is the discriminator.
    const options = [
      ...pageCharges.map((c) => ({
        created: c.created,
        option: {
          label: `${ctx.stripe.formatAmount(c.amount, c.currency)} · ${c.status}${
            c.refunded ? " · refunded" : c.amount_refunded > 0 ? " · partly refunded" : ""
          }${c.disputed ? " · 🚩 disputed" : ""}`.slice(0, 100),
          description: c.id.slice(0, 100),
          value: c.id,
        },
      })),
      ...pagePis.map((pi) => ({
        created: pi.created,
        option: {
          label: `⛔ ${ctx.stripe.formatAmount(pi.amount, pi.currency)} · ${pi.status}`.slice(0, 100),
          description: pi.id.slice(0, 100),
          value: pi.id,
        },
      })),
    ]
      .sort((a, b) => b.created - a.created)
      .slice(0, 25)
      .map((row) => row.option);
    const pick = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_ch_pick:${token}:${page}`)
      .setPlaceholder("Open a charge or incomplete attempt…")
      .addOptions(options);
    components.push(selectRow(pick));
  }
  const navButtons = [
    btn(`billadmin_page:${token}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
    btn(`billadmin_page:${token}:${page + 1}`, "Next", ButtonStyle.Secondary, !hasNext),
  ];
  // Customer-scoped lists get a jump back to the Customer-360 panel; the
  // fingerprint view is account-wide, so there is no single customer to show.
  if (session.view !== "fpcharges" && session.customerId) {
    navButtons.push(btn(`billadmin_c360_refresh:${token}`, "Customer 360", ButtonStyle.Secondary));
  }
  navButtons.push(btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary));
  components.push(buttonRow(...navButtons));

  await interaction.editReply({ embeds: [embed], components });
}

// Shared refund confirm step: entered from the refund modal, the charge detail
// panel and the Disputes hub's refund-to-prevent flow (hence exported, like
// renderListPage — no hub-to-hub dependency). Resolves the subscription behind
// the charge via its invoice (getInvoice → invoice.parent.subscription_details
// .subscription) and stashes it in the session, so "Refund + cancel sub"
// cancels exactly that subscription — never a guessed one derived from the
// customer.
export async function showRefundConfirm(
  ctx: HubContext,
  interaction: RenderInteraction,
  token: string,
  charge: Stripe.Charge,
  cancelTarget = "billadmin_hub:charges"
): Promise<void> {
  const session = ctx.sessions.get(token);
  if (!session) return;
  const fmt = (v: number) => ctx.stripe.formatAmount(v, charge.currency);
  const remaining = charge.amount - charge.amount_refunded;
  const amountMinor = session.refundAmountMinor ?? null;

  let subscriptionId: string | null = null;
  const invoiceId = await ctx.stripe.resolveChargeInvoiceId(charge);
  if (invoiceId) {
    try {
      const invoice = await ctx.stripe.getInvoice(invoiceId);
      const subRef = invoice.parent?.subscription_details?.subscription;
      subscriptionId = subRef ? (typeof subRef === "string" ? subRef : subRef.id) : null;
    } catch (error) {
      logger.warn("Could not resolve the charge's invoice for subscription lookup", {
        chargeId: charge.id,
        invoiceId,
        error: String(error),
      });
    }
  }
  session.subscriptionId = subscriptionId ?? undefined;
  // Land the refund result back on wherever the flow was launched from (the
  // charge detail when opened there, the Charges hub for the id-modal flow),
  // instead of always dumping to the hub top menu.
  session.refundReturn = cancelTarget;

  // "Disputed" alone doesn't tell the admin whether refunding still helps, so
  // resolve the dispute's stage: at the early-warning / inquiry stage a full
  // refund prevents the formal chargeback; once formal, Stripe rejects the
  // refund outright.
  const dispute = charge.disputed ? await ctx.stripe.getDisputeForCharge(charge.id).catch(() => null) : null;
  const warningStage =
    dispute?.status === "warning_needs_response" || dispute?.status === "warning_under_review";
  const formalOpen = dispute?.status === "needs_response" || dispute?.status === "under_review";
  session.refundDisputeStage = dispute ? (warningStage && dispute.is_charge_refundable ? "warning" : "formal") : null;

  const disputeNotes: string[] = [];
  if (charge.disputed) {
    if (!dispute) {
      disputeNotes.push(
        "🚩 **This charge is disputed**: a refund only helps at the inquiry / early-warning stage; Stripe rejects refunds on formal chargebacks."
      );
    } else if (warningStage && dispute.is_charge_refundable) {
      disputeNotes.push(
        `✅ **This refund can still prevent the chargeback.** Dispute \`${dispute.id}\` is at the early-warning / inquiry stage (\`${dispute.status}\`); refunding the full remainder closes it before it becomes a formal chargeback. It stays \`${dispute.status}\` until the bank processes the refund (can take a few days).`
      );
      if (amountMinor != null && amountMinor < remaining) {
        disputeNotes.push(
          "⚠️ **Partial refund selected**: only refunding the **full remainder** reliably prevents the chargeback."
        );
      }
    } else if (warningStage) {
      disputeNotes.push(
        `⛔ Dispute \`${dispute.id}\` is still at the warning stage, but Stripe reports the charge as **not refundable**; this refund will be rejected.`
      );
    } else if (formalOpen) {
      disputeNotes.push(
        `⛔ **Too late to prevent: this is a formal chargeback** (\`${dispute.status}\`). Stripe rejects refunds on it, so this refund will fail. Respond with evidence or accept the dispute instead.`
      );
    } else if (dispute.status === "lost") {
      disputeNotes.push(
        "⛔ **Dispute already lost**: the bank has already pulled the disputed amount back. Refunding on top would return the money **twice**."
      );
    } else {
      disputeNotes.push(
        `🚩 Dispute \`${dispute.id}\` is already closed (**${dispute.status}**); this refund is goodwill only and doesn't change the dispute outcome.`
      );
    }
  }

  const notes = [
    ...disputeNotes,
    subscriptionId
      ? null
      : "ℹ️ No subscription attached to this charge. Cancel explicitly via Subscriptions if needed.",
    "ℹ️ Admin refunds don't record a self-service lock: the customer's own refund flow could still refund any remainder.",
    "ℹ️ **Refund as Fraudulent** also puts the card + email on Stripe's built-in block lists.",
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle("Confirm refund")
    .setColor(COLORS.danger)
    .addFields(
      { name: "Charge", value: `\`${charge.id}\``, inline: true },
      { name: "Customer", value: charge.customer ? `\`${typeof charge.customer === "string" ? charge.customer : charge.customer.id}\`` : "N/A", inline: true },
      { name: "Created", value: `<t:${charge.created}:D>`, inline: true },
      { name: "Original", value: fmt(charge.amount), inline: true },
      { name: "Already refunded", value: fmt(charge.amount_refunded), inline: true },
      { name: "Remaining", value: fmt(remaining), inline: true },
      {
        name: "This refund",
        value: amountMinor != null ? `**${fmt(amountMinor)}** (partial)` : `**${fmt(remaining)}** (full remainder)`,
        inline: false,
      },
      {
        name: "Subscription",
        value: subscriptionId
          ? `\`${subscriptionId}\`: cancelled if you pick **Refund + cancel sub**`
          : "none attached to this charge",
        inline: false,
      }
    )
    .setDescription(notes.join("\n"));

  await interaction.editReply({
    embeds: [embed],
    components: [
      buttonRow(
        btn(`billadmin_refund_exec:${token}`, "Refund", ButtonStyle.Danger),
        btn(`billadmin_refund_execsub:${token}`, "Refund + cancel sub", ButtonStyle.Danger, !subscriptionId),
        btn(`billadmin_refund_execfr:${token}`, "Refund as Fraudulent", ButtonStyle.Danger),
        btn(cancelTarget, "Cancel", ButtonStyle.Secondary)
      ),
    ],
  });
}

// Charges hub: charge & invoice history, disputes/fraud signals, refunds.
export class ChargesHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_page:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderListPage(interaction, token, page));
      },
    },
    {
      kind: "button",
      id: "billadmin_goto:",
      match: "prefix",
      handler: async (interaction) => {
        const [, view, token] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        // billadmin_goto: buttons only exist on the Customer-360 panel — record
        // it so the target list's Back returns there.
        pushNav(session, `billadmin_c360_refresh:${token}`);
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (view === "fraud") {
            session.fingerprint = undefined;
            await this.renderFraud(interaction, token);
          } else {
            session.view = view === "invoices" ? "invoices" : "charges";
            session.cursors = [undefined];
            await this.renderListPage(interaction, token, 0);
          }
        });
      },
    },
    // Charge / PaymentIntent detail: picked from the merged charges-list select.
    // The value's id prefix discriminates: ch_/py_ → charge, pi_ → PaymentIntent.
    {
      kind: "select",
      id: "billadmin_ch_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        // The detail's Back returns to the exact list page it was opened from.
        pushNav(session, `billadmin_page:${token}:${page}`);
        const picked = interaction.values[0];
        if (picked.startsWith("pi_")) {
          session.paymentIntentId = picked;
          await this.ctx.sessions.tryRender(interaction, () => this.renderPiDetail(interaction, token, page));
          return;
        }
        session.chargeId = picked;
        await this.ctx.sessions.tryRender(interaction, () => this.renderChargeDetail(interaction, token, page));
      },
    },
    // PaymentIntent detail re-render (Back target of its confirm step).
    {
      kind: "button",
      id: "billadmin_pi_det:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.paymentIntentId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderPiDetail(interaction, token, page));
      },
    },
    // Cancel-PaymentIntent confirm step (danger confirm, PI pre-loaded).
    {
      kind: "button",
      id: "billadmin_pi_cancel:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.paymentIntentId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const pi = await this.ctx.stripe.getPaymentIntent(session.paymentIntentId!);
          if (!PI_CANCELABLE.has(pi.status)) {
            await this.renderPiDetail(interaction, token, page, `⚠️ \`${pi.id}\` is **${pi.status}**, no longer cancelable.`);
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle("Cancel PaymentIntent")
            .setColor(COLORS.danger)
            .setDescription(
              `⚠️ Cancel \`${pi.id}\` (**${this.ctx.stripe.formatAmount(pi.amount, pi.currency)}**, ` +
                `status **${pi.status}**)?\nThe attempt is closed for good. The customer can no longer ` +
                "complete it (e.g. a pending 3DS challenge stops working). No money has moved on this intent."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_pi_cancelx:${token}:${page}`, "Cancel PaymentIntent", ButtonStyle.Danger),
                btn(`billadmin_pi_det:${token}:${page}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_pi_cancelx:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.executePiCancel(interaction, token, page);
      },
    },
    {
      kind: "button",
      id: "billadmin_ch_det:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderChargeDetail(interaction, token, page));
      },
    },
    // Refund entry from the charge detail panel: the charge is pre-loaded, so
    // this skips the charge-id modal and goes straight to the confirm step.
    {
      kind: "button",
      id: "billadmin_ch_refund:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const charge = await this.ctx.stripe.getCharge(session.chargeId!);
          const remaining = charge.amount - charge.amount_refunded;
          if (charge.refunded || remaining <= 0) {
            await interaction.editReply({
              embeds: [
                makeEmbed(
                  `Already fully refunded (${this.ctx.stripe.formatAmount(charge.amount_refunded, charge.currency)} ` +
                    `of ${this.ctx.stripe.formatAmount(charge.amount, charge.currency)}).`,
                  COLORS.warn
                ),
              ],
              components: [backRow(`billadmin_ch_det:${token}:${page}`)],
            });
            return;
          }
          session.refundAmountMinor = null; // full remaining amount
          const chargeCustomer = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
          if (chargeCustomer) session.customerId = chargeCustomer;
          await this.showRefundConfirm(interaction, token, charge, `billadmin_ch_det:${token}:${page}`);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_refund_exec:",
      match: "prefix",
      handler: (interaction) => this.executeRefund(interaction, interaction.customId.split(":")[1], false),
    },
    {
      kind: "button",
      id: "billadmin_refund_execsub:",
      match: "prefix",
      handler: (interaction) => this.executeRefund(interaction, interaction.customId.split(":")[1], true),
    },
    // Fraudulent-reason refund: Stripe additionally adds the card + email to
    // its built-in block lists (the refund-to-prevent flow's preferred exit).
    {
      kind: "button",
      id: "billadmin_refund_execfr:",
      match: "prefix",
      handler: (interaction) => this.executeRefund(interaction, interaction.customId.split(":")[1], false, "fraudulent"),
    },
    {
      kind: "modal",
      id: "billadmin_refund_modal",
      match: "exact",
      handler: (interaction) => this.handleRefundModal(interaction),
    },
    // ---- charge-detail QoL: team notes + shared bookmark ----
    {
      kind: "button",
      id: "billadmin_ch_notes:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr, npageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () =>
          renderNotesPanel(this.ctx, interaction, {
            type: "charge",
            objectId: session.chargeId!,
            backId: `billadmin_ch_det:${token}:${page}`,
            addNoteId: `billadmin_ch_noteadd:${token}:${page}`,
            pageBaseId: `billadmin_ch_notes:${token}:${page}`,
            page: Math.max(0, Number.parseInt(npageStr, 10) || 0),
          })
        );
      },
    },
    {
      kind: "button",
      id: "billadmin_ch_noteadd:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await interaction.showModal(buildNoteModal(`billadmin_ch_notem:${token}:${page}`, session.chargeId));
      },
    },
    {
      kind: "modal",
      id: "billadmin_ch_notem:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        const text = interaction.fields.getTextInputValue("note_text").trim();
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (text) {
            await this.ctx.qolStore.addNote(
              "charge",
              session.chargeId!,
              interaction.user.id,
              interaction.user.displayName ?? interaction.user.username,
              text
            );
          }
          await renderNotesPanel(this.ctx, interaction, {
            type: "charge",
            objectId: session.chargeId!,
            backId: `billadmin_ch_det:${token}:${page}`,
            addNoteId: `billadmin_ch_noteadd:${token}:${page}`,
            pageBaseId: `billadmin_ch_notes:${token}:${page}`,
            notice: text ? "✅ Note added." : undefined,
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_ch_bm:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.chargeId) return;
        await interaction.deferUpdate();
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const charge = await this.ctx.stripe.getCharge(session.chargeId!);
          const label = `${this.ctx.stripe.formatAmount(charge.amount, charge.currency)} · ${charge.status}`;
          const { bookmarked } = await this.ctx.qolStore.toggleBookmark(
            "charge",
            session.chargeId!,
            label,
            interaction.user.id,
            interaction.user.displayName ?? interaction.user.username
          );
          await this.renderChargeDetail(
            interaction,
            token,
            page,
            bookmarked ? "🔖 Bookmarked for the team." : "Bookmark removed."
          );
        });
      },
    },
  ];

  buildRefundModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_refund_modal")
      .setTitle("Refund a charge")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("charge_id", "Charge ID", { required: true, placeholder: "ch_…" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", "Amount (empty = full refund)", {
            required: false,
            placeholder: "e.g. 12.50, in the charge's currency",
          })
        )
      );
  }

  renderListPage(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    return renderListPage(this.ctx, interaction, token, page);
  }

  async renderFraud(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;

    let charges: Stripe.Charge[];
    let source: string;
    if (session.fingerprint) {
      charges = (await this.ctx.stripe.searchChargesByCardFingerprint(session.fingerprint, 20)).charges;
      source = `card \`${session.fingerprint}\``;
    } else if (session.customerId) {
      charges = (await this.ctx.stripe.listCharges(session.customerId, 20)).charges;
      source = `\`${session.customerId}\``;
    } else {
      return;
    }

    const warnings = await this.ctx.stripe.listRecentEarlyFraudWarnings(100);
    const warningByCharge = new Map(
      warnings.map((w) => [typeof w.charge === "string" ? w.charge : w.charge.id, w])
    );

    const disputedCharges = charges.filter((c) => c.disputed);
    const disputeEntries = await Promise.all(
      disputedCharges
        .slice(0, 5)
        .map(async (charge) => [charge.id, await this.ctx.stripe.getDisputeForCharge(charge.id)] as const)
    );
    const disputeByCharge = new Map<string, Stripe.Dispute | null>(disputeEntries);

    let matchedWarnings = 0;
    const lines = charges.map((charge) => {
      const parts = [
        `\`${charge.id}\``,
        `<t:${charge.created}:R>`,
        `**${this.ctx.stripe.formatAmount(charge.amount, charge.currency)}**`,
      ];
      const risk = charge.outcome?.risk_level;
      if (risk) parts.push(`risk: ${risk}${charge.outcome?.risk_score != null ? ` (${charge.outcome.risk_score})` : ""}`);
      if (charge.disputed) {
        const dispute = disputeByCharge.get(charge.id);
        parts.push(`🚩 DISPUTED${dispute ? ` (${dispute.status}, ${dispute.reason})` : ""}`);
      }
      const warning = warningByCharge.get(charge.id);
      if (warning) {
        matchedWarnings++;
        parts.push(`⚠️ EFW: ${warning.fraud_type}`);
      }
      return parts.join(" · ");
    });

    const embed = new EmbedBuilder()
      .setTitle(`Disputes & fraud: ${source}`)
      .setColor(disputedCharges.length || matchedWarnings ? COLORS.warn : COLORS.brand)
      .setDescription(
        [
          `**${charges.length}** recent charges scanned · **${disputedCharges.length}** disputed · **${matchedWarnings}** early fraud warnings matched`,
          "",
          ...lines,
        ]
          .join("\n")
          .slice(0, 4096) || "No charges found."
      )
      .setFooter({
        text: "risk_score requires Radar for Fraud Teams · EFW match covers the 100 most recent warnings · Search data can lag ~1 min",
      });
    session.originHub ??= "charges";
    await interaction.editReply({ embeds: [embed], components: [backRow(`billadmin_nav_back:${token}`)] });
  }

  // ---- refund flow ----

  async handleRefundModal(interaction: ModalSubmitInteraction): Promise<void> {
    const chargeId = interaction.fields.getTextInputValue("charge_id").trim();
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();

    if (!/^(ch|py)_[A-Za-z0-9]+$/.test(chargeId)) {
      await interaction.reply({
        embeds: [makeEmbed("Charge IDs start with `ch_` (or `py_`).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if (amountRaw && !/^\d+(\.\d{1,2})?$/.test(amountRaw)) {
      await interaction.reply({
        embeds: [makeEmbed("Amount must be a number like `12.50`, or leave it empty for a full refund.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const charge = await this.ctx.stripe.getCharge(chargeId);

      let amountMinor: number | null = null;
      if (amountRaw) {
        if (StripeClient.isZeroDecimal(charge.currency)) {
          if (amountRaw.includes(".")) {
            await interaction.editReply({
              embeds: [
                makeEmbed(`\`${charge.currency}\` is a zero-decimal currency: whole amounts only.`, COLORS.danger),
              ],
              components: [backRow("billadmin_hub:charges")],
            });
            return;
          }
          amountMinor = Number.parseInt(amountRaw, 10);
        } else {
          amountMinor = Math.round(Number.parseFloat(amountRaw) * 100);
        }
      }

      const remaining = charge.amount - charge.amount_refunded;
      const fmt = (v: number) => this.ctx.stripe.formatAmount(v, charge.currency);
      if (charge.refunded || remaining <= 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`Already fully refunded (${fmt(charge.amount_refunded)} of ${fmt(charge.amount)}).`, COLORS.warn)],
          components: [backRow("billadmin_hub:charges")],
        });
        return;
      }
      if (amountMinor != null && (amountMinor <= 0 || amountMinor > remaining)) {
        await interaction.editReply({
          embeds: [makeEmbed(`Requested amount exceeds the un-refunded remainder of ${fmt(remaining)}.`, COLORS.danger)],
          components: [backRow("billadmin_hub:charges")],
        });
        return;
      }

      const token = this.ctx.sessions.newSession(interaction, {
        chargeId: charge.id,
        refundAmountMinor: amountMinor,
        customerId: typeof charge.customer === "string" ? charge.customer : charge.customer?.id,
      });
      await this.showRefundConfirm(interaction, token, charge);
    });
  }

  // Delegates to the exported confirm step (shared with the Disputes hub's
  // refund-to-prevent flow, same pattern as the exported renderListPage).
  showRefundConfirm(
    interaction: RenderInteraction,
    token: string,
    charge: Stripe.Charge,
    cancelTarget?: string
  ): Promise<void> {
    return showRefundConfirm(this.ctx, interaction, token, charge, cancelTarget);
  }

  // ---- charge detail ----

  // Public: the Disputes hub's Jump-to-ID and bookmark board land here too
  // (bound through BillingAdmin, like the TargetResolver handlers).
  async renderChargeDetail(interaction: RenderInteraction, token: string, page: number, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.chargeId) return;

    const charge = await this.ctx.stripe.getCharge(session.chargeId);
    const chargeCustomerId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
    const [dispute, blockHit, bookmarked, latestNote] = await Promise.all([
      charge.disputed ? this.ctx.stripe.getDisputeForCharge(charge.id) : Promise.resolve(null),
      this.ctx.blockStore.anyBlocked({
        customerId: chargeCustomerId,
        email: charge.billing_details?.email ?? charge.receipt_email,
        fingerprint: charge.payment_method_details?.card?.fingerprint,
      }),
      this.ctx.qolStore.isBookmarked("charge", charge.id),
      this.ctx.qolStore.latestNote("charge", charge.id),
    ]);
    const fmt = (v: number) => this.ctx.stripe.formatAmount(v, charge.currency);
    const remaining = charge.amount - charge.amount_refunded;
    const invoiceId = await this.ctx.stripe.resolveChargeInvoiceId(charge);

    const card = charge.payment_method_details?.card;
    const pmText = card
      ? `${card.brand ?? "card"} •••• ${card.last4 ?? "????"}${card.exp_month ? ` · exp ${card.exp_month}/${card.exp_year}` : ""}`
      : charge.payment_method_details?.type ?? "N/A";
    const outcome = charge.outcome;
    const riskText = outcome?.risk_level
      ? `${outcome.risk_level}${outcome.risk_score != null ? ` (score ${outcome.risk_score})` : ""}`
      : "N/A";

    const embed = new EmbedBuilder()
      .setTitle(`Charge: \`${charge.id}\``)
      .setColor(blockHit ? COLORS.danger : charge.disputed ? COLORS.warn : COLORS.brand)
      .addFields(
        ...(blockHit
          ? [
              {
                name: "⛔ BLOCKED",
                value: `${blockHit.kind} \`${blockHit.value.slice(0, 100)}\`: ${blockHit.reason.slice(0, 300)}`,
                inline: false,
              },
            ]
          : []),
        { name: "Amount", value: `**${fmt(charge.amount)}**`, inline: true },
        { name: "Status", value: charge.status, inline: true },
        { name: "Created", value: `<t:${charge.created}:D>`, inline: true },
        {
          name: "Refunded",
          value: charge.amount_refunded > 0 ? `${fmt(charge.amount_refunded)} · ${fmt(remaining)} remaining` : "no",
          inline: true,
        },
        {
          name: "Dispute",
          value: charge.disputed ? `🚩 ${dispute?.status ?? "disputed"}${dispute?.reason ? ` · ${dispute.reason}` : ""}` : "none",
          inline: true,
        },
        { name: "Risk", value: riskText, inline: true },
        { name: "Payment method", value: pmText.slice(0, 1024), inline: true },
        { name: "Invoice", value: invoiceId ? `\`${invoiceId}\`` : "N/A", inline: true },
        { name: "Receipt", value: charge.receipt_url ? `[open receipt](${charge.receipt_url})` : "N/A", inline: true },
        ...(latestNote
          ? [
              {
                name: "Latest note",
                value: `<t:${Math.floor(latestNote.createdAt.getTime() / 1000)}:R> **${latestNote.authorName}**: ${latestNote.text}`.slice(0, 1024),
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
          btn(`billadmin_ch_refund:${token}:${page}`, "Refund…", ButtonStyle.Danger, charge.refunded || remaining <= 0),
          btn("billadmin_hub:invoices", "View invoice", ButtonStyle.Secondary, !invoiceId),
          btn(`billadmin_c360_refresh:${token}`, "Customer 360", ButtonStyle.Secondary, !session.customerId),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn(`billadmin_ch_notes:${token}:${page}`, "Notes", ButtonStyle.Secondary),
          btn(`billadmin_ch_bm:${token}:${page}`, bookmarked ? "Remove Bookmark" : "Bookmark", ButtonStyle.Secondary),
          btn(`billadmin_blk_open:${token}:ch:${page}`, "Block…", ButtonStyle.Danger)
        ),
      ],
    });
  }

  // ---- PaymentIntent detail (chargeless attempts from the merged list) ----

  private async renderPiDetail(
    interaction: RenderInteraction,
    token: string,
    page: number,
    notice?: string
  ): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.paymentIntentId) return;

    const pi = await this.ctx.stripe.getPaymentIntent(session.paymentIntentId);
    const err = pi.last_payment_error;
    const errText = err
      ? [
          err.code ? `code \`${err.code}\`` : null,
          err.decline_code ? `decline \`${err.decline_code}\`` : null,
          err.message?.slice(0, 300) ?? null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "N/A";

    // payment_method is unexpanded (a string) on retrieve; the failed attempt's
    // full PaymentMethod object often survives on last_payment_error instead.
    let pmText = "N/A";
    const pmRef = pi.payment_method ?? err?.payment_method ?? null;
    if (pmRef && typeof pmRef !== "string") {
      pmText = pmRef.card ? `${pmRef.card.brand} •••• ${pmRef.card.last4}` : pmRef.type;
    } else if (typeof pmRef === "string") {
      pmText = `\`${pmRef}\``;
    }

    const invoiceId = await this.ctx.stripe.resolvePaymentIntentInvoiceId(pi);
    const cancelable = PI_CANCELABLE.has(pi.status);

    const embed = new EmbedBuilder()
      .setTitle(`⛔ Payment attempt: \`${pi.id}\``)
      .setColor(pi.status === "canceled" ? COLORS.neutral : COLORS.warn)
      .addFields(
        { name: "Amount", value: `**${this.ctx.stripe.formatAmount(pi.amount, pi.currency)}**`, inline: true },
        { name: "Status", value: pi.status, inline: true },
        { name: "Created", value: `<t:${pi.created}:D>`, inline: true },
        { name: "Last payment error", value: errText.slice(0, 1024), inline: false },
        { name: "Cancellation reason", value: pi.cancellation_reason ?? "N/A", inline: true },
        { name: "Payment method", value: pmText.slice(0, 1024), inline: true },
        { name: "Invoice", value: invoiceId ? `\`${invoiceId}\`` : "N/A", inline: true }
      );
    if (notice) embed.setDescription(notice.slice(0, 4096));

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_pi_cancel:${token}:${page}`, "Cancel PI", ButtonStyle.Danger, !cancelable),
          btn(`billadmin_c360_refresh:${token}`, "Customer 360", ButtonStyle.Secondary, !session.customerId),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async executePiCancel(interaction: ButtonInteraction, token: string, page: number): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.paymentIntentId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      let pi: Stripe.PaymentIntent;
      try {
        pi = await this.ctx.stripe.cancelPaymentIntent(
          session.paymentIntentId!,
          `billadmin-picancel-${interaction.id}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: "Cancel PaymentIntent",
          targetCustomerId: session.customerId,
          objectId: session.paymentIntentId,
          outcome: `Failed: ${msg.slice(0, 500)}`,
          severity: "danger",
        });
        await this.renderPiDetail(interaction, token, page, `⚠️ Cancel failed: ${msg.slice(0, 300)}`);
        return;
      }

      // The cached chargeless-PI rows now show a stale status — refetch next render.
      chargelessPiCache.delete(session);
      this.ctx.audit.log(interaction, {
        action: "Cancel PaymentIntent",
        targetCustomerId: session.customerId,
        objectId: pi.id,
        amountText: this.ctx.stripe.formatAmount(pi.amount, pi.currency),
        outcome: `Canceled (was an incomplete attempt, no money had moved)`,
        severity: "warn",
      });
      await this.renderPiDetail(interaction, token, page, `🚫 \`${pi.id}\` canceled.`);
    });
  }

  private async executeRefund(
    interaction: ButtonInteraction,
    token: string,
    withCancel: boolean,
    reason?: Stripe.RefundCreateParams.Reason
  ): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.chargeId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.runExclusive(token, interaction, async () => {
      // Best-effort claim of the self-service billing-action lock, so the
      // customer's own refund flow sees this charge as handled. An existing
      // claim never blocks an admin (admin override) — it is only surfaced.
      // Tagged "admin_refund" (not "refund") so it still locks the charge but is
      // NOT counted by the self-service refund velocity guardrail.
      let lockNote = "";
      try {
        const claimed = await this.ctx.sessionStore.claimBillingAction(interaction.user.id, session.chargeId!, "admin_refund");
        if (!claimed) lockNote = "\nℹ️ a billing action already existed for this charge";
      } catch (error) {
        logger.warn("claimBillingAction failed, proceeding (admin override)", {
          chargeId: session.chargeId,
          error: String(error),
        });
      }

      // Per-click idempotency key: stable across Discord retries of this click, but
      // unique across deliberate repeat refunds (reusing refund-${chargeId} would
      // silently return the first refund on a second partial).
      const actionLabel = withCancel
        ? "Refund + cancel subscription"
        : reason === "fraudulent"
          ? "Refund (marked fraudulent)"
          : "Refund";
      let result: Awaited<ReturnType<StripeClient["refundChargeAmount"]>>;
      try {
        result = await this.ctx.stripe.refundChargeAmount(
          session.chargeId!,
          session.refundAmountMinor ?? null,
          `billadmin-refund-${interaction.id}`,
          reason
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: actionLabel,
          targetCustomerId: session.customerId,
          objectId: session.chargeId,
          amountText: session.refundAmountMinor != null ? `${session.refundAmountMinor} (minor units)` : "full remainder",
          outcome: `Failed: ${msg.slice(0, 500)}`,
          severity: "danger",
        });
        throw error;
      }

      let cancelNote = "";
      if (withCancel) {
        // The confirm step resolved this from the charge's invoice
        // (invoice.parent.subscription_details). cancelSubscription is strict
        // about sub_ ids, so never fall back to a customer id here.
        const subId = session.subscriptionId;
        if (!subId?.startsWith("sub_")) {
          cancelNote = "\n⚠️ No subscription is attached to this charge. Nothing was cancelled.";
        } else {
          try {
            await this.ctx.stripe.cancelSubscription(subId);
            cancelNote = `\n🔚 Subscription \`${subId}\` cancelled.`;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            cancelNote = `\n⚠️ Refund succeeded but cancelling \`${subId}\` failed: ${msg.slice(0, 300)}`;
          }
        }
      }

      const fraudNote =
        reason === "fraudulent" ? "\n🚫 Marked fraudulent: Stripe added the card + email to its block lists." : "";
      // Refunding at the warning stage doesn't flip the dispute immediately —
      // without this note, a still-open dispute panel reads like the refund
      // didn't work.
      const disputeNote =
        session.refundDisputeStage === "warning"
          ? "\n🛡️ The dispute stays in its `warning_…` status until the bank processes this refund. Expect it to close as **prevented / warning_closed** within a few days. No evidence response is needed."
          : "";
      const amountText = this.ctx.stripe.formatAmount(result.amount, result.currency);
      this.ctx.audit.log(interaction, {
        action: actionLabel,
        targetCustomerId: session.customerId,
        objectId: session.chargeId,
        amountText,
        outcome: `Refund \`${result.refundId}\` (${result.status ?? "pending"})${
          session.refundAmountMinor != null ? " · partial" : " · full remainder"
        }${cancelNote.replace(/\n/g, " ")}${fraudNote.replace(/\n/g, " ")}${lockNote.replace(/\n/g, " ")}`,
        severity: "success",
      });
      exportBillingEvent({
        event: "refund",
        amountMinor: result.amount,
        currency: result.currency,
        chargeId: session.chargeId,
        surface: "discord",
        partial: session.refundAmountMinor != null,
        ...(reason ? { reason } : {}),
      });

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `↩️ Refunded **${amountText}** on \`${session.chargeId}\`, ` +
              `refund \`${result.refundId}\` (${result.status ?? "pending"}).${disputeNote}${cancelNote}${fraudNote}${lockNote}`,
            COLORS.success
          ),
        ],
        components: [backRow(session.refundReturn ?? "billadmin_hub:charges")],
      });
    });
  }
}
