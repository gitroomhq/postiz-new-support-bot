import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SettingsStore, DashboardAdminRole } from "../config/SettingsStore";
import { DashboardTokens } from "./DashboardTokens";
import { DashboardUiState } from "./renderer/contract";
import { CredentialStore } from "./auth/CredentialStore";
import { DashboardDbSessions, StandingSession, hashSessionToken, ABSOLUTE_TTL_MS } from "./auth/DashboardDbSessions";
import { DashboardAudit } from "./auth/DashboardAudit";
import {
  ChallengeStore,
  checkAuthentication,
  checkRegistration,
  makeAuthenticationOptions,
  makeRegistrationOptions,
  rpFromBaseUrl,
} from "./auth/webauthnSupport";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { log } from "../util/logger";

const authLog = log.child("dashboard:auth");

// The auth seam between transport (Dashboard.ts) and the concrete auth model.
// Section modules only ever see a DashboardActor + state.

export interface DashboardActor {
  id: string; // Discord user id
  name: string;
  role: DashboardAdminRole;
  isAdmin: boolean; // role === "admin" — re-resolved from settings per request
}

export interface DashboardAuthResult {
  actor: DashboardActor;
  state: DashboardUiState; // "locked" | "active" (never "expired" — that's null)
  activationCode?: string; // present while locked (rendered by the lock overlay)
  sessionIdHash: string;
  authMethod: "passkey" | "totp" | "breakglass";
  // T2 ceremonies: was a fresh factor asserted within the window?
  stepUpFresh(windowMs?: number): boolean;
  // Verify + consume a Discord reverse code for THIS request (T3 ceremonies).
  consumeReverse(code: string): boolean;
  // Terminate this session (the topbar "End session" button).
  logout(): Promise<void>;
}

export interface AuthEndpointResult {
  status: number;
  json: object;
  setCookie?: string;
}

export interface DashboardAuthProvider {
  // GET /billing — resume a cookie session, exchange a break-glass link
  // token, or serve the shell in login mode (standing URL, no credentials yet).
  enter(input: {
    token: string;
    cookie: string;
    ip?: string;
    ua?: string;
  }): Promise<{ kind: "page"; sessionCookie?: string } | { kind: "reject"; status: number; message: string }>;
  // POST /billing/api/* — cookie → subject; null = 401/expired.
  authenticate(cookie: string, meta?: { ip?: string }): Promise<DashboardAuthResult | null>;
  // Session-LESS endpoints (the login ceremony + the pre-login activation
  // poll). null = unknown endpoint.
  publicEndpoint(endpoint: string, body: unknown, meta: { ip?: string; ua?: string }): Promise<AuthEndpointResult | null>;
  // Session-BOUND auth endpoints (step-up, passkey registration). null = unknown.
  sessionEndpoint(
    endpoint: string,
    auth: DashboardAuthResult,
    body: unknown,
    meta: { ip?: string; ua?: string }
  ): Promise<AuthEndpointResult | null>;
}

// ---- the standing stack (passkey → passphrase → Discord DM activation) ----

const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
const REVERSE_TTL_MS = 5 * 60 * 1000;
const MAX_REVERSE_ATTEMPTS = 5;
const JTI_RETENTION_MS = 20 * 60 * 1000;
const COOKIE_MAX_AGE_S = Math.floor(ABSOLUTE_TTL_MS / 1000);

// Per-identity lockout ladder: 5 → 60s, 10 → 15min, 25 → 1h.
const LOCKOUT_STEPS: Array<{ fails: number; lockMs: number }> = [
  { fails: 25, lockMs: 60 * 60 * 1000 },
  { fails: 10, lockMs: 15 * 60 * 1000 },
  { fails: 5, lockMs: 60 * 1000 },
];

export interface LoginNotifier {
  // DM the admin about a fresh LOCKED session (activation buttons live in the
  // DM). Best-effort — login proceeds even if the DM fails (the /billing
  // Activate button is the fallback).
  notifyLogin(discordUserId: string, info: { method: string; ip?: string; ua?: string }): Promise<void>;
  // Alert on lockout-ladder escalation.
  notifyLockout(discordUserId: string, fails: number): Promise<void>;
}

export class StandingDashboardAuth implements DashboardAuthProvider {
  private challenges = new ChallengeStore();
  private usedJtis = new Map<string, number>();
  // Passkey verified, passphrase pending.
  private pendingLogins = new Map<string, { userId: string; name: string; credRowId: string; credentialId: string; at: number }>();
  // T3 reverse codes, keyed by session idHash.
  private reverse = new Map<string, { code: string; issuedAt: number; attempts: number }>();
  private failures = new Map<string, { fails: number; lockedUntil: number }>();
  private notifier: LoginNotifier | null = null;

  constructor(
    private settings: SettingsStore,
    private tokens: DashboardTokens,
    private sessions: DashboardDbSessions,
    private credentials: CredentialStore,
    private audit: DashboardAudit
  ) {}

  bindNotifier(notifier: LoginNotifier): void {
    this.notifier = notifier;
  }

  // ---- page entry ----

  async enter(input: {
    token: string;
    cookie: string;
    ip?: string;
    ua?: string;
  }): Promise<{ kind: "page"; sessionCookie?: string } | { kind: "reject"; status: number; message: string }> {
    // 1) A live cookie session resumes silently (reload / deep link / daily use).
    if (input.cookie && (await this.sessions.get(input.cookie, this.settings.dashboardEpoch(), { ip: input.ip }))) {
      return { kind: "page" };
    }
    // 2) A break-glass link token (minted from /billing) starts a LOCKED
    //    session with the Discord passcode ceremony.
    if (input.token) {
      const payload = this.tokens.verify(input.token, "open");
      if (!payload) {
        return { kind: "reject", status: 401, message: "This dashboard link is invalid or expired. Re-open it from /billing." };
      }
      const role = this.settings.dashboardAdminRole(payload.sub);
      if (!role) {
        authLog.warn("dashboard link for non-allowlisted user rejected", { "discord.user_id": payload.sub });
        return { kind: "reject", status: 403, message: "You are not on the dashboard allowlist (Dashboard hub → Dashboard admins)." };
      }
      if (!this.consumeJti(payload.jti)) {
        authLog.warn("dashboard link replay rejected", { "discord.user_id": payload.sub });
        return { kind: "reject", status: 401, message: "This dashboard link was already used. Mint a fresh one from /billing." };
      }
      const { token } = await this.sessions.create({
        discordUserId: payload.sub,
        adminName: payload.an,
        epoch: this.settings.dashboardEpoch(),
        authMethod: "breakglass",
        ip: input.ip,
        ua: input.ua,
      });
      await this.audit.record({
        actorId: payload.sub,
        actorName: payload.an,
        kind: "auth",
        action: "login.breakglass",
        summary: "Break-glass link exchanged (locked session)",
        outcome: "ok",
        ip: input.ip,
        sessionIdHash: hashSessionToken(token),
      });
      return { kind: "page", sessionCookie: this.cookieFor(token) };
    }
    // 3) Standing URL with no session: serve the shell in login mode.
    return { kind: "page" };
  }

  // ---- per-request session auth ----

  async authenticate(cookie: string, meta?: { ip?: string }): Promise<DashboardAuthResult | null> {
    if (!cookie) return null;
    const session = await this.sessions.get(cookie, this.settings.dashboardEpoch(), meta);
    if (!session) return null;
    // Allowlist re-check on EVERY request — removal kills live sessions.
    const role = this.settings.dashboardAdminRole(session.discordUserId);
    if (!role) {
      await this.sessions.delete(session.idHash);
      return null;
    }
    return this.resultFor(session, role);
  }

  private resultFor(session: StandingSession, role: DashboardAdminRole): DashboardAuthResult {
    return {
      actor: { id: session.discordUserId, name: session.adminName, role, isAdmin: role === "admin" },
      state: session.state,
      ...(session.state === "locked" && session.activationCode ? { activationCode: session.activationCode } : {}),
      sessionIdHash: session.idHash,
      authMethod: session.authMethod,
      stepUpFresh: (windowMs = STEP_UP_WINDOW_MS) =>
        session.stepUpAt != null && Date.now() - session.stepUpAt.getTime() < windowMs,
      consumeReverse: (code: string) => this.consumeReverse(session.idHash, code),
      logout: async () => {
        await this.sessions.delete(session.idHash);
      },
    };
  }

  // ---- session-less endpoints (login ceremony) ----

  async publicEndpoint(endpoint: string, body: unknown, meta: { ip?: string; ua?: string }): Promise<AuthEndpointResult | null> {
    const request = (body ?? {}) as Record<string, unknown>;
    switch (endpoint) {
      // The shell's first poll when no session exists → login mode.
      case "activation-status": {
        return { status: 200, json: { state: "login", passkey: this.rp() != null } };
      }
      case "auth-passkey-options": {
        const rp = this.rp();
        if (!rp) return { status: 400, json: { error: "Public base URL is not configured." } };
        const { options, challenge } = await makeAuthenticationOptions(rp);
        this.challenges.remember(challenge);
        return { status: 200, json: { options } };
      }
      case "auth-passkey": {
        const rp = this.rp();
        if (!rp) return { status: 400, json: { error: "Public base URL is not configured." } };
        const response = request.response as AuthenticationResponseJSON | undefined;
        const challenge = this.challengeFrom(response);
        if (!response || !challenge || !this.challenges.consume(challenge)) {
          return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        }
        const row = await this.credentials.findPasskeyByCredentialId(response.id ?? "");
        const cred = row ? this.credentials.toWebAuthnCredential(row) : null;
        if (!row || !cred) return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        const role = this.settings.dashboardAdminRole(row.discordUserId);
        if (!role) return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        const verified = await checkAuthentication(rp, response, challenge, cred);
        if (!verified) {
          await this.recordFailure(row.discordUserId, "login.passkey", meta);
          return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        }
        const { regressed } = await this.credentials.recordPasskeyUse(row.id, verified.newCounter);
        if (regressed) {
          await this.audit.record({
            actorId: row.discordUserId,
            actorName: this.nameFor(row.discordUserId),
            kind: "auth",
            action: "passkey.signcount_regressed",
            summary: `Sign counter regressed on "${row.label ?? row.id}": possible cloned authenticator`,
            outcome: "ok",
            ip: meta.ip,
          });
        }
        // Passkey good → passphrase step (knowledge factor).
        const loginId = hashSessionToken(`${row.id}:${Date.now()}:${Math.random()}`).slice(0, 32);
        this.prunePendingLogins();
        this.pendingLogins.set(loginId, {
          userId: row.discordUserId,
          name: this.nameFor(row.discordUserId),
          credRowId: row.id,
          credentialId: row.credentialId ?? "",
          at: Date.now(),
        });
        return { status: 200, json: { ok: true, next: "passphrase", loginId } };
      }
      case "auth-passphrase": {
        const loginId = typeof request.loginId === "string" ? request.loginId : "";
        const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
        this.prunePendingLogins();
        const pending = this.pendingLogins.get(loginId);
        if (!pending) return { status: 200, json: { ok: false, error: "Sign-in expired. Start over." } };
        const locked = this.lockedFor(pending.userId);
        if (locked) return { status: 200, json: { ok: false, error: locked } };
        if (!(await this.credentials.checkPassphrase(pending.userId, passphrase))) {
          await this.recordFailure(pending.userId, "login.passphrase", meta);
          return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        }
        this.pendingLogins.delete(loginId);
        this.clearFailures(pending.userId);
        return this.startLockedSession(pending.userId, pending.name, "passkey", pending.credentialId, meta);
      }
      case "auth-totp-login": {
        // Fallback path (no passkey available): identity + passphrase + code
        // in one shot. Anti-oracle: every failure is the same string, and the
        // passphrase check runs (dummy scrypt) even for unknown ids.
        const userId = typeof request.userId === "string" ? request.userId.trim() : "";
        const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
        const code = typeof request.code === "string" ? request.code : "";
        const locked = this.lockedFor(userId);
        if (locked) return { status: 200, json: { ok: false, error: locked } };
        const role = /^\d{15,21}$/.test(userId) ? this.settings.dashboardAdminRole(userId) : null;
        const passOk = await this.credentials.checkPassphrase(userId, passphrase);
        const totpOk = passOk && role != null ? await this.credentials.checkTotp(userId, code) : false;
        if (!role || !passOk || !totpOk) {
          if (userId) await this.recordFailure(userId, "login.totp", meta);
          return { status: 200, json: { ok: false, error: "Sign-in failed. Try again." } };
        }
        this.clearFailures(userId);
        return this.startLockedSession(userId, this.nameFor(userId), "totp", null, meta);
      }
      default:
        return null;
    }
  }

  // ---- session-bound auth endpoints (step-up, passkey registration) ----

  async sessionEndpoint(
    endpoint: string,
    auth: DashboardAuthResult,
    body: unknown,
    meta: { ip?: string; ua?: string }
  ): Promise<AuthEndpointResult | null> {
    const request = (body ?? {}) as Record<string, unknown>;
    switch (endpoint) {
      case "auth-stepup-options": {
        const rp = this.rp();
        if (!rp) return { status: 400, json: { error: "Public base URL is not configured." } };
        const { options, challenge } = await makeAuthenticationOptions(rp);
        this.challenges.remember(challenge);
        return { status: 200, json: { options } };
      }
      case "auth-stepup": {
        // Fresh factor re-assert (T2): a passkey assertion by THIS admin, or
        // a current TOTP code.
        const totp = typeof request.totp === "string" ? request.totp : null;
        if (totp != null) {
          if (!(await this.credentials.checkTotp(auth.actor.id, totp))) {
            await this.recordFailure(auth.actor.id, "stepup.totp", meta);
            return { status: 200, json: { ok: false, error: "That code didn't match." } };
          }
        } else {
          const rp = this.rp();
          const response = request.response as AuthenticationResponseJSON | undefined;
          const challenge = this.challengeFrom(response);
          if (!rp || !response || !challenge || !this.challenges.consume(challenge)) {
            return { status: 200, json: { ok: false, error: "Verification failed. Try again." } };
          }
          const row = await this.credentials.findPasskeyByCredentialId(response.id ?? "");
          const cred = row ? this.credentials.toWebAuthnCredential(row) : null;
          // The asserted passkey must belong to the SESSION's admin.
          if (!row || !cred || row.discordUserId !== auth.actor.id) {
            return { status: 200, json: { ok: false, error: "Verification failed. Try again." } };
          }
          const verified = await checkAuthentication(rp, response, challenge, cred);
          if (!verified) return { status: 200, json: { ok: false, error: "Verification failed. Try again." } };
          await this.credentials.recordPasskeyUse(row.id, verified.newCounter);
        }
        await this.sessions.markStepUp(auth.sessionIdHash);
        await this.audit.record({
          actorId: auth.actor.id,
          actorName: auth.actor.name,
          kind: "auth",
          action: "stepup",
          summary: `Fresh factor re-asserted (${totp != null ? "totp" : "passkey"})`,
          outcome: "ok",
          ip: meta.ip,
          sessionIdHash: auth.sessionIdHash,
        });
        return { status: 200, json: { ok: true } };
      }
      case "auth-register-options": {
        const rp = this.rp();
        if (!rp) return { status: 400, json: { error: "Public base URL is not configured." } };
        const existing = await this.credentials.listPasskeys(auth.actor.id);
        const { options, challenge } = await makeRegistrationOptions(
          rp,
          auth.actor.name,
          existing.map((r) => r.credentialId!).filter(Boolean)
        );
        this.challenges.remember(challenge);
        return { status: 200, json: { options } };
      }
      case "auth-register": {
        const rp = this.rp();
        const response = request.response as RegistrationResponseJSON | undefined;
        const challenge = this.challengeFrom(response);
        const label = typeof request.label === "string" && request.label.trim() ? request.label.trim() : "Passkey";
        if (!rp || !response || !challenge || !this.challenges.consume(challenge)) {
          return { status: 200, json: { ok: false, error: "Registration failed. Try again." } };
        }
        // Passphrase-before-first-credential rule.
        if (!(await this.credentials.hasPassphrase(auth.actor.id))) {
          return { status: 200, json: { ok: false, error: "Set a passphrase first." } };
        }
        const verified = await checkRegistration(rp, response, challenge);
        if (!verified) return { status: 200, json: { ok: false, error: "Registration failed. Try again." } };
        await this.credentials.addPasskey({
          discordUserId: auth.actor.id,
          label,
          credential: verified.credential,
          backedUp: verified.backedUp,
        });
        await this.audit.record({
          actorId: auth.actor.id,
          actorName: auth.actor.name,
          kind: "auth",
          action: "passkey.enrolled",
          summary: `Passkey enrolled: ${label}`,
          outcome: "ok",
          ip: meta.ip,
          sessionIdHash: auth.sessionIdHash,
        });
        return { status: 200, json: { ok: true, text: "Passkey enrolled." } };
      }
      default:
        return null;
    }
  }

  // ---- Discord-side surface (activation modal, reverse codes, reset) ----

  async activate(
    discordUserId: string,
    code: string,
    epoch: number
  ): Promise<{ ok: true } | { ok: false; reason: "notfound" | "locked_out" }> {
    const result = await this.sessions.activate(discordUserId, code, epoch);
    await this.audit.record({
      actorId: discordUserId,
      actorName: this.nameFor(discordUserId),
      kind: "auth",
      action: "session.activate",
      summary: result.ok ? "Session activated from Discord" : `Activation failed (${result.ok === false ? result.reason : ""})`,
      outcome: result.ok ? "ok" : "denied",
    });
    return result;
  }

  // Reverse code (T3): minted from Discord onto the caller's most recent
  // ACTIVE session; typed into the web page; single-use, 5-min TTL.
  async issueReverseForUser(discordUserId: string): Promise<string | null> {
    const sessions = await this.sessions.listForUser(discordUserId, this.settings.dashboardEpoch());
    const active = sessions.find((s) => s.state === "active");
    if (!active) return null;
    const bytes = randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) code += String(bytes[i] % 10);
    this.reverse.set(active.idHash, { code, issuedAt: Date.now(), attempts: 0 });
    return code;
  }

  private consumeReverse(idHash: string, code: string): boolean {
    const ch = this.reverse.get(idHash);
    if (!ch) return false;
    if (Date.now() - ch.issuedAt > REVERSE_TTL_MS || ch.attempts >= MAX_REVERSE_ATTEMPTS) {
      this.reverse.delete(idHash);
      return false;
    }
    if (ctEqual(code, ch.code)) {
      this.reverse.delete(idHash); // single-use
      return true;
    }
    ch.attempts += 1;
    if (ch.attempts >= MAX_REVERSE_ATTEMPTS) this.reverse.delete(idHash);
    return false;
  }

  // Discord "Reset my credentials": revoke all credentials + bump the epoch
  // (their sessions die). Root of trust stays with the Discord account.
  async resetCredentials(discordUserId: string): Promise<number> {
    const count = await this.credentials.revokeAll(discordUserId);
    await this.settings.bumpDashboardEpoch();
    await this.audit.record({
      actorId: discordUserId,
      actorName: this.nameFor(discordUserId),
      kind: "auth",
      action: "credentials.reset",
      summary: `All credentials revoked (${count}) + epoch bumped`,
      outcome: "ok",
    });
    return count;
  }

  // ---- internals ----

  private async startLockedSession(
    userId: string,
    name: string,
    method: "passkey" | "totp",
    credentialId: string | null,
    meta: { ip?: string; ua?: string }
  ): Promise<AuthEndpointResult> {
    const { token } = await this.sessions.create({
      discordUserId: userId,
      adminName: name,
      epoch: this.settings.dashboardEpoch(),
      authMethod: method,
      credentialIdUsed: credentialId,
      ip: meta.ip,
      ua: meta.ua,
    });
    await this.audit.record({
      actorId: userId,
      actorName: name,
      kind: "auth",
      action: `login.${method}`,
      summary: `Standing login (locked; awaiting Discord activation) from ${meta.ip ?? "unknown ip"}`,
      outcome: "ok",
      ip: meta.ip,
      sessionIdHash: hashSessionToken(token),
    });
    // Push the activation DM (best-effort).
    this.notifier?.notifyLogin(userId, { method, ip: meta.ip, ua: meta.ua }).catch(() => {});
    return { status: 200, json: { ok: true, state: "locked" }, setCookie: this.cookieFor(token) };
  }

  private cookieFor(token: string): string {
    // SameSite=Lax (not Strict): deep links from Discord audit embeds must
    // arrive with the cookie. CSRF never rests on SameSite here — the triple
    // belt + POST-only mutations carry it.
    return `__Host-billing=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
  }

  private rp() {
    return rpFromBaseUrl(this.settings.resolvedPublicBaseUrl());
  }

  private nameFor(userId: string): string {
    return this.settings.dashboardAdmins().find((a) => a.id === userId)?.name ?? userId;
  }

  private challengeFrom(response: { response?: { clientDataJSON?: string } } | undefined): string | null {
    // The client echoes the challenge inside clientDataJSON; extract it so the
    // ChallengeStore can enforce single-use before signature verification.
    try {
      const b64 = response?.response?.clientDataJSON;
      if (!b64) return null;
      const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as { challenge?: string };
      return typeof parsed.challenge === "string" ? parsed.challenge : null;
    } catch {
      return null;
    }
  }

  private lockedFor(userId: string): string | null {
    const f = this.failures.get(userId);
    if (!f) return null;
    if (Date.now() < f.lockedUntil) return "Too many attempts. Try again later.";
    return null;
  }

  private async recordFailure(userId: string, action: string, meta: { ip?: string }): Promise<void> {
    const f = this.failures.get(userId) ?? { fails: 0, lockedUntil: 0 };
    f.fails += 1;
    for (const step of LOCKOUT_STEPS) {
      if (f.fails >= step.fails) {
        f.lockedUntil = Date.now() + step.lockMs;
        break;
      }
    }
    this.failures.set(userId, f);
    if (f.fails === 5 || f.fails === 10 || f.fails === 25) {
      await this.audit.record({
        actorId: userId,
        actorName: this.nameFor(userId),
        kind: "auth",
        action,
        summary: `${f.fails} consecutive failed attempts`,
        outcome: "denied",
        ip: meta.ip,
      });
      if (f.fails >= 25) this.notifier?.notifyLockout(userId, f.fails).catch(() => {});
    }
  }

  private clearFailures(userId: string): void {
    this.failures.delete(userId);
  }

  private consumeJti(jti: string): boolean {
    const cutoff = Date.now() - JTI_RETENTION_MS;
    for (const [k, at] of this.usedJtis) {
      if (at < cutoff) this.usedJtis.delete(k);
    }
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.set(jti, Date.now());
    return true;
  }

  private prunePendingLogins(): void {
    const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
    for (const [id, p] of this.pendingLogins) {
      if (p.at < cutoff) this.pendingLogins.delete(id);
    }
  }
}

function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
