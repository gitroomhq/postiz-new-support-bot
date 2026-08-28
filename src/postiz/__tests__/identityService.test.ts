import { test } from "node:test";
import assert from "node:assert/strict";
import { PostizIdentityService } from "../PostizIdentityService";
import { PostizClient, PostizQueryError } from "../PostizClient";
import type { SettingsStore } from "../../config/SettingsStore";
import type { SessionStore } from "../../auth/SessionStore";

// Resolution ladder for a Discord customer: their linked Postiz id first, then
// the email on their linked Stripe customer, then nothing.

interface HarnessOpts {
  enabled?: boolean;
  configured?: boolean;
  session?: { postizUserId?: string | null; stripeCustomerId?: string | null } | null;
  rowsByTerm?: Record<string, unknown[]>;
  stripeEmail?: string | null;
  clientThrows?: boolean;
}

const row = (n: number) => ({
  id: `uo_${n}`,
  role: "ADMIN",
  organization: { id: `org_${n}`, name: `Org ${n}`, subscription: { subscriptionTier: "TEAM" } },
  user: { id: `usr_${n}`, name: `User ${n}`, email: `user${n}@example.com` },
});

function harness(opts: HarnessOpts = {}) {
  const searched: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const term = new URL(String(url)).searchParams.get("name") ?? "";
    searched.push(term);
    if (opts.clientThrows) return { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom" };
    const rows = opts.rowsByTerm?.[term] ?? [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => rows, text: async () => "" };
  }) as unknown as typeof globalThis.fetch;

  const settings = {
    postizLookupEnabled: () => opts.enabled ?? true,
    postizConfigured: () => opts.configured ?? true,
    postizBaseUrl: () => "https://api.example.com",
    postizApiKey: () => "key",
  } as unknown as SettingsStore;

  const sessions = {
    async getSession() {
      return opts.session === undefined ? null : opts.session;
    },
  } as unknown as SessionStore;

  const stamped: Array<{ threadId: string; postizUserId: string; postizTier: string | null }> = [];
  const tickets = {
    async setPostizIdentity(
      threadId: string,
      stamp: { postizUserId: string; postizTier: string | null; postizLinkedAt: Date }
    ) {
      // postizLinkedAt is wall-clock, so only the stable fields are captured.
      stamped.push({ threadId, postizUserId: stamp.postizUserId, postizTier: stamp.postizTier });
      assert.ok(stamp.postizLinkedAt instanceof Date);
    },
  };

  const service = new PostizIdentityService(new PostizClient(settings), settings, sessions);
  const stripeEmail = async () => opts.stripeEmail ?? null;
  return { service, searched, stamped, tickets, stripeEmail, restore: () => { globalThis.fetch = original; } };
}

test("resolve: a single match is returned, an ambiguous one is refused", async () => {
  const h = harness({ rowsByTerm: { "usr_1": [row(1)], "example.com": [row(1), row(2)] } });
  try {
    assert.equal((await h.service.resolve("usr_1"))?.orgId, "org_1");
    // Guessing between candidates would attach the wrong customer to a ticket.
    assert.equal(await h.service.resolve("example.com"), null);
  } finally {
    h.restore();
  }
});

test("resolve: returns null rather than throwing when the lookup is off or unconfigured", async () => {
  const off = harness({ enabled: false, rowsByTerm: { "usr_1": [row(1)] } });
  try {
    assert.equal(await off.service.resolve("usr_1"), null);
    assert.equal(off.searched.length, 0, "a disabled lookup makes no request");
  } finally {
    off.restore();
  }

  const unconfigured = harness({ configured: false, rowsByTerm: { "usr_1": [row(1)] } });
  try {
    assert.equal(await unconfigured.service.resolve("usr_1"), null);
  } finally {
    unconfigured.restore();
  }
});

test("resolve: a platform outage degrades to null instead of propagating", async () => {
  const h = harness({ clientThrows: true });
  try {
    assert.equal(await h.service.resolve("usr_1"), null);
  } finally {
    h.restore();
  }
});

test("resolve: a query too broad to run is refused without a request", async () => {
  const h = harness();
  try {
    assert.equal(await h.service.resolve("ab"), null);
    assert.equal(h.searched.length, 0);
    // The operator-facing surface still sees why.
    await assert.rejects(() => h.service.search("ab"), PostizQueryError);
  } finally {
    h.restore();
  }
});

test("discord user: the linked Postiz id is preferred over the Stripe email", async () => {
  const h = harness({
    session: { postizUserId: "usr_1", stripeCustomerId: "cus_9" },
    rowsByTerm: { "usr_1": [row(1)], "user2@example.com": [row(2)] },
    stripeEmail: "user2@example.com",
  });
  try {
    const acct = await h.service.resolveForDiscordUser("discord_1", h.stripeEmail);
    assert.equal(acct?.userId, "usr_1");
    assert.deepEqual(h.searched, ["usr_1"], "the Stripe rung is not consulted once the id resolves");
  } finally {
    h.restore();
  }
});

test("discord user: falls through to the Stripe email when the id resolves to nothing", async () => {
  const h = harness({
    session: { postizUserId: "usr_gone", stripeCustomerId: "cus_9" },
    rowsByTerm: { "user2@example.com": [row(2)] },
    stripeEmail: "user2@example.com",
  });
  try {
    const acct = await h.service.resolveForDiscordUser("discord_1", h.stripeEmail);
    assert.equal(acct?.userId, "usr_2");
    assert.deepEqual(h.searched, ["usr_gone", "user2@example.com"]);
  } finally {
    h.restore();
  }
});

test("discord user: a mangled placeholder address is not searched", async () => {
  // The platform stores usernames without an "@" as name@postiz.com on the
  // Stripe side; a value with no "@" at all is not an address to look up.
  const h = harness({
    session: { stripeCustomerId: "cus_9" },
    stripeEmail: "not-an-address",
  });
  try {
    assert.equal(await h.service.resolveForDiscordUser("discord_1", h.stripeEmail), null);
    assert.equal(h.searched.length, 0);
  } finally {
    h.restore();
  }
});

test("discord user: an unlinked Discord account resolves to nothing", async () => {
  const h = harness({ session: null });
  try {
    assert.equal(await h.service.resolveForDiscordUser("discord_1"), null);
    assert.equal(h.searched.length, 0);
  } finally {
    h.restore();
  }
});

test("enrichTicket: stamps the resolved account and swallows failures", async () => {
  const h = harness({ session: { postizUserId: "usr_1" }, rowsByTerm: { "usr_1": [row(1)] } });
  try {
    await h.service.enrichTicket(h.tickets, "thread_1", "discord_1");
    assert.deepEqual(h.stamped, [{ threadId: "thread_1", postizUserId: "usr_1", postizTier: "TEAM" }]);
  } finally {
    h.restore();
  }

  // A write that blows up must not surface into ticket creation.
  const boom = harness({ session: { postizUserId: "usr_1" }, rowsByTerm: { "usr_1": [row(1)] } });
  try {
    const failing = {
      async setPostizIdentity() {
        throw new Error("db down");
      },
    };
    assert.equal(await boom.service.enrichTicket(failing, "thread_2", "discord_1"), null);
  } finally {
    boom.restore();
  }
});

test("enrichTicket: an unresolved customer leaves the ticket untouched", async () => {
  const h = harness({ session: null });
  try {
    assert.equal(await h.service.enrichTicket(h.tickets, "thread_1", "discord_1"), null);
    assert.deepEqual(h.stamped, []);
  } finally {
    h.restore();
  }
});

// --- resolveOrgsForCustomer: Stripe customer -> Postiz organization ---------

const CUS = "cus_UGGLxT7aZyXyCG";

// A membership row for one org, with the platform's extended select filled in.
const orgRow = (
  n: number,
  over: { role?: string; paymentId?: string | null; disabled?: boolean; userDeletedAt?: string | null; email?: string } = {}
) => ({
  id: `uo_${n}`,
  role: over.role ?? "USER",
  disabled: over.disabled ?? false,
  organization: {
    id: "org_1",
    name: "Acme Social",
    paymentId: over.paymentId === undefined ? CUS : over.paymentId,
    deletedAt: null,
    subscription: { subscriptionTier: "PRO", identifier: "aB3xK9mQ2p", isLifetime: false, period: "MONTHLY", cancelAt: null },
  },
  user: {
    id: `usr_${n}`,
    name: `User ${n}`,
    email: over.email ?? `user${n}@acme.com`,
    activated: true,
    providerName: "LOCAL",
    deletedAt: over.userDeletedAt ?? null,
  },
});

test("resolveOrgsForCustomer: groups memberships into one org and picks the superadmin", async () => {
  const h = harness({
    rowsByTerm: {
      [CUS]: [
        orgRow(1, { role: "USER" }),
        orgRow(2, { role: "SUPERADMIN", email: "boss@acme.com" }),
        orgRow(3, { role: "ADMIN" }),
      ],
    },
  });
  try {
    const out = await h.service.resolveOrgsForCustomer(CUS);
    assert.equal(out.state, "found");
    assert.equal(out.via, "customer");
    assert.equal(out.orgs.length, 1, "three memberships are one organization");
    const [org] = out.orgs;
    assert.equal(org.orgId, "org_1");
    assert.equal(org.memberCount, 3);
    assert.equal(org.ownerEmail, "boss@acme.com");
    assert.equal(org.ownerRole, "SUPERADMIN");
    assert.equal(org.ownerMembershipId, "uo_2");
    // The echoed paymentId proves the hit really is this Stripe customer.
    assert.equal(org.customerMatches, true);
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: a deleted or disabled member never becomes the owner", async () => {
  const h = harness({
    rowsByTerm: {
      [CUS]: [
        orgRow(1, { role: "SUPERADMIN", email: "gone@acme.com", userDeletedAt: "2026-01-01T00:00:00.000Z" }),
        orgRow(2, { role: "SUPERADMIN", email: "off@acme.com", disabled: true }),
        orgRow(3, { role: "USER", email: "live@acme.com" }),
      ],
    },
  });
  try {
    const [org] = (await h.service.resolveOrgsForCustomer(CUS)).orgs;
    assert.equal(org.ownerEmail, "live@acme.com", "a live USER outranks a deleted SUPERADMIN");
    assert.equal(org.ownerIsLive, true);
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: falls back to the subscription uniqueId, and only then", async () => {
  const h = harness({ rowsByTerm: { aB3xK9mQ2p: [orgRow(1, { paymentId: null })] } });
  try {
    const out = await h.service.resolveOrgsForCustomer(CUS, ["aB3xK9mQ2p"]);
    assert.deepEqual(h.searched, [CUS, "aB3xK9mQ2p"], "the customer id is tried first");
    assert.equal(out.via, "uniqueId");
    assert.equal(out.orgs[0].orgId, "org_1");
    // The platform did not echo a paymentId, so no claim is made either way.
    assert.equal(out.orgs[0].customerMatches, null);
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: a hit on the customer id skips the fallback entirely", async () => {
  const h = harness({ rowsByTerm: { [CUS]: [orgRow(1)] } });
  try {
    await h.service.resolveOrgsForCustomer(CUS, ["aB3xK9mQ2p"]);
    assert.deepEqual(h.searched, [CUS], "no second call once the customer id answered");
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: never makes more than two platform calls", async () => {
  const h = harness({ rowsByTerm: {} });
  try {
    await h.service.resolveOrgsForCustomer(CUS, ["uid0000001", "uid0000002", "uid0000003"]);
    assert.equal(h.searched.length, 2, "a customer with many subs must not fan out");
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: an org pointing elsewhere is reported, not hidden", async () => {
  const h = harness({ rowsByTerm: { aB3xK9mQ2p: [orgRow(1, { paymentId: "cus_somethingelse" })] } });
  try {
    const out = await h.service.resolveOrgsForCustomer(CUS, ["aB3xK9mQ2p"]);
    assert.equal(out.orgs[0].customerMatches, false);
    assert.equal(out.orgs[0].paymentId, "cus_somethingelse");
  } finally {
    h.restore();
  }
});

test("resolveOrgsForCustomer: a miss, an outage and a disabled lookup are three states", async () => {
  const miss = harness({ rowsByTerm: {} });
  try {
    assert.equal((await miss.service.resolveOrgsForCustomer(CUS)).state, "none");
  } finally {
    miss.restore();
  }

  const broken = harness({ clientThrows: true });
  try {
    const out = await broken.service.resolveOrgsForCustomer(CUS);
    assert.equal(out.state, "error", "an outage must not read as 'no account'");
    assert.deepEqual(out.orgs, []);
  } finally {
    broken.restore();
  }

  const off = harness({ enabled: false });
  try {
    const out = await off.service.resolveOrgsForCustomer(CUS);
    assert.equal(out.state, "off");
    assert.equal(off.searched.length, 0, "a disabled lookup makes no request at all");
  } finally {
    off.restore();
  }
});

test("resolveOrgsForCustomer: a term too short to send is skipped, not counted as an outage", async () => {
  const h = harness({ rowsByTerm: {} });
  try {
    // "ab" is below MIN_QUERY_LENGTH, so the client refuses it pre-flight.
    const out = await h.service.resolveOrgsForCustomer(CUS, ["ab"]);
    assert.equal(out.state, "none", "rejected input is not an error state");
    assert.deepEqual(h.searched, [CUS], "the short term never went out");
  } finally {
    h.restore();
  }
});
