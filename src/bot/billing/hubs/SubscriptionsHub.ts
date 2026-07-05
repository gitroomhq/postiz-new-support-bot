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
import {
  backRow,
  btn,
  buttonRow,
  couponDesc,
  describeDiscounts,
  priceLabel,
  promoCoupon,
  promoProblem,
  selectRow,
  subPlanLabel,
  textInput,
} from "../ui";
import type { BillAdminSession, Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// Plain-language descriptions of Stripe's three pause_collection behaviors.
const PAUSE_BEHAVIORS = {
  keep_as_draft: "invoices are still created but left as drafts",
  mark_uncollectible: "invoices are created and marked uncollectible",
  void: "invoices are created then voided",
} as const;
type PauseBehavior = keyof typeof PAUSE_BEHAVIORS;

function isPauseBehavior(value: string): value is PauseBehavior {
  return value in PAUSE_BEHAVIORS;
}

// Deep-subscription-ops state that doesn't fit BillAdminSession (types.ts is
// shared). Keyed on the session object itself, so entries die with the session.
interface SubOpsExtra {
  prorationDate?: number;
  trialEndTs?: number;
  quantity?: number;
  schedPriceId?: string;
  schedPriceLabel?: string;
  scheduleId?: string;
  periodEnd?: number;
}
const subExtra = new WeakMap<BillAdminSession, SubOpsExtra>();
function extraFor(session: BillAdminSession): SubOpsExtra {
  let extra = subExtra.get(session);
  if (!extra) {
    extra = {};
    subExtra.set(session, extra);
  }
  return extra;
}

// Subscriptions hub: create, change plan (with discount handling), apply the
// configured discount coupon, cancel, the plan allowlist settings, and the
// per-subscription management panel (pause, trial, quantity, schedules).
export class SubscriptionsHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_cancelsub_exec:",
      match: "prefix",
      handler: async (interaction) => {
        const session = await this.ctx.sessions.getOwnedSession(interaction.customId.split(":")[1], interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.cancelSubscription(session.subscriptionId!);
          this.ctx.audit.log(interaction, {
            action: "Cancel subscription (now)",
            objectId: session.subscriptionId,
            outcome: `Cancelled immediately${session.planFrom ? ` — ${session.planFrom}` : ""}`,
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `🔚 Subscription \`${session.subscriptionId}\`${session.planFrom ? ` (**${session.planFrom}**)` : ""} cancelled.`,
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:subs")],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_cancelsub_softexec:",
      match: "prefix",
      handler: async (interaction) => {
        const session = await this.ctx.sessions.getOwnedSession(interaction.customId.split(":")[1], interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.cancelSubscriptionAtPeriodEnd(session.subscriptionId!);
          this.ctx.audit.log(interaction, {
            action: "Cancel subscription (at period end)",
            objectId: session.subscriptionId,
            outcome: `Scheduled to cancel at period end${session.planFrom ? ` — ${session.planFrom}` : ""}`,
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `⏳ Subscription \`${session.subscriptionId}\`${session.planFrom ? ` (**${session.planFrom}**)` : ""} will cancel at the end of the current period.`,
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:subs")],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_discount_exec:",
      match: "prefix",
      handler: async (interaction) => {
        const session = await this.ctx.sessions.getOwnedSession(interaction.customId.split(":")[1], interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.applyDiscountCoupon(session.subscriptionId!, `billadmin-discount-${interaction.id}`);
          this.ctx.audit.log(interaction, {
            action: "Apply discount coupon",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `Coupon \`${this.ctx.config.stripe.discountCouponId}\` applied`,
            severity: "info",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `💸 Coupon \`${this.ctx.config.stripe.discountCouponId}\` applied to \`${session.subscriptionId}\`.`,
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:subs")],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_dchoice:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, choice] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        if (choice === "change") {
          await interaction.deferUpdate();
          await this.ctx.sessions.tryRender(interaction, async () => {
            const coupons = await this.ctx.stripe.listCoupons(25);
            if (coupons.length === 0) {
              await interaction.editReply({
                embeds: [
                  makeEmbed(
                    "No coupons exist — create one under 🎟️ Promos first, or continue without changing the discount.",
                    COLORS.warn
                  ),
                ],
                components: [
                  buttonRow(
                    btn(`billadmin_dchoice:${token}:keep`, "Keep as-is", ButtonStyle.Primary),
                    btn(`billadmin_dchoice:${token}:remove`, "Remove discount", ButtonStyle.Danger),
                    btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
                  ),
                ],
              });
              return;
            }
            const select = new StringSelectMenuBuilder()
              .setCustomId(`billadmin_dcouponpick:${token}`)
              .setPlaceholder("Pick the coupon for the new plan")
              .addOptions(
                coupons.slice(0, 25).map((c) => ({
                  label: `${c.id}${c.name ? ` (${c.name})` : ""}`.slice(0, 100),
                  description: couponDesc(this.ctx.stripe, c).slice(0, 100),
                  value: c.id,
                }))
              );
            await interaction.editReply({
              embeds: [makeEmbed("Pick the coupon to apply to the new plan:", COLORS.brand)],
              components: [selectRow(select), backRow("billadmin_hub:subs")],
            });
          });
          return;
        }
        session.discountChoice = choice === "remove" ? "remove" : "keep";
        if (session.pendingSubAction === "createsub") {
          await interaction.update(this.buildCreateSubConfirm(token));
          return;
        }
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.showChangePlanConfirm(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_plansettings",
      match: "prefix",
      handler: async (interaction) => {
        const force = interaction.customId.endsWith(":refresh");
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const stale = force || this.ctx.priceBook.isPlanUsageStale();
          if (stale) {
            await interaction.editReply({
              embeds: [makeEmbed("⏳ Counting active subscriptions per plan — this can take a moment…", COLORS.neutral)],
              components: [],
            });
          }
          await this.renderPlanSettings(interaction, undefined, force);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_cstrial:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        await interaction.showModal(this.buildTrialModal(token));
      },
    },
    {
      kind: "button",
      id: "billadmin_cspromo:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        await interaction.showModal(this.buildPromoEntryModal(token));
      },
    },
    {
      kind: "button",
      id: "billadmin_cscreate:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, mode] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId || !session.newPriceId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const choice = session.discountChoice ?? "keep";
          const isPromo = choice.startsWith("pc:");
          const noDiscount = choice === "keep" || choice === "remove";
          const sub = await this.ctx.stripe.createSubscription(
            {
              customerId: session.customerId!,
              priceId: session.newPriceId!,
              couponId: noDiscount || isPromo ? undefined : choice,
              promotionCodeId: isPromo ? choice.slice(3) : undefined,
              trialDays: session.trialDays,
              collection: mode === "invoice" ? "invoice" : "charge",
            },
            `billadmin-createsub-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Create subscription",
            targetCustomerId: session.customerId,
            objectId: sub.id,
            outcome:
              `${session.planTo} — status ${sub.status}` +
              (mode === "invoice" ? " (invoice emailed, due in 7 days)" : "") +
              (session.trialDays ? ` — trial ${session.trialDays} days` : ""),
            severity: "success",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `✅ Created \`${sub.id}\` — **${session.planTo}**, status **${sub.status}**.` +
                  (mode === "invoice" ? "\n📧 An invoice (due in 7 days) is emailed to the customer." : ""),
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:subs")],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_planexec:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, mode] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId || !session.subItemId || !session.newPriceId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const choice = session.discountChoice ?? "keep";
          await this.ctx.stripe.changeSubscriptionPlan(
            {
              subscriptionId: session.subscriptionId!,
              itemId: session.subItemId!,
              priceId: session.newPriceId!,
              prorationBehavior: mode === "prorate" ? "create_prorations" : "none",
              discounts: choice === "remove" ? "clear" : choice === "keep" ? undefined : choice,
              // Pin prorations to the previewed timestamp so the charge matches it.
              prorationDate: mode === "prorate" ? subExtra.get(session)?.prorationDate : undefined,
            },
            `billadmin-plan-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Change subscription plan",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome:
              `${session.planFrom ?? "?"} → ${session.planTo ?? "?"} (${mode === "prorate" ? "prorated" : "no proration"}). ` +
              `Discount ${choice === "keep" ? "unchanged" : choice === "remove" ? "removed" : `set to \`${choice}\``}`,
            severity: "info",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `✅ \`${session.subscriptionId}\` changed to **${session.planTo}** ` +
                  `(${mode === "prorate" ? "prorated" : "no proration"}). Discount ${
                    choice === "keep" ? "unchanged" : choice === "remove" ? "removed" : `set to \`${choice}\``
                  }.`,
                COLORS.success
              ),
            ],
            components: [backRow("billadmin_hub:subs")],
          });
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_plansel",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.settingsStore.updateAllowedPriceIds(interaction.values);
          this.ctx.audit.log(interaction, {
            action: "Update plan allowlist",
            outcome: interaction.values.length
              ? `Allowlist set to ${interaction.values.length} plan(s): ${interaction.values.join(", ")}`
              : "Allowlist cleared — all active plans are offered",
            severity: "info",
          });
          await this.renderPlanSettings(
            interaction,
            interaction.values.length
              ? `✅ Allowlist set to ${interaction.values.length} plan(s).`
              : "✅ Allowlist cleared — all active plans are offered."
          );
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_subpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const sub = await this.ctx.stripe.getSubscription(value);
          session.subscriptionId = sub.id;
          if (session.pendingSubAction === "changeplan") {
            await this.showPlanPicker(interaction, token, sub);
          } else {
            const priceMap = await this.ctx.priceBook.labelMap();
            await interaction.editReply(this.buildDiscountConfirmPanel(sub, token, subPlanLabel(this.ctx.stripe, sub, priceMap)));
          }
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_planpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        const isCreate = session.pendingSubAction === "createsub";
        if (!isCreate && !session.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const price = await this.ctx.stripe.getPrice(value);
          session.newPriceId = price.id;
          session.planTo = priceLabel(this.ctx.stripe, price);
          if (isCreate) {
            const promos = await this.ctx.stripe.listPromotionCodes(25, true);
            await interaction.editReply(this.buildCreateSubDiscountPanel(token, promos));
          } else {
            const sub = await this.ctx.stripe.getSubscription(session.subscriptionId!);
            await interaction.editReply(this.buildDiscountChoicePanel(sub, token));
          }
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_dcouponpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        session.discountChoice = value;
        if (session.pendingSubAction === "createsub") {
          await interaction.update(this.buildCreateSubConfirm(token));
          return;
        }
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.showChangePlanConfirm(interaction, token));
      },
    },
    {
      kind: "select",
      id: "billadmin_cspromopick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const promo = await this.ctx.stripe.getPromotionCode(value);
          const problem = promoProblem(promo, session.customerId);
          if (problem) {
            await interaction.editReply({
              embeds: [makeEmbed(`❌ ${problem}`, COLORS.danger)],
              components: [backRow("billadmin_hub:subs")],
            });
            return;
          }
          session.discountChoice = `pc:${promo.id}`;
          session.discountLabel = promo.code;
          await interaction.editReply(this.buildCreateSubConfirm(token));
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_cancel_modal",
      match: "exact",
      handler: (interaction) => this.handleCancelModal(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_cspromo_modal:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        const code = interaction.fields.getTextInputValue("code").trim();
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const matches = code.startsWith("promo_")
            ? [await this.ctx.stripe.getPromotionCode(code)]
            : await this.ctx.stripe.findPromotionCodes(code);
          const promo = matches.find((p) => p.active) ?? matches[0];
          const problem = promo ? promoProblem(promo, session.customerId) : `No promotion code matching \`${code}\`.`;
          if (!promo || problem) {
            await interaction.editReply({
              embeds: [makeEmbed(`❌ ${problem}`, COLORS.danger)],
              components: [
                buttonRow(
                  btn(`billadmin_cspromo:${token}`, "Try another code", ButtonStyle.Secondary),
                  btn(`billadmin_dchoice:${token}:keep`, "No discount", ButtonStyle.Primary),
                  btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
                ),
              ],
            });
            return;
          }
          session.discountChoice = `pc:${promo.id}`;
          session.discountLabel = promo.code;
          await interaction.editReply(this.buildCreateSubConfirm(token));
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_cstrial_modal:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.newPriceId) return;
        const daysRaw = interaction.fields.getTextInputValue("days").trim();
        const days = Number.parseInt(daysRaw, 10);
        if (!/^\d{1,3}$/.test(daysRaw) || days > 730) {
          await interaction.reply({
            embeds: [makeEmbed("Trial days must be a whole number between 0 and 730.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        session.trialDays = days > 0 ? days : undefined;
        await this.ctx.sessions.ackModal(interaction);
        await interaction.editReply(this.buildCreateSubConfirm(token));
      },
    },

    // ---- subscription detail panel (manage: pause, trial, quantity, schedule) ----

    {
      kind: "button",
      id: "billadmin_sub_manage_entry",
      match: "exact",
      handler: async (interaction) => {
        await interaction.showModal(this.buildManageModal());
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_view:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderSubDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_list:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const subs = (await this.ctx.stripe.listSubscriptions(session.customerId!)).filter(
            (s) => s.status !== "canceled"
          );
          if (subs.length === 0) {
            await interaction.editReply({
              embeds: [makeEmbed(`\`${session.customerId}\` has no non-canceled subscriptions.`, COLORS.warn)],
              components: [backRow("billadmin_hub:subs")],
            });
            return;
          }
          if (subs.length === 1) {
            session.subscriptionId = subs[0].id;
            await this.renderSubDetail(interaction, token);
            return;
          }
          const priceMap = await this.ctx.priceBook.labelMap();
          await interaction.editReply(this.buildSubPickPanel(token, subs, priceMap));
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_sub_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          session.subscriptionId = value;
          await this.renderSubDetail(interaction, token);
        });
      },
    },
    {
      kind: "modal",
      id: "billadmin_sub_manage_modal",
      match: "exact",
      handler: (interaction) => this.handleManageModal(interaction),
    },
    {
      kind: "button",
      id: "billadmin_sub_chplan:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          session.pendingSubAction = "changeplan";
          const sub = await this.ctx.stripe.getSubscription(session.subscriptionId!);
          await this.showPlanPicker(interaction, token, sub);
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_discount:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          if (!this.ctx.config.stripe.discountCouponId) {
            await interaction.editReply({
              embeds: [makeEmbed("No discount coupon configured (STRIPE_DISCOUNT_COUPON_ID).", COLORS.danger)],
              components: [backRow(`billadmin_sub_view:${token}`)],
            });
            return;
          }
          const [sub, priceMap] = await Promise.all([
            this.ctx.stripe.getSubscription(session.subscriptionId!),
            this.ctx.priceBook.labelMap(),
          ]);
          await interaction.editReply(
            this.buildDiscountConfirmPanel(
              sub,
              token,
              subPlanLabel(this.ctx.stripe, sub, priceMap),
              `billadmin_sub_view:${token}`
            )
          );
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_cancel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const [sub, priceMap] = await Promise.all([
            this.ctx.stripe.getSubscription(session.subscriptionId!),
            this.ctx.priceBook.labelMap(),
          ]);
          const plan = subPlanLabel(this.ctx.stripe, sub, priceMap);
          session.planFrom = plan;
          await interaction.editReply(
            this.buildCancelConfirmPanel(sub, plan, token, `billadmin_sub_view:${token}`, false)
          );
        });
      },
    },

    // ---- pause / resume collection ----

    {
      kind: "button",
      id: "billadmin_sub_pause:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const embed = new EmbedBuilder()
          .setTitle("⏸ Pause payment collection")
          .setColor(COLORS.warn)
          .setDescription(
            `How should \`${session.subscriptionId}\` handle invoices while paused?\n\n` +
              `**Keep as draft** — ${PAUSE_BEHAVIORS.keep_as_draft}.\n` +
              `**Mark uncollectible** — ${PAUSE_BEHAVIORS.mark_uncollectible}.\n` +
              `**Void** — ${PAUSE_BEHAVIORS.void}.\n\n` +
              "⚠️ Pausing collection does **not** stop the billing cycle — invoices keep being generated " +
              "on schedule; only what happens to them changes."
          );
        await interaction.update({
          embeds: [embed],
          components: [
            buttonRow(
              btn(`billadmin_sub_pausec:${token}:keep_as_draft`, "Keep as draft", ButtonStyle.Primary),
              btn(`billadmin_sub_pausec:${token}:mark_uncollectible`, "Mark uncollectible", ButtonStyle.Secondary),
              btn(`billadmin_sub_pausec:${token}:void`, "Void", ButtonStyle.Danger)
            ),
            backRow(`billadmin_sub_view:${token}`),
          ],
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_pausec:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, behavior] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId || !isPauseBehavior(behavior)) return;
        const embed = new EmbedBuilder()
          .setTitle("Confirm pause")
          .setColor(COLORS.danger)
          .setDescription(
            `Pause collection on \`${session.subscriptionId}\` with behavior **${behavior}** — ` +
              `${PAUSE_BEHAVIORS[behavior]}.\n\n` +
              "⚠️ The billing cycle keeps running; invoices keep being generated on schedule."
          );
        await interaction.update({
          embeds: [embed],
          components: [
            buttonRow(
              btn(`billadmin_sub_pausex:${token}:${behavior}`, "Pause collection", ButtonStyle.Danger),
              btn(`billadmin_sub_pause:${token}`, "◀ Back", ButtonStyle.Secondary)
            ),
          ],
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_pausex:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, behavior] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId || !isPauseBehavior(behavior)) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.pauseSubscription(session.subscriptionId!, behavior, `billadmin-pause-${interaction.id}`);
          this.ctx.audit.log(interaction, {
            action: "Pause collection",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `pause_collection.behavior = ${behavior}`,
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [makeEmbed(`⏸️ Collection paused on \`${session.subscriptionId}\` (${behavior}).`, COLORS.success)],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_resume:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const embed = new EmbedBuilder()
          .setTitle("Resume payment collection")
          .setColor(COLORS.warn)
          .setDescription(
            `Resume collection on \`${session.subscriptionId}\`? New invoices are collected normally again ` +
              "from the next billing cycle."
          );
        await interaction.update({
          embeds: [embed],
          components: [
            buttonRow(
              btn(`billadmin_sub_resumex:${token}`, "Resume collection", ButtonStyle.Primary),
              btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
            ),
          ],
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_resumex:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.resumeSubscription(session.subscriptionId!, `billadmin-resume-${interaction.id}`);
          this.ctx.audit.log(interaction, {
            action: "Resume collection",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: "pause_collection cleared — invoices collect normally again",
            severity: "info",
          });
          await interaction.editReply({
            embeds: [makeEmbed(`▶️ Collection resumed on \`${session.subscriptionId}\`.`, COLORS.success)],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },

    // ---- trial extension / end trial now ----

    {
      kind: "button",
      id: "billadmin_sub_trial:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const sub = await this.ctx.stripe.getSubscription(session.subscriptionId!);
          const embed = new EmbedBuilder()
            .setTitle("Trial")
            .setColor(COLORS.brand)
            .setDescription(
              `\`${sub.id}\` — status **${sub.status}**.\n` +
                (sub.trial_end && sub.trial_end > Math.floor(Date.now() / 1000)
                  ? `Current trial end: <t:${sub.trial_end}:F> (<t:${sub.trial_end}:R>)`
                  : "No active trial.") +
                "\n\n**Set / extend trial…** accepts a number of days (extends from now) or an absolute " +
                "date (YYYY-MM-DD). Setting a trial end on a non-trialing subscription puts it into " +
                "trialing until then. No proration is applied."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_sub_trialset:${token}`, "Set / extend trial…", ButtonStyle.Primary),
                btn(`billadmin_sub_trialnow:${token}`, "End trial now", ButtonStyle.Danger, sub.status !== "trialing"),
                btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_trialset:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.showModal(this.buildTrialEndModal(token));
      },
    },
    {
      kind: "modal",
      id: "billadmin_sub_trial_modal:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const raw = interaction.fields.getTextInputValue("value").trim();
        const nowSec = Math.floor(Date.now() / 1000);
        let ts: number | undefined;
        if (/^\d{1,3}$/.test(raw)) {
          const days = Number.parseInt(raw, 10);
          if (days >= 1 && days <= 730) ts = nowSec + days * 86400;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          const parsed = Date.parse(`${raw}T00:00:00Z`);
          if (!Number.isNaN(parsed)) ts = Math.floor(parsed / 1000);
        }
        if (!ts || ts <= nowSec) {
          await interaction.reply({
            embeds: [makeEmbed("Enter 1-730 (days from now) or a **future** date as YYYY-MM-DD.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        extraFor(session).trialEndTs = ts;
        await this.ctx.sessions.ackModal(interaction);
        const embed = new EmbedBuilder()
          .setTitle("Confirm trial end")
          .setColor(COLORS.warn)
          .setDescription(
            `Trial on \`${session.subscriptionId}\` will end **<t:${ts}:F>** (<t:${ts}:R>).\n` +
              "No proration is applied; the first regular invoice lands when the trial ends."
          );
        await interaction.editReply({
          embeds: [embed],
          components: [
            buttonRow(
              btn(`billadmin_sub_trialx:${token}`, "Set trial end", ButtonStyle.Primary),
              btn(`billadmin_sub_trial:${token}`, "◀ Back", ButtonStyle.Secondary)
            ),
          ],
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_trialx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const ts = subExtra.get(session)?.trialEndTs;
        if (!ts) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.setTrialEnd(session.subscriptionId!, ts, `billadmin-trial-${interaction.id}`);
          this.ctx.audit.log(interaction, {
            action: "Set trial end",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `Trial end set to ${new Date(ts * 1000).toISOString()}`,
            severity: "info",
          });
          await interaction.editReply({
            embeds: [makeEmbed(`⏱️ Trial on \`${session.subscriptionId}\` now ends <t:${ts}:F>.`, COLORS.success)],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_trialnow:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const embed = new EmbedBuilder()
          .setTitle("End trial now")
          .setColor(COLORS.danger)
          .setDescription(
            `⚠️ End the trial on \`${session.subscriptionId}\` **immediately**? ` +
              "The subscription becomes active and regular billing starts right away."
          );
        await interaction.update({
          embeds: [embed],
          components: [
            buttonRow(
              btn(`billadmin_sub_trialnowx:${token}`, "End trial now", ButtonStyle.Danger),
              btn(`billadmin_sub_trial:${token}`, "◀ Back", ButtonStyle.Secondary)
            ),
          ],
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_trialnowx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.setTrialEnd(session.subscriptionId!, "now", `billadmin-trialend-${interaction.id}`);
          this.ctx.audit.log(interaction, {
            action: "End trial now",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: "Trial ended immediately — regular billing starts now",
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [makeEmbed(`⏱️ Trial on \`${session.subscriptionId}\` ended — billing starts now.`, COLORS.success)],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },

    // ---- quantity ----

    {
      kind: "button",
      id: "billadmin_sub_qty:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.showModal(this.buildQuantityModal(token));
      },
    },
    {
      kind: "modal",
      id: "billadmin_sub_qty_modal:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const raw = interaction.fields.getTextInputValue("quantity").trim();
        const qty = Number.parseInt(raw, 10);
        if (!/^\d{1,3}$/.test(raw) || qty < 1 || qty > 999) {
          await interaction.reply({
            embeds: [makeEmbed("Quantity must be a whole number between 1 and 999.", COLORS.danger)],
            flags: 64,
          });
          return;
        }
        await this.ctx.sessions.ackModal(interaction);
        await this.ctx.sessions.tryRender(interaction, async () => {
          const [sub, priceMap] = await Promise.all([
            this.ctx.stripe.getSubscription(session.subscriptionId!),
            this.ctx.priceBook.labelMap(),
          ]);
          const item = sub.items.data[0];
          if (!item) {
            await interaction.editReply({
              embeds: [makeEmbed(`\`${sub.id}\` has no items.`, COLORS.warn)],
              components: [backRow(`billadmin_sub_view:${token}`)],
            });
            return;
          }
          session.subItemId = item.id;
          extraFor(session).quantity = qty;
          const embed = new EmbedBuilder()
            .setTitle("Confirm quantity change")
            .setColor(COLORS.warn)
            .addFields(
              { name: "Subscription", value: `\`${sub.id}\``, inline: false },
              { name: "Plan", value: subPlanLabel(this.ctx.stripe, sub, priceMap), inline: true },
              { name: "Quantity", value: `${item.quantity ?? 1} → **${qty}**`, inline: true }
            )
            .setDescription(
              "**Prorate** credits/bills the seat difference for the rest of the period. " +
                "**No proration** just changes the quantity — the new amount applies from the next invoice."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_sub_qtyx:${token}:prorate`, "Update (prorate)", ButtonStyle.Danger),
                btn(`billadmin_sub_qtyx:${token}:none`, "Update (no proration)", ButtonStyle.Danger),
                btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_qtyx:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, mode] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId || !session.subItemId) return;
        const qty = subExtra.get(session)?.quantity;
        if (!qty) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          await this.ctx.stripe.setSubscriptionQuantity(
            session.subscriptionId!,
            session.subItemId!,
            qty,
            mode === "prorate" ? "create_prorations" : "none",
            `billadmin-qty-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Set subscription quantity",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `Quantity set to ${qty} (${mode === "prorate" ? "prorated" : "no proration"})`,
            severity: "info",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `🔢 \`${session.subscriptionId}\` quantity set to **${qty}** ` +
                  `(${mode === "prorate" ? "prorated" : "no proration"}).`,
                COLORS.success
              ),
            ],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },

    // ---- scheduled plan change (subscription schedules) ----

    {
      kind: "button",
      id: "billadmin_sub_sched:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const sub = await this.ctx.stripe.getSubscription(session.subscriptionId!);
          const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
          extraFor(session).scheduleId = scheduleId;
          if (!scheduleId) {
            await this.showSchedulePlanPicker(interaction, token, sub);
            return;
          }
          const [schedule, priceMap] = await Promise.all([
            this.ctx.stripe.getSubscriptionSchedule(scheduleId),
            this.ctx.priceBook.labelMap(),
          ]);
          const nowSec = Math.floor(Date.now() / 1000);
          const next = schedule.phases.find((p) => p.start_date > nowSec);
          const pending = next
            ? `Pending phase: **${this.phaseLabels(next, priceMap)}** from <t:${next.start_date}:D>.`
            : "The schedule has no pending phase.";
          const embed = new EmbedBuilder()
            .setTitle("🗓️ Subscription schedule")
            .setColor(COLORS.brand)
            .setDescription(
              `\`${sub.id}\` is managed by schedule \`${scheduleId}\`.\n${pending}\n\n` +
                "**Release schedule** discards the pending change — the subscription keeps its current " +
                "plan and is no longer schedule-managed. **Replace next phase** picks a different plan " +
                "for the switch at period end."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_sub_schedplan:${token}`, "Replace next phase", ButtonStyle.Primary),
                btn(`billadmin_sub_schedrel:${token}`, "Release schedule", ButtonStyle.Danger),
                btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_schedplan:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const sub = await this.ctx.stripe.getSubscription(session.subscriptionId!);
          await this.showSchedulePlanPicker(interaction, token, sub);
        });
      },
    },
    {
      kind: "select",
      id: "billadmin_sub_schedpick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const price = await this.ctx.stripe.getPrice(value);
          const extra = extraFor(session);
          extra.schedPriceId = price.id;
          extra.schedPriceLabel = priceLabel(this.ctx.stripe, price);
          const periodEnd = extra.periodEnd;
          const embed = new EmbedBuilder()
            .setTitle("Confirm scheduled plan change")
            .setColor(COLORS.warn)
            .setDescription(
              `\`${session.subscriptionId}\` switches to **${extra.schedPriceLabel}** at period end` +
                `${periodEnd ? ` (<t:${periodEnd}:D>)` : ""}.\n` +
                "The current phase runs unchanged until then; after the switch the schedule releases " +
                "itself and the subscription is billed on the new plan."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_sub_schedx:${token}`, "Schedule change", ButtonStyle.Primary),
                btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_schedx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        const extra = subExtra.get(session);
        if (!extra?.schedPriceId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          let scheduleId = extra.scheduleId;
          if (!scheduleId) {
            const created = await this.ctx.stripe.createScheduleFromSubscription(
              session.subscriptionId!,
              `billadmin-sched-${interaction.id}`
            );
            scheduleId = created.id;
            extra.scheduleId = scheduleId;
          }
          await this.ctx.stripe.scheduleNextPhasePlan(
            scheduleId,
            extra.schedPriceId!,
            `billadmin-schedphase-${interaction.id}`
          );
          this.ctx.audit.log(interaction, {
            action: "Schedule plan change",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `Next phase → ${extra.schedPriceLabel ?? extra.schedPriceId} (schedule \`${scheduleId}\`)`,
            severity: "info",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `📅 \`${session.subscriptionId}\` switches to **${extra.schedPriceLabel ?? extra.schedPriceId}** ` +
                  `at period end${extra.periodEnd ? ` (<t:${extra.periodEnd}:D>)` : ""}.`,
                COLORS.success
              ),
            ],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_schedrel:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const scheduleId = await this.resolveScheduleId(session);
          if (!scheduleId) {
            await interaction.editReply({
              embeds: [makeEmbed(`\`${session.subscriptionId}\` has no schedule attached.`, COLORS.warn)],
              components: [backRow(`billadmin_sub_view:${token}`)],
            });
            return;
          }
          const embed = new EmbedBuilder()
            .setTitle("Release schedule")
            .setColor(COLORS.danger)
            .setDescription(
              `⚠️ Release schedule \`${scheduleId}\` on \`${session.subscriptionId}\`?\n` +
                "The pending plan change is **discarded** — the subscription keeps its current plan and " +
                "is no longer schedule-managed."
            );
          await interaction.editReply({
            embeds: [embed],
            components: [
              buttonRow(
                btn(`billadmin_sub_schedrelx:${token}`, "Release schedule", ButtonStyle.Danger),
                btn(`billadmin_sub_view:${token}`, "◀ Back", ButtonStyle.Secondary)
              ),
            ],
          });
        });
      },
    },
    {
      kind: "button",
      id: "billadmin_sub_schedrelx:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.subscriptionId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, async () => {
          const scheduleId = await this.resolveScheduleId(session);
          if (!scheduleId) {
            await interaction.editReply({
              embeds: [makeEmbed(`\`${session.subscriptionId}\` has no schedule attached.`, COLORS.warn)],
              components: [backRow(`billadmin_sub_view:${token}`)],
            });
            return;
          }
          await this.ctx.stripe.releaseSchedule(scheduleId, `billadmin-schedrel-${interaction.id}`);
          extraFor(session).scheduleId = undefined;
          this.ctx.audit.log(interaction, {
            action: "Release subscription schedule",
            targetCustomerId: session.customerId,
            objectId: session.subscriptionId,
            outcome: `Schedule \`${scheduleId}\` released — pending plan change discarded`,
            severity: "warn",
          });
          await interaction.editReply({
            embeds: [
              makeEmbed(`🗓️ Schedule \`${scheduleId}\` released — \`${session.subscriptionId}\` keeps its current plan.`, COLORS.success),
            ],
            components: [this.subDetailBackRow(token)],
          });
        });
      },
    },
  ];

  // ---- discount flow (the "discount" target action) ----

  async startDiscount(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;

    if (!this.ctx.config.stripe.discountCouponId) {
      await interaction.editReply({
        embeds: [makeEmbed("No discount coupon configured (STRIPE_DISCOUNT_COUPON_ID).", COLORS.danger)],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }

    const [subscriptions, priceMap] = await Promise.all([
      this.ctx.stripe.listSubscriptions(session.customerId),
      this.ctx.priceBook.labelMap(),
    ]);
    const candidates = subscriptions.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`\`${session.customerId}\` has no active subscription to discount.`, COLORS.warn)],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }
    if (candidates.length === 1) {
      session.subscriptionId = candidates[0].id;
      await interaction.editReply(
        this.buildDiscountConfirmPanel(candidates[0], token, subPlanLabel(this.ctx.stripe, candidates[0], priceMap))
      );
      return;
    }

    session.pendingSubAction = "discount";
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_subpick:${token}`)
      .setPlaceholder("Pick the subscription to discount")
      .addOptions(
        candidates.slice(0, 25).map((sub) => ({
          label: `${subPlanLabel(this.ctx.stripe, sub, priceMap)} · ${sub.status}`.slice(0, 100),
          description: sub.id.slice(0, 100),
          value: sub.id,
        }))
      );
    await interaction.editReply({
      embeds: [makeEmbed(`\`${session.customerId}\` has ${candidates.length} eligible subscriptions.`, COLORS.brand)],
      components: [
        selectRow(select),
        buttonRow(
          btn(`billadmin_sub_list:${token}`, "🛠 Manage a subscription", ButtonStyle.Secondary),
          btn("billadmin_hub:subs", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private buildDiscountConfirmPanel(
    sub: Stripe.Subscription,
    token: string,
    planLabel: string,
    backId = "billadmin_hub:subs"
  ): Panel {
    const existing = (sub.discounts ?? [])
      .map((d) => (typeof d === "string" ? d : d.id))
      .filter(Boolean);
    const embed = new EmbedBuilder()
      .setTitle("Apply discount coupon")
      .setColor(COLORS.warn)
      .addFields(
        { name: "Plan", value: planLabel, inline: true },
        { name: "Subscription", value: `\`${sub.id}\``, inline: true },
        { name: "Status", value: sub.status, inline: true },
        { name: "Coupon", value: `\`${this.ctx.config.stripe.discountCouponId}\``, inline: true }
      )
      .setDescription(
        existing.length
          ? `⚠️ This **replaces** the subscription's existing discount(s): ${existing.map((d) => `\`${d}\``).join(", ")}`
          : "The subscription has no existing discount."
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_discount_exec:${token}`, "Apply coupon", ButtonStyle.Danger),
          btn(backId, "Cancel", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- change plan flow (the "changeplan" target action) ----

  async startChangePlan(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;

    const subscriptions = await this.ctx.stripe.listSubscriptions(session.customerId);
    const candidates = subscriptions.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`\`${session.customerId}\` has no active subscription.`, COLORS.warn)],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }
    if (candidates.length === 1) {
      await this.showPlanPicker(interaction, token, candidates[0]);
      return;
    }

    session.pendingSubAction = "changeplan";
    const priceMap = await this.ctx.priceBook.labelMap();
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_subpick:${token}`)
      .setPlaceholder("Pick the subscription to change")
      .addOptions(
        candidates.slice(0, 25).map((sub) => ({
          label: `${subPlanLabel(this.ctx.stripe, sub, priceMap)} · ${sub.status}`.slice(0, 100),
          description: sub.id.slice(0, 100),
          value: sub.id,
        }))
      );
    await interaction.editReply({
      embeds: [makeEmbed(`\`${session.customerId}\` has ${candidates.length} eligible subscriptions.`, COLORS.brand)],
      components: [
        selectRow(select),
        buttonRow(
          btn(`billadmin_sub_list:${token}`, "🛠 Manage a subscription", ButtonStyle.Secondary),
          btn("billadmin_hub:subs", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async showPlanPicker(interaction: RenderInteraction, token: string, sub: Stripe.Subscription): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const item = sub.items.data[0];
    if (!item) {
      await interaction.editReply({
        embeds: [makeEmbed(`\`${sub.id}\` has no items to change.`, COLORS.warn)],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }

    session.subscriptionId = sub.id;
    session.subItemId = item.id;

    const prices = await this.ctx.priceBook.prices();
    // The item's own price has an unexpanded product — prefer the listed copy for its name.
    const current = prices.find((p) => p.id === item.price.id);
    session.planFrom = priceLabel(this.ctx.stripe, current ?? item.price);

    const { offered, limited } = this.filterAllowedPrices(prices);
    const options = offered.filter((p) => p.id !== item.price.id).slice(0, 25);
    if (options.length === 0) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            limited
              ? "No other plans are allowed — adjust 🔧 Plan Settings in the Subscriptions hub."
              : "No other active recurring prices exist in this Stripe account.",
            COLORS.warn
          ),
        ],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_planpick:${token}`)
      .setPlaceholder("Pick the new plan")
      .addOptions(
        options.map((p) => ({
          label: priceLabel(this.ctx.stripe, p).slice(0, 100),
          description: p.id.slice(0, 100),
          value: p.id,
        }))
      );

    const embed = new EmbedBuilder()
      .setTitle("Change plan")
      .setColor(COLORS.brand)
      .setDescription(
        `\`${sub.id}\` is currently on **${session.planFrom}**.` +
          (sub.items.data.length > 1 ? "\n⚠️ Multi-item subscription — only the first item's plan is changed." : "") +
          "\nPick the new plan:" +
          (limited ? "\n-# Plans limited by 🔧 Plan Settings" : "")
      );
    await interaction.editReply({
      embeds: [embed],
      components: [
        selectRow(select),
        buttonRow(
          btn(`billadmin_sub_view:${token}`, "🛠 Manage this subscription", ButtonStyle.Secondary),
          btn("billadmin_hub:subs", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private buildDiscountChoicePanel(sub: Stripe.Subscription, token: string): Panel {
    const session = this.ctx.sessions.get(token);
    const discounts = describeDiscounts(this.ctx.stripe, sub);
    const embed = new EmbedBuilder()
      .setTitle("Discount handling")
      .setColor(COLORS.brand)
      .setDescription(
        `Changing \`${sub.id}\` to **${session?.planTo ?? "?"}**.\n\n` +
          (discounts.length
            ? `Current discount: ${discounts.join(", ")}\n\nKeep it on the new plan, remove it, or set a different coupon?`
            : "The subscription has no discount. Continue without one, or add a coupon?")
      );
    const buttons = discounts.length
      ? [
          btn(`billadmin_dchoice:${token}:keep`, "Keep discount", ButtonStyle.Primary),
          btn(`billadmin_dchoice:${token}:remove`, "Remove discount", ButtonStyle.Danger),
          btn(`billadmin_dchoice:${token}:change`, "Set different coupon", ButtonStyle.Secondary),
        ]
      : [
          btn(`billadmin_dchoice:${token}:keep`, "No discount", ButtonStyle.Primary),
          btn(`billadmin_dchoice:${token}:change`, "Add a coupon", ButtonStyle.Secondary),
        ];
    buttons.push(btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary));
    return { embeds: [embed], components: [buttonRow(...buttons)] };
  }

  // Between the discount choice and this confirm, showChangePlanConfirm computes
  // a pinned-proration-date invoice preview; its fields land here. The preview is
  // best-effort — failures (currency mismatch, trialing sub) degrade to a warning
  // line, never a blocked flow.
  private async showChangePlanConfirm(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.subscriptionId || !session.subItemId || !session.newPriceId) return;
    const extra = extraFor(session);
    extra.prorationDate = undefined;
    const previewFields: { name: string; value: string }[] = [];
    let previewWarn: string | undefined;
    if (!session.customerId) {
      previewWarn = "Proration preview unavailable (no customer in session).";
    } else {
      const prorationDate = Math.floor(Date.now() / 1000);
      try {
        const preview = await this.ctx.stripe.previewPlanChange({
          customerId: session.customerId,
          subscriptionId: session.subscriptionId,
          itemId: session.subItemId,
          priceId: session.newPriceId,
          prorationDate,
        });
        extra.prorationDate = prorationDate;
        const nextTs = preview.next_payment_attempt ?? preview.period_end;
        previewFields.push(
          { name: "Due now", value: this.ctx.stripe.formatAmount(preview.amount_due, preview.currency) },
          {
            name: "Next invoice",
            value: `${this.ctx.stripe.formatAmount(preview.total, preview.currency)} on <t:${nextTs}:D>`,
          }
        );
        const lines = preview.lines.data
          .slice(0, 5)
          .map(
            (line) =>
              `${this.ctx.stripe.formatAmount(line.amount, line.currency)} — ${(line.description ?? line.id).slice(0, 80)}`
          );
        if (lines.length > 0) {
          previewFields.push({
            name:
              preview.lines.data.length > 5
                ? `Line items (5 of ${preview.lines.data.length})`
                : "Line items",
            value: lines.join("\n").slice(0, 1024),
          });
        }
      } catch (error) {
        previewWarn = `Proration preview unavailable: ${
          error instanceof Error ? error.message.slice(0, 200) : String(error)
        }`;
      }
    }
    await interaction.editReply(this.buildChangePlanConfirm(token, previewFields, previewWarn));
  }

  private buildChangePlanConfirm(
    token: string,
    previewFields: { name: string; value: string }[] = [],
    previewWarn?: string
  ): Panel {
    const session = this.ctx.sessions.get(token);
    const choice = session?.discountChoice ?? "keep";
    const discountLine =
      choice === "keep" ? "unchanged" : choice === "remove" ? "**removed**" : `set to \`${choice}\``;
    const embed = new EmbedBuilder()
      .setTitle("Confirm plan change")
      .setColor(COLORS.warn)
      .addFields(
        { name: "Subscription", value: `\`${session?.subscriptionId}\``, inline: false },
        { name: "From", value: session?.planFrom ?? "—", inline: true },
        { name: "To", value: session?.planTo ?? "—", inline: true },
        { name: "Discount", value: discountLine, inline: false },
        ...previewFields.map((f) => ({ ...f, inline: false }))
      )
      .setDescription(
        (previewWarn ? `⚠️ ${previewWarn}\n\n` : "") +
          "**Prorate** credits unused time on the old plan and bills the difference. " +
          "**No proration** just switches — the new price applies from the next invoice." +
          (previewFields.length > 0
            ? "\n-# Prorations are pinned to the preview timestamp — the prorated charge matches the preview."
            : "")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_planexec:${token}:prorate`, "Change (prorate)", ButtonStyle.Danger),
          btn(`billadmin_planexec:${token}:none`, "Change (no proration)", ButtonStyle.Danger),
          btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- create subscription flow (the "createsub" target action) ----

  async startCreateSub(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;

    const customer = await this.ctx.stripe.getCustomer(session.customerId);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }
    session.pendingSubAction = "createsub";
    session.hasDefaultPm = !!(customer.invoice_settings?.default_payment_method ?? customer.default_source);

    const prices = await this.ctx.priceBook.prices();
    const { offered, limited } = this.filterAllowedPrices(prices);
    if (offered.length === 0) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            limited
              ? "No plans are allowed — adjust 🔧 Plan Settings in the Subscriptions hub."
              : "No active recurring prices exist in this Stripe account.",
            COLORS.warn
          ),
        ],
        components: [backRow("billadmin_hub:subs")],
      });
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_planpick:${token}`)
      .setPlaceholder("Pick the plan")
      .addOptions(
        offered.slice(0, 25).map((p) => ({
          label: priceLabel(this.ctx.stripe, p).slice(0, 100),
          description: p.id.slice(0, 100),
          value: p.id,
        }))
      );
    const embed = new EmbedBuilder()
      .setTitle("Create subscription")
      .setColor(COLORS.brand)
      .setDescription(
        `New subscription for \`${customer.id}\`${customer.email ? ` (${customer.email})` : ""}. Pick the plan:` +
          (limited ? "\n-# Plans limited by 🔧 Plan Settings" : "")
      );
    await interaction.editReply({
      embeds: [embed],
      components: [selectRow(select), backRow("billadmin_hub:subs")],
    });
  }

  private buildCreateSubDiscountPanel(token: string, promos: Stripe.PromotionCode[]): Panel {
    const session = this.ctx.sessions.get(token);
    const embed = new EmbedBuilder()
      .setTitle("Discount")
      .setColor(COLORS.brand)
      .setDescription(
        `Creating **${session?.planTo ?? "?"}** for \`${session?.customerId}\`.\n\n` +
          "Start it with a discount? Pick an active promo code below, enter one manually, " +
          "pick a raw coupon — or continue without."
      );

    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (promos.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cspromopick:${token}`)
        .setPlaceholder("Pick an active promo code")
        .addOptions(
          promos.slice(0, 25).map((p) => {
            const coupon = promoCoupon(p);
            return {
              label: `${p.code}${coupon ? ` — ${couponDesc(this.ctx.stripe, coupon)}` : ""}`.slice(0, 100),
              description: `${p.times_redeemed}/${p.max_redemptions ?? "∞"} used · ${p.id}`.slice(0, 100),
              value: p.id,
            };
          })
        );
      components.push(selectRow(select));
    }
    components.push(
      buttonRow(
        btn(`billadmin_dchoice:${token}:keep`, "No discount", ButtonStyle.Primary),
        btn(`billadmin_cspromo:${token}`, "Enter promo code", ButtonStyle.Secondary),
        btn(`billadmin_dchoice:${token}:change`, "Pick a coupon", ButtonStyle.Secondary),
        btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private buildPromoEntryModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_cspromo_modal:${token}`)
      .setTitle("Apply a promo code")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("code", "Promo code", { required: true, placeholder: "e.g. WELCOME50 or promo_…" })
        )
      );
  }

  private buildCreateSubConfirm(token: string): Panel {
    const session = this.ctx.sessions.get(token);
    const choice = session?.discountChoice ?? "keep";
    const discountLine =
      choice === "keep" || choice === "remove"
        ? "none"
        : choice.startsWith("pc:")
          ? `\`${session?.discountLabel ?? choice.slice(3)}\` (promo code)`
          : `\`${choice}\` (coupon)`;
    const payNote = session?.hasDefaultPm
      ? "**Create & charge** bills the customer's default payment method for the first period now (unless a trial is set)."
      : "⚠️ The customer has **no default payment method** — **Create & charge** will fail. Use **Create + email invoice** (due in 7 days), or set a trial.";
    const embed = new EmbedBuilder()
      .setTitle("Confirm new subscription")
      .setColor(COLORS.warn)
      .addFields(
        { name: "Customer", value: `\`${session?.customerId}\``, inline: true },
        { name: "Plan", value: session?.planTo ?? "—", inline: true },
        { name: "Discount", value: discountLine, inline: true },
        { name: "Trial", value: session?.trialDays ? `${session.trialDays} days` : "none", inline: true }
      )
      .setDescription(payNote);
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_cscreate:${token}:auto`, "Create & charge", ButtonStyle.Danger),
          btn(`billadmin_cscreate:${token}:invoice`, "Create + email invoice", ButtonStyle.Primary),
          btn(`billadmin_cstrial:${token}`, "Set trial…", ButtonStyle.Secondary),
          btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private buildTrialModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_cstrial_modal:${token}`)
      .setTitle("Trial period")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("days", "Trial days (0 = no trial, max 730)", {
            required: true,
            placeholder: "e.g. 14",
            maxLength: 3,
          })
        )
      );
  }

  // ---- plan settings (allowlist + usage debug) ----

  private filterAllowedPrices(prices: Stripe.Price[]): { offered: Stripe.Price[]; limited: boolean } {
    const allowed = this.ctx.settingsStore.allowedPriceIds();
    if (allowed.length === 0) return { offered: prices, limited: false };
    const set = new Set(allowed);
    return { offered: prices.filter((p) => set.has(p.id)), limited: true };
  }

  private async renderPlanSettings(
    interaction: RenderInteraction,
    notice?: string,
    forceRecount = false
  ): Promise<void> {
    const [usage, prices] = await Promise.all([
      this.ctx.priceBook.getPlanUsage(forceRecount),
      this.ctx.priceBook.prices(forceRecount),
    ]);
    const allowed = new Set(this.ctx.settingsStore.allowedPriceIds());

    const sorted = [...prices].sort(
      (a, b) => (usage.counts.get(b.id) ?? 0) - (usage.counts.get(a.id) ?? 0)
    );
    const lines = sorted.map((p) => {
      const n = usage.counts.get(p.id) ?? 0;
      return `**${n}×** — ${priceLabel(this.ctx.stripe, p)} — \`${p.id}\`${allowed.has(p.id) ? " ✅" : ""}`;
    });
    // Prices no longer active but still carrying subscriptions — pure debug info.
    const activeIds = new Set(prices.map((p) => p.id));
    const archived = [...usage.counts.entries()]
      .filter(([priceId]) => !activeIds.has(priceId))
      .sort((a, b) => b[1] - a[1]);
    for (const [priceId, n] of archived.slice(0, 10)) {
      lines.push(`**${n}×** — _archived/inactive price_ — \`${priceId}\``);
    }

    const embed = new EmbedBuilder()
      .setTitle("🔧 Plan Settings")
      .setColor(COLORS.brand)
      .setDescription(
        [
          notice,
          "The selection below defines which plans the **Create Subscription** and **Change Plan** " +
            "pickers offer. Empty selection = all active plans. ✅ = currently allowed.",
          "",
          ...lines,
        ]
          .filter((l): l is string => l != null)
          .join("\n")
          .slice(0, 4096)
      )
      .setFooter({
        text:
          `${usage.scanned} active subscriptions scanned${usage.truncated ? " (truncated)" : ""} · ` +
          "counts cached for 5 min — Recount to refresh",
      });

    const options = sorted.slice(0, 25).map((p) => ({
      label: `${usage.counts.get(p.id) ?? 0}× · ${priceLabel(this.ctx.stripe, p)}`.slice(0, 100),
      description: p.id.slice(0, 100),
      value: p.id,
      default: allowed.has(p.id),
    }));
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (options.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId("billadmin_plansel")
        .setPlaceholder("Select the allowed plans (empty = all)")
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options);
      components.push(selectRow(select));
    }
    components.push(
      buttonRow(
        btn("billadmin_plansettings:refresh", "🔄 Recount", ButtonStyle.Secondary),
        btn("billadmin_hub:subs", "◀ Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- cancel subscription flow ----

  buildCancelModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_cancel_modal")
      .setTitle("Cancel a subscription")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("target_id", "Subscription or customer ID", { required: true, placeholder: "sub_… or cus_…" })
        )
      );
  }

  private async handleCancelModal(interaction: ModalSubmitInteraction): Promise<void> {
    const target = interaction.fields.getTextInputValue("target_id").trim();
    if (!/^(sub|cus)_[A-Za-z0-9]+$/.test(target)) {
      await interaction.reply({
        embeds: [makeEmbed("Enter a subscription ID (`sub_…`) or customer ID (`cus_…`).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      let sub: Stripe.Subscription | null;
      if (target.startsWith("sub_")) {
        sub = await this.ctx.stripe.getSubscription(target);
      } else {
        const subs = await this.ctx.stripe.listSubscriptions(target);
        sub = subs.find((s) => s.status !== "canceled") ?? null;
      }
      if (!sub || sub.status === "canceled") {
        await interaction.editReply({
          embeds: [makeEmbed(`No active subscription found for \`${target}\`.`, COLORS.warn)],
          components: [backRow("billadmin_hub:subs")],
        });
        return;
      }

      const priceMap = await this.ctx.priceBook.labelMap();
      const plan = subPlanLabel(this.ctx.stripe, sub, priceMap);
      const token = this.ctx.sessions.newSession(interaction, {
        subscriptionId: sub.id,
        planFrom: plan,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      });
      await interaction.editReply(this.buildCancelConfirmPanel(sub, plan, token, "billadmin_hub:subs", true));
    });
  }

  private buildCancelConfirmPanel(
    sub: Stripe.Subscription,
    plan: string,
    token: string,
    backId: string,
    showManage: boolean
  ): Panel {
    const periodEnd = sub.items.data[0]?.current_period_end;
    const embed = new EmbedBuilder()
      .setTitle("Confirm subscription cancel")
      .setColor(COLORS.danger)
      .addFields(
        { name: "Plan", value: plan, inline: true },
        { name: "Subscription", value: `\`${sub.id}\``, inline: true },
        {
          name: "Customer",
          value: `\`${typeof sub.customer === "string" ? sub.customer : sub.customer.id}\``,
          inline: true,
        },
        { name: "Status", value: sub.status, inline: true },
        { name: "Period end", value: periodEnd ? `<t:${periodEnd}:D>` : "—", inline: true },
        { name: "Cancel at period end?", value: sub.cancel_at_period_end ? "already scheduled" : "no", inline: true }
      )
      .setDescription("⚠️ **Cancel now** ends the subscription immediately; **at period end** lets it run out.");
    const buttons = [
      btn(`billadmin_cancelsub_exec:${token}`, "Cancel now", ButtonStyle.Danger),
      btn(`billadmin_cancelsub_softexec:${token}`, "Cancel at period end", ButtonStyle.Primary),
    ];
    if (showManage) buttons.push(btn(`billadmin_sub_view:${token}`, "🛠 Manage", ButtonStyle.Secondary));
    buttons.push(btn(backId, "Back", ButtonStyle.Secondary));
    return { embeds: [embed], components: [buttonRow(...buttons)] };
  }

  // ---- subscription detail panel & helpers ----

  private subDetailBackRow(token: string): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return buttonRow(
      btn(`billadmin_sub_view:${token}`, "🛠 Back to subscription", ButtonStyle.Secondary),
      btn("billadmin_hub:subs", "◀ Subscriptions", ButtonStyle.Secondary)
    );
  }

  private buildManageModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_sub_manage_modal")
      .setTitle("Manage a subscription")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("target_id", "Subscription or customer ID", { required: true, placeholder: "sub_… or cus_…" })
        )
      );
  }

  private async handleManageModal(interaction: ModalSubmitInteraction): Promise<void> {
    const target = interaction.fields.getTextInputValue("target_id").trim();
    if (!/^(sub|cus)_[A-Za-z0-9]+$/.test(target)) {
      await interaction.reply({
        embeds: [makeEmbed("Enter a subscription ID (`sub_…`) or customer ID (`cus_…`).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      if (target.startsWith("sub_")) {
        const sub = await this.ctx.stripe.getSubscription(target);
        const token = this.ctx.sessions.newSession(interaction, { subscriptionId: sub.id });
        await this.renderSubDetail(interaction, token);
        return;
      }
      const subs = (await this.ctx.stripe.listSubscriptions(target)).filter((s) => s.status !== "canceled");
      if (subs.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`\`${target}\` has no non-canceled subscriptions.`, COLORS.warn)],
          components: [backRow("billadmin_hub:subs")],
        });
        return;
      }
      if (subs.length === 1) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: target, subscriptionId: subs[0].id });
        await this.renderSubDetail(interaction, token);
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { customerId: target });
      const priceMap = await this.ctx.priceBook.labelMap();
      await interaction.editReply(this.buildSubPickPanel(token, subs, priceMap));
    });
  }

  private buildSubPickPanel(token: string, subs: Stripe.Subscription[], priceMap: Map<string, string>): Panel {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_sub_pick:${token}`)
      .setPlaceholder("Pick the subscription to manage")
      .addOptions(
        subs.slice(0, 25).map((sub) => ({
          label: `${subPlanLabel(this.ctx.stripe, sub, priceMap)} · ${sub.status}`.slice(0, 100),
          description: sub.id.slice(0, 100),
          value: sub.id,
        }))
      );
    return {
      embeds: [makeEmbed(`${subs.length} subscriptions — pick one to manage.`, COLORS.brand)],
      components: [selectRow(select), backRow("billadmin_hub:subs")],
    };
  }

  private buildTrialEndModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_sub_trial_modal:${token}`)
      .setTitle("Set / extend trial")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("value", "Days from now, or a date (YYYY-MM-DD)", {
            required: true,
            placeholder: "e.g. 14 — or 2026-08-01",
            maxLength: 10,
          })
        )
      );
  }

  private buildQuantityModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_sub_qty_modal:${token}`)
      .setTitle("Set quantity")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("quantity", "New quantity (1-999)", { required: true, placeholder: "e.g. 3", maxLength: 3 })
        )
      );
  }

  private phaseLabels(phase: Stripe.SubscriptionSchedule.Phase, priceMap: Map<string, string>): string {
    return phase.items
      .map((item) => {
        const priceId = typeof item.price === "string" ? item.price : item.price.id;
        return priceMap.get(priceId) ?? priceId;
      })
      .join(", ");
  }

  // The schedule id is cached per-session at detail render; fall back to a fresh
  // fetch so release still works after the panel went stale.
  private async resolveScheduleId(session: BillAdminSession): Promise<string | undefined> {
    const cached = subExtra.get(session)?.scheduleId;
    if (cached) return cached;
    if (!session.subscriptionId) return undefined;
    const sub = await this.ctx.stripe.getSubscription(session.subscriptionId);
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
    extraFor(session).scheduleId = scheduleId;
    return scheduleId;
  }

  private async showSchedulePlanPicker(
    interaction: RenderInteraction,
    token: string,
    sub: Stripe.Subscription
  ): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    const item = sub.items.data[0];
    if (!item) {
      await interaction.editReply({
        embeds: [makeEmbed(`\`${sub.id}\` has no items to schedule a change for.`, COLORS.warn)],
        components: [backRow(`billadmin_sub_view:${token}`)],
      });
      return;
    }
    const extra = extraFor(session);
    extra.periodEnd = item.current_period_end;

    const prices = await this.ctx.priceBook.prices();
    const { offered, limited } = this.filterAllowedPrices(prices);
    const options = offered.filter((p) => p.id !== item.price.id).slice(0, 25);
    if (options.length === 0) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            limited
              ? "No other plans are allowed — adjust 🔧 Plan Settings in the Subscriptions hub."
              : "No other active recurring prices exist in this Stripe account.",
            COLORS.warn
          ),
        ],
        components: [backRow(`billadmin_sub_view:${token}`)],
      });
      return;
    }

    const current = prices.find((p) => p.id === item.price.id);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_sub_schedpick:${token}`)
      .setPlaceholder("Pick the plan for the next phase")
      .addOptions(
        options.map((p) => ({
          label: priceLabel(this.ctx.stripe, p).slice(0, 100),
          description: p.id.slice(0, 100),
          value: p.id,
        }))
      );
    const embed = new EmbedBuilder()
      .setTitle("Schedule a plan change")
      .setColor(COLORS.brand)
      .setDescription(
        `\`${sub.id}\` stays on **${priceLabel(this.ctx.stripe, current ?? item.price)}** until ` +
          `<t:${item.current_period_end}:D>, then switches to the plan you pick:` +
          (limited ? "\n-# Plans limited by 🔧 Plan Settings" : "")
      );
    await interaction.editReply({
      embeds: [embed],
      components: [selectRow(select), backRow(`billadmin_sub_view:${token}`)],
    });
  }

  private async renderSubDetail(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.subscriptionId) return;
    const [sub, priceMap] = await Promise.all([
      this.ctx.stripe.getSubscription(session.subscriptionId),
      this.ctx.priceBook.labelMap(),
    ]);
    session.customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const item = sub.items.data[0];
    session.subItemId = item?.id;
    session.planFrom = subPlanLabel(this.ctx.stripe, sub, priceMap);
    const extra = extraFor(session);
    extra.periodEnd = item?.current_period_end;
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
    extra.scheduleId = scheduleId;

    const plans =
      sub.items.data
        .slice(0, 5)
        .map(
          (it) =>
            `${priceMap.get(it.price.id) ?? priceLabel(this.ctx.stripe, it.price)}` +
            `${it.quantity != null && it.quantity !== 1 ? ` ×${it.quantity}` : ""}`
        )
        .join("\n") || "—";
    const discounts = describeDiscounts(this.ctx.stripe, sub);

    let scheduleLine = "none";
    if (scheduleId) {
      scheduleLine = `\`${scheduleId}\``;
      try {
        const schedule = await this.ctx.stripe.getSubscriptionSchedule(scheduleId);
        const nowSec = Math.floor(Date.now() / 1000);
        const next = schedule.phases.find((p) => p.start_date > nowSec);
        scheduleLine = next
          ? `\`${scheduleId}\` → **${this.phaseLabels(next, priceMap)}** from <t:${next.start_date}:D>`
          : `\`${scheduleId}\` (no pending phase)`;
      } catch {
        scheduleLine = `\`${scheduleId}\` (details unavailable)`;
      }
    }

    const latestInvoice = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
    const embed = new EmbedBuilder()
      .setTitle("🔄 Manage subscription")
      .setColor(COLORS.brand)
      .setDescription(`\`${sub.id}\` — customer \`${session.customerId}\``)
      .addFields(
        { name: "Plan(s)", value: plans.slice(0, 1024), inline: false },
        {
          name: "Status",
          value: `${sub.status}${sub.cancel_at_period_end ? " · cancels at period end" : ""}`,
          inline: true,
        },
        {
          name: "Collection",
          value: sub.pause_collection ? `⏸️ paused (${sub.pause_collection.behavior})` : "collecting normally",
          inline: true,
        },
        { name: "Discounts", value: (discounts.join("\n") || "none").slice(0, 1024), inline: true },
        { name: "Trial end", value: sub.trial_end ? `<t:${sub.trial_end}:F>` : "—", inline: true },
        { name: "Period end", value: extra.periodEnd ? `<t:${extra.periodEnd}:F>` : "—", inline: true },
        { name: "Latest invoice", value: latestInvoice ? `\`${latestInvoice}\`` : "—", inline: true },
        { name: "Schedule", value: scheduleLine.slice(0, 1024), inline: false }
      );

    const dead = sub.status === "canceled";
    const paused = !!sub.pause_collection;
    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_sub_chplan:${token}`, "Change plan", ButtonStyle.Primary, dead),
          btn(`billadmin_sub_qty:${token}`, "Quantity…", ButtonStyle.Secondary, dead),
          btn(`billadmin_sub_trial:${token}`, "Extend trial…", ButtonStyle.Secondary, dead)
        ),
        buttonRow(
          paused
            ? btn(`billadmin_sub_resume:${token}`, "▶ Resume", ButtonStyle.Success, dead)
            : btn(`billadmin_sub_pause:${token}`, "⏸ Pause ▸", ButtonStyle.Secondary, dead),
          btn(`billadmin_sub_sched:${token}`, scheduleId ? "Schedule ▸" : "Schedule change", ButtonStyle.Secondary, dead),
          btn(`billadmin_sub_discount:${token}`, "Apply discount", ButtonStyle.Secondary, dead)
        ),
        buttonRow(
          btn(`billadmin_sub_cancel:${token}`, "Cancel…", ButtonStyle.Danger, dead),
          btn(`billadmin_sub_view:${token}`, "🔄 Refresh", ButtonStyle.Secondary),
          btn("billadmin_hub:subs", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }
}
