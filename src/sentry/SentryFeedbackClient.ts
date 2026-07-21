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
  async getFeedbackContext(issueId: string): Promise<SentryFeedbackContext> {
    const { data } = await this.request<{
      contexts?: { feedback?: { contact_email?: string; name?: string; message?: string; url?: string } };
    }>(
      `/api/0/organizations/${encodeURIComponent(this.orgSlug())}/issues/${encodeURIComponent(issueId)}/events/latest/`,
      "feedback event"
    );
    const fb = data.contexts?.feedback ?? {};
    return {
      contactEmail: fb.contact_email?.trim() || null,
      name: fb.name?.trim() || null,
      message: fb.message ?? null,
      url: fb.url?.trim() || null,
    };
  }
}
