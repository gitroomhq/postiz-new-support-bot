import { randomBytes } from "node:crypto";
import { SettingsStore } from "../config/SettingsStore";
import { AdminPanelTokens } from "./AdminPanelTokens";
import { AdminPanelSessions, AdminSession } from "./AdminPanelSessions";
import { GuildSnapshotProvider } from "./guildSnapshot";
import { renderAdminShell } from "./adminPanelHtml";
import { AdminActor, AdminHubContext, HubModule } from "./sections/types";
import { ActionResult, HubView, SaveResult } from "./renderer/contract";
import { log } from "../util/logger";

const panelLog = log.child("adminpanel");

const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;

export type AdminAuditFn = (actor: AdminActor, change: string) => Promise<void>;

// What CallbackServer needs — a thin transport-facing view of this class.
export interface AdminPanelRoute {
  page(token: string): Promise<{ html: string; nonce: string; sessionCookie: string } | { status: number; message: string }>;
  api(endpoint: string, sessionId: string, body: unknown): Promise<{ status: number; json: object }>;
}

// The server half of the admin web panel: token exchange → passcode-gated
// session → generic form dispatch. Everything the page renders is decided here
// (mirrors IntercomPanel); the client is a dumb form renderer.
export class AdminPanel implements AdminPanelRoute {
  private rate = new Map<string, number[]>();
  private modules = new Map<string, HubModule>();

  constructor(
    private settingsStore: SettingsStore,
    private tokens: AdminPanelTokens,
    private sessions: AdminPanelSessions,
    private guild: GuildSnapshotProvider,
    modules: HubModule[],
    private audit?: AdminAuditFn
  ) {
    for (const m of modules) this.modules.set(m.hub, m);
  }

  // GET /admin/panel?t=… — exchange the SINGLE-USE link token for a LOCKED
  // session + HttpOnly cookie, and serve the generic shell. The activation code
  // is delivered via the activation-status poll (nothing session-specific is
  // baked into the HTML except the CSP nonce).
  async page(
    token: string
  ): Promise<{ html: string; nonce: string; sessionCookie: string } | { status: number; message: string }> {
    const payload = this.tokens.verify(token);
    if (!payload) return { status: 401, message: "This panel link is invalid or expired. Re-run /config or /intercom." };
    if (!this.allow(`page:${payload.sub}`)) return { status: 429, message: "Too many requests." };
    if (!this.sessions.consumeJti(payload.jti)) {
      panelLog.warn("admin panel link replay rejected", { "discord.user_id": payload.sub });
      return { status: 401, message: "This panel link was already used. Re-run /config or /intercom for a fresh one." };
    }
    const { sessionId } = this.sessions.create({
      discordUserId: payload.sub,
      guildId: payload.gid,
      adminName: payload.an,
      panel: payload.panel,
      epoch: payload.epo,
    });
    const nonce = randomBytes(16).toString("base64");
    panelLog.info("admin panel opened (locked)", { "discord.user_id": payload.sub, "adminpanel.group": payload.panel });
    return {
      html: renderAdminShell({ nonce }),
      nonce,
      sessionCookie: `__Host-acpanel=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800`,
    };
  }

  // POST /admin/panel/api/:endpoint — cookie-authenticated (CallbackServer
  // already enforced the CSRF belts). activation-status works while LOCKED;
  // everything else requires an ACTIVE session.
  async api(endpoint: string, sessionId: string, body: unknown): Promise<{ status: number; json: object }> {
    const session = sessionId ? this.sessions.get(sessionId, this.settingsStore.adminPanelEpoch()) : null;
    if (!session) return { status: 200, json: { state: "expired", error: "expired" } };
    if (!this.allow(`api:${session.discordUserId}`)) return { status: 429, json: { error: "rate limited" } };
    const request = (body ?? {}) as Record<string, unknown>;
    if (typeof request !== "object" || Array.isArray(request)) return { status: 400, json: { error: "bad request" } };

    try {
      if (endpoint === "activation-status") {
        return {
          status: 200,
          json: {
            state: session.state,
            adminName: session.adminName,
            group: session.panel,
            defaultHub: this.defaultHub(session.panel),
            ...(session.state === "locked" ? { activationCode: session.activationCode } : {}),
          },
        };
      }

      // Everything below requires activation.
      if (session.state !== "active") return { status: 403, json: { error: "locked" } };

      switch (endpoint) {
        case "view": {
          const view = await this.buildView(session, this.str(request.hub), this.str(request.tab), this.str(request.scope));
          if (!view) return { status: 404, json: { error: "unknown hub" } };
          return { status: 200, json: view };
        }
        case "save": {
          const module = this.modules.get(this.str(request.hub));
          if (!module) return { status: 404, json: { ok: false, error: "unknown hub" } };
          const ctx = this.ctxFor(session);
          const result: SaveResult = await module.save(ctx, {
            section: this.str(request.section),
            field: request.field != null ? this.str(request.field) : undefined,
            value: request.value,
            fields: this.obj(request.fields),
            scope: request.scope != null ? this.str(request.scope) : undefined,
          });
          return { status: 200, json: result };
        }
        case "action": {
          const module = this.modules.get(this.str(request.hub));
          if (!module || !module.action) return { status: 404, json: { ok: false, error: "unknown action" } };
          let reverseSatisfied = false;
          if (typeof request.reverseCode === "string" && request.reverseCode) {
            reverseSatisfied = this.sessions.consumeDestructiveChallenge(session, request.reverseCode);
          }
          const ctx = this.ctxFor(session, { satisfied: reverseSatisfied });
          const result: ActionResult = await module.action(ctx, {
            key: this.str(request.key),
            params: this.obj(request.params),
            confirmWord: request.confirmWord != null ? this.str(request.confirmWord) : undefined,
            scope: request.scope != null ? this.str(request.scope) : undefined,
          });
          return { status: 200, json: result };
        }
        default:
          return { status: 404, json: { error: "unknown endpoint" } };
      }
    } catch (e) {
      // Raw errors stay in the logs; only a generic message reaches the client.
      panelLog.warn("admin panel api error", {
        "adminpanel.endpoint": endpoint,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return { status: 200, json: { ok: false, error: "Internal error. Check the bot logs." } };
    }
  }

  private async buildView(
    session: AdminSession,
    hub: string,
    tab?: string,
    scope?: string
  ): Promise<HubView | null> {
    const module = this.modules.get(hub) ?? this.modules.get(this.defaultHub(session.panel) ?? "");
    if (!module) return null;
    const ctx = this.ctxFor(session);
    const sections = await module.buildSections(ctx, { tab, scope });
    const scopeSel = module.buildScope ? await module.buildScope(ctx, { tab, scope }) : undefined;
    const tabs = [...this.modules.values()]
      .filter((m) => m.group === module.group)
      .map((m) => ({ key: m.hub, label: m.title }));
    return {
      hub: module.hub,
      title: module.title,
      group: module.group,
      tabs,
      activeTab: module.hub,
      scope: scopeSel,
      sections,
    };
  }

  private defaultHub(group: string): string | undefined {
    for (const m of this.modules.values()) if (m.group === group) return m.hub;
    return undefined;
  }

  private ctxFor(session: AdminSession, reverse?: { satisfied: boolean }): AdminHubContext {
    const actor: AdminActor = { id: session.discordUserId, name: session.adminName, guildId: session.guildId };
    return {
      settings: this.settingsStore,
      guild: this.guild,
      actor,
      reverse,
      audit: async (change: string) => {
        try {
          if (this.audit) await this.audit(actor, change);
          else panelLog.info("admin panel change", { "adminpanel.actor": actor.name, "adminpanel.change": change });
        } catch (e) {
          panelLog.warn("admin panel audit failed", { "error.message": e instanceof Error ? e.message : String(e) });
        }
      },
    };
  }

  private allow(key: string): boolean {
    const now = Date.now();
    const hits = (this.rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_PER_MIN) {
      this.rate.set(key, hits);
      return false;
    }
    hits.push(now);
    this.rate.set(key, hits);
    return true;
  }

  private str(v: unknown): string {
    return typeof v === "string" ? v : "";
  }
  private obj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
}
