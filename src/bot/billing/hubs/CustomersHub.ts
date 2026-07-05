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
} from "discord.js";
import type Stripe from "stripe";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { Logger } from "../../../util/logger";
import { backRow, btn, buttonRow, formatAddress, hubBack, selectRow, stripeErrorEmbed, subPlanLabel, textInput } from "../ui";
import type { BillAdminSession, Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const logger = new Logger("billing-admin:customers");

// Customers hub: overview, create/edit (details, address, tax IDs), the
// Discord ↔ Stripe link and customer deletion.
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
  ];

  // ---- overview (the "overview" target action) ----

  async renderOverview(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;

    const [customer, subscriptions, discordIds, priceMap] = await Promise.all([
      this.ctx.stripe.getCustomer(customerId),
      this.ctx.stripe.listSubscriptions(customerId),
      this.ctx.sessionStore.findDiscordIdsByStripeId(customerId),
      this.ctx.priceBook.labelMap(),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [backRow(hubBack("overview", session.originHub))],
      });
      return;
    }

    const defaultPm = customer.invoice_settings?.default_payment_method;
    const subLines = subscriptions.slice(0, 10).map((sub) => {
      const periodEnd = sub.items.data[0]?.current_period_end;
      const flags = sub.cancel_at_period_end ? " · cancels at period end" : "";
      return `**${subPlanLabel(this.ctx.stripe, sub, priceMap)}** · \`${sub.id}\` · ${sub.status}${flags}${periodEnd ? ` · ends <t:${periodEnd}:D>` : ""}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Customer — \`${customer.id}\``)
      .setColor(COLORS.brand)
      .addFields(
        { name: "Email", value: customer.email ?? "—", inline: true },
        { name: "Name", value: customer.name ?? "—", inline: true },
        { name: "Created", value: `<t:${customer.created}:D>`, inline: true },
        {
          name: "Balance",
          value: `${this.ctx.stripe.formatAmount(customer.balance, customer.currency ?? "usd")}${customer.balance < 0 ? " (credit)" : ""}`,
          inline: true,
        },
        { name: "Delinquent", value: customer.delinquent ? "⚠️ yes" : "no", inline: true },
        {
          name: "Default payment method",
          value: defaultPm ? `\`${typeof defaultPm === "string" ? defaultPm : defaultPm.id}\`` : "—",
          inline: true,
        },
        {
          name: `Subscriptions (${subscriptions.length})`,
          value: subLines.join("\n").slice(0, 1024) || "—",
          inline: false,
        },
        {
          name: "Discord",
          value: discordIds.length ? discordIds.map((d) => `<@${d}>`).join(" ") : "no linked Discord user",
          inline: false,
        }
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_goto:charges:${token}`, "View Charges", ButtonStyle.Primary),
          btn(`billadmin_goto:invoices:${token}`, "Invoices", ButtonStyle.Primary),
          btn(`billadmin_goto:fraud:${token}`, "Disputes & Fraud", ButtonStyle.Primary)
        ),
        backRow(hubBack("overview", session.originHub)),
      ],
    });
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
    session.custSnapshot = {
      name: customer.name ?? "",
      email: customer.email ?? "",
      phone: customer.phone ?? "",
      description: customer.description ?? "",
      address: customer.address ?? null,
    };

    const taxIdLines = taxIds
      .slice(0, 15)
      .map((t) => `\`${t.id}\` · ${t.type} · **${t.value}**${t.verification?.status ? ` · ${t.verification.status}` : ""}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`Edit customer — \`${customer.id}\``)
      .setColor(COLORS.brand)
      .addFields(
        { name: "Name / company", value: customer.name ?? "—", inline: true },
        { name: "Email", value: customer.email ?? "—", inline: true },
        { name: "Phone", value: customer.phone ?? "—", inline: true },
        { name: "Description", value: (customer.description ?? "—").slice(0, 1024), inline: false },
        { name: "Address", value: formatAddress(customer.address), inline: false },
        { name: `Tax IDs (${taxIds.length})`, value: taxIdLines.slice(0, 1024) || "—", inline: false }
      );
    if (notice) embed.setDescription(notice);

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_edit_details:${token}`, "Edit details", ButtonStyle.Primary),
          btn(`billadmin_edit_address:${token}`, "Edit address", ButtonStyle.Primary)
        ),
        buttonRow(
          btn(`billadmin_taxid_add:${token}`, "Add tax ID", ButtonStyle.Primary),
          btn(`billadmin_taxid_remove:${token}`, "Remove tax ID", ButtonStyle.Secondary, taxIds.length === 0),
          btn(`billadmin_cust_delete:${token}`, "Delete customer", ButtonStyle.Danger),
          btn("billadmin_hub:customers", "Back", ButtonStyle.Secondary)
        ),
      ],
    });
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
        buttonRow(btn(`billadmin_editcust_show:${token}`, "◀ Back", ButtonStyle.Secondary)),
      ],
    });
  }

  private async handleEditDetailsModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ctx.sessions.ackModal(interaction);

    // Fields are pre-filled with current values, so what comes back IS the new
    // state: an emptied field means "clear it" (Stripe treats "" as unset).
    const params: Stripe.CustomerUpdateParams = {
      name: interaction.fields.getTextInputValue("name").trim(),
      email: interaction.fields.getTextInputValue("email").trim(),
      phone: interaction.fields.getTextInputValue("phone").trim(),
      description: interaction.fields.getTextInputValue("description").trim(),
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
    const country = get("country");

    let address: Stripe.CustomerUpdateParams["address"];
    if (!line1 && !line2 && !city && !postalCode && !country) {
      address = ""; // all fields cleared = remove the address entirely
    } else {
      address = {
        ...(line1 ? { line1 } : {}),
        ...(line2 ? { line2 } : {}),
        ...(city ? { city } : {}),
        ...(postalCode ? { postal_code: postalCode } : {}),
        ...(country ? { country: country.toUpperCase() } : {}),
        // state isn't editable here (5-field modal limit) — carry it over.
        ...(session.custSnapshot?.address?.state ? { state: session.custSnapshot.address.state } : {}),
      };
    }
    await this.applyCustomerEdit(interaction, token, { address }, "✅ Address updated.", "Edit customer address");
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
    interaction: ModalSubmitInteraction,
    token: string,
    params: Stripe.CustomerUpdateParams,
    notice: string,
    auditAction: string
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
      await this.renderEditCustomer(interaction, token, notice);
    } catch (error) {
      await this.editCustomerErrorFallback(interaction, token, error);
    }
  }

  // Keep the edit panel usable after a rejected update (bad VAT number, invalid
  // email, …) instead of dead-ending on an error-only screen.
  private async editCustomerErrorFallback(
    interaction: ModalSubmitInteraction,
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
      this.ctx.audit.log(interaction, {
        action: "Create customer",
        targetCustomerId: customer.id,
        outcome: `Success${email ? ` — ${email}` : ""}`,
        severity: "success",
      });
      const token = this.ctx.sessions.newSession(interaction, { customerId: customer.id });
      await this.renderEditCustomer(interaction, token, `✅ Customer \`${customer.id}\` created.`);
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

  private buildEditDetailsModal(token: string, snap: NonNullable<BillAdminSession["custSnapshot"]>): ModalBuilder {
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
