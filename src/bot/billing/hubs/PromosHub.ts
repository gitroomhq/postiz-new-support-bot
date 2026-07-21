import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  StringSelectMenuBuilder,
  type ModalSubmitInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { StripeClient } from "../../StripeClient";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { btn, buttonRow, couponDesc, promoBackRow, promoCoupon, promoCouponId, selectRow, textInput } from "../ui";
import type { Panel, RouteEntry, SessionRenderInteraction } from "../types";
import type { HubContext } from "./HubContext";

// Promos hub: promotion codes (check / create / list / toggle) and the raw
// coupons behind them (list / create / delete).
export class PromosHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_promo_check",
      match: "exact",
      handler: async (interaction) => {
        await interaction.showModal(this.buildPromoCheckModal());
      },
    },
    {
      kind: "button",
      id: "billadmin_promo_create",
      match: "exact",
      handler: async (interaction) => {
        await interaction.showModal(this.buildPromoCreateModal());
      },
    },
    {
      kind: "button",
      id: "billadmin_promo_list",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderPromoList(interaction));
      },
    },
    {
      kind: "button",
      id: "billadmin_coupon_list",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderCouponList(interaction));
      },
    },
    {
      kind: "button",
      id: "billadmin_coupon_create",
      match: "exact",
      handler: async (interaction) => {
        await interaction.showModal(this.buildCouponCreateModal());
      },
    },
    {
      kind: "button",
      id: "billadmin_coupon_delete_exec:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.couponId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.deleteCoupon(session.couponId!);
          this.ctx.audit.log(interaction, {
            action: "Delete coupon",
            objectId: session.couponId,
            outcome: "Success",
            severity: "warn",
          });
          await this.renderCouponList(interaction, `🗑️ Coupon \`${session.couponId}\` deleted.`);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_promo_toggle:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, dir] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.promoCodeId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const promo = await this.ctx.stripe.setPromotionCodeActive(session.promoCodeId!, dir === "on");
          this.ctx.audit.log(interaction, {
            action: dir === "on" ? "Activate promo code" : "Deactivate promo code",
            objectId: promo.id,
            outcome: `Success: \`${promo.code}\` is now ${promo.active ? "active" : "inactive"}`,
            severity: dir === "on" ? "success" : "warn",
          });
          await interaction.editReply(this.buildPromoDetailPanel(promo, token));
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_promopick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const promo = await this.ctx.stripe.getPromotionCode(value);
          session.promoCodeId = promo.id;
          await interaction.editReply(this.buildPromoDetailPanel(promo, token));
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_couponpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.couponId = value;
        await this.ctx.sessions.tryRender(interaction, async () => {
          const embed = new EmbedBuilder()
            .setTitle("Delete coupon")
            .setColor(COLORS.danger)
            .setDescription(
              `⚠️ Delete coupon \`${value}\`? New promo codes can't use it anymore. ` +
                "Customers who already have it applied keep their discount."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_coupon_delete_exec:${token}`, "Delete coupon", ButtonStyle.Danger),
                btn("billadmin_coupon_list", "Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_promo_check_modal",
      match: "exact",
      handler: (interaction) => this.handlePromoCheckModal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_promo_create_modal",
      match: "exact",
      handler: (interaction) => this.handlePromoCreateModal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_coupon_create_modal",
      match: "exact",
      handler: (interaction) => this.handleCouponCreateModal(interaction),
    },
  ];

  buildPromoHubPanel(): Panel {
    const embed = new EmbedBuilder()
      .setTitle("Promotion codes & coupons")
      .setColor(COLORS.brand)
      .setDescription(
        "Check whether a promo code is valid, create new codes, deactivate/reactivate them, " +
          "and manage the coupons they apply.\n\n" +
          "ℹ️ Stripe promotion codes can't be **edited or deleted**, only deactivated. To change one, " +
          "deactivate it and create a replacement. Coupons *can* be deleted."
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_promo_check", "Check a code", ButtonStyle.Primary),
          btn("billadmin_promo_create", "Create a code", ButtonStyle.Primary),
          btn("billadmin_promo_list", "List codes", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("billadmin_coupon_list", "Coupons", ButtonStyle.Primary),
          btn("billadmin_coupon_create", "Create coupon", ButtonStyle.Primary),
          btn("billadmin_root", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async renderPromoList(interaction: SessionRenderInteraction): Promise<void> {
    const promos = await this.ctx.stripe.listPromotionCodes(25);
    if (promos.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed("No promotion codes exist yet.", COLORS.neutral)],
        components: [promoBackRow()],
      });
      return;
    }

    const lines = promos.map(
      (p) =>
        `**${p.code}** · ${p.active ? "active" : "inactive"} · coupon \`${promoCouponId(p)}\` · ` +
        `${p.times_redeemed}/${p.max_redemptions ?? "∞"} used${p.expires_at ? ` · expires <t:${p.expires_at}:R>` : ""}`
    );
    const token = this.ctx.sessions.newSession(interaction, {});
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_promopick:${token}`)
      .setPlaceholder("Pick a code to inspect / toggle")
      .addOptions(
        promos.slice(0, 25).map((p) => ({
          label: p.code.slice(0, 100),
          description: `${p.active ? "active" : "inactive"} · coupon ${promoCouponId(p)}`.slice(0, 100),
          value: p.id,
        }))
      );

    const embed = new EmbedBuilder()
      .setTitle("Promotion codes")
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096))
      .setFooter({ text: `${promos.length} most recent codes` });
    await interaction.editReply({ embeds: [embed], components: [selectRow(select), promoBackRow()] });
  }

  private async renderCouponList(interaction: SessionRenderInteraction, notice?: string): Promise<void> {
    const coupons = await this.ctx.stripe.listCoupons(25);
    if (coupons.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed([notice, "No coupons exist yet."].filter(Boolean).join("\n"), COLORS.neutral)],
        components: [promoBackRow()],
      });
      return;
    }

    const describe = (c: Stripe.Coupon) =>
      c.percent_off != null
        ? `${c.percent_off}% off`
        : c.amount_off != null
          ? `${this.ctx.stripe.formatAmount(c.amount_off, c.currency ?? "usd")} off`
          : "N/A";
    const lines = coupons.map(
      (c) =>
        `\`${c.id}\`${c.name ? ` (${c.name})` : ""} · ${describe(c)} · ${c.duration}` +
        `${c.duration_in_months ? ` (${c.duration_in_months}m)` : ""} · ${c.times_redeemed} redeemed · ` +
        `${c.valid ? "valid" : "invalid"}`
    );
    const token = this.ctx.sessions.newSession(interaction, {});
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_couponpick:${token}`)
      .setPlaceholder("Pick a coupon to delete")
      .addOptions(
        coupons.slice(0, 25).map((c) => ({
          label: `${c.id}${c.name ? ` (${c.name})` : ""}`.slice(0, 100),
          description: describe(c).slice(0, 100),
          value: c.id,
        }))
      );

    const embed = new EmbedBuilder()
      .setTitle("Coupons")
      .setColor(COLORS.brand)
      .setDescription([notice, lines.join("\n")].filter(Boolean).join("\n").slice(0, 4096))
      .setFooter({ text: `${coupons.length} most recent coupons` });
    await interaction.editReply({ embeds: [embed], components: [selectRow(select), promoBackRow()] });
  }

  private async handleCouponCreateModal(interaction: ModalSubmitInteraction): Promise<void> {
    const couponId = interaction.fields.getTextInputValue("id").trim();
    const name = interaction.fields.getTextInputValue("name").trim();
    const percentRaw = interaction.fields.getTextInputValue("percent_off").trim();
    const amountRaw = interaction.fields.getTextInputValue("amount_off").trim();
    const durationRaw = interaction.fields.getTextInputValue("duration").trim().toLowerCase() || "once";

    if ((percentRaw === "") === (amountRaw === "")) {
      await interaction.reply({
        embeds: [makeEmbed("Fill exactly one of **percent off** or **amount off**.", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    const percentOff = percentRaw ? Number.parseFloat(percentRaw) : undefined;
    if (percentRaw && (!/^\d+(\.\d+)?$/.test(percentRaw) || percentOff! <= 0 || percentOff! > 100)) {
      await interaction.reply({
        embeds: [makeEmbed("Percent off must be a number between 0 and 100.", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    const amountMatch = amountRaw ? amountRaw.match(/^(\d+(?:\.\d{1,2})?)\s+([a-zA-Z]{3})$/) : null;
    if (amountRaw && !amountMatch) {
      await interaction.reply({
        embeds: [makeEmbed("Amount off must look like `12.50 eur` (amount + currency).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    const durationMatch = durationRaw.match(/^(once|forever|repeating)(?::(\d+))?$/);
    if (!durationMatch || (durationMatch[1] === "repeating" && !durationMatch[2])) {
      await interaction.reply({
        embeds: [makeEmbed("Duration must be `once`, `forever`, or `repeating:N` (N months).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    let amountOffMinor: number | undefined;
    let currency: string | undefined;
    if (amountMatch) {
      currency = amountMatch[2].toLowerCase();
      const value = Number.parseFloat(amountMatch[1]);
      if (StripeClient.isZeroDecimal(currency) && amountMatch[1].includes(".")) {
        await interaction.reply({
          embeds: [makeEmbed(`\`${currency}\` is a zero-decimal currency: whole amounts only.`, COLORS.danger)],
          flags: 64,
        });
        return;
      }
      amountOffMinor = StripeClient.isZeroDecimal(currency) ? Math.round(value) : Math.round(value * 100);
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const coupon = await this.ctx.stripe.createCoupon(
        {
          id: couponId || undefined,
          name: name || undefined,
          percentOff,
          amountOffMinor,
          currency,
          duration: durationMatch[1] as "once" | "forever" | "repeating",
          durationInMonths: durationMatch[2] ? Number.parseInt(durationMatch[2], 10) : undefined,
        },
        `billadmin-coupon-${interaction.id}`
      );
      this.ctx.audit.log(interaction, {
        action: "Create coupon",
        objectId: coupon.id,
        outcome: `Success: ${couponDesc(this.ctx.stripe, coupon)} · ${coupon.duration}${coupon.duration_in_months ? ` (${coupon.duration_in_months}m)` : ""}`,
        severity: "success",
      });
      await this.renderCouponList(interaction, `✅ Coupon \`${coupon.id}\` created.`);
    });
  }

  private async handlePromoCheckModal(interaction: ModalSubmitInteraction): Promise<void> {
    const query = interaction.fields.getTextInputValue("code").trim();
    if (!query) {
      await interaction.reply({ embeds: [makeEmbed("Enter a promo code or `promo_…` ID.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const promos = query.startsWith("promo_")
        ? [await this.ctx.stripe.getPromotionCode(query)]
        : await this.ctx.stripe.findPromotionCodes(query);

      if (promos.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No promotion code matching \`${query}\`.`, COLORS.warn)],
          components: [promoBackRow()],
        });
        return;
      }
      if (promos.length === 1) {
        const token = this.ctx.sessions.newSession(interaction, { promoCodeId: promos[0].id });
        await interaction.editReply(this.buildPromoDetailPanel(promos[0], token));
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, {});
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_promopick:${token}`)
        .setPlaceholder("Several promo codes matched. Pick one")
        .addOptions(
          promos.slice(0, 25).map((p) => ({
            label: p.code.slice(0, 100),
            description: `${p.active ? "active" : "inactive"} · coupon ${promoCouponId(p)}`.slice(0, 100),
            value: p.id,
          }))
        );
      await interaction.editReply({
        embeds: [makeEmbed(`${promos.length} promo codes matched \`${query}\`.`, COLORS.brand)],
        components: [selectRow(select), promoBackRow()],
      });
    });
  }

  private async handlePromoCreateModal(interaction: ModalSubmitInteraction): Promise<void> {
    const coupon = interaction.fields.getTextInputValue("coupon").trim();
    const code = interaction.fields.getTextInputValue("code").trim();
    const maxRedemptionsRaw = interaction.fields.getTextInputValue("max_redemptions").trim();
    const expiresDaysRaw = interaction.fields.getTextInputValue("expires_in_days").trim();

    if (!coupon) {
      await interaction.reply({ embeds: [makeEmbed("A coupon ID is required.", COLORS.danger)], flags: 64 });
      return;
    }
    if ((maxRedemptionsRaw && !/^\d+$/.test(maxRedemptionsRaw)) || (expiresDaysRaw && !/^\d+$/.test(expiresDaysRaw))) {
      await interaction.reply({
        embeds: [makeEmbed("Max redemptions and expiry days must be whole numbers.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const promo = await this.ctx.stripe.createPromotionCode(
        {
          coupon,
          code: code || undefined,
          maxRedemptions: maxRedemptionsRaw ? Number.parseInt(maxRedemptionsRaw, 10) : undefined,
          expiresAt: expiresDaysRaw
            ? Math.floor(Date.now() / 1000) + Number.parseInt(expiresDaysRaw, 10) * 86400
            : undefined,
        },
        `billadmin-promo-${interaction.id}`
      );
      this.ctx.audit.log(interaction, {
        action: "Create promo code",
        objectId: promo.id,
        outcome: `Success: \`${promo.code}\` on coupon \`${coupon}\``,
        severity: "success",
      });
      const token = this.ctx.sessions.newSession(interaction, { promoCodeId: promo.id });
      await interaction.editReply(this.buildPromoDetailPanel(promo, token, "✅ Promotion code created."));
    });
  }

  private buildPromoDetailPanel(promo: Stripe.PromotionCode, token: string, notice?: string): Panel {
    const coupon = promoCoupon(promo);
    const now = Math.floor(Date.now() / 1000);
    const reasons: string[] = [];
    if (!promo.active) reasons.push("code is deactivated");
    if (promo.expires_at && promo.expires_at < now) reasons.push("code expired");
    if (promo.max_redemptions != null && promo.times_redeemed >= promo.max_redemptions) {
      reasons.push("max redemptions reached");
    }
    if (coupon && !coupon.valid) reasons.push("underlying coupon is invalid");
    const valid = reasons.length === 0;

    const discount =
      coupon?.percent_off != null
        ? `${coupon.percent_off}% off`
        : coupon?.amount_off != null
          ? `${this.ctx.stripe.formatAmount(coupon.amount_off, coupon.currency ?? "usd")} off`
          : "N/A";
    const restrictions = [
      promo.restrictions.first_time_transaction ? "first purchase only" : null,
      promo.restrictions.minimum_amount != null
        ? `min ${this.ctx.stripe.formatAmount(promo.restrictions.minimum_amount, promo.restrictions.minimum_amount_currency ?? "usd")}`
        : null,
      promo.customer ? `customer-specific (\`${typeof promo.customer === "string" ? promo.customer : promo.customer.id}\`)` : null,
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle(`Promo code · ${promo.code}`)
      .setColor(valid ? COLORS.success : COLORS.warn)
      .addFields(
        { name: "Valid now", value: valid ? "✅ yes" : `❌ no: ${reasons.join(", ")}`, inline: false },
        { name: "ID", value: `\`${promo.id}\``, inline: true },
        { name: "Active flag", value: promo.active ? "active" : "deactivated", inline: true },
        { name: "Expires", value: promo.expires_at ? `<t:${promo.expires_at}:f>` : "never", inline: true },
        {
          name: "Coupon",
          value: coupon
            ? `\`${coupon.id}\`${coupon.name ? ` (${coupon.name})` : ""} · ${discount} · ${coupon.duration}${coupon.duration_in_months ? ` (${coupon.duration_in_months} months)` : ""} · ${coupon.valid ? "valid" : "invalid"}`
            : `\`${promoCouponId(promo)}\``,
          inline: false,
        },
        {
          name: "Redemptions",
          value: `${promo.times_redeemed} / ${promo.max_redemptions ?? "∞"}`,
          inline: true,
        },
        { name: "Restrictions", value: restrictions.join(" · ") || "none", inline: true }
      );
    if (notice) embed.setDescription(notice);

    return {
      embeds: [embed],
      components: [
        buttonRow(
          promo.active
            ? btn(`billadmin_promo_toggle:${token}:off`, "Deactivate", ButtonStyle.Danger)
            : btn(`billadmin_promo_toggle:${token}:on`, "Reactivate", ButtonStyle.Success),
          btn("billadmin_open:promo", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private buildPromoCheckModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_promo_check_modal")
      .setTitle("Check a promotion code")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("code", "Code or promo_… ID", { required: true, placeholder: "e.g. WELCOME50" })
        )
      );
  }

  private buildPromoCreateModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_promo_create_modal")
      .setTitle("Create a promotion code")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("coupon", "Coupon ID the code applies", {
            required: true,
            value: this.ctx.config.stripe.discountCouponId ?? "",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("code", "Code (empty = auto-generate)", { required: false, placeholder: "e.g. WELCOME50" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("max_redemptions", "Max redemptions (empty = unlimited)", {
            required: false,
            placeholder: "e.g. 100",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("expires_in_days", "Expires in days (empty = never)", {
            required: false,
            placeholder: "e.g. 30",
          })
        )
      );
  }

  private buildCouponCreateModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_coupon_create_modal")
      .setTitle("Create a coupon")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("id", "Coupon ID (empty = auto-generate)", { required: false, placeholder: "e.g. SUMMER25" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("name", "Display name", { required: false, placeholder: "shown on invoices" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("percent_off", "Percent off (fill this OR amount)", { required: false, placeholder: "e.g. 25" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount_off", "Amount off + currency", { required: false, placeholder: "e.g. 12.50 eur" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("duration", "Duration: once / forever / repeating:N", {
            required: false,
            placeholder: "default: once · repeating:3 = 3 months",
          })
        )
      );
  }
}
