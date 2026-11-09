import { randomBytes } from "node:crypto";
import type { MountedPanelRoute, PanelRequestMeta } from "../server/panelMount";
import { log } from "../util/logger";
import type { SupportAuth } from "./SupportAuth";
import type { SupportViews } from "./supportViews";
import type { SupportViewRequest } from "./contract";
import { renderSupportShell } from "./html/supportShell";

const panelLog = log.child("support");

const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;

export interface SupportPanelSettings {
  supportDashEnabled(): boolean;
}

// The support dashboard's web surface: GET /support (shell) + POST
// /support/api/:endpoint on the shared panelMount transport (per-IP throttle,
// CSP nonce, CSRF belts). The sign-in endpoints work without a session; every
// other endpoint needs one.
export class SupportPanel implements MountedPanelRoute {
  private rate = new Map<string, number[]>();

  constructor(
    private settings: SupportPanelSettings,
    private auth: SupportAuth,
    private views: SupportViews
  ) {}

  async page(): Promise<{ html: string; nonce: string } | { status: number; message: string }> {
    if (!this.settings.supportDashEnabled()) return { status: 404, message: "Not found" };
    const nonce = randomBytes(16).toString("base64");
    return { html: renderSupportShell({ nonce }), nonce };
  }

  async api(endpoint: string, sessionId: string, body: unknown, meta?: PanelRequestMeta): Promise<{ status: number; json: object; setCookie?: string }> {
    if (!this.settings.supportDashEnabled()) return { status: 404, json: { error: "not_found" } };
    const request = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    try {
      const login = await this.auth.publicEndpoint(endpoint, request, { ip: meta?.ip, ua: meta?.ua });
      if (login) return login;

      const actor = await this.auth.authenticate(sessionId, { ip: meta?.ip });
      if (!actor) {
        if (endpoint === "status") return { status: 200, json: { state: "login" } };
        return { status: 200, json: { state: "expired", error: "expired" } };
      }
      if (!this.allow(actor.id)) return { status: 429, json: { error: "rate limited" } };
      switch (endpoint) {
        case "status":
          return { status: 200, json: { state: "active", name: actor.name } };
        case "view": {
          const req = viewRequest(request);
          if (!req) return { status: 400, json: { error: "bad request" } };
          const view = await this.views.build(actor, req);
          if (!view) return { status: 404, json: { error: "unknown page" } };
          return { status: 200, json: view };
        }
        case "action": {
          const key = typeof request.key === "string" ? request.key.slice(0, 64) : "";
          const params = request.params && typeof request.params === "object" && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};
          return { status: 200, json: await this.views.action(actor, key, params) };
        }
        case "logout":
          await this.auth.logout(actor);
          return { status: 200, json: { ok: true } };
        default:
          return { status: 404, json: { error: "unknown endpoint" } };
      }
    } catch (e) {
      panelLog.warn("support api error", {
        "support.endpoint": endpoint,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return { status: 200, json: { ok: false, error: "Internal error. Check the bot logs." } };
    }
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
    if (this.rate.size > 1000) this.rate.clear();
    return true;
  }
}

// Hostile-client shaping of a view request.
export function viewRequest(request: Record<string, unknown>): SupportViewRequest | null {
  const page = typeof request.page === "string" ? request.page : "";
  if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(page)) return null;
  const pick = (v: unknown, maxLen: number): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (Object.keys(out).length >= 8) break;
      if (/^[a-z0-9_]{1,16}$/.test(k) && typeof val === "string" && val.length <= maxLen) out[k] = val;
    }
    return out;
  };
  const cursor = typeof request.cursor === "string" && /^\d{1,6}$/.test(request.cursor) ? request.cursor : null;
  return { page, params: pick(request.params, 80), filters: pick(request.filters, 254), cursor };
}
