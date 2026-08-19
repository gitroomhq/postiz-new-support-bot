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
