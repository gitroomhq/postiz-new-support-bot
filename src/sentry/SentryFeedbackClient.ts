import type { SettingsStore } from "../config/SettingsStore";
import { parseSentryLinkHeader } from "./feedbackFormat";

const REQUEST_TIMEOUT_MS = 30_000;

// Transient statuses surface retryAfterSeconds so the sync tick can decide;
// the client itself never retries (tick cadence IS the retry policy).
export class SentryHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message);
  }
}

export interface SentryFeedbackIssue {
  id: string;
  shortId: string | null;
  title: string | null;
  firstSeen: string; // ISO — feedback issues are 1:1 with submissions, so firstSeen = submission time
  permalink: string | null;
  projectSlug: string | null;
}

export interface SentryFeedbackContext {
  contactEmail: string | null;
  name: string | null;
  message: string | null;
  url: string | null;
  // Acting identity carried by the platform on every authenticated request.
  identity: SentryIdentity;
}

// The platform attaches the acting identity to its events, but the SHAPE
// differs by release: older builds call Sentry.setUser (so id/email arrive in
// the event's `user` block) while newer ones carry the same values as indexed
// tags because the user context is display-only and not searchable. Both are in
// flight, so every read tries tags first and falls back to the user block.
export interface SentryIdentity {
  userId: string | null;
  email: string | null;
  orgId: string | null;
  stripeCustomerId: string | null;
}

// Tag keys the platform sets. `organization` duplicates `organization.id` on
// newer builds; only the explicit one is read.
export const IDENTITY_TAGS = {
  userId: "user.id",
  email: "user.email",
  orgId: "organization.id",
  stripeCustomerId: "stripe.customer_id",
} as const;

export type IdentityTagKey = (typeof IDENTITY_TAGS)[keyof typeof IDENTITY_TAGS];

// Sentry returns event tags as [{key, value}]; be tolerant of a plain object
// too, since the shape varies across endpoints.
type RawTags = Array<{ key?: string; value?: string }> | Record<string, string> | undefined;

export function readTag(tags: RawTags, key: string): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    const hit = tags.find((t) => t?.key === key);
    return hit?.value?.trim() || null;
  }
  return tags[key]?.trim() || null;
}

export function extractIdentity(
  tags: RawTags,
  user?: { id?: string | number; email?: string } | null
): SentryIdentity {
  return {
    userId: readTag(tags, IDENTITY_TAGS.userId) ?? (user?.id != null ? String(user.id) : null),
    email: readTag(tags, IDENTITY_TAGS.email) ?? (user?.email?.trim() || null),
    orgId: readTag(tags, IDENTITY_TAGS.orgId),
    // Only ever set by the backend, and only for a real `cus_` customer.
    stripeCustomerId: readTag(tags, IDENTITY_TAGS.stripeCustomerId),
  };
}

// Read-only client for Sentry's org API — User Feedback widget submissions
// are issues of category "feedback". Hand-rolled fetch is sanctioned here:
// the base URL derives from the operator-set region, never external input
// (safeFetch is for externally-influenced URLs). Settings are re-read per
// call so /config edits apply without a restart.
export class SentryFeedbackClient {
  constructor(private settingsStore: SettingsStore) {}

  private baseUrl(): string {
    return this.settingsStore.sentryReadRegion() === "eu" ? "https://de.sentry.io" : "https://us.sentry.io";
  }

  private orgSlug(): string {
    const org = this.settingsStore.sentryOrgSlug();
    if (!org) throw new SentryHttpError(400, "Sentry feedback: no org slug configured");
    return org;
  }

  private async request<T>(pathAndQuery: string, what: string): Promise<{ data: T; link: string | null }> {
    const res = await fetch(`${this.baseUrl()}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${this.settingsStore.sentryReadToken() ?? ""}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryAfter = res.status === 429 ? Number(res.headers.get("retry-after")) || undefined : undefined;
      throw new SentryHttpError(
        res.status,
        `Sentry ${what}: HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        retryAfter
      );
    }
    return { data: (await res.json()) as T, link: res.headers.get("link") };
  }

  // One page of feedback issues inside [startIso, endIso] (sort=new → newest
  // first; the importer re-sorts ascending). The pagination cursor lives in
  // the Link RESPONSE HEADER, not the JSON body.
  async listFeedbackIssues(input: { startIso: string; endIso: string; cursor?: string }): Promise<{
    items: SentryFeedbackIssue[];
    nextCursor: string | null;
  }> {
    const params = new URLSearchParams({
      query: "issue.category:feedback",
      start: input.startIso,
      end: input.endIso,
      utc: "true",
      sort: "new",
      limit: "100",
    });
    if (input.cursor) params.set("cursor", input.cursor);
    const { data, link } = await this.request<
      Array<{
        id?: string | number;
        shortId?: string;
        title?: string;
        firstSeen?: string;
        permalink?: string;
        project?: { slug?: string };
      }>
    >(`/api/0/organizations/${encodeURIComponent(this.orgSlug())}/issues/?${params.toString()}`, "feedback list");
    const items = (Array.isArray(data) ? data : [])
      .filter((i) => i.id != null && typeof i.firstSeen === "string")
      .map((i) => ({
        id: String(i.id),
        shortId: i.shortId ?? null,
        title: i.title ?? null,
        firstSeen: i.firstSeen as string,
        permalink: i.permalink ?? null,
        projectSlug: i.project?.slug ?? null,
      }));
    return { items, nextCursor: parseSentryLinkHeader(link) };
  }

  // The feedback content (submitter email/name/message/page URL) lives in the
  // latest event's contexts.feedback.
  //
  // The widget's own email field is hidden on the platform side, which means
  // contact_email is only populated when the SDK had a scope user to fill it
  // from. On builds that carry the identity as tags instead there is no scope
  // user, so contact_email arrives EMPTY and the identity tags are the only way
  // to know who submitted. Hence the three-way resolution below: without it a
  // whole release's feedback imports as anonymous and is dropped.
  async getFeedbackContext(issueId: string): Promise<SentryFeedbackContext> {
    const { data } = await this.request<{
      contexts?: { feedback?: { contact_email?: string; name?: string; message?: string; url?: string } };
      tags?: RawTags;
      user?: { id?: string | number; email?: string } | null;
    }>(
      `/api/0/organizations/${encodeURIComponent(this.orgSlug())}/issues/${encodeURIComponent(issueId)}/events/latest/`,
      "feedback event"
    );
    const fb = data.contexts?.feedback ?? {};
    const identity = extractIdentity(data.tags, data.user);
    return {
      contactEmail: fb.contact_email?.trim() || identity.email,
      name: fb.name?.trim() || null,
      message: fb.message ?? null,
      url: fb.url?.trim() || null,
      identity,
    };
  }

  // Issues carrying a given identity, newest first. Used to show a ticket's
  // customer their own recent errors. The `tags[...]` form matches the tag
  // shape; the bare `user.id:` / `user.email:` form is Sentry's own syntax for
  // the user context, so both are issued for the identity keys that can arrive
  // either way.
  async searchIssuesByIdentity(input: {
    key: IdentityTagKey;
    value: string;
    sinceIso: string;
    untilIso: string;
    limit?: number;
  }): Promise<SentryFeedbackIssue[]> {
    const quoted = `"${input.value.replace(/"/g, '\\"')}"`;
    const clauses = [`tags[${input.key}]:${quoted}`];
    if (input.key === IDENTITY_TAGS.userId || input.key === IDENTITY_TAGS.email) {
      clauses.push(`${input.key}:${quoted}`);
    }

    const seen = new Set<string>();
    const out: SentryFeedbackIssue[] = [];
    for (const clause of clauses) {
      const params = new URLSearchParams({
        // Feedback submissions are imported separately; this is for errors.
        query: `!issue.category:feedback ${clause}`,
        start: input.sinceIso,
        end: input.untilIso,
        utc: "true",
        sort: "date",
        limit: String(input.limit ?? 25),
      });
      const { data } = await this.request<
        Array<{
          id?: string | number;
          shortId?: string;
          title?: string;
          firstSeen?: string;
          permalink?: string;
          project?: { slug?: string };
        }>
      >(`/api/0/organizations/${encodeURIComponent(this.orgSlug())}/issues/?${params.toString()}`, "identity issue search");
      for (const i of Array.isArray(data) ? data : []) {
        if (i.id == null || typeof i.firstSeen !== "string") continue;
        const id = String(i.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          shortId: i.shortId ?? null,
          title: i.title ?? null,
          firstSeen: i.firstSeen,
          permalink: i.permalink ?? null,
          projectSlug: i.project?.slug ?? null,
        });
      }
    }
    return out;
  }
}
