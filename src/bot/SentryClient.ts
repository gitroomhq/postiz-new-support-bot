import { log } from "../util/logger";

// Read-only client for Sentry's REST API — used to PRE-FETCH product issues that
// may relate to a support ticket, so /ai cause can trace a real error instead of
// guessing. Correlation is heuristic (ticket keywords, optionally a user email):
// treat hits as leads, not proof. Everything is best-effort → [] on any failure.
//
// Region-aware: org auth tokens do NOT auto-route to EU, so the host must be
// targeted explicitly (verified via Sentry docs). US = sentry.io, EU = de.sentry.io.

const sentryLog = log.child("sentry-client");
const SENTRY_API_HOSTS: Record<SentryRegion, string> = {
  us: "https://sentry.io/api/0",
  eu: "https://de.sentry.io/api/0",
};
const FETCH_TIMEOUT_MS = 6_000;

export type SentryRegion = "us" | "eu";

export interface SentryReadConfig {
  token: string;
  orgSlug: string;
  projectSlug: string;
  region: SentryRegion;
}

export interface SentryIssue {
  shortId: string;
  title: string;
  culprit: string | null;
  /** Event count (Sentry returns this as a string). */
  count: string;
  userCount: number;
  lastSeen: string;
  permalink: string;
}

export class SentryClient {
  constructor(private cfg: SentryReadConfig) {}

  // Searches the project's issues. `query` is a Sentry search string, e.g.
  // "is:unresolved user.email:a@b.com token expired". Returns [] on any error.
  async findIssues(
    query: string,
    opts: { statsPeriod?: string; limit?: number } = {}
  ): Promise<SentryIssue[]> {
    const { statsPeriod = "14d", limit = 5 } = opts;
    const params = new URLSearchParams({
      query,
      statsPeriod,
      limit: String(limit),
      sort: "freq",
    });
    const base = SENTRY_API_HOSTS[this.cfg.region] ?? SENTRY_API_HOSTS.us;
    const url =
      `${base}/projects/${encodeURIComponent(this.cfg.orgSlug)}/` +
      `${encodeURIComponent(this.cfg.projectSlug)}/issues/?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.cfg.token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        sentryLog.debug("issues api non-2xx", { status: res.status });
        return [];
      }
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.map((i: any) => ({
        shortId: String(i.shortId ?? i.id ?? ""),
        title: String(i.title ?? i.metadata?.type ?? "(untitled)"),
        culprit: i.culprit ?? null,
        count: String(i.count ?? "0"),
        userCount: Number(i.userCount ?? 0),
        lastSeen: String(i.lastSeen ?? ""),
        permalink: String(i.permalink ?? ""),
      }));
    } catch (err) {
      sentryLog.debug("issues api failed", { error: String(err) });
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
