import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { StripeClient } from "../../StripeClient";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { afterActionBack, backRow, btn, buttonRow, selectRow, textInput } from "../ui";
import type { Panel, RenderInteraction, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// Payments flows: customer balance adjustments (credits/debits), balance
// history, manual off-session charges, and the legacy payment-methods view
// (the "pm" op has no hub button anymore — the 360 and 💳 Cards cover it —
// but its routes stay registered so stale panels keep working).
//
// The hub PANEL itself lives in ui.ts buildHubPanel: the old 💰 Charges and
// 💸 Payments panels were merged into one "💰 Payments" panel, rendered for
// both billadmin_hub:charges and billadmin_hub:pay by the facade's prefix
// route. This hub keeps its own target-resolution flow (user pick / cus_ /
// email / Postiz id) because TargetResolver's TARGET_ACTIONS list is a shared
// file. Payments-specific flow state lives in a hub-private side map keyed by
// the shared session token, since BillAdminSession (types.ts) is shared too.

type PayOp = "pm" | "bal" | "hist" | "charge";

const PAY_OPS: readonly PayOp[] = ["pm", "bal", "hist", "charge"];

const PAY_TITLES: Record<PayOp, string> = {
  pm: "Payment methods of a user",
  bal: "Adjust customer balance",
  hist: "Customer balance history",
  charge: "Charge a saved card now",
};

interface PayFlow {
  op: PayOp;
  // Balance-history pager: forward-only cursor chain, ChargesHub pattern.
  cursors?: (string | undefined)[];
  // Adjust-balance state (amountMinor is the absolute value; signedMinor
  // carries the Stripe sign convention: negative = credit).
  kind?: "credit" | "debit";
  amountMinor?: number;
  signedMinor?: number;
  currency?: string;
  description?: string;
  // Prefill for the amount modals, learned from customer.currency.
  customerCurrency?: string;
  // Labels for the PM select so the confirm step can echo the picked card.
  pmLabels?: Map<string, string>;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const CURRENCY_RE = /^[a-zA-Z]{3}$/;

export class PaymentsHub {
  // Extra per-token state that doesn't fit the shared BillAdminSession. Entries
  // are dropped alongside their session (see newFlow's sweep).
  private flows = new Map<string, PayFlow>();

  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    // Hub panel buttons → target-resolution panel for the chosen operation.
    // (billadmin_hub:pay itself is served by the facade's prefix route via
    // buildHubPanel, which renders the merged 💰 Payments panel.)
    {
      kind: "button",
      id: "billadmin_pay_open:",
      match: "prefix",
      handler: async (interaction) => {
        const op = interaction.customId.split(":")[1] as PayOp;
        if (!PAY_OPS.includes(op)) return;
        await interaction.update(this.buildTargetPanel(op));
      },
    },
    {
      kind: "button",
      id: "billadmin_pay_manual:",
      match: "prefix",
      handler: async (interaction) => {
        const op = interaction.customId.split(":")[1] as PayOp;
        if (!PAY_OPS.includes(op)) return;
        await interaction.showModal(this.buildTargetModal(op));
      },
    },
    {
      kind: "userSelect",
      id: "billadmin_pay_user:",
      match: "prefix",
      handler: (interaction) => this.handleUserSelect(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_pay_target_modal:",
      match: "prefix",
      handler: (interaction) => this.handleTargetModal(interaction, interaction.customId.split(":")[1] as PayOp),
    },
    // Several customers matched an email / Postiz id — pick one.
    {
      kind: "select",
      id: "billadmin_pay_cuspick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        const flow = this.flows.get(token);
        if (!session || !flow) return;
        await interaction.deferUpdate();
        session.customerId = interaction.values[0];
        await this.ctx.sessions.tryRender(interaction, () => this.dispatchOp(interaction, token, flow.op));
      },
    },
    // ---- adjust balance ----
    {
      kind: "button",
      id: "billadmin_pay_bal_show:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderBalancePanel(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_pay_baladj:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, kind] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId || (kind !== "credit" && kind !== "debit")) return;
        await interaction.showModal(this.buildBalanceModal(token, kind));
      },
    },
    {
      kind: "modal",
      id: "billadmin_pay_bal_modal:",
      match: "prefix",
      handler: (interaction) => this.handleBalanceModal(interaction),
    },
    {
      kind: "button",
      id: "billadmin_pay_bal_exec:",
      match: "prefix",
      handler: (interaction) => this.executeBalanceAdjust(interaction, interaction.customId.split(":")[1]),
    },
    // ---- balance history ----
    {
      kind: "button",
      id: "billadmin_pay_histpage:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderHistoryPage(interaction, token, page));
      },
    },
    // ---- charge card now ----
    {
      kind: "button",
      id: "billadmin_pay_charge_amt:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.showModal(this.buildChargeModal(token));
      },
    },
    {
      kind: "modal",
      id: "billadmin_pay_charge_modal:",
      match: "prefix",
      handler: (interaction) => this.handleChargeModal(interaction),
    },
    {
      kind: "button",
      id: "billadmin_pay_charge_pms:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderChargePmSelect(interaction, token));
      },
    },
    {
      kind: "select",
      id: "billadmin_pay_pmpick:",
      match: "prefix",
      handler: (interaction) => this.handlePmPick(interaction),
    },
    {
      kind: "button",
      id: "billadmin_pay_charge_exec:",
      match: "prefix",
      handler: (interaction) => this.executeCharge(interaction, interaction.customId.split(":")[1]),
    },
  ];

  // ---- self-contained target resolution (mirrors TargetResolver's flow) ----

  private buildTargetPanel(op: PayOp, error?: string): Panel {
    const embed = new EmbedBuilder()
      .setTitle(PAY_TITLES[op])
      .setColor(error ? COLORS.warn : COLORS.brand)
      .setDescription(
        [
          error ? `⚠️ ${error}\n` : null,
          "Pick the Discord user, or enter a Stripe customer ID / email / Postiz user ID manually.",
        ]
          .filter(Boolean)
          .join("\n")
      );
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`billadmin_pay_user:${op}`)
      .setPlaceholder("Pick a Discord user");
    return {
      embeds: [embed],
      components: [
        selectRow(userSelect),
        buttonRow(
          btn(`billadmin_pay_manual:${op}`, "Enter cus_ / email / Postiz ID", ButtonStyle.Secondary),
          btn("billadmin_hub:pay", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private buildTargetModal(op: PayOp): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_pay_target_modal:${op}`)
      .setTitle(PAY_TITLES[op].slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("target", "Stripe cus_ ID, email, or Postiz user ID", {
            required: true,
            placeholder: "cus_… / mail@example.com / postiz id",
          })
        )
      );
  }

  private async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    const op = interaction.customId.split(":")[1] as PayOp;
    const pickedId = interaction.values[0];
    if (!PAY_OPS.includes(op) || !pickedId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const row = await this.ctx.sessionStore.getSession(pickedId);
      if (!row) {
        await interaction.editReply(
          this.buildTargetPanel(
            op,
            `<@${pickedId}> has no bot session — they've never logged in via **Start Here**. ` +
              `Use manual entry (cus_… / email) instead.`
          )
        );
        return;
      }
      if (!row.stripeCustomerId) {
        await interaction.editReply(
          this.buildTargetPanel(
            op,
            `<@${pickedId}> has a session but no linked Stripe customer. Link one via 👤 Customers → ` +
              `**Link / Unlink**, or use manual entry (cus_… / email).`
          )
        );
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { customerId: row.stripeCustomerId, originHub: "pay" });
      this.newFlow(token, op);
      await this.dispatchOp(interaction, token, op);
    });
  }

  private async handleTargetModal(interaction: ModalSubmitInteraction, op: PayOp): Promise<void> {
    if (!PAY_OPS.includes(op)) return;
    const target = interaction.fields.getTextInputValue("target").trim();
    if (!target) {
      await interaction.reply({
        embeds: [makeEmbed("Enter a Stripe customer ID, an email, or a Postiz user ID.", COLORS.danger)],
        flags: 64,
      });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      if (target.startsWith("cus_")) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: target, originHub: "pay" });
        this.newFlow(token, op);
        await this.dispatchOp(interaction, token, op);
        return;
      }

      if (target.includes("@")) {
        const customers = await this.ctx.stripe.findCustomersByEmail(target);
        if (customers.length === 0) {
          await interaction.editReply(this.buildTargetPanel(op, `No Stripe customer found for \`${target}\`.`));
          return;
        }
        if (customers.length === 1) {
          const token = this.ctx.sessions.newSession(interaction, { customerId: customers[0].id, originHub: "pay" });
          this.newFlow(token, op);
          await this.dispatchOp(interaction, token, op);
          return;
        }
        const token = this.ctx.sessions.newSession(interaction, { originHub: "pay" });
        this.newFlow(token, op);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`billadmin_pay_cuspick:${token}`)
          .setPlaceholder("Several customers matched — pick one")
          .addOptions(
            customers.slice(0, 25).map((c) => ({
              label: (c.email ?? c.id).slice(0, 100),
              description: `${c.name ?? "no name"} · ${c.id}`.slice(0, 100),
              value: c.id,
            }))
          );
        await interaction.editReply({
          embeds: [makeEmbed(`${customers.length} Stripe customers matched \`${target}\`.`, COLORS.brand)],
          components: [selectRow(select), backRow("billadmin_hub:pay")],
        });
        return;
      }

      // Anything else is treated as a Postiz user id, resolved through the bot DB.
      const discordIds = await this.ctx.sessionStore.findDiscordIdsByPostizId(target);
      const rows = await this.ctx.sessionStore.listByDiscordIds(discordIds);
      const stripeIds = [...new Set(rows.map((r) => r.stripeCustomerId).filter((v): v is string => !!v))];
      if (stripeIds.length === 0) {
        await interaction.editReply(
          this.buildTargetPanel(op, `No linked Stripe customer found for Postiz user \`${target}\`.`)
        );
        return;
      }
      if (stripeIds.length === 1) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: stripeIds[0], originHub: "pay" });
        this.newFlow(token, op);
        await this.dispatchOp(interaction, token, op);
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { originHub: "pay" });
      this.newFlow(token, op);
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_pay_cuspick:${token}`)
        .setPlaceholder("Several Stripe customers are linked — pick one")
        .addOptions(stripeIds.slice(0, 25).map((id) => ({ label: id, description: "via Postiz link", value: id })));
      await interaction.editReply({
        embeds: [makeEmbed(`Postiz user \`${target}\` maps to ${stripeIds.length} Stripe customers.`, COLORS.warn)],
        components: [selectRow(select), backRow("billadmin_hub:pay")],
      });
    });
  }

  // Runs once session.customerId is resolved; interaction is already deferred.
  private async dispatchOp(interaction: RenderInteraction, token: string, op: PayOp): Promise<void> {
    switch (op) {
      case "pm":
        await this.renderPaymentMethods(interaction, token);
        return;
      case "bal":
        await this.renderBalancePanel(interaction, token);
        return;
      case "hist": {
        const flow = this.flow(token);
        flow.cursors = [undefined];
        await this.renderHistoryPage(interaction, token, 0);
        return;
      }
      case "charge":
        await this.renderChargeStart(interaction, token);
        return;
    }
  }

  // ---- flow state ----

  private newFlow(token: string, op: PayOp): PayFlow {
    // Sweep entries whose session is gone (expired + pruned, or never ours).
    for (const staleToken of this.flows.keys()) {
      if (!this.ctx.sessions.get(staleToken)) this.flows.delete(staleToken);
    }
    const flow: PayFlow = { op };
    this.flows.set(token, flow);
    return flow;
  }

  private flow(token: string): PayFlow {
    return this.flows.get(token) ?? this.newFlow(token, "bal");
  }

  // ---- payment methods (read-only; management is the Cards hub's job) ----

  private async renderPaymentMethods(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customerId = session.customerId;

    const [paymentMethods, customer] = await Promise.all([
      this.ctx.stripe.listAllPaymentMethods(customerId),
      this.ctx.stripe.getCustomer(customerId),
    ]);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${customerId}\` (or deleted).`, COLORS.warn)],
        components: [backRow("billadmin_hub:pay")],
      });
      return;
    }
    const defaultPm = customer.invoice_settings?.default_payment_method;
    const defaultPmId = typeof defaultPm === "string" ? defaultPm : defaultPm?.id;

    const lines = paymentMethods.map(
      (pm) => `\`${pm.id}\` · ${this.pmLabel(pm)}${pm.id === defaultPmId ? " · ⭐ default" : ""}`
    );

    const embed = new EmbedBuilder()
      .setTitle(`Payment methods — \`${customerId}\``)
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096) || "No saved payment methods.")
      .setFooter({ text: "Read-only here — set default / detach via Manage in Cards hub" });

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          // Existing CardsHub route — the shared session token carries customerId.
          btn(`billadmin_cards_show:${token}`, "Manage in Cards hub", ButtonStyle.Primary),
          btn("billadmin_hub:pay", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private pmLabel(pm: Stripe.PaymentMethod): string {
    if (pm.card) {
      return `${pm.card.brand} •••• ${pm.card.last4} · exp ${pm.card.exp_month}/${pm.card.exp_year} · ${pm.card.funding}`;
    }
    return pm.type;
  }

  // ---- adjust balance ----

  private async renderBalancePanel(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customer = await this.ctx.stripe.getCustomer(session.customerId);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or deleted).`, COLORS.warn)],
        components: [backRow("billadmin_hub:pay")],
      });
      return;
    }
    const flow = this.flow(token);
    flow.customerCurrency = customer.currency ?? undefined;
    const displayCurrency = customer.currency ?? "usd";
    const balance = customer.balance ?? 0;

    const embed = new EmbedBuilder()
      .setTitle(`Customer balance — \`${customer.id}\``)
      .setColor(COLORS.brand)
      .setDescription(
        [
          notice,
          `Current balance: **${this.ctx.stripe.formatAmount(balance, displayCurrency)}**` +
            (customer.currency ? "" : " *(customer has no settled currency yet — shown as USD)*"),
          "",
          "ℹ️ **Negative balance = credit** — automatically applied to (reduces) future invoices.",
          "**Positive balance = debit** — added on top of future invoices.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n")
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_pay_baladj:${token}:credit`, "Grant credit", ButtonStyle.Success),
          btn(`billadmin_pay_baladj:${token}:debit`, "Add debit", ButtonStyle.Danger),
          btn("billadmin_hub:pay", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private buildBalanceModal(token: string, kind: "credit" | "debit"): ModalBuilder {
    const flow = this.flows.get(token);
    return new ModalBuilder()
      .setCustomId(`billadmin_pay_bal_modal:${token}:${kind}`)
      .setTitle(kind === "credit" ? "Grant credit" : "Add debit")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", "Amount (positive, e.g. 12.50)", { required: true, placeholder: "12.50" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("currency", "Currency (3-letter code)", {
            required: true,
            placeholder: "eur / usd",
            value: flow?.customerCurrency,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("description", "Description (shows on the balance history)", {
            required: true,
            placeholder: "e.g. goodwill credit for the March outage",
            maxLength: 350,
          })
        )
      );
  }

  private async handleBalanceModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [, token, kindRaw] = interaction.customId.split(":");
    const kind = kindRaw === "credit" ? "credit" : "debit";
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    const currency = interaction.fields.getTextInputValue("currency").trim().toLowerCase();
    const description = interaction.fields.getTextInputValue("description").trim();

    const validationError = this.validateAmount(amountRaw, currency);
    if (validationError) {
      await interaction.reply({ embeds: [makeEmbed(validationError, COLORS.danger)], flags: 64 });
      return;
    }
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const customer = await this.ctx.stripe.getCustomer(session.customerId!);
      if (!customer) {
        await interaction.editReply({
          embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or deleted).`, COLORS.warn)],
          components: [backRow("billadmin_hub:pay")],
        });
        return;
      }
      // Pre-flight: Stripe rejects balance transactions in any currency other
      // than the customer's settled currency — catch it with a clear message.
      if (customer.currency && customer.currency.toLowerCase() !== currency) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `This customer's currency is \`${customer.currency}\` — balance adjustments must use it. ` +
                `You entered \`${currency}\`. Stripe would reject the transaction.`,
              COLORS.danger
            ),
          ],
          components: [buttonRow(btn(`billadmin_pay_bal_show:${token}`, "◀ Back", ButtonStyle.Secondary))],
        });
        return;
      }

      const amountMinor = this.toMinor(amountRaw, currency);
      const flow = this.flow(token);
      flow.kind = kind;
      flow.amountMinor = amountMinor;
      // Stripe sign convention: NEGATIVE = credit, POSITIVE = debit.
      flow.signedMinor = kind === "credit" ? -amountMinor : amountMinor;
      flow.currency = currency;
      flow.description = description;

      const fmt = this.ctx.stripe.formatAmount(amountMinor, currency);
      const effect =
        kind === "credit"
          ? `Grants a **${fmt}** credit — applied automatically to future invoices.`
          : `Adds a **${fmt}** debit — the customer owes this on top of future invoices.`;

      const embed = new EmbedBuilder()
        .setTitle(kind === "credit" ? "Confirm credit" : "Confirm debit")
        .setColor(COLORS.danger)
        .setDescription(effect)
        .addFields(
          { name: "Customer", value: `\`${customer.id}\``, inline: true },
          { name: "Current balance", value: this.ctx.stripe.formatAmount(customer.balance ?? 0, currency), inline: true },
          {
            name: "Balance after",
            value: this.ctx.stripe.formatAmount((customer.balance ?? 0) + flow.signedMinor, currency),
            inline: true,
          },
          { name: "Description", value: description.slice(0, 1024), inline: false }
        );

      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`billadmin_pay_bal_exec:${token}`, kind === "credit" ? "Grant credit" : "Add debit", ButtonStyle.Danger),
            btn(`billadmin_pay_bal_show:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private async executeBalanceAdjust(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const flow = this.flows.get(token);
    if (!session?.customerId || flow?.signedMinor == null || !flow.currency || !flow.description) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.runExclusive(token, interaction, async () => {
      const kind = flow.kind ?? "credit";
      const fmt = this.ctx.stripe.formatAmount(flow.amountMinor ?? Math.abs(flow.signedMinor!), flow.currency!);
      const actionName = kind === "credit" ? "Adjust balance — grant credit" : "Adjust balance — add debit";

      let txn: Stripe.CustomerBalanceTransaction;
      try {
        txn = await this.ctx.stripe.adjustCustomerBalance(
          session.customerId!,
          flow.signedMinor!,
          flow.currency!,
          flow.description!,
          `billadmin-pay-baladj-${interaction.id}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: actionName,
          targetCustomerId: session.customerId,
          amountText: `${fmt} (${kind})`,
          outcome: `Failed — ${msg.slice(0, 500)}`,
          severity: "danger",
        });
        await interaction.editReply({
          embeds: [makeEmbed(`Balance adjustment failed: ${msg.slice(0, 500)}`, COLORS.danger)],
          components: [
            buttonRow(
              btn(`billadmin_pay_bal_show:${token}`, "◀ Back to balance", ButtonStyle.Secondary),
              btn("billadmin_hub:pay", "Payments hub", ButtonStyle.Secondary)
            ),
          ],
        });
        return;
      }

      this.ctx.audit.log(interaction, {
        action: actionName,
        targetCustomerId: session.customerId,
        objectId: txn.id,
        amountText: `${fmt} (${kind})`,
        outcome: `Success — new balance ${this.ctx.stripe.formatAmount(txn.ending_balance, txn.currency)}`,
        severity: kind === "debit" ? "warn" : "success",
      });

      await this.renderBalancePanel(
        interaction,
        token,
        `✅ ${kind === "credit" ? "Credited" : "Debited"} **${fmt}** — transaction \`${txn.id}\`.\n`
      );
    });
  }

  // ---- balance history ----

  private async renderHistoryPage(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const flow = this.flow(token);
    if (!flow.cursors) flow.cursors = [undefined];

    const res = await this.ctx.stripe.listBalanceTransactions(session.customerId, 10, flow.cursors[page]);
    const last = res.data[res.data.length - 1];
    if (res.has_more && last) flow.cursors[page + 1] = last.id;

    const lines = res.data.map((t) => {
      const sign = t.amount < 0 ? "🟢 credit" : "🔴 debit";
      return (
        `**${this.ctx.stripe.formatAmount(t.amount, t.currency)}** · ${sign} · ` +
        `${(t.description ?? t.type).slice(0, 80)} · <t:${t.created}:D> · ` +
        `ending ${this.ctx.stripe.formatAmount(t.ending_balance, t.currency)}`
      );
    });

    const embed = new EmbedBuilder()
      .setTitle(`Balance history — \`${session.customerId}\``)
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n").slice(0, 4096) || "No balance transactions.")
      .setFooter({ text: `Page ${page + 1} · negative = credit, positive = debit` });

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_pay_histpage:${token}:${page - 1}`, "◀ Prev", ButtonStyle.Secondary, page <= 0),
          btn(`billadmin_pay_histpage:${token}:${page + 1}`, "Next ▶", ButtonStyle.Secondary, !res.has_more),
          btn("billadmin_hub:pay", "Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  // ---- charge card now ----

  private async renderChargeStart(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const customer = await this.ctx.stripe.getCustomer(session.customerId);
    if (!customer) {
      await interaction.editReply({
        embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or deleted).`, COLORS.warn)],
        components: [backRow("billadmin_hub:pay")],
      });
      return;
    }
    const flow = this.flow(token);
    flow.customerCurrency = customer.currency ?? undefined;

    const embed = new EmbedBuilder()
      .setTitle(`Charge card now — \`${customer.id}\``)
      .setColor(COLORS.warn)
      .setDescription(
        [
          customer.email ? `Customer: ${customer.email}` : null,
          "",
          "⚡ This creates an **off-session** PaymentIntent: the saved card is charged immediately, " +
            "with no customer-present authentication step. If the bank requires 3DS the charge fails.",
        ]
          .filter((line): line is string => line !== null)
          .join("\n")
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_pay_charge_amt:${token}`, "Enter amount", ButtonStyle.Primary),
          btn("billadmin_hub:pay", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private buildChargeModal(token: string): ModalBuilder {
    const flow = this.flows.get(token);
    return new ModalBuilder()
      .setCustomId(`billadmin_pay_charge_modal:${token}`)
      .setTitle("Charge card now")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", "Amount (e.g. 12.50)", { required: true, placeholder: "12.50" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("currency", "Currency (3-letter code)", {
            required: true,
            placeholder: "eur / usd",
            value: flow?.customerCurrency,
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("description", "Description (shows on the charge)", {
            required: true,
            placeholder: "e.g. manual charge for plan upgrade",
            maxLength: 350,
          })
        )
      );
  }

  private async handleChargeModal(interaction: ModalSubmitInteraction): Promise<void> {
    const token = interaction.customId.split(":")[1];
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    const currency = interaction.fields.getTextInputValue("currency").trim().toLowerCase();
    const description = interaction.fields.getTextInputValue("description").trim();

    const validationError = this.validateAmount(amountRaw, currency);
    if (validationError) {
      await interaction.reply({ embeds: [makeEmbed(validationError, COLORS.danger)], flags: 64 });
      return;
    }
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    if (!session?.customerId) return;

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      const flow = this.flow(token);
      flow.amountMinor = this.toMinor(amountRaw, currency);
      flow.currency = currency;
      flow.description = description;
      await this.renderChargePmSelect(interaction, token);
    });
  }

  private async renderChargePmSelect(interaction: RenderInteraction, token: string): Promise<void> {
    const session = this.ctx.sessions.get(token);
    const flow = this.flows.get(token);
    if (!session?.customerId || flow?.amountMinor == null || !flow.currency) return;

    const [paymentMethods, customer] = await Promise.all([
      this.ctx.stripe.listAllPaymentMethods(session.customerId),
      this.ctx.stripe.getCustomer(session.customerId),
    ]);
    if (paymentMethods.length === 0) {
      await interaction.editReply({
        embeds: [
          makeEmbed(
            `\`${session.customerId}\` has no saved payment methods — nothing to charge off-session. ` +
              "Send an invoice by email instead (Invoices hub).",
            COLORS.warn
          ),
        ],
        components: [backRow("billadmin_hub:pay")],
      });
      return;
    }
    const defaultPm = customer?.invoice_settings?.default_payment_method;
    const defaultPmId = typeof defaultPm === "string" ? defaultPm : defaultPm?.id;

    flow.pmLabels = new Map(paymentMethods.map((pm) => [pm.id, this.pmLabel(pm)]));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_pay_pmpick:${token}`)
      .setPlaceholder("Pick the payment method to charge")
      .addOptions(
        paymentMethods.slice(0, 25).map((pm) => ({
          label: `${this.pmLabel(pm)}${pm.id === defaultPmId ? " · ⭐ default" : ""}`.slice(0, 100),
          description: pm.id.slice(0, 100),
          value: pm.id,
          default: pm.id === defaultPmId,
        }))
      );

    const embed = new EmbedBuilder()
      .setTitle(`Charge ${this.ctx.stripe.formatAmount(flow.amountMinor, flow.currency)} — pick a card`)
      .setColor(COLORS.warn)
      .setDescription(
        `Customer \`${session.customerId}\` · ${flow.description ?? "no description"}\n` +
          "The ⭐ default payment method is preselected."
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        selectRow(select),
        buttonRow(
          btn(`billadmin_pay_charge_amt:${token}`, "Change amount", ButtonStyle.Secondary),
          btn("billadmin_hub:pay", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async handlePmPick(interaction: StringSelectMenuInteraction): Promise<void> {
    const token = interaction.customId.split(":")[1];
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const flow = this.flows.get(token);
    if (!session?.customerId || flow?.amountMinor == null || !flow.currency) return;
    await interaction.deferUpdate();
    session.paymentMethodId = interaction.values[0];
    await this.ctx.sessions.tryRender(interaction, async () => {
      const fmt = this.ctx.stripe.formatAmount(flow.amountMinor!, flow.currency!);
      const pmLabel = flow.pmLabels?.get(session.paymentMethodId!) ?? session.paymentMethodId!;

      const embed = new EmbedBuilder()
        .setTitle("Confirm manual charge")
        .setColor(COLORS.danger)
        .setDescription(
          `⚡ Charges **${fmt}** to **${pmLabel}** **immediately, off-session** — no 3DS/authentication ` +
            "step is possible. If the bank requires authentication the charge fails."
        )
        .addFields(
          { name: "Customer", value: `\`${session.customerId}\``, inline: true },
          { name: "Payment method", value: `\`${session.paymentMethodId}\``, inline: true },
          { name: "Amount", value: fmt, inline: true },
          { name: "Description", value: (flow.description ?? "—").slice(0, 1024), inline: false }
        );

      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`billadmin_pay_charge_exec:${token}`, "Charge now", ButtonStyle.Danger),
            btn(`billadmin_pay_charge_pms:${token}`, "◀ Back", ButtonStyle.Secondary),
            btn("billadmin_hub:pay", "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private async executeCharge(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const flow = this.flows.get(token);
    if (!session?.customerId || !session.paymentMethodId || flow?.amountMinor == null || !flow.currency) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.runExclusive(token, interaction, async () => {
      const fmt = this.ctx.stripe.formatAmount(flow.amountMinor!, flow.currency!);

      let pi: Stripe.PaymentIntent;
      try {
        pi = await this.ctx.stripe.createManualPaymentIntent(
          {
            customerId: session.customerId!,
            amountMinor: flow.amountMinor!,
            currency: flow.currency!,
            paymentMethodId: session.paymentMethodId!,
            description: flow.description,
          },
          `billadmin-pay-charge-${interaction.id}`
        );
      } catch (error) {
        // Stripe card errors expose code + decline_code; surface both.
        const err = error as { code?: string; decline_code?: string; message?: string };
        const code = err.decline_code ?? err.code ?? "unknown";
        const msg = err.message ?? String(error);
        this.ctx.audit.log(interaction, {
          action: "Manual off-session charge",
          targetCustomerId: session.customerId,
          objectId: session.paymentMethodId,
          amountText: fmt,
          outcome: `Failed — ${code}: ${msg.slice(0, 400)}`,
          severity: "danger",
        });
        const needs3ds = err.code === "authentication_required" || err.decline_code === "authentication_required";
        const hint = needs3ds
          ? "\n💡 card requires 3DS — send an invoice by email instead (Invoices hub)."
          : "";
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `❌ Charge failed — decline code \`${code}\`.\n${msg.slice(0, 500)}${hint}`,
              COLORS.danger
            ),
          ],
          components: [
            buttonRow(
              btn(`billadmin_pay_charge_pms:${token}`, "Try another card", ButtonStyle.Primary),
              btn("billadmin_hub:pay", "◀ Back", ButtonStyle.Secondary)
            ),
          ],
        });
        return;
      }

      this.ctx.audit.log(interaction, {
        action: "Manual off-session charge",
        targetCustomerId: session.customerId,
        objectId: pi.id,
        amountText: fmt,
        outcome: `PaymentIntent \`${pi.id}\` — ${pi.status}`,
        severity: "success",
      });

      const statusNote = pi.status === "succeeded" ? "" : `\nℹ️ Status: \`${pi.status}\` — not final yet, check Stripe.`;
      await interaction.editReply({
        embeds: [
          makeEmbed(
            `✅ Charged **${fmt}** on \`${session.customerId}\` — PaymentIntent \`${pi.id}\` (${pi.status}).${statusNote}`,
            COLORS.success
          ),
        ],
        components: [backRow(afterActionBack(session, token, "pay"))],
      });
    });
  }

  // ---- amount parsing ----

  private validateAmount(amountRaw: string, currency: string): string | null {
    if (!CURRENCY_RE.test(currency)) return "Currency must be a 3-letter code like `eur` or `usd`.";
    if (!AMOUNT_RE.test(amountRaw)) return "Amount must be a positive number like `12.50`.";
    if (StripeClient.isZeroDecimal(currency) && amountRaw.includes(".")) {
      return `\`${currency}\` is a zero-decimal currency — whole amounts only.`;
    }
    const minor = this.toMinor(amountRaw, currency);
    if (minor <= 0) return "Amount must be greater than zero.";
    if (minor > 99_999_999) return "Amount is too large (Stripe caps charges at 8 digits in minor units).";
    return null;
  }

  private toMinor(amountRaw: string, currency: string): number {
    return StripeClient.isZeroDecimal(currency)
      ? Number.parseInt(amountRaw, 10)
      : Math.round(Number.parseFloat(amountRaw) * 100);
  }
}
