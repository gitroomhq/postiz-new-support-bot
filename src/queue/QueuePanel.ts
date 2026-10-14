import { randomBytes } from "node:crypto";
import type { MountedPanelRoute, PanelRequestMeta } from "../server/panelMount";
import { log } from "../util/logger";
import type { QueueAuth, QueueRedirect } from "./QueueAuth";
import type { QueueViews } from "./queueViews";
import type { QueueViewRequest } from "./contract";
import { renderQueueShell } from "./html/queueShell";
import { queueReadiness, type QueueReadinessSettings } from "./queueConfig";

const panelLog = log.child("queue");

const RATE_LIMIT_PER_MIN = 120;
const RATE_WINDOW_MS = 60_000;
// How long a live-update request waits for a change before it answers
// "unchanged" (well inside proxy idle timeouts).
const WATCH_MS = 25_000;
const VERSION_RE = /^[0-9a-f]{8}\.\d{1,12}$/;

// The Intercom Queue's web surface: GET /queue (shell) + POST /queue/api/:ep
// on the shared panelMount transport (per-IP throttle, CSP nonce, CSRF
// belts), plus the two OAuth routes CallbackServer mounts beside it.
export interface QueueRoute extends MountedPanelRoute {
  oauthStart(): QueueRedirect;
  oauthCallback(query: { code?: unknown; state?: unknown; error?: unknown }, oauthCookie: string, meta: { ip?: string; ua?: string }): Promise<QueueRedirect>;
}

export type QueuePanelSettings = QueueReadinessSettings;

export class QueuePanel implements QueueRoute {
  private rate = new Map<string, number[]>();

  constructor(
    private settings: QueuePanelSettings,
    private auth: QueueAuth,
    private views: QueueViews,
    private watchMs = WATCH_MS
  ) {}

  // The shell is the same for everyone; the client asks `status` whether to
  // show the sign-in screen. Nothing session-specific is in the HTML.
  async page(): Promise<{ html: string; nonce: string } | { status: number; message: string }> {
    if (!this.settings.queueEnabled()) return { status: 404, message: "Not found" };
    const nonce = randomBytes(16).toString("base64");
    return { html: renderQueueShell({ nonce }), nonce };
  }

  async api(endpoint: string, sessionId: string, body: unknown, meta?: PanelRequestMeta): Promise<{ status: number; json: object }> {
    if (!this.settings.queueEnabled()) return { status: 404, json: { error: "not_found" } };
    const actor = await this.auth.authenticate(sessionId, { ip: meta?.ip });
    if (!actor) {
      if (endpoint === "status") return { status: 200, json: { state: "login", ready: queueReadiness(this.settings).ok } };
      return { status: 200, json: { state: "expired", error: "expired" } };
    }
    if (!this.allow(actor.adminId)) return { status: 429, json: { error: "rate limited" } };
    const request = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    try {
      switch (endpoint) {
        case "status":
          return { status: 200, json: { state: "active", name: actor.name } };
        case "view": {
          const req = viewRequest(request);
          if (!req) return { status: 400, json: { error: "bad request" } };
          if (request.refresh === true) this.views.refresh();
          // Live updates: a long-poll that answers as soon as the list changes.
          if (req.since && !(await this.views.waitForChange(req.since, this.watchMs))) {
            return { status: 200, json: { unchanged: true } };
          }
          const view = await this.views.build(actor, req, { waitForSnapshot: false });
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
      panelLog.warn("queue api error", {
        "queue.endpoint": endpoint,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return { status: 200, json: { ok: false, error: "Internal error. Check the bot logs." } };
    }
  }

  oauthStart(): QueueRedirect {
    return this.auth.start();
  }

  oauthCallback(query: { code?: unknown; state?: unknown; error?: unknown }, oauthCookie: string, meta: { ip?: string; ua?: string }): Promise<QueueRedirect> {
    return this.auth.callback(query, oauthCookie, meta);
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
    if (this.rate.size > 1000) this.rate.clear(); // crude bound: throttle state, not audit data
    return true;
  }
}

// Hostile-client shaping of a view request.
export function viewRequest(request: Record<string, unknown>): QueueViewRequest | null {
  const page = typeof request.page === "string" ? request.page : "";
  if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(page)) return null;
  const pick = (v: unknown, maxLen: number): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (Object.keys(out).length >= 16) break;
      if (/^[a-z_]{1,16}$/.test(k) && typeof val === "string" && val.length <= maxLen) out[k] = val;
    }
    return out;
  };
  const cursor = typeof request.cursor === "string" && /^\d{1,6}$/.test(request.cursor) ? request.cursor : null;
  const since = typeof request.since === "string" && VERSION_RE.test(request.since) ? request.since : null;
  return { page, params: pick(request.params, 32), filters: pick(request.filters, 32), cursor, since };
}
