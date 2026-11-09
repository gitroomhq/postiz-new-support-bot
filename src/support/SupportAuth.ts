import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hashPassphrase, verifyPassphrase } from "../dashboard/auth/passphrase";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";
import { SUPPORT_ABSOLUTE_TTL_MS, type SupportSessions } from "./SupportSessions";
import type { SupportCredentials } from "./SupportStores";

const authLog = log.child("support:auth");

// Sign-in for the support dashboard (/support), in four steps:
//  1. the teammate runs /support in Discord (staff only) and gets a code,
//  2. they type it on the page, which proves the browser belongs to that
//     Discord account, and the bot DMs them a second code,
//  3. they type the DM code,
//  4. they enter their password, or choose one at their first sign-in.
// Every request re-checks that the teammate is still staff (Administrator or
// a support tier role) every few minutes; losing the role ends the session.

export const SUPPORT_COOKIE = "__Host-support";
export const SUPPORT_BASE_PATH = "/support";
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 200;

const CODE_TTL_MS = 10 * 60_000;
const DM_CODE_TTL_MS = 10 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const MAX_DM_ATTEMPTS = 5;
const MAX_ENTRIES = 500;
const VERIFY_EVERY_MS = 5 * 60_000;
// Discord down: a session keeps working this long past its last check.
const VERIFY_GRACE_MS = 30 * 60_000;
// Wrong Discord codes from anywhere, before code entry pauses for everyone.
// The codes carry 40 bits and live ten minutes; this caps a spray across IPs.
const CODE_FAILS_WINDOW_MS = 10 * 60_000;
const CODE_FAILS_MAX = 200;
// Per teammate: every 5th wrong password locks the next try out: 1 minute at
// 5, 15 minutes from 10, and from 25 on every wrong password locks for 1 hour.
export function lockoutUntil(fails: number, now: number): number | null {
  if (fails >= 25) return now + 60 * 60_000;
  if (fails % 5 !== 0) return null;
  return now + (fails >= 10 ? 15 * 60_000 : 60_000);
}
// No 0/O or 1/I: the code is read off one screen and typed into another.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export interface SupportActor {
  id: string; // Discord user id
  name: string;
  sessionIdHash: string;
}

export interface SupportStaffDirectory {
  // The member's display name when they are staff, null when they are not (or
  // left the server). Throws when Discord cannot be asked.
  staff(discordUserId: string): Promise<{ name: string } | null>;
  // DM a teammate; false when Discord would not deliver it.
  dm(discordUserId: string, text: string): Promise<boolean>;
}

export interface SupportAuthSettings {
  supportDashEnabled(): boolean;
  supportDashEpoch(): number;
}

export interface SupportAuthResult {
  status: number;
  json: Record<string, unknown>;
  setCookie?: string;
}

interface Pending {
  userId: string;
  name: string;
  at: number;
  step: "dm" | "password";
  dmHash: string;
  dmAt: number;
  attempts: number;
}

export interface PasswordHasher {
  hash(password: string): string;
  verify(password: string, stored: string | null): boolean;
}

const SCRYPT: PasswordHasher = { hash: hashPassphrase, verify: verifyPassphrase };

export class SupportAuth {
  private codes = new Map<string, { userId: string; name: string; at: number }>();
  private pending = new Map<string, Pending>();
  private failures = new Map<string, { fails: number; lockedUntil: number }>();
  private codeFails: number[] = [];

  constructor(
    private settings: SupportAuthSettings,
    private directory: SupportStaffDirectory,
    private sessions: SupportSessions,
    private credentials: SupportCredentials,
    private now: () => number = Date.now,
    private hasher: PasswordHasher = SCRYPT
  ) {}

  // ---- step 1: /support in Discord (the caller checked staff) ----

  issueCode(userId: string, name: string): { code: string; minutes: number } {
    this.prune();
    for (const [key, c] of this.codes) if (c.userId === userId) this.codes.delete(key);
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.codes.set(sha256(code), { userId, name, at: this.now() });
    return { code: `${code.slice(0, 4)} ${code.slice(4)}`, minutes: CODE_TTL_MS / 60_000 };
  }

  // ---- steps 2 to 4: session-less endpoints on the page ----

  async publicEndpoint(endpoint: string, body: Record<string, unknown>, meta: { ip?: string; ua?: string }): Promise<SupportAuthResult | null> {
    if (endpoint === "login-code") return this.loginCode(body);
    if (endpoint === "login-dm") return this.loginDm(body);
    if (endpoint === "login-password") return this.loginPassword(body, meta);
    return null;
  }

  private async loginCode(body: Record<string, unknown>): Promise<SupportAuthResult> {
    this.prune();
    const now = this.now();
    this.codeFails = this.codeFails.filter((t) => now - t < CODE_FAILS_WINDOW_MS);
    if (this.codeFails.length >= CODE_FAILS_MAX) {
      return fail("Too many wrong codes. Try again in a few minutes.");
    }
    const code = normalizeCode(body.code);
    const key = code ? sha256(code) : "";
    const entry = key ? this.codes.get(key) : undefined;
    if (key) this.codes.delete(key); // single use, whatever happens next
    if (!entry || now - entry.at > CODE_TTL_MS) {
      this.codeFails.push(now);
      metricCount("support.signin", 1, { outcome: "bad_code" });
      return fail("That code is wrong or expired. Run /support in Discord for a new one.", "code");
    }

    let staff: { name: string } | null;
    try {
      staff = await this.directory.staff(entry.userId);
    } catch {
      return fail("Discord did not answer. Try again in a minute.");
    }
    if (!staff) {
      metricCount("support.signin", 1, { outcome: "not_staff" });
      return fail("Only support staff can sign in here.");
    }

    const dmCode = String(randomInt(1_000_000)).padStart(6, "0");
    const token = randomBytes(32).toString("base64url");
    this.pending.set(sha256(token), {
      userId: entry.userId,
      name: staff.name,
      at: now,
      step: "dm",
      dmHash: sha256(dmCode),
      dmAt: now,
      attempts: 0,
    });
    const sent = await this.directory
      .dm(entry.userId, `Support dashboard sign-in code: **${dmCode.slice(0, 3)} ${dmCode.slice(3)}**\nIt expires in 10 minutes. If you are not signing in right now, ignore it.`)
      .catch(() => false);
    if (!sent) {
      this.pending.delete(sha256(token));
      return fail("The bot could not DM you. Allow direct messages from server members, then run /support again.");
    }
    return { status: 200, json: { ok: true, step: "dm", pending: token } };
  }

  private async loginDm(body: Record<string, unknown>): Promise<SupportAuthResult> {
    const p = this.pendingFor(body.pending, "dm");
    if (!p) return restart();
    const now = this.now();
    if (now - p.entry.dmAt > DM_CODE_TTL_MS) {
      this.pending.delete(p.key);
      return restart("That DM code expired. Run /support in Discord again.");
    }
    p.entry.attempts += 1;
    const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
    if (code.length !== 6 || !ctEqual(sha256(code), p.entry.dmHash)) {
      if (p.entry.attempts >= MAX_DM_ATTEMPTS) {
        this.pending.delete(p.key);
        return restart("Too many wrong codes. Run /support in Discord again.");
      }
      return fail("That code does not match the DM.", "code");
    }
    p.entry.step = "password";
    p.entry.at = now;
    const cred = await this.credentials.get(p.entry.userId);
    return { status: 200, json: { ok: true, step: "password", hasPassword: !!cred, name: p.entry.name } };
  }

  private async loginPassword(body: Record<string, unknown>, meta: { ip?: string; ua?: string }): Promise<SupportAuthResult> {
    const p = this.pendingFor(body.pending, "password");
    if (!p) return restart();
    const { userId, name } = p.entry;
    const now = this.now();
    const lock = this.failures.get(userId);
    if (lock && lock.lockedUntil > now) {
      return fail(`Too many wrong passwords. Try again in ${Math.ceil((lock.lockedUntil - now) / 60_000)} minute(s).`);
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || password.length > MAX_PASSWORD_LENGTH) return fail("Enter your password.", "password");

    const cred = await this.credentials.get(userId);
    if (!cred) {
      if (password.length < MIN_PASSWORD_LENGTH) return fail(`At least ${MIN_PASSWORD_LENGTH} characters.`, "password");
      if (body.repeat !== password) return fail("The two passwords differ.", "repeat");
      if (!(await this.credentials.create(userId, name, this.hasher.hash(password)))) {
        this.pending.delete(p.key);
        return restart("A password was set meanwhile. Run /support in Discord again.");
      }
      authLog.info("support password set", { "discord.user_id": userId });
    } else if (!this.hasher.verify(password, cred.passwordHash)) {
      const fails = (lock?.fails ?? 0) + 1;
      this.failures.set(userId, { fails, lockedUntil: lockoutUntil(fails, now) ?? lock?.lockedUntil ?? 0 });
      metricCount("support.signin", 1, { outcome: "bad_password" });
      return fail("Wrong password.", "password");
    } else {
      await this.credentials.touchLogin(userId, name);
    }

    this.failures.delete(userId);
    this.pending.delete(p.key);
    const token = await this.sessions.create({
      discordUserId: userId,
      name,
      epoch: this.settings.supportDashEpoch(),
      ip: meta.ip,
      ua: meta.ua,
    });
    metricCount("support.signin", 1, { outcome: "ok" });
    authLog.info("support sign-in", { "discord.user_id": userId });
    return {
      status: 200,
      json: { ok: true, step: "done" },
      setCookie: `${SUPPORT_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SUPPORT_ABSOLUTE_TTL_MS / 1000)}`,
    };
  }

  // ---- per request ----

  async authenticate(cookie: string, meta?: { ip?: string }): Promise<SupportActor | null> {
    if (!cookie || !this.settings.supportDashEnabled()) return null;
    const session = await this.sessions.get(cookie, this.settings.supportDashEpoch(), meta);
    if (!session) return null;
    const age = this.now() - session.lastVerifiedAt.getTime();
    let name = session.name;
    if (age > VERIFY_EVERY_MS) {
      let staff: { name: string } | null;
      try {
        staff = await this.directory.staff(session.discordUserId);
      } catch {
        if (age > VERIFY_GRACE_MS) return null;
        return { id: session.discordUserId, name, sessionIdHash: session.idHash };
      }
      if (!staff) {
        await this.sessions.deleteForUser(session.discordUserId);
        authLog.info("support sessions ended: no longer staff", { "discord.user_id": session.discordUserId });
        return null;
      }
      name = staff.name;
      await this.sessions.markVerified(session.idHash, name);
    }
    return { id: session.discordUserId, name, sessionIdHash: session.idHash };
  }

  async logout(actor: SupportActor): Promise<void> {
    await this.sessions.delete(actor.sessionIdHash);
  }

  // Admin reset from /config: the password goes, and so does every session.
  async resetPassword(discordUserId: string): Promise<{ removed: boolean; sessions: number }> {
    const removed = await this.credentials.reset(discordUserId);
    const sessions = await this.sessions.deleteForUser(discordUserId);
    this.failures.delete(discordUserId);
    return { removed, sessions };
  }

  // ---- internals ----

  private pendingFor(raw: unknown, step: Pending["step"]): { key: string; entry: Pending } | null {
    if (typeof raw !== "string" || !raw || raw.length > 100) return null;
    this.prune();
    const key = sha256(raw);
    const entry = this.pending.get(key);
    if (!entry || entry.step !== step) return null;
    return { key, entry };
  }

  private prune(): void {
    const now = this.now();
    for (const [k, c] of this.codes) if (now - c.at > CODE_TTL_MS) this.codes.delete(k);
    for (const [k, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this.pending.delete(k);
    for (const map of [this.codes, this.pending] as Array<Map<string, unknown>>) {
      while (map.size > MAX_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
    if (this.failures.size > 2000) {
      for (const [k, f] of this.failures) if (f.lockedUntil < now) this.failures.delete(k);
    }
  }
}

// "k7q2-9xmd" → "K7Q2 9XMD" without the separator; null when it cannot be a code.
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const v = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (v.length !== CODE_LENGTH) return null;
  for (const ch of v) if (!CODE_ALPHABET.includes(ch)) return null;
  return v;
}

function fail(error: string, field?: string): SupportAuthResult {
  return { status: 200, json: { ok: false, error, ...(field ? { field } : {}) } };
}

function restart(error = "That sign-in expired. Run /support in Discord again."): SupportAuthResult {
  return { status: 200, json: { ok: false, error, restart: true } };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
