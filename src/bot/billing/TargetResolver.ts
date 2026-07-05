import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import type Stripe from "stripe";
import { embed as makeEmbed, COLORS } from "../../util/embeds";
import {
  FINGERPRINT_RE,
  TARGET_TITLES,
  type Panel,
  type RenderInteraction,
  type RouteEntry,
  type TargetAction,
} from "./types";
import { backRow, btn, buttonRow, hubBack, isTargetAction, selectRow, textInput } from "./ui";
import type { HubContext } from "./hubs/HubContext";

// The customer-scoped renderers a resolved target is dispatched to. Implemented
// by the facade as a thin delegation onto the hubs, so the resolver stays free
// of hub imports (and hub → resolver imports stay acyclic).
export interface TargetActionHandlers {
  renderCards(interaction: RenderInteraction, token: string): Promise<void>;
  renderOverview(interaction: RenderInteraction, token: string): Promise<void>;
  renderListPage(interaction: RenderInteraction, token: string, page: number): Promise<void>;
  renderFraud(interaction: RenderInteraction, token: string): Promise<void>;
  startDiscount(interaction: RenderInteraction, token: string): Promise<void>;
  startChangePlan(interaction: RenderInteraction, token: string): Promise<void>;
  startCreateSub(interaction: RenderInteraction, token: string): Promise<void>;
  renderEditCustomer(interaction: RenderInteraction, token: string, notice?: string): Promise<void>;
  buildCustomerDeleteConfirm(token: string, customer?: Stripe.Customer): Panel;
  buildLinkPanel(token: string, notice?: string): Promise<Panel>;
}

// Resolves "a user" (Discord pick, cus_ id, email, or Postiz user id) to a
// Stripe customer, then hands off to the action's hub renderer.
export class TargetResolver {
  private handlers!: TargetActionHandlers;

  constructor(private ctx: HubContext) {}

  // Bound after the hubs exist (they need the resolver's panels; the resolver
  // needs their renderers).
  bindHandlers(handlers: TargetActionHandlers): void {
    this.handlers = handlers;
  }

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_manual:",
      match: "prefix",
      handler: async (interaction) => {
        const [, action, origin] = interaction.customId.split(":");
        await interaction.showModal(this.buildTargetModal(action as TargetAction, origin));
      },
    },
    {
      kind: "userSelect",
      id: "billadmin_user:",
      match: "prefix",
      handler: (interaction) => this.handleUserSelect(interaction),
    },
    {
      kind: "modal",
      id: "billadmin_target_modal:",
      match: "prefix",
      handler: async (interaction) => {
        const [, action, origin] = interaction.customId.split(":");
        await this.handleTargetModal(interaction, action as TargetAction, origin);
      },
    },
    {
      kind: "select",
      id: "billadmin_cuspick:",
      match: "prefix",
      handler: async (interaction) => {
        const token = interaction.customId.split(":")[1];
        const value = interaction.values[0];
        const session = await this.ctx.sessions.getOwnedSession(token, interaction);
        if (!session) return;
        await interaction.deferUpdate();
        session.customerId = value;
        await this.ctx.sessions.tryRender(interaction, () =>
          this.runTargetAction(interaction, token, session.pendingAction ?? "overview")
        );
      },
    },
  ];

  // Runs a customer-scoped action once session.customerId is resolved.
  // The interaction must already be deferred; callers wrap this in tryRender.
  async runTargetAction(interaction: RenderInteraction, token: string, action: TargetAction): Promise<void> {
    const session = this.ctx.sessions.get(token);
    if (!session) return;
    switch (action) {
      case "cards":
        await this.handlers.renderCards(interaction, token);
        return;
      case "overview":
        await this.handlers.renderOverview(interaction, token);
        return;
      case "charges":
      case "invoices":
        session.view = action;
        session.cursors = [undefined];
        await this.handlers.renderListPage(interaction, token, 0);
        return;
      case "fraud":
        await this.handlers.renderFraud(interaction, token);
        return;
      case "discount":
        await this.handlers.startDiscount(interaction, token);
        return;
      case "changeplan":
        await this.handlers.startChangePlan(interaction, token);
        return;
      case "createsub":
        await this.handlers.startCreateSub(interaction, token);
        return;
      case "editcust":
        await this.handlers.renderEditCustomer(interaction, token);
        return;
      case "delcust": {
        const customer = await this.ctx.stripe.getCustomer(session.customerId!);
        if (!customer) {
          await interaction.editReply({
            embeds: [makeEmbed(`No such Stripe customer: \`${session.customerId}\` (or already deleted).`, COLORS.warn)],
            components: [backRow("billadmin_hub:customers")],
          });
          return;
        }
        await interaction.editReply(this.handlers.buildCustomerDeleteConfirm(token, customer));
        return;
      }
    }
  }

  async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    const [, action, origin] = interaction.customId.split(":");
    const pickedId = interaction.values[0];
    if (!pickedId) return;
    await interaction.deferUpdate();

    await this.ctx.sessions.tryRender(interaction, async () => {
      const row = await this.ctx.sessionStore.getSession(pickedId);

      if (action === "link") {
        if (!row) {
          await interaction.editReply(
            this.buildTargetPanel(
              "link",
              `<@${pickedId}> has never authenticated with the bot, so there is no session row to attach a ` +
                `Stripe customer to (creating one would let them skip the OAuth login). Ask them to click ` +
                `**Start Here** and log in first.`,
              origin
            )
          );
          return;
        }
        const token = this.ctx.sessions.newSession(interaction, { targetDiscordUserId: pickedId });
        await interaction.editReply(await this.handlers.buildLinkPanel(token));
        return;
      }

      if (!isTargetAction(action)) return;
      if (!row) {
        await interaction.editReply(
          this.buildTargetPanel(
            action,
            `<@${pickedId}> has no bot session — they've never logged in via **Start Here**. ` +
              `Use manual entry (cus_… / email) instead.`,
            origin
          )
        );
        return;
      }
      if (!row.stripeCustomerId) {
        await interaction.editReply(
          this.buildTargetPanel(
            action,
            `<@${pickedId}> has a session but no linked Stripe customer. Link one via ` +
              `**Link / Unlink User**, or use manual entry (cus_… / email).`,
            origin
          )
        );
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { customerId: row.stripeCustomerId, originHub: origin });
      await this.runTargetAction(interaction, token, action);
    });
  }

  // ---- target resolution via modal (cus_ id, email, or Postiz user id) ----

  async handleTargetModal(interaction: ModalSubmitInteraction, action: TargetAction, origin?: string): Promise<void> {
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

    await this.ctx.sessions.ackModal(interaction);
    await this.ctx.sessions.tryRender(interaction, async () => {
      if (fingerprint) {
        const token = this.ctx.sessions.newSession(interaction, { fingerprint });
        await this.handlers.renderFraud(interaction, token);
        return;
      }

      if (target.startsWith("cus_")) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: target, originHub: origin });
        await this.runTargetAction(interaction, token, action);
        return;
      }

      if (target.includes("@")) {
        const customers = await this.ctx.stripe.findCustomersByEmail(target);
        if (customers.length === 0) {
          await interaction.editReply(
            this.buildTargetPanel(action, `No Stripe customer found for \`${target}\`.`, origin)
          );
          return;
        }
        if (customers.length === 1) {
          const token = this.ctx.sessions.newSession(interaction, { customerId: customers[0].id, originHub: origin });
          await this.runTargetAction(interaction, token, action);
          return;
        }
        const token = this.ctx.sessions.newSession(interaction, { pendingAction: action, originHub: origin });
        await interaction.editReply(this.buildCustomerPickPanel(customers, token, hubBack(action, origin)));
        return;
      }

      // Anything else is treated as a Postiz user id, resolved through the bot DB.
      const discordIds = await this.ctx.sessionStore.findDiscordIdsByPostizId(target);
      const rows = await this.ctx.sessionStore.listByDiscordIds(discordIds);
      const stripeIds = [...new Set(rows.map((r) => r.stripeCustomerId).filter((v): v is string => !!v))];
      if (stripeIds.length === 0) {
        await interaction.editReply(
          this.buildTargetPanel(action, `No linked Stripe customer found for Postiz user \`${target}\`.`, origin)
        );
        return;
      }
      if (stripeIds.length === 1) {
        const token = this.ctx.sessions.newSession(interaction, { customerId: stripeIds[0], originHub: origin });
        await this.runTargetAction(interaction, token, action);
        return;
      }
      const token = this.ctx.sessions.newSession(interaction, { pendingAction: action, originHub: origin });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_cuspick:${token}`)
        .setPlaceholder("Several Stripe customers are linked — pick one")
        .addOptions(
          stripeIds.slice(0, 25).map((id) => ({ label: id, description: "via Postiz link", value: id }))
        );
      await interaction.editReply({
        embeds: [makeEmbed(`Postiz user \`${target}\` maps to ${stripeIds.length} Stripe customers.`, COLORS.warn)],
        components: [selectRow(select), backRow(hubBack(action, origin))],
      });
    });
  }

  buildTargetPanel(action: TargetAction | "link", error?: string, origin?: string): Panel {
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

    const suffix = origin ? `:${origin}` : "";
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`billadmin_user:${action}${suffix}`)
      .setPlaceholder("Pick a Discord user");

    const buttons: ButtonBuilder[] = [];
    if (action !== "link") {
      buttons.push(btn(`billadmin_manual:${action}${suffix}`, "Enter cus_ / email / Postiz ID", ButtonStyle.Secondary));
    }
    buttons.push(btn(hubBack(action, origin), "◀ Back", ButtonStyle.Secondary));

    return {
      embeds: [embed],
      components: [selectRow(userSelect), buttonRow(...buttons)],
    };
  }

  buildTargetModal(action: TargetAction, origin?: string): ModalBuilder {
    const modal = new ModalBuilder()
      .setCustomId(`billadmin_target_modal:${action}${origin ? `:${origin}` : ""}`)
      .setTitle(TARGET_TITLES[action].slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("target", "Stripe cus_ ID, email, or Postiz user ID", {
          required: action !== "fraud",
          placeholder: "cus_… / mail@example.com / postiz id",
        })
      )
    );
    if (action === "fraud") {
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          textInput("fingerprint", "…or a card fingerprint instead", {
            required: false,
            placeholder: "Wins over the field above if filled",
          })
        )
      );
    }
    return modal;
  }

  buildCustomerPickPanel(customers: Stripe.Customer[], token: string, backTarget: string): Panel {
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
      components: [selectRow(select), backRow(backTarget)],
    };
  }
}
