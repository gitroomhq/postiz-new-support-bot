import type { SettingsStore } from "../config/SettingsStore";
import type { SessionStore } from "../auth/SessionStore";
import { log } from "../util/logger";
import { PostizClient, PostizHttpError, PostizQueryError, type PostizAccount, type PostizSearchResult } from "./PostizClient";

const idLog = log.child("postiz:identity");

export interface PostizIdentityStamp {
  postizUserId: string;
  postizOrgId: string;
  postizTier: string | null;
  postizRole: string | null;
  postizLinkedAt: Date;
}

// Narrow slice of TicketStore this service needs, so the enrichment can be
// tested without a database.
export interface PostizTicketWriter {
  setPostizIdentity(threadId: string, stamp: PostizIdentityStamp): Promise<void>;
}

// How long a page render is willing to wait for the platform. PostizClient's
// own 15s AbortSignal stays in force underneath: losing this race abandons the
// WAIT, not the request, so the answer still lands in the 60s cache and the
// next view of the same customer is instant.
const ORG_LOOKUP_TIMEOUT_MS = 3_000;

// Hard ceiling on platform calls per lookup, so a customer with many
// subscriptions cannot fan out into a burst of searches.
const MAX_LOOKUP_TERMS = 2;

const ROLE_RANK: Record<string, number> = { SUPERADMIN: 3, ADMIN: 2, USER: 1 };

// One organization, flattened from the membership rows the platform returns.
export interface PostizOrgSummary {
  orgId: string;
  orgName: string | null;
  tier: string | null;
  // The org's Stripe customer id as the platform sees it.
  paymentId: string | null;
  orgDeleted: boolean;
  // Whether `paymentId` agrees with the Stripe customer we are looking at.
  // null when the platform is too old to echo it back.
  customerMatches: boolean | null;
  ownerEmail: string | null;
  ownerRole: string | null;
  ownerMembershipId: string | null;
  ownerProvider: string | null;
  ownerActivated: boolean | null;
  ownerIsLive: boolean;
  memberCount: number;
  // True when the result set was capped, so memberCount is a floor.
  countIsFloor: boolean;
  subIdentifier: string | null;
  subPeriod: string | null;
  subIsLifetime: boolean | null;
  subCancelAt: string | null;
}

export type PostizOrgLookupState = "off" | "none" | "found" | "timeout" | "error";

export interface PostizOrgLookup {
  state: PostizOrgLookupState;
  orgs: PostizOrgSummary[];
  // Which term actually answered, so a surface can say so.
  via: "customer" | "uniqueId" | null;
}

// A member who is deleted or whose membership is switched off outranks nobody:
// a deleted SUPERADMIN is not the address support should be writing to.
function ownerScore(a: PostizAccount): number {
  const live = a.userDeletedAt || a.membershipDisabled ? 0 : 1;
  return live * 100 + (ROLE_RANK[(a.role ?? "").toUpperCase()] ?? 0);
}

function summarizeOrgs(result: PostizSearchResult, customerId: string): PostizOrgSummary[] {
  const byOrg = new Map<string, PostizAccount[]>();
  for (const a of result.accounts) {
    const list = byOrg.get(a.orgId);
    if (list) list.push(a);
    else byOrg.set(a.orgId, [a]);
  }

  const orgs: PostizOrgSummary[] = [];
  for (const [orgId, members] of byOrg) {
    // Stable pick: highest score wins, ties fall to the platform's own order.
    let owner = members[0];
    for (const m of members) {
      if (ownerScore(m) > ownerScore(owner)) owner = m;
    }
    const paymentId = members.find((m) => m.orgPaymentId)?.orgPaymentId ?? null;
    orgs.push({
      orgId,
      orgName: owner.orgName,
      tier: owner.tier,
      paymentId,
      orgDeleted: members.every((m) => !!m.orgDeletedAt),
      customerMatches: paymentId === null ? null : paymentId === customerId,
      ownerEmail: owner.email,
      ownerRole: owner.role,
      ownerMembershipId: owner.membershipId || null,
      ownerProvider: owner.userProvider,
      ownerActivated: owner.userActivated,
      ownerIsLive: ownerScore(owner) >= 100,
      memberCount: members.length,
      countIsFloor: result.capped,
      subIdentifier: owner.subIdentifier,
      subPeriod: owner.subPeriod,
      subIsLifetime: owner.subIsLifetime,
      subCancelAt: owner.subCancelAt,
    });
  }
  // Orgs that really are this Stripe customer first; deleted ones last.
  return orgs.sort(
    (a, b) => Number(b.customerMatches === true) - Number(a.customerMatches === true) || Number(a.orgDeleted) - Number(b.orgDeleted)
  );
}

// Turns whatever a support contact gives us into a Postiz account.
//
// The platform's search is a `contains` match over user id / name / email / org
// id, so an exact id or a full email address is the only input that reliably
// identifies ONE account. Everything looser is treated as a hint and rejected
// when it comes back ambiguous: attaching the wrong customer to a ticket is far
// worse than attaching none.
export class PostizIdentityService {
  constructor(
    private client: PostizClient,
    private settingsStore: SettingsStore,
    private sessionStore: SessionStore
  ) {}

  private enabled(): boolean {
    return this.settingsStore.postizLookupEnabled() && this.settingsStore.postizConfigured();
  }

  // Exact-ish resolution for an identifier the operator or a linked session
  // supplied. Null when the lookup is off, unconfigured, ambiguous or unknown.
  async resolve(term: string): Promise<PostizAccount | null> {
    if (!this.enabled()) return null;
    try {
      return await this.client.resolveSingle(term);
    } catch (e) {
      // A rejected query is operator input, not an outage: it is reported by
      // the caller rather than logged as a failure.
      if (e instanceof PostizQueryError) return null;
      idLog.warn("postiz.identity.lookup_failed", {
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // Every candidate for a term, for operator-facing surfaces that can show a
  // disambiguation list. Throws PostizQueryError for input too broad to run.
  async search(term: string) {
    if (!this.enabled()) return null;
    return this.client.searchUsers(term);
  }

  // Which Postiz organization IS this Stripe customer? Answers from the
  // platform's own record rather than from anything we mirror locally.
  //
  // Tries the Stripe customer id first (the platform matches it against
  // Organization.paymentId exactly). Only if that finds nothing does it fall
  // back to a subscription's `uniqueId`, which the platform stores as
  // Subscription.identifier — note that is the uniqueId from Stripe metadata,
  // NEVER a Stripe sub_ id.
  //
  // Never throws: this decorates a page that must render without it.
  async resolveOrgsForCustomer(customerId: string, fallbackUniqueIds: string[] = []): Promise<PostizOrgLookup> {
    if (!this.enabled()) return { state: "off", orgs: [], via: null };

    const attempts: Array<{ term: string; via: "customer" | "uniqueId" }> = [];
    const push = (term: string | null | undefined, via: "customer" | "uniqueId") => {
      const t = term?.trim();
      if (!t || attempts.some((a) => a.term === t)) return;
      attempts.push({ term: t, via });
    };
    push(customerId, "customer");
    for (const uid of fallbackUniqueIds) push(uid, "uniqueId");

    let sawTimeout = false;
    let sawError = false;
    for (const { term, via } of attempts.slice(0, MAX_LOOKUP_TERMS)) {
      const outcome = await this.searchTimeBoxed(term);
      if (outcome.kind === "timeout") {
        sawTimeout = true;
        continue;
      }
      if (outcome.kind === "error") {
        sawError = true;
        continue;
      }
      if (outcome.kind === "skipped") continue;
      const orgs = summarizeOrgs(outcome.result, customerId);
      if (orgs.length) return { state: "found", orgs, via };
    }

    // A partial failure must not masquerade as "this customer has no account".
    if (sawTimeout) return { state: "timeout", orgs: [], via: null };
    if (sawError) return { state: "error", orgs: [], via: null };
    return { state: "none", orgs: [], via: null };
  }

  private async searchTimeBoxed(
    term: string
    // Spelled out as four members rather than one with a union `kind`: TypeScript
    // only narrows a discriminated union member-by-member, so the collapsed form
    // never reduces to the "ok" case at the call site.
  ): Promise<
    | { kind: "ok"; result: PostizSearchResult }
    | { kind: "timeout" }
    | { kind: "error" }
    | { kind: "skipped" }
  > {
    let timer: NodeJS.Timeout | undefined;
    try {
      // The search promise is caught separately so that losing the race can
      // never surface later as an unhandled rejection.
      const search = this.client.searchUsers(term).then(
        (result) => ({ kind: "ok", result } as const),
        (error: unknown) => ({ kind: "failed", error } as const)
      );
      const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" } as const), ORG_LOOKUP_TIMEOUT_MS);
      });
      const race = await Promise.race([search, timeout]);

      if (race.kind === "timeout") {
        idLog.warn("postiz.identity.org_lookup_timeout", { "postiz.term_length": term.length });
        return { kind: "timeout" };
      }
      if (race.kind === "ok") return { kind: "ok", result: race.result };

      // A term the client refuses to send (too short) is bad input, not an
      // outage, and must not colour the whole lookup as failed.
      if (race.error instanceof PostizQueryError) return { kind: "skipped" };
      idLog.warn("postiz.identity.org_lookup_failed", {
        "error.message": race.error instanceof Error ? race.error.message : String(race.error),
        ...(race.error instanceof PostizHttpError ? { "http.status_code": race.error.status } : {}),
      });
      return { kind: "error" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // What we know about a Discord user, in decreasing order of confidence:
  // their linked Postiz id, then the email on their linked Stripe customer.
  // An unlinked Discord user is simply unknown to the platform.
  async resolveForDiscordUser(
    discordUserId: string,
    lookupStripeEmail?: (customerId: string) => Promise<string | null>
  ): Promise<PostizAccount | null> {
    if (!this.enabled()) return null;

    const session = await this.sessionStore.getSession(discordUserId).catch(() => null);
    if (session?.postizUserId) {
      const byId = await this.resolve(session.postizUserId);
      if (byId) return byId;
    }
    if (session?.stripeCustomerId && lookupStripeEmail) {
      const email = await lookupStripeEmail(session.stripeCustomerId).catch(() => null);
      // The platform mangles usernames without an "@" into name@postiz.com, so
      // an address is only useful when it really is one.
      if (email && email.includes("@")) {
        const byEmail = await this.resolve(email);
        if (byEmail) return byEmail;
      }
    }
    return null;
  }

  static stampOf(account: PostizAccount, at: Date): PostizIdentityStamp {
    return {
      postizUserId: account.userId,
      postizOrgId: account.orgId,
      postizTier: account.tier,
      postizRole: account.role,
      postizLinkedAt: at,
    };
  }

  // Best-effort enrichment hung off ticket creation. Never throws and never
  // delays the ticket itself: an unresolved ticket is a ticket with null
  // identity columns, which is exactly how every pre-existing ticket looks.
  async enrichTicket(
    tickets: PostizTicketWriter,
    threadId: string,
    discordUserId: string,
    lookupStripeEmail?: (customerId: string) => Promise<string | null>
  ): Promise<PostizAccount | null> {
    try {
      const account = await this.resolveForDiscordUser(discordUserId, lookupStripeEmail);
      if (!account) return null;
      await tickets.setPostizIdentity(threadId, PostizIdentityService.stampOf(account, new Date()));
      idLog.info("postiz.identity.linked", {
        "ticket.thread_id": threadId,
        "postiz.user_id": account.userId,
        "postiz.org_id": account.orgId,
        "postiz.tier": account.tier ?? "none",
      });
      return account;
    } catch (e) {
      idLog.warn("postiz.identity.enrich_failed", {
        "ticket.thread_id": threadId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
}
