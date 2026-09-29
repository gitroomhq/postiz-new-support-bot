import type { SettingsStore } from "../config/SettingsStore";

// Resend, the provider Postiz sends its activation, password-reset and
// notification mail through. This bot only ever READS and REMOVES entries on
// the team's suppression list: when an address hard-bounces or files a spam
// complaint, Resend suppresses it team-wide and silently skips every later
// send to it, which is how a customer ends up never receiving the mail that
// would let them log in.
//
// Contract, verified against resend.com/docs (suppressions reference):
//   GET    /suppressions/{email|id}  -> the entry, or 404 when not suppressed
//   DELETE /suppressions/{email|id}  -> { deleted: true }
//   GET    /suppressions?limit=1     -> the self-test (needs a FULL access key)
//   GET    /emails/{id}              -> the email that caused a suppression
//
// Two platform rules shape this file:
//   - a User-Agent header is REQUIRED (Resend answers 403 without one);
//   - the rate limit is 10 requests a second per TEAM, and Postiz's own
//     sending draws on the same budget, so this client throttles itself well
//     below it and caches lookups. Support must never be why a password-reset
//     email got rate limited.

const BASE_URL = "https://api.resend.com";
const USER_AGENT = "postiz-support-bot (suppression lookups)";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
// At most this many requests in flight, and no faster than one per gap: about
// four a second at worst, less than half the team's allowance.
const MAX_IN_FLIGHT = 2;
const MIN_GAP_MS = 250;

export class ResendHttpError extends Error {
  constructor(
    public status: number,
    // Resend's error `name` (not_found, restricted_api_key, rate_limit_exceeded, ...).
    public code: string | null,
    message: string,
    public retryAfterSeconds: number | null = null
  ) {
    super(message);
  }
}

export type SuppressionOrigin = "bounce" | "complaint" | "manual";

export interface Suppression {
  id: string;
  email: string;
  // Anything unexpected is kept verbatim rather than guessed into a known one.
  origin: SuppressionOrigin | string;
  // The email that triggered it; null for a manual entry.
  sourceId: string | null;
  createdAt: Date | null;
}

// What support may see about a sent email: never its body.
export interface EmailSummary {
  id: string;
  subject: string | null;
  from: string | null;
  createdAt: Date | null;
  lastEvent: string | null;
}

// Resend writes timestamps as "2026-10-06 23:47:56.678+00", which Date does not
// parse everywhere: the space and the hour-only offset are both normalised.
export function parseResendDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let v = raw.trim().replace(" ", "T");
  if (/[+-]\d{2}$/.test(v)) v = `${v}:00`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

type RawSuppression = { id?: string; email?: string; origin?: string; source_id?: string | null; created_at?: string };

export class ResendClient {
  private cache = new Map<string, { at: number; value: Suppression | null }>();
  private inflight = new Map<string, Promise<Suppression | null>>();
  private active = 0;
  private lastStart = 0;
  private queue: Array<() => void> = [];

  constructor(
    private settings: SettingsStore,
    private fetchImpl: typeof fetch = fetch
  ) {}

  configured(): boolean {
    return Boolean(this.settings.resendApiKey());
  }

  // null = not on the list. Case: the address is looked up lowercased first,
  // then exactly as given if that differs, because an email's local part is
  // case-sensitive on paper and we must not report "clear" off the wrong one.
  async getSuppression(email: string): Promise<Suppression | null> {
    const trimmed = email.trim();
    const key = trimmed.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;

    const work = (async () => {
      for (const candidate of [...new Set([key, trimmed])]) {
        const found = await this.lookup(candidate);
        if (found) {
          this.remember(key, found);
          return found;
        }
      }
      this.remember(key, null);
      return null;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  // true = removed; false = it was not on the list (already removed, or never).
  async removeSuppression(emailOrId: string): Promise<boolean> {
    const target = emailOrId.trim();
    try {
      await this.request("DELETE", `/suppressions/${encodeURIComponent(target)}`, "suppression remove");
      return true;
    } catch (e) {
      if (e instanceof ResendHttpError && e.status === 404) return false;
      throw e;
    } finally {
      this.clearCache(target);
    }
  }

  async getEmailSummary(emailId: string): Promise<EmailSummary | null> {
    try {
      const raw = await this.request<{
        id?: string;
        subject?: string | null;
        from?: string | null;
        created_at?: string;
        last_event?: string | null;
      }>("GET", `/emails/${encodeURIComponent(emailId)}`, "email get");
      return {
        id: raw.id ?? emailId,
        subject: raw.subject ?? null,
        from: raw.from ?? null,
        createdAt: parseResendDate(raw.created_at),
        lastEvent: raw.last_event ?? null,
      };
    } catch (e) {
      if (e instanceof ResendHttpError && e.status === 404) return null;
      throw e;
    }
  }

  // For the /config panels: can this key read the suppression list, and which
  // team does it belong to (its sending domains are the tell). A sending-only
  // key, the kind Postiz itself runs on, is named as such, because "401" alone
  // sends people looking for a typo.
  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    if (!this.configured()) {
      return { ok: false, detail: "No key: paste one here, or set RESEND_API_KEY in the environment." };
    }
    try {
      await this.request("GET", "/suppressions?limit=1", "suppression list");
    } catch (e) {
      if (e instanceof ResendHttpError) {
        if (e.code === "restricted_api_key" && e.status === 401) {
          return {
            ok: false,
            detail: "This key can only send email. Create a Full access key in Resend (API Keys) and paste it here.",
          };
        }
        if (e.status === 401 || e.status === 403) {
          return { ok: false, detail: `Resend rejected the key (${e.code ?? e.status}).` };
        }
        return { ok: false, detail: `Resend answered ${e.status}${e.code ? ` (${e.code})` : ""}.` };
      }
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    const domains = await this.request<{ data?: Array<{ name?: string; status?: string }> }>("GET", "/domains", "domain list")
      .then((r) => (r.data ?? []).map((d) => `${d.name ?? "?"}${d.status && d.status !== "verified" ? ` (${d.status})` : ""}`))
      .catch(() => [] as string[]);
    return {
      ok: true,
      detail: `Full access. ${
        domains.length
          ? `Sending domains on this team: ${domains.slice(0, 5).join(", ")}${domains.length > 5 ? ", ..." : ""}. It must be the team Postiz sends from.`
          : "It must belong to the team Postiz sends from."
      }`,
    };
  }

  clearCache(email?: string): void {
    if (email == null) this.cache.clear();
    else this.cache.delete(email.trim().toLowerCase());
  }

  private async lookup(candidate: string): Promise<Suppression | null> {
    try {
      const raw = await this.request<RawSuppression>("GET", `/suppressions/${encodeURIComponent(candidate)}`, "suppression get");
      return {
        id: raw.id ?? "",
        email: raw.email ?? candidate,
        origin: raw.origin ?? "unknown",
        sourceId: raw.source_id ?? null,
        createdAt: parseResendDate(raw.created_at),
      };
    } catch (e) {
      if (e instanceof ResendHttpError && e.status === 404) return null;
      throw e;
    }
  }

  private remember(key: string, value: Suppression | null): void {
    // The cache absorbs a burst of renders of one conversation; it is not a
    // store. A full reset beats tracking an LRU.
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
  }

  private async slot(): Promise<() => void> {
    while (this.active >= MAX_IN_FLIGHT) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const wait = this.lastStart + MIN_GAP_MS - Date.now();
    this.lastStart = Math.max(Date.now(), this.lastStart + MIN_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return () => {
      this.active--;
      this.queue.shift()?.();
    };
  }

  private async request<T>(method: "GET" | "DELETE", path: string, what: string): Promise<T> {
    const key = this.settings.resendApiKey();
    if (!key) throw new ResendHttpError(401, "missing_api_key", `Resend ${what}: no API key configured`);
    const release = await this.slot();
    try {
      const res = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let code: string | null = null;
        let message = "";
        try {
          const body = JSON.parse(text) as { name?: string; message?: string };
          code = typeof body.name === "string" ? body.name : null;
          message = typeof body.message === "string" ? body.message : "";
        } catch {
          message = text.slice(0, 200);
        }
        const retryAfter =
          res.status === 429 ? Number(res.headers.get("retry-after") ?? res.headers.get("ratelimit-reset")) || null : null;
        throw new ResendHttpError(
          res.status,
          code,
          `Resend ${what}: HTTP ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message.slice(0, 200)}` : ""}`,
          retryAfter
        );
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      release();
    }
  }
}
