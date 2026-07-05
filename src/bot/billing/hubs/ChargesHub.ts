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
import { backRow, btn, buttonRow, chargeLine, invoiceLine, selectRow, textInput } from "../ui";
import type { Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const logger = new Logger("billing-admin:charges");

// Basil (SDK v20) dropped `invoice` from the Stripe.Charge type, but the field
// is still returned on the wire for subscription charges — narrow, don't cast.
interface ChargeWithInvoiceRef extends Stripe.Charge {
  invoice?: string | { id: string } | null;
}

function chargeInvoiceId(charge: Stripe.Charge): string | null {
  const ref = (charge as ChargeWithInvoiceRef).invoice;
  return typeof ref === "string" ? ref : ref?.id ?? null;
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

  if (session.view === "invoices") {
    const { invoices, hasMore } = await ctx.stripe.listInvoices(session.customerId!, 10, session.cursors[page]);
    const last = invoices[invoices.length - 1];
    if (hasMore && last?.id) session.cursors[page + 1] = last.id;
    hasNext = hasMore;
    title = `Invoices — \`${session.customerId}\``;
    lines = invoices.map((inv) => invoiceLine(ctx.stripe, inv));
  } else if (session.view === "fpcharges") {
    const { charges, nextPage } = await ctx.stripe.searchChargesByCardFingerprint(
      session.fingerprint!,
      10,
      session.cursors[page]
    );
    if (nextPage) session.cursors[page + 1] = nextPage;
    hasNext = !!nextPage;
    title = `Charges — card \`${session.fingerprint}\``;
    lines = charges.map((c) => chargeLine(ctx.stripe, c, true));
    footerExtra = " · Search data can lag ~1 min";
  } else {
    const { charges, hasMore } = await ctx.stripe.listCharges(session.customerId!, 10, session.cursors[page]);
    const last = charges[charges.length - 1];
    if (hasMore && last) session.cursors[page + 1] = last.id;
    hasNext = hasMore;
    title = `Charges — \`${session.customerId}\``;
    lines = charges.map((c) => chargeLine(ctx.stripe, c, false));
    pageCharges = charges;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLORS.brand)
    .setDescription(lines.join("\n").slice(0, 4096) || "Nothing here.")
    .setFooter({ text: `Page ${page + 1}${footerExtra}` });

  const components: Panel["components"] = [];
  if (session.view === "charges" && pageCharges.length > 0) {
    const pick = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_ch_pick:${token}:${page}`)
      .setPlaceholder("Open a charge…")
      .addOptions(
        pageCharges.slice(0, 25).map((c) => ({
          label: `${ctx.stripe.formatAmount(c.amount, c.currency)} · ${c.status}${
            c.refunded ? " · refunded" : c.amount_refunded > 0 ? " · partly refunded" : ""
          }${c.disputed ? " · 🚩 disputed" : ""}`.slice(0, 100),
          description: c.id.slice(0, 100),
          value: c.id,
        }))
      );
    components.push(selectRow(pick));
  }
  const navButtons = [
    btn(`billadmin_page:${token}:${page - 1}`, "◀ Prev", ButtonStyle.Secondary, page <= 0),
    btn(`billadmin_page:${token}:${page + 1}`, "Next ▶", ButtonStyle.Secondary, !hasNext),
  ];
  // Customer-scoped lists get a jump back to the Customer-360 panel; the
  // fingerprint view is account-wide, so there is no single customer to show.
  if (session.view !== "fpcharges" && session.customerId) {
    navButtons.push(btn(`billadmin_c360_refresh:${token}`, "👤 360", ButtonStyle.Secondary));
  }
  navButtons.push(
    btn(session.view === "fpcharges" ? "billadmin_hub:cards" : "billadmin_hub:charges", "Back", ButtonStyle.Secondary)
  );
  components.push(buttonRow(...navButtons));

  await interaction.editReply({ embeds: [embed], components });
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
    // Charge detail: picked from the charges list select.
    {
      kind: "select",
      id: "billadmin_ch_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.chargeId = interaction.values[0];
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await this.ctx.sessions.tryRender(interaction, () => this.renderChargeDetail(interaction, token, page));
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
    {
      kind: "modal",
      id: "billadmin_refund_modal",
      match: "exact",
      handler: (interaction) => this.handleRefundModal(interaction),
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
            placeholder: "e.g. 12.50 — in the charge's currency",
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
      .setTitle(`Disputes & fraud — ${source}`)
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
    await interaction.editReply({ embeds: [embed], components: [backRow("billadmin_hub:charges")] });
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
        embeds: [makeEmbed("Amount must be a number like `12.50` — or leave it empty for a full refund.", COLORS.danger)],
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
                makeEmbed(`\`${charge.currency}\` is a zero-decimal currency — whole amounts only.`, COLORS.danger),
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

  // Shared refund confirm step: entered from the refund modal and from the
  // charge detail panel. Resolves the subscription behind the charge via its
  // invoice (getInvoice → invoice.parent.subscription_details.subscription) and
  // stashes it in the session, so "Refund + cancel sub" cancels exactly that
  // subscription — never a guessed one derived from the customer.
  private async showRefundConfirm(
    interaction: RenderInteraction,
    token: string,
    charge: Stripe.Charge,
    cancelTarget = "billadmin_hub:charges"
  ): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const fmt = (v: number) => this.ctx.stripe.formatAmount(v, charge.currency);
    const remaining = charge.amount - charge.amount_refunded;
    const amountMinor = session.refundAmountMinor ?? null;

    let subscriptionId: string | null = null;
    const invoiceId = chargeInvoiceId(charge);
    if (invoiceId) {
      try {
        const invoice = await this.ctx.stripe.getInvoice(invoiceId);
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

    const notes = [
      charge.disputed
        ? "🚩 **This charge is disputed** — refunding usually won't release disputed funds."
        : null,
      subscriptionId
        ? null
        : "ℹ️ No subscription attached to this charge — cancel explicitly via Subscriptions if needed.",
      "ℹ️ Admin refunds don't record a self-service lock: the customer's own refund flow could still refund any remainder.",
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle("Confirm refund")
      .setColor(COLORS.danger)
      .addFields(
        { name: "Charge", value: `\`${charge.id}\``, inline: true },
        { name: "Customer", value: charge.customer ? `\`${typeof charge.customer === "string" ? charge.customer : charge.customer.id}\`` : "—", inline: true },
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
            ? `\`${subscriptionId}\` — cancelled if you pick **Refund + cancel sub**`
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
          btn(cancelTarget, "Cancel", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ---- charge detail ----

  private async renderChargeDetail(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.chargeId) return;

    const charge = await this.ctx.stripe.getCharge(session.chargeId);
    const dispute = charge.disputed ? await this.ctx.stripe.getDisputeForCharge(charge.id) : null;
    const fmt = (v: number) => this.ctx.stripe.formatAmount(v, charge.currency);
    const remaining = charge.amount - charge.amount_refunded;
    const invoiceId = chargeInvoiceId(charge);

    const card = charge.payment_method_details?.card;
    const pmText = card
      ? `${card.brand ?? "card"} •••• ${card.last4 ?? "????"}${card.exp_month ? ` · exp ${card.exp_month}/${card.exp_year}` : ""}`
      : charge.payment_method_details?.type ?? "—";
    const outcome = charge.outcome;
    const riskText = outcome?.risk_level
      ? `${outcome.risk_level}${outcome.risk_score != null ? ` (score ${outcome.risk_score})` : ""}`
      : "—";

    const embed = new EmbedBuilder()
      .setTitle(`Charge — \`${charge.id}\``)
      .setColor(charge.disputed ? COLORS.warn : COLORS.brand)
      .addFields(
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
        { name: "Invoice", value: invoiceId ? `\`${invoiceId}\`` : "—", inline: true },
        { name: "Receipt", value: charge.receipt_url ? `[open receipt](${charge.receipt_url})` : "—", inline: true }
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_ch_refund:${token}:${page}`, "↩️ Refund…", ButtonStyle.Danger, charge.refunded || remaining <= 0),
          btn("billadmin_hub:invoices", "View invoice", ButtonStyle.Secondary, !invoiceId),
          btn(`billadmin_c360_refresh:${token}`, "👤 360", ButtonStyle.Secondary, !session.customerId),
          btn(`billadmin_page:${token}:${page}`, "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async executeRefund(interaction: ButtonInteraction, token: string, withCancel: boolean): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.chargeId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      // Best-effort claim of the self-service billing-action lock, so the
      // customer's own refund flow sees this charge as handled. An existing
      // claim never blocks an admin (admin override) — it is only surfaced.
      let lockNote = "";
      try {
        const claimed = await this.ctx.sessionStore.claimBillingAction(interaction.user.id, session.chargeId!, "refund");
        if (!claimed) lockNote = "\nℹ️ a billing action already existed for this charge";
      } catch (error) {
        logger.warn("claimBillingAction failed — proceeding (admin override)", {
          chargeId: session.chargeId,
          error: String(error),
        });
      }

      // Per-click idempotency key: stable across Discord retries of this click, but
      // unique across deliberate repeat refunds (reusing refund-${chargeId} would
      // silently return the first refund on a second partial).
      let result: Awaited<ReturnType<StripeClient["refundChargeAmount"]>>;
      try {
        result = await this.ctx.stripe.refundChargeAmount(
          session.chargeId!,
          session.refundAmountMinor ?? null,
          `billadmin-refund-${interaction.id}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: withCancel ? "Refund + cancel subscription" : "Refund",
          targetCustomerId: session.customerId,
          objectId: session.chargeId,
          amountText: session.refundAmountMinor != null ? `${session.refundAmountMinor} (minor units)` : "full remainder",
          outcome: `Failed — ${msg.slice(0, 500)}`,
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
          cancelNote = "\n⚠️ No subscription is attached to this charge — nothing was cancelled.";
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

      const amountText = this.ctx.stripe.formatAmount(result.amount, result.currency);
      this.ctx.audit.log(interaction, {
        action: withCancel ? "Refund + cancel subscription" : "Refund",
        targetCustomerId: session.customerId,
        objectId: session.chargeId,
        amountText,
        outcome: `Refund \`${result.refundId}\` (${result.status ?? "pending"})${
          session.refundAmountMinor != null ? " — partial" : " — full remainder"
        }${cancelNote.replace(/\n/g, " ")}${lockNote.replace(/\n/g, " ")}`,
        severity: "success",
      });

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `↩️ Refunded **${amountText}** on \`${session.chargeId}\` — ` +
              `refund \`${result.refundId}\` (${result.status ?? "pending"}).${cancelNote}${lockNote}`,
            COLORS.success
          ),
        ],
        components: [backRow("billadmin_hub:charges")],
      });
    });
  }
}
