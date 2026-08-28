import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  PostizClient,
  PostizHttpError,
  PostizQueryError,
} from "../PostizClient";
import type { SettingsStore } from "../../config/SettingsStore";

// Hand-rolled fakes (importer.test.ts style): every outbound request lands in
// `calls` so both the URL and the auth header are assertable.

interface Harness {
  client: PostizClient;
  calls: Array<{ url: string; auth: string | undefined }>;
  restore: () => void;
}

interface HarnessOpts {
  baseUrl?: string | null;
  apiKey?: string | null;
  rows?: unknown;
  status?: number;
  body?: string;
}

const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: `uo_${n}`,
  role: "USER",
  organization: { id: `org_${n}`, name: `Org ${n}`, subscription: { subscriptionTier: "PRO" } },
  user: { id: `usr_${n}`, name: `User ${n}`, email: `user${n}@example.com` },
  ...over,
});

function harness(opts: HarnessOpts = {}): Harness {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const settings = {
    postizBaseUrl: () => (opts.baseUrl === undefined ? "https://api.example.com" : opts.baseUrl),
    postizApiKey: () => (opts.apiKey === undefined ? "key-123" : opts.apiKey),
  } as unknown as SettingsStore;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization });
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => opts.rows ?? [],
      text: async () => opts.body ?? "",
    };
  }) as unknown as typeof globalThis.fetch;

  return { client: new PostizClient(settings), calls, restore: () => { globalThis.fetch = original; } };
}

test("search: rejects blank and short queries before any request goes out", async () => {
  const h = harness();
  try {
    // A blank term is `contains: ""` on the platform side, which matches every
    // row in the table.
    await assert.rejects(() => h.client.searchUsers("   "), PostizQueryError);
    await assert.rejects(() => h.client.searchUsers("ab"), PostizQueryError);
    assert.equal(h.calls.length, 0, "no request should be made for a rejected query");

    // The boundary itself is allowed.
    await h.client.searchUsers("a".repeat(MIN_QUERY_LENGTH));
    assert.equal(h.calls.length, 1);
  } finally {
    h.restore();
  }
});

test("search: sends the raw key with no Bearer prefix and maps the row shape", async () => {
  const h = harness({ rows: [row(1)] });
  try {
    const res = await h.client.searchUsers("user1@example.com");
    // A "Bearer " prefix makes the platform treat it as an unknown key.
    assert.equal(h.calls[0].auth, "key-123");
    assert.match(h.calls[0].url, /\/public\/v1\/users\?name=/);
    // The `row` fixture is a minimal (older-platform) response, so every
    // extended field maps to null rather than a fabricated default.
    assert.deepEqual(res.accounts, [
      {
        membershipId: "uo_1",
        role: "USER",
        userId: "usr_1",
        name: "User 1",
        email: "user1@example.com",
        orgId: "org_1",
        orgName: "Org 1",
        tier: "PRO",
        membershipDisabled: null,
        orgPaymentId: null,
        orgDeletedAt: null,
        userDeletedAt: null,
        userActivated: null,
        userProvider: null,
        subIdentifier: null,
        subPeriod: null,
        subIsLifetime: null,
        subCancelAt: null,
      },
    ]);
    assert.equal(res.capped, false);
  } finally {
    h.restore();
  }
});

test("search: caps an oversized result set and reports the cap rather than truncating silently", async () => {
  const rows = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => row(i));
  const h = harness({ rows });
  try {
    const res = await h.client.searchUsers("example.com");
    assert.equal(res.accounts.length, MAX_RESULTS);
    assert.equal(res.capped, true);
    assert.equal(res.matched, MAX_RESULTS + 5);
  } finally {
    h.restore();
  }
});

test("search: drops rows missing a user or organization, and tolerates a null subscription", async () => {
  const h = harness({
    rows: [
      row(1, { user: undefined }),
      row(2, { organization: undefined }),
      row(3, { organization: { id: "org_3", name: "Org 3", subscription: null } }),
    ],
  });
  try {
    const res = await h.client.searchUsers("example");
    assert.equal(res.accounts.length, 1);
    assert.equal(res.accounts[0].orgId, "org_3");
    // A free org has no subscription row; that is not a failure.
    assert.equal(res.accounts[0].tier, null);
  } finally {
    h.restore();
  }
});

test("search: caches per exact term, because id matching is case-sensitive", async () => {
  const h = harness({ rows: [row(1)] });
  try {
    await h.client.searchUsers("aB3xK9mQ2p");
    await h.client.searchUsers("aB3xK9mQ2p");
    assert.equal(h.calls.length, 1, "an identical term is served from cache");

    // Case is deliberately NOT folded. The endpoint matches ids — Stripe
    // customer id, subscription identifier, channel id, post id — with
    // `equals`, so two terms differing only in case are genuinely two
    // different lookups and must not share a cache entry.
    await h.client.searchUsers("ab3xk9mq2p");
    assert.equal(h.calls.length, 2, "a differently-cased id is its own lookup");

    h.client.clearCache();
    await h.client.searchUsers("aB3xK9mQ2p");
    assert.equal(h.calls.length, 3);
  } finally {
    h.restore();
  }
});

test("search: sends the customer id verbatim, so an exact-match branch can hit", async () => {
  const h = harness({ rows: [] });
  try {
    await h.client.searchUsers("cus_UGGLxT7aZyXyCG");
    assert.equal(new URL(h.calls[0].url).searchParams.get("name"), "cus_UGGLxT7aZyXyCG");
  } finally {
    h.restore();
  }
});

test("search: maps the platform's extended fields, and leaves absent ones unknown", async () => {
  const h = harness({
    rows: [
      row(1, {
        disabled: false,
        organization: {
          id: "org_1",
          name: "Acme",
          paymentId: "cus_abc",
          deletedAt: null,
          subscription: { subscriptionTier: "PRO", identifier: "aB3xK9mQ2p", isLifetime: true, period: "YEARLY", cancelAt: null },
        },
        user: { id: "usr_1", name: "Jane", email: "jane@acme.com", activated: true, providerName: "GOOGLE", deletedAt: null },
      }),
      // An older deployment that predates the wider `select`.
      row(2),
    ],
  });
  try {
    const { accounts } = await h.client.searchUsers("acme");
    assert.equal(accounts[0].orgPaymentId, "cus_abc");
    assert.equal(accounts[0].subIdentifier, "aB3xK9mQ2p");
    assert.equal(accounts[0].subIsLifetime, true);
    assert.equal(accounts[0].subPeriod, "YEARLY");
    assert.equal(accounts[0].userProvider, "GOOGLE");
    assert.equal(accounts[0].userActivated, true);
    assert.equal(accounts[0].membershipDisabled, false);

    // Absent must stay null ("the platform did not say"), never false.
    assert.equal(accounts[1].orgPaymentId, null);
    assert.equal(accounts[1].subIsLifetime, null);
    assert.equal(accounts[1].userActivated, null);
    assert.equal(accounts[1].membershipDisabled, null);
  } finally {
    h.restore();
  }
});

test("resolveSingle: returns the account only when exactly one matched", async () => {
  const one = harness({ rows: [row(1)] });
  try {
    assert.equal((await one.client.resolveSingle("user1@example.com"))?.userId, "usr_1");
  } finally {
    one.restore();
  }

  // Two candidates must not be guessed between: enrichment would attach the
  // wrong customer to a ticket.
  const two = harness({ rows: [row(1), row(2)] });
  try {
    assert.equal(await two.client.resolveSingle("example.com"), null);
  } finally {
    two.restore();
  }

  const none = harness({ rows: [] });
  try {
    assert.equal(await none.client.resolveSingle("nobody@example.com"), null);
  } finally {
    none.restore();
  }
});

test("errors: missing configuration and HTTP failures surface as PostizHttpError", async () => {
  const noUrl = harness({ baseUrl: null });
  try {
    await assert.rejects(() => noUrl.client.searchUsers("something"), PostizHttpError);
  } finally {
    noUrl.restore();
  }

  const noKey = harness({ apiKey: null });
  try {
    await assert.rejects(() => noKey.client.searchUsers("something"), PostizHttpError);
  } finally {
    noKey.restore();
  }

  const forbidden = harness({ status: 403, body: "Unauthorized" });
  try {
    await assert.rejects(
      () => forbidden.client.searchUsers("something"),
      (e: unknown) => e instanceof PostizHttpError && e.status === 403
    );
  } finally {
    forbidden.restore();
  }
});

test("selfTest: names which of the three gates rejected the key", async () => {
  const ok = harness({ rows: [] });
  try {
    assert.equal((await ok.client.selfTest()).ok, true);
  } finally {
    ok.restore();
  }

  // 401 and 403 mean different things here: a bad key or a missing
  // subscription vs an org with no superadmin user.
  const unauth = harness({ status: 401 });
  try {
    const r = await unauth.client.selfTest();
    assert.equal(r.ok, false);
    assert.match(r.detail, /subscription/i);
  } finally {
    unauth.restore();
  }

  const forbidden = harness({ status: 403 });
  try {
    const r = await forbidden.client.selfTest();
    assert.equal(r.ok, false);
    assert.match(r.detail, /superadmin/i);
  } finally {
    forbidden.restore();
  }

  const notFound = harness({ status: 404 });
  try {
    assert.match((await notFound.client.selfTest()).detail, /base URL/i);
  } finally {
    notFound.restore();
  }

  const noKey = harness({ apiKey: null });
  try {
    assert.equal((await noKey.client.selfTest()).ok, false);
  } finally {
    noKey.restore();
  }
});
