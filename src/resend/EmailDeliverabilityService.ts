import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "../bot/AuditLogger";
import { metricCount } from "../util/instrument";
import { log } from "../util/logger";
import { ResendHttpError, SUPPRESSION_BATCH_MAX, type EmailSummary, type ResendClient, type Suppression } from "./ResendClient";

const deliveryLog = log.child("email-delivery");

// Whether Postiz's mail can reach a customer, and the one repair support can
// make: taking an address off Resend's suppression list. Shared by every
// surface that offers it (the Intercom sidebar, the /email command, the web
// customer page), so each removal is audited the same way whoever pressed it.
//
// Logs carry the address's DOMAIN only. The audit channel names the full
// address, because staff reading it need to know which one was touched, but a
// log line is not the place for a customer's email.

// A single lookup's budget: the Intercom card has to answer in seconds.
const LOOKUP_TIMEOUT_MS = 3_000;
// More than this many addresses for one person is a data problem, not a
// customer, and each one is a request against the shared rate limit.
export const MAX_ADDRESSES = 3;
const ACTIVATION_TIMEOUT_MS = 10_000;

export const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export type DeliveryStatus =
  | { email: string; state: "suppressed"; suppression: Suppression; source: EmailSummary | null }
  | { email: string; state: "clear" }
  | { email: string; state: "unknown"; error: string };

export type RemoveResult =
  | { kind: "removed"; previous: Suppression | null }
  | { kind: "not_suppressed" }
  | { kind: "invalid"; error: string }
  | { kind: "disabled" }
  | { kind: "error"; error: string };

export interface DeliveryActor {
  surface: "intercom" | "discord" | "dashboard" | "config";
  id: string;
  name: string;
}

export const ORIGIN_LABELS: Record<string, string> = {
  bounce: "hard bounce",
  complaint: "spam complaint",
  manual: "added by hand",
};

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

export function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "invalid";
}

function timeBox<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => timer && clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

// "suppressed since 12 Sep 2026 (hard bounce), after Activate your account"
export function describeSuppression(s: Suppression, source: EmailSummary | null): string {
  const since = s.createdAt ? s.createdAt.toISOString().slice(0, 10) : "an unknown date";
  const cause = source?.subject ? `, after "${source.subject.slice(0, 80)}"` : "";
  return `suppressed since ${since} (${originLabel(s.origin)})${cause}`;
}

// Deduplicated, trimmed, syntactically valid, capped: the addresses one person
// is known by (contact, Postiz account, Stripe customer), in the order given.
export function distinctEmails(emails: Array<string | null | undefined>, cap = MAX_ADDRESSES): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = raw?.trim();
    if (!email || !EMAIL_RE.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
    if (out.length >= cap) break;
  }
  return out;
}

// Admin batch removal and the suppression list browser. Resend filters the
// list by origin only, so dates and the recipient domain are matched here.
export interface SuppressionFilter {
  origin: "any" | "bounce" | "complaint" | "manual";
  since: Date | null;
  until: Date | null;
  domain: string | null; // recipient domain, lowercase, no "@"
}

// A whole-list walk is one request per 100 entries at the client's pace (about
// four a second). Past this many entries the scan stops and says so, rather
// than spend minutes of the rate limit Postiz sends on.
export const SCAN_MAX_ENTRIES = 20_000;

export interface SuppressionScan {
  matches: Suppression[];
  scanned: number;
  truncated: boolean;
}

export function describeFilter(f: SuppressionFilter): string {
  const parts = [f.origin === "any" ? "any origin" : originLabel(f.origin)];
  if (f.domain) parts.push(`@${f.domain}`);
  if (f.since) parts.push(`from ${f.since.toISOString().slice(0, 10)}`);
  if (f.until) parts.push(`until ${f.until.toISOString().slice(0, 10)}`);
  return parts.join(", ");
}

export function matchesFilter(s: Suppression, f: SuppressionFilter): boolean {
  if (f.origin !== "any" && s.origin !== f.origin) return false;
  if (f.domain && domainOf(s.email) !== f.domain) return false;
  if (f.since && (!s.createdAt || s.createdAt < f.since)) return false;
  if (f.until && (!s.createdAt || s.createdAt > f.until)) return false;
  return true;
}

export class EmailDeliverabilityService {
  constructor(
    private settings: SettingsStore,
    private client: ResendClient,
    private audit?: AuditLogger | null
  ) {}

  enabled(): boolean {
    return this.settings.resendEnabled() && this.client.configured();
  }

  // Never throws: every caller decorates a page or a card that must render
  // without it. A lookup that fails says "unknown", which is not "clear".
  async statusFor(emails: Array<string | null | undefined>): Promise<DeliveryStatus[]> {
    if (!this.enabled()) return [];
    return Promise.all(distinctEmails(emails).map((email) => this.statusOf(email)));
  }

  async statusOf(email: string): Promise<DeliveryStatus> {
    try {
      const suppression = await timeBox(this.client.getSuppression(email), LOOKUP_TIMEOUT_MS);
      if (!suppression) return { email, state: "clear" };
      // Which email caused it is context, not the answer: best effort.
      const source = suppression.sourceId
        ? await timeBox(this.client.getEmailSummary(suppression.sourceId), LOOKUP_TIMEOUT_MS).catch(() => null)
        : null;
      return { email, state: "suppressed", suppression, source };
    } catch (e) {
      const error =
        e instanceof ResendHttpError
          ? e.status === 429
            ? "Resend is rate limiting; try again in a moment"
            : `Resend answered ${e.status}`
          : e instanceof Error
            ? e.message
            : String(e);
      deliveryLog.warn("resend suppression lookup failed", { "email.domain": domainOf(email), "error.message": error });
      return { email, state: "unknown", error };
    }
  }

  // Take an address off the list. Any teammate may (operator decision), so the
  // audit entry is what keeps it accountable: who, from where, and what the
  // address was suppressed for.
  async remove(email: string, actor: DeliveryActor, context: { conversationId?: string | null } = {}): Promise<RemoveResult> {
    if (!this.enabled()) return { kind: "disabled" };
    const address = email.trim();
    if (!EMAIL_RE.test(address)) return { kind: "invalid", error: "That is not an email address." };
    try {
      const previous = await this.client.getSuppression(address).catch(() => null);
      const removed = await this.client.removeSuppression(address);
      this.client.clearCache(address);
      if (!removed) return { kind: "not_suppressed" };
      metricCount("resend.suppression_removed", 1, {
        origin: previous?.origin ?? "unknown",
        surface: actor.surface,
      });
      deliveryLog.info("resend suppression removed", {
        "email.domain": domainOf(address),
        "resend.origin": previous?.origin ?? "unknown",
        "actor.surface": actor.surface,
      });
      void this.audit?.log({
        title: "📧 Email removed from the Resend suppression list",
        severity: "warn",
        actor: actor.name,
        fields: [
          { name: "Address", value: address, inline: true },
          {
            name: "Was",
            value: previous ? describeSuppression(previous, null) : "suppressed (details unavailable)",
            inline: true,
          },
          { name: "From", value: SURFACE_LABELS[actor.surface], inline: true },
          ...(context.conversationId ? [{ name: "Intercom conversation", value: context.conversationId, inline: true }] : []),
        ],
      });
      return { kind: "removed", previous };
    } catch (e) {
      const error =
        e instanceof ResendHttpError
          ? e.code === "restricted_api_key"
            ? "The Resend key can only send email; a Full access key is needed (see /config → Integrations → Resend)."
            : e.status === 429
              ? "Resend is rate limiting; try again in a moment."
              : `Resend answered ${e.status}${e.code ? ` (${e.code})` : ""}.`
          : e instanceof Error
            ? e.message
            : String(e);
      deliveryLog.warn("resend suppression removal failed", { "email.domain": domainOf(address), "error.message": error });
      return { kind: "error", error };
    }
  }

  // Walks the suppression list and returns every entry the filter matches,
  // newest first.
  async scanSuppressions(filter: SuppressionFilter): Promise<SuppressionScan> {
    const matches: Suppression[] = [];
    let after: string | null = null;
    let scanned = 0;
    let truncated = false;
    for (;;) {
      const page = await this.client.listSuppressions({
        after,
        origin: filter.origin === "any" ? null : filter.origin,
        limit: 100,
      });
      scanned += page.items.length;
      for (const s of page.items) if (matchesFilter(s, filter)) matches.push(s);
      const last = page.items[page.items.length - 1];
      if (!page.hasMore || !last) break;
      if (scanned >= SCAN_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      after = last.id;
    }
    matches.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    return { matches, scanned, truncated };
  }

  // Admin-only (callers check). Re-scans with the same filter instead of
  // trusting the preview, removes in batches of 100, and audits one summary
  // entry. `expected` is the preview's count, reported next to what happened.
  async removeMatching(
    filter: SuppressionFilter,
    actor: DeliveryActor,
    expected: number
  ): Promise<{ ok: true; removed: number; matched: number; failed: number } | { ok: false; error: string }> {
    if (!this.enabled()) return { ok: false, error: "Resend support is off." };
    try {
      const scan = await this.scanSuppressions(filter);
      const ids = scan.matches.map((m) => m.id).filter(Boolean);
      let removed = 0;
      for (let i = 0; i < ids.length; i += SUPPRESSION_BATCH_MAX) {
        removed += (await this.client.removeSuppressionsBatch(ids.slice(i, i + SUPPRESSION_BATCH_MAX))).length;
      }
      metricCount("resend.suppression_removed", removed, { origin: filter.origin, surface: actor.surface });
      deliveryLog.info("resend suppression batch removal", {
        "resend.matched": ids.length,
        "resend.removed": removed,
        "resend.origin": filter.origin,
      });
      void this.audit?.log({
        title: "📧 Batch removal from the Resend suppression list",
        severity: "warn",
        actor: actor.name,
        fields: [
          { name: "Filter", value: describeFilter(filter), inline: false },
          { name: "Removed", value: String(removed), inline: true },
          { name: "Matched", value: `${ids.length} (preview said ${expected})`, inline: true },
          ...(scan.truncated ? [{ name: "Note", value: `Scan stopped at ${SCAN_MAX_ENTRIES} entries`, inline: false }] : []),
          { name: "From", value: SURFACE_LABELS[actor.surface], inline: true },
        ],
      });
      return { ok: true, removed, matched: ids.length, failed: ids.length - removed };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof ResendHttpError
            ? e.code === "restricted_api_key"
              ? "The Resend key can only send email; a Full access key is needed."
              : e.status === 429
                ? "Resend is rate limiting; try again in a moment."
                : e.message
            : e instanceof Error
              ? e.message
              : String(e),
      };
    }
  }

  // Ask Postiz to send the activation email again, to exactly this address.
  // Uses the platform's own public "resend activation" route (the one behind
  // the login page's button), so the mail is the real one, sent by Postiz
  // through the same Resend team this bot just unsuppressed.
  async resendActivation(email: string, actor: DeliveryActor): Promise<{ ok: true } | { ok: false; error: string }> {
    const base = this.settings.postizBaseUrl();
    if (!base) return { ok: false, error: "The Postiz base URL is not configured (/config → Integrations → Postiz)." };
    const address = email.trim();
    if (!EMAIL_RE.test(address)) return { ok: false, error: "That is not an email address." };
    try {
      const res = await fetch(`${base}/auth/resend-activation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: address }),
        signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string } | null;
      if (!res.ok || !body?.success) {
        return { ok: false, error: body?.message ? `Postiz: ${body.message}` : `Postiz answered ${res.status}.` };
      }
      void this.audit?.log({
        title: "✉️ Postiz activation email re-sent",
        severity: "info",
        actor: actor.name,
        fields: [
          { name: "Address", value: address, inline: true },
          { name: "From", value: SURFACE_LABELS[actor.surface], inline: true },
        ],
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

const SURFACE_LABELS: Record<DeliveryActor["surface"], string> = {
  intercom: "Intercom sidebar",
  discord: "Discord /email",
  dashboard: "Web customer page",
  config: "/config",
};
