import type { SettingsStore } from "../config/SettingsStore";

const REQUEST_TIMEOUT_MS = 15_000;

// The endpoint matches with Prisma `contains` and has no minimum length, so a
// one- or two-character query is a full-table scan wearing a lookup's clothes.
// An empty string matches EVERY row (`contains: ""` is always true), which is
// why blank is rejected before the request rather than after.
export const MIN_QUERY_LENGTH = 3;

// The endpoint has no LIMIT either: a common substring can return the whole
// user base. We keep the first slice and tell the caller the rest exist rather
// than pretending the list was complete.
export const MAX_RESULTS = 25;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

export class PostizHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message);
  }
}

// Thrown before any request goes out, for input the endpoint would happily
// answer with far too much data.
export class PostizQueryError extends Error {}

// One user's membership of one organization. The platform returns a
// userOrganization row, so a user in two orgs comes back twice.
//
// Everything below `tier` was added to the platform's `select` later. An older
// deployment simply omits those keys, so each one is optional-and-null rather
// than assumed present: absent must read as "unknown", never as "false" or
// "deleted".
export interface PostizAccount {
  // The userOrganization id. Doubles as the platform's `impersonate` value,
  // which is why it is kept rather than flattened away.
  membershipId: string;
  role: string | null;
  userId: string;
  name: string | null;
  email: string | null;
  orgId: string;
  orgName: string | null;
  tier: string | null;
  // This membership is switched off, but the row still comes back.
  membershipDisabled: boolean | null;
  // The org's Stripe customer id, echoed back. Lets a caller VERIFY that a hit
  // really belongs to the customer it searched for instead of trusting the
  // server's OR clause.
  orgPaymentId: string | null;
  orgDeletedAt: string | null;
  userDeletedAt: string | null;
  userActivated: boolean | null;
  // Login provider ("LOCAL", "GOOGLE", …) — support context for "I can't sign in".
  userProvider: string | null;
  // Platform-side subscription facts, for cross-checking against Stripe.
  subIdentifier: string | null;
  subPeriod: string | null;
  subIsLifetime: boolean | null;
  subCancelAt: string | null;
}

export interface PostizSearchResult {
  accounts: PostizAccount[];
  // True when the platform returned more than MAX_RESULTS; `accounts` is the
  // head of a longer list and the query should be narrowed.
  capped: boolean;
  matched: number;
}

interface RawUserOrganization {
  id?: string;
  role?: string;
  disabled?: boolean;
  organization?: {
    id?: string;
    name?: string;
    paymentId?: string | null;
    deletedAt?: string | null;
    subscription?: {
      subscriptionTier?: string;
      identifier?: string | null;
      isLifetime?: boolean;
      period?: string | null;
      cancelAt?: string | null;
    } | null;
  };
  user?: {
    id?: string;
    name?: string;
    email?: string;
    activated?: boolean;
    providerName?: string | null;
    deletedAt?: string | null;
  };
}

// An older platform omits the newer `select` keys entirely. `undefined` has to
// survive as null ("the deployment does not tell us") rather than becoming
// false, which would read as a positive statement the server never made.
function nullableBool(v: boolean | undefined): boolean | null {
  return typeof v === "boolean" ? v : null;
}

// Read-only client for the Postiz platform's superadmin search
// (GET /public/v1/users?name=…). Auth is the raw org API key in the
// Authorization header — no "Bearer" prefix — and the platform additionally
// requires that org to contain a superadmin user and to hold a subscription.
// Both of those failures surface as 401/403, so `configured` and `reachable`
// are deliberately different questions.
//
// Hand-rolled fetch is sanctioned here for the same reason as the Sentry
// client: the base URL is operator-set and never externally influenced
// (safeFetch is for externally-influenced URLs). Settings are re-read per call
// so /config edits apply without a restart.
export class PostizClient {
  private cache = new Map<string, { at: number; result: PostizSearchResult }>();

  constructor(private settingsStore: SettingsStore) {}

  private baseUrl(): string {
    const base = this.settingsStore.postizBaseUrl();
    if (!base) throw new PostizHttpError(400, "Postiz lookup: no base URL configured");
    return base;
  }

  private apiKey(): string {
    const key = this.settingsStore.postizApiKey();
    if (!key) throw new PostizHttpError(401, "Postiz lookup: no API key configured");
    return key;
  }

  /** Drop cached answers — call after the key or base URL changes. */
  clearCache(): void {
    this.cache.clear();
  }

  // Cache key. Case is PRESERVED on purpose: the endpoint's name/email branches
  // match case-insensitively, but its id branches (Stripe customer id,
  // subscription identifier, channel id, post id) match with `equals`, which is
  // case-sensitive. Folding case would let two different ids — a base62
  // uniqueId differing only in capitalisation, say — collide on one entry and
  // hand back the wrong organisation. The only cost of keeping case is a
  // duplicate entry for a differently-typed email, which is never a wrong answer.
  private static normalize(query: string): string {
    return query.trim();
  }

  async searchUsers(query: string): Promise<PostizSearchResult> {
    const term = query.trim();
    if (!term) {
      throw new PostizQueryError("Enter something to search for. A blank search would match every account.");
    }
    if (term.length < MIN_QUERY_LENGTH) {
      throw new PostizQueryError(
        `Search for at least ${MIN_QUERY_LENGTH} characters. Shorter terms match too much of the user base to be useful.`
      );
    }

    const key = PostizClient.normalize(term);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

    const params = new URLSearchParams({ name: term });
    const raw = await this.request<RawUserOrganization[]>(`/public/v1/users?${params.toString()}`, "user search");
    const rows = Array.isArray(raw) ? raw : [];
    const accounts = rows
      .filter((r) => r.user?.id && r.organization?.id)
      .map((r) => {
        const org = r.organization!;
        const user = r.user!;
        const sub = org.subscription ?? null;
        return {
          membershipId: String(r.id ?? ""),
          role: r.role ?? null,
          userId: String(user.id),
          name: user.name?.trim() || null,
          email: user.email?.trim() || null,
          orgId: String(org.id),
          orgName: org.name?.trim() || null,
          tier: sub?.subscriptionTier ?? null,
          membershipDisabled: nullableBool(r.disabled),
          orgPaymentId: org.paymentId?.trim() || null,
          orgDeletedAt: org.deletedAt ?? null,
          userDeletedAt: user.deletedAt ?? null,
          userActivated: nullableBool(user.activated),
          userProvider: user.providerName?.trim() || null,
          subIdentifier: sub?.identifier?.trim() || null,
          subPeriod: sub?.period?.trim() || null,
          subIsLifetime: nullableBool(sub?.isLifetime),
          subCancelAt: sub?.cancelAt ?? null,
        };
      });

    const result: PostizSearchResult = {
      accounts: accounts.slice(0, MAX_RESULTS),
      capped: accounts.length > MAX_RESULTS,
      matched: accounts.length,
    };
    this.remember(key, result);
    return result;
  }

  // Exactly one account, or null when the term is ambiguous or unknown. Used by
  // the automatic ticket enrichment, where guessing between two candidates
  // would attach the wrong customer to a ticket.
  async resolveSingle(query: string): Promise<PostizAccount | null> {
    const { accounts } = await this.searchUsers(query);
    if (accounts.length !== 1) return null;
    return accounts[0];
  }

  // Connectivity self-test for the /config panel: distinguishes the three gates
  // that all otherwise fail silently (key valid, org has a superadmin, org has
  // a subscription).
  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    if (!this.settingsStore.postizBaseUrl()) return { ok: false, detail: "No base URL configured." };
    if (!this.settingsStore.postizApiKey()) return { ok: false, detail: "No API key configured." };
    try {
      // A term that is well-formed but matches nothing: proves the route,
      // the key and both guards without pulling real accounts back.
      await this.searchUsers("zzz-postiz-connectivity-probe");
      return { ok: true, detail: "Reachable. The key is valid and passes the superadmin guard." };
    } catch (e) {
      if (e instanceof PostizHttpError) {
        if (e.status === 401) {
          return { ok: false, detail: "Rejected (401). The API key is wrong, or its org has no active subscription." };
        }
        if (e.status === 403) {
          return { ok: false, detail: "Forbidden (403). The key's organization contains no superadmin user." };
        }
        if (e.status === 404) {
          return { ok: false, detail: "Not found (404). Check the base URL points at the backend, not the frontend." };
        }
        return { ok: false, detail: `Failed: ${e.message}` };
      }
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private remember(key: string, result: PostizSearchResult): void {
    // Cheap bound: the cache exists to absorb per-ticket bursts, not to be a
    // long-lived store, so a full reset beats tracking an LRU.
    if (this.cache.size >= CACHE_MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), result });
  }

  private async request<T>(pathAndQuery: string, what: string): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${pathAndQuery}`, {
      headers: {
        // The platform's public auth middleware reads the key RAW — a "Bearer "
        // prefix makes it look like an unknown key and 401s.
        Authorization: this.apiKey(),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryAfter = res.status === 429 ? Number(res.headers.get("retry-after")) || undefined : undefined;
      throw new PostizHttpError(
        res.status,
        `Postiz ${what}: HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        retryAfter
      );
    }
    return (await res.json()) as T;
  }
}
