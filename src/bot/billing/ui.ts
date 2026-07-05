import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type Stripe from "stripe";
import type { BotConfig } from "../../config";
import { StripeClient } from "../StripeClient";
import { embed as makeEmbed, COLORS } from "../../util/embeds";
import { TARGET_ACTIONS, type BillAdminSession, type Panel, type TargetAction } from "./types";

// Pure UI helpers shared by the billing admin facade and its hubs. Everything
// here is stateless — formatting, row/button builders and the two navigation
// panels (root + hub) that predate the hub split.

export function btn(customId: string, label: string, style: ButtonStyle, disabled = false): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
}

export function buttonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons);
}

export function selectRow(
  select: StringSelectMenuBuilder | UserSelectMenuBuilder
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

export function backRow(target = "billadmin_root"): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return buttonRow(btn(target, "◀ Back", ButtonStyle.Secondary));
}

// Back target for a terminal-action RESULT panel (refund done, sub cancelled,
// invoice voided…). Walks the nav stack back to the panel the action was
// launched from, so the admin stays in the customer/detail context instead of
// being dumped at the hub top menu. Setting originHub guarantees the empty-stack
// fallback lands on the flow's hub (not the root panel) for actions entered
// straight from a hub modal. Pass the hub area this flow belongs to as fallback.
export function afterActionBack(session: BillAdminSession, token: string, hubFallback: string): string {
  session.originHub ??= hubFallback;
  return `billadmin_nav_back:${token}`;
}

export function promoBackRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return buttonRow(btn("billadmin_open:promo", "◀ Back", ButtonStyle.Secondary));
}

export function textInput(
  customId: string,
  label: string,
  opts: { required: boolean; placeholder?: string; value?: string; style?: TextInputStyle; maxLength?: number }
): TextInputBuilder {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label.slice(0, 45))
    .setStyle(opts.style ?? TextInputStyle.Short)
    .setRequired(opts.required);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder.slice(0, 100));
  if (opts.value) input.setValue(opts.value.slice(0, opts.maxLength ?? 4000));
  if (opts.maxLength) input.setMaxLength(opts.maxLength);
  return input;
}

export function stripeErrorEmbed(error: unknown): EmbedBuilder {
  const msg = error instanceof Error ? error.message : String(error);
  return makeEmbed(`Stripe error: ${msg.slice(0, 500)}`, COLORS.danger);
}

export function isTargetAction(action: string): action is TargetAction {
  return (TARGET_ACTIONS as readonly string[]).includes(action);
}

// promotion.coupon is expanded by StripeClient, but the API type still allows a
// bare id string — normalize both shapes.
export function promoCoupon(promo: Stripe.PromotionCode): Stripe.Coupon | null {
  const coupon = promo.promotion?.coupon;
  return coupon && typeof coupon !== "string" ? coupon : null;
}

export function promoCouponId(promo: Stripe.PromotionCode): string {
  const coupon = promo.promotion?.coupon;
  return typeof coupon === "string" ? coupon : coupon?.id ?? "—";
}

export function couponDesc(stripe: StripeClient, coupon: Stripe.Coupon): string {
  return coupon.percent_off != null
    ? `${coupon.percent_off}% off`
    : coupon.amount_off != null
      ? `${stripe.formatAmount(coupon.amount_off, coupon.currency ?? "usd")} off`
      : "—";
}

// Everything that would make Stripe reject the code at create time — checked
// up front so the admin sees why instead of a generic API error.
export function promoProblem(promo: Stripe.PromotionCode, customerId?: string): string | null {
  const now = Math.floor(Date.now() / 1000);
  if (!promo.active) return `\`${promo.code}\` is deactivated.`;
  if (promo.expires_at && promo.expires_at < now) return `\`${promo.code}\` has expired.`;
  if (promo.max_redemptions != null && promo.times_redeemed >= promo.max_redemptions) {
    return `\`${promo.code}\` has reached its redemption limit.`;
  }
  const coupon = promoCoupon(promo);
  if (coupon && !coupon.valid) return `The coupon behind \`${promo.code}\` is no longer valid.`;
  const restrictedTo = typeof promo.customer === "string" ? promo.customer : promo.customer?.id;
  if (restrictedTo && restrictedTo !== customerId) {
    return `\`${promo.code}\` is restricted to a different customer (\`${restrictedTo}\`).`;
  }
  return null;
}

export function priceLabel(stripe: StripeClient, price: Stripe.Price): string {
  const product =
    price.product && typeof price.product !== "string" && !("deleted" in price.product && price.product.deleted)
      ? (price.product as Stripe.Product)
      : null;
  const name = product?.name ?? price.nickname ?? price.id;
  const amount = price.unit_amount != null ? stripe.formatAmount(price.unit_amount, price.currency) : "custom";
  const interval = price.recurring
    ? `/${price.recurring.interval_count > 1 ? `${price.recurring.interval_count} ` : ""}${price.recurring.interval}`
    : "";
  return `${name} — ${amount}${interval}`;
}

export function subPlanLabel(stripe: StripeClient, sub: Stripe.Subscription, priceMap?: Map<string, string>): string {
  const item = sub.items.data[0];
  if (!item) return "no plan";
  return priceMap?.get(item.price.id) ?? priceLabel(stripe, item.price);
}

export function describeDiscounts(stripe: StripeClient, sub: Stripe.Subscription): string[] {
  return (sub.discounts ?? []).map((d) => {
    if (typeof d === "string") return `\`${d}\``;
    const coupon = d.source?.coupon;
    const couponObj = coupon && typeof coupon !== "string" ? coupon : null;
    const couponId = typeof coupon === "string" ? coupon : couponObj?.id;
    const off = couponObj ? couponDesc(stripe, couponObj) : "";
    return `\`${couponId ?? d.id}\`${couponObj?.name ? ` (${couponObj.name})` : ""}${off && off !== "—" ? ` · ${off}` : ""}`;
  });
}

export function chargeLine(stripe: StripeClient, charge: Stripe.Charge, showCustomer: boolean): string {
  const parts = [
    `\`${charge.id}\``,
    `<t:${charge.created}:R>`,
    `**${stripe.formatAmount(charge.amount, charge.currency)}**`,
    charge.status,
  ];
  if (charge.amount_refunded > 0) {
    parts.push(
      charge.refunded ? "↩️ refunded" : `↩️ ${stripe.formatAmount(charge.amount_refunded, charge.currency)} refunded`
    );
  }
  if (charge.disputed) parts.push("🚩 disputed");
  const risk = charge.outcome?.risk_level;
  if (risk && risk !== "normal") parts.push(`⚠️ risk: ${risk}`);
  if (showCustomer && charge.customer) {
    parts.push(`\`${typeof charge.customer === "string" ? charge.customer : charge.customer.id}\``);
  }
  return parts.join(" · ");
}

export function invoiceLine(stripe: StripeClient, invoice: Stripe.Invoice): string {
  const total = stripe.formatAmount(invoice.total, invoice.currency);
  const link = invoice.hosted_invoice_url ? ` · [open](${invoice.hosted_invoice_url})` : "";
  return `\`${invoice.number ?? invoice.id ?? "draft"}\` · ${invoice.status ?? "—"} · **${total}** · <t:${invoice.created}:D>${link}`;
}

export function formatAddress(address: Stripe.Address | null | undefined): string {
  if (!address) return "—";
  const parts = [
    address.line1,
    address.line2,
    [address.postal_code, address.city].filter(Boolean).join(" "),
    address.state,
    address.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "—";
}

// Which hub a detail flow's Back button returns to.
export function hubFor(action: TargetAction | "link"): string {
  switch (action) {
    case "cards":
      return "billadmin_hub:cards";
    case "charges":
    case "invoices":
    case "fraud":
      return "billadmin_hub:charges";
    case "discount":
    case "changeplan":
    case "createsub":
      return "billadmin_hub:subs";
    default:
      return "billadmin_hub:customers"; // overview, editcust, delcust, link
  }
}

// Prefer the hub the flow actually came from over the action's default hub.
export function hubBack(action: TargetAction | "link", origin?: string): string {
  return origin && ["cards", "customers", "charges", "subs"].includes(origin)
    ? `billadmin_hub:${origin}`
    : hubFor(action);
}

// ---- panels ----

export function buildRootPanel(config: BotConfig): Panel {
  const testMode = config.stripe.secretKey?.includes("_test_");
  const embed = new EmbedBuilder()
    .setTitle("Billing Admin")
    .setColor(COLORS.brand)
    .setDescription(
      [
        "💳 **Cards** — lookups by user, fingerprint or last 4 · set default · detach",
        "👤 **Customers** — overview, email lookup, create, edit (VAT/address), link, delete",
        "💰 **Charges** — charge & invoice history, disputes & fraud, refunds",
        "🔄 **Subscriptions** — view, create, change plan, apply discount, cancel",
        "🎟️ **Promos** — promo codes & coupons",
        "🧾 **Invoices** — invoice list & detail, one-off invoices, credit notes",
        "💸 **Payments** — payment methods, account credits/debits, balance history, manual charges",
      ].join("\n")
    )
    .setFooter({
      text: `Ephemeral · Stripe ${testMode ? "TEST" : "LIVE"} mode · Sessions expire after 15 minutes`,
    });

  return {
    embeds: [embed],
    components: [
      buttonRow(
        btn("billadmin_hub:cards", "💳 Cards", ButtonStyle.Primary),
        btn("billadmin_hub:customers", "👤 Customers", ButtonStyle.Primary),
        btn("billadmin_hub:charges", "💰 Charges", ButtonStyle.Primary),
        btn("billadmin_hub:subs", "🔄 Subscriptions", ButtonStyle.Primary),
        btn("billadmin_open:promo", "🎟️ Promos", ButtonStyle.Primary)
      ),
      buttonRow(
        btn("billadmin_hub:invoices", "🧾 Invoices", ButtonStyle.Primary),
        btn("billadmin_hub:pay", "💸 Payments", ButtonStyle.Primary)
      ),
    ],
  };
}

// Second navigation level: one hub per top-level area, grouping its actions
// by CRUD verb. The concrete flows (target pickers, modals, results) hang off
// the same billadmin_open:/billadmin_manual: ids as before.
export function buildHubPanel(area: string, config: BotConfig): Panel {
  if (area === "cards") {
    const embed = new EmbedBuilder()
      .setTitle("💳 Cards")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "**Read** — a user's cards, or hunt cards account-wide by fingerprint / last 4.",
          "**Find** — locate a customer or a **declined / bank-blocked** payment by amount or name when card and",
          "last-4 lookups come up empty (a refused payment never becomes a charge, so it won't show in the searches above).",
          "**Update / Delete** — open *User's Cards* and pick a saved card to set it as default or detach it.",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_open:cards", "User's Cards", ButtonStyle.Primary),
          btn("billadmin_open:usersbycard", "Users by Card", ButtonStyle.Primary),
          btn("billadmin_open:chargesbycard", "Charges by Card", ButtonStyle.Primary),
          btn("billadmin_open:cardsbylast4", "Cards by Last 4", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("billadmin_open:findamount", "🔎 Find by Amount", ButtonStyle.Secondary),
          btn("billadmin_open:findname", "🔎 Find by Name / Email", ButtonStyle.Secondary)
        ),
        backRow(),
      ],
    };
  }
  if (area === "customers") {
    const embed = new EmbedBuilder()
      .setTitle("👤 Customers")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "**Read** — full overview: pick a Discord user, or enter a cus_ ID / **email** / Postiz ID manually.",
          "**Create** — a bare Stripe customer.",
          "**Update** — details, address, VAT/tax IDs · link/unlink the Discord ↔ Stripe mapping.",
          "**Delete** — permanently remove a customer (cancels their subscriptions).",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(btn("billadmin_open:overview", "Overview", ButtonStyle.Primary)),
        buttonRow(
          btn("billadmin_open:createcust", "Create", ButtonStyle.Success),
          btn("billadmin_open:editcust", "Edit", ButtonStyle.Primary),
          btn("billadmin_open:link", "Link / Unlink", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn("billadmin_open:delcust", "Delete Customer", ButtonStyle.Danger),
          btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }
  if (area === "charges") {
    const embed = new EmbedBuilder()
      .setTitle("💰 Charges")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "**Read** — a user's charge and invoice history, plus disputes & fraud signals.",
          "**Refund** — full or partial refund of a charge, optionally cancelling the subscription.",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_open:charges", "Charges for User", ButtonStyle.Primary),
          btn("billadmin_open:invoices", "Invoices", ButtonStyle.Primary),
          btn("billadmin_open:fraud", "Disputes & Fraud", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("billadmin_open:refund", "Refund a Charge", ButtonStyle.Danger),
          btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }
  if (area === "subs") {
    const embed = new EmbedBuilder()
      .setTitle("🔄 Subscriptions")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "**Read** — subscriptions (with their plans) are listed under 👤 Customers → *Overview*.",
          "**Create** — start a new subscription: plan, optional coupon & trial, charge now or email an invoice.",
          "**Update** — change plan (keep / remove / swap the discount along the way) · apply the configured discount coupon.",
          "**Delete** — cancel now, or at the end of the current period.",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_open:createsub", "Create Subscription", ButtonStyle.Success),
          btn("billadmin_sub_manage_entry", "🛠 Manage Subscription", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("billadmin_open:changeplan", "Change Plan", ButtonStyle.Primary),
          btn("billadmin_open:discount", "Apply Discount", ButtonStyle.Primary)
        ),
        buttonRow(
          btn("billadmin_open:cancelsub", "Cancel Subscription", ButtonStyle.Danger),
          btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }
  return buildRootPanel(config);
}
