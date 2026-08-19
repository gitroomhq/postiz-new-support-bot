import type { SettingsStore } from "../config/SettingsStore";
import type { SessionStore } from "../auth/SessionStore";
import { log } from "../util/logger";
import { PostizClient, PostizQueryError, type PostizAccount } from "./PostizClient";

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
