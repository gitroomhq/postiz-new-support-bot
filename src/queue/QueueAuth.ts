import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntercomRegion } from "../config/SettingsStore";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";
import type { QueueSessions } from "./QueueSessions";
import { QUEUE_ABSOLUTE_TTL_MS } from "./QueueSessions";
import type { QueueTeammate } from "./QueueData";
import { intercomAppHost } from "./queueModel";
import { httpsBase } from "./queueConfig";

const authLog = log.child("queue:auth");

// "Sign in with Intercom" for the Intercom Queue. The OAuth app only proves
// who the teammate is: the token it returns is used for one GET /me and then
// dropped (never stored, never logged). The queue's data is read with the
// bridge's own token.
//
// Login CSRF: the state is single-use, expires after 10 minutes and is bound
// to a random nonce in a pre-login cookie, so a callback URL planted on a
// teammate cannot sign them in as somebody else.
//
// The identity is accepted only when Intercom says the email is verified (its
// own guidance for "log in with Intercom"), the teammate belongs to the same
// workspace as the bridge, and they hold an inbox seat and are a person.

export const QUEUE_COOKIE = "__Host-queue";
export const QUEUE_OAUTH_COOKIE = "__Host-queue-oauth";
export const QUEUE_BASE_PATH = "/queue";
export const QUEUE_CALLBACK_PATH = "/queue/oauth/callback";

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const VERIFY_EVERY_MS = 5 * 60_000;
// Intercom down: a session keeps working this long past its last check.
const VERIFY_GRACE_MS = 30 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const API_VERSION = "2.15";

// Why a sign-in was turned away. The page maps the code to fixed text; nothing
// from the request is reflected back.
export type QueueRefusal = "denied" | "expired" | "config" | "error" | "unverified" | "workspace" | "seat";

export interface QueueActor {
  adminId: string;
  name: string;
  sessionIdHash: string;
}

export interface QueueAuthSettings {
  queueEnabled(): boolean;
  queueReady(): boolean;
  queueOauthClientId(): string | null;
  queueOauthClientSecret(): string | null;
  queueEpoch(): number;
  intercomRegion(): IntercomRegion;
  resolvedPublicBaseUrl(): string | null;
}

export interface QueueDirectoryView {
  seatedTeammate(adminId: string): Promise<QueueTeammate | null>;
  workspaceIdCode(): Promise<string | null>;
}

export interface QueueRefusalAudit {
  reason: string;
  teammate?: { id: string | null; name: string | null; email: string | null };
  ip?: string;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type QueueRedirect = { status: 302; location: string; setCookies: string[] } | { status: 404 };

export class QueueAuth {
  private pending = new Map<string, { nonceHash: string; at: number }>();

  constructor(
    private settings: QueueAuthSettings,
    private directory: QueueDirectoryView,
    private sessions: QueueSessions,
    private auditRefusal: (event: QueueRefusalAudit) => void,
    private fetchFn: FetchFn = (url, init) => fetch(url, init),
    private now: () => number = Date.now
  ) {}

  // ---- GET /queue/oauth/start ----

  start(): QueueRedirect {
    if (!this.settings.queueEnabled()) return { status: 404 };
    const clientId = this.settings.queueOauthClientId();
    const base = this.publicBase();
    if (!this.settings.queueReady() || !clientId || !base) return this.toPage("config");
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    this.prunePending();
    this.pending.set(state, { nonceHash: sha256(nonce), at: this.now() });
    const url = new URL(`${intercomAppHost(this.settings.intercomRegion())}/oauth`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", `${base}${QUEUE_CALLBACK_PATH}`);
    return {
      status: 302,
      location: url.toString(),
      setCookies: [`${QUEUE_OAUTH_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}`],
    };
  }

  // ---- GET /queue/oauth/callback ----

  async callback(
    query: { code?: unknown; state?: unknown; error?: unknown },
    oauthCookie: string,
    meta: { ip?: string; ua?: string }
  ): Promise<QueueRedirect> {
    if (!this.settings.queueEnabled()) return { status: 404 };
    const clear = `${QUEUE_OAUTH_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
    const refuse = (reason: QueueRefusal, audit?: QueueRefusalAudit): QueueRedirect => {
      metricCount("queue.signin", 1, { outcome: reason });
      if (audit) this.auditRefusal({ ...audit, ip: meta.ip });
      const r = this.toPage(reason);
      return r.status === 302 ? { ...r, setCookies: [clear] } : r;
    };

    // The teammate pressed Cancel on Intercom's consent screen.
    if (typeof query.error === "string" && query.error) return refuse("denied");

    const state = typeof query.state === "string" ? query.state : "";
    const pending = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state); // single use, whatever happens next
    if (!pending || this.now() - pending.at > STATE_TTL_MS || !oauthCookie || !ctEqual(sha256(oauthCookie), pending.nonceHash)) {
      return refuse("expired", { reason: "The sign-in link was expired, already used, or opened in another browser." });
    }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code || code.length > 1024 || !/^[A-Za-z0-9._~+/=-]+$/.test(code)) {
      return refuse("error", { reason: "Intercom returned no usable authorization code." });
    }
    const clientId = this.settings.queueOauthClientId();
    const clientSecret = this.settings.queueOauthClientSecret();
    if (!this.settings.queueReady() || !clientId || !clientSecret) return refuse("config");

    let me: IntercomMe;
    try {
      const token = await this.exchange(code, clientId, clientSecret);
      me = await this.identify(token);
    } catch (e) {
      authLog.warn("queue sign-in: intercom exchange failed", { "error.message": e instanceof Error ? e.message : String(e) });
      return refuse("error", { reason: "Intercom did not confirm the sign-in (token exchange or identity lookup failed)." });
    }
    const who = { id: me.id, name: me.name, email: me.email };

    if (me.emailVerified !== true) {
      return refuse("unverified", { reason: "The Intercom account's email address is not verified.", teammate: who });
    }
    let workspace: string | null;
    try {
      workspace = await this.directory.workspaceIdCode();
    } catch {
      workspace = null;
    }
    if (!workspace) return refuse("error", { reason: "The bridge's own Intercom workspace could not be confirmed.", teammate: who });
    if (!me.workspaceIdCode || me.workspaceIdCode !== workspace) {
      return refuse("workspace", { reason: "The Intercom account belongs to a different workspace.", teammate: who });
    }
    let teammate: QueueTeammate | null;
    try {
      teammate = me.id ? await this.directory.seatedTeammate(me.id) : null;
    } catch {
      return refuse("error", { reason: "The teammate list could not be read from Intercom.", teammate: who });
    }
    if (!teammate) {
      return refuse("seat", { reason: "Not a teammate with an inbox seat (or an Operator/bot identity).", teammate: who });
    }

    const token = await this.sessions.create({
      adminId: teammate.id,
      adminName: teammate.name,
      epoch: this.settings.queueEpoch(),
      ip: meta.ip,
      ua: meta.ua,
    });
    metricCount("queue.signin", 1, { outcome: "ok" });
    authLog.info("queue sign-in", { "intercom.admin_id": teammate.id });
    return {
      status: 302,
      location: QUEUE_BASE_PATH,
      setCookies: [
        clear,
        `${QUEUE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(QUEUE_ABSOLUTE_TTL_MS / 1000)}`,
      ],
    };
  }

  // ---- per request ----

  // The signed-in teammate, re-checked against Intercom every few minutes: a
  // teammate removed from the workspace or unseated loses the session.
  async authenticate(cookie: string, meta?: { ip?: string }): Promise<QueueActor | null> {
    if (!cookie || !this.settings.queueEnabled()) return null;
    const session = await this.sessions.get(cookie, this.settings.queueEpoch(), meta);
    if (!session) return null;
    const age = this.now() - session.lastVerifiedAt.getTime();
    let name = session.adminName;
    if (age > VERIFY_EVERY_MS) {
      let teammate: QueueTeammate | null;
      try {
        teammate = await this.directory.seatedTeammate(session.adminId);
      } catch {
        // Intercom unreachable: keep working for a while, then stop.
        if (age > VERIFY_GRACE_MS) return null;
        return { adminId: session.adminId, name, sessionIdHash: session.idHash };
      }
      if (!teammate) {
        await this.sessions.delete(session.idHash);
        authLog.info("queue session ended: teammate no longer seated", { "intercom.admin_id": session.adminId });
        return null;
      }
      name = teammate.name;
      await this.sessions.markVerified(session.idHash, name);
    }
    return { adminId: session.adminId, name, sessionIdHash: session.idHash };
  }

  async logout(actor: QueueActor): Promise<void> {
    await this.sessions.delete(actor.sessionIdHash);
  }

  // ---- internals ----

  private toPage(reason: QueueRefusal): QueueRedirect {
    return { status: 302, location: `${QUEUE_BASE_PATH}?e=${reason}`, setCookies: [] };
  }

  // https only (localhost allowed for development), no trailing slash.
  private publicBase(): string | null {
    return httpsBase(this.settings.resolvedPublicBaseUrl());
  }

  private async exchange(code: string, clientId: string, clientSecret: string): Promise<string> {
    const res = await this.fetchFn(`${apiHost(this.settings.intercomRegion())}/auth/eagle/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { access_token?: unknown; token?: unknown };
    const token = typeof data.access_token === "string" ? data.access_token : typeof data.token === "string" ? data.token : "";
    if (!token) throw new Error("token exchange: no token in response");
    return token;
  }

  private async identify(token: string): Promise<IntercomMe> {
    const res = await this.fetchFn(`${apiHost(this.settings.intercomRegion())}/me`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Intercom-Version": API_VERSION, Accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`me ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      email_verified?: unknown;
      app?: { id_code?: unknown } | null;
    };
    const id = typeof data.id === "number" || (typeof data.id === "string" && data.id) ? String(data.id) : null;
    return {
      id,
      name: typeof data.name === "string" ? data.name.slice(0, 200) : null,
      email: typeof data.email === "string" ? data.email.slice(0, 200) : null,
      emailVerified: data.email_verified === true,
      workspaceIdCode: typeof data.app?.id_code === "string" ? data.app.id_code : null,
    };
  }

  private prunePending(): void {
    const cutoff = this.now() - STATE_TTL_MS;
    for (const [state, p] of this.pending) if (p.at < cutoff) this.pending.delete(state);
    // A flood of abandoned starts must not grow the map without bound.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}

interface IntercomMe {
  id: string | null;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  workspaceIdCode: string | null;
}

function apiHost(region: IntercomRegion): string {
  return region === "eu" ? "https://api.eu.intercom.io" : region === "au" ? "https://api.au.intercom.io" : "https://api.intercom.io";
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
