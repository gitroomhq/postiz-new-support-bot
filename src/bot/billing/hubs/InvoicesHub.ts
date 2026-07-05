import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { StripeClient } from "../../StripeClient";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { backRow, btn, buttonRow, invoiceLine, selectRow, textInput } from "../ui";
import { SESSION_TTL_MS, type Panel, type RenderInteraction, type RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// Entry modes of the hub: list all invoices, list open invoices, or build a
// one-off invoice. Carried in custom ids until a customer is resolved.
type InvMode = "user" | "open" | "oneoff";

const MODE_TITLES: Record<InvMode, string> = {
  user: "Invoices for a user",
  open: "Open invoices for a user",
  oneoff: "Create one-off invoice",
};

const CN_REASONS = ["duplicate", "fraudulent", "order_change", "product_unsatisfactory"] as const;

// Invoice-specific per-token state. BillAdminSession has no invoice fields (a
// shared-types change is out of scope here), so the hub keeps its own map keyed
// by the same session token; entries are pruned with the same sliding TTL.
interface InvState {
  createdAt: number;
  mode: InvMode;
  listStatus?: "open"; // undefined = all statuses
  invoiceId?: string;
  // Credit note flow (paid invoices).
  cnCurrency?: string;
  cnMaxMinor?: number;
  cnAmountMinor?: number;
  cnMemo?: string;
  cnMode?: "refund" | "credit";
  cnReason?: Stripe.CreditNoteCreateParams.Reason;
  // One-off invoice draft.
  draftId?: string;
}

// Invoices hub: per-customer invoice lists, a status-contextual invoice detail
// panel (finalize/send/pay/void/uncollectible/credit note) and a one-off
// draft-invoice builder. All custom ids are namespaced billadmin_inv_*.
export class InvoicesHub {
  constructor(private ctx: HubContext) {}

  private state = new Map<string, InvState>();

  // ---- state helpers ----

  private getState(token: string): InvState {
    let s = this.state.get(token);
    if (!s) {
      s = { createdAt: Date.now(), mode: "user" };
      this.state.set(token, s);
    }
    s.createdAt = Date.now();
    return s;
  }

  private setState(token: string, data: Omit<InvState, "createdAt">): InvState {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [key, value] of this.state) {
      if (value.createdAt < cutoff) this.state.delete(key);
    }
    const s: InvState = { createdAt: Date.now(), ...data };
    this.state.set(token, s);
    return s;
  }

  private fmt(amount: number, currency: string): string {
    return this.ctx.stripe.formatAmount(amount, currency);
  }

  // "12.50" → minor units in the given currency (whole numbers only for
  // zero-decimal currencies) — same idiom as the ChargesHub refund parser.
  private parseMinor(raw: string, currency: string): { ok: true; minor: number } | { ok: false; error: string } {
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      return { ok: false, error: "Amount must be a number like `12.50`." };
    }
    if (StripeClient.isZeroDecimal(currency)) {
      if (raw.includes(".")) {
        return { ok: false, error: `\`${currency}\` is a zero-decimal currency — whole amounts only.` };
      }
      return { ok: true, minor: Number.parseInt(raw, 10) };
    }
    return { ok: true, minor: Math.round(Number.parseFloat(raw) * 100) };
  }

  // ---- routes ----

  readonly routes: RouteEntry[] = [
    // Exact id beats the facade's billadmin_hub: prefix route, so the hub's
    // real panel renders without a facade change.
    {
      kind: "button",
      id: "billadmin_hub:invoices",
      match: "exact",
      handler: async (interaction) => {
        await interaction.update(this.buildPanel());
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_open:",
      match: "prefix",
      handler: async (interaction) => {
        const mode = interaction.customId.split(":")[1] as InvMode;
        await interaction.update(this.buildTargetPanel(mode));
      },
    },
    {
      kind: "userSelect",
      id: "billadmin_inv_user:",
      match: "prefix",
      handler: (interaction) => this.handleUserSelect(interaction),
    },
    {
      kind: "button",
      id: "billadmin_inv_manual:",
      match: "prefix",
      handler: async (interaction) => {
        const mode = interaction.customId.split(":")[1] as InvMode;
        await interaction.showModal(this.buildTargetModal(mode));
      },
    },
    {
      kind: "modal",
      id: "billadmin_inv_target:",
      match: "prefix",
      handler: (interaction) => this.handleTargetModal(interaction, interaction.customId.split(":")[1] as InvMode),
    },
    {
      kind: "select",
      id: "billadmin_inv_cuspick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        session.customerId = interaction.values[0];
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () =>
          this.startForCustomer(interaction, token, this.getState(token).mode)
        );
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_page:",
      match: "prefix",
      handler: async (interaction) => {
        const [, token, pageStr] = interaction.customId.split(":");
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        const page = Math.max(0, Number.parseInt(pageStr, 10) || 0);
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderList(interaction, token, page));
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_list:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        session.cursors = [undefined];
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderList(interaction, token, 0));
      },
    },
    {
      kind: "select",
      id: "billadmin_inv_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        this.getState(token).invoiceId = interaction.values[0];
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_det:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderDetail(interaction, token));
      },
    },

    // ---- detail actions ----
    {
      kind: "button",
      id: "billadmin_inv_fin:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Finalize invoice",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.finalizeInvoice(invoiceId, `billadmin-inv-fin-${interaction.id}`);
            return {
              outcome: `Finalized as \`${inv.number ?? inv.id}\` (${inv.status ?? "open"})`,
              notice: "✅ Invoice finalized.",
              amountText: this.fmt(inv.total, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_finsend:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Finalize & send invoice",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.finalizeInvoice(invoiceId, `billadmin-inv-fin-${interaction.id}`);
            await this.ctx.stripe.sendInvoice(invoiceId, `billadmin-inv-send-${interaction.id}`);
            return {
              outcome: `Finalized as \`${inv.number ?? inv.id}\` and emailed to the customer`,
              notice: "✅ Invoice finalized and emailed to the customer.",
              amountText: this.fmt(inv.total, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_resend:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Resend invoice email",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.sendInvoice(invoiceId, `billadmin-inv-send-${interaction.id}`);
            return {
              outcome: `Invoice email re-sent for \`${inv.number ?? inv.id}\``,
              notice: "📧 Invoice email sent.",
              amountText: this.fmt(inv.total, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_pay:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Pay invoice now",
          auditFailure: true,
          hint: "If the customer has no chargeable default payment method, use **Resend email** so they can pay online.",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.payInvoice(invoiceId, `billadmin-inv-pay-${interaction.id}`);
            return {
              outcome: `Charged the default payment method — status ${inv.status ?? "paid"}`,
              notice: "💳 Payment attempted against the default payment method.",
              amountText: this.fmt(inv.amount_paid, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_void:",
      match: "prefix",
      handler: (interaction) =>
        this.renderConfirm(interaction, interaction.customId.split(":")[1], {
          title: "Void invoice?",
          warning:
            "Voiding **cannot be undone** — the invoice is treated as zero and can never be paid. " +
            "Amounts already paid are NOT refunded (use a credit note for that).",
          confirmId: "billadmin_inv_void_go",
          confirmLabel: "Void invoice",
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_void_go:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Void invoice",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.voidInvoice(invoiceId, `billadmin-inv-void-${interaction.id}`);
            return {
              outcome: `Voided \`${inv.number ?? inv.id}\``,
              notice: "🗑️ Invoice voided.",
              amountText: this.fmt(inv.total, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_uncol:",
      match: "prefix",
      handler: (interaction) =>
        this.renderConfirm(interaction, interaction.customId.split(":")[1], {
          title: "Mark invoice uncollectible?",
          warning:
            "Marks the invoice as bad debt for accounting purposes. " +
            "The customer can still pay it later via the hosted invoice page.",
          confirmId: "billadmin_inv_uncol_go",
          confirmLabel: "Mark uncollectible",
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_uncol_go:",
      match: "prefix",
      handler: (interaction) =>
        this.execDetailOp(interaction, interaction.customId.split(":")[1], {
          action: "Mark invoice uncollectible",
          work: async (invoiceId) => {
            const inv = await this.ctx.stripe.markInvoiceUncollectible(invoiceId, `billadmin-inv-uncol-${interaction.id}`);
            return {
              outcome: `Marked \`${inv.number ?? inv.id}\` uncollectible`,
              notice: "🏷️ Invoice marked uncollectible.",
              amountText: this.fmt(inv.total, inv.currency),
            };
          },
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_deldraft:",
      match: "prefix",
      handler: (interaction) =>
        this.renderConfirm(interaction, interaction.customId.split(":")[1], {
          title: "Delete draft invoice?",
          warning: "Deletes the draft and every line item attached to it. This cannot be undone.",
          confirmId: "billadmin_inv_deldraft_go",
          confirmLabel: "Delete draft",
        }),
    },
    {
      kind: "button",
      id: "billadmin_inv_deldraft_go:",
      match: "prefix",
      handler: (interaction) => this.executeDeleteDraft(interaction, interaction.customId.split(":")[1], "list"),
    },

    // ---- credit note flow ----
    {
      kind: "button",
      id: "billadmin_inv_cn:",
      match: "prefix",
      handler: (interaction) => this.startCreditNote(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "button",
      id: "billadmin_inv_cn_full:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        const state = this.getState(token);
        if (!session || state.cnMaxMinor == null) return;
        state.cnAmountMinor = state.cnMaxMinor;
        state.cnMemo = undefined;
        await interaction.update(this.buildCnModePanel(token, state));
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_cn_partial:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        const state = this.getState(token);
        if (!session || !state.cnCurrency) return;
        await interaction.showModal(this.buildCnModal(token, state.cnCurrency));
      },
    },
    {
      kind: "modal",
      id: "billadmin_inv_cn_modal:",
      match: "prefix",
      handler: (interaction) => this.handleCnModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "select",
      id: "billadmin_inv_cn_reason:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        const state = this.getState(token);
        if (!session || state.cnAmountMinor == null) return;
        const value = interaction.values[0];
        state.cnReason = (CN_REASONS as readonly string[]).includes(value)
          ? (value as Stripe.CreditNoteCreateParams.Reason)
          : undefined;
        await interaction.update(this.buildCnModePanel(token, state));
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_cn_mode:",
      match: "prefix",
      handler: (interaction) => {
        const [, mode, token] = interaction.customId.split(":");
        return this.previewCn(interaction, token, mode === "credit" ? "credit" : "refund");
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_cn_go:",
      match: "prefix",
      handler: (interaction) => this.executeCn(interaction, interaction.customId.split(":")[1]),
    },

    // ---- one-off invoice flow ----
    {
      kind: "button",
      id: "billadmin_inv_item:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session?.customerId) return;
        await interaction.showModal(this.buildItemModal(token));
      },
    },
    {
      kind: "modal",
      id: "billadmin_inv_item_modal:",
      match: "prefix",
      handler: (interaction) => this.handleItemModal(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "button",
      id: "billadmin_inv_draft:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        await this.ctx.sessions.tryRender(interaction, () => this.renderDraft(interaction, token));
      },
    },
    {
      kind: "button",
      id: "billadmin_inv_dr_email:",
      match: "prefix",
      handler: (interaction) => this.finalizeDraft(interaction, interaction.customId.split(":")[1], "email"),
    },
    {
      kind: "button",
      id: "billadmin_inv_dr_charge:",
      match: "prefix",
      handler: (interaction) => this.finalizeDraft(interaction, interaction.customId.split(":")[1], "charge"),
    },
    {
      kind: "button",
      id: "billadmin_inv_dr_disc:",
      match: "prefix",
      handler: (interaction) => this.confirmDiscardDraft(interaction, interaction.customId.split(":")[1]),
    },
    {
      kind: "button",
      id: "billadmin_inv_dr_disc_go:",
      match: "prefix",
      handler: (interaction) => this.executeDeleteDraft(interaction, interaction.customId.split(":")[1], "hub"),
    },
  ];

  // ---- hub panel ----

  buildPanel(): Panel {
    const embed = new EmbedBuilder()
      .setTitle("🧾 Invoices")
      .setColor(COLORS.brand)
      .setDescription(
        [
          "**Read** — a user's invoice history, or just their open (unpaid) invoices.",
          "**Manage** — pick an invoice to finalize, resend, collect, void, mark uncollectible or credit-note it.",
          "**Create** — build a one-off invoice from ad-hoc line items and email it or charge it now.",
        ].join("\n")
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_inv_open:user", "Invoices for User", ButtonStyle.Primary),
          btn("billadmin_inv_open:open", "Open Invoices", ButtonStyle.Primary),
          btn("billadmin_inv_open:oneoff", "Create One-off Invoice", ButtonStyle.Success)
        ),
        backRow(),
      ],
    };
  }

  // ---- self-contained customer resolution (mirrors TargetResolver's flow;
  // the resolver itself is shared and can't grow invoice modes in this step) ----

  private buildTargetPanel(mode: InvMode, error?: string): Panel {
    const embed = new EmbedBuilder()
      .setTitle(MODE_TITLES[mode] ?? MODE_TITLES.user)
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
      .setCustomId(`billadmin_inv_user:${mode}`)
      .setPlaceholder("Pick a Discord user");
    return {
      embeds: [embed],
      components: [
        selectRow(userSelect),
        buttonRow(
          btn(`billadmin_inv_manual:${mode}`, "Enter cus_ / email / Postiz ID", ButtonStyle.Secondary),
          btn("billadmin_hub:invoices", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private buildTargetModal(mode: InvMode): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_inv_target:${mode}`)
      .setTitle((MODE_TITLES[mode] ?? MODE_TITLES.user).slice(0, 45))
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
    const mode = interaction.customId.split(":")[1] as InvMode;
    const pickedId = interaction.values[0];
    if (!pickedId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const row = await this.ctx.sessionStore.getSession(pickedId);
      if (!row) {
        await interaction.editReply(
          this.buildTargetPanel(
            mode,
            `<@${pickedId}> has no bot session — they've never logged in via **Start Here**. ` +
              `Use manual entry (cus_… / email) instead.`
          )
        );
        return;
      }
      if (!row.stripeCustomerId) {
        await interaction.editReply(
          this.buildTargetPanel(
            mode,
            `<@${pickedId}> has a session but no linked Stripe customer. Link one via ` +
              `👤 Customers → **Link / Unlink**, or use manual entry (cus_… / email).`
          )
        );
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { customerId: row.stripeCustomerId });
      this.setState(token, { mode });
      await this.startForCustomer(interaction, token, mode);
    });
  }

  private async handleTargetModal(interaction: ModalSubmitInteraction, mode: InvMode): Promise<void> {
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
        const token = this.ctx.sessions.newSession(interaction, { customerId: target });
        this.setState(token, { mode });
        await this.startForCustomer(interaction, token, mode);
        return;
      }

      let candidateIds: string[];
      let sourceLabel: string;
      if (target.includes("@")) {
        const customers = await this.ctx.stripe.findCustomersByEmail(target);
        candidateIds = customers.map((c) => c.id);
        sourceLabel = `\`${target}\``;
      } else {
        // Anything else is treated as a Postiz user id, resolved via the bot DB.
        const discordIds = await this.ctx.sessionStore.findDiscordIdsByPostizId(target);
        const rows = await this.ctx.sessionStore.listByDiscordIds(discordIds);
        candidateIds = [...new Set(rows.map((r) => r.stripeCustomerId).filter((v): v is string => !!v))];
        sourceLabel = `Postiz user \`${target}\``;
      }

      if (candidateIds.length === 0) {
        await interaction.editReply(this.buildTargetPanel(mode, `No Stripe customer found for ${sourceLabel}.`));
        return;
      }
      if (candidateIds.length === 1) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: candidateIds[0] });
        this.setState(token, { mode });
        await this.startForCustomer(interaction, token, mode);
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, {});
      this.setState(token, { mode });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_inv_cuspick:${token}`)
        .setPlaceholder("Several Stripe customers matched — pick one")
        .addOptions(candidateIds.slice(0, 25).map((id) => ({ label: id.slice(0, 100), value: id })));
      await interaction.editReply({
        embeds: [makeEmbed(`${sourceLabel} maps to ${candidateIds.length} Stripe customers.`, COLORS.warn)],
        components: [selectRow(select), backRow("billadmin_hub:invoices")],
      });
    });
  }

  private async startForCustomer(interaction: RenderInteraction, token: string, mode: InvMode): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session?.customerId) return;
    const state = this.getState(token);
    state.mode = mode;
    if (mode === "oneoff") {
      await interaction.editReply(this.buildOneoffStartPanel(token, session.customerId));
      return;
    }
    state.listStatus = mode === "open" ? "open" : undefined;
    session.cursors = [undefined];
    await this.renderList(interaction, token, 0);
  }

  // ---- invoice list ----

  private async renderList(interaction: RenderInteraction, token: string, page: number): Promise<void> {
    const session = this.ctx.sessions.get(token);
    const state = this.getState(token);
    if (!session?.customerId) return;
    if (!session.cursors) session.cursors = [undefined];

    const res = await this.ctx.stripe.listInvoicesByStatus(
      session.customerId,
      state.listStatus,
      10,
      session.cursors[page]
    );
    const invoices = res.data;
    const last = invoices[invoices.length - 1];
    if (res.has_more && last?.id) session.cursors[page + 1] = last.id;

    const embed = new EmbedBuilder()
      .setTitle(`${state.listStatus === "open" ? "Open invoices" : "Invoices"} — \`${session.customerId}\``)
      .setColor(COLORS.brand)
      .setDescription(
        invoices.map((inv) => invoiceLine(this.ctx.stripe, inv)).join("\n").slice(0, 4096) || "No invoices found."
      )
      .setFooter({ text: `Page ${page + 1} · pick an invoice below to manage it` });

    const components: Panel["components"] = [];
    if (invoices.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_inv_pick:${token}`)
        .setPlaceholder("Open an invoice…")
        .addOptions(
          invoices.slice(0, 25).map((inv) => ({
            label: `${inv.number ?? inv.id} · ${inv.status ?? "—"}`.slice(0, 100),
            description: `${this.fmt(inv.total, inv.currency)} · ${new Date(inv.created * 1000)
              .toISOString()
              .slice(0, 10)}`.slice(0, 100),
            value: inv.id,
          }))
        );
      components.push(selectRow(select));
    }
    components.push(
      buttonRow(
        btn(`billadmin_inv_page:${token}:${page - 1}`, "◀ Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_inv_page:${token}:${page + 1}`, "Next ▶", ButtonStyle.Secondary, !res.has_more),
        btn("billadmin_hub:invoices", "Back", ButtonStyle.Secondary)
      )
    );
    await interaction.editReply({ embeds: [embed], components });
  }

  // ---- invoice detail ----

  private async renderDetail(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const state = this.getState(token);
    if (!state.invoiceId) return;
    const inv = await this.ctx.stripe.getInvoice(state.invoiceId);
    const fmt = (v: number) => this.fmt(v, inv.currency);

    // charge/payment ref lives on invoice.payments, which needs an expand the
    // shared StripeClient.getInvoice doesn't request — shown when available.
    let paymentRef = "—";
    const pay = inv.payments?.data?.[0]?.payment;
    if (pay?.type === "charge" && pay.charge) {
      paymentRef = `\`${typeof pay.charge === "string" ? pay.charge : pay.charge.id}\``;
    } else if (pay?.type === "payment_intent" && pay.payment_intent) {
      paymentRef = `\`${typeof pay.payment_intent === "string" ? pay.payment_intent : pay.payment_intent.id}\``;
    }

    const subRef = inv.parent?.subscription_details?.subscription;
    const subText = subRef ? `\`${typeof subRef === "string" ? subRef : subRef.id}\`` : "—";

    const balanceDelta = inv.ending_balance != null ? inv.ending_balance - inv.starting_balance : 0;
    const balanceText =
      balanceDelta === 0
        ? "—"
        : `${fmt(Math.abs(balanceDelta))} ${balanceDelta > 0 ? "applied from balance" : "credited to balance"}`;

    const links =
      [
        inv.hosted_invoice_url ? `[Hosted invoice](${inv.hosted_invoice_url})` : null,
        inv.invoice_pdf ? `[PDF](${inv.invoice_pdf})` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle(`Invoice \`${inv.number ?? inv.id}\``)
      .setColor(inv.status === "paid" ? COLORS.success : inv.status === "open" ? COLORS.warn : COLORS.brand)
      .addFields(
        { name: "Status", value: inv.status ?? "—", inline: true },
        { name: "Total", value: fmt(inv.total), inline: true },
        { name: "Paid / Remaining", value: `${fmt(inv.amount_paid)} / ${fmt(inv.amount_remaining)}`, inline: true },
        { name: "Created", value: `<t:${inv.created}:D>`, inline: true },
        { name: "Due date", value: inv.due_date ? `<t:${inv.due_date}:D>` : "—", inline: true },
        { name: "Applied balance", value: balanceText.slice(0, 1024), inline: true },
        { name: "Charge / Payment", value: paymentRef, inline: true },
        { name: "Subscription", value: subText, inline: true },
        { name: "Links", value: links.slice(0, 1024), inline: true }
      );
    if (notice) embed.setDescription(notice.slice(0, 4096));

    await interaction.editReply({ embeds: [embed], components: this.detailRows(inv.status, token) });
  }

  // Status-contextual action rows for the detail panel.
  private detailRows(status: Stripe.Invoice.Status | null, token: string): Panel["components"] {
    const back = btn(`billadmin_inv_list:${token}`, "◀ Back", ButtonStyle.Secondary);
    switch (status) {
      case "draft":
        return [
          buttonRow(
            btn(`billadmin_inv_fin:${token}`, "Finalize", ButtonStyle.Primary),
            btn(`billadmin_inv_finsend:${token}`, "Finalize & send", ButtonStyle.Success),
            btn(`billadmin_inv_deldraft:${token}`, "Delete draft", ButtonStyle.Danger),
            back
          ),
        ];
      case "open":
        return [
          buttonRow(
            btn(`billadmin_inv_resend:${token}`, "Resend email", ButtonStyle.Primary),
            btn(`billadmin_inv_pay:${token}`, "Pay now", ButtonStyle.Success)
          ),
          buttonRow(
            btn(`billadmin_inv_void:${token}`, "Void…", ButtonStyle.Danger),
            btn(`billadmin_inv_uncol:${token}`, "Mark uncollectible…", ButtonStyle.Danger),
            back
          ),
        ];
      case "paid":
        return [buttonRow(btn(`billadmin_inv_cn:${token}`, "Credit note…", ButtonStyle.Primary), back)];
      default:
        // void / uncollectible / unknown: read-only.
        return [buttonRow(back)];
    }
  }

  // Shared execute wrapper for detail-panel mutations: audit on success, keep
  // the detail panel navigable on failure (money-moving ops also audit failures).
  private async execDetailOp(
    interaction: ButtonInteraction,
    token: string,
    opts: {
      action: string;
      auditFailure?: boolean;
      hint?: string;
      work: (invoiceId: string) => Promise<{ outcome: string; notice: string; amountText?: string }>;
    }
  ): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      try {
        const res = await opts.work(state.invoiceId!);
        this.ctx.audit.log(interaction, {
          action: opts.action,
          targetCustomerId: session.customerId,
          objectId: state.invoiceId,
          amountText: res.amountText,
          outcome: res.outcome,
          severity: "success",
        });
        await this.renderDetail(interaction, token, res.notice);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (opts.auditFailure) {
          this.ctx.audit.log(interaction, {
            action: opts.action,
            targetCustomerId: session.customerId,
            objectId: state.invoiceId,
            outcome: `Failed — ${msg.slice(0, 500)}`,
            severity: "danger",
          });
        }
        await this.renderDetail(
          interaction,
          token,
          `⚠️ ${opts.action} failed: ${msg.slice(0, 300)}${opts.hint ? `\n${opts.hint}` : ""}`
        );
      }
    });
  }

  // Danger confirm panel for void / uncollectible / delete-draft (same
  // convention as the ChargesHub refund confirm).
  private async renderConfirm(
    interaction: ButtonInteraction,
    token: string,
    opts: { title: string; warning: string; confirmId: string; confirmLabel: string }
  ): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const inv = await this.ctx.stripe.getInvoice(state.invoiceId!);
      const embed = new EmbedBuilder()
        .setTitle(opts.title)
        .setColor(COLORS.danger)
        .setDescription(opts.warning)
        .addFields(
          { name: "Invoice", value: `\`${inv.number ?? inv.id}\``, inline: true },
          { name: "Status", value: inv.status ?? "—", inline: true },
          { name: "Total", value: this.fmt(inv.total, inv.currency), inline: true }
        );
      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`${opts.confirmId}:${token}`, opts.confirmLabel, ButtonStyle.Danger),
            btn(`billadmin_inv_det:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  // Delete draft — used from the detail panel ("list" return) and the one-off
  // draft panel's Discard ("hub" return).
  private async executeDeleteDraft(
    interaction: ButtonInteraction,
    token: string,
    returnTo: "list" | "hub"
  ): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    const invoiceId = returnTo === "hub" ? state.draftId : state.invoiceId;
    if (!session || !invoiceId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      await this.ctx.stripe.deleteDraftInvoice(invoiceId, `billadmin-inv-deldraft-${interaction.id}`);
      this.ctx.audit.log(interaction, {
        action: returnTo === "hub" ? "Discard one-off draft invoice" : "Delete draft invoice",
        targetCustomerId: session.customerId,
        objectId: invoiceId,
        outcome: "Draft invoice deleted (line items attached to it went with it)",
        severity: "warn",
      });
      if (returnTo === "hub") state.draftId = undefined;
      else state.invoiceId = undefined;
      await interaction.editReply({
        embeds: [makeEmbed(`🗑️ Draft invoice \`${invoiceId}\` deleted.`, COLORS.success)],
        components: [
          returnTo === "hub"
            ? backRow("billadmin_hub:invoices")
            : buttonRow(btn(`billadmin_inv_list:${token}`, "◀ Back to invoices", ButtonStyle.Secondary)),
        ],
      });
    });
  }

  // ---- credit note flow (paid invoices) ----

  private async startCreditNote(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const inv = await this.ctx.stripe.getInvoice(state.invoiceId!);
      if (inv.status !== "paid" || inv.amount_paid <= 0) {
        await this.renderDetail(interaction, token, "⚠️ Credit notes with a refund/credit only apply to paid invoices.");
        return;
      }
      state.cnCurrency = inv.currency;
      state.cnMaxMinor = inv.amount_paid;
      state.cnAmountMinor = undefined;
      state.cnMemo = undefined;
      state.cnMode = undefined;
      state.cnReason = undefined;

      const embed = new EmbedBuilder()
        .setTitle(`Credit note — \`${inv.number ?? inv.id}\``)
        .setColor(COLORS.brand)
        .setDescription(
          `Amount paid: **${this.fmt(inv.amount_paid, inv.currency)}**.\n` +
            "Credit the full amount, or enter a partial amount (with an optional memo)."
        );
      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`billadmin_inv_cn_full:${token}`, `Full amount (${this.fmt(inv.amount_paid, inv.currency)})`.slice(0, 80), ButtonStyle.Primary),
            btn(`billadmin_inv_cn_partial:${token}`, "Partial…", ButtonStyle.Secondary),
            btn(`billadmin_inv_det:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private buildCnModal(token: string, currency: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_inv_cn_modal:${token}`)
      .setTitle("Partial credit note")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", `Amount in ${currency.toUpperCase()}`, {
            required: true,
            placeholder: StripeClient.isZeroDecimal(currency) ? "e.g. 1250" : "e.g. 12.50",
          })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("memo", "Memo (shown to the customer)", {
            required: false,
            style: TextInputStyle.Paragraph,
            maxLength: 500,
            placeholder: "Optional",
          })
        )
      );
  }

  private async handleCnModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId || !state.cnCurrency || state.cnMaxMinor == null) return;

    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    const memo = interaction.fields.getTextInputValue("memo").trim();
    const parsed = this.parseMinor(amountRaw, state.cnCurrency);
    if (!parsed.ok) {
      await interaction.reply({ embeds: [makeEmbed(parsed.error, COLORS.danger)], flags: 64 });
      return;
    }
    if (parsed.minor <= 0 || parsed.minor > state.cnMaxMinor) {
      await interaction.reply({
        embeds: [
          makeEmbed(
            `Amount must be between 0 and the amount paid (${this.fmt(state.cnMaxMinor, state.cnCurrency)}).`,
            COLORS.danger
          ),
        ],
        flags: 64,
      });
      return;
    }

    state.cnAmountMinor = parsed.minor;
    state.cnMemo = memo || undefined;
    await this.ctx.sessions.ackModal(interaction);
    await interaction.editReply(this.buildCnModePanel(token, state));
  }

  private buildCnModePanel(token: string, state: InvState): Panel {
    const amountText =
      state.cnAmountMinor != null && state.cnCurrency ? this.fmt(state.cnAmountMinor, state.cnCurrency) : "—";
    const embed = new EmbedBuilder()
      .setTitle("Credit note — how should the credit be issued?")
      .setColor(COLORS.brand)
      .addFields(
        { name: "Amount", value: `**${amountText}**`, inline: true },
        { name: "Memo", value: state.cnMemo?.slice(0, 1024) || "—", inline: true },
        { name: "Reason", value: state.cnReason ?? "—", inline: true }
      )
      .setDescription(
        "**Refund to payment method** sends the money back to the card/PM that paid.\n" +
          "**Credit customer balance** applies it to the customer's Stripe balance for future invoices.\n" +
          "Optionally pick a reason first — you'll see a preview before anything is created."
      );
    const reasonSelect = new StringSelectMenuBuilder()
      .setCustomId(`billadmin_inv_cn_reason:${token}`)
      .setPlaceholder(state.cnReason ? `Reason: ${state.cnReason}` : "Reason (optional)")
      .addOptions(
        { label: "No reason", value: "none" },
        ...CN_REASONS.map((r) => ({ label: r.replace(/_/g, " "), value: r }))
      );
    return {
      embeds: [embed],
      components: [
        selectRow(reasonSelect),
        buttonRow(
          btn(`billadmin_inv_cn_mode:refund:${token}`, "Refund to payment method", ButtonStyle.Primary),
          btn(`billadmin_inv_cn_mode:credit:${token}`, "Credit customer balance", ButtonStyle.Primary),
          btn(`billadmin_inv_det:${token}`, "Cancel", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private async previewCn(interaction: ButtonInteraction, token: string, mode: "refund" | "credit"): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId || state.cnAmountMinor == null) return;
    state.cnMode = mode;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const preview = await this.ctx.stripe.previewCreditNote({
        invoiceId: state.invoiceId!,
        ...(mode === "refund"
          ? { refundAmountMinor: state.cnAmountMinor }
          : { creditAmountMinor: state.cnAmountMinor }),
      });
      const refundSum = preview.refunds.reduce((sum, r) => sum + r.amount_refunded, 0);
      const creditSum = preview.total - refundSum - (preview.out_of_band_amount ?? 0);
      const fmt = (v: number) => this.fmt(v, preview.currency);

      const embed = new EmbedBuilder()
        .setTitle("Confirm credit note")
        .setColor(COLORS.danger)
        .setDescription("Preview from Stripe — nothing has been created yet.")
        .addFields(
          { name: "Invoice", value: `\`${state.invoiceId}\``, inline: true },
          { name: "Credit note total", value: `**${fmt(preview.total)}**`, inline: true },
          { name: "Mode", value: mode === "refund" ? "Refund to payment method" : "Credit customer balance", inline: true },
          { name: "Refunded to payment method", value: fmt(refundSum), inline: true },
          { name: "Credited to customer balance", value: fmt(creditSum), inline: true },
          { name: "Reason / Memo", value: `${state.cnReason ?? "—"} / ${state.cnMemo?.slice(0, 500) || "—"}`, inline: true }
        );
      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`billadmin_inv_cn_go:${token}`, "Create credit note", ButtonStyle.Danger),
            btn(`billadmin_inv_det:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }

  private async executeCn(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.invoiceId || state.cnAmountMinor == null || !state.cnMode) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const amountText = state.cnCurrency ? this.fmt(state.cnAmountMinor!, state.cnCurrency) : String(state.cnAmountMinor);
      try {
        const cn = await this.ctx.stripe.createCreditNote(
          {
            invoiceId: state.invoiceId!,
            amountMinor: state.cnAmountMinor,
            mode: state.cnMode!,
            memo: state.cnMemo,
            reason: state.cnReason,
          },
          `billadmin-inv-cn-${interaction.id}`
        );
        this.ctx.audit.log(interaction, {
          action: "Create credit note",
          targetCustomerId: session.customerId,
          objectId: cn.id,
          amountText: this.fmt(cn.total, cn.currency),
          outcome:
            `Credit note \`${cn.number}\` on \`${state.invoiceId}\` — ` +
            `${state.cnMode === "refund" ? "refunded to payment method" : "credited to customer balance"}` +
            `${state.cnReason ? ` (${state.cnReason})` : ""}`,
          severity: "success",
        });
        await this.renderDetail(
          interaction,
          token,
          `✅ Credit note \`${cn.number}\` created — **${this.fmt(cn.total, cn.currency)}** ` +
            `${state.cnMode === "refund" ? "refunded to the payment method" : "credited to the customer balance"}. ` +
            `[PDF](${cn.pdf})`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.ctx.audit.log(interaction, {
          action: "Create credit note",
          targetCustomerId: session.customerId,
          objectId: state.invoiceId,
          amountText,
          outcome: `Failed — ${msg.slice(0, 500)}`,
          severity: "danger",
        });
        await this.renderDetail(interaction, token, `⚠️ Creating the credit note failed: ${msg.slice(0, 300)}`);
      }
    });
  }

  // ---- one-off invoice flow ----

  private buildOneoffStartPanel(token: string, customerId: string): Panel {
    const embed = new EmbedBuilder()
      .setTitle(`One-off invoice — \`${customerId}\``)
      .setColor(COLORS.brand)
      .setDescription(
        "Add the first line item to create the draft.\n" +
          "The draft starts as **send by email, due in 7 days** — you can charge it immediately instead when finalizing."
      );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_inv_item:${token}`, "Add first item…", ButtonStyle.Success),
          btn("billadmin_hub:invoices", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private buildItemModal(token: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`billadmin_inv_item_modal:${token}`)
      .setTitle("Invoice line item")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("description", "Description", { required: true, maxLength: 250, placeholder: "e.g. Setup fee" })
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("amount", "Amount + currency", { required: true, placeholder: "e.g. 12.50 eur" })
        )
      );
  }

  private async handleItemModal(interaction: ModalSubmitInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session?.customerId) return;

    const description = interaction.fields.getTextInputValue("description").trim();
    const amountRaw = interaction.fields.getTextInputValue("amount").trim();
    const amountMatch = amountRaw.match(/^(\d+(?:\.\d{1,2})?)\s+([a-zA-Z]{3})$/);
    if (!amountMatch) {
      await interaction.reply({
        embeds: [makeEmbed("Amount must look like `12.50 eur` (amount + currency).", COLORS.danger)],
        flags: 64,
      });
      return;
    }
    const currency = amountMatch[2].toLowerCase();
    const parsed = this.parseMinor(amountMatch[1], currency);
    if (!parsed.ok) {
      await interaction.reply({ embeds: [makeEmbed(parsed.error, COLORS.danger)], flags: 64 });
      return;
    }

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      let draftCreated = false;
      if (!state.draftId) {
        const draft = await this.ctx.stripe.createDraftInvoice(
          { customerId: session.customerId!, collectionMethod: "send_invoice", daysUntilDue: 7 },
          `billadmin-inv-draft-${interaction.id}`
        );
        state.draftId = draft.id;
        draftCreated = true;
      }
      try {
        await this.ctx.stripe.createInvoiceItem(
          {
            customerId: session.customerId!,
            invoiceId: state.draftId,
            amountMinor: parsed.minor,
            currency,
            description,
          },
          `billadmin-inv-item-${interaction.id}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.renderDraft(interaction, token, `⚠️ Adding the item failed: ${msg.slice(0, 300)}`);
        return;
      }
      this.ctx.audit.log(interaction, {
        action: draftCreated ? "Create one-off draft invoice" : "Add invoice line item",
        targetCustomerId: session.customerId,
        objectId: state.draftId,
        amountText: this.fmt(parsed.minor, currency),
        outcome: `Line item "${description.slice(0, 200)}" added to draft \`${state.draftId}\``,
        severity: "info",
      });
      await this.renderDraft(interaction, token, "✅ Item added.");
    });
  }

  private async renderDraft(interaction: RenderInteraction, token: string, notice?: string): Promise<void> {
    const state = this.getState(token);
    if (!state.draftId) return;
    const inv = await this.ctx.stripe.getInvoice(state.draftId);
    const fmt = (v: number) => this.fmt(v, inv.currency);
    const lines = inv.lines.data
      .slice(0, 20)
      .map((line) => `• ${line.description ?? "item"} — **${fmt(line.amount)}**`);

    const embed = new EmbedBuilder()
      .setTitle(`One-off invoice draft — \`${inv.id}\``)
      .setColor(inv.status === "draft" ? COLORS.brand : COLORS.warn)
      .setDescription(
        [notice, "", ...(lines.length ? lines : ["*No line items yet.*"]), "", `**Total: ${fmt(inv.total)}**`]
          .filter((v) => v != null)
          .join("\n")
          .slice(0, 4096)
      )
      .addFields(
        { name: "Status", value: inv.status ?? "—", inline: true },
        { name: "Customer", value: `\`${typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? "—"}\``, inline: true },
        { name: "Collection", value: inv.collection_method === "send_invoice" ? "email, due in 7 days" : "charge automatically", inline: true }
      );

    await interaction.editReply({
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_inv_item:${token}`, "Add another item…", ButtonStyle.Secondary),
          btn(`billadmin_inv_dr_email:${token}`, "Finalize & email", ButtonStyle.Success),
          btn(`billadmin_inv_dr_charge:${token}`, "Finalize & charge now", ButtonStyle.Primary)
        ),
        buttonRow(
          btn(`billadmin_inv_dr_disc:${token}`, "Discard draft", ButtonStyle.Danger),
          btn("billadmin_hub:invoices", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async finalizeDraft(interaction: ButtonInteraction, token: string, via: "email" | "charge"): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.draftId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const draftId = state.draftId!;
      const action = via === "email" ? "Finalize & email one-off invoice" : "Finalize & charge one-off invoice";
      try {
        let inv = await this.ctx.stripe.getInvoice(draftId);
        if (inv.status === "draft") {
          if (via === "charge") {
            await this.ctx.stripe.updateInvoiceCollection(
              draftId,
              "charge_automatically",
              undefined,
              `billadmin-inv-colm-${interaction.id}`
            );
          }
          inv = await this.ctx.stripe.finalizeInvoice(draftId, `billadmin-inv-fin-${interaction.id}`);
        }

        if (via === "email") {
          inv = await this.ctx.stripe.sendInvoice(draftId, `billadmin-inv-send-${interaction.id}`);
        } else {
          inv = await this.ctx.stripe.payInvoice(draftId, `billadmin-inv-pay-${interaction.id}`);
        }

        this.ctx.audit.log(interaction, {
          action,
          targetCustomerId: session.customerId,
          objectId: draftId,
          amountText: this.fmt(inv.total, inv.currency),
          outcome:
            via === "email"
              ? `Finalized \`${inv.number ?? inv.id}\` and emailed it (due <t:${inv.due_date ?? inv.created}:D>)`
              : `Finalized \`${inv.number ?? inv.id}\` and charged the default payment method (status ${inv.status ?? "paid"})`,
          severity: "success",
        });

        const link = inv.hosted_invoice_url ? `\n[Hosted invoice](${inv.hosted_invoice_url})` : "";
        await interaction.editReply({
          embeds: [
            makeEmbed(
              via === "email"
                ? `📧 Invoice \`${inv.number ?? inv.id}\` (**${this.fmt(inv.total, inv.currency)}**) finalized and emailed to the customer.${link}`
                : `💳 Invoice \`${inv.number ?? inv.id}\` (**${this.fmt(inv.total, inv.currency)}**) finalized and paid (status ${inv.status ?? "paid"}).${link}`,
              COLORS.success
            ),
          ],
          components: [backRow("billadmin_hub:invoices")],
        });
        state.draftId = undefined;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (via === "charge") {
          this.ctx.audit.log(interaction, {
            action,
            targetCustomerId: session.customerId,
            objectId: draftId,
            outcome: `Failed — ${msg.slice(0, 500)}`,
            severity: "danger",
          });
        }
        await this.renderDraft(
          interaction,
          token,
          `⚠️ ${action} failed: ${msg.slice(0, 300)}` +
            (via === "charge" ? "\nNo default payment method or the charge declined? Use **Finalize & email** instead." : "")
        );
      }
    });
  }

  private async confirmDiscardDraft(interaction: ButtonInteraction, token: string): Promise<void> {
    const session = await this.ctx.sessions.getOwnedSession(token, interaction);
    const state = this.getState(token);
    if (!session || !state.draftId) return;
    await interaction.deferUpdate();
    await this.ctx.sessions.tryRender(interaction, async () => {
      const inv = await this.ctx.stripe.getInvoice(state.draftId!);
      const embed = new EmbedBuilder()
        .setTitle("Discard draft invoice?")
        .setColor(COLORS.danger)
        .setDescription("Deletes the draft and every line item attached to it. This cannot be undone.")
        .addFields(
          { name: "Draft", value: `\`${inv.id}\``, inline: true },
          { name: "Items", value: String(inv.lines.data.length), inline: true },
          { name: "Total", value: this.fmt(inv.total, inv.currency), inline: true }
        );
      await interaction.editReply({
        embeds: [embed],
        components: [
          buttonRow(
            btn(`billadmin_inv_dr_disc_go:${token}`, "Discard draft", ButtonStyle.Danger),
            btn(`billadmin_inv_draft:${token}`, "Cancel", ButtonStyle.Secondary)
          ),
        ],
      });
    });
  }
}
