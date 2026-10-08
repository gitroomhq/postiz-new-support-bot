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
import type { PostizIdentityService } from "../postiz/PostizIdentityService";
import { isPostizCreditType, type PostizAccount, type PostizCreditType } from "../postiz/PostizClient";
import { CREDIT_LABELS, describeTarget, orgLabel, type PostizCreditService } from "../postiz/PostizCreditService";
import type { PostizCreditResetRow } from "../postiz/PostizCreditResetStore";
import type { IntercomClient } from "./IntercomClient";
import {
  EMAIL_RE,
  describeSuppression,
  distinctEmails,
  type DeliveryStatus,
  type EmailDeliverabilityService,
} from "../resend/EmailDeliverabilityService";
import { PROBLEM_EVENTS, categoryLabel, eventLabel, type LoggedEmail } from "../resend/DeliveryLogStore";
import type { DeliveryLogService } from "../resend/DeliveryLogService";
import type { DisputeStore } from "../bot/billing/DisputeStore";
import type { BlockStore } from "../bot/billing/BlockStore";

// Canvas Kit inbox app: renders a live context card in the Intercom inbox
// sidebar. Everything is fetched at render time (plan, charges, ticket state),
// so nothing can go stale. Intercom's canvas response window is short, so each
// external fetch is time-boxed; degraded rows say "unavailable" instead of
// failing the whole card.
//
// The card is a small navigator. The main view holds only who this is (one
// identity line) and warnings that are true right now (email suppressed or
// bouncing, delinquent, blocked, open dispute, refund review or approvals
// waiting). Everything else sits behind a button, each opening its own view
// with a Back: Postiz Account (plus the AI credit reset), E-Mail
// Deliverability (suppression status and removal, the delivery log), Billing (subscriptions, charges, the refund
// review and approvals), Discord Ticket. Which view is open travels in the
// component ids only; the server re-derives everything else on every press.
// The submit body's `admin` object is the authentic clicker.
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

type View = "home" | "postiz" | "email" | "billing" | "discord";
const VIEWS: readonly View[] = ["home", "postiz", "email", "billing", "discord"];

// Delivery log rows per page in the email view.
const LOG_PAGE_SIZE = 10;

// What the email-delivery section is in the middle of. Carried from one
// submit to the next only through component ids and the prefilled input, so
// the server re-derives everything that matters (which address, whose) on
// every press.
interface EmailView {
  // Index into this conversation's address list awaiting a "yes, remove".
  confirm?: number;
  // The "check another address" input is open, and what it was asked about.
  checkOpen?: boolean;
  query?: string;
  confirmQuery?: boolean;
  // Offer "resend activation email" for this listed address (or the query).
  activation?: number | "q";
  // Delivery log page, and the logged email opened for its timeline.
  logPage?: number;
  openEmailId?: string;
}

// The AI credit reset in the Postiz view. Like EmailView it travels only in
// component ids and the email input: the organization is re-resolved from the
// typed address on every press, never read back from the client.
interface CreditsView {
  // What the email field shows; absent means "prefill from the conversation".
  email?: string;
  // A reset awaiting "yes": which kind, for which resolved organization.
  confirm?: { type: PostizCreditType; orgId: string; orgName: string | null; last: PostizCreditResetRow | null };
}

// A reset of the same kind this recent is called out on the confirm step.
const RECENT_RESET_DAYS = 31;

// Everything the card knows about who this conversation is with, resolved
// once per render or press.
interface CanvasContext {
  link: Awaited<ReturnType<IntercomStore["getLinkByConversationId"]>>;
  ticket: Awaited<ReturnType<TicketStore["getByThreadId"]>>;
  session: Awaited<ReturnType<SessionStore["getSession"]>>;
  nativeContact: { email: string | null; name: string | null; contactId: string | null; sourceLabel: string } | null;
  account: PostizAccount | null;
  stripeCustomerId: string | null;
  // Filled on first use by addressesFor (the customer too, for its flags).
  addresses?: string[];
  customer?: { email: string | null; delinquent: boolean } | null;
}

// How long one resolved context is reused: long enough to span an action and
// the render that follows it, short enough that Refresh always re-reads.
const CONTEXT_MEMO_MS = 5_000;

const REMOVE_WARNING =
  "Postiz mail (activation, password reset, notifications) will be sent to it again. If it still bounces or is reported as spam, Resend suppresses it again, and repeated bounces hurt delivery for every customer.";

export class IntercomInboxApp {
  private client: Client | null = null;
  private log = new Logger("intercom:canvas");
  private ctxMemo = new Map<string, { at: number; ctx: CanvasContext }>();

  constructor(
    private settingsStore: SettingsStore,
    private store: IntercomStore,
    private ticketStore: TicketStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private categoryLabelResolver: (id: string | null) => string | null,
    private billingActions: BillingActionService,
    // Reads the contact behind a conversation this bot did not create (email,
    // website, Sentry feedback): those have no Discord link to read from.
    private intercomClient?: IntercomClient,
    // Optional: the card degrades to the identity stamped on the ticket when
    // the platform lookup is off or unconfigured.
    private postizIdentity?: PostizIdentityService,
    // Resend suppression status and removal. Absent or switched off, the
    // section is simply not rendered.
    private emailDelivery?: EmailDeliverabilityService | null,
    // Posts an internal note on a conversation (bridged ones through the
    // executor's echo-safe path). Best effort: the removal is audited anyway.
    private noteWriter?: ((conversationId: string, text: string) => Promise<void>) | null,
    // The Resend delivery log (what happened to each email sent to them).
    private deliveryLog?: DeliveryLogService | null,
    // The AI credit reset. Absent, or the Postiz lookup off, the section is
    // simply not rendered.
    private postizCredits?: PostizCreditService | null
  ) {}

  // Local mirrors behind the main view's "open dispute" and "blocked" warnings.
  private badgeSources: { disputes: DisputeStore; blocks: BlockStore } | null = null;

  bindBadgeSources(sources: { disputes: DisputeStore; blocks: BlockStore }): void {
    this.badgeSources = sources;
  }

  bindClient(client: Client): void {
    this.client = client;
  }

  getClientSecret(): string | null {
    return this.settingsStore.intercomClientSecret();
  }

  async initialize(body: unknown): Promise<object> {
    return this.buildCanvas(body);
  }

  // component_id router: navigation, billing actions and email actions;
  // anything else (refresh, stale ids) re-renders the view it names.
  async submit(body: unknown): Promise<object> {
    const request = body as CanvasRequestBody;
    const componentId = typeof request?.component_id === "string" ? request.component_id : "";
    const conversationId = request?.conversation?.id ?? request?.context?.conversation_id;
    const actor = this.actorFrom(request);

    if (conversationId == null || !actor) return this.buildCanvas(body);

    try {
      if (componentId.startsWith("nav:") || componentId.startsWith("refresh:")) {
        const view = componentId.slice(componentId.indexOf(":") + 1) as View;
        if (componentId.startsWith("refresh:")) this.ctxMemo.delete(String(conversationId));
        return this.buildCanvas(body, undefined, {}, VIEWS.includes(view) ? view : "home");
      }
      if (componentId === "review_approve" || componentId === "review_deny") {
        const decision = componentId === "review_approve" ? "approve" : "deny";
        const outcome = await timeBox(
          this.billingActions.request(String(conversationId), actor, "charge_review", { decision }),
          ACTION_TIMEOUT_MS
        ).catch(() => null);
        return this.buildCanvas(body, this.noticeForRequest(outcome), {}, "billing");
      }
      if (componentId.startsWith("email_")) {
        return await this.handleEmailComponent(body, request, componentId, String(conversationId), actor);
      }
      if (componentId.startsWith("credits_")) {
        return await this.handleCreditsComponent(body, request, componentId, String(conversationId), actor);
      }
      if (componentId.startsWith("appr_ok:") || componentId.startsWith("appr_no:")) {
        const decision = componentId.startsWith("appr_ok:") ? "approve" : "reject";
        const approvalId = componentId.slice("appr_ok:".length);
        const outcome = await timeBox(
          this.billingActions.actOnApproval(approvalId, actor, decision),
          ACTION_TIMEOUT_MS
        ).catch(() => null);
        return this.buildCanvas(body, this.noticeForApproval(outcome), {}, "billing");
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

  // Who this conversation is with. A conversation is EITHER Discord-bridged
  // (this bot opened it and knows the customer from its own link table) or
  // native: email, website Messenger, or a Sentry feedback import. Native
  // conversations used to get "not bridged" and nothing else, which is
  // precisely backwards: they are the ones where nobody knows who the person
  // is. Their Intercom contact email is the identifier that resolves them
  // against the platform.
  private async resolveContext(conversationId: string): Promise<CanvasContext> {
    // An action resolves the context, acts, then renders: without this the
    // render would pay for every lookup a second time inside Intercom's short
    // response window.
    const memo = this.ctxMemo.get(conversationId);
    if (memo && Date.now() - memo.at < CONTEXT_MEMO_MS) return memo.ctx;
    const ctx = await this.resolveContextUncached(conversationId);
    if (this.ctxMemo.size > 200) this.ctxMemo.clear();
    this.ctxMemo.set(conversationId, { at: Date.now(), ctx });
    return ctx;
  }

  private async resolveContextUncached(conversationId: string): Promise<CanvasContext> {
    const link = await this.store.getLinkByConversationId(conversationId).catch(() => null);
    const ticket = link ? await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null) : null;
    const session = ticket?.customerId
      ? await this.sessionStore.getSession(ticket.customerId).catch(() => null)
      : null;
    const nativeContact = link ? null : await this.nativeContact(conversationId);
    const term = ticket?.postizUserId ?? session?.postizUserId ?? nativeContact?.email ?? null;
    const account = term ? await this.resolveAccount(term) : null;
    // Stripe customer: from the Discord link, or resolved from the contact
    // email for a native conversation.
    const stripeCustomerId =
      session?.stripeCustomerId ?? (nativeContact?.email ? await this.customerIdForEmail(nativeContact.email) : null);
    return { link, ticket, session, nativeContact, account, stripeCustomerId };
  }

  // The addresses this person is known by, in the order support reads them:
  // the one they wrote from, the one Postiz sends to, the one Stripe bills.
  private async addressesFor(ctx: CanvasContext): Promise<string[]> {
    if (ctx.addresses) return ctx.addresses;
    ctx.customer = ctx.stripeCustomerId
      ? await timeBox(this.stripe.getCustomer(ctx.stripeCustomerId), FETCH_TIMEOUT_MS)
          .then((c) => (c ? { email: c.email ?? null, delinquent: c.delinquent === true } : null))
          .catch(() => null)
      : null;
    ctx.addresses = distinctEmails([ctx.nativeContact?.email, ctx.account?.email, ctx.customer?.email]);
    return ctx.addresses;
  }

  private async buildCanvas(
    body: unknown,
    notice?: string,
    emailView: EmailView = {},
    view: View = "home",
    creditsView: CreditsView = {}
  ): Promise<object> {
    const request = body as CanvasRequestBody;
    const conversationId = request?.conversation?.id ?? request?.context?.conversation_id;
    if (conversationId == null) return canvas([text("No conversation context.")]);

    const ctx = await this.resolveContext(String(conversationId));
    const components: CanvasComponent[] = [];
    if (notice) components.push(text(notice), divider());

    switch (view) {
      case "postiz":
        components.push(...(await this.postizView(ctx)), ...this.creditsSection(ctx, creditsView));
        break;
      case "email":
        components.push(...(await this.emailView(ctx, emailView)));
        break;
      case "billing":
        components.push(...(await this.billingView(ctx, String(conversationId))));
        break;
      case "discord":
        components.push(...(await this.discordView(ctx)));
        break;
      default:
        components.push(...(await this.homeView(ctx, String(conversationId))));
        return canvas(components);
    }
    components.push(divider(), button("nav:home", "Back", "secondary"), button(`refresh:${view}`, "Refresh", "secondary"));
    return canvas(components);
  }

  // ---- views ----

  // Who, and what is wrong right now. Every warning is computed from data the
  // other views also show, so a badge never says something a view cannot back.
  private async homeView(ctx: CanvasContext, conversationId: string): Promise<CanvasComponent[]> {
    const addresses = await this.addressesFor(ctx);
    const emailOn = this.emailDelivery?.enabled() === true;
    const [subs, statuses, lastProblem, review, approvals, disputes, blocks] = await Promise.all([
      ctx.stripeCustomerId
        ? timeBox(this.stripe.listSubscriptions(ctx.stripeCustomerId), FETCH_TIMEOUT_MS).catch(() => null)
        : Promise.resolve(null),
      emailOn ? this.emailDelivery!.statusFor(addresses) : Promise.resolve([] as DeliveryStatus[]),
      emailOn ? this.lastProblemEmail(addresses) : Promise.resolve(null),
      ctx.link ? this.sessionStore.getPendingChargeReview(ctx.link.ticketThreadId).catch(() => null) : Promise.resolve(null),
      this.billingActions.pendingForConversation(conversationId, 10).catch(() => []),
      ctx.stripeCustomerId && this.badgeSources
        ? this.badgeSources.disputes.listByCustomer(ctx.stripeCustomerId, 10).catch(() => [])
        : Promise.resolve([]),
      ctx.stripeCustomerId && this.badgeSources
        ? this.badgeSources.blocks.listForCustomer(ctx.stripeCustomerId, ctx.customer?.email ?? null).catch(() => [])
        : Promise.resolve([]),
    ]);

    const who =
      ctx.account?.name ?? ctx.nativeContact?.name ?? ctx.ticket?.customerDisplayName ?? ctx.account?.email ?? ctx.nativeContact?.email ?? "Unknown person";
    const whoEmail = ctx.account?.email ?? ctx.nativeContact?.email ?? addresses[0] ?? null;
    const plan = ctx.account?.tier ?? ctx.ticket?.postizTier ?? null;
    const subStatus = subs == null ? (ctx.stripeCustomerId ? "unavailable" : null) : subscriptionSummary(subs);
    const identity = [
      whoEmail && whoEmail !== who ? `${who} · ${whoEmail}` : who,
      [plan ? `Postiz ${plan}` : "no Postiz plan", subStatus ? `Stripe ${subStatus}` : "no Stripe customer"].join(" · "),
    ];

    const warnings: string[] = [];
    for (const st of statuses) if (st.state === "suppressed") warnings.push(`⛔ Email suppressed: ${st.email}`);
    if (lastProblem) {
      warnings.push(`⚠️ Last email ${eventLabel(lastProblem.lastEvent).toLowerCase()}: ${categoryLabel(lastProblem.category)} to ${lastProblem.recipient}`);
    }
    if (ctx.customer?.delinquent) warnings.push("⚠️ Delinquent: an invoice is unpaid");
    if (blocks.length) warnings.push("⛔ Blocked from buying");
    const open = disputes.filter((d) => OPEN_DISPUTE.has(d.status));
    if (open.length) warnings.push(`⚠️ Open dispute${open.length > 1 ? `s (${open.length})` : ""}`);
    if (review) warnings.push("⚠️ Refund review pending");
    if (approvals.length) warnings.push(`📋 ${approvals.length} approval${approvals.length > 1 ? "s" : ""} pending`);

    const components: CanvasComponent[] = [header(`👤 ${identity[0]}`), text(identity[1])];
    if (warnings.length) components.push(...warnings.map((w) => ({ type: "text", text: w, style: "paragraph" })));
    components.push(
      divider(),
      button("nav:postiz", "Postiz Account", "secondary"),
      ...(this.emailDelivery?.enabled() ? [button("nav:email", "E-Mail Deliverability", "secondary")] : []),
      button("nav:billing", "Billing", "secondary"),
      ...(ctx.ticket || ctx.link ? [button("nav:discord", "Discord Ticket", "secondary")] : []),
      button("refresh:home", "Refresh", "secondary")
    );
    return components;
  }

  private async postizView(ctx: CanvasContext): Promise<CanvasComponent[]> {
    return this.postizSection(
      {
        stampedUserId: ctx.ticket?.postizUserId ?? ctx.session?.postizUserId ?? null,
        email: ctx.nativeContact?.email ?? null,
        stamped: ctx.ticket,
      },
      { account: ctx.account }
    );
  }

  private async emailView(ctx: CanvasContext, view: EmailView): Promise<CanvasComponent[]> {
    if (!this.emailDelivery?.enabled()) return [header("📧 Email delivery"), text("Resend is not enabled (/config → Integrations → Resend).")];
    const addresses = await this.addressesFor(ctx);
    if (view.openEmailId) return this.emailDetail(view.openEmailId, view.logPage ?? 0);
    return [...(await this.emailSection(addresses, view)), ...(await this.deliveryLogSection(addresses, view.logPage ?? 0))];
  }

  private async billingView(ctx: CanvasContext, conversationId: string): Promise<CanvasComponent[]> {
    const components: CanvasComponent[] = [];
    if (ctx.stripeCustomerId) components.push(...(await this.billingSection(ctx.stripeCustomerId)));
    else components.push(header("💳 Billing"), text("No linked Stripe customer."));
    if (ctx.link) components.push(...(await this.chargeReviewSection(ctx.link.ticketThreadId)));
    components.push(...(await this.approvalsSection(conversationId)));
    return components;
  }

  private async discordView(ctx: CanvasContext): Promise<CanvasComponent[]> {
    const { ticket, link, nativeContact } = ctx;
    if (!ticket && !link) {
      return [header("🎫 Discord ticket"), text(`${nativeContact?.sourceLabel ?? "Native Intercom conversation"} · no Discord ticket.`)];
    }
    const components: CanvasComponent[] = [header("🎫 Discord ticket")];
    if (ticket) {
      const who = ticket.customerDisplayName ?? ticket.customerId ?? "unknown";
      const category = this.categoryLabelResolver(ticket.categoryId);
      components.push(
        dataRow("Customer", category ? `${who} · ${category}` : who),
        ...(ticket.csatScore != null ? [dataRow("CSAT", `${ticket.csatScore}/5`)] : [])
      );
    }
    const threadUrl = link ? await this.threadUrl(link.ticketThreadId) : null;
    if (threadUrl) {
      components.push({
        type: "button",
        id: "open_thread",
        label: "Open Discord thread",
        style: "secondary",
        action: { type: "url", url: threadUrl },
      });
    }
    return components;
  }

  // The newest logged email to any of these addresses, when it went wrong.
  private async lastProblemEmail(addresses: string[]): Promise<LoggedEmail | null> {
    if (!this.deliveryLog || !addresses.length) return null;
    const latest = await Promise.all(
      addresses.map((a) => this.deliveryLog!.historyFor(a, 0, 1).then((r) => r.rows[0] ?? null).catch(() => null))
    );
    const newest = latest
      .filter((r): r is LoggedEmail => r != null)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];
    return newest && PROBLEM_EVENTS.has(newest.lastEvent) ? newest : null;
  }

  // Guardrail-blocked refund awaiting review: amount/charge/reason rows +
  // Approve/Deny. Agents route through the approval queue; configured admins
  // execute directly (BillingActionService decides; these buttons only
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
  // the panel shows the rest). Approve/Reject act via BillingActionService:
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
    if (pending.length > 3) components.push(text(`…more on the web panel's Approvals page.`));
    return components;
  }

  // Contact behind a conversation this bot did not create. Time-boxed like
  // every other fetch on this card.
  private async nativeContact(
    conversationId: string
  ): Promise<{ email: string | null; name: string | null; contactId: string | null; sourceLabel: string } | null> {
    if (!this.intercomClient) return null;
    const contact = await timeBox(this.intercomClient.getConversationContact(conversationId), FETCH_TIMEOUT_MS).catch(
      (e) => {
        this.log.warn("conversation contact fetch failed", { error: e instanceof Error ? e.message : String(e) });
        return null;
      }
    );
    if (!contact) return null;
    return { ...contact, sourceLabel: "Intercom conversation" };
  }

  // Email to Stripe customer, for native conversations that have no Discord
  // link to read the customer from. Ambiguity is refused rather than guessed:
  // showing the wrong person's billing is worse than showing none.
  private async customerIdForEmail(email: string): Promise<string | null> {
    const found = await timeBox(this.stripe.findCustomersByEmail(email), FETCH_TIMEOUT_MS).catch((e) => {
      this.log.warn("stripe email lookup failed", { error: e instanceof Error ? e.message : String(e) });
      return [] as Array<{ id: string }>;
    });
    return found.length === 1 ? found[0].id : null;
  }

  // Who this conversation is with, on the Postiz platform.
  //
  // Two ways in: a Discord-bridged ticket carries the account id stamped at
  // creation, while a native conversation (email, website, Sentry feedback)
  // only has its Intercom contact email. The email path is the whole point of
  // this section: before the platform exposed a search, an emailed-in customer
  // was simply anonymous to us.
  //
  // The stamped id decides WHICH account; the live lookup supplies email,
  // names and the CURRENT tier, keeping this card's "fetched at render time"
  // rule. A lookup that is off, slow or failing degrades to whatever the
  // ticket already recorded rather than dropping the section.
  private async resolveAccount(term: string): Promise<PostizAccount | null> {
    if (!this.postizIdentity) return null;
    return timeBox(this.postizIdentity.resolve(term), FETCH_TIMEOUT_MS).catch((e) => {
      this.log.warn("postiz lookup failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    });
  }

  // `pre` carries an account the caller already resolved for the same term,
  // so one render never asks the platform twice.
  private async postizSection(
    input: {
      stampedUserId: string | null;
      email: string | null;
      stamped: { postizOrgId: string | null; postizTier: string | null; postizRole: string | null } | null;
    },
    pre?: { account: PostizAccount | null }
  ): Promise<CanvasComponent[]> {
    const term = input.stampedUserId ?? input.email;
    if (!term) return [header("👤 Postiz account"), text("Not identified: no linked account and no contact email.")];

    const components: CanvasComponent[] = [header("👤 Postiz account")];
    const account = pre ? pre.account : await this.resolveAccount(term);

    if (account) {
      components.push(
        dataRow("User ID", account.userId),
        ...(account.email ? [dataRow("Email", account.email)] : []),
        dataRow("Organization", account.orgName ? `${account.orgName} (${account.orgId})` : account.orgId),
        dataRow("Plan", `${account.tier ?? "none"}${account.role ? ` · ${account.role}` : ""}`)
      );
      // The tier the platform reports NOW versus the one recorded when the
      // ticket opened: that gap is the drift the billing panel can repair.
      if (input.stamped?.postizTier && account.tier && input.stamped.postizTier !== account.tier) {
        components.push(dataRow("Plan at ticket open", input.stamped.postizTier));
      }
      return components;
    }

    // Degraded: everything known without the platform.
    if (input.stampedUserId) {
      components.push(dataRow("User ID", input.stampedUserId));
      if (input.stamped?.postizOrgId) components.push(dataRow("Organization", input.stamped.postizOrgId));
      if (input.stamped?.postizTier) {
        components.push(dataRow("Plan (at ticket open)", `${input.stamped.postizTier}${input.stamped.postizRole ? ` · ${input.stamped.postizRole}` : ""}`));
      }
    } else if (input.email) {
      components.push(dataRow("Email", input.email));
    }
    components.push(dataRow("Live lookup", this.postizIdentity ? "unavailable" : "not configured"));
    return components;
  }

  // ---- AI credit reset (Postiz platform) ----

  // Prefilled with who this conversation resolved to; the teammate can point
  // it at any other account. What the reset will hit is only ever shown after
  // the server resolved the typed address (the confirm step).
  private creditsSection(ctx: CanvasContext, view: CreditsView): CanvasComponent[] {
    if (!this.postizCredits?.enabled()) return [];
    const email = view.email ?? ctx.account?.email ?? ctx.nativeContact?.email ?? "";
    const components: CanvasComponent[] = [
      divider(),
      header("✨ AI credits"),
      text("Gives the organization its AI images or videos for this billing period back. It cannot be undone."),
      {
        type: "input",
        id: "credits_email",
        label: "Postiz account email",
        placeholder: "customer@example.com",
        ...(email ? { value: email } : {}),
      },
    ];
    if (!view.confirm) {
      components.push(
        button("credits_ask:ai_images", "Reset AI image credits", "secondary"),
        button("credits_ask:ai_videos", "Reset AI video credits", "secondary")
      );
      return components;
    }
    const { type, orgId, orgName, last } = view.confirm;
    const label = CREDIT_LABELS[type];
    components.push(
      text(`Reset ${label} credits for ${orgLabel({ orgId, orgName })}? Everything generated this billing period stops counting against the plan.`),
      last ? lastResetLine(last) : text(`No earlier ${label} credit reset is recorded for this organization.`),
      button(`credits_do:${type}:${orgId}`, `Yes, reset ${label} credits`, "primary"),
      button("credits_cancel", "Cancel", "secondary")
    );
    return components;
  }

  // Every credits_* press. Which organization is re-derived from the typed
  // address on every press; the id in "credits_do" is only what the teammate
  // confirmed, and the reset refuses when the address resolves elsewhere now.
  private async handleCreditsComponent(
    body: unknown,
    request: CanvasRequestBody,
    componentId: string,
    conversationId: string,
    actor: ActionActor
  ): Promise<object> {
    const svc = this.postizCredits;
    const typed = typeof request.input_values?.["credits_email"] === "string" ? String(request.input_values["credits_email"]).trim() : "";
    const inPostiz = (notice: string | undefined, view: CreditsView = { email: typed }) =>
      this.buildCanvas(body, notice, {}, "postiz", view);
    if (!svc?.enabled()) return inPostiz("⚠️ The Postiz lookup is off or not configured (/config → Integrations → Postiz).");

    if (componentId.startsWith("credits_ask:")) {
      const type = componentId.slice("credits_ask:".length);
      if (!isPostizCreditType(type)) return inPostiz(undefined);
      const target = await timeBox(svc.target(typed), FETCH_TIMEOUT_MS).catch(() => null);
      if (!target) return inPostiz("⏳ Postiz did not answer in time. Try again.");
      if (target.kind !== "one") return inPostiz(`⚠️ ${describeTarget(target, typed)}`);
      const last = await svc.lastReset(target.orgId, type);
      return inPostiz(undefined, { email: typed, confirm: { type, orgId: target.orgId, orgName: target.orgName, last } });
    }

    if (componentId.startsWith("credits_do:")) {
      const rest = componentId.slice("credits_do:".length);
      const split = rest.indexOf(":");
      const type = split > 0 ? rest.slice(0, split) : "";
      const orgId = split > 0 ? rest.slice(split + 1) : "";
      if (!isPostizCreditType(type) || !orgId) return inPostiz(undefined);
      const label = CREDIT_LABELS[type];
      // The note is chained to the reset itself, not to this wait: a reset
      // that outlives the response window still leaves its note.
      const run = svc.reset({ email: typed, type, expectOrgId: orgId, actor: { id: actor.id, name: actor.name }, conversationId }).then((outcome) => {
        if (outcome.ok) {
          void this.noteWriter?.(
            conversationId,
            `${actor.name} reset the ${label} credits of ${orgLabel(outcome)} for this billing period${restoredText(outcome.restored)}.`
          ).catch((e) => this.log.warn("credit reset note failed", { error: e instanceof Error ? e.message : String(e) }));
        }
        return outcome;
      });
      const outcome = await timeBox(run, ACTION_TIMEOUT_MS).catch(() => null);
      if (!outcome) return inPostiz("⏳ Still processing. Press Refresh in a few seconds.");
      if (!outcome.ok) return inPostiz(`⚠️ ${outcome.error}`);
      return inPostiz(`✅ Reset the ${label} credits of ${orgLabel(outcome)}${restoredText(outcome.restored)}.`);
    }

    // credits_cancel, and any stale id: back to the buttons, field kept.
    return inPostiz(undefined);
  }

  // ---- email delivery (Resend suppression list) ----

  private describeStatus(st: DeliveryStatus): string {
    if (st.state === "suppressed") return `⛔ ${describeSuppression(st.suppression, st.source)}`;
    if (st.state === "clear") return "✅ deliverable, not on the suppression list";
    return `⚠️ unknown (${st.error})`;
  }

  private async emailSection(addresses: string[], view: EmailView): Promise<CanvasComponent[]> {
    const svc = this.emailDelivery!;
    const components: CanvasComponent[] = [divider(), header("📧 Email delivery (Resend)")];
    const statuses = await svc.statusFor(addresses);
    if (!statuses.length) components.push(text("No email address is known for this person."));
    statuses.forEach((st, i) => {
      components.push(dataRow(st.email, this.describeStatus(st)));
      if (st.state === "suppressed") {
        if (view.confirm === i) {
          components.push(
            text(`Remove ${st.email} from the suppression list? ${REMOVE_WARNING}`),
            button(`email_rmx:${i}`, "Yes, remove it", "primary"),
            button("email_cancel", "Cancel", "secondary")
          );
        } else {
          components.push(button(`email_rm:${i}`, "Remove from suppression list", "secondary"));
        }
      }
      if (view.activation === i) components.push(button(`email_act:${i}`, "Resend activation email", "secondary"));
    });

    if (!view.checkOpen) {
      components.push(button("email_check_open", "Check another address", "secondary"));
      return components;
    }
    components.push(
      {
        type: "input",
        id: "email_query",
        label: "Any email address",
        placeholder: "customer@example.com",
        ...(view.query ? { value: view.query } : {}),
      },
      button("email_check", "Check", "secondary")
    );
    if (view.query) {
      const st = await svc.statusOf(view.query);
      components.push(dataRow(st.email, this.describeStatus(st)));
      if (st.state === "suppressed") {
        if (view.confirmQuery) {
          components.push(
            text(`Remove ${st.email} from the suppression list? ${REMOVE_WARNING}`),
            button("email_rmx_q", "Yes, remove it", "primary"),
            button("email_cancel", "Cancel", "secondary")
          );
        } else {
          components.push(button("email_rm_q", "Remove from suppression list", "secondary"));
        }
      }
      if (view.activation === "q") components.push(button("email_act_q", "Resend activation email", "secondary"));
    }
    return components;
  }

  // Every logged email to this person's addresses, newest first, a page at a
  // time; a dropdown opens one for its event timeline.
  private async deliveryLogSection(addresses: string[], page: number): Promise<CanvasComponent[]> {
    const components: CanvasComponent[] = [divider(), header("📬 Delivery log")];
    if (!this.deliveryLog) return [...components, text("Not available on this instance.")];
    if (!this.deliveryLog.webhookRegistered()) {
      components.push(text("Not collecting: an admin can register the webhook in /config → Integrations → Resend."));
    }
    const history = await timeBox(this.deliveryLog.historyForMany(addresses, page, LOG_PAGE_SIZE), FETCH_TIMEOUT_MS).catch(() => null);
    if (!history) return [...components, text("Unavailable right now.")];
    if (!history.rows.length) return [...components, text("No email to these addresses in the last 180 days.")];
    const pages = Math.max(1, Math.ceil(history.total / LOG_PAGE_SIZE));
    const current = Math.min(page, pages - 1);
    components.push(text(`${history.total} email${history.total === 1 ? "" : "s"}${pages > 1 ? ` · page ${current + 1}/${pages}` : ""}`));
    for (const r of history.rows) components.push(dataRow(logWhen(r.sentAt), logSummary(r, addresses.length > 1)));
    components.push(
      {
        type: "dropdown",
        id: "email_pick",
        label: "Open an email",
        options: history.rows.map((r) => ({
          type: "option",
          id: r.id,
          text: `${logWhen(r.sentAt)} ${categoryLabel(r.category)}: ${eventLabel(r.lastEvent)}`.slice(0, 100),
        })),
      },
      button(`email_open:${current}`, "Open", "secondary")
    );
    if (current > 0) components.push(button(`email_logp:${current - 1}`, "Newer", "secondary"));
    if (current < pages - 1) components.push(button(`email_logp:${current + 1}`, "Older", "secondary"));
    return components;
  }

  private async emailDetail(emailId: string, page: number): Promise<CanvasComponent[]> {
    const found = this.deliveryLog ? await timeBox(this.deliveryLog.email(emailId), FETCH_TIMEOUT_MS).catch(() => null) : null;
    const back = button(`email_logp:${page}`, "Back to the log", "secondary");
    if (!found) return [header("✉️ Email"), text("That email is not in the delivery log anymore."), back];
    const { email: m, events } = found;
    return [
      header(`✉️ ${m.subject ?? "(no subject)"}`),
      dataRow("To", m.recipient),
      dataRow("Kind", categoryLabel(m.category)),
      dataRow("Status", eventLabel(m.lastEvent)),
      dataRow("Sent", `${logWhen(m.sentAt)} UTC`),
      ...(m.detail ? [dataRow("Reason", m.detail)] : []),
      header("Timeline"),
      ...(events.length
        ? events.map((e) => text(`${logWhen(e.occurredAt)} ${eventLabel(e.type)}${e.detail ? `: ${e.detail.slice(0, 160)}` : ""}`))
        : [text(m.source === "backfill" ? "Imported from Resend's history: only the last status is known." : "No events stored.")]),
      back,
    ];
  }

  // Every email_* press. Which address a button means is re-derived here from
  // the conversation (listed addresses) or read from the input the teammate
  // typed into (checked ones), never trusted from anything else.
  private async handleEmailComponent(
    body: unknown,
    request: CanvasRequestBody,
    componentId: string,
    conversationId: string,
    actor: ActionActor
  ): Promise<object> {
    const svc = this.emailDelivery;
    if (!svc?.enabled()) return this.buildCanvas(body, "⚠️ Resend is not enabled (/config → Integrations → Resend).");
    const inEmail = (notice: string | undefined, v: EmailView) => this.buildCanvas(body, notice, v, "email");
    const typed = typeof request.input_values?.["email_query"] === "string" ? String(request.input_values["email_query"]).trim() : "";
    const query = typed && EMAIL_RE.test(typed) ? typed : undefined;

    if (componentId === "email_check_open") return inEmail(undefined, { checkOpen: true });
    if (componentId === "email_cancel") return inEmail(undefined, { checkOpen: !!typed, query });
    if (componentId === "email_check") {
      if (!query) return inEmail("⚠️ That is not an email address.", { checkOpen: true });
      return inEmail(undefined, { checkOpen: true, query });
    }
    if (componentId === "email_rm_q") {
      if (!query) return inEmail("⚠️ That is not an email address.", { checkOpen: true });
      return inEmail(undefined, { checkOpen: true, query, confirmQuery: true });
    }
    if (componentId.startsWith("email_rm:")) {
      const index = Number(componentId.slice("email_rm:".length));
      return inEmail(undefined, { confirm: Number.isInteger(index) ? index : -1 });
    }

    if (componentId.startsWith("email_logp:")) {
      return inEmail(undefined, { logPage: Math.max(0, Number(componentId.slice("email_logp:".length)) || 0) });
    }
    if (componentId.startsWith("email_open:")) {
      // The dropdown's pick; which page to return to rides in the id.
      const picked = typeof request.input_values?.["email_pick"] === "string" ? String(request.input_values["email_pick"]) : "";
      const page = Math.max(0, Number(componentId.slice("email_open:".length)) || 0);
      if (!picked) return inEmail("⚠️ Pick an email first.", { logPage: page });
      return inEmail(undefined, { logPage: page, openEmailId: picked });
    }

    // The presses that act: resolve who, then which address.
    const ctx = await this.resolveContext(conversationId);
    const addresses = await this.addressesFor(ctx);
    const pick = (id: string, prefix: string): { email: string | undefined; slot: number | "q" } => {
      if (id === `${prefix}_q`) return { email: query, slot: "q" };
      const index = Number(id.slice(`${prefix}:`.length));
      return { email: Number.isInteger(index) ? addresses[index] : undefined, slot: index };
    };
    const keepCheck = { checkOpen: !!typed, query };

    if (componentId.startsWith("email_rmx")) {
      const { email, slot } = pick(componentId, "email_rmx");
      if (!email) return inEmail("⚠️ That address is no longer on this card; nothing was removed.", keepCheck);
      const result = await timeBox(
        svc.remove(email, { surface: "intercom", id: actor.id, name: actor.name }, { conversationId }),
        ACTION_TIMEOUT_MS
      ).catch(() => null);
      if (!result) return inEmail("⏳ Still processing. Press Refresh in a few seconds.", keepCheck);
      if (result.kind === "not_suppressed") {
        return inEmail(`ℹ️ ${email} was not on the suppression list; nothing to remove.`, keepCheck);
      }
      if (result.kind !== "removed") {
        const why = result.kind === "error" || result.kind === "invalid" ? result.error : "Resend is not enabled.";
        return inEmail(`⚠️ ${why}`, keepCheck);
      }
      const was = result.previous ? describeSuppression(result.previous, null) : "suppressed";
      void this.noteWriter?.(
        conversationId,
        `${actor.name} removed ${email} from the Resend suppression list (it was ${was}). Postiz emails will be delivered to it again; a new bounce or spam complaint suppresses it again.`
      ).catch((e) => this.log.warn("suppression note failed", { error: e instanceof Error ? e.message : String(e) }));
      // The usual reason this mattered: the activation mail never arrived.
      const account = ctx.account?.email?.toLowerCase() === email.toLowerCase() ? ctx.account : slot === "q" ? await this.resolveAccount(email) : null;
      const offer = account?.userActivated === false && account.email?.toLowerCase() === email.toLowerCase();
      return inEmail(`✅ Removed ${email} from the suppression list. New mail from Postiz will be delivered to it.${
          offer ? " Their Postiz account is not activated yet: resend the activation email below." : ""
        }`, { ...keepCheck, ...(offer ? { activation: slot } : {}) });
    }

    if (componentId.startsWith("email_act")) {
      const { email } = pick(componentId, "email_act");
      if (!email) return inEmail("⚠️ That address is no longer on this card.", keepCheck);
      const sent = await timeBox(
        svc.resendActivation(email, { surface: "intercom", id: actor.id, name: actor.name }),
        ACTION_TIMEOUT_MS
      ).catch(() => ({ ok: false as const, error: "Postiz did not answer in time." }));
      if (sent.ok) {
        void this.noteWriter?.(conversationId, `${actor.name} asked Postiz to resend the activation email to ${email}.`).catch(() => {});
      }
      return inEmail(sent.ok ? `✅ Postiz is sending a new activation email to ${email}.` : `⚠️ ${sent.error}`, keepCheck);
    }
    return inEmail(undefined, keepCheck);
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
      // Identical rows are common (a customer can hold several copies of the
      // same plan, and a retried payment repeats verbatim). Rendering each one
      // buries the card in duplicates, so they collapse to one row with a
      // count.
      for (const row of collapse(
        subs.map((sub) => {
          const item = sub.items.data[0];
          const price = item?.price;
          const label = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
          const periodEnd = item?.current_period_end
            ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10)
            : null;
          const flags = [
            sub.status,
            periodEnd ? `ends ${periodEnd}` : null,
            sub.pause_collection ? "⏸ paused" : null,
            sub.cancel_at_period_end ? "cancels at period end" : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return { label, value: flags };
        }),
        3
      )) {
        components.push(dataRow(row.label, row.value));
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
      for (const row of collapse(
        recent.charges.map((charge) => {
          const state = charge.refunded ? "refunded" : (charge.amount_refunded ?? 0) > 0 ? "partial refund" : charge.status;
          return {
            label: this.stripe.formatAmount(charge.amount, charge.currency),
            value: `${state} · ${new Date(charge.created * 1000).toISOString().slice(0, 10)}`,
          };
        }),
        3
      )) {
        components.push(dataRow(row.label, row.value));
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

const OPEN_DISPUTE = new Set(["needs_response", "warning_needs_response", "under_review", "warning_under_review"]);

// "active", "2 active", "past_due, 1 canceled": what Stripe says, briefly.
function subscriptionSummary(subs: Stripe.Subscription[]): string {
  if (!subs.length) return "no subscription";
  const counts = new Map<string, number>();
  for (const sub of subs) counts.set(sub.status, (counts.get(sub.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => (n > 1 ? `${n} ${status}` : status)).join(", ");
}

// ": 14 credits restored", or nothing when the platform did not say.
function restoredText(restored: number | null): string {
  if (restored == null) return "";
  return `: ${restored} credit${restored === 1 ? "" : "s"} restored`;
}

// The confirm step's record of the last reset of the same kind, flagged when
// it is recent enough that this one is probably a repeat.
function lastResetLine(last: PostizCreditResetRow): CanvasComponent {
  const days = Math.max(0, Math.floor((Date.now() - last.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const line = `Last reset ${when} (${logWhen(last.createdAt)} UTC) by ${last.actorName}${restoredText(last.restored)}.`;
  return days < RECENT_RESET_DAYS ? { type: "text", text: `⚠️ ${line}`, style: "paragraph" } : text(line);
}

function logWhen(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function logSummary(r: LoggedEmail, showRecipient: boolean): string {
  const status = PROBLEM_EVENTS.has(r.lastEvent) ? `⚠️ ${eventLabel(r.lastEvent)}` : eventLabel(r.lastEvent);
  return `${categoryLabel(r.category)} · ${status}${showRecipient ? ` · ${r.recipient}` : ""}`;
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
  // Canvas Kit bold is SINGLE-asterisk (like header() above): `**x**` renders
  // as a bold x wrapped in literal asterisks.
  return { type: "text", text: `*${label}:* ${value}`, style: "paragraph" };
}

function divider(): CanvasComponent {
  return { type: "divider" };
}

// Button labels are plain text: no emoji (house rule), the section header
// carries the icon.
function button(id: string, label: string, style: "primary" | "secondary"): CanvasComponent {
  return { type: "button", id, label, style, action: { type: "submit" } };
}

// Folds identical label/value pairs into one row carrying a count, keeps the
// first `limit` distinct rows, and says how many were left off. Three retries
// of the same failed charge should read as one line, not three.
export function collapse(
  rows: Array<{ label: string; value: string }>,
  limit: number
): Array<{ label: string; value: string }> {
  const seen = new Map<string, { label: string; value: string; count: number }>();
  for (const row of rows) {
    const key = `${row.label}\u0000${row.value}`;
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { ...row, count: 1 });
  }
  const distinct = [...seen.values()];
  const shown = distinct.slice(0, limit).map((r) => ({
    label: r.label,
    value: r.count > 1 ? `${r.value} (×${r.count})` : r.value,
  }));
  const hidden = distinct.length - shown.length;
  if (hidden > 0) shown.push({ label: "…", value: `${hidden} more not shown` });
  return shown;
}

function timeBox<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
