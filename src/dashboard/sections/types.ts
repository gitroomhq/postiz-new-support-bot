import { SettingsStore } from "../../config/SettingsStore";
import { StripeClient } from "../../bot/StripeClient";
import { SessionStore } from "../../auth/SessionStore";
import { DisputeStore } from "../../bot/billing/DisputeStore";
import { BlockStore } from "../../bot/billing/BlockStore";
import { BillingQolStore } from "../../bot/billing/BillingQolStore";
import { MoneyOutStore } from "../../bot/billing/MoneyOutStore";
import type { MoneyOutService } from "../../bot/billing/MoneyOutService";
import type { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import type { DashboardActionGateway } from "../DashboardActions";
import { DashboardActor } from "../DashboardAuth";
import { ActionRequest, ActionResult, AttentionItem, Block, Crumb, NavItem, PeekResponse, ViewRequest } from "../renderer/contract";

// Per-request context handed to every dashboard section module. Deliberately
// Discord-free: sections are thin adapters from the domain services (Stripe
// client + billing stores) to Block JSON, mirroring the admin panel's
// AdminHubContext idiom.
export interface DashboardCtx {
  actor: DashboardActor;
  stripe: StripeClient;
  settings: SettingsStore;
  stores: {
    session: SessionStore; // Discord↔Stripe links (UserSession)
    dispute: DisputeStore; // local dispute mirror
    block: BlockStore; // blocklist
    qol: BillingQolStore; // notes + bookmarks
    moneyOut: MoneyOutStore; // every outflow (refunds, disputes, fees, concessions)
  };
  // Registry billing actions: the shared level/queue/execute/audit brain plus
  // the dashboard's target→customer binding gateway. Sections use `actions`
  // for approvals + advisory mode maps; registry EXECUTION always flows
  // through Dashboard.ts → gateway (never section code).
  billing: {
    actions: BillingActionService;
    gateway: DashboardActionGateway;
    // Concessions made straight from a section (credit grants) leave no
    // balance transaction, so the section has to book them itself. Optional
    // like ActionExecCtx.moneyOut: a metrics gap must never fail the action.
    moneyOut?: MoneyOutService;
  };
  audit(change: string): Promise<void>;
  // For destructive (reverseConfirm) actions: whether a valid Discord→web
  // reverse code was consumed on THIS request. Undefined on view requests.
  reverse?: { satisfied: boolean };
  // Session security context (ceremony enforcement + the Security page).
  security: {
    sessionIdHash: string;
    authMethod: "passkey" | "totp" | "breakglass" | "yubikey";
    stepUpFresh(): boolean; // T2: fresh factor asserted within the window?
  };
}

// What a section returns for one page render; Dashboard.ts wraps it into the
// full PageView (nav, testMode, actor label). null = unknown page → 404.
export interface SectionPage {
  title: string;
  crumbs: Crumb[];
  blocks: Block[];
  // Optional Stripe-style right rail (Details / Insights / related objects).
  rail?: Block[];
}

// One module per sidebar area. Dashboard.ts registers them, assembles the nav
// from the contributed items, and dispatches view/action by page ownership.
export interface DashboardSectionModule {
  // Contributed sidebar entries (usually one; group "Operate" for the second block).
  readonly nav: NavItem[];
  // Pages this module renders ("customers", "customers.detail", …).
  ownsPage(page: string): boolean;
  buildPage(ctx: DashboardCtx, req: ViewRequest): Promise<SectionPage | null>;
  // Section-local actions ("section:" keys). Registry billing actions route
  // through the action gateway instead.
  action?(ctx: DashboardCtx, req: ActionRequest): Promise<ActionResult>;
  // Live sidebar count for this module's nav badge (Approvals, Disputes).
  navBadge?(ctx: DashboardCtx): Promise<string | null>;
  // Needs-attention items for the topbar bell — collected by the nav-badges
  // endpoint on the same 60s poll.
  attention?(ctx: DashboardCtx): Promise<AttentionItem[]>;
  // Hover peek card for one of this module's detail pages. Cached
  // 30s per Dashboard; page is allowlisted and id validated BEFORE this runs.
  peek?(ctx: DashboardCtx, page: string, id: string): Promise<PeekResponse | null>;
}

// ---- shared param validators (hostile client) ----

export const STRIPE_ID_RES: Record<string, RegExp> = {
  customer: /^cus_[A-Za-z0-9]{1,64}$/,
  charge: /^(ch|py)_[A-Za-z0-9]{1,64}$/,
  payment_intent: /^pi_[A-Za-z0-9]{1,64}$/,
  subscription: /^sub_[A-Za-z0-9]{1,64}$/,
  invoice: /^in_[A-Za-z0-9]{1,64}$/,
  dispute: /^(dp|du)_[A-Za-z0-9]{1,64}$/,
  payout: /^po_[A-Za-z0-9]{1,64}$/,
};

export function validId(kind: keyof typeof STRIPE_ID_RES, v: unknown): string | null {
  return typeof v === "string" && STRIPE_ID_RES[kind].test(v) ? v : null;
}

// Cursors flow into Stripe starting_after — same shape check as IntercomPanel.
export const CURSOR_RE = /^[A-Za-z0-9_:.-]{0,120}$/;

export function validCursor(v: unknown): string | null {
  return typeof v === "string" && v !== "" && CURSOR_RE.test(v) ? v : null;
}

export function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
