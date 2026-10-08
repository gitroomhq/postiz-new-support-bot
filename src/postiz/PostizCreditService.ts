import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "../bot/AuditLogger";
import { EMAIL_RE } from "../resend/EmailDeliverabilityService";
import { log } from "../util/logger";
import { PostizClient, PostizHttpError, PostizQueryError, type PostizAccount, type PostizCreditType } from "./PostizClient";
import type { PostizCreditResetLedger, PostizCreditResetRow } from "./PostizCreditResetStore";

const creditLog = log.child("postiz:credits");

export const CREDIT_LABELS: Record<PostizCreditType, string> = {
  ai_images: "AI image",
  ai_videos: "AI video",
};

// The one organization an email address resolves to, or why there is none.
export type PostizCreditTarget =
  | { kind: "one"; orgId: string; orgName: string | null; tier: string | null }
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "off" }
  | { kind: "invalid"; error: string }
  | { kind: "error"; error: string };

export type PostizCreditResetOutcome =
  | { ok: true; orgId: string; orgName: string | null; restored: number | null }
  | { ok: false; error: string };

export function orgLabel(org: { orgId: string; orgName: string | null }): string {
  return org.orgName ? `${org.orgName} (${org.orgId})` : org.orgId;
}

export function describeTarget(target: Exclude<PostizCreditTarget, { kind: "one" }>, email: string): string {
  switch (target.kind) {
    case "off":
      return "The Postiz lookup is off or not configured (/config → Integrations → Postiz).";
    case "none":
      return `No live Postiz account uses ${email}.`;
    case "many":
      return `${email} belongs to ${target.count} organizations, so the card will not guess which one to reset.`;
    case "invalid":
      return target.error;
    case "error":
      return `The Postiz lookup failed: ${target.error}`;
  }
}

// What a failed reset means, in support's words. A 404 is three different
// failures that only the body tells apart.
function describeResetError(e: unknown, org: string): string {
  if (e instanceof PostizHttpError) {
    const body = e.body ?? "";
    if (e.status === 404 && body.includes("No subscription found")) {
      return `${org} has no subscription on the platform, so there are no plan credits to reset.`;
    }
    if (e.status === 404 && body.includes("Organization not found")) return `The platform no longer has ${org}.`;
    if (e.status === 404) return "This Postiz deployment cannot reset credits yet; it needs a platform update.";
    if (e.status === 401 || e.status === 403) {
      return "Postiz rejected the bot's API key. Run the self-test in /config → Integrations → Postiz.";
    }
    if (e.status === 429) return "Postiz is rate limiting; try again in a moment.";
    return `Postiz answered ${e.status}.`;
  }
  return e instanceof Error ? e.message : String(e);
}

// Gives a Postiz organization its AI credits back for the current billing
// period, on behalf of a support teammate.
//
// The teammate names the account by email; the organization is resolved
// here, on the server, on every press, and a reset only runs when the email
// still resolves to the organization the teammate confirmed. Nothing undoes a
// reset (the platform deletes the usage rows), so every one is recorded, and
// the confirm step shows the last.
export class PostizCreditService {
  // Double-press guard: one reset per organization and kind at a time.
  private inFlight = new Set<string>();

  constructor(
    private client: PostizClient,
    private settings: SettingsStore,
    private ledger: PostizCreditResetLedger,
    private audit?: AuditLogger | null
  ) {}

  enabled(): boolean {
    return this.settings.postizLookupEnabled() && this.settings.postizConfigured();
  }

  // The platform's search is a `contains` match, so "am@x.io" also finds
  // "sam@x.io": only rows whose email IS this address count. Deleted users and
  // organizations are skipped (the platform refuses to act on a deleted org
  // anyway), and an address in two live organizations is refused rather than
  // guessed.
  async target(email: string): Promise<PostizCreditTarget> {
    if (!this.enabled()) return { kind: "off" };
    const address = email.trim();
    if (!address) return { kind: "invalid", error: "Enter the Postiz account email first." };
    if (!EMAIL_RE.test(address)) return { kind: "invalid", error: "That is not an email address." };

    let result: Awaited<ReturnType<PostizClient["searchUsers"]>>;
    try {
      result = await this.client.searchUsers(address);
    } catch (e) {
      if (e instanceof PostizQueryError) return { kind: "invalid", error: e.message };
      return { kind: "error", error: e instanceof Error ? e.message : String(e) };
    }
    // A capped result may hide a second organization past the cut.
    if (result.capped) {
      return { kind: "invalid", error: "That address matches too many accounts to pick one organization safely." };
    }

    const wanted = address.toLowerCase();
    const orgs = new Map<string, PostizAccount>();
    for (const a of result.accounts) {
      if (a.email?.toLowerCase() !== wanted || a.orgDeletedAt || a.userDeletedAt) continue;
      if (!orgs.has(a.orgId)) orgs.set(a.orgId, a);
    }
    if (orgs.size === 0) return { kind: "none" };
    if (orgs.size > 1) return { kind: "many", count: orgs.size };
    const [only] = orgs.values();
    return { kind: "one", orgId: only.orgId, orgName: only.orgName, tier: only.tier };
  }

  lastReset(orgId: string, type: PostizCreditType): Promise<PostizCreditResetRow | null> {
    return this.ledger.last(orgId, type).catch((e) => {
      creditLog.warn("postiz.credits.ledger_read_failed", { "error.message": e instanceof Error ? e.message : String(e) });
      return null;
    });
  }

  async reset(input: {
    email: string;
    type: PostizCreditType;
    // The organization the teammate saw and confirmed.
    expectOrgId: string;
    actor: { id: string; name: string };
    conversationId: string | null;
  }): Promise<PostizCreditResetOutcome> {
    const email = input.email.trim();
    const target = await this.target(email);
    if (target.kind !== "one") return { ok: false, error: describeTarget(target, email) };
    if (target.orgId !== input.expectOrgId) {
      return {
        ok: false,
        error: `${email} no longer resolves to the organization you confirmed; nothing was reset. Check it again.`,
      };
    }

    const key = `${target.orgId}:${input.type}`;
    if (this.inFlight.has(key)) return { ok: false, error: "This reset is already running. Refresh in a moment." };
    this.inFlight.add(key);
    try {
      const org = orgLabel(target);
      let restored: number | null;
      try {
        ({ deleted: restored } = await this.client.resetCredits(target.orgId, input.type));
      } catch (e) {
        creditLog.warn("postiz.credits.reset_failed", {
          "postiz.org_id": target.orgId,
          "postiz.credit_type": input.type,
          "error.message": e instanceof Error ? e.message : String(e),
          ...(e instanceof PostizHttpError ? { "http.status_code": e.status } : {}),
        });
        return { ok: false, error: describeResetError(e, org) };
      }

      // The reset already happened: a ledger or audit failure is logged, never
      // reported as the reset failing.
      await this.ledger
        .record({
          orgId: target.orgId,
          orgName: target.orgName,
          creditType: input.type,
          email,
          restored,
          actorId: input.actor.id,
          actorName: input.actor.name,
          conversationId: input.conversationId,
        })
        .catch((e) =>
          creditLog.warn("postiz.credits.ledger_write_failed", { "error.message": e instanceof Error ? e.message : String(e) })
        );
      void this.audit?.log({
        title: "✨ Postiz AI credits reset",
        severity: "info",
        actor: input.actor.name,
        fields: [
          { name: "Organization", value: org, inline: false },
          { name: "Credits", value: CREDIT_LABELS[input.type], inline: true },
          { name: "Restored", value: restored == null ? "not reported" : String(restored), inline: true },
          { name: "Email entered", value: email, inline: true },
          { name: "From", value: "Intercom sidebar", inline: true },
        ],
      });
      creditLog.info("postiz.credits.reset", {
        "postiz.org_id": target.orgId,
        "postiz.credit_type": input.type,
        "postiz.credits_restored": restored ?? -1,
        "actor.id": input.actor.id,
      });
      return { ok: true, orgId: target.orgId, orgName: target.orgName, restored };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
