import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type Stripe from "stripe";
import { BotConfig } from "../config";
import { StripeClient } from "./StripeClient";
import { SessionStore } from "../auth/SessionStore";
import { embed as makeEmbed, COLORS } from "../util/embeds";

// Actions that first resolve "a user" to a Stripe customer before running.
const TARGET_ACTIONS = ["cards", "overview", "charges", "invoices", "fraud", "discount", "editcust", "delcust"] as const;
type TargetAction = (typeof TARGET_ACTIONS)[number];

const TARGET_TITLES: Record<TargetAction | "link", string> = {
  cards: "Card fingerprints of a user",
  overview: "Customer overview",
  charges: "Charges for a user",
  invoices: "Invoice history",
  fraud: "Disputes & fraud signals",
  discount: "Apply discount coupon",
  editcust: "Edit customer info",
  delcust: "Delete a customer",
  link: "Link / unlink Stripe customer",
};

type Panel = { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] };

interface BillAdminSession {
  ownerUserId: string;
  createdAt: number;
  // Paginated list state: which view the pager renders and the per-page cursor
  // (charges/invoices: starting_after id; charge search: page token).
  view?: "charges" | "invoices" | "fpcharges";
  cursors?: (string | undefined)[];
  customerId?: string;
  customerIds?: string[];
  pendingAction?: TargetAction;
  fingerprint?: string;
  chargeId?: string;
  refundAmountMinor?: number | null; // null = full remaining amount
  subscriptionId?: string;
  targetDiscordUserId?: string;
  promoCodeId?: string;
  paymentMethodId?: string;
  couponId?: string;
  custSnapshot?: {
    name: string;
    email: string;
    phone: string;
    description: string;
    address: Stripe.Address | null;
  };
}

type AdminGateInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | ModalSubmitInteraction;

const FINGERPRINT_RE = /^[A-Za-z0-9]{8,64}$/;
const SESSION_TTL_MS = 15 * 60 * 1000;

// Admin-only /billing panel: Stripe investigation and actions from Discord.
// Everything is ephemeral; sub-views swap in place on one message (like /config),
// with per-panel state held in a token session keyed by the creating interaction id.
export class BillingAdmin {
  private sessions = new Map<string, BillAdminSession>();

  constructor(
    private config: BotConfig,
    private stripeClient: StripeClient,
    private sessionStore: SessionStore
  ) {}

  // ---- entry points (routed from DiscordBot by the billadmin_ prefix) ----

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    await interaction.reply({ ...this.buildRootPanel(), flags: 64 });
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const id = interaction.customId;

    if (id === "billadmin_root") {
      await interaction.update(this.buildRootPanel());
      return;
    }
    if (id.startsWith("billadmin_hub:")) {
      await interaction.update(this.buildHubPanel(id.split(":")[1]));
      return;
    }
    if (id === "billadmin_promo_check") {
      await interaction.showModal(this.buildPromoCheckModal());
      return;
    }
    if (id === "billadmin_promo_create") {
      await interaction.showModal(this.buildPromoCreateModal());
      return;
    }
    if (id === "billadmin_promo_list") {
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.renderPromoList(interaction));
      return;
    }
    if (id === "billadmin_coupon_list") {
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.renderCouponList(interaction));
      return;
    }
    if (id === "billadmin_coupon_create") {
      await interaction.showModal(this.buildCouponCreateModal());
      return;
    }
    if (id.startsWith("billadmin_open:")) {
      await this.handleOpen(interaction, id.split(":")[1]);
      return;
    }
    if (id.startsWith("billadmin_manual:")) {
      const action = id.split(":")[1] as TargetAction;
      await interaction.showModal(this.buildTargetModal(action));
      return;
    }
    if (id.startsWith("billadmin_page:")) {
      const [, token, pageStr] = id.split(":");
      const session = await this.getOwnedSession(token, interaction);
      if (!session) return;
      const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.renderListPage(interaction, token, page));
      return;
    }
    if (id.startsWith("billadmin_goto:")) {
      const [, view, token] = id.split(":");
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        if (view === "fraud") {
          session.fingerprint = undefined;
          await this.renderFraud(interaction, token);
        } else {
          session.view = view === "invoices" ? "invoices" : "charges";
          session.cursors = [undefined];
          await this.renderListPage(interaction, token, 0);
        }
      });
      return;
    }
    if (id.startsWith("billadmin_refund_exec:") || id.startsWith("billadmin_refund_execsub:")) {
      await this.executeRefund(interaction, id.split(":")[1], id.startsWith("billadmin_refund_execsub:"));
      return;
    }
    if (id.startsWith("billadmin_cancelsub_exec:")) {
      const session = await this.getOwnedSession(id.split(":")[1], interaction);
      if (!session?.subscriptionId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.cancelSubscription(session.subscriptionId!);
        await interaction.editReply({
          embeds: [makeEmbed(`🔚 Subscription \`${session.subscriptionId}\` cancelled.`, COLORS.success)],
          components: [this.backRow("billadmin_hub:subs")],
        });
      });
      return;
    }
    if (id.startsWith("billadmin_cancelsub_softexec:")) {
      const session = await this.getOwnedSession(id.split(":")[1], interaction);
      if (!session?.subscriptionId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.cancelSubscriptionAtPeriodEnd(session.subscriptionId!);
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `⏳ Subscription \`${session.subscriptionId}\` will cancel at the end of the current period.`,
              COLORS.success
            ),
          ],
          components: [this.backRow("billadmin_hub:subs")],
        });
      });
      return;
    }
    if (id.startsWith("billadmin_discount_exec:")) {
      const session = await this.getOwnedSession(id.split(":")[1], interaction);
      if (!session?.subscriptionId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.applyDiscountCoupon(session.subscriptionId!, `billadmin-discount-${interaction.id}`);
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `💸 Coupon \`${this.config.stripe.discountCouponId}\` applied to \`${session.subscriptionId}\`.`,
              COLORS.success
            ),
          ],
          components: [this.backRow("billadmin_hub:subs")],
        });
      });
      return;
    }
    if (id.startsWith("billadmin_link_set:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.targetDiscordUserId) return;
      await interaction.showModal(this.buildLinkModal(token));
      return;
    }
    if (id.startsWith("billadmin_link_clear:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.targetDiscordUserId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.sessionStore.updateStripeCustomerId(session.targetDiscordUserId!, null);
        await interaction.editReply(await this.buildLinkPanel(token, "✅ Unlinked."));
      });
      return;
    }
    if (id.startsWith("billadmin_edit_details:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.custSnapshot) return;
      await interaction.showModal(this.buildEditDetailsModal(token, session.custSnapshot));
      return;
    }
    if (id.startsWith("billadmin_edit_address:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.custSnapshot) return;
      await interaction.showModal(this.buildEditAddressModal(token, session.custSnapshot.address));
      return;
    }
    if (id.startsWith("billadmin_taxid_add:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.showModal(this.buildTaxIdAddModal(token));
      return;
    }
    if (id.startsWith("billadmin_taxid_remove:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.showTaxIdRemovePicker(interaction, token));
      return;
    }
    if (id.startsWith("billadmin_editcust_show:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.renderEditCustomer(interaction, token));
      return;
    }
    if (id.startsWith("billadmin_cust_delete_exec:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.deleteCustomer(session.customerId!);
        const unlinked = await this.sessionStore.unlinkStripeCustomerEverywhere(session.customerId!);
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `🗑️ Customer \`${session.customerId}\` deleted in Stripe.` +
                (unlinked ? `\nCleared the link on ${unlinked} Discord user session(s).` : ""),
              COLORS.success
            ),
          ],
          components: [this.backRow("billadmin_hub:customers")],
        });
      });
      return;
    }
    if (id.startsWith("billadmin_cust_delete:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.update(this.buildCustomerDeleteConfirm(token));
      return;
    }
    if (id.startsWith("billadmin_cards_show:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, () => this.renderCards(interaction, token));
      return;
    }
    if (id.startsWith("billadmin_card_default:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId || !session.paymentMethodId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.setDefaultPaymentMethod(session.customerId!, session.paymentMethodId!);
        await this.renderCards(interaction, token, `✅ \`${session.paymentMethodId}\` is now the default.`);
      });
      return;
    }
    if (id.startsWith("billadmin_card_detach:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId || !session.paymentMethodId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.detachPaymentMethod(session.paymentMethodId!);
        await this.renderCards(interaction, token, `🗑️ Detached \`${session.paymentMethodId}\`.`);
      });
      return;
    }
    if (id.startsWith("billadmin_coupon_delete_exec:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.couponId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.deleteCoupon(session.couponId!);
        await this.renderCouponList(interaction, `🗑️ Coupon \`${session.couponId}\` deleted.`);
      });
      return;
    }
    if (id.startsWith("billadmin_promo_toggle:")) {
      const [, token, dir] = id.split(":");
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.promoCodeId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        const promo = await this.stripeClient.setPromotionCodeActive(session.promoCodeId!, dir === "on");
        await interaction.editReply(this.buildPromoDetailPanel(promo, token));
      });
      return;
    }
  }

  async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const action = interaction.customId.split(":")[1];
    const pickedId = interaction.values[0];
    if (!pickedId) return;
    await interaction.deferUpdate();

    await this.tryRender(interaction, async () => {
      const row = await this.sessionStore.getSession(pickedId);

      if (action === "link") {
        if (!row) {
          await interaction.editReply(
            this.buildTargetPanel(
              "link",
              `<@${pickedId}> has never authenticated with the bot, so there is no session row to attach a ` +
                `Stripe customer to (creating one would let them skip the OAuth login). Ask them to click ` +
                `**Start Here** and log in first.`
            )
          );
          return;
        }
        const token = this.newSession(interaction, { targetDiscordUserId: pickedId });
        await interaction.editReply(await this.buildLinkPanel(token));
        return;
      }

      if (!this.isTargetAction(action)) return;
      if (!row) {
        await interaction.editReply(
          this.buildTargetPanel(
            action,
            `<@${pickedId}> has no bot session — they've never logged in via **Start Here**. ` +
              `Use manual entry (cus_… / email) instead.`
          )
        );
        return;
      }
      if (!row.stripeCustomerId) {
        await interaction.editReply(
          this.buildTargetPanel(
            action,
            `<@${pickedId}> has a session but no linked Stripe customer. Link one via ` +
              `**Link / Unlink User**, or use manual entry (cus_… / email).`
          )
        );
        return;
      }
      const token = this.newSession(interaction, { customerId: row.stripeCustomerId });
      await this.runTargetAction(interaction, token, action);
    });
  }

  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const id = interaction.customId;
    const value = interaction.values[0];

    if (id.startsWith("billadmin_cuspick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session) return;
      await interaction.deferUpdate();
      session.customerId = value;
      await this.tryRender(interaction, () =>
        this.runTargetAction(interaction, token, session.pendingAction ?? "overview")
      );
      return;
    }
    if (id.startsWith("billadmin_subpick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        const sub = await this.stripeClient.getSubscription(value);
        session.subscriptionId = sub.id;
        await interaction.editReply(this.buildDiscountConfirmPanel(sub, token));
      });
      return;
    }
    if (id.startsWith("billadmin_taxidpick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        await this.stripeClient.removeTaxId(session.customerId!, value);
        await this.renderEditCustomer(interaction, token, "✅ Tax ID removed.");
      });
      return;
    }
    if (id.startsWith("billadmin_promopick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session) return;
      await interaction.deferUpdate();
      await this.tryRender(interaction, async () => {
        const promo = await this.stripeClient.getPromotionCode(value);
        session.promoCodeId = promo.id;
        await interaction.editReply(this.buildPromoDetailPanel(promo, token));
      });
      return;
    }
    if (id.startsWith("billadmin_cardpick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session?.customerId) return;
      await interaction.deferUpdate();
      session.paymentMethodId = value;
      await this.tryRender(interaction, async () => {
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
            this.buttonRow(
              this.btn(`billadmin_card_default:${token}`, "Set as default", ButtonStyle.Primary),
              this.btn(`billadmin_card_detach:${token}`, "Detach card", ButtonStyle.Danger),
              this.btn(`billadmin_cards_show:${token}`, "Back", ButtonStyle.Secondary)
            ),
          ],
        });
      });
      return;
    }
    if (id.startsWith("billadmin_couponpick:")) {
      const token = id.split(":")[1];
      const session = await this.getOwnedSession(token, interaction);
      if (!session) return;
      await interaction.deferUpdate();
      session.couponId = value;
      await this.tryRender(interaction, async () => {
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
            this.buttonRow(
              this.btn(`billadmin_coupon_delete_exec:${token}`, "Delete coupon", ButtonStyle.Danger),
              this.btn("billadmin_coupon_list", "Back", ButtonStyle.Secondary)
            ),
          ],
        });
      });
      return;
    }
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const id = interaction.customId;

    if (id.startsWith("billadmin_target_modal:")) {
      await this.handleTargetModal(interaction, id.split(":")[1] as TargetAction);
      return;
    }
    if (id.startsWith("billadmin_fp_modal:")) {
      await this.handleFingerprintModal(interaction, id.split(":")[1]);
      return;
    }
    if (id === "billadmin_last4_modal") {
      await this.handleLast4Modal(interaction);
      return;
    }
    if (id === "billadmin_refund_modal") {
      await this.handleRefundModal(interaction);
      return;
    }
    if (id === "billadmin_cancel_modal") {
      await this.handleCancelModal(interaction);
      return;
    }
    if (id === "billadmin_email_modal") {
      await this.handleEmailModal(interaction);
      return;
    }
    if (id === "billadmin_promo_check_modal") {
      await this.handlePromoCheckModal(interaction);
      return;
    }
    if (id === "billadmin_promo_create_modal") {
      await this.handlePromoCreateModal(interaction);
      return;
    }
    if (id === "billadmin_coupon_create_modal") {
      await this.handleCouponCreateModal(interaction);
      return;
    }
    if (id === "billadmin_createcust_modal") {
      await this.handleCreateCustomerModal(interaction);
      return;
    }
    if (id.startsWith("billadmin_link_modal:")) {
      await this.handleLinkModal(interaction, id.split(":")[1]);
      return;
    }
    if (id.startsWith("billadmin_edit_details_modal:")) {
      await this.handleEditDetailsModal(interaction, id.split(":")[1]);
      return;
    }
    if (id.startsWith("billadmin_edit_address_modal:")) {
      await this.handleEditAddressModal(interaction, id.split(":")[1]);
      return;
    }
    if (id.startsWith("billadmin_taxid_add_modal:")) {
      await this.handleTaxIdAddModal(interaction, id.split(":")[1]);
      return;
    }
  }

  // ---- root dispatch ----

  private async handleOpen(interaction: ButtonInteraction, action: string): Promise<void> {
    if (this.isTargetAction(action) || action === "link") {
      await interaction.update(this.buildTargetPanel(action as TargetAction | "link"));
      return;
    }
    switch (action) {
      case "usersbycard":
      case "chargesbycard":
        await interaction.showModal(this.buildFingerprintModal(action));
        return;
      case "cardsbylast4":
        await interaction.showModal(this.buildLast4Modal());
        return;
      case "refund":
        await interaction.showModal(this.buildRefundModal());
        return;
      case "cancelsub":
        await interaction.showModal(this.buildCancelModal());
        return;
      case "email":
        await interaction.showModal(this.buildEmailModal());
        return;
      case "createcust":
        await interaction.showModal(this.buildCreateCustomerModal());
        return;
      case "promo":
        await interaction.update(this.buildPromoHubPanel());
        return;
    }
  }

  // Runs a customer-scoped action once session.customerId is resolved.
  // The interaction must already be deferred; callers wrap this in tryRender.
  private async runTargetAction(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string,
    action: TargetAction
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;
    switch (action) {
      case "cards":
        await this.renderCards(interaction, token);
        return;
      case "overview":
        await this.renderOverview(interaction, token);
        return;
      case "charges":
      case "invoices":
        session.view = action;
        session.cursors = [undefined];
        await this.renderListPage(interaction, token, 0);
        return;
      case "fraud":
        await this.renderFraud(interaction, token);
        return;
      case "discount":
        await this.startDiscount(interaction, token);
        return;
      case "editcust":
        await this.renderEditCustomer(interaction, token);
        return;
      case "delcust": {
        const customer = await this.stripeClient.getCustomer(session.customerId!);
        if (!customer) {
          await interaction.editReply({
            embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or already deleted).`, COLORS.warn)],
            components: [this.backRow("billadmin_hub:customers")],
          });
          return;
        }
        await interaction.editReply(this.buildCustomerDeleteConfirm(token, customer));
        return;
      }
    }
  }

  // ---- target resolution via modal (cus_ id, email, or Postiz user id) ----

  private async handleTargetModal(interaction: ModalSubmitInteraction, action: TargetAction): Promise<void> {
    const target = interaction.fields.getTextInputValue("target").trim();
    const fingerprint = action === "fraud" ? interaction.fields.getTextInputValue("fingerprint").trim() : "";

    if (fingerprint && !FINGERPRINT_RE.test(fingerprint)) {
      await interaction.reply({
        embeds: [makeEmbed("That doesn't look like a card fingerprint (8-64 letters/digits).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    if (!target && !fingerprint) {
      await interaction.reply({
        embeds: [makeEmbed("Enter a Stripe customer ID, an email, or a Postiz user ID.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      if (fingerprint) {
        const token = this.newSession(interaction, { fingerprint });
        await this.renderFraud(interaction, token);
        return;
      }

      if (target.startsWith("cus_")) {
        const token = this.newSession(interaction, { customerId: target });
        await this.runTargetAction(interaction, token, action);
        return;
      }

      if (target.includes("@")) {
        const customers = await this.stripeClient.findCustomersByEmail(target);
        if (customers.length === 0) {
          await interaction.editReply(this.buildTargetPanel(action, `No Stripe customer found for \`${target}\`.`));
          return;
        }
        if (customers.length === 1) {
          const token = this.newSession(interaction, { customerId: customers[0].id });
          await this.runTargetAction(interaction, token, action);
          return;
        }
        const token = this.newSession(interaction, { pendingAction: action });
        await interaction.editReply(this.buildCustomerPickPanel(customers, token, this.hubFor(action)));
        return;
      }

      // Anything else is treated as a Postiz user id, resolved through the bot DB.
      const discordIds = await this.sessionStore.findDiscordIdsByPostizId(target);
      const rows = await this.sessionStore.listByDiscordIds(discordIds);
      const stripeIds = [...new Set(rows.map((r) => r.stripeCustomerId).filter((v): v is string => !!v))];
      if (stripeIds.length === 0) {
        await interaction.editReply(
          this.buildTargetPanel(action, `No linked Stripe customer found for Postiz user \`${target}\`.`)
        );
        return;
      }
      if (stripeIds.length === 1) {
        const token = this.newSession(interaction, { customerId: stripeIds[0] });
        await this.runTargetAction(interaction, token, action);
        return;
      }
      const token = this.newSession(interaction, { pendingAction: action });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cuspick:${token}`)
        .setPlaceholder("Several Stripe customers are linked — pick one")
        .addOptions(
          stripeIds.slice(0, 25).map((id) => ({ label: id, description: "via Postiz link", value: id }))
        );
      await interaction.editReply({
        embeds: [makeEmbed(`Postiz user \`${target}\` maps to ${stripeIds.length} Stripe customers.`, COLORS.warn)],
        components: [this.selectRow(select), this.backRow(this.hubFor(action))],
      });
    });
  }

  // ---- fingerprint-driven flows (users by card, charges by card, block card) ----

  private async handleFingerprintModal(interaction: ModalSubmitInteraction, action: string): Promise<void> {
    const fingerprint = interaction.fields.getTextInputValue("fingerprint").trim();
    if (!FINGERPRINT_RE.test(fingerprint)) {
      await interaction.reply({
        embeds: [makeEmbed("That doesn't look like a card fingerprint (8-64 letters/digits).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      if (action === "usersbycard") {
        await this.renderUsersByCard(interaction, fingerprint);
        return;
      }
      if (action === "chargesbycard") {
        const token = this.newSession(interaction, { fingerprint, view: "fpcharges", cursors: [undefined] });
        await this.renderListPage(interaction, token, 0);
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

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const { charges, nextPage } = await this.stripeClient.searchChargesByCardLast4(last4, brand || undefined, 100);
      if (charges.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No charges found for cards ending \`${last4}\`${brand ? ` (${brand})` : ""}.`, COLORS.neutral)],
          components: [this.backRow("billadmin_hub:cards")],
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
      await interaction.editReply({ embeds: [embed], components: [this.backRow("billadmin_hub:cards")] });
    });
  }

  private async renderUsersByCard(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    fingerprint: string
  ): Promise<void> {
    const { charges, nextPage } = await this.stripeClient.searchChargesByCardFingerprint(fingerprint, 100);
    if (charges.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`No charges found for card fingerprint \`${fingerprint}\`.`, COLORS.neutral)],
        components: [this.backRow("billadmin_hub:cards")],
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
      const discordIds = cusId.startsWith("cus_") ? await this.sessionStore.findDiscordIdsByStripeId(cusId) : [];
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
    await interaction.editReply({ embeds: [embed], components: [this.backRow("billadmin_hub:cards")] });
  }

  // ---- customer-scoped renderers ----

  private async renderCards(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string,
    notice?: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;

    const [paymentMethods, chargesRes, customer] = await Promise.all([
      this.stripeClient.listCustomerCards(customerId),
      this.stripeClient.listCharges(customerId, 100),
      this.stripeClient.getCustomer(customerId),
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
        components: [this.backRow("billadmin_hub:cards")],
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
      components.push(this.selectRow(select));
    }
    components.push(this.backRow("billadmin_hub:cards"));
    await interaction.editReply({ embeds: [embed], components });
  }

  private async renderOverview(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;

    const [customer, subscriptions, discordIds] = await Promise.all([
      this.stripeClient.getCustomer(customerId),
      this.stripeClient.listSubscriptions(customerId),
      this.sessionStore.findDiscordIdsByStripeId(customerId),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [this.backRow("billadmin_hub:customers")],
      });
      return;
    }

    const defaultPm = customer.invoice_settings?.default_payment_method;
    const subLines = subscriptions.slice(0, 10).map((sub) => {
      const periodEnd = sub.items.data[0]?.current_period_end;
      const flags = sub.cancel_at_period_end ? " · cancels at period end" : "";
      return `\`${sub.id}\` · ${sub.status}${flags}${periodEnd ? ` · ends <t:${periodEnd}:D>` : ""}`;
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
          value: `${this.stripeClient.formatAmount(customer.balance, customer.currency ?? "usd")}${customer.balance < 0 ? " (credit)" : ""}`,
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
        this.buttonRow(
          this.btn(`billadmin_goto:charges:${token}`, "View Charges", ButtonStyle.Primary),
          this.btn(`billadmin_goto:invoices:${token}`, "Invoices", ButtonStyle.Primary),
          this.btn(`billadmin_goto:fraud:${token}`, "Disputes & Fraud", ButtonStyle.Primary)
        ),
        this.backRow("billadmin_hub:customers"),
      ],
    });
  }

  // One pager for the three list views; the session records which view is active
  // and the cursor chain discovered so far (forward-only, so Prev re-uses stored cursors).
  private async renderListPage(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string,
    page: number
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.view || !session.cursors) return;

    let title: string;
    let lines: string[];
    let hasNext = false;
    let footerExtra = "";

    if (session.view === "invoices") {
      const { invoices, hasMore } = await this.stripeClient.listInvoices(session.customerId!, 10, session.cursors[page]);
      const last = invoices[invoices.length - 1];
      if (hasMore && last?.id) session.cursors[page + 1] = last.id;
      hasNext = hasMore;
      title = `Invoices — \`${session.customerId}\``;
      lines = invoices.map((inv) => this.invoiceLine(inv));
    } else if (session.view === "fpcharges") {
      const { charges, nextPage } = await this.stripeClient.searchChargesByCardFingerprint(
        session.fingerprint!,
        10,
        session.cursors[page]
      );
      if (nextPage) session.cursors[page + 1] = nextPage;
      hasNext = !!nextPage;
      title = `Charges — card \`${session.fingerprint}\``;
      lines = charges.map((c) => this.chargeLine(c, true));
      footerExtra = " · Search data can lag ~1 min";
    } else {
      const { charges, hasMore } = await this.stripeClient.listCharges(session.customerId!, 10, session.cursors[page]);
      const last = charges[charges.length - 1];
      if (hasMore && last) session.cursors[page + 1] = last.id;
      hasNext = hasMore;
      title = `Charges — \`${session.customerId}\``;
      lines = charges.map((c) => this.chargeLine(c, false));
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096) || "Nothing here.")
      .setFooter({ text: `Page ${page + 1}${footerExtra}` });

    await interaction.editReply({
      embeds: [embed],
      components: [
        this.buttonRow(
          this.btn(`billadmin_page:${token}:${page - 1}`, "◀ Prev", ButtonStyle.Secondary, page <= 0),
          this.btn(`billadmin_page:${token}:${page + 1}`, "Next ▶", ButtonStyle.Secondary, !hasNext),
          this.btn(session.view === "fpcharges" ? "billadmin_hub:cards" : "billadmin_hub:charges", "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async renderFraud(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session) return;

    let charges: Stripe.Charge[];
    let source: string;
    if (session.fingerprint) {
      charges = (await this.stripeClient.searchChargesByCardFingerprint(session.fingerprint, 20)).charges;
      source = `card \`${session.fingerprint}\``;
    } else if (session.customerId) {
      charges = (await this.stripeClient.listCharges(session.customerId, 20)).charges;
      source = `\`${session.customerId}\``;
    } else {
      return;
    }

    const warnings = await this.stripeClient.listRecentEarlyFraudWarnings(100);
    const warningByCharge = new Map(
      warnings.map((w) => [typeof w.charge === "string" ? w.charge : w.charge.id, w])
    );

    const disputedCharges = charges.filter((c) => c.disputed);
    const disputeByCharge = new Map<string, Stripe.Dispute | null>();
    for (const charge of disputedCharges.slice(0, 5)) {
      disputeByCharge.set(charge.id, await this.stripeClient.getDisputeForCharge(charge.id));
    }

    let matchedWarnings = 0;
    const lines = charges.map((charge) => {
      const parts = [
        `\`${charge.id}\``,
        `<t:${charge.created}:R>`,
        `**${this.stripeClient.formatAmount(charge.amount, charge.currency)}**`,
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
    await interaction.editReply({ embeds: [embed], components: [this.backRow("billadmin_hub:charges")] });
  }

  // ---- discount flow ----

  private async startDiscount(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;

    if (!this.config.stripe.discountCouponId) {
      await interaction.editReply({
        embeds: [makeEmbed("No discount coupon configured (STRIPE_DISCOUNT_COUPON_ID).", COLORS.danger)],
        components: [this.backRow("billadmin_hub:subs")],
      });
      return;
    }

    const subscriptions = await this.stripeClient.listSubscriptions(session.customerId);
    const candidates = subscriptions.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
    if (candidates.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed(`\`${session.customerId}\` has no active subscription to discount.`, COLORS.warn)],
        components: [this.backRow("billadmin_hub:subs")],
      });
      return;
    }
    if (candidates.length === 1) {
      session.subscriptionId = candidates[0].id;
      await interaction.editReply(this.buildDiscountConfirmPanel(candidates[0], token));
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_subpick:${token}`)
      .setPlaceholder("Pick the subscription to discount")
      .addOptions(
        candidates.slice(0, 25).map((sub) => ({
          label: sub.id.slice(0, 100),
          description: sub.status,
          value: sub.id,
        }))
      );
    await interaction.editReply({
      embeds: [makeEmbed(`\`${session.customerId}\` has ${candidates.length} eligible subscriptions.`, COLORS.brand)],
      components: [this.selectRow(select), this.backRow("billadmin_hub:subs")],
    });
  }

  private buildDiscountConfirmPanel(sub: Stripe.Subscription, token: string): Panel {
    const existing = (sub.discounts ?? [])
      .map((d) => (typeof d === "string" ? d : d.id))
      .filter(Boolean);
    const embed = new EmbedBuilder()
      .setTitle("Apply discount coupon")
      .setColor(COLORS.warn)
      .addFields(
        { name: "Subscription", value: `\`${sub.id}\``, inline: true },
        { name: "Status", value: sub.status, inline: true },
        { name: "Coupon", value: `\`${this.config.stripe.discountCouponId}\``, inline: true }
      )
      .setDescription(
        existing.length
          ? `⚠️ This **replaces** the subscription's existing discount(s): ${existing.map((d) => `\`${d}\``).join(", ")}`
          : "The subscription has no existing discount."
      );
    return {
      embeds: [embed],
      components: [
        this.buttonRow(
          this.btn(`billadmin_discount_exec:${token}`, "Apply coupon", ButtonStyle.Danger),
          this.btn("billadmin_hub:subs", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- refund flow ----

  private async handleRefundModal(interaction: ModalSubmitInteraction): Promise<void> {
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

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const charge = await this.stripeClient.getCharge(chargeId);

      let amountMinor: number | null = null;
      if (amountRaw) {
        if (StripeClient.isZeroDecimal(charge.currency)) {
          if (amountRaw.includes(".")) {
            await interaction.editReply({
              embeds: [
                makeEmbed(`\`${charge.currency}\` is a zero-decimal currency — whole amounts only.`, COLORS.danger),
              ],
              components: [this.backRow("billadmin_hub:charges")],
            });
            return;
          }
          amountMinor = Number.parseInt(amountRaw, 10);
        } else {
          amountMinor = Math.round(Number.parseFloat(amountRaw) * 100);
        }
      }

      const remaining = charge.amount - charge.amount_refunded;
      const fmt = (v: number) => this.stripeClient.formatAmount(v, charge.currency);
      if (charge.refunded || remaining <= 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`Already fully refunded (${fmt(charge.amount_refunded)} of ${fmt(charge.amount)}).`, COLORS.warn)],
          components: [this.backRow("billadmin_hub:charges")],
        });
        return;
      }
      if (amountMinor != null && (amountMinor <= 0 || amountMinor > remaining)) {
        await interaction.editReply({
          embeds: [makeEmbed(`Requested amount exceeds the un-refunded remainder of ${fmt(remaining)}.`, COLORS.danger)],
          components: [this.backRow("billadmin_hub:charges")],
        });
        return;
      }

      const token = this.newSession(interaction, {
        chargeId: charge.id,
        refundAmountMinor: amountMinor,
        customerId: typeof charge.customer === "string" ? charge.customer : charge.customer?.id,
      });

      const notes = [
        charge.disputed
          ? "🚩 **This charge is disputed** — refunding usually won't release disputed funds."
          : null,
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
          }
        )
        .setDescription(notes.join("\n"));

      await interaction.editReply({
        embeds: [embed],
        components: [
          this.buttonRow(
            this.btn(`billadmin_refund_exec:${token}`, "Refund", ButtonStyle.Danger),
            this.btn(`billadmin_refund_execsub:${token}`, "Refund + cancel sub", ButtonStyle.Danger),
            this.btn("billadmin_hub:charges", "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private async executeRefund(interaction: ButtonInteraction, token: string, withCancel: boolean): Promise<void> {
    const session = await this.getOwnedSession(token, interaction);
    if (!session?.chargeId) return;
    await interaction.deferUpdate();
    await this.tryRender(interaction, async () => {
      // Per-click idempotency key: stable across Discord retries of this click, but
      // unique across deliberate repeat refunds (reusing refund-${chargeId} would
      // silently return the first refund on a second partial).
      const result = await this.stripeClient.refundChargeAmount(
        session.chargeId!,
        session.refundAmountMinor ?? null,
        `billadmin-refund-${interaction.id}`
      );

      let cancelNote = "";
      if (withCancel) {
        if (!session.customerId) {
          cancelNote = "\n⚠️ The charge has no customer — no subscription to cancel.";
        } else {
          try {
            await this.stripeClient.cancelSubscription(session.customerId);
            cancelNote = "\n🔚 Subscription cancelled.";
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            cancelNote = `\n⚠️ Refund succeeded but cancelling the subscription failed: ${msg.slice(0, 300)}`;
          }
        }
      }

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `↩️ Refunded **${this.stripeClient.formatAmount(result.amount, result.currency)}** on \`${session.chargeId}\` — ` +
              `refund \`${result.refundId}\` (${result.status ?? "pending"}).${cancelNote}`,
            COLORS.success
          ),
        ],
        components: [this.backRow("billadmin_hub:charges")],
      });
    });
  }

  // ---- cancel subscription flow ----

  private async handleCancelModal(interaction: ModalSubmitInteraction): Promise<void> {
    const target = interaction.fields.getTextInputValue("target_id").trim();
    if (!/^(sub|cus)_[A-Za-z0-9]+$/.test(target)) {
      await interaction.reply({
        embeds: [makeEmbed("Enter a subscription ID (`sub_…`) or customer ID (`cus_…`).", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      let sub: Stripe.Subscription | null;
      if (target.startsWith("sub_")) {
        sub = await this.stripeClient.getSubscription(target);
      } else {
        const subs = await this.stripeClient.listSubscriptions(target);
        sub = subs.find((s) => s.status !== "canceled") ?? null;
      }
      if (!sub || sub.status === "canceled") {
        await interaction.editReply({
          embeds: [makeEmbed(`No active subscription found for \`${target}\`.`, COLORS.warn)],
          components: [this.backRow("billadmin_hub:subs")],
        });
        return;
      }

      const token = this.newSession(interaction, { subscriptionId: sub.id });
      const periodEnd = sub.items.data[0]?.current_period_end;
      const embed = new EmbedBuilder()
        .setTitle("Confirm subscription cancel")
        .setColor(COLORS.danger)
        .addFields(
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
      await interaction.editReply({
        embeds: [embed],
        components: [
          this.buttonRow(
            this.btn(`billadmin_cancelsub_exec:${token}`, "Cancel now", ButtonStyle.Danger),
            this.btn(`billadmin_cancelsub_softexec:${token}`, "Cancel at period end", ButtonStyle.Primary),
            this.btn("billadmin_hub:subs", "Back", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  // ---- find by email ----

  private async handleEmailModal(interaction: ModalSubmitInteraction): Promise<void> {
    const email = interaction.fields.getTextInputValue("email").trim();
    if (!email.includes("@")) {
      await interaction.reply({ embeds: [makeEmbed("That doesn't look like an email address.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const customers = await this.stripeClient.findCustomersByEmail(email);
      if (customers.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No Stripe customer found for \`${email}\` (exact match).`, COLORS.warn)],
          components: [this.backRow("billadmin_hub:customers")],
        });
        return;
      }
      if (customers.length === 1) {
        const token = this.newSession(interaction, { customerId: customers[0].id });
        await this.renderOverview(interaction, token);
        return;
      }
      const token = this.newSession(interaction, { pendingAction: "overview" });
      await interaction.editReply(this.buildCustomerPickPanel(customers, token, "billadmin_hub:customers"));
    });
  }

  private buildCustomerPickPanel(customers: Stripe.Customer[], token: string, backTarget: string): Panel {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_cuspick:${token}`)
      .setPlaceholder("Several customers matched — pick one")
      .addOptions(
        customers.slice(0, 25).map((c) => ({
          label: (c.email ?? c.id).slice(0, 100),
          description: `${c.name ?? "no name"} · ${c.id}`.slice(0, 100),
          value: c.id,
        }))
      );
    return {
      embeds: [makeEmbed(`${customers.length} Stripe customers matched.`, COLORS.brand)],
      components: [this.selectRow(select), this.backRow(backTarget)],
    };
  }

  // ---- link / unlink ----

  private async buildLinkPanel(token: string, notice?: string): Promise<Panel> {
    const session = this.sessions.get(token);
    const targetId = session?.targetDiscordUserId ?? "";
    const row = targetId ? await this.sessionStore.getSession(targetId) : null;

    let otherNote = "";
    if (row?.stripeCustomerId) {
      const others = (await this.sessionStore.findDiscordIdsByStripeId(row.stripeCustomerId)).filter(
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

    const buttons = [this.btn(`billadmin_link_set:${token}`, "Set / Change", ButtonStyle.Primary)];
    if (row?.stripeCustomerId) {
      buttons.push(this.btn(`billadmin_link_clear:${token}`, "Unlink", ButtonStyle.Danger));
    }
    buttons.push(this.btn("billadmin_hub:customers", "Back", ButtonStyle.Secondary));
    return { embeds: [embed], components: [this.buttonRow(...buttons)] };
  }

  private async handleLinkModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.getOwnedSession(token, interaction);
    if (!session?.targetDiscordUserId) return;

    const customerId = interaction.fields.getTextInputValue("customer_id").trim();
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
      await interaction.reply({ embeds: [makeEmbed("Customer IDs start with `cus_`.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const customer = await this.stripeClient.getCustomer(customerId);
      if (!customer) {
        await interaction.editReply(await this.buildLinkPanel(token, `❌ No such Stripe customer: \`${customerId}\`.`));
        return;
      }
      const updated = await this.sessionStore.updateStripeCustomerId(session.targetDiscordUserId!, customerId);
      await interaction.editReply(
        await this.buildLinkPanel(
          token,
          updated ? `✅ Linked to \`${customerId}\`.` : "⚠️ The user's session row disappeared — nothing updated."
        )
      );
    });
  }

  // ---- edit customer info ----

  private async renderEditCustomer(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    token: string,
    notice?: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;

    const [customer, taxIds] = await Promise.all([
      this.stripeClient.getCustomer(session.customerId),
      this.stripeClient.listTaxIds(session.customerId),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or it was deleted).`, COLORS.warn)],
        components: [this.backRow("billadmin_hub:customers")],
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
        { name: "Address", value: this.formatAddress(customer.address), inline: false },
        { name: `Tax IDs (${taxIds.length})`, value: taxIdLines.slice(0, 1024) || "—", inline: false }
      );
    if (notice) embed.setDescription(notice);

    await interaction.editReply({
      embeds: [embed],
      components: [
        this.buttonRow(
          this.btn(`billadmin_edit_details:${token}`, "Edit details", ButtonStyle.Primary),
          this.btn(`billadmin_edit_address:${token}`, "Edit address", ButtonStyle.Primary)
        ),
        this.buttonRow(
          this.btn(`billadmin_taxid_add:${token}`, "Add tax ID", ButtonStyle.Primary),
          this.btn(`billadmin_taxid_remove:${token}`, "Remove tax ID", ButtonStyle.Secondary, taxIds.length === 0),
          this.btn(`billadmin_cust_delete:${token}`, "Delete customer", ButtonStyle.Danger),
          this.btn("billadmin_hub:customers", "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async showTaxIdRemovePicker(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;
    const taxIds = await this.stripeClient.listTaxIds(session.customerId);
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
        this.selectRow(select),
        this.buttonRow(this.btn(`billadmin_editcust_show:${token}`, "◀ Back", ButtonStyle.Secondary)),
      ],
    });
  }

  private async handleEditDetailsModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ackModal(interaction);

    // Fields are pre-filled with current values, so what comes back IS the new
    // state: an emptied field means "clear it" (Stripe treats "" as unset).
    const params: Stripe.CustomerUpdateParams = {
      name: interaction.fields.getTextInputValue("name").trim(),
      email: interaction.fields.getTextInputValue("email").trim(),
      phone: interaction.fields.getTextInputValue("phone").trim(),
      description: interaction.fields.getTextInputValue("description").trim(),
    };
    await this.applyCustomerEdit(interaction, token, params, "✅ Details updated.");
  }

  private async handleEditAddressModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ackModal(interaction);

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
    await this.applyCustomerEdit(interaction, token, { address }, "✅ Address updated.");
  }

  private async handleTaxIdAddModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.getOwnedSession(token, interaction);
    if (!session?.customerId) return;
    await this.ackModal(interaction);

    const type = interaction.fields.getTextInputValue("type").trim();
    const value = interaction.fields.getTextInputValue("value").trim();
    try {
      await this.stripeClient.addTaxId(session.customerId, type, value);
      await this.renderEditCustomer(interaction, token, "✅ Tax ID added.");
    } catch (error) {
      await this.editCustomerErrorFallback(interaction, token, error);
    }
  }

  private async applyCustomerEdit(
    interaction: ModalSubmitInteraction,
    token: string,
    params: Stripe.CustomerUpdateParams,
    notice: string
  ): Promise<void> {
    const session = this.sessions.get(token);
    if (!session?.customerId) return;
    try {
      await this.stripeClient.updateCustomer(session.customerId, params);
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
    console.error("Billing admin customer edit error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    try {
      await this.renderEditCustomer(interaction, token, `⚠️ Stripe rejected the change: ${msg.slice(0, 500)}`);
    } catch {
      await interaction
        .editReply({ embeds: [this.stripeErrorEmbed(error)], components: [this.backRow()] })
        .catch(() => undefined);
    }
  }

  // ---- promo codes ----

  private buildPromoHubPanel(): Panel {
    const embed = new EmbedBuilder()
      .setTitle("Promotion codes & coupons")
      .setColor(COLORS.brand)
      .setDescription(
        "Check whether a promo code is valid, create new codes, deactivate/reactivate them, " +
          "and manage the coupons they apply.\n\n" +
          "ℹ️ Stripe promotion codes can't be **edited or deleted** — only deactivated. To change one, " +
          "deactivate it and create a replacement. Coupons *can* be deleted."
      );
    return {
      embeds: [embed],
      components: [
        this.buttonRow(
          this.btn("billadmin_promo_check", "Check a code", ButtonStyle.Primary),
          this.btn("billadmin_promo_create", "Create a code", ButtonStyle.Primary),
          this.btn("billadmin_promo_list", "List codes", ButtonStyle.Primary)
        ),
        this.buttonRow(
          this.btn("billadmin_coupon_list", "Coupons", ButtonStyle.Primary),
          this.btn("billadmin_coupon_create", "Create coupon", ButtonStyle.Primary),
          this.btn("billadmin_root", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async renderPromoList(interaction: {
    editReply: (payload: Panel) => Promise<unknown>;
    id: string;
    user: { id: string };
  }): Promise<void> {
    const promos = await this.stripeClient.listPromotionCodes(25);
    if (promos.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed("No promotion codes exist yet.", COLORS.neutral)],
        components: [this.promoBackRow()],
      });
      return;
    }

    const lines = promos.map(
      (p) =>
        `**${p.code}** · ${p.active ? "active" : "inactive"} · coupon \`${this.promoCouponId(p)}\` · ` +
        `${p.times_redeemed}/${p.max_redemptions ?? "∞"} used${p.expires_at ? ` · expires <t:${p.expires_at}:R>` : ""}`
    );
    const token = this.newSession(interaction, {});
    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_promopick:${token}`)
      .setPlaceholder("Pick a code to inspect / toggle")
      .addOptions(
        promos.slice(0, 25).map((p) => ({
          label: p.code.slice(0, 100),
          description: `${p.active ? "active" : "inactive"} · coupon ${this.promoCouponId(p)}`.slice(0, 100),
          value: p.id,
        }))
      );

    const embed = new EmbedBuilder()
      .setTitle("Promotion codes")
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096))
      .setFooter({ text: `${promos.length} most recent codes` });
    await interaction.editReply({ embeds: [embed], components: [this.selectRow(select), this.promoBackRow()] });
  }

  private async renderCouponList(
    interaction: { editReply: (payload: Panel) => Promise<unknown>; id: string; user: { id: string } },
    notice?: string
  ): Promise<void> {
    const coupons = await this.stripeClient.listCoupons(25);
    if (coupons.length === 0) {
      await interaction.editReply({
        embeds: [makeEmbed([notice, "No coupons exist yet."].filter(Boolean).join("\n"), COLORS.neutral)],
        components: [this.promoBackRow()],
      });
      return;
    }

    const describe = (c: Stripe.Coupon) =>
      c.percent_off != null
        ? `${c.percent_off}% off`
        : c.amount_off != null
          ? `${this.stripeClient.formatAmount(c.amount_off, c.currency ?? "usd")} off`
          : "—";
    const lines = coupons.map(
      (c) =>
        `\`${c.id}\`${c.name ? ` (${c.name})` : ""} · ${describe(c)} · ${c.duration}` +
        `${c.duration_in_months ? ` (${c.duration_in_months}m)` : ""} · ${c.times_redeemed} redeemed · ` +
        `${c.valid ? "valid" : "invalid"}`
    );
    const token = this.newSession(interaction, {});
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
    await interaction.editReply({ embeds: [embed], components: [this.selectRow(select), this.promoBackRow()] });
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
          embeds: [makeEmbed(`\`${currency}\` is a zero-decimal currency — whole amounts only.`, COLORS.danger)],
          flags: 64,
        });
        return;
      }
      amountOffMinor = StripeClient.isZeroDecimal(currency) ? Math.round(value) : Math.round(value * 100);
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const coupon = await this.stripeClient.createCoupon(
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
      await this.renderCouponList(interaction, `✅ Coupon \`${coupon.id}\` created.`);
    });
  }

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

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const customer = await this.stripeClient.createCustomer({
        email: email || undefined,
        name: name || undefined,
        description: description || undefined,
      });
      const token = this.newSession(interaction, { customerId: customer.id });
      await this.renderEditCustomer(interaction, token, `✅ Customer \`${customer.id}\` created.`);
    });
  }

  private async handlePromoCheckModal(interaction: ModalSubmitInteraction): Promise<void> {
    const query = interaction.fields.getTextInputValue("code").trim();
    if (!query) {
      await interaction.reply({ embeds: [makeEmbed("Enter a promo code or `promo_…` ID.", COLORS.danger)], flags: 64 });
      return;
    }

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const promos = query.startsWith("promo_")
        ? [await this.stripeClient.getPromotionCode(query)]
        : await this.stripeClient.findPromotionCodes(query);

      if (promos.length === 0) {
        await interaction.editReply({
          embeds: [makeEmbed(`No promotion code matching \`${query}\`.`, COLORS.warn)],
          components: [this.promoBackRow()],
        });
        return;
      }
      if (promos.length === 1) {
        const token = this.newSession(interaction, { promoCodeId: promos[0].id });
        await interaction.editReply(this.buildPromoDetailPanel(promos[0], token));
        return;
      }
      const token = this.newSession(interaction, {});
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_promopick:${token}`)
        .setPlaceholder("Several promo codes matched — pick one")
        .addOptions(
          promos.slice(0, 25).map((p) => ({
            label: p.code.slice(0, 100),
            description: `${p.active ? "active" : "inactive"} · coupon ${this.promoCouponId(p)}`.slice(0, 100),
            value: p.id,
          }))
        );
      await interaction.editReply({
        embeds: [makeEmbed(`${promos.length} promo codes matched \`${query}\`.`, COLORS.brand)],
        components: [this.selectRow(select), this.promoBackRow()],
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

    await this.ackModal(interaction);
    await this.tryRender(interaction, async () => {
      const promo = await this.stripeClient.createPromotionCode(
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
      const token = this.newSession(interaction, { promoCodeId: promo.id });
      await interaction.editReply(this.buildPromoDetailPanel(promo, token, "✅ Promotion code created."));
    });
  }

  private buildPromoDetailPanel(promo: Stripe.PromotionCode, token: string, notice?: string): Panel {
    const coupon = this.promoCoupon(promo);
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
          ? `${this.stripeClient.formatAmount(coupon.amount_off, coupon.currency ?? "usd")} off`
          : "—";
    const restrictions = [
      promo.restrictions.first_time_transaction ? "first purchase only" : null,
      promo.restrictions.minimum_amount != null
        ? `min ${this.stripeClient.formatAmount(promo.restrictions.minimum_amount, promo.restrictions.minimum_amount_currency ?? "usd")}`
        : null,
      promo.customer ? `customer-specific (\`${typeof promo.customer === "string" ? promo.customer : promo.customer.id}\`)` : null,
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle(`Promo code — ${promo.code}`)
      .setColor(valid ? COLORS.success : COLORS.warn)
      .addFields(
        { name: "Valid now", value: valid ? "✅ yes" : `❌ no — ${reasons.join(", ")}`, inline: false },
        { name: "ID", value: `\`${promo.id}\``, inline: true },
        { name: "Active flag", value: promo.active ? "active" : "deactivated", inline: true },
        { name: "Expires", value: promo.expires_at ? `<t:${promo.expires_at}:f>` : "never", inline: true },
        {
          name: "Coupon",
          value: coupon
            ? `\`${coupon.id}\`${coupon.name ? ` (${coupon.name})` : ""} · ${discount} · ${coupon.duration}${coupon.duration_in_months ? ` (${coupon.duration_in_months} months)` : ""} · ${coupon.valid ? "valid" : "invalid"}`
            : `\`${this.promoCouponId(promo)}\``,
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
        this.buttonRow(
          promo.active
            ? this.btn(`billadmin_promo_toggle:${token}:off`, "Deactivate", ButtonStyle.Danger)
            : this.btn(`billadmin_promo_toggle:${token}:on`, "Reactivate", ButtonStyle.Success),
          this.btn("billadmin_open:promo", "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  // ---- panels ----

  private buildRootPanel(): Panel {
    const testMode = this.config.stripe.secretKey?.includes("_test_");
    const embed = new EmbedBuilder()
      .setTitle("Billing Admin")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "💳 **Cards** — lookups by user, fingerprint or last 4 · set default · detach",
          "👤 **Customers** — overview, email lookup, create, edit (VAT/address), link, delete",
          "💰 **Charges** — charge & invoice history, disputes & fraud, refunds",
          "🔄 **Subscriptions** — view, apply discount, cancel",
          "🎟️ **Promos** — promo codes & coupons",
        ].join("\n")
      )
      .setFooter({
        text: `Ephemeral · Stripe ${testMode ? "TEST" : "LIVE"} mode · Sessions expire after 15 minutes`,
      });

    return {
      embeds: [embed],
      components: [
        this.buttonRow(
          this.btn("billadmin_hub:cards", "💳 Cards", ButtonStyle.Primary),
          this.btn("billadmin_hub:customers", "👤 Customers", ButtonStyle.Primary),
          this.btn("billadmin_hub:charges", "💰 Charges", ButtonStyle.Primary),
          this.btn("billadmin_hub:subs", "🔄 Subscriptions", ButtonStyle.Primary),
          this.btn("billadmin_open:promo", "🎟️ Promos", ButtonStyle.Primary)
        ),
      ],
    };
  }

  // Second navigation level: one hub per top-level area, grouping its actions
  // by CRUD verb. The concrete flows (target pickers, modals, results) hang off
  // the same billadmin_open:/billadmin_manual: ids as before.
  private buildHubPanel(area: string): Panel {
    if (area === "cards") {
      const embed = new EmbedBuilder()
        .setTitle("💳 Cards")
        .setColor(COLORS.brand)
        .setDescription(
          [
            "**Read** — a user's cards, or hunt cards account-wide by fingerprint / last 4.",
            "**Update / Delete** — open *User's Cards* and pick a saved card to set it as default or detach it.",
          ].join("\n")
        );
      return {
        embeds: [embed],
        components: [
          this.buttonRow(
            this.btn("billadmin_open:cards", "User's Cards", ButtonStyle.Primary),
            this.btn("billadmin_open:usersbycard", "Users by Card", ButtonStyle.Primary),
            this.btn("billadmin_open:chargesbycard", "Charges by Card", ButtonStyle.Primary),
            this.btn("billadmin_open:cardsbylast4", "Cards by Last 4", ButtonStyle.Primary)
          ),
          this.backRow(),
        ],
      };
    }
    if (area === "customers") {
      const embed = new EmbedBuilder()
        .setTitle("👤 Customers")
        .setColor(COLORS.brand)
        .setDescription(
          [
            "**Read** — full overview, or find a customer by email.",
            "**Create** — a bare Stripe customer.",
            "**Update** — details, address, VAT/tax IDs · link/unlink the Discord ↔ Stripe mapping.",
            "**Delete** — permanently remove a customer (cancels their subscriptions).",
          ].join("\n")
        );
      return {
        embeds: [embed],
        components: [
          this.buttonRow(
            this.btn("billadmin_open:overview", "Overview", ButtonStyle.Primary),
            this.btn("billadmin_open:email", "Find by Email", ButtonStyle.Primary)
          ),
          this.buttonRow(
            this.btn("billadmin_open:createcust", "Create", ButtonStyle.Success),
            this.btn("billadmin_open:editcust", "Edit", ButtonStyle.Primary),
            this.btn("billadmin_open:link", "Link / Unlink", ButtonStyle.Secondary)
          ),
          this.buttonRow(
            this.btn("billadmin_open:delcust", "Delete Customer", ButtonStyle.Danger),
            this.btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
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
          this.buttonRow(
            this.btn("billadmin_open:charges", "Charges for User", ButtonStyle.Primary),
            this.btn("billadmin_open:invoices", "Invoices", ButtonStyle.Primary),
            this.btn("billadmin_open:fraud", "Disputes & Fraud", ButtonStyle.Primary)
          ),
          this.buttonRow(
            this.btn("billadmin_open:refund", "Refund a Charge", ButtonStyle.Danger),
            this.btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
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
            "**Read** — subscriptions are listed in the customer *Overview*.",
            "**Update** — apply the configured discount coupon.",
            "**Delete** — cancel now, or at the end of the current period.",
          ].join("\n")
        );
      return {
        embeds: [embed],
        components: [
          this.buttonRow(
            this.btn("billadmin_open:overview", "View (Overview)", ButtonStyle.Primary),
            this.btn("billadmin_open:discount", "Apply Discount", ButtonStyle.Primary),
            this.btn("billadmin_open:cancelsub", "Cancel Subscription", ButtonStyle.Danger)
          ),
          this.backRow(),
        ],
      };
    }
    return this.buildRootPanel();
  }

  // Which hub a detail flow's Back button returns to.
  private hubFor(action: TargetAction | "link"): string {
    switch (action) {
      case "cards":
        return "billadmin_hub:cards";
      case "charges":
      case "invoices":
      case "fraud":
        return "billadmin_hub:charges";
      case "discount":
        return "billadmin_hub:subs";
      default:
        return "billadmin_hub:customers"; // overview, editcust, delcust, link
    }
  }

  private buildTargetPanel(action: TargetAction | "link", error?: string): Panel {
    const embed = new EmbedBuilder()
      .setTitle(TARGET_TITLES[action])
      .setColor(error ? COLORS.warn : COLORS.brand)
      .setDescription(
        [
          error ? `⚠️ ${error}\n` : null,
          action === "link"
            ? "Pick the Discord user whose Stripe link you want to change."
            : "Pick the Discord user, or enter a Stripe customer ID / email / Postiz user ID manually.",
        ]
          .filter(Boolean)
          .join("\n")
      );

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`billadmin_user:${action}`)
      .setPlaceholder("Pick a Discord user");

    const buttons: ButtonBuilder[] = [];
    if (action !== "link") {
      buttons.push(this.btn(`billadmin_manual:${action}`, "Enter cus_ / email / Postiz ID", ButtonStyle.Secondary));
    }
    buttons.push(this.btn(this.hubFor(action), "◀ Back", ButtonStyle.Secondary));

    return {
      embeds: [embed],
      components: [this.selectRow(userSelect), this.buttonRow(...buttons)],
    };
  }

  // ---- modals ----

  private buildTargetModal(action: TargetAction): ModalBuilder {
    const modal = new ModalBuilder()
      .setCustomId(`billadmin_target_modal:${action}`)
      .setTitle(TARGET_TITLES[action].slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        this.textInput("target", "Stripe cus_ ID, email, or Postiz user ID", {
          required: action !== "fraud",
          placeholder: "cus_… / mail@example.com / postiz id",
        })
      )
    );
    if (action === "fraud") {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("fingerprint", "…or a card fingerprint instead", {
            required: false,
            placeholder: "Wins over the field above if filled",
          })
        )
      );
    }
    return modal;
  }

  private buildFingerprintModal(action: string): ModalBuilder {
    const titles: Record<string, string> = {
      usersbycard: "Users by card fingerprint",
      chargesbycard: "Charges by card fingerprint",
    };
    return new ModalBuilder()
      .setCustomId(`billadmin_fp_modal:${action}`)
      .setTitle(titles[action] ?? "Card fingerprint")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("fingerprint", "Card fingerprint", {
            required: true,
            placeholder: "e.g. Xt5EWLLDS7FJjR1c",
          })
        )
      );
  }

  private buildLast4Modal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_last4_modal")
      .setTitle("Cards by last 4 digits")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("last4", "Last 4 digits", { required: true, placeholder: "4242", maxLength: 4 })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("brand", "Brand filter (optional)", {
            required: false,
            placeholder: "visa / mastercard / amex — narrows results",
          })
        )
      );
  }

  private buildRefundModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_refund_modal")
      .setTitle("Refund a charge")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("charge_id", "Charge ID", { required: true, placeholder: "ch_…" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("amount", "Amount (empty = full refund)", {
            required: false,
            placeholder: "e.g. 12.50 — in the charge's currency",
          })
        )
      );
  }

  private buildCancelModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_cancel_modal")
      .setTitle("Cancel a subscription")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("target_id", "Subscription or customer ID", { required: true, placeholder: "sub_… or cus_…" })
        )
      );
  }

  private buildEmailModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_email_modal")
      .setTitle("Find customer by email")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("email", "Email address (exact match)", { required: true, placeholder: "mail@example.com" })
        )
      );
  }

  private buildLinkModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_link_modal:${token}`)
      .setTitle("Link Stripe customer")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("customer_id", "Stripe customer ID", { required: true, placeholder: "cus_…" })
        )
      );
  }

  private buildEditDetailsModal(token: string, snap: NonNullable<BillAdminSession["custSnapshot"]>): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_edit_details_modal:${token}`)
      .setTitle("Edit customer details")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("name", "Name / company (empty = clear)", { required: false, value: snap.name })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("email", "Email (empty = clear)", { required: false, value: snap.email })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("phone", "Phone (empty = clear)", { required: false, value: snap.phone })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("description", "Description (empty = clear)", {
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
          this.textInput("line1", "Address line 1", { required: false, value: address?.line1 ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("line2", "Address line 2", { required: false, value: address?.line2 ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("city", "City", { required: false, value: address?.city ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("postal_code", "Postal code", { required: false, value: address?.postal_code ?? "" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("country", "Country (2-letter code, e.g. DE)", {
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
          this.textInput("type", "Type (eu_vat, gb_vat, ch_vat, us_ein, …)", {
            required: true,
            value: "eu_vat",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("value", "Value", { required: true, placeholder: "e.g. DE123456789" })
        )
      );
  }

  private buildPromoCheckModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_promo_check_modal")
      .setTitle("Check a promotion code")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("code", "Code or promo_… ID", { required: true, placeholder: "e.g. WELCOME50" })
        )
      );
  }

  private buildPromoCreateModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_promo_create_modal")
      .setTitle("Create a promotion code")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("coupon", "Coupon ID the code applies", {
            required: true,
            value: this.config.stripe.discountCouponId ?? "",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("code", "Code (empty = auto-generate)", { required: false, placeholder: "e.g. WELCOME50" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("max_redemptions", "Max redemptions (empty = unlimited)", {
            required: false,
            placeholder: "e.g. 100",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("expires_in_days", "Expires in days (empty = never)", {
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
          this.textInput("id", "Coupon ID (empty = auto-generate)", { required: false, placeholder: "e.g. SUMMER25" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("name", "Display name", { required: false, placeholder: "shown on invoices" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("percent_off", "Percent off (fill this OR amount)", { required: false, placeholder: "e.g. 25" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("amount_off", "Amount off + currency", { required: false, placeholder: "e.g. 12.50 eur" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("duration", "Duration: once / forever / repeating:N", {
            required: false,
            placeholder: "default: once — repeating:3 = 3 months",
          })
        )
      );
  }

  private buildCreateCustomerModal(): ModalBuilder {
    return new ModalBuilder()
      .setCustomId("billadmin_createcust_modal")
      .setTitle("Create a Stripe customer")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("email", "Email", { required: false, placeholder: "mail@example.com" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("name", "Name / company", { required: false })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          this.textInput("description", "Description", { required: false, style: TextInputStyle.Paragraph })
        )
      );
  }

  // ---- shared helpers ----

  private isTargetAction(action: string): action is TargetAction {
    return (TARGET_ACTIONS as readonly string[]).includes(action);
  }

  // promotion.coupon is expanded by StripeClient, but the API type still allows a
  // bare id string — normalize both shapes.
  private promoCoupon(promo: Stripe.PromotionCode): Stripe.Coupon | null {
    const coupon = promo.promotion?.coupon;
    return coupon && typeof coupon !== "string" ? coupon : null;
  }

  private promoCouponId(promo: Stripe.PromotionCode): string {
    const coupon = promo.promotion?.coupon;
    return typeof coupon === "string" ? coupon : coupon?.id ?? "—";
  }

  private async requireAdmin(interaction: AdminGateInteraction): Promise<boolean> {
    // memberPermissions is null in DMs, so DM use is implicitly rejected too.
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    await interaction
      .reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 })
      .catch(() => undefined);
    return false;
  }

  private newSession(interaction: { id: string; user: { id: string } }, data: Partial<BillAdminSession>): string {
    this.pruneSessions();
    this.sessions.set(interaction.id, {
      ownerUserId: interaction.user.id,
      createdAt: Date.now(),
      ...data,
    });
    return interaction.id;
  }

  private async getOwnedSession(
    token: string,
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<BillAdminSession | null> {
    const session = this.sessions.get(token);
    if (!session) {
      await interaction.reply({
        embeds: [makeEmbed("This /billing session has expired — run /billing again.", COLORS.warn)],
        flags: 64,
      });
      return null;
    }
    if (session.ownerUserId !== interaction.user.id) {
      await interaction.reply({
        embeds: [makeEmbed("Only the person who opened this panel can use it.", COLORS.danger)],
        flags: 64,
      });
      return null;
    }
    return session;
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(token);
    }
  }

  // For a modal launched from the panel message, deferUpdate keeps the whole flow
  // on that one message; the fallback covers modals whose message is gone.
  private async ackModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: 64 });
  }

  // Wraps post-defer work: Stripe/DB errors land as a danger embed instead of
  // the silent "interaction failed" Discord shows on an unhandled rejection.
  private async tryRender(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      console.error("Billing admin error:", error);
      await interaction
        .editReply({ embeds: [this.stripeErrorEmbed(error)], components: [this.backRow()] })
        .catch(() => undefined);
    }
  }

  private stripeErrorEmbed(error: unknown): EmbedBuilder {
    const msg = error instanceof Error ? error.message : String(error);
    return makeEmbed(`Stripe error: ${msg.slice(0, 500)}`, COLORS.danger);
  }

  private chargeLine(charge: Stripe.Charge, showCustomer: boolean): string {
    const parts = [
      `\`${charge.id}\``,
      `<t:${charge.created}:R>`,
      `**${this.stripeClient.formatAmount(charge.amount, charge.currency)}**`,
      charge.status,
    ];
    if (charge.amount_refunded > 0) {
      parts.push(
        charge.refunded
          ? "↩️ refunded"
          : `↩️ ${this.stripeClient.formatAmount(charge.amount_refunded, charge.currency)} refunded`
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

  private invoiceLine(invoice: Stripe.Invoice): string {
    const total = this.stripeClient.formatAmount(invoice.total, invoice.currency);
    const link = invoice.hosted_invoice_url ? ` · [open](${invoice.hosted_invoice_url})` : "";
    return `\`${invoice.number ?? invoice.id ?? "draft"}\` · ${invoice.status ?? "—"} · **${total}** · <t:${invoice.created}:D>${link}`;
  }

  private formatAddress(address: Stripe.Address | null | undefined): string {
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

  private btn(customId: string, label: string, style: ButtonStyle, disabled = false): ButtonBuilder {
    return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  }

  private buttonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons);
  }

  private selectRow(
    select: StringSelectMenuBuilder | UserSelectMenuBuilder
  ): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
  }

  // The delete confirm is reachable both from the customers hub (delcust) and
  // from inside the edit panel; the optional customer object enriches the former.
  private buildCustomerDeleteConfirm(token: string, customer?: Stripe.Customer): Panel {
    const session = this.sessions.get(token);
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
        this.buttonRow(
          this.btn(`billadmin_cust_delete_exec:${token}`, "Delete customer", ButtonStyle.Danger),
          this.btn(`billadmin_editcust_show:${token}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private backRow(target = "billadmin_root"): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return this.buttonRow(this.btn(target, "◀ Back", ButtonStyle.Secondary));
  }

  private promoBackRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
    return this.buttonRow(this.btn("billadmin_open:promo", "◀ Back", ButtonStyle.Secondary));
  }

  private textInput(
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
}
