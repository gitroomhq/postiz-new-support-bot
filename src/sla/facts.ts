import type Stripe from "stripe";
import { TicketStore } from "../bot/TicketStore";
import { IntercomStore } from "../intercom/IntercomStore";
import { IntercomClient } from "../intercom/IntercomClient";
import { SessionStore } from "../auth/SessionStore";
import { DisputeStore } from "../bot/billing/DisputeStore";
import { StripeClient } from "../bot/StripeClient";
import { SettingsStore } from "../config/SettingsStore";
import { SlaDim, SlaFacts, SlaStripeFacts } from "./types";
import { log } from "../util/logger";

const factsLog = log.child("sla:facts");

// Loads the SlaFacts for one subject. Expensive sources are gated by the
// referenced-dimension set the rule store precomputes: no enabled rule uses a
// stripe.* dim → zero Stripe work; none uses an Intercom-API dim → zero
// Intercom GETs for bridged tickets (native conversations always need the one
// GET — it is also their open/tags/text source).
//
// Stripe API results are cached per customer for 15 minutes (negative results
// too) and every call is time-boxed; on timeout/error the stripe facts carry
// `unavailable` so stripe.* conditions (except linked) evaluate false rather
// than blocking or hammering Stripe.

const STRIPE_CACHE_TTL_MS = 15 * 60 * 1000;
const STRIPE_CALL_TIMEOUT_MS = 5_000;
const STRIPE_TOTAL_BUDGET_MS = 10_000;
const SPEND_MAX_PAGES = 3;

// Dispute statuses that count as "open" for stripe.dispute.
const OPEN_DISPUTE_STATUSES = new Set([
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
]);

interface StripeApiCacheEntry {
  fetchedAt: number;
  unavailable: boolean;
  paying?: boolean;
  planKeys?: string[];
  spendMajor?: number;
  truncatedSpend?: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.()),
  ]);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const STRIPE_API_DIMS: SlaDim[] = ["stripe.paying", "stripe.plan", "stripe.spend"];
const INTERCOM_API_DIMS: SlaDim[] = ["intercom.team", "intercom.tag", "intercom.ticket_type"];

export class SlaFactsLoader {
  private stripeCache = new Map<string, StripeApiCacheEntry>();

  constructor(
    private ticketStore: TicketStore,
    private intercomStore: IntercomStore,
    private intercomClient: IntercomClient,
    private sessionStore: SessionStore,
    private disputeStore: DisputeStore,
    private stripe: StripeClient,
    private settingsStore: SettingsStore
  ) {}

  invalidateStripeCustomer(stripeCustomerId: string): void {
    this.stripeCache.delete(stripeCustomerId);
  }

  // Facts for a bridged Discord ticket. Returns null when the ticket row is
  // gone. `conversationId`/`ticketId` are echoed back so the caller can write
  // without a second link lookup.
  async forBridged(
    threadId: string,
    referenced: Set<SlaDim>
  ): Promise<{ facts: SlaFacts; conversationId: string | null; ticketId: string | null } | null> {
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return null;
    const link = await this.intercomStore.getLink(threadId);

    const facts: SlaFacts = {
      kind: "bridged",
      categoryId: ticket.categoryId ?? undefined,
      statusTagId: ticket.statusTagId ?? undefined,
      tierId: ticket.escalationTierId ?? undefined,
      open: !ticket.closed,
      exempt: ticket.intercomExempt,
      mirrored: !!link,
      text: ticket.question ?? undefined,
    };

    if ([...referenced].some((d) => d.startsWith("stripe."))) {
      facts.stripe = ticket.customerId
        ? await this.stripeFacts(ticket.customerId, threadId, referenced)
        : { linked: false };
    }

    if ([...referenced].some((d) => d.startsWith("intercom."))) {
      const intercom: SlaFacts["intercom"] = {
        kind: link?.ticketId ? "ticket" : "conversation",
        ticketTypeId: this.settingsStore.intercomTicketTypeIdFor(ticket.categoryId) ?? null,
      };
      const needsApi = link?.conversationId && [...referenced].some((d) => INTERCOM_API_DIMS.includes(d));
      if (needsApi) {
        try {
          const conv = await this.intercomClient.getConversationSlaFacts(link!.conversationId!);
          if (conv) {
            intercom.teamId = conv.teamAssigneeId;
            intercom.teamName = conv.teamAssigneeId
              ? await this.intercomClient.getTeamNameCached(conv.teamAssigneeId).catch(() => null)
              : null;
            intercom.tags = conv.tags;
          }
        } catch (e) {
          factsLog.warn("sla.facts.intercom_fetch_failed", {
            "ticket.thread_id": threadId,
            "error.message": e instanceof Error ? e.message : String(e),
          });
          // team/tags stay undefined → those conditions evaluate false
        }
      }
      facts.intercom = intercom;
    }

    return { facts, conversationId: link?.conversationId ?? null, ticketId: link?.ticketId ?? null };
  }

  // Facts for a native Intercom conversation (no Discord ticket). Returns null
  // when the conversation doesn't exist (deleted). The single conversation GET
  // also provides open-state, current attribute value and sla_applied, which
  // the service uses for gating/preview.
  async forNative(conversationId: string): Promise<{
    facts: SlaFacts;
    open: boolean;
    customAttributes: Record<string, unknown>;
    slaApplied: { name: string; status: string | null } | null;
  } | null> {
    const conv = await this.intercomClient.getConversationSlaFacts(conversationId);
    if (!conv) return null;
    const teamName = conv.teamAssigneeId
      ? await this.intercomClient.getTeamNameCached(conv.teamAssigneeId).catch(() => null)
      : null;
    const facts: SlaFacts = {
      kind: "native",
      intercom: {
        teamId: conv.teamAssigneeId,
        teamName,
        kind: conv.ticketId ? "ticket" : "conversation",
        ticketTypeId: null,
        tags: conv.tags,
      },
      text: conv.sourceBody ? stripHtml(conv.sourceBody) : undefined,
    };
    return { facts, open: conv.open, customAttributes: conv.customAttributes, slaApplied: conv.slaApplied };
  }

  // ---- Stripe ----

  private async stripeFacts(
    discordCustomerId: string,
    threadId: string,
    referenced: Set<SlaDim>
  ): Promise<SlaStripeFacts> {
    const session = await this.sessionStore.getSession(discordCustomerId).catch(() => null);
    const cus = session?.stripeCustomerId ?? null;
    if (!cus) return { linked: false };

    const out: SlaStripeFacts = { linked: true };

    // Local-DB facts — cheap, always fresh, never cached.
    if (referenced.has("stripe.dispute")) {
      const disputes = await this.disputeStore.listByCustomer(cus, 50).catch(() => []);
      out.openDispute = disputes.some((d) => OPEN_DISPUTE_STATUSES.has(d.status));
    }
    if (referenced.has("stripe.refund_review")) {
      const review = await this.sessionStore.getPendingChargeReview(threadId).catch(() => null);
      out.refundReview = !!review;
    }

    // Stripe-API facts — cached per customer, time-boxed.
    if ([...referenced].some((d) => STRIPE_API_DIMS.includes(d))) {
      const api = await this.stripeApiFacts(cus, referenced);
      out.unavailable = api.unavailable || undefined;
      out.paying = api.paying;
      out.planKeys = api.planKeys;
      out.spendMajor = api.spendMajor;
      out.truncatedSpend = api.truncatedSpend;
    }

    return out;
  }

  private async stripeApiFacts(cus: string, referenced: Set<SlaDim>): Promise<StripeApiCacheEntry> {
    const cached = this.stripeCache.get(cus);
    if (cached && Date.now() - cached.fetchedAt < STRIPE_CACHE_TTL_MS) return cached;

    const entry: StripeApiCacheEntry = { fetchedAt: Date.now(), unavailable: false };
    const started = Date.now();
    try {
      if (referenced.has("stripe.paying") || referenced.has("stripe.plan")) {
        const subs = await withTimeout(this.stripe.listSubscriptions(cus), STRIPE_CALL_TIMEOUT_MS, "stripe subscriptions");
        const live = subs.filter((s) => s.status === "active" || s.status === "trialing" || s.status === "past_due");
        entry.paying = live.some((s) => s.status === "active" || s.status === "past_due");
        entry.planKeys = collectPlanKeys(live);
      }
      if (referenced.has("stripe.spend") && Date.now() - started < STRIPE_TOTAL_BUDGET_MS) {
        let sum = 0;
        let cursor: string | undefined;
        let pages = 0;
        let hasMore = true;
        while (hasMore && pages < SPEND_MAX_PAGES && Date.now() - started < STRIPE_TOTAL_BUDGET_MS) {
          const { charges, hasMore: more } = await withTimeout(
            this.stripe.listCharges(cus, 100, cursor),
            STRIPE_CALL_TIMEOUT_MS,
            "stripe charges"
          );
          for (const c of charges) {
            if (c.paid && c.status === "succeeded") sum += (c.amount - (c.amount_refunded ?? 0)) / 100;
          }
          cursor = charges.length ? charges[charges.length - 1].id : undefined;
          hasMore = more && charges.length > 0;
          pages++;
        }
        entry.spendMajor = Math.round(sum * 100) / 100;
        entry.truncatedSpend = hasMore;
        if (hasMore) {
          factsLog.warn("sla.facts.spend_truncated", { "stripe.customer_id": cus, "sla.spend_pages": pages });
        }
      }
    } catch (e) {
      entry.unavailable = true;
      factsLog.warn("sla.facts.stripe_unavailable", {
        "stripe.customer_id": cus,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    this.stripeCache.set(cus, entry);
    return entry;
  }
}

function collectPlanKeys(subs: Stripe.Subscription[]): string[] {
  const keys = new Set<string>();
  for (const sub of subs) {
    for (const item of sub.items.data) {
      const price = item.price;
      if (!price) continue;
      if (price.id) keys.add(price.id);
      if (price.nickname) keys.add(price.nickname);
      if (price.lookup_key) keys.add(price.lookup_key);
      if (typeof price.product === "string") keys.add(price.product);
    }
  }
  return [...keys];
}
