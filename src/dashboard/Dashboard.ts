import { randomBytes } from "node:crypto";
import { SettingsStore } from "../config/SettingsStore";
import { MountedPanelRoute, PanelRequestMeta } from "../server/panelMount";
import { actionByKey } from "../bot/billing/actions/ActionRegistry";
import type { ActionActor } from "../bot/billing/actions/BillingActionService";
import { DashboardAuthProvider, DashboardAuthResult } from "./DashboardAuth";
import { DashboardCtx, DashboardSectionModule } from "./sections/types";
import type { GlobalSearch } from "./search/GlobalSearch";
import {
  ActionResult,
  ActivationStatusResponse,
  NavBadgesResponse,
  NavItem,
  PageView,
  ViewRequest,
} from "./renderer/contract";
import { renderDashboardShell } from "./html/shellHtml";
import { log } from "../util/logger";

const dashLog = log.child("dashboard");

const RATE_LIMIT_PER_MIN = 240; // a real dashboard tab is chattier than the mini-panels
const RATE_WINDOW_MS = 60_000;

// Dashboard ceremony tiers for REGISTRY actions (§C tier map), enforced
// server-side — the client modal is advisory. Registry defs flagged
// `dangerous` are T1 automatically; this set adds the not-flagged T1 keys.
const DASH_T1_EXTRA = new Set([
  "payment_intent.cancel",
  "subscription.pause_resume",
  "subscription.terms",
  "invoice.collect",
  "customer.payment_method",
]);
// T2 (fresh factor re-assert): fraud refunds, blocklisting, cancel-NOW.
const DASH_T2 = new Set(["charge.refund_fraud", "customer.block"]);

function needsStepUp(key: string, params: Record<string, unknown> | undefined): boolean {
  if (DASH_T2.has(key)) return true;
  return key === "subscription.cancel" && params?.when === "now";
}

export type DashboardAuditFn = (actor: { id: string; name: string }, change: string) => Promise<void>;

// The server half of the Stripe dashboard: auth via the pluggable provider,
// then generic page dispatch across the registered section modules. Everything
// the page renders is decided HERE (server-driven UI); the client is a dumb
// block renderer with a hash router.
export class Dashboard implements MountedPanelRoute {
  private rate = new Map<string, number[]>();
  private buildCtxDeps: Omit<DashboardCtx, "actor" | "audit" | "reverse" | "security">;
  private search?: GlobalSearch;

  constructor(
    private settings: SettingsStore,
    private auth: DashboardAuthProvider,
    private modules: DashboardSectionModule[],
    deps: Omit<DashboardCtx, "actor" | "audit" | "reverse" | "security"> & { search?: GlobalSearch },
    private auditFn?: DashboardAuditFn
  ) {
    this.buildCtxDeps = deps;
    this.search = deps.search;
  }

  // GET /billing — kill switch, then auth-provider entry (cookie resume,
  // break-glass token exchange, or login mode), then the shell. Nothing
  // session-specific is baked into the HTML except the CSP nonce.
  async page(
    token: string,
    cookie: string,
    meta?: PanelRequestMeta
  ): Promise<{ html: string; nonce: string; sessionCookie?: string } | { status: number; message: string }> {
    if (!this.settings.dashboardEnabled()) return { status: 404, message: "Not found" };
    const entered = await this.auth.enter({ token, cookie, ip: meta?.ip, ua: meta?.ua });
    if (entered.kind === "reject") return { status: entered.status, message: entered.message };
    const nonce = randomBytes(16).toString("base64");
    return {
      html: renderDashboardShell({ nonce }),
      nonce,
      ...(entered.sessionCookie ? { sessionCookie: entered.sessionCookie } : {}),
    };
  }

  // POST /billing/api/:endpoint — cookie-authenticated (panelMount already
  // enforced the CSRF belts). Without a session, only the login-ceremony
  // endpoints (auth-*) and the pre-login activation-status poll work; with a
  // LOCKED session only activation-status; everything else needs ACTIVE.
  async api(
    endpoint: string,
    sessionId: string,
    body: unknown,
    meta?: PanelRequestMeta
  ): Promise<{ status: number; json: object; setCookie?: string }> {
    if (!this.settings.dashboardEnabled()) return { status: 404, json: { error: "not_found" } };
    const requestMeta = { ip: meta?.ip, ua: meta?.ua };
    const auth = await this.auth.authenticate(sessionId, requestMeta);
    if (!auth) {
      // Session-less: the login ceremony + login-mode activation-status.
      if (endpoint === "activation-status" || endpoint.startsWith("auth-")) {
        if (!this.allow(`anon:${meta?.ip ?? "unknown"}`)) return { status: 429, json: { error: "rate limited" } };
        try {
          const handled = await this.auth.publicEndpoint(endpoint, body, requestMeta);
          if (handled) return handled;
        } catch (e) {
          dashLog.warn("dashboard auth endpoint error", {
            "dashboard.endpoint": endpoint,
            "error.message": e instanceof Error ? e.message : String(e),
          });
          return { status: 200, json: { ok: false, error: "Internal error — check the bot logs." } };
        }
      }
      return { status: 200, json: { state: "expired", error: "expired" } };
    }
    if (!this.allow(`api:${auth.actor.id}`)) return { status: 429, json: { error: "rate limited" } };
    const request = (body ?? {}) as Record<string, unknown>;
    if (typeof request !== "object" || Array.isArray(request)) return { status: 400, json: { error: "bad request" } };

    try {
      // Session-bound auth endpoints (step-up, passkey registration) work
      // while ACTIVE only — a locked session must finish activation first.
      if (endpoint.startsWith("auth-")) {
        if (auth.state !== "active") return { status: 403, json: { error: "locked" } };
        const handled = await this.auth.sessionEndpoint(endpoint, auth, body, requestMeta);
        if (handled) return handled;
        return { status: 404, json: { error: "unknown endpoint" } };
      }

      if (endpoint === "activation-status") {
        const json: ActivationStatusResponse = {
          state: auth.state,
          adminName: auth.actor.name,
          ...(auth.state === "locked" && auth.activationCode ? { activationCode: auth.activationCode } : {}),
        };
        return { status: 200, json };
      }

      // Everything below requires activation.
      if (auth.state !== "active") return { status: 403, json: { error: "locked" } };

      switch (endpoint) {
        case "view": {
          const req = this.viewRequest(request);
          if (!req) return { status: 400, json: { error: "bad request" } };
          const view = await this.buildView(auth, req);
          if (!view) return { status: 404, json: { error: "unknown page" } };
          return { status: 200, json: view };
        }
        case "search": {
          if (!this.search) return { status: 404, json: { error: "unknown endpoint" } };
          // Dedicated per-actor budget: the fan-out hits Stripe's eventually
          // consistent Search API (~20 req/s account-wide) — the palette
          // debounces 400ms client-side, this is the server backstop.
          if (!this.allow(`search:${auth.actor.id}`, 30)) {
            return { status: 200, json: { groups: [], notice: "Search rate limit reached — give it a few seconds." } };
          }
          const term = typeof request.term === "string" ? request.term : "";
          return { status: 200, json: await this.search.run(term) };
        }
        case "nav-badges": {
          const ctx = this.ctxFor(auth);
          const badges: Record<string, string> = {};
          await Promise.all(
            this.modules.map(async (m) => {
              if (!m.navBadge) return;
              const value = await m.navBadge(ctx).catch(() => null);
              if (value) for (const item of m.nav) badges[item.key] = value;
            })
          );
          const json: NavBadgesResponse = { badges };
          return { status: 200, json };
        }
        case "action": {
          const key = typeof request.key === "string" ? request.key.slice(0, 64) : "";
          if (key.startsWith("section:")) {
            const page = typeof request.page === "string" ? request.page.slice(0, 64) : "";
            const module = this.modules.find((m) => m.action && m.ownsPage(page));
            if (!module?.action) return { status: 404, json: { ok: false, error: "Unknown action." } };
            let reverseSatisfied = false;
            if (typeof request.reverseCode === "string" && request.reverseCode) {
              reverseSatisfied = auth.consumeReverse(request.reverseCode);
            }
            const ctx = this.ctxFor(auth, { satisfied: reverseSatisfied });
            const result: ActionResult = await module.action(ctx, {
              key,
              params: this.obj(request.params),
              confirmWord: typeof request.confirmWord === "string" ? request.confirmWord : undefined,
              reverseCode: typeof request.reverseCode === "string" ? request.reverseCode : undefined,
            });
            return { status: 200, json: result };
          }
          return { status: 200, json: await this.registryAction(auth, key, request) };
        }
        case "logout": {
          auth.logout();
          return { status: 200, json: { ok: true } };
        }
        default:
          return { status: 404, json: { error: "unknown endpoint" } };
      }
    } catch (e) {
      // Raw errors stay in the logs (Stripe messages can echo request data /
      // PII); only a generic message reaches the client.
      dashLog.warn("dashboard api error", {
        "dashboard.endpoint": endpoint,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return { status: 200, json: { ok: false, error: "Internal error — check the bot logs." } };
    }
  }

  // Registry billing action via the gateway (money movement). The ceremony
  // belts run HERE, server-side: T1 typed-CONFIRM, T2 fresh-factor — the
  // client modal already asked, but the client is hostile.
  private async registryAction(auth: DashboardAuthResult, key: string, request: Record<string, unknown>): Promise<ActionResult> {
    const def = actionByKey(key);
    if (!def) return { ok: false, error: "Unknown action." };
    const params = this.obj(request.params) ?? {};
    if (needsStepUp(key, params) && !auth.stepUpFresh()) {
      return { ok: false, needsStepUp: true };
    }
    if (def.dangerous || DASH_T1_EXTRA.has(key)) {
      const word = typeof request.confirmWord === "string" ? request.confirmWord : "";
      if (word !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action.", fieldErrors: {} };
    }
    const actor: ActionActor = {
      kind: "dashboard",
      id: auth.actor.id,
      name: auth.actor.name,
      isAdmin: auth.actor.isAdmin,
    };
    const outcome = await this.buildCtxDeps.billing.gateway.request(actor, key, params);
    switch (outcome.kind) {
      case "executed":
        return { ok: true, text: outcome.text };
      case "queued":
        return { ok: true, queued: true, text: "Queued for admin approval (expires in 7 days)." };
      case "denied":
      case "invalid":
      case "failed":
        return { ok: false, error: outcome.error };
    }
  }

  private async buildView(auth: DashboardAuthResult, req: ViewRequest): Promise<PageView | null> {
    const module = this.modules.find((m) => m.ownsPage(req.page));
    if (!module) return null;
    const ctx = this.ctxFor(auth);
    const section = await module.buildPage(ctx, req);
    if (!section) return null;
    const nav = this.assembleNav();
    const active = module.nav.find((n) => req.page === n.page || req.page.startsWith(`${n.page}.`)) ?? module.nav[0];
    return {
      page: req.page,
      title: section.title,
      crumbs: section.crumbs,
      nav,
      activeNav: active?.key ?? "",
      blocks: section.blocks,
      ...(section.rail && section.rail.length ? { rail: section.rail } : {}),
      testMode: this.buildCtxDeps.stripe.isTestMode(),
      actorLabel: `${auth.actor.name} · ${auth.actor.role}`,
    };
  }

  private assembleNav(): NavItem[] {
    const nav: NavItem[] = [];
    for (const m of this.modules) nav.push(...m.nav);
    return nav;
  }

  private ctxFor(auth: DashboardAuthResult, reverse?: { satisfied: boolean }): DashboardCtx {
    const actor = auth.actor;
    return {
      ...this.buildCtxDeps,
      actor,
      reverse,
      security: {
        sessionIdHash: auth.sessionIdHash,
        authMethod: auth.authMethod,
        stepUpFresh: () => auth.stepUpFresh(),
      },
      audit: async (change: string) => {
        try {
          if (this.auditFn) await this.auditFn(actor, change);
          else dashLog.info("dashboard change", { "dashboard.actor": actor.name, "dashboard.change": change });
        } catch (e) {
          dashLog.warn("dashboard audit failed", { "error.message": e instanceof Error ? e.message : String(e) });
        }
      },
    };
  }

  // Hostile-client shaping of the view request.
  private viewRequest(request: Record<string, unknown>): ViewRequest | null {
    const page = typeof request.page === "string" ? request.page : "";
    if (!/^[a-z][a-z0-9_.]{0,63}$/.test(page)) return null;
    const params: Record<string, string> = {};
    const rawParams = this.obj(request.params);
    if (rawParams) {
      for (const [k, v] of Object.entries(rawParams)) {
        if (typeof k === "string" && k.length <= 32 && typeof v === "string" && v.length <= 200) params[k] = v;
      }
    }
    const filters: Record<string, string> = {};
    const rawFilters = this.obj(request.filters);
    if (rawFilters) {
      for (const [k, v] of Object.entries(rawFilters)) {
        if (typeof k === "string" && k.length <= 32 && typeof v === "string" && v.length <= 200) filters[k] = v;
      }
    }
    const cursor = typeof request.cursor === "string" ? request.cursor.slice(0, 120) : null;
    return { page, params, filters, cursor };
  }

  private allow(key: string, limit = RATE_LIMIT_PER_MIN): boolean {
    const now = Date.now();
    const hits = (this.rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= limit) {
      this.rate.set(key, hits);
      return false;
    }
    hits.push(now);
    this.rate.set(key, hits);
    return true;
  }

  private obj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
}
