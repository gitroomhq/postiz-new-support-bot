import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { Logger } from "../../../util/logger";
import { backRow, btn, buttonRow, formatAddress, selectRow, stripeErrorEmbed, subPlanLabel, textInput } from "../ui";
import type { BillAdminSession, Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const logger = new Logger("billing-admin:customers");

// Countries whose addresses typically carry a state/province — after an
// address edit for one of these (or when a state was previously set) the
// admin gets a follow-up prompt to (re)enter the state.
const STATE_COUNTRIES = ["US", "CA", "AU", "BR", "IN", "MX"];

const TAX_EXEMPT_LABELS: Record<string, string> = {
  none: "None (taxable)",
  exempt: "Exempt",
  reverse: "Reverse charge",
};

const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: "en", label: "en — English" },
  { value: "de", label: "de — German" },
  { value: "fr", label: "fr — French" },
  { value: "es", label: "es — Spanish" },
  { value: "it", label: "it — Italian" },
  { value: "nl", label: "nl — Dutch" },
  { value: "pt", label: "pt — Portuguese" },
  { value: "pl", label: "pl — Polish" },
  { value: "sv", label: "sv — Swedish" },
  { value: "da", label: "da — Danish" },
  { value: "ja", label: "ja — Japanese" },
];

type CustSnapshot = NonNullable<BillAdminSession["custSnapshot"]>;
type EditSubmitInteraction = ModalSubmitInteraction | StringSelectMenuInteraction;

// Customers hub: overview, create/edit (details, address, shipping, invoice
// settings, metadata, tax IDs), the Discord ↔ Stripe link and customer deletion.
export class CustomersHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_link_set:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.targetDiscordUserId) return;
        await interaction.showModal(this.buildLinkModal(token));
      },
    },
    {
      kind: "button",
      id: "billadmin_link_clear:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.targetDiscordUserId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.sessionStore.updateStripeCustomerId(session.targetDiscordUserId!, null);
          this.ctx.audit.log(interaction, {
            action: "Unlink Discord ↔ Stripe",
            objectId: session.targetDiscordUserId,
            outcome: "Success — Stripe customer link cleared",
            severity: "warn",
          });
          await interaction.editReply(await this.buildLinkPanel(token, "✅ Unlinked."));
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_edit_details:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.custSnapshot) return;
        await interaction.showModal(this.buildEditDetailsModal(token, session.custSnapshot));
      },
    },
    {
      kind: "button",
      id: "billadmin_edit_address:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.custSnapshot) return;
        await interaction.showModal(this.buildEditAddressModal(token, session.custSnapshot.address));
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_ship:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.custSnapshot) return;
        await interaction.showModal(this.buildShippingModal(token, session.custSnapshot));
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_inv:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.custSnapshot) return;
        await interaction.showModal(this.buildInvoiceModal(token, session.custSnapshot));
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_meta:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.custSnapshot) return;
        await interaction.showModal(this.buildMetadataModal(token, session.custSnapshot));
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_state_open:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        // Pre-fill with the state from before the address edit (it was just
        // cleared in Stripe) so a carried-over state is one click away.
        await interaction.showModal(this.buildStateModal(token, session.custSnapshot?.address?.state ?? ""));
      },
    },
    {
      kind: "select",
      id: "billadmin_cust_taxex:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0] as Stripe.CustomerUpdateParams.TaxExempt;
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.applyCustomerEdit(
          interaction,
          token,
          { tax_exempt: value },
          `✅ Tax exemption set to **${TAX_EXEMPT_LABELS[value] ?? value}**.`,
          "Set customer tax exemption"
        );
      },
    },
    {
      kind: "select",
      id: "billadmin_cust_locale:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        const clear = value === "__clear";
        await this.applyCustomerEdit(
          interaction,
          token,
          { preferred_locales: clear ? [] : [value] },
          clear ? "✅ Preferred locales cleared." : `✅ Preferred locale set to **${value}**.`,
          "Set customer preferred locale"
        );
      },
    },
    {
      kind: "button",
      id: "billadmin_taxid_add:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.showModal(this.buildTaxIdAddModal(token));
      },
    },
    {
      kind: "button",
      id: "billadmin_taxid_remove:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.showTaxIdRemovePicker(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_c360_refresh:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderOverview(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_editcust_show:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderEditCustomer(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_delete_exec:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.deleteCustomer(session.customerId!);
          const unlinked = await this.ctx.sessionStore.unlinkStripeCustomerEverywhere(session.customerId!);
          this.ctx.audit.log(interaction, {
            action: "Delete customer",
            targetCustomerId: session.customerId,
            outcome: `Deleted in Stripe${unlinked ? ` — cleared the link on ${unlinked} Discord user session(s)` : ""}`,
            severity: "danger",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `🗑️ Customer \`${session.customerId}\` deleted in Stripe.` +
                  (unlinked ? `\nCleared the link on ${unlinked} Discord user session(s).` : ""),
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:customers")],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_cust_delete:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.update(this.buildCustomerDeleteConfirm(token));
      },
    },
    {
      kind: "select",
      id: "billadmin_taxidpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.removeTaxId(session.customerId!, value);
          this.ctx.audit.log(interaction, {
            action: "Remove tax ID",
            targetCustomerId: session.customerId,
            objectId: value,
            outcome: "Success",
            severity: "info",
          });
          await this.renderEditCustomer(interaction, token, "✅ Tax ID removed.");
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_createcust_modal",
      match: "exact",
      handler: (interaction) => this.handleCreateCustomerModal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_link_modal:",
      match: "prefix",
      handler: (interaction) => this.handleLinkModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_edit_details_modal:",
      match: "prefix",
      handler: (interaction) => this.handleEditDetailsModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_edit_address_modal:",
      match: "prefix",
      handler: (interaction) => this.handleEditAddressModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_taxid_add_modal:",
      match: "prefix",
      handler: (interaction) => this.handleTaxIdAddModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_cust_state_modal:",
      match: "prefix",
      handler: (interaction) => this.handleStateModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_cust_ship_modal:",
      match: "prefix",
      handler: (interaction) => this.handleShippingModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_cust_inv_modal:",
      match: "prefix",
      handler: (interaction) => this.handleInvoiceModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_cust_meta_modal:",
      match: "prefix",
      handler: (interaction) => this.handleMetadataModal(interaction, interaction.customId.split(":")[1]),
    },
  ];

  // ---- customer 360 (the "overview" target action) ----

  async renderOverview(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;
    // Empty-nav-stack fallback for this panel's Back button.
    session.originHub ??= "customers";

    const [customer, subscriptions, openInvoices, paymentMethods, chargesRes, linkRows, priceMap] = await Promise.all([
      this.ctx.stripe.getCustomer(customerId),
      this.ctx.stripe.listSubscriptions(customerId),
      this.ctx.stripe.listInvoicesByStatus(customerId, "open", 10),
      this.ctx.stripe.listAllPaymentMethods(customerId),
      this.ctx.stripe.listCharges(customerId, 100),
      (async () => {
        const discordIds = await this.ctx.sessionStore.findDiscordIdsByStripeId(customerId);
        return this.ctx.sessionStore.listByDiscordIds(discordIds);
      })(),
      this.ctx.priceBook.labelMap(),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [backRow(`billadmin_nav_back:${token}`)],
      });
      return;
    }
    const charges = chargesRes.charges;

    // The Link/Unlink action in the 360 select reuses the existing link panel,
    // which is keyed on a Discord user — pre-resolve it from the reverse lookup.
    session.targetDiscordUserId = linkRows[0]?.discordUserId;

    const defaultPmRef = customer.invoice_settings?.default_payment_method;
    const defaultPmId = typeof defaultPmRef === "string" ? defaultPmRef : defaultPmRef?.id;
    const defaultPmObj = paymentMethods.find((pm) => pm.id === defaultPmId);

    // Lifetime spend: succeeded charge amounts minus refunds, per currency —
    // bounded by the 100 most recent charges fetched above (see footer).
    const lifetime = new Map<string, number>();
    for (const charge of charges) {
      if (charge.status !== "succeeded") continue;
      lifetime.set(charge.currency, (lifetime.get(charge.currency) ?? 0) + charge.amount - charge.amount_refunded);
    }
    const spendText = lifetime.size
      ? [...lifetime.entries()].map(([cur, amt]) => `**${this.ctx.stripe.formatAmount(amt, cur)}**`).join(" · ")
      : "—";

    const subLines = subscriptions.slice(0, 8).map((sub) => {
      const periodEnd = sub.items.data[0]?.current_period_end;
      const flags = [
        sub.pause_collection ? "⏸ paused" : null,
        sub.schedule ? "📅 scheduled change" : null,
        sub.cancel_at_period_end ? "cancels at period end" : null,
      ].filter(Boolean);
      return (
        `**${subPlanLabel(this.ctx.stripe, sub, priceMap)}** · \`${sub.id}\` · ${sub.status}` +
        `${flags.length ? ` · ${flags.join(" · ")}` : ""}${periodEnd ? ` · ends <t:${periodEnd}:D>` : ""}`
      );
    });

    let openInvText = "none";
    if (openInvoices.data.length) {
      const totals = new Map<string, number>();
      for (const inv of openInvoices.data) totals.set(inv.currency, (totals.get(inv.currency) ?? 0) + inv.total);
      const totalText = [...totals.entries()].map(([cur, amt]) => this.ctx.stripe.formatAmount(amt, cur)).join(" · ");
      const oldestDue = Math.min(...openInvoices.data.map((inv) => inv.due_date ?? inv.created));
      openInvText =
        `**${openInvoices.data.length}${openInvoices.has_more ? "+" : ""}** open · ${totalText} total · ` +
        `oldest due <t:${oldestDue}:D>`;
    }

    const pmLines = paymentMethods
      .slice(0, 8)
      .map((pm) => `${this.pmSummary(pm)}${pm.id === defaultPmId ? " · ⭐ default" : ""}`);

    const disputedCount = charges.filter((c) => c.disputed).length;

    const linkText = linkRows.length
      ? linkRows
          .slice(0, 5)
          .map((row) => `<@${row.discordUserId}>${row.postizUserId ? ` · postiz \`${row.postizUserId}\`` : ""}`)
          .join("\n")
      : "no linked Discord user";

    const embed = new EmbedBuilder()
      .setTitle(`👤 Customer 360 — \`${customer.id}\``)
      .setColor(customer.delinquent || disputedCount ? COLORS.warn : COLORS.brand)
      .addFields(
        { name: "Email", value: (customer.email ?? "—").slice(0, 1024), inline: true },
        { name: "Name", value: (customer.name ?? "—").slice(0, 1024), inline: true },
        { name: "Created", value: `<t:${customer.created}:D>`, inline: true },
        { name: "Delinquent", value: customer.delinquent ? "⚠️ yes" : "no", inline: true },
        {
          name: "Balance",
          value: `${this.ctx.stripe.formatAmount(customer.balance, customer.currency ?? "usd")} *(negative = credit)*`,
          inline: true,
        },
        {
          name: "Default PM",
          value: defaultPmObj ? this.pmSummary(defaultPmObj).slice(0, 1024) : defaultPmId ? `\`${defaultPmId}\`` : "—",
          inline: true,
        },
        { name: "Lifetime spend", value: spendText.slice(0, 1024), inline: false },
        {
          name: `Subscriptions (${subscriptions.length})`,
          value: subLines.join("\n").slice(0, 1024) || "—",
          inline: false,
        },
        { name: `Open invoices (${openInvoices.data.length})`, value: openInvText.slice(0, 1024), inline: false },
        {
          name: `Payment methods (${paymentMethods.length})`,
          value: pmLines.join("\n").slice(0, 1024) || "—",
          inline: false,
        },
        {
          name: "Disputes",
          value: disputedCount ? `🚩 **${disputedCount}** disputed charge(s) among recent charges` : "none among recent charges",
          inline: false,
        },
        { name: "Discord / Postiz", value: linkText.slice(0, 1024), inline: false }
      )
      .setFooter({ text: "Lifetime spend & dispute count from the 100 most recent charges" });

    const actionSelect = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_c360_act:${token}`)
      .setPlaceholder("Action…")
      .addOptions(
        { label: "New subscription", value: "createsub", description: "Plan, coupon & trial — charge now or invoice" },
        { label: "Adjust balance", value: "bal", description: "Grant credit / add debit (Payments flow)" },
        { label: "Charge card now", value: "charge", description: "Off-session charge on a saved card (Payments flow)" },
        { label: "Edit customer", value: "editcust", description: "Details, address, VAT/tax IDs" },
        { label: "Link / Unlink", value: "link", description: "Discord ↔ Stripe customer mapping" },
        { label: "Apply discount", value: "discount", description: "Apply the configured discount coupon" },
        { label: "Change plan", value: "changeplan", description: "Swap the subscription's plan" },
        { label: "Delete customer", value: "delcust", description: "Permanently delete in Stripe" }
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_goto:charges:${token}`, "Charges", ButtonStyle.Primary),
          btn(`billadmin_goto:invoices:${token}`, "Invoices", ButtonStyle.Primary),
          btn(`billadmin_sub_list:${token}`, "Subscriptions", ButtonStyle.Primary, subscriptions.length === 0),
          btn(`billadmin_c360_go:cards:${token}`, "Cards", ButtonStyle.Primary),
          btn(`billadmin_goto:fraud:${token}`, "Fraud", ButtonStyle.Primary)
        ),
        selectRow(actionSelect),
        buttonRow(
          btn(`billadmin_c360_refresh:${token}`, "Refresh", ButtonStyle.Secondary),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private pmSummary(pm: Stripe.PaymentMethod): string {
    if (pm.card) return `${pm.card.brand} •••• ${pm.card.last4}`;
    return pm.type;
  }

  // ---- link / unlink ----

  async buildLinkPanel(token: string, notice?: string): Promise<Panel> {
    const session = this.ctx.sessions.get(token);
    const targetId = session?.targetDiscordUserId ?? "";
    const row = targetId ? await this.ctx.sessionStore.getSession(targetId) : null;

    let otherNote = "";
    if (row?.stripeCustomerId) {
      const others = (await this.ctx.sessionStore.findDiscordIdsByStripeId(row.stripeCustomerId)).filter(
        (d) => d !== targetId
      );
      if (others.length) otherNote = `\n⚠️ Also linked to: ${others.map((d) => `<@${d}>`).join(" ")}`;
    }

    const embed = new EmbedBuilder()
      .setTitle("Link / unlink Stripe customer")
      .setColor(COLORS.brand)
      .setDescription(
        [
          notice,
          `User: <@${targetId}>`,
          `Stripe customer: ${row?.stripeCustomerId ? `\`${row.stripeCustomerId}\`` : "_none_"}${otherNote}`,
          `Postiz user: ${row?.postizUserId ? `\`${row.postizUserId}\`` : "_none_"}`,
        ]
          .filter(Boolean)
          .join("\n")
      );

    const buttons = [btn(`billadmin_link_set:${token}`, "Set / Change", ButtonStyle.Primary)];
    if (row?.stripeCustomerId) {
      buttons.push(btn(`billadmin_link_clear:${token}`, "Unlink", ButtonStyle.Danger));
    }
    buttons.push(btn("billadmin_hub:customers", "Back", ButtonStyle.Secondary));
    return { embeds: [embed], components: [buttonRow(...buttons)] };
  }

  private async handleLinkModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.targetDiscordUserId) return;

    const customerId = interaction.fields.getTextInputValue("customer_id").trim();
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
      await interaction.reply({ embeds: [makeEmbed("Customer IDs start with `cus_`.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const customer = await this.ctx.stripe.getCustomer(customerId);
      if (!customer) {
        await interaction.editReply(await this.buildLinkPanel(token, `❌ No such Stripe customer: \`${customerId}\`.`));
        return;
      }
      const updated = await this.ctx.sessionStore.updateStripeCustomerId(session.targetDiscordUserId!, customerId);
      if (updated) {
        this.ctx.audit.log(interaction, {
          action: "Link Discord ↔ Stripe",
          targetCustomerId: customerId,
          objectId: session.targetDiscordUserId,
          outcome: "Success",
          severity: "info",
        });
      }
      await interaction.editReply(
        await this.buildLinkPanel(
          token,
          updated ? `✅ Linked to \`${customerId}\`.` : "⚠️ The user's session row disappeared — nothing updated."
        )
      );
    });
  }

  // ---- edit customer info (the "editcust" target action) ----

  async renderEditCustomer(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    session.originHub ??= "customers";

    const [customer, taxIds] = await Promise.all([
      this.ctx.stripe.getCustomer(session.customerId),
      this.ctx.stripe.listTaxIds(session.customerId),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [backRow("billadmin_hub:customers")],
      });
      return;
    }

    // Snapshot feeds the modal pre-fills, so the edit modals don't need a Stripe
    // round-trip inside the 3-second showModal window.
    session.custSnapshot = this.snapshotOf(customer);
    const snap = session.custSnapshot;

    const taxIdLines = taxIds
      .slice(0, 15)
      .map((t) => `\`${t.id}\` · ${t.type} · **${t.value}**${t.verification?.status ? ` · ${t.verification.status}` : ""}`)
      .join("\n");

    const biText =
      [snap.businessName ? `business: ${snap.businessName}` : null, snap.individualName ? `individual: ${snap.individualName}` : null]
        .filter(Boolean)
        .join(" · ") || "—";

    const shippingText = customer.shipping
      ? [customer.shipping.name, customer.shipping.phone, formatAddress(customer.shipping.address ?? null)]
          .filter((p) => p && p !== "—")
          .join(" · ") || "—"
      : "—";

    const taxExempt = customer.tax_exempt ?? "none";
    const locales = customer.preferred_locales ?? [];
    const invoiceText = [
      `prefix: ${snap.invoicePrefix ? `\`${snap.invoicePrefix}\`` : "—"}`,
      `next #: ${snap.nextInvoiceSequence ?? "—"}`,
      `custom fields: ${snap.invoiceCustomFields.length}`,
      `footer: ${snap.invoiceFooter ? "set" : "—"}`,
      `tax display: ${snap.amountTaxDisplay === "include_inclusive_tax" ? "incl" : snap.amountTaxDisplay === "exclude_tax" ? "excl" : "—"}`,
    ].join(" · ");

    const metaKeys = Object.keys(snap.metadata);
    const metaText = metaKeys.length
      ? `${metaKeys.length} key(s): ${metaKeys.slice(0, 10).join(", ")}${metaKeys.length > 10 ? ", …" : ""}`
      : "—";

    const embed = new EmbedBuilder()
      .setTitle(`Edit customer — \`${customer.id}\``)
      .setColor(COLORS.brand)
      .addFields(
        { name: "Name / company", value: (customer.name ?? "—").slice(0, 1024), inline: true },
        { name: "Email", value: (customer.email ?? "—").slice(0, 1024), inline: true },
        { name: "Phone", value: (customer.phone ?? "—").slice(0, 1024), inline: true },
        { name: "Business / individual", value: biText.slice(0, 1024), inline: false },
        { name: "Description", value: (customer.description ?? "—").slice(0, 1024), inline: false },
        { name: "Address", value: formatAddress(customer.address).slice(0, 1024), inline: false },
        { name: "Shipping", value: shippingText.slice(0, 1024), inline: false },
        { name: "Tax exemption", value: TAX_EXEMPT_LABELS[taxExempt] ?? taxExempt, inline: true },
        { name: "Preferred locales", value: (locales.join(", ") || "—").slice(0, 1024), inline: true },
        { name: "Invoice & branding", value: invoiceText.slice(0, 1024), inline: false },
        { name: "Metadata", value: metaText.slice(0, 1024), inline: false },
        { name: `Tax IDs (${taxIds.length})`, value: taxIdLines.slice(0, 1024) || "—", inline: false }
      );
    if (notice) embed.setDescription(notice.slice(0, 4096));

    const taxExemptSelect = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_cust_taxex:${token}`)
      .setPlaceholder("Tax exemption…")
      .addOptions(
        (["none", "exempt", "reverse"] as const).map((value) => ({
          label: TAX_EXEMPT_LABELS[value],
          value,
          default: taxExempt === value,
        }))
      );

    const localeSelect = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_cust_locale:${token}`)
      .setPlaceholder("Preferred locale…")
      .addOptions(
        ...LOCALE_OPTIONS.map((opt) => ({ label: opt.label, value: opt.value, default: locales[0] === opt.value })),
        { label: "Clear preferred locales", value: "__clear" }
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_edit_details:${token}`, "Details", ButtonStyle.Primary),
          btn(`billadmin_edit_address:${token}`, "Address", ButtonStyle.Primary),
          btn(`billadmin_cust_ship:${token}`, "Shipping", ButtonStyle.Primary),
          btn(`billadmin_cust_inv:${token}`, "Invoice & branding", ButtonStyle.Primary),
          btn(`billadmin_cust_meta:${token}`, "Metadata", ButtonStyle.Primary)
        ),
        selectRow(taxExemptSelect),
        selectRow(localeSelect),
        buttonRow(
          btn(`billadmin_taxid_add:${token}`, "Add tax ID", ButtonStyle.Primary),
          btn(`billadmin_taxid_remove:${token}`, "Remove tax ID", ButtonStyle.Secondary, taxIds.length === 0),
          btn(`billadmin_cust_delete:${token}`, "Delete customer", ButtonStyle.Danger),
          btn(`billadmin_nav_back:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private snapshotOf(customer: Stripe.Customer): CustSnapshot {
    return {
      name: customer.name ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      description: customer.description ?? "",
      address: customer.address ?? null,
      businessName: customer.business_name ?? "",
      individualName: customer.individual_name ?? "",
      shipping: customer.shipping ?? null,
      invoicePrefix: customer.invoice_prefix ?? "",
      nextInvoiceSequence: customer.next_invoice_sequence ?? null,
      invoiceFooter: customer.invoice_settings?.footer ?? "",
      invoiceCustomFields: (customer.invoice_settings?.custom_fields ?? []).map((f) => ({ name: f.name, value: f.value })),
      amountTaxDisplay: customer.invoice_settings?.rendering_options?.amount_tax_display ?? "",
      metadata: { ...customer.metadata },
    };
  }

  private async showTaxIdRemovePicker(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const taxIds = await this.ctx.stripe.listTaxIds(session.customerId);
    if (taxIds.length === 0) {
      await this.renderEditCustomer(interaction, token, "No tax IDs to remove.");
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_taxidpick:${token}`)
      .setPlaceholder("Pick the tax ID to remove")
      .addOptions(
        taxIds.slice(0, 25).map((t) => ({
          label: `${t.type} · ${t.value}`.slice(0, 100),
          value: t.id,
        }))
      );
    await interaction.editReply({
      embeds: [makeEmbed(`Removing a tax ID from \`${session.customerId}\` — pick one:`, COLORS.warn)],
      components: [
        selectRow(select),
        buttonRow(btn(`billadmin_editcust_show:${token}`, "Back", ButtonStyle.Secondary)),
      ],
    });
  }

  // Re-render the edit panel with a validation warning without losing the panel.
  private async rerenderWithWarning(interaction: EditSubmitInteraction, token: string, warning: string): Promise<void> {
    await this.ctx.sessions.tryRender(interaction, () => this.renderEditCustomer(interaction, token, warning));
  }

  private async handleEditDetailsModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    // 5th input: "b: Acme GmbH" → business_name, "i: Jane Doe" → individual_name,
    // blank → clear both. Setting one always clears the other.
    const bi = interaction.fields.getTextInputValue("bi_name").trim();
    let businessName = "";
    let individualName = "";
    if (bi) {
      const match = /^(b|i)\s*:\s*(.+)$/i.exec(bi);
      if (!match) {
        await this.rerenderWithWarning(
          interaction,
          token,
          "⚠️ Business/individual name must start with `b:` or `i:` (e.g. `b: Acme GmbH`, `i: Jane Doe`) — nothing was saved."
        );
        return;
      }
      if (match[1].toLowerCase() === "b") businessName = match[2].trim();
      else individualName = match[2].trim();
    }

    // Fields are pre-filled with current values, so what comes back IS the new
    // state: an emptied field means "clear it" (Stripe treats "" as unset).
    const params: Stripe.CustomerUpdateParams = {
      name: interaction.fields.getTextInputValue("name").trim(),
      email: interaction.fields.getTextInputValue("email").trim(),
      phone: interaction.fields.getTextInputValue("phone").trim(),
      description: interaction.fields.getTextInputValue("description").trim(),
      business_name: businessName,
      individual_name: individualName,
    };
    await this.applyCustomerEdit(interaction, token, params, "✅ Details updated.", "Edit customer details");
  }

  private async handleEditAddressModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    const get = (field: string) => interaction.fields.getTextInputValue(field).trim();
    const line1 = get("line1");
    const line2 = get("line2");
    const city = get("city");
    const postalCode = get("postal_code");
    const country = get("country").toUpperCase();

    let address: Stripe.CustomerUpdateParams["address"];
    if (!line1 && !line2 && !city && !postalCode && !country) {
      address = ""; // all fields cleared = remove the address entirely
    } else {
      address = {
        ...(line1 ? { line1 } : {}),
        ...(line2 ? { line2 } : {}),
        ...(city ? { city } : {}),
        ...(postalCode ? { postal_code: postalCode } : {}),
        ...(country ? { country } : {}),
        // state is intentionally NOT written here (5-input modal limit) — the
        // follow-up state modal re-adds it on top of the freshly stored address.
      };
    }

    // Offer the state/province follow-up when the country typically uses states
    // or a state was set before this edit (it has just been cleared).
    const hadState = Boolean(session.custSnapshot?.address?.state);
    const wantsStateFollowUp = address !== "" && (STATE_COUNTRIES.includes(country) || hadState);

    await this.applyCustomerEdit(
      interaction,
      token,
      { address },
      "✅ Address updated.",
      "Edit customer address",
      wantsStateFollowUp
        ? async () => {
            await interaction.editReply({
              embeds: [
                makeEmbed(
                  `✅ Address updated — the state/province is currently **cleared**.\n` +
                    `${country && STATE_COUNTRIES.includes(country) ? `\`${country}\` addresses usually carry one. ` : ""}` +
                    `Set it now, or go back to keep the address without a state.`,
                  COLORS.brand
                ),
              ],
              components: [
                buttonRow(
                  btn(`billadmin_cust_state_open:${token}`, "Set state/province…", ButtonStyle.Primary),
                  btn(`billadmin_editcust_show:${token}`, "Back", ButtonStyle.Secondary)
                ),
              ],
            });
          }
        : undefined
    );
  }

  // Second step of the address flow: re-fetch the just-stored address (race-safe,
  // no session stash needed) and write it back with the state added.
  private async handleStateModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    const state = interaction.fields.getTextInputValue("state").trim();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const customer = await this.ctx.stripe.getCustomer(session.customerId!);
      if (!customer) {
        await this.renderEditCustomer(interaction, token); // renders the "no such customer" panel
        return;
      }
      const current = customer.address;
      const address: Stripe.CustomerUpdateParams["address"] = {
        ...(current?.line1 ? { line1: current.line1 } : {}),
        ...(current?.line2 ? { line2: current.line2 } : {}),
        ...(current?.city ? { city: current.city } : {}),
        ...(current?.postal_code ? { postal_code: current.postal_code } : {}),
        ...(current?.country ? { country: current.country } : {}),
        ...(state ? { state } : {}),
      };
      await this.applyCustomerEdit(
        interaction,
        token,
        { address },
        state ? "✅ State/province set." : "✅ State/province left empty.",
        "Edit customer address (state)"
      );
    });
  }

  private async handleShippingModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    const get = (field: string) => interaction.fields.getTextInputValue(field).trim();
    const name = get("ship_name");
    const phone = get("ship_phone");
    const line1 = get("ship_line1");
    const cpc = get("ship_cpc");
    const extra = get("ship_extra");

    if (!name && !phone && !line1 && !cpc && !extra) {
      await this.applyCustomerEdit(interaction, token, { shipping: "" }, "✅ Shipping cleared.", "Clear customer shipping");
      return;
    }
    if (!name) {
      await this.rerenderWithWarning(
        interaction,
        token,
        "⚠️ Stripe requires a **recipient name** when shipping is set (leave every field blank to clear shipping) — nothing was saved."
      );
      return;
    }

    // "City, Postal, Country" — fixed order, country last. With more than three
    // segments the leading ones are joined back into the city.
    let city = "";
    let postal = "";
    let country = "";
    if (cpc) {
      const parts = cpc.split(",").map((p) => p.trim());
      if (parts.length >= 3) {
        country = parts[parts.length - 1];
        postal = parts[parts.length - 2];
        city = parts.slice(0, parts.length - 2).join(", ");
      } else {
        [city = "", postal = ""] = parts;
      }
      country = country.toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) {
        await this.rerenderWithWarning(
          interaction,
          token,
          `⚠️ Shipping country must be a 2-letter code (got \`${country}\`) — use \`City, Postal, Country\`, e.g. \`Berlin, 10115, DE\`. Nothing was saved.`
        );
        return;
      }
    }

    // Extra input: optional "state: …" and/or "line2: …" lines.
    let state = "";
    let line2 = "";
    const badExtra: string[] = [];
    for (const rawLine of extra.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^(state|line2)\s*:\s*(.*)$/i.exec(line);
      if (!match) {
        badExtra.push(line);
        continue;
      }
      if (match[1].toLowerCase() === "state") state = match[2].trim();
      else line2 = match[2].trim();
    }
    if (badExtra.length) {
      await this.rerenderWithWarning(
        interaction,
        token,
        `⚠️ Shipping extras must be \`state: …\` or \`line2: …\` lines — could not parse: ${badExtra
          .map((l) => `\`${l.slice(0, 50)}\``)
          .join(", ")}. Nothing was saved.`
      );
      return;
    }

    const shipping: Stripe.CustomerUpdateParams["shipping"] = {
      name,
      ...(phone ? { phone } : {}),
      address: {
        ...(line1 ? { line1 } : {}),
        ...(line2 ? { line2 } : {}),
        ...(city ? { city } : {}),
        ...(postal ? { postal_code: postal } : {}),
        ...(country ? { country } : {}),
        ...(state ? { state } : {}),
      },
    };
    await this.applyCustomerEdit(interaction, token, { shipping }, "✅ Shipping updated.", "Edit customer shipping");
  }

  private async handleInvoiceModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);
    const snap = session.custSnapshot;

    const get = (field: string) => interaction.fields.getTextInputValue(field).trim();

    // invoice_prefix / next_invoice_sequence are NOT Emptyable in the API type —
    // blank means "leave unchanged", not "clear".
    const prefix = get("inv_prefix").toUpperCase();
    if (prefix && !/^[A-Z0-9]{3,12}$/.test(prefix)) {
      await this.rerenderWithWarning(
        interaction,
        token,
        "⚠️ Invoice prefix must be 3-12 uppercase letters/digits (blank = keep current) — nothing was saved."
      );
      return;
    }

    const seqRaw = get("inv_seq");
    let nextSeq: number | undefined;
    if (seqRaw) {
      nextSeq = Number(seqRaw);
      if (!/^\d+$/.test(seqRaw) || !Number.isSafeInteger(nextSeq) || nextSeq < 1) {
        await this.rerenderWithWarning(
          interaction,
          token,
          "⚠️ Next invoice sequence must be a positive integer (blank = keep current) — nothing was saved."
        );
        return;
      }
    }

    const footer = get("inv_footer"); // "" clears (Stripe unsets text fields on empty string)

    const cfRaw = get("inv_cf");
    let customFields: Stripe.CustomerUpdateParams.InvoiceSettings["custom_fields"] = "";
    if (cfRaw) {
      const lines = cfRaw.split("\n").map((l) => l.trim()).filter(Boolean);
      const parsed: { name: string; value: string }[] = [];
      const bad: string[] = [];
      for (const line of lines) {
        const idx = line.indexOf(":");
        const cfName = idx > 0 ? line.slice(0, idx).trim() : "";
        const cfValue = idx > 0 ? line.slice(idx + 1).trim() : "";
        if (!cfName || !cfValue || cfName.length > 40 || cfValue.length > 140) bad.push(line);
        else parsed.push({ name: cfName, value: cfValue });
      }
      if (bad.length || parsed.length > 4) {
        await this.rerenderWithWarning(
          interaction,
          token,
          `⚠️ Custom fields: up to 4 \`Name: Value\` lines (name ≤40 chars, value ≤140).` +
            `${parsed.length > 4 ? ` Got ${parsed.length} lines.` : ""}` +
            `${bad.length ? ` Could not parse: ${bad.map((l) => `\`${l.slice(0, 50)}\``).join(", ")}.` : ""}` +
            " Nothing was saved."
        );
        return;
      }
      customFields = parsed;
    }

    // 5th input: "incl" → include_inclusive_tax, "excl" → exclude_tax, blank → clear.
    const taxDispRaw = get("inv_taxdisp").toLowerCase();
    let amountTaxDisplay: Stripe.Emptyable<"exclude_tax" | "include_inclusive_tax">;
    if (!taxDispRaw) amountTaxDisplay = "";
    else if (taxDispRaw === "incl") amountTaxDisplay = "include_inclusive_tax";
    else if (taxDispRaw === "excl") amountTaxDisplay = "exclude_tax";
    else {
      await this.rerenderWithWarning(
        interaction,
        token,
        "⚠️ Tax display must be `incl`, `excl` or blank (blank = no override) — nothing was saved."
      );
      return;
    }

    const params: Stripe.CustomerUpdateParams = {
      ...(prefix && prefix !== snap?.invoicePrefix ? { invoice_prefix: prefix } : {}),
      ...(nextSeq !== undefined ? { next_invoice_sequence: nextSeq } : {}),
      invoice_settings: {
        footer,
        custom_fields: customFields,
        rendering_options: { amount_tax_display: amountTaxDisplay },
      },
    };
    await this.applyCustomerEdit(interaction, token, params, "✅ Invoice & branding updated.", "Edit customer invoice settings");
  }

  private async handleMetadataModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    const raw = interaction.fields.getTextInputValue("meta").trim();
    if (!raw) {
      await this.applyCustomerEdit(interaction, token, { metadata: "" }, "✅ Metadata cleared.", "Clear customer metadata");
      return;
    }

    const metadata: Record<string, string> = {};
    const bad: string[] = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      const key = idx > 0 ? line.slice(0, idx).trim() : "";
      const value = idx > 0 ? line.slice(idx + 1).trim() : "";
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || value.length > 500) bad.push(line);
      else metadata[key] = value;
    }
    if (bad.length) {
      await this.rerenderWithWarning(
        interaction,
        token,
        `⚠️ Metadata lines must be \`key: value\` (key ≤40 chars, alnum/_/-, value ≤500 chars) — could not parse: ${bad
          .map((l) => `\`${l.slice(0, 60)}\``)
          .join(", ")}. Nothing was saved.`
      );
      return;
    }

    // Stripe merges metadata per key — keys the admin deleted from the pre-filled
    // text must be explicitly unset with an empty value.
    for (const key of Object.keys(session.custSnapshot?.metadata ?? {})) {
      if (!(key in metadata)) metadata[key] = "";
    }
    await this.applyCustomerEdit(interaction, token, { metadata }, "✅ Metadata updated.", "Edit customer metadata");
  }

  private async handleTaxIdAddModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    const type = interaction.fields.getTextInputValue("type").trim();
    const value = interaction.fields.getTextInputValue("value").trim();
    try {
      await this.ctx.stripe.addTaxId(session.customerId, type, value);
      this.ctx.audit.log(interaction, {
        action: "Add tax ID",
        targetCustomerId: session.customerId,
        objectId: value,
        outcome: `Success — ${type}`,
        severity: "info",
      });
      await this.renderEditCustomer(interaction, token, "✅ Tax ID added.");
    } catch (error) {
      await this.editCustomerErrorFallback(interaction, token, error);
    }
  }

  private async applyCustomerEdit(
    interaction: EditSubmitInteraction,
    token: string,
    params: Stripe.CustomerUpdateParams,
    notice: string,
    auditAction: string,
    onSuccess?: () => Promise<void>
  ): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    try {
      await this.ctx.stripe.updateCustomer(session.customerId, params);
      this.ctx.audit.log(interaction, {
        action: auditAction,
        targetCustomerId: session.customerId,
        outcome: "Success",
        severity: "info",
      });
      if (onSuccess) await onSuccess();
      else await this.renderEditCustomer(interaction, token, notice);
    } catch (error) {
      await this.editCustomerErrorFallback(interaction, token, error);
    }
  }

  // Keep the edit panel usable after a rejected update (bad VAT number, invalid
  // email, …) instead of dead-ending on an error-only screen.
  private async editCustomerErrorFallback(
    interaction: EditSubmitInteraction,
    token: string,
    error: unknown
  ): Promise<void> {
    logger.error("Billing admin customer edit error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    try {
      await this.renderEditCustomer(interaction, token, `⚠️ Stripe rejected the change: ${msg.slice(0, 500)}`);
    } catch {
      await interaction
        .editReply({ embeds: [stripeErrorEmbed(error)], components: [backRow()] })
        .catch(() => undefined);
    }
  }

  // ---- create ----

  private async handleCreateCustomerModal(interaction: ModalSubmitInteraction): Promise<void> {
    const email = interaction.fields.getTextInputValue("email").trim();
    const name = interaction.fields.getTextInputValue("name").trim();
    const phone = interaction.fields.getTextInputValue("phone").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    if (email && !email.includes("@")) {
      await interaction.reply({ embeds: [makeEmbed("That doesn't look like an email address.", COLORS.danger)], flags: 64 });
      return;
    }
    if (!email && !name) {
      await interaction.reply({
        embeds: [makeEmbed("Give the customer at least an email or a name.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const customer = await this.ctx.stripe.createCustomer({
        email: email || undefined,
        name: name || undefined,
        description: description || undefined,
      });
      // StripeClient.createCustomer doesn't take a phone — set it in a follow-up
      // update through the same path every other customer edit uses.
      if (phone) await this.ctx.stripe.updateCustomer(customer.id, { phone });
      this.ctx.audit.log(interaction, {
        action: "Create customer",
        targetCustomerId: customer.id,
        outcome: `Success${email ? ` — ${email}` : ""}${phone ? " — phone set" : ""}`,
        severity: "success",
      });
      // Snapshot up front so [Set address…] can open the address modal without
      // a render of the edit panel in between.
      const snapshot = this.snapshotOf(customer);
      snapshot.phone = phone;
      const token = this.ctx.sessions.newSession(interaction, { customerId: customer.id, custSnapshot: snapshot });
      await interaction.editReply({
        embeds: [
          makeEmbed(
            `✅ Customer \`${customer.id}\` created${email ? ` for **${email}**` : ""}.`,
            COLORS.success
          ),
        ],
        components: [
          buttonRow(
            btn(`billadmin_edit_address:${token}`, "Set address…", ButtonStyle.Primary),
            btn(`billadmin_editcust_show:${token}`, "Edit customer", ButtonStyle.Secondary),
            btn("billadmin_hub:customers", "Back", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  // ---- delete ----

  // The delete confirm is reachable both from the customers hub (delcust) and
  // from inside the edit panel; the optional customer object enriches the former.
  buildCustomerDeleteConfirm(token: string, customer?: Stripe.Customer): Panel {
    const session = this.ctx.sessions.get(token);
    const customerId = session?.customerId ?? "?";
    const who = customer ? ` (${[customer.email, customer.name].filter(Boolean).join(", ") || "no email/name"})` : "";
    const embed = new EmbedBuilder()
      .setTitle("Delete customer")
      .setColor(COLORS.danger)
      .setDescription(
        `⚠️ This **permanently deletes** \`${customerId}\`${who} in Stripe: active subscriptions are ` +
          "cancelled immediately, and the deletion **cannot be undone**. Payment history stays visible " +
          "in the Stripe dashboard, but the customer object is gone."
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_cust_delete_exec:${token}`, "Delete customer", ButtonStyle.Danger),
          btn(`billadmin_editcust_show:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- modals ----

  buildCreateCustomerModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_createcust_modal")
      .setTitle("Create a Stripe customer")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("email", "Email", { required: false, placeholder: "mail@example.com" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("name", "Name / company", { required: false })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("phone", "Phone", { required: false, placeholder: "+49 30 123456" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("description", "Description", { required: false, style: TextInputStyle.Paragraph })
        )
      );
  }

  private buildLinkModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_link_modal:${token}`)
      .setTitle("Link Stripe customer")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("customer_id", "Stripe customer ID", { required: true, placeholder: "cus_…" })
        )
      );
  }

  private buildEditDetailsModal(token: string, snap: CustSnapshot): ModalBuilder {
    const biValue = snap.businessName ? `b: ${snap.businessName}` : snap.individualName ? `i: ${snap.individualName}` : "";
    return new ModalBuilder()
      .setCustomId(`billadmin_edit_details_modal:${token}`)
      .setTitle("Edit customer details")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("name", "Name / company (empty = clear)", { required: false, value: snap.name })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("email", "Email (empty = clear)", { required: false, value: snap.email })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("phone", "Phone (empty = clear)", { required: false, value: snap.phone })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("description", "Description (empty = clear)", {
            required: false,
            value: snap.description,
            style: TextInputStyle.Paragraph,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("bi_name", "Business/individual — 'b: X' or 'i: X'", {
            required: false,
            value: biValue,
            placeholder: "b: Acme GmbH — or — i: Jane Doe (empty = clear both)",
          })
        )
      );
  }

  private buildStateModal(token: string, currentState: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_cust_state_modal:${token}`)
      .setTitle("Set state / province")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("state", "State / province (empty = none)", {
            required: false,
            value: currentState,
            placeholder: "e.g. CA, Ontario, Bayern",
          })
        )
      );
  }

  private buildShippingModal(token: string, snap: CustSnapshot): ModalBuilder {
    const addr = snap.shipping?.address;
    const cpcValue =
      addr?.city || addr?.postal_code || addr?.country
        ? [addr?.city ?? "", addr?.postal_code ?? "", addr?.country ?? ""].join(", ")
        : "";
    const extraValue = [
      addr?.state ? `state: ${addr.state}` : null,
      addr?.line2 ? `line2: ${addr.line2}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return new ModalBuilder()
      .setCustomId(`billadmin_cust_ship_modal:${token}`)
      .setTitle("Edit shipping (all empty = clear)")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("ship_name", "Recipient name (required if shipping set)", {
            required: false,
            value: snap.shipping?.name ?? "",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("ship_phone", "Phone", { required: false, value: snap.shipping?.phone ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("ship_line1", "Address line 1", { required: false, value: addr?.line1 ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("ship_cpc", "City, Postal, Country (comma-separated)", {
            required: false,
            value: cpcValue,
            placeholder: "Berlin, 10115, DE",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("ship_extra", "Extras: 'state: …' / 'line2: …' per line", {
            required: false,
            value: extraValue,
            placeholder: "state: Bayern\nline2: c/o Foo",
            style: TextInputStyle.Paragraph,
          })
        )
      );
  }

  private buildInvoiceModal(token: string, snap: CustSnapshot): ModalBuilder {
    const cfValue = snap.invoiceCustomFields.map((f) => `${f.name}: ${f.value}`).join("\n");
    const taxDispValue =
      snap.amountTaxDisplay === "include_inclusive_tax" ? "incl" : snap.amountTaxDisplay === "exclude_tax" ? "excl" : "";
    return new ModalBuilder()
      .setCustomId(`billadmin_cust_inv_modal:${token}`)
      .setTitle("Invoice & branding")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("inv_prefix", "Invoice prefix (3-12 A-Z/0-9, empty=keep)", {
            required: false,
            value: snap.invoicePrefix,
            maxLength: 12,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("inv_seq", "Next invoice sequence (empty = keep)", {
            required: false,
            value: snap.nextInvoiceSequence != null ? String(snap.nextInvoiceSequence) : "",
            placeholder: "e.g. 42",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("inv_footer", "Invoice footer (empty = clear)", {
            required: false,
            value: snap.invoiceFooter,
            style: TextInputStyle.Paragraph,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("inv_cf", "Custom fields: 'Name: Value' /line, max 4", {
            required: false,
            value: cfValue,
            placeholder: "VAT-ID: DE123456789 (empty = clear all)",
            style: TextInputStyle.Paragraph,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("inv_taxdisp", "Tax display: incl / excl (empty = none)", {
            required: false,
            value: taxDispValue,
            placeholder: "incl = include inclusive tax · excl = exclude tax",
          })
        )
      );
  }

  private buildMetadataModal(token: string, snap: CustSnapshot): ModalBuilder {
    const value = Object.entries(snap.metadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return new ModalBuilder()
      .setCustomId(`billadmin_cust_meta_modal:${token}`)
      .setTitle("Edit metadata")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("meta", "'key: value' per line (empty = clear all)", {
            required: false,
            value,
            placeholder: "plan_source: import\nvip: yes",
            style: TextInputStyle.Paragraph,
          })
        )
      );
  }

  private buildEditAddressModal(token: string, address: Stripe.Address | null): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_edit_address_modal:${token}`)
      .setTitle("Edit customer address")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("line1", "Address line 1", { required: false, value: address?.line1 ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("line2", "Address line 2", { required: false, value: address?.line2 ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("city", "City", { required: false, value: address?.city ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("postal_code", "Postal code", { required: false, value: address?.postal_code ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("country", "Country (2-letter code, e.g. DE)", {
            required: false,
            value: address?.country ?? "",
            maxLength: 2,
          })
        )
      );
  }

  private buildTaxIdAddModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_taxid_add_modal:${token}`)
      .setTitle("Add tax ID (VAT etc.)")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("type", "Type (eu_vat, gb_vat, ch_vat, us_ein, …)", {
            required: true,
            value: "eu_vat",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("value", "Value", { required: true, placeholder: "e.g. DE123456789" })
        )
      );
  }
}
