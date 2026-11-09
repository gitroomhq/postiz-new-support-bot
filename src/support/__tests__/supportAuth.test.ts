import { test } from "node:test";
import assert from "node:assert/strict";
import { SupportAuth, lockoutUntil, normalizeCode, type PasswordHasher, type SupportStaffDirectory } from "../SupportAuth";
import { SupportSessions, type SupportSessionDb } from "../SupportSessions";
import type { SupportCredentials } from "../SupportStores";

// Sign-in: a code from /support (single use, ten minutes), a DM code (five
// tries), then a password (set at the first sign-in, locked out after wrong
// tries). A session ends when its teammate stops being staff. Discord, the
// database and scrypt are fakes.

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

function fakeSessionDb(): SupportSessionDb {
  const rows = new Map<string, Row>();
  const ss = {
    create: async ({ data }: { data: Row }) => (rows.set(data.id, { ...data }), data),
    findUnique: async ({ where }: { where: { id: string } }) => (rows.has(where.id) ? { ...rows.get(where.id)! } : null),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.get(where.id)!, data),
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
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) =>
      [...rows.values()].filter((r) => matches(r, args.where)).slice(0, args.take ?? 1000).map((r) => ({ id: r.id })),
    count: async (args?: { where?: Record<string, unknown> }) => [...rows.values()].filter((r) => matches(r, args?.where)).length,
  };
  return { supportSession: ss } as unknown as SupportSessionDb;
}

function fakeCredentials(): SupportCredentials & { rows: Map<string, { passwordHash: string; name: string }> } {
  const rows = new Map<string, { passwordHash: string; name: string }>();
  return {
    rows,
    get: async (id: string) => (rows.has(id) ? { discordUserId: id, ...rows.get(id)! } : null),
    create: async (id: string, name: string, passwordHash: string) => {
      if (rows.has(id)) return false;
      rows.set(id, { name, passwordHash });
      return true;
    },
    touchLogin: async () => undefined,
    reset: async (id: string) => rows.delete(id),
  } as unknown as SupportCredentials & { rows: Map<string, { passwordHash: string; name: string }> };
}

const HASHER: PasswordHasher = {
  hash: (p) => `h:${p}`,
  verify: (p, stored) => stored === `h:${p}`,
};

function setup(opts: { staff?: Set<string>; dmOk?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const staff = opts.staff ?? new Set(["111111111111111111"]);
  const dms: Array<{ to: string; text: string }> = [];
  let discordDown = false;
  const directory: SupportStaffDirectory = {
    staff: async (id) => {
      if (discordDown) throw new Error("discord down");
      return staff.has(id) ? { name: "Mara" } : null;
    },
    dm: async (to, text) => {
      if (opts.dmOk === false) return false;
      dms.push({ to, text });
      return true;
    },
  };
  const settings = { enabled: true, epoch: 0, supportDashEnabled: () => settings.enabled, supportDashEpoch: () => settings.epoch };
  const sessions = new SupportSessions(fakeSessionDb(), clock.now);
  const creds = fakeCredentials();
  const auth = new SupportAuth(settings, directory, sessions, creds, clock.now, HASHER);
  const dmCode = () => (/\*\*(\d{3}) (\d{3})\*\*/.exec(dms[dms.length - 1]?.text ?? "") ?? []).slice(1).join("");
  return { auth, clock, staff, dms, dmCode, creds, settings, setDiscordDown: (v: boolean) => (discordDown = v) };
}

async function signIn(s: ReturnType<typeof setup>, password = "correct horse battery", userId = "111111111111111111") {
  const { code } = s.auth.issueCode(userId, "Mara");
  const step1 = await s.auth.publicEndpoint("login-code", { code }, {});
  assert.equal(step1?.json.ok, true, JSON.stringify(step1?.json));
  const pending = step1!.json.pending as string;
  const step2 = await s.auth.publicEndpoint("login-dm", { pending, code: s.dmCode() }, {});
  assert.equal(step2?.json.ok, true, JSON.stringify(step2?.json));
  const step3 = await s.auth.publicEndpoint("login-password", { pending, password, repeat: password }, { ip: "203.0.113.9" });
  return { step2: step2!, step3: step3! };
}

function cookieToken(setCookie: string | undefined): string {
  const m = /^__Host-support=([^;]+);/.exec(setCookie ?? "");
  assert.ok(m, `no cookie in ${setCookie}`);
  return m[1];
}

test("first sign-in: code, DM code, chosen password, then a working session", async () => {
  const s = setup();
  const { step2, step3 } = await signIn(s);
  assert.equal(step2.json.hasPassword, false);
  assert.equal(step3.json.ok, true);
  assert.match(step3.setCookie ?? "", /HttpOnly; SameSite=Strict/);
  assert.equal(s.creds.rows.get("111111111111111111")?.passwordHash, "h:correct horse battery");
  const actor = await s.auth.authenticate(cookieToken(step3.setCookie));
  assert.equal(actor?.id, "111111111111111111");
  assert.equal(s.dms[0].to, "111111111111111111");
});

test("a chosen password needs 12 characters and the same twice", async () => {
  const s = setup();
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  const pending = (await s.auth.publicEndpoint("login-code", { code }, {}))!.json.pending as string;
  await s.auth.publicEndpoint("login-dm", { pending, code: s.dmCode() }, {});
  const short = await s.auth.publicEndpoint("login-password", { pending, password: "short", repeat: "short" }, {});
  assert.equal(short?.json.field, "password");
  const differ = await s.auth.publicEndpoint("login-password", { pending, password: "long enough pass", repeat: "long enough pasS" }, {});
  assert.equal(differ?.json.field, "repeat");
  assert.equal(s.creds.rows.size, 0);
});

test("a Discord code works once and for ten minutes", async () => {
  const s = setup();
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  assert.equal((await s.auth.publicEndpoint("login-code", { code: code.toLowerCase().replace(" ", "-") }, {}))?.json.ok, true);
  assert.equal((await s.auth.publicEndpoint("login-code", { code }, {}))?.json.ok, false);
  const second = s.auth.issueCode("111111111111111111", "Mara");
  s.clock.advance(11 * 60_000);
  assert.equal((await s.auth.publicEndpoint("login-code", { code: second.code }, {}))?.json.ok, false);
});

test("a new /support replaces the teammate's earlier code", async () => {
  const s = setup();
  const first = s.auth.issueCode("111111111111111111", "Mara");
  s.auth.issueCode("111111111111111111", "Mara");
  assert.equal((await s.auth.publicEndpoint("login-code", { code: first.code }, {}))?.json.ok, false);
});

test("someone who lost the support role between /support and the page is refused", async () => {
  const s = setup();
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  s.staff.clear();
  const res = await s.auth.publicEndpoint("login-code", { code }, {});
  assert.equal(res?.json.ok, false);
  assert.equal(s.dms.length, 0);
});

test("closed DMs stop the sign-in at step two", async () => {
  const s = setup({ dmOk: false });
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  const res = await s.auth.publicEndpoint("login-code", { code }, {});
  assert.equal(res?.json.ok, false);
  assert.match(String(res?.json.error), /could not DM/);
});

test("five wrong DM codes end the sign-in", async () => {
  const s = setup();
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  const pending = (await s.auth.publicEndpoint("login-code", { code }, {}))!.json.pending as string;
  const wrong = s.dmCode() === "000000" ? "000001" : "000000";
  for (let i = 0; i < 4; i++) assert.equal((await s.auth.publicEndpoint("login-dm", { pending, code: wrong }, {}))?.json.restart, undefined);
  assert.equal((await s.auth.publicEndpoint("login-dm", { pending, code: wrong }, {}))?.json.restart, true);
  assert.equal((await s.auth.publicEndpoint("login-dm", { pending, code: s.dmCode() }, {}))?.json.restart, true);
});

test("the password step cannot be reached without the DM code", async () => {
  const s = setup();
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  const pending = (await s.auth.publicEndpoint("login-code", { code }, {}))!.json.pending as string;
  const res = await s.auth.publicEndpoint("login-password", { pending, password: "correct horse battery", repeat: "correct horse battery" }, {});
  assert.equal(res?.json.restart, true);
  assert.equal(s.creds.rows.size, 0);
});

test("a returning teammate's wrong password counts toward a lockout", async () => {
  const s = setup();
  await signIn(s);
  const { code } = s.auth.issueCode("111111111111111111", "Mara");
  const pending = (await s.auth.publicEndpoint("login-code", { code }, {}))!.json.pending as string;
  const step2 = await s.auth.publicEndpoint("login-dm", { pending, code: s.dmCode() }, {});
  assert.equal(step2?.json.hasPassword, true);
  for (let i = 0; i < 5; i++) {
    assert.equal((await s.auth.publicEndpoint("login-password", { pending, password: "wrong password!" }, {}))?.json.error, "Wrong password.");
  }
  const locked = await s.auth.publicEndpoint("login-password", { pending, password: "correct horse battery" }, {});
  assert.match(String(locked?.json.error), /Too many wrong passwords/);
  s.clock.advance(61_000);
  const ok = await s.auth.publicEndpoint("login-password", { pending, password: "correct horse battery" }, {});
  assert.equal(ok?.json.ok, true);
});

test("the lockout keeps locking: 1 minute at 5, 15 from 10, an hour every try from 25", () => {
  assert.equal(lockoutUntil(4, 0), null);
  assert.equal(lockoutUntil(5, 0), 60_000);
  assert.equal(lockoutUntil(7, 0), null);
  assert.equal(lockoutUntil(10, 0), 15 * 60_000);
  assert.equal(lockoutUntil(20, 0), 15 * 60_000);
  assert.equal(lockoutUntil(26, 0), 60 * 60_000);
});

test("losing the staff role ends every session at the next check; a Discord outage does not", async () => {
  const s = setup();
  const token = cookieToken((await signIn(s)).step3.setCookie);
  s.clock.advance(6 * 60_000);
  s.setDiscordDown(true);
  assert.ok(await s.auth.authenticate(token), "kept during a short outage");
  s.setDiscordDown(false);
  s.staff.clear();
  assert.equal(await s.auth.authenticate(token), null);
  s.staff.add("111111111111111111");
  assert.equal(await s.auth.authenticate(token), null, "the session is gone, not paused");
});

test("switching the dashboard off or bumping the epoch signs everyone out", async () => {
  const s = setup();
  const token = cookieToken((await signIn(s)).step3.setCookie);
  s.settings.enabled = false;
  assert.equal(await s.auth.authenticate(token), null);
  s.settings.enabled = true;
  assert.ok(await s.auth.authenticate(token));
  s.settings.epoch = 1;
  assert.equal(await s.auth.authenticate(token), null);
});

test("an admin reset removes the password and the teammate's sessions", async () => {
  const s = setup();
  const token = cookieToken((await signIn(s)).step3.setCookie);
  const res = await s.auth.resetPassword("111111111111111111");
  assert.deepEqual(res, { removed: true, sessions: 1 });
  assert.equal(await s.auth.authenticate(token), null);
  const again = await signIn(s, "a brand new password");
  assert.equal(again.step2.json.hasPassword, false);
});

test("codes are read leniently and rejected strictly", () => {
  assert.equal(normalizeCode("k7q2 9xmd"), "K7Q29XMD");
  assert.equal(normalizeCode("K7Q2-9XMD"), "K7Q29XMD");
  assert.equal(normalizeCode("K7Q29XM"), null);
  assert.equal(normalizeCode("K7Q29XM0"), null, "0 is not in the alphabet");
  assert.equal(normalizeCode(42), null);
});
