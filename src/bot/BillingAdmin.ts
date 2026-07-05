import {
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { BotConfig } from "../config";
import { StripeClient } from "./StripeClient";
import { SessionStore } from "../auth/SessionStore";
import { SettingsStore } from "../config/SettingsStore";
import { AuditLogger } from "./AuditLogger";
import { embed as makeEmbed, COLORS } from "../util/embeds";
import {
  type AdminGateInteraction,
  type Panel,
  type RouteEntry,
  type RouteMatch,
  type TargetAction,
} from "./billing/types";
import { buildHubPanel, buildRootPanel, isTargetAction } from "./billing/ui";
import { SessionManager } from "./billing/SessionManager";
import { PriceBook } from "./billing/PriceBook";
import { AdminAudit } from "./billing/AdminAudit";
import { TargetResolver } from "./billing/TargetResolver";
import type { HubContext } from "./billing/hubs/HubContext";
import { CardsHub } from "./billing/hubs/CardsHub";
import { CustomersHub } from "./billing/hubs/CustomersHub";
import { ChargesHub } from "./billing/hubs/ChargesHub";
import { SubscriptionsHub } from "./billing/hubs/SubscriptionsHub";
import { PromosHub } from "./billing/hubs/PromosHub";
import { InvoicesHub } from "./billing/hubs/InvoicesHub";
import { PaymentsHub } from "./billing/hubs/PaymentsHub";

type Handler<I> = (interaction: I) => Promise<void>;

// Exact ids win; otherwise the longest matching registered prefix wins — this
// reproduces the specificity of the old hand-ordered if/else-if chains.
class RouteTable<I> {
  private exact = new Map<string, Handler<I>>();
  private prefixes: Array<{ id: string; handler: Handler<I> }> = [];

  add(id: string, match: RouteMatch, handler: Handler<I>): void {
    if (match === "exact") {
      this.exact.set(id, handler);
    } else {
      this.prefixes.push({ id, handler });
      this.prefixes.sort((a, b) => b.id.length - a.id.length);
    }
  }

  find(id: string): Handler<I> | null {
    const exact = this.exact.get(id);
    if (exact) return exact;
    for (const entry of this.prefixes) {
      if (id.startsWith(entry.id)) return entry.handler;
    }
    return null;
  }
}

// Admin-only /billing panel: Stripe investigation and actions from Discord.
// This class is a thin facade: it owns the admin gate, the route registry and
// root navigation; every flow lives in a hub under ./billing/hubs.
export class BillingAdmin {
  private sessions = new SessionManager();
  private priceBook: PriceBook;
  private audit: AdminAudit;
  private targets: TargetResolver;
  private cards: CardsHub;
  private customers: CustomersHub;
  private charges: ChargesHub;
  private subs: SubscriptionsHub;
  private promos: PromosHub;
  private invoices: InvoicesHub;
  private payments: PaymentsHub;

  private buttonRoutes = new RouteTable<ButtonInteraction>();
  private selectRoutes = new RouteTable<StringSelectMenuInteraction>();
  private userSelectRoutes = new RouteTable<UserSelectMenuInteraction>();
  private modalRoutes = new RouteTable<ModalSubmitInteraction>();

  constructor(
    private config: BotConfig,
    private stripeClient: StripeClient,
    private sessionStore: SessionStore,
    private settingsStore: SettingsStore,
    auditLogger: AuditLogger
  ) {
    this.priceBook = new PriceBook(stripeClient);
    this.audit = new AdminAudit(settingsStore, auditLogger);
    const ctx: HubContext = {
      config: this.config,
      stripe: this.stripeClient,
      sessions: this.sessions,
      priceBook: this.priceBook,
      audit: this.audit,
      sessionStore: this.sessionStore,
      settingsStore: this.settingsStore,
    };

    this.targets = new TargetResolver(ctx);
    this.cards = new CardsHub(ctx);
    this.customers = new CustomersHub(ctx);
    this.charges = new ChargesHub(ctx);
    this.subs = new SubscriptionsHub(ctx);
    this.promos = new PromosHub(ctx);
    this.invoices = new InvoicesHub(ctx);
    this.payments = new PaymentsHub(ctx);

    // The resolver dispatches a resolved customer to the owning hub's renderer.
    this.targets.bindHandlers({
      renderCards: (i, token) => this.cards.renderCards(i, token),
      renderOverview: (i, token) => this.customers.renderOverview(i, token),
      renderListPage: (i, token, page) => this.charges.renderListPage(i, token, page),
      renderFraud: (i, token) => this.charges.renderFraud(i, token),
      startDiscount: (i, token) => this.subs.startDiscount(i, token),
      startChangePlan: (i, token) => this.subs.startChangePlan(i, token),
      startCreateSub: (i, token) => this.subs.startCreateSub(i, token),
      renderEditCustomer: (i, token, notice) => this.customers.renderEditCustomer(i, token, notice),
      buildCustomerDeleteConfirm: (token, customer) => this.customers.buildCustomerDeleteConfirm(token, customer),
      buildLinkPanel: (token, notice) => this.customers.buildLinkPanel(token, notice),
    });

    const sources: { routes: RouteEntry[] }[] = [
      this.targets,
      this.cards,
      this.customers,
      this.charges,
      this.subs,
      this.promos,
      this.invoices,
      this.payments,
      { routes: this.facadeRoutes() },
    ];
    for (const source of sources) {
      for (const route of source.routes) this.register(route);
    }
  }

  private register(route: RouteEntry): void {
    switch (route.kind) {
      case "button":
        this.buttonRoutes.add(route.id, route.match, route.handler);
        return;
      case "select":
        this.selectRoutes.add(route.id, route.match, route.handler);
        return;
      case "userSelect":
        this.userSelectRoutes.add(route.id, route.match, route.handler);
        return;
      case "modal":
        this.modalRoutes.add(route.id, route.match, route.handler);
        return;
    }
  }

  // Root navigation stays with the facade: the root panel, the hub panels and
  // the billadmin_open: fan-out into the hubs' entry flows.
  private facadeRoutes(): RouteEntry[] {
    return [
      {
        kind: "button",
        id: "billadmin_root",
        match: "exact",
        handler: async (interaction) => {
          await interaction.update(this.buildRootPanel());
        },
      },
      {
        kind: "button",
        id: "billadmin_hub:",
        match: "prefix",
        handler: async (interaction) => {
          await interaction.update(buildHubPanel(interaction.customId.split(":")[1], this.config));
        },
      },
      {
        kind: "button",
        id: "billadmin_open:",
        match: "prefix",
        handler: async (interaction) => {
          const [, action, origin] = interaction.customId.split(":");
          await this.handleOpen(interaction, action, origin);
        },
      },
    ];
  }

  // ---- entry points (routed from DiscordBot by the billadmin_ prefix) ----

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    await interaction.reply({ ...this.buildRootPanel(), flags: 64 });
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.buttonRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.selectRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  async handleUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.userSelectRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await this.requireAdmin(interaction))) return;
    const handler = this.modalRoutes.find(interaction.customId);
    if (handler) {
      await handler(interaction);
      return;
    }
    await this.replyUnknownComponent(interaction);
  }

  // ---- root dispatch ----

  buildRootPanel(): Panel {
    return buildRootPanel(this.config);
  }

  private async handleOpen(interaction: ButtonInteraction, action: string, origin?: string): Promise<void> {
    if (isTargetAction(action) || action === "link") {
      await interaction.update(this.targets.buildTargetPanel(action as TargetAction | "link", undefined, origin));
      return;
    }
    switch (action) {
      case "usersbycard":
      case "chargesbycard":
        await interaction.showModal(this.cards.buildFingerprintModal(action));
        return;
      case "cardsbylast4":
        await interaction.showModal(this.cards.buildLast4Modal());
        return;
      case "refund":
        await interaction.showModal(this.charges.buildRefundModal());
        return;
      case "cancelsub":
        await interaction.showModal(this.subs.buildCancelModal());
        return;
      case "createcust":
        await interaction.showModal(this.customers.buildCreateCustomerModal());
        return;
      case "promo":
        await interaction.update(this.promos.buildPromoHubPanel());
        return;
    }
  }

  // Catch-all for stale panels: any billadmin_ component whose id no longer
  // matches a route (older bot builds fell through silently here).
  private async replyUnknownComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<void> {
    if (!interaction.customId.startsWith("billadmin_")) return;
    await interaction
      .reply({
        embeds: [makeEmbed("This button is from an older version of the panel — run /billing again.", COLORS.warn)],
        flags: 64,
      })
      .catch(() => undefined);
  }

  private async requireAdmin(interaction: AdminGateInteraction): Promise<boolean> {
    // memberPermissions is null in DMs, so DM use is implicitly rejected too.
    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
    await interaction
      .reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 })
      .catch(() => undefined);
    return false;
  }
}
