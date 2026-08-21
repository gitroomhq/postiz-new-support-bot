import type Stripe from "stripe";
import { Client } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { TicketStore } from "../bot/TicketStore";
import { StripeClient } from "../bot/StripeClient";
import { Logger } from "../util/logger";
import { IntercomStore } from "./IntercomStore";
import type { BillingActionService } from "../bot/billing/actions/BillingActionService";
import type { ActionActor } from "../bot/billing/actions/ActionRegistry";
import type { PanelTokens } from "./panel/PanelTokens";
import type { PanelSessions } from "./panel/PanelSessions";
import type { PostizIdentityService } from "../postiz/PostizIdentityService";

// Canvas Kit inbox app: renders a live context card in the Intercom inbox
// sidebar. Everything is fetched at render time (plan, charges, ticket state)
// — nothing can go stale. Intercom's canvas response window is short, so each
// external fetch is time-boxed; degraded rows say "unavailable" instead of
// failing the whole card.
//
// Beyond the read-only card, the canvas now carries the billing-action
// surfaces: charge-review Approve/Deny, the pending-approvals list, and the
// "Open Stripe Panel" button (Canvas Kit sheets are Messenger-only, so the
// panel is a tokenized standalone page — the submit body's `admin` object is
// the authentic clicker, and the minted link is bound to them).
//
// Developer Hub setup (same app as the webhook subscription):
//   Canvas Kit → "For teammates" → Inbox app;
//   Initialize URL: https://<host>/intercom/inbox-app/initialize
//   Submit URL:     https://<host>/intercom/inbox-app/submit
// then Inbox → conversation details → add the app to the sidebar.

const FETCH_TIMEOUT_MS = 3000;
// Intercom expects sub-10s canvas responses; long-running actions return a
// "still processing" notice and finish in the background (all executors are
// idempotent + claim-guarded, so Refresh shows the truth).
const ACTION_TIMEOUT_MS = 7000;

type CanvasComponent = Record<string, unknown>;

interface CanvasRequestBody {
  conversation?: { id?: string | number };
  context?: { conversation_id?: string | number };
  component_id?: string;
  admin?: { id?: string | number; name?: string; email?: string };
  input_values?: Record<string, unknown>;
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
    private categoryLabelResolver: (id: string | null) => string | null,
    private billingActions: BillingActionService,
    private panelTokens: PanelTokens,
    private panelSessions: PanelSessions,
    // Optional: the card degrades to the identity stamped on the ticket when
    // the platform lookup is off or unconfigured.
    private postizIdentity?: PostizIdentityService
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

  // component_id router: billing actions + panel-link minting; anything else
  // (refresh, stale ids) is a plain re-render.
  async submit(body: unknown): Promise<object> {
    const request = body as CanvasRequestBody;
    const componentId = typeof request?.component_id === "string" ? request.component_id : "";
    const conversationId = request?.conversation?.id ?? request?.context?.conversation_id;
    const actor = this.actorFrom(request);

    if (conversationId == null || !actor) return this.buildCanvas(body);

    try {
      if (componentId === "open_panel") {
        return await this.handleOpenPanel(body, String(conversationId), actor);
      }
      if (componentId === "unlock_panel") {
        const rawv = request.input_values && typeof request.input_values["panel_code"] === "string" ? String(request.input_values["panel_code"]) : "";
        const norm = rawv.toUpperCase().replace(/[^0-9A-Z]/g, "");
        const code = norm.length === 8 ? `${norm.slice(0, 4)}-${norm.slice(4)}` : rawv.toUpperCase();
        const ok = rawv ? this.panelSessions.activate(actor.id, code, this.settingsStore.panelTokenEpoch()) : false;
        return this.buildCanvas(
          body,
          ok
            ? "✅ Panel unlocked. Return to your browser."
            : "⚠️ That code didn't match. Open the panel link and enter the exact code shown."
        );
      }
      if (componentId === "review_approve" || componentId === "review_deny") {
        const decision = componentId === "review_approve" ? "approve" : "deny";
        const outcome = await timeBox(
          this.billingActions.request(String(conversationId), actor, "charge_review", { decision }),
          ACTION_TIMEOUT_MS
        ).catch(() => null);
        return this.buildCanvas(body, this.noticeForRequest(outcome));
      }
      if (componentId.startsWith("appr_ok:") || componentId.startsWith("appr_no:")) {
        const decision = componentId.startsWith("appr_ok:") ? "approve" : "reject";
        const approvalId = componentId.slice("appr_ok:".length);
        const outcome = await timeBox(
          this.billingActions.actOnApproval(approvalId, actor, decision),
          ACTION_TIMEOUT_MS
        ).catch(() => null);
        return this.buildCanvas(body, this.noticeForApproval(outcome));
      }
    } catch (e) {
      this.log.warn("canvas submit action failed", { error: e instanceof Error ? e.message : String(e) });
      return this.buildCanvas(body, "⚠️ Action failed. Check the audit log.");
    }
    return this.buildCanvas(body);
  }

  // The authentic acting teammate from the signed submit body.
  private actorFrom(request: CanvasRequestBody): ActionActor | null {
    const id = request?.admin?.id;
    if (id == null) return null;
    const idStr = String(id);
    return {
      kind: "intercom",
      id: idStr,
      name: request.admin?.name || `Teammate ${idStr}`,
      isAdmin: this.settingsStore.isIntercomPanelAdmin(idStr),
    };
  }

  private noticeForRequest(
    outcome: Awaited<ReturnType<BillingActionService["request"]>> | null
  ): string {
    if (!outcome) return "⏳ Still processing. Press Refresh in a few seconds.";
    switch (outcome.kind) {
      case "executed":
        return `✅ ${outcome.text}`;
      case "queued":
        return "📋 Queued for admin approval.";
      default:
        return `⚠️ ${outcome.error}`;
    }
  }

  private noticeForApproval(
    outcome: Awaited<ReturnType<BillingActionService["actOnApproval"]>> | null
  ): string {
    if (!outcome) return "⏳ Still processing. Press Refresh in a few seconds.";
    switch (outcome.kind) {
      case "executed":
        return `✅ ${outcome.text}`;
      case "rejected":
        return "🚫 Approval rejected.";
      case "denied":
        return `⚠️ ${outcome.error}`;
      default:
        return `⚠️ ${outcome.error}`;
    }
  }

  // "Open Stripe Panel": mint a 15-min token bound to the clicking teammate +
  // conversation, and re-render with a personal URL button. The canvas is
  // stored per-conversation, so the button row names its owner.
  private async handleOpenPanel(body: unknown, conversationId: string, actor: ActionActor): Promise<object> {
    const base = this.settingsStore.resolvedPublicBaseUrl();
    if (!base) {
      return this.buildCanvas(body, "⚠️ Set the public URL first (/config → Billing → Webhooks).");
    }
    const token = await this.panelTokens.mint({
      adminId: actor.id,
      adminName: actor.name,
      conversationId,
    });
    const url = `${base}/intercom/panel?t=${encodeURIComponent(token)}`;
    return this.buildCanvas(body, undefined, {
      label: `Open Stripe Panel · link for ${actor.name}, valid 15 minutes`,
      url,
    });
  }

  private async buildCanvas(body: unknown, notice?: string, panelLink?: { label: string; url: string }): Promise<object> {
    const request = body as CanvasRequestBody;
    const conversationId = request?.conversation?.id ?? request?.context?.conversation_id;
    if (conversationId == null) return canvas([text("No conversation context.")]);

    const link = await this.store.getLinkByConversationId(String(conversationId)).catch(() => null);
    if (!link) return canvas([text("Not a Discord-bridged conversation.")]);

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
    const session = ticket?.customerId
      ? await this.sessionStore.getSession(ticket.customerId).catch(() => null)
      : null;

    const components: CanvasComponent[] = [];
    if (notice) components.push(text(notice), divider());
    components.push(header("🎫 Discord ticket"));

    if (ticket) {
      const statusLabel = ticket.statusTag ? `${ticket.statusTag.emoji} ${ticket.statusTag.label}` : "N/A";
      components.push(
        dataRow("Customer", ticket.customerDisplayName ?? ticket.customerId ?? "unknown"),
        dataRow("Category", this.categoryLabelResolver(ticket.categoryId) ?? "N/A"),
        dataRow("Status", statusLabel),
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

    components.push(...(await this.postizSection(ticket, session?.postizUserId ?? null)));

    components.push(...(await this.chargeReviewSection(link.ticketThreadId)));
    components.push(...(await this.approvalsSection(String(conversationId))));

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
    if (panelLink) {
      components.push({
        type: "button",
        id: "panel_link",
        label: panelLink.label,
        style: "primary",
        action: { type: "url", url: panelLink.url },
      });
      // The panel opens LOCKED and shows a code — confirm it here to unlock.
      components.push({ type: "input", id: "panel_code", label: "Panel code (shown on the page)", placeholder: "XXXX-XXXX" });
      components.push({ type: "button", id: "unlock_panel", label: "Unlock panel", style: "secondary", action: { type: "submit" } });
    } else {
      components.push({
        type: "button",
        id: "open_panel",
        label: "Open Stripe Panel",
        style: "secondary",
        action: { type: "submit" },
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

  // Guardrail-blocked refund awaiting review: amount/charge/reason rows +
  // Approve/Deny. Agents route through the approval queue; configured admins
  // execute directly (BillingActionService decides — these buttons only
  // render the entry point).
  private async chargeReviewSection(ticketThreadId: string): Promise<CanvasComponent[]> {
    const review = await this.sessionStore.getPendingChargeReview(ticketThreadId).catch(() => null);
    if (!review) return [];
    return [
      divider(),
      header("⚠️ Refund review pending"),
      dataRow("Amount", this.stripe.formatAmount(review.amount, review.currency)),
      dataRow("Charge", review.chargeId),
      dataRow("Blocked by", review.reason),
      {
        type: "button",
        id: "review_approve",
        label: "Approve refund",
        style: "primary",
        action: { type: "submit" },
      },
      {
        type: "button",
        id: "review_deny",
        label: "Deny refund",
        style: "secondary",
        action: { type: "submit" },
      },
    ];
  }

  // Pending billing-action approvals for THIS conversation (max 3 rendered;
  // the panel shows the rest). Approve/Reject act via BillingActionService —
  // non-admin clicks come back with a clear refusal notice.
  private async approvalsSection(conversationId: string): Promise<CanvasComponent[]> {
    const pending = await this.billingActions.pendingForConversation(conversationId, 4).catch(() => []);
    if (pending.length === 0) return [];
    const components: CanvasComponent[] = [divider(), header("📋 Pending approvals")];
    for (const approval of pending.slice(0, 3)) {
      const age = Math.max(0, Math.floor((Date.now() - approval.createdAt.getTime()) / (60 * 60 * 1000)));
      const state = approval.status === "FAILED" ? ` · FAILED: ${approval.errorText ?? "error"} (retryable)` : "";
      components.push(
        text(`${approval.summary}\nRequested by ${approval.requestedByName}, ${age}h ago${state}`),
        {
          type: "button",
          id: `appr_ok:${approval.id}`,
          label: "Approve",
          style: "primary",
          action: { type: "submit" },
        },
        {
          type: "button",
          id: `appr_no:${approval.id}`,
          label: "Reject",
          style: "secondary",
          action: { type: "submit" },
        }
      );
    }
    if (pending.length > 3) components.push(text(`…more in the Stripe panel.`));
    return components;
  }

  // The Postiz account behind this conversation: who they are on the platform,
  // which organization, and what plan the platform actually has them on.
  //
  // The stamped id is authoritative for WHICH account this is (resolved once at
  // ticket creation); the live lookup is what supplies the email, names and the
  // CURRENT tier, in keeping with this card's "fetched at render time" rule. A
  // lookup that is off, slow or failing degrades to the stamped columns rather
  // than dropping the section.
  private async postizSection(
    ticket: { postizUserId: string | null; postizOrgId: string | null; postizTier: string | null; postizRole: string | null } | null,
    sessionPostizUserId: string | null
  ): Promise<CanvasComponent[]> {
    const stampedId = ticket?.postizUserId ?? null;
    const lookupTerm = stampedId ?? sessionPostizUserId;
    if (!lookupTerm) return [text("👤 No Postiz account linked.")];

    const components: CanvasComponent[] = [header("👤 Postiz account")];
    const account = this.postizIdentity
      ? await timeBox(this.postizIdentity.resolve(lookupTerm), FETCH_TIMEOUT_MS).catch((e) => {
          this.log.warn("postiz lookup failed", { error: e instanceof Error ? e.message : String(e) });
          return null;
        })
      : null;

    if (account) {
      components.push(
        dataRow("User ID", account.userId),
        ...(account.email ? [dataRow("Email", account.email)] : []),
        ...(account.name ? [dataRow("Name", account.name)] : []),
        dataRow("Organization", account.orgName ? `${account.orgName} (${account.orgId})` : account.orgId),
        ...(account.role ? [dataRow("Role", account.role)] : []),
        dataRow("Plan", account.tier ?? "none")
      );
      // The tier the platform reports now versus the one recorded when this
      // ticket was opened: a mismatch is exactly the drift the billing panel
      // can repair, so it is worth an agent seeing it here.
      if (ticket?.postizTier && account.tier && ticket.postizTier !== account.tier) {
        components.push(dataRow("Plan at ticket open", ticket.postizTier));
      }
      return components;
    }

    // Degraded: everything known without the platform.
    components.push(dataRow("User ID", lookupTerm));
    if (ticket?.postizOrgId) components.push(dataRow("Organization", ticket.postizOrgId));
    if (ticket?.postizRole) components.push(dataRow("Role", ticket.postizRole));
    if (ticket?.postizTier) components.push(dataRow("Plan (at ticket open)", ticket.postizTier));
    components.push(dataRow("Live lookup", this.postizIdentity ? "unavailable" : "not configured"));
    return components;
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
        const periodEnd = item?.current_period_end
          ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10)
          : null;
        const flags = [
          sub.status,
          periodEnd ? `period ends ${periodEnd}` : null,
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

    // Recent charges (last 3): amount · status(+refund flag) · date.
    const recent = await timeBox(this.stripe.listCharges(stripeCustomerId, 3), FETCH_TIMEOUT_MS).catch((e) => {
      this.log.warn("charge fetch failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    if (recent === null) {
      components.push(dataRow("Recent charges", "unavailable"));
    } else if (recent.charges.length > 0) {
      for (const charge of recent.charges) {
        const state = charge.refunded ? "refunded" : (charge.amount_refunded ?? 0) > 0 ? "partial refund" : charge.status;
        components.push(
          dataRow(
            this.stripe.formatAmount(charge.amount, charge.currency),
            `${state} · ${new Date(charge.created * 1000).toISOString().slice(0, 10)}`
          )
        );
      }
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
