import type Stripe from "stripe";
import { Client } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { TicketStore } from "../bot/TicketStore";
import { StripeClient } from "../bot/StripeClient";
import { Logger } from "../util/logger";
import { IntercomStore } from "./IntercomStore";

// Canvas Kit inbox app: renders a live context card in the Intercom inbox
// sidebar. Everything is fetched at render time (plan, charges, ticket state)
// — nothing can go stale. Intercom's canvas response window is short, so each
// external fetch is time-boxed; degraded rows say "unavailable" instead of
// failing the whole card.
//
// Developer Hub setup (same app as the webhook subscription):
//   Canvas Kit → "For teammates" → Inbox app;
//   Initialize URL: https://<host>/intercom/inbox-app/initialize
//   Submit URL:     https://<host>/intercom/inbox-app/submit
// then Inbox → conversation details → add the app to the sidebar.

const FETCH_TIMEOUT_MS = 3000;

type CanvasComponent = Record<string, unknown>;

interface CanvasRequestBody {
  conversation?: { id?: string | number };
  context?: { conversation_id?: string | number };
}

export class IntercomInboxApp {
  private client: Client | null = null;
  private log = new Logger("intercom:canvas");

  constructor(
    private settingsStore: SettingsStore,
    private store: IntercomStore,
    private ticketStore: TicketStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private categoryLabelResolver: (id: string | null) => string | null
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  getClientSecret(): string | null {
    return this.settingsStore.intercomClientSecret();
  }

  async initialize(body: unknown): Promise<object> {
    return this.buildCanvas(body);
  }

  // The only submit action is Refresh — re-render.
  async submit(body: unknown): Promise<object> {
    return this.buildCanvas(body);
  }

  private async buildCanvas(body: unknown): Promise<object> {
    const request = body as CanvasRequestBody;
    const conversationId = request?.conversation?.id ?? request?.context?.conversation_id;
    if (conversationId == null) return canvas([text("No conversation context.")]);

    const link = await this.store.getLinkByConversationId(String(conversationId)).catch(() => null);
    if (!link) return canvas([text("Not a Discord-bridged conversation.")]);

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
    const session = ticket?.customerId
      ? await this.sessionStore.getSession(ticket.customerId).catch(() => null)
      : null;

    const components: CanvasComponent[] = [header("🎫 Discord ticket")];

    if (ticket) {
      const statusLabel = ticket.statusTag ? `${ticket.statusTag.emoji} ${ticket.statusTag.label}` : "—";
      const priority = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;
      components.push(
        dataRow("Customer", ticket.customerDisplayName ?? ticket.customerId ?? "unknown"),
        dataRow("Category", this.categoryLabelResolver(ticket.categoryId) ?? "—"),
        dataRow("Status", statusLabel),
        ...(priority ? [dataRow("Priority", `${priority.emoji} ${priority.label}`)] : []),
        ...(ticket.csatScore != null ? [dataRow("CSAT", `${ticket.csatScore}/5`)] : [])
      );
    } else {
      components.push(text("Discord ticket record not found."));
    }

    components.push(divider());

    if (session?.stripeCustomerId) {
      components.push(...(await this.billingSection(session.stripeCustomerId)));
    } else {
      components.push(text("💳 No linked Stripe customer."));
    }

    if (session?.postizUserId) {
      components.push(dataRow("Postiz user", session.postizUserId));
    }

    components.push(divider());

    const threadUrl = await this.threadUrl(link.ticketThreadId);
    if (threadUrl) {
      components.push({
        type: "button",
        id: "open_thread",
        label: "Open Discord thread",
        style: "secondary",
        action: { type: "url", url: threadUrl },
      });
    }
    components.push({
      type: "button",
      id: "refresh",
      label: "🔄 Refresh",
      style: "secondary",
      action: { type: "submit" },
    });

    return canvas(components);
  }

  private async billingSection(stripeCustomerId: string): Promise<CanvasComponent[]> {
    const components: CanvasComponent[] = [header("💳 Billing (live)")];
    components.push(dataRow("Stripe customer", stripeCustomerId));

    const subs = await timeBox(this.stripe.listSubscriptions(stripeCustomerId), FETCH_TIMEOUT_MS).catch((e) => {
      this.log.warn("subscription fetch failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    if (subs === null) {
      components.push(dataRow("Subscriptions", "unavailable"));
    } else if (subs.length === 0) {
      components.push(dataRow("Subscriptions", "none"));
    } else {
      let mrrMinor = 0;
      let mrrCurrency: string | null = null;
      for (const sub of subs.filter((s) => s.status === "active" || s.status === "trialing")) {
        for (const item of sub.items.data) {
          const price = item.price;
          if (!price?.unit_amount || !price.recurring) continue;
          const qty = item.quantity ?? 1;
          const monthly =
            price.recurring.interval === "year"
              ? (price.unit_amount * qty) / (12 * (price.recurring.interval_count || 1))
              : price.recurring.interval === "month"
                ? (price.unit_amount * qty) / (price.recurring.interval_count || 1)
                : null;
          if (monthly != null) {
            mrrMinor += monthly;
            mrrCurrency = price.currency;
          }
        }
      }
      for (const sub of subs.slice(0, 3)) {
        const item = sub.items.data[0];
        const price = item?.price;
        const label = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
        const flags = [
          sub.status,
          sub.pause_collection ? "⏸ paused" : null,
          sub.cancel_at_period_end ? "cancels at period end" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        components.push(dataRow(label, flags));
      }
      if (mrrCurrency) {
        components.push(dataRow("MRR", this.stripe.formatAmount(Math.round(mrrMinor), mrrCurrency)));
      }
    }

    const lastCharge = await timeBox(this.stripe.getLastSubscriptionCharge(stripeCustomerId), FETCH_TIMEOUT_MS).catch(
      () => null
    );
    if (lastCharge) {
      components.push(
        dataRow(
          "Last charge",
          `${this.stripe.formatAmount(lastCharge.amountPaid, lastCharge.currency)} — ${lastCharge.created.toISOString().slice(0, 10)}`
        )
      );
    }

    return components;
  }

  private async threadUrl(threadId: string): Promise<string | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel.url ?? null) : null;
  }
}

// ---- Canvas Kit JSON helpers ----

function canvas(components: CanvasComponent[]): object {
  return { canvas: { content: { components } } };
}

function header(textValue: string): CanvasComponent {
  return { type: "text", text: `*${textValue}*`, style: "header" };
}

function text(textValue: string): CanvasComponent {
  return { type: "text", text: textValue, style: "muted" };
}

function dataRow(label: string, value: string): CanvasComponent {
  // Canvas Kit bold is SINGLE-asterisk (like header() above) — `**x**` renders
  // as a bold x wrapped in literal asterisks.
  return { type: "text", text: `*${label}:* ${value}`, style: "paragraph" };
}

function divider(): CanvasComponent {
  return { type: "divider" };
}

function timeBox<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
