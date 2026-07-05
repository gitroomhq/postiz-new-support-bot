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
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { backRow, btn, buttonRow, selectRow, textInput } from "../ui";
import { FINGERPRINT_RE, type RenderInteraction, type RouteEntry } from "../types";
import type { HubContext } from "./HubContext";
import { renderListPage } from "./ChargesHub";

// Cards hub: card lookups (per user, by fingerprint, by last 4) and saved
// payment-method management (set default / detach).
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
            placeholder: "visa / mastercard / amex — narrows results",
          })
        )
      );
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
    if (!/^\d{4}$/.test(last4)) {
      await interaction.reply({ embeds: [makeEmbed("Enter exactly the 4 digits.", COLORS.danger)], flags: 64 });
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
      const { charges, nextPage } = await this.ctx.stripe.searchChargesByCardLast4(last4, brand || undefined, 100);
      if (charges.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No charges found for cards ending \`${last4}\`${brand ? ` (${brand})` : ""}.`, COLORS.neutral)],
          components: [backRow("billadmin_hub:cards")],
        });
        return;
      }

      // last4 is not unique, so group by fingerprint — that's the id the other
      // card tools take for exact matching.
      type Group = { label: string; exp: string; fp: string | null; count: number; customers: Map<string, string | null> };
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
          customers: new Map(),
        };
        group.count++;
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
        return (
          `**${g.label}** · exp ${g.exp} · ${g.count} charge(s)\n` +
          `fingerprint: ${g.fp ? `\`${g.fp}\`` : "—"}\ncustomers: ${customers || "—"}${more}`
        );
      });

      const embed = new EmbedBuilder()
        .setTitle(`Cards ending •••• ${last4}${brand ? ` (${brand})` : ""}`)
        .setColor(COLORS.brand)
        .setDescription(lines.join("\n\n").slice(0, 4096))
        .setFooter({
          text:
            `From the ${charges.length} most recent matching charges${nextPage ? " — more exist" : ""} · ` +
            "last4 is not unique — use the fingerprint tools for exact matches · Search data can lag ~1 min",
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
          `${nextPage ? " — more exist" : ""} · Search data can lag ~1 min`,
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
        country: card.country ?? "—",
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
          funding: card.funding ?? "—",
          country: card.country ?? "—",
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
      .setTitle(`Cards — \`${customerId}\``)
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
