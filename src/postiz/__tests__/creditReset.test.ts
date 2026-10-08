import { test } from "node:test";
import assert from "node:assert/strict";
import { PostizClient, PostizHttpError, PostizQueryError, type PostizAccount } from "../PostizClient";
import { PostizCreditService } from "../PostizCreditService";
import type { PostizCreditResetLedger, PostizCreditResetRow } from "../PostizCreditResetStore";
import type { SettingsStore } from "../../config/SettingsStore";

// The AI credit reset is the one write this bot makes on the Postiz platform.
// The cases that matter: the reset must always name the target organization
// (the route otherwise acts on the bot's own org), and an email only resets
// the one organization it exactly and unambiguously belongs to.

const settings = {
  postizBaseUrl: () => "https://api.example.com",
  postizApiKey: () => "key-123",
  postizLookupEnabled: () => true,
  postizConfigured: () => true,
} as unknown as SettingsStore;

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function withFetch(status: number, json: unknown, text = ""): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => json,
      text: async () => text,
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("the reset posts the kind and names the customer's org in x-postiz-org", async () => {
  const f = withFetch(200, { deleted: 14 });
  try {
    const out = await new PostizClient(settings).resetCredits("org_1", "ai_images");
    assert.deepEqual(out, { deleted: 14 });
    assert.equal(f.calls.length, 1);
    const [call] = f.calls;
    assert.equal(call.url, "https://api.example.com/public/v1/credits/reset");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.Authorization, "key-123");
    assert.equal(call.headers["x-postiz-org"], "org_1");
    assert.deepEqual(JSON.parse(call.body ?? "{}"), { type: "ai_images" });
  } finally {
    f.restore();
  }
});

test("a reset with no organization never leaves the bot (it would hit the bot's own org)", async () => {
  const f = withFetch(200, { deleted: 1 });
  try {
    await assert.rejects(new PostizClient(settings).resetCredits("  ", "ai_images"), PostizQueryError);
    await assert.rejects(new PostizClient(settings).resetCredits("org_1", "ai_audio" as never), PostizQueryError);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

test("an answer without a count reads as unknown, not as zero", async () => {
  const f = withFetch(200, {});
  try {
    assert.deepEqual(await new PostizClient(settings).resetCredits("org_1", "ai_videos"), { deleted: null });
  } finally {
    f.restore();
  }
});

test("a failed reset keeps the platform's body so a 404 can be told apart", async () => {
  const f = withFetch(404, null, '{"msg":"No subscription found"}');
  try {
    await assert.rejects(new PostizClient(settings).resetCredits("org_1", "ai_images"), (e: unknown) => {
      assert.ok(e instanceof PostizHttpError);
      assert.equal(e.status, 404);
      assert.match(e.body ?? "", /No subscription found/);
      return true;
    });
  } finally {
    f.restore();
  }
});

// ---- PostizCreditService ----

const acct = (over: Partial<PostizAccount> = {}): PostizAccount =>
  ({
    membershipId: "uo_1",
    role: "ADMIN",
    userId: "usr_1",
    name: "Jamie",
    email: "jamie@example.com",
    orgId: "org_1",
    orgName: "Acme",
    tier: "PRO",
    orgDeletedAt: null,
    userDeletedAt: null,
    ...over,
  }) as PostizAccount;

function service(opts: {
  accounts?: PostizAccount[];
  capped?: boolean;
  resetError?: unknown;
  deleted?: number | null;
  enabled?: boolean;
}) {
  const resets: Array<{ orgId: string; type: string }> = [];
  const rows: PostizCreditResetRow[] = [];
  const client = {
    searchUsers: async () => ({ accounts: opts.accounts ?? [acct()], capped: opts.capped ?? false, matched: 1 }),
    resetCredits: async (orgId: string, type: string) => {
      resets.push({ orgId, type });
      if (opts.resetError) throw opts.resetError;
      return { deleted: opts.deleted === undefined ? 14 : opts.deleted };
    },
  } as unknown as PostizClient;
  const ledger: PostizCreditResetLedger = {
    record: async (row) => void rows.push({ ...row, createdAt: new Date() }),
    last: async (orgId, type) => [...rows].reverse().find((r) => r.orgId === orgId && r.creditType === type) ?? null,
  };
  const s = {
    postizLookupEnabled: () => opts.enabled ?? true,
    postizConfigured: () => true,
  } as unknown as SettingsStore;
  return { svc: new PostizCreditService(client, s, ledger, null), resets, rows };
}

const actor = { id: "7", name: "Sam" };

test("only rows whose email IS the address count (the search is a contains match)", async () => {
  const { svc } = service({
    accounts: [acct({ email: "sam.jamie@example.com", orgId: "org_other" }), acct({ email: "Jamie@Example.com" })],
  });
  assert.deepEqual(await svc.target("jamie@example.com"), { kind: "one", orgId: "org_1", orgName: "Acme", tier: "PRO" });
});

test("an address in two live organizations is refused, not guessed", async () => {
  const { svc } = service({ accounts: [acct(), acct({ orgId: "org_2", membershipId: "uo_2" })] });
  assert.deepEqual(await svc.target("jamie@example.com"), { kind: "many", count: 2 });
});

test("deleted users and organizations do not count as a second organization", async () => {
  const { svc } = service({
    accounts: [acct(), acct({ orgId: "org_old", orgDeletedAt: "2026-01-01" }), acct({ orgId: "org_x", userDeletedAt: "2026-02-01" })],
  });
  assert.equal((await svc.target("jamie@example.com")).kind, "one");
});

test("a capped search is refused: a second organization may be past the cut", async () => {
  const { svc } = service({ capped: true });
  assert.equal((await svc.target("jamie@example.com")).kind, "invalid");
});

test("blank, malformed and switched-off lookups never search", async () => {
  assert.equal((await service({}).svc.target("")).kind, "invalid");
  assert.equal((await service({}).svc.target("not-an-email")).kind, "invalid");
  assert.equal((await service({ enabled: false }).svc.target("jamie@example.com")).kind, "off");
});

test("a reset runs only against the organization the teammate confirmed, and is recorded", async () => {
  const { svc, resets, rows } = service({});
  const out = await svc.reset({ email: "jamie@example.com", type: "ai_images", expectOrgId: "org_1", actor, conversationId: "99" });
  assert.deepEqual(out, { ok: true, orgId: "org_1", orgName: "Acme", restored: 14 });
  assert.deepEqual(resets, [{ orgId: "org_1", type: "ai_images" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorName, "Sam");
  assert.equal(rows[0].restored, 14);
  assert.equal((await svc.lastReset("org_1", "ai_images"))?.conversationId, "99");
  assert.equal(await svc.lastReset("org_1", "ai_videos"), null);
});

test("an address that now resolves elsewhere resets nothing", async () => {
  const { svc, resets, rows } = service({ accounts: [acct({ orgId: "org_2" })] });
  const out = await svc.reset({ email: "jamie@example.com", type: "ai_images", expectOrgId: "org_1", actor, conversationId: null });
  assert.equal(out.ok, false);
  assert.equal(resets.length, 0);
  assert.equal(rows.length, 0);
});

test("platform failures read as what they mean, and are not recorded", async () => {
  const cases: Array<[PostizHttpError, RegExp]> = [
    [new PostizHttpError(404, "x", undefined, '{"msg":"No subscription found"}'), /no subscription/],
    [new PostizHttpError(404, "x", undefined, '{"msg":"Organization not found"}'), /no longer has/],
    [new PostizHttpError(404, "x", undefined, '{"message":"Cannot POST /public/v1/credits/reset"}'), /platform update/],
    [new PostizHttpError(403, "x", undefined, '{"msg":"Unauthorized"}'), /API key/],
  ];
  for (const [error, expected] of cases) {
    const { svc, rows } = service({ resetError: error });
    const out = await svc.reset({ email: "jamie@example.com", type: "ai_videos", expectOrgId: "org_1", actor, conversationId: null });
    assert.equal(out.ok, false);
    assert.match(out.ok ? "" : out.error, expected);
    assert.equal(rows.length, 0);
  }
});
