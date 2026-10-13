import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueAuth, type QueueAuthSettings, type QueueRefusalAudit } from "../QueueAuth";
import { QueueSessions, type QueueSessionDb } from "../QueueSessions";
import type { QueueTeammate } from "../QueueData";

// "Sign in with Intercom": the state is single-use and bound to the pre-login
// cookie, the identity must be verified, in our workspace and seated, the
// OAuth token never leaves the exchange, and a session dies when the teammate
// does. Intercom and the database are fakes.

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { lt?: Date; gt?: Date; in?: string[] };
      if (c.in && !c.in.includes(v as string)) return false;
      if (c.lt && !((v as Date).getTime() < c.lt.getTime())) return false;
      if (c.gt && !((v as Date).getTime() > c.gt.getTime())) return false;
    } else if (v !== cond) return false;
  }
  return true;
}

function fakeDb(): { db: QueueSessionDb; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const qs = {
    create: async ({ data }: { data: Row }) => {
      rows.set(data.id, { ...data });
      return data;
    },
    findUnique: async ({ where }: { where: { id: string } }) => (rows.has(where.id) ? { ...rows.get(where.id)! } : null),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.get(where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const r of rows.values()) if (matches(r, where)) (Object.assign(r, data), count++);
      return { count };
    },
    deleteMany: async (args?: { where?: Record<string, unknown> }) => {
      let count = 0;
      for (const [id, r] of [...rows]) if (matches(r, args?.where)) (rows.delete(id), count++);
      return { count };
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
      const list = [...rows.values()].filter((r) => matches(r, args.where)).sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
      return (args.take ? list.slice(0, args.take) : list).map((r) => ({ id: r.id }));
    },
    count: async (args?: { where?: Record<string, unknown> }) => [...rows.values()].filter((r) => matches(r, args?.where)).length,
  };
  return { db: { queueSession: qs } as unknown as QueueSessionDb, rows };
}

const NOW = 2_000_000_000_000;

function setup(opts: { me?: Record<string, unknown>; tokenStatus?: number; ready?: boolean; enabled?: boolean } = {}) {
  let now = NOW;
  const state = { enabled: opts.enabled ?? true, ready: opts.ready ?? true, epoch: 0 };
  const settings: QueueAuthSettings = {
    queueEnabled: () => state.enabled,
    queueReady: () => state.ready,
    queueOauthClientId: () => "client-123",
    queueOauthClientSecret: () => "secret-xyz-123",
    queueEpoch: () => state.epoch,
    intercomRegion: () => "us",
    resolvedPublicBaseUrl: () => "https://bot.example.com/",
  };
  const teammates = new Map<string, QueueTeammate>([["11", { id: "11", name: "Ada", seated: true, away: false, bot: false }]]);
  const directory = {
    down: false,
    async seatedTeammate(id: string) {
      if (directory.down) throw new Error("intercom down");
      return teammates.get(id) ?? null;
    },
    async workspaceIdCode() {
      return "abcd1234";
    },
  };
  const { db, rows } = fakeDb();
  const sessions = new QueueSessions(db, () => now);
  const audits: QueueRefusalAudit[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const me = opts.me ?? { id: 11, name: "Ada", email: "ada@example.test", email_verified: true, app: { id_code: "abcd1234" } };
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.endsWith("/auth/eagle/token")) {
      const status = opts.tokenStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { token_type: "Bearer", access_token: "user-token-1" } : { error: "bad" }), { status });
    }
    if (url.endsWith("/me")) return new Response(JSON.stringify(me), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const auth = new QueueAuth(settings, directory, sessions, (e) => audits.push(e), fetchFn, () => now);
  return { auth, state, teammates, directory, rows, audits, calls, advance: (ms: number) => (now += ms) };
}

function cookieValue(setCookies: string[], name: string): string {
  const c = setCookies.find((x) => x.startsWith(`${name}=`));
  assert.ok(c, `cookie ${name}`);
  return c.slice(name.length + 1).split(";")[0];
}

function startFlow(auth: QueueAuth): { state: string; nonce: string } {
  const r = auth.start();
  assert.equal(r.status, 302);
  if (r.status !== 302) throw new Error("unreachable");
  const url = new URL(r.location);
  return { state: url.searchParams.get("state")!, nonce: cookieValue(r.setCookies, "__Host-queue-oauth") };
}

test("start: 404 while off, the config error while not ready, else Intercom's consent page", () => {
  assert.equal(setup({ enabled: false }).auth.start().status, 404);
  const notReady = setup({ ready: false }).auth.start();
  assert.deepEqual(notReady, { status: 302, location: "/queue?e=config", setCookies: [] });

  const { auth } = setup();
  const r = auth.start();
  assert.equal(r.status, 302);
  if (r.status !== 302) return;
  const url = new URL(r.location);
  assert.equal(url.origin + url.pathname, "https://app.intercom.com/oauth");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://bot.example.com/queue/oauth/callback");
  assert.ok((url.searchParams.get("state") ?? "").length >= 30);
  const cookie = r.setCookies[0];
  assert.match(cookie, /^__Host-queue-oauth=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
});

test("callback: a verified teammate of our workspace gets a session; the OAuth token is used once and dropped", async () => {
  const { auth, rows, calls, audits } = setup();
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "auth-code-1", state }, nonce, { ip: "1.2.3.4", ua: "UA" });
  assert.equal(r.status, 302);
  if (r.status !== 302) return;
  assert.equal(r.location, "/queue");
  const session = cookieValue(r.setCookies, "__Host-queue");
  assert.ok(session.length > 30);
  assert.ok(r.setCookies.some((c) => c.startsWith("__Host-queue-oauth=;") && c.includes("Max-Age=0")), "the state cookie is cleared");
  assert.equal(rows.size, 1);
  const row = [...rows.values()][0];
  assert.equal(row.adminId, "11");
  assert.notEqual(row.id, session, "only the hash is stored");
  assert.ok(!JSON.stringify(row).includes("user-token-1"), "the OAuth token is never stored");

  const exchange = calls.find((c) => c.url === "https://api.intercom.io/auth/eagle/token")!;
  const body = new URLSearchParams(String(exchange.init.body));
  assert.equal(body.get("code"), "auth-code-1");
  assert.equal(body.get("client_id"), "client-123");
  assert.equal(body.get("client_secret"), "secret-xyz-123");
  const me = calls.find((c) => c.url === "https://api.intercom.io/me")!;
  assert.equal((me.init.headers as Record<string, string>).Authorization, "Bearer user-token-1");
  assert.equal(audits.length, 0);

  const actor = await auth.authenticate(session);
  assert.equal(actor?.adminId, "11");
  assert.equal(actor?.name, "Ada");
});

test("callback: a replayed or foreign state is refused and audited", async () => {
  const { auth, audits } = setup();
  const { state, nonce } = startFlow(auth);
  const first = await auth.callback({ code: "c1", state }, nonce, {});
  assert.equal(first.status === 302 && first.location, "/queue");
  const replay = await auth.callback({ code: "c1", state }, nonce, {});
  assert.equal(replay.status === 302 && replay.location, "/queue?e=expired");
  assert.equal(audits.length, 1);

  // A state started in another browser (no matching cookie).
  const other = startFlow(auth);
  const csrf = await auth.callback({ code: "c2", state: other.state }, "attacker-nonce", { ip: "9.9.9.9" });
  assert.equal(csrf.status === 302 && csrf.location, "/queue?e=expired");
  assert.equal(audits[1].ip, "9.9.9.9");
});

test("callback: an expired state is refused", async () => {
  const { auth, advance } = setup();
  const { state, nonce } = startFlow(auth);
  advance(11 * 60_000);
  const r = await auth.callback({ code: "c", state }, nonce, {});
  assert.equal(r.status === 302 && r.location, "/queue?e=expired");
});

test("callback: Cancel on Intercom's screen is not audited", async () => {
  const { auth, audits } = setup();
  const r = await auth.callback({ error: "access_denied" }, "", {});
  assert.equal(r.status === 302 && r.location, "/queue?e=denied");
  assert.equal(audits.length, 0);
});

for (const [name, me, code] of [
  ["an unverified email", { id: 11, name: "Ada", email: "a@x.test", email_verified: false, app: { id_code: "abcd1234" } }, "unverified"],
  ["another workspace", { id: 11, name: "Ada", email: "a@x.test", email_verified: true, app: { id_code: "zzzz9999" } }, "workspace"],
  ["a teammate without a seat", { id: 13, name: "Lite", email: "l@x.test", email_verified: true, app: { id_code: "abcd1234" } }, "seat"],
] as const) {
  test(`callback: ${name} is refused with an audit naming them`, async () => {
    const { auth, audits, rows } = setup({ me });
    const { state, nonce } = startFlow(auth);
    const r = await auth.callback({ code: "c", state }, nonce, { ip: "5.5.5.5" });
    assert.equal(r.status === 302 && r.location, `/queue?e=${code}`);
    assert.equal(rows.size, 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].teammate?.name, me.name);
    assert.ok(!JSON.stringify(audits[0]).includes("user-token-1"));
  });
}

test("callback: a failed token exchange is an error, not a session", async () => {
  const { auth, rows } = setup({ tokenStatus: 400 });
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "c", state }, nonce, {});
  assert.equal(r.status === 302 && r.location, "/queue?e=error");
  assert.equal(rows.size, 0);
});

test("callback: a malformed code never reaches Intercom", async () => {
  const { auth, calls } = setup();
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "a b<c>", state }, nonce, {});
  assert.equal(r.status === 302 && r.location, "/queue?e=error");
  assert.equal(calls.length, 0);
});

test("sessions: re-verified every few minutes; a removed teammate is signed out", async () => {
  const { auth, teammates, advance, rows } = setup();
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "c", state }, nonce, {});
  if (r.status !== 302) return assert.fail();
  const cookie = cookieValue(r.setCookies, "__Host-queue");
  advance(6 * 60_000);
  teammates.delete("11");
  assert.equal(await auth.authenticate(cookie), null);
  assert.equal(rows.size, 0, "the session row is gone");
});

test("sessions: Intercom down keeps a session for a grace period, then stops", async () => {
  const { auth, directory, advance } = setup();
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "c", state }, nonce, {});
  if (r.status !== 302) return assert.fail();
  const cookie = cookieValue(r.setCookies, "__Host-queue");
  directory.down = true;
  advance(10 * 60_000);
  assert.equal((await auth.authenticate(cookie))?.adminId, "11");
  advance(25 * 60_000);
  assert.equal(await auth.authenticate(cookie), null);
});

test("sessions: an epoch bump signs everyone out; switching the queue off rejects every cookie", async () => {
  const { auth, state: st } = setup();
  const { state, nonce } = startFlow(auth);
  const r = await auth.callback({ code: "c", state }, nonce, {});
  if (r.status !== 302) return assert.fail();
  const cookie = cookieValue(r.setCookies, "__Host-queue");
  st.enabled = false;
  assert.equal(await auth.authenticate(cookie), null);
  st.enabled = true;
  assert.ok(await auth.authenticate(cookie));
  st.epoch = 1;
  assert.equal(await auth.authenticate(cookie), null);
  assert.equal(await auth.authenticate("garbage"), null);
});
