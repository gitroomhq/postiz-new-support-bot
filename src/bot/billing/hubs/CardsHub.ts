import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  StringSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { StripeClient } from "../../StripeClient";
import { backRow, btn, buttonRow, selectRow, textInput } from "../ui";
import { FINGERPRINT_RE, type RenderInteraction, type RouteEntry } from "../types";
import type { HubContext } from "./HubContext";
import { renderListPage } from "./ChargesHub";

// Cards hub: card lookups (per user, by fingerprint, by last 4) and saved
// payment-method management (set default / detach). Also home of the two
// account-wide find flows, which are ENTERED from other hubs since the nav
// reorg: Find by Amount from 💰 Payments, Find by Name/Email from 👤 Customers
// (their Back targets point there accordingly).
export class CardsHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_cards_show:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderCards(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_card_default:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId || !session.paymentMethodId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.setDefaultPaymentMethod(session.customerId!, session.paymentMethodId!);
          this.ctx.audit.log(interaction, {
            action: "Set default payment method",
            targetCustomerId: session.customerId,
            objectId: session.paymentMethodId,
            outcome: "Success",
            severity: "info",
          });
          await this.renderCards(interaction, token, `✅ \`${session.paymentMethodId}\` is now the default.`);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_card_detach:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId || !session.paymentMethodId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.detachPaymentMethod(session.paymentMethodId!);
          this.ctx.audit.log(interaction, {
            action: "Detach payment method",
            targetCustomerId: session.customerId,
            objectId: session.paymentMethodId,
            outcome: "Success",
            severity: "warn",
          });
          await this.renderCards(interaction, token, `🗑️ Detached \`${session.paymentMethodId}\`.`);
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_cardpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        session.paymentMethodId = value;
        await this.ctx.sessions.tryRender(interaction, async () => {
          const embed = new EmbedBuilder()
            .setTitle("Card actions")
            .setColor(COLORS.brand)
            .setDescription(
              `Payment method \`${value}\` on \`${session.customerId}\`.\n\n` +
                "Detaching removes the saved card from the customer (the customer can re-add it; " +
                "past charges are unaffected)."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_card_default:${token}`, "Set as default", ButtonStyle.Primary),
                btn(`billadmin_card_detach:${token}`, "Detach card", ButtonStyle.Danger),
                btn(`billadmin_cards_show:${token}`, "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_fp_modal:",
      match: "prefix",
      handler: (interaction) => this.handleFingerprintModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "modal",
      id: "billadmin_last4_modal",
      match: "exact",
      handler: (interaction) => this.handleLast4Modal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_findamt_modal",
      match: "exact",
      handler: (interaction) => this.handleFindAmountModal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_findname_modal",
      match: "exact",
      handler: (interaction) => this.handleFindNameModal(interaction),
    },
  ];

  buildFingerprintModal(action: string): ModalBuilder {
    const titles: Record<string, string> = {
      usersbycard: "Users by card fingerprint",
      chargesbycard: "Charges by card fingerprint",
    };
    return new ModalBuilder()
      .setCustomId(`billadmin_fp_modal:${action}`)
      .setTitle(titles[action] ?? "Card fingerprint")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("fingerprint", "Card fingerprint", {
            required: true,
            placeholder: "e.g. Xt5EWLLDS7FJjR1c",
          })
        )
      );
  }

  buildLast4Modal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_last4_modal")
      .setTitle("Cards by last 4 digits")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("last4", "Last 4 digits", { required: true, placeholder: "4242", maxLength: 4 })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("brand", "Brand filter (optional)", {
            required: false,
            placeholder: "visa / mastercard / amex, narrows results",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("status", "Status filter (optional)", {
            required: false,
            placeholder: "failed / succeeded / pending, blank = all",
            maxLength: 9,
          })
        )
      );
  }

  buildFindAmountModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_findamt_modal")
      .setTitle("Find payments by amount")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", "Amount (e.g. 25.39)", { required: true, placeholder: "25.39" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("currency", "Currency (optional, e.g. eur)", {
            required: false,
            placeholder: "eur, narrows results",
            maxLength: 3,
          })
        )
      );
  }

  buildFindNameModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_findname_modal")
      .setTitle("Find customer by name / email")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("term", "Name or email (partial is fine)", {
            required: true,
            placeholder: "True Brew Birdie / jan@example.com",
          })
        )
      );
  }

  // ---- account-wide "find when card lookups come up empty" flows ----

  // Amount search hits PaymentIntents, so it surfaces attempts that never
  // produced ANY charge (abandoned checkout, unfinished 3DS) — the slice the
  // last4/charge searches cannot see. Ordinary declines DO become failed
  // charges; the last4 hunt reaches those with its status filter.
  private async handleFindAmountModal(interaction: ModalSubmitInteraction): Promise<void> {
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    const currencyRaw = interaction.fields.getTextInputValue("currency").trim().toLowerCase();
    if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) {
      await interaction.reply({ embeds: [makeEmbed("Enter an amount like `25.39`.", COLORS.danger)], flags: 64 });
      return;
    }
    if (currencyRaw && !/^[a-z]{3}$/.test(currencyRaw)) {
      await interaction.reply({
        embeds: [makeEmbed("Currency must be a 3-letter code (eur, usd, …) or left blank.", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    const zeroDecimal = currencyRaw ? StripeClient.isZeroDecimal(currencyRaw) : false;
    const amountMinor = zeroDecimal ? Math.round(Number(amountRaw)) : Math.round(Number(amountRaw) * 100);
    const label = `${amountRaw}${currencyRaw ? ` ${currencyRaw.toUpperCase()}` : ""}`;

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const { paymentIntents, nextPage } = await this.ctx.stripe.searchPaymentIntentsByAmount(
        amountMinor,
        currencyRaw || undefined,
        50
      );
      if (paymentIntents.length === 0) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `No payment attempts found for **${label}** (this includes declined ones).\n\n` +
                "If the customer is sure of the amount, it may be on a **different Stripe account** or a " +
                "different currency: try leaving the currency blank, or search by name instead.",
              COLORS.neutral
            ),
          ],
          components: [backRow("billadmin_hub:pay")],
        });
        return;
      }
      await this.renderPaymentMatches(interaction, paymentIntents, nextPage, label);
    });
  }

  private async renderPaymentMatches(
    interaction: ModalSubmitInteraction,
    pis: Stripe.PaymentIntent[],
    nextPage: string | null,
    label: string
  ): Promise<void> {
    const custIds: string[] = [];
    const lines = pis.map((pi) => {
      const charge = pi.latest_charge && typeof pi.latest_charge !== "string" ? pi.latest_charge : null;
      const card = charge?.payment_method_details?.card;
      const cusId = typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;
      if (cusId && !custIds.includes(cusId)) custIds.push(cusId);
      const icon = pi.status === "succeeded" ? "✅" : "⛔";
      const email = charge?.billing_details?.email ?? charge?.receipt_email ?? pi.receipt_email ?? null;
      const reason = pi.last_payment_error?.message ?? charge?.outcome?.seller_message ?? charge?.failure_message ?? null;
      return (
        `${icon} **${this.ctx.stripe.formatAmount(pi.amount, pi.currency)}** · ${pi.status} · <t:${pi.created}:R>\n` +
        `${cusId ? `\`${cusId}\`` : "no customer"}${email ? ` · ${email}` : ""}` +
        `${card ? ` · ${card.brand} •••• ${card.last4}` : ""}` +
        `${reason ? `\n↳ ${reason}` : ""}`
      );
    });

    const embed = new EmbedBuilder()
      .setTitle(`Payment attempts · ${label}`)
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n\n").slice(0, 4096))
      .setFooter({
        text:
          `${pis.length} attempt(s)${nextPage ? " · more exist" : ""} · ⛔ = declined/incomplete · ` +
          "pick a customer to open their overview · Search data can lag ~1 min",
      });

    const components = [];
    if (custIds.length > 0) {
      const token = this.ctx.sessions.newSession(interaction, { pendingAction: "overview", originHub: "pay" });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cuspick:${token}`)
        .setPlaceholder("Open a customer's overview…")
        .addOptions(custIds.slice(0, 25).map((id) => ({ label: id, description: "open overview", value: id })));
      components.push(selectRow(select));
    }
    components.push(backRow("billadmin_hub:pay"));
    await interaction.editReply({ embeds: [embed], components });
  }

  private async handleFindNameModal(interaction: ModalSubmitInteraction): Promise<void> {
    // Strip quotes/backslashes: term is interpolated into the Stripe search query.
    const term = interaction.fields.getTextInputValue("term").replace(/["\\]/g, "").trim();
    if (term.length < 2) {
      await interaction.reply({
        embeds: [makeEmbed("Enter at least 2 characters (name or email) to search.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const customers = await this.ctx.stripe.searchCustomersByTerm(term, 20);
      if (customers.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No Stripe customers matched \`${term}\` (name or email).`, COLORS.neutral)],
          components: [backRow("billadmin_hub:customers")],
        });
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { pendingAction: "overview", originHub: "customers" });
      const lines = customers.map((c) => `\`${c.id}\` · ${c.name ?? "no name"} · ${c.email ?? "no email"}`);
      const embed = new EmbedBuilder()
        .setTitle(`Customers matching "${term}"`)
        .setColor(COLORS.brand)
        .setDescription(lines.join("\n").slice(0, 4096))
        .setFooter({
          text: `${customers.length} match(es) · pick one to open their overview · Search data can lag ~1 min`,
        });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cuspick:${token}`)
        .setPlaceholder("Open a customer's overview…")
        .addOptions(
          customers.slice(0, 25).map((c) => ({
            label: (c.email ?? c.id).slice(0, 100),
            description: `${c.name ?? "no name"} · ${c.id}`.slice(0, 100),
            value: c.id,
          }))
        );
      await interaction.editReply({ embeds: [embed], components: [selectRow(select), backRow("billadmin_hub:customers")] });
    });
  }

  // ---- fingerprint-driven flows (users by card, charges by card) ----

  private async handleFingerprintModal(interaction: ModalSubmitInteraction, action: string): Promise<void> {
    const fingerprint = interaction.fields.getTextInputValue("fingerprint").trim();
    if (!FINGERPRINT_RE.test(fingerprint)) {
      await interaction.reply({
        embeds: [makeEmbed("That doesn't look like a card fingerprint (8-64 letters/digits).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      if (action === "usersbycard") {
        await this.renderUsersByCard(interaction, fingerprint);
        return;
      }
      if (action === "chargesbycard") {
        const token = this.ctx.sessions.newSession(interaction, { fingerprint, view: "fpcharges", cursors: [undefined] });
        await renderListPage(this.ctx, interaction, token, 0);
      }
    });
  }

  private async handleLast4Modal(interaction: ModalSubmitInteraction): Promise<void> {
    const last4 = interaction.fields.getTextInputValue("last4").trim();
    const brand = interaction.fields.getTextInputValue("brand").trim().toLowerCase();
    const status = interaction.fields.getTextInputValue("status").trim().toLowerCase();
    if (!/^\d{4}$/.test(last4)) {
      await interaction.reply({ embeds: [makeEmbed("Enter exactly the 4 digits.", COLORS.danger)], flags: 64 });
      return;
    }
    if (status && !/^(succeeded|pending|failed)$/.test(status)) {
      await interaction.reply({
        embeds: [makeEmbed("Status must be `failed`, `succeeded` or `pending` (or blank for all).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if (brand && !/^[a-z_]+$/.test(brand)) {
      await interaction.reply({
        embeds: [makeEmbed("Brand must be letters only (visa, mastercard, amex, …).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const { charges, nextPage } = await this.ctx.stripe.searchChargesByCardLast4(
        last4,
        brand || undefined,
        100,
        undefined,
        (status || undefined) as "succeeded" | "pending" | "failed" | undefined
      );
      if (charges.length === 0) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `No ${status ? `**${status}** ` : ""}charges found for cards ending \`${last4}\`${brand ? ` (${brand})` : ""}.\n\n` +
                "⚠️ Declined and Radar-blocked payments **do** show up here as failed charges. What this search can't " +
                "see is an attempt that never reached confirmation (abandoned checkout, unfinished 3DS). Use " +
                "**Find by Amount** for those.",
              COLORS.neutral
            ),
          ],
          components: [
            buttonRow(
              btn("billadmin_open:findamount", "Find by Amount", ButtonStyle.Primary),
              btn("billadmin_hub:cards", "Back", ButtonStyle.Secondary)
            ),
          ],
        });
        return;
      }

      // last4 is not unique, so group by fingerprint — that's the id the other
      // card tools take for exact matching.
      type Group = {
        label: string;
        exp: string;
        fp: string | null;
        count: number;
        failed: number;
        lastFail: { piId: string | null; chargeId: string; reason: string | null; created: number } | null;
        customers: Map<string, string | null>;
      };
      const groups = new Map<string, Group>();
      for (const charge of charges) {
        const card = charge.payment_method_details?.card;
        if (!card) continue;
        const key = card.fingerprint ?? `${card.brand}-${card.last4}-nofp`;
        const group = groups.get(key) ?? {
          label: `${card.brand ?? "card"} •••• ${card.last4 ?? last4}`,
          exp: `${card.exp_month ?? "?"}/${card.exp_year ?? "?"}`,
          fp: card.fingerprint ?? null,
          count: 0,
          failed: 0,
          lastFail: null,
          customers: new Map(),
        };
        group.count++;
        if (charge.status === "failed") {
          group.failed++;
          if (!group.lastFail || charge.created > group.lastFail.created) {
            group.lastFail = {
              piId: typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null),
              chargeId: charge.id,
              reason: charge.outcome?.seller_message ?? charge.failure_message ?? charge.failure_code ?? null,
              created: charge.created,
            };
          }
        }
        const cusId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
        if (cusId && !group.customers.has(cusId)) {
          group.customers.set(cusId, charge.billing_details?.email ?? charge.receipt_email ?? null);
        }
        groups.set(key, group);
      }

      const lines = [...groups.values()].map((g) => {
        const customers = [...g.customers.entries()]
          .slice(0, 5)
          .map(([id, email]) => `\`${id}\`${email ? ` (${email})` : ""}`)
          .join(", ");
        const more = g.customers.size > 5 ? ` +${g.customers.size - 5} more` : "";
        const lastFail = g.lastFail
          ? `\n↳ last failed <t:${g.lastFail.created}:R>: ${g.lastFail.reason ?? "no reason given"} · \`${g.lastFail.piId ?? g.lastFail.chargeId}\``
          : "";
        return (
          `**${g.label}** · exp ${g.exp} · ${g.count} charge(s)${g.failed ? ` · ⛔ ${g.failed} failed` : ""}\n` +
          `fingerprint: ${g.fp ? `\`${g.fp}\`` : "N/A"}\ncustomers: ${customers || "N/A"}${more}${lastFail}`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`Cards ending •••• ${last4}${brand ? ` (${brand})` : ""}${status ? ` · ${status} only` : ""}`)
        .setColor(COLORS.brand)
        .setDescription(lines.join("\n\n").slice(0, 4096))
        .setFooter({
          text:
            `From the ${charges.length} most recent matching charges${nextPage ? " · more exist" : ""} · ` +
            "last4 is not unique · use the fingerprint tools for exact matches · Search data can lag ~1 min",
        });
      await interaction.editReply({ embeds: [embed], components: [backRow("billadmin_hub:cards")] });
    });
  }

  private async renderUsersByCard(interaction: RenderInteraction, fingerprint: string): Promise<void> {
    const { charges, nextPage } = await this.ctx.stripe.searchChargesByCardFingerprint(fingerprint, 100);
    if (charges.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`No charges found for card fingerprint \`${fingerprint}\`.`, COLORS.neutral)],
        components: [backRow("billadmin_hub:cards")],
      });
      return;
    }

    const byCustomer = new Map<string, { email: string | null; count: number }>();
    for (const charge of charges) {
      const cusId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? "(no customer)";
      const entry = byCustomer.get(cusId) ?? { email: null, count: 0 };
      entry.count++;
      entry.email = entry.email ?? charge.billing_details?.email ?? charge.receipt_email ?? null;
      byCustomer.set(cusId, entry);
    }

    const lines: string[] = [];
    for (const [cusId, info] of byCustomer) {
      const discordIds = cusId.startsWith("cus_") ? await this.ctx.sessionStore.findDiscordIdsByStripeId(cusId) : [];
      const discord = discordIds.length ? discordIds.map((d) => `<@${d}>`).join(" ") : "no Discord link";
      lines.push(`\`${cusId}\` · ${info.email ?? "no email"} · ${info.count} charge(s) · ${discord}`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`Users with card \`${fingerprint}\``)
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096))
      .setFooter({
        text:
          `Aggregated from the ${charges.length} most recent matching charges` +
          `${nextPage ? " · more exist" : ""} · Search data can lag ~1 min`,
      });
    await interaction.editReply({ embeds: [embed], components: [backRow("billadmin_hub:cards")] });
  }

  // ---- customer-scoped renderer (also the "cards" target action) ----

  async renderCards(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;
    // Empty-nav-stack fallback for this panel's Back button.
    session.originHub ??= "cards";

    const [paymentMethods, chargesRes, customer] = await Promise.all([
      this.ctx.stripe.listCustomerCards(customerId),
      this.ctx.stripe.listCharges(customerId, 100),
      this.ctx.stripe.getCustomer(customerId),
    ]);
    const defaultPm = customer?.invoice_settings?.default_payment_method;
    const defaultPmId = typeof defaultPm === "string" ? defaultPm : defaultPm?.id;

    type CardInfo = { brand: string; last4: string; exp: string; funding: string; country: string; saved: boolean; count: number };
    const cards = new Map<string, CardInfo>();
    for (const pm of paymentMethods) {
      const card = pm.card;
      if (!card?.fingerprint) continue;
      cards.set(card.fingerprint, {
        brand: card.brand,
        last4: card.last4,
        exp: `${card.exp_month}/${card.exp_year}`,
        funding: card.funding,
        country: card.country ?? "N/A",
        saved: true,
        count: 0,
      });
    }
    for (const charge of chargesRes.charges) {
      const card = charge.payment_method_details?.card;
      if (!card?.fingerprint) continue;
      const existing = cards.get(card.fingerprint);
      if (existing) {
        existing.count++;
      } else {
        cards.set(card.fingerprint, {
          brand: card.brand ?? "card",
          last4: card.last4 ?? "????",
          exp: `${card.exp_month ?? "?"}/${card.exp_year ?? "?"}`,
          funding: card.funding ?? "N/A",
          country: card.country ?? "N/A",
          saved: false,
          count: 1,
        });
      }
    }

    if (cards.size === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`No card payment methods or card charges found for \`${customerId}\`.`, COLORS.neutral)],
        components: [backRow(`billadmin_nav_back:${token}`)],
      });
      return;
    }

    const lines = [...cards.entries()].map(
      ([fp, c]) =>
        `**${c.brand} •••• ${c.last4}** · exp ${c.exp} · ${c.funding} · ${c.country} · ` +
        `${c.saved ? "saved" : "historical"}${c.count ? ` (${c.count} charge${c.count === 1 ? "" : "s"})` : ""}\n` +
        `fingerprint: \`${fp}\``
    );

    const pmLines = paymentMethods.map(
      (pm) =>
        `\`${pm.id}\` · ${pm.card?.brand ?? "card"} •••• ${pm.card?.last4 ?? "????"}` +
        `${pm.id === defaultPmId ? " · ⭐ default" : ""}`
    );

    const embed = new EmbedBuilder()
      .setTitle(`Cards · \`${customerId}\``)
      .setColor(COLORS.brand)
      .setDescription(
        [notice, lines.join("\n\n"), pmLines.length ? `\n**Saved payment methods**\n${pmLines.join("\n")}` : null]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4096)
      )
      .setFooter({ text: "Historical cards come from the 100 most recent charges" });

    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (paymentMethods.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cardpick:${token}`)
        .setPlaceholder("Pick a saved card to set default / detach")
        .addOptions(
          paymentMethods.slice(0, 25).map((pm) => ({
            label: `${pm.card?.brand ?? "card"} •••• ${pm.card?.last4 ?? "????"}${pm.id === defaultPmId ? " (default)" : ""}`.slice(0, 100),
            description: pm.id.slice(0, 100),
            value: pm.id,
          }))
        );
      components.push(selectRow(select));
    }
    components.push(backRow(`billadmin_nav_back:${token}`));
    await interaction.editReply({ embeds: [embed], components });
  }
}
