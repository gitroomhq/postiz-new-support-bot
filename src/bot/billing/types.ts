import type {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from "discord.js";
import type Stripe from "stripe";

// Actions that first resolve "a user" to a Stripe customer before running.
export const TARGET_ACTIONS = ["cards", "overview", "charges", "invoices", "fraud", "discount", "changeplan", "createsub", "editcust", "delcust"] as const;
export type TargetAction = (typeof TARGET_ACTIONS)[number];

export const TARGET_TITLES: Record<TargetAction | "link", string> = {
  cards: "Card fingerprints of a user",
  overview: "Customer overview",
  charges: "Charges for a user",
  invoices: "Invoice history",
  fraud: "Disputes & fraud signals",
  discount: "Apply discount coupon",
  changeplan: "Change subscription plan",
  createsub: "Create a subscription",
  editcust: "Edit customer info",
  delcust: "Delete a customer",
  link: "Link / unlink Stripe customer",
};

export type Panel = { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] };

export interface BillAdminSession {
  ownerUserId: string;
  createdAt: number;
  // Paginated list state: which view the pager renders and the per-page cursor
  // (charges/invoices: starting_after id; charge search: page token).
  view?: "charges" | "invoices" | "fpcharges";
  cursors?: (string | undefined)[];
  customerId?: string;
  customerIds?: string[];
  pendingAction?: TargetAction;
  fingerprint?: string;
  chargeId?: string;
  refundAmountMinor?: number | null; // null = full remaining amount
  // Where the refund result panel's Back returns — the panel the refund was
  // launched from (charge detail when opened there, else the Charges hub).
  refundReturn?: string;
  subscriptionId?: string;
  paymentIntentId?: string;
  // Origin-aware Back navigation: a stack of re-renderable button custom-ids
  // (pushed at navigation time, popped by billadmin_nav_back:<token>).
  nav?: string[];
  // Set by the nav-back dispatcher while re-invoking a popped route, so that a
  // route which normally pushes (it doubles as a navigation entry) doesn't
  // re-grow the stack when it merely re-renders as a Back target.
  navSkipPush?: boolean;
  // Change-plan / create-subscription flow state.
  pendingSubAction?: "discount" | "changeplan" | "createsub";
  subItemId?: string;
  newPriceId?: string;
  discountChoice?: string; // "keep" | "remove" | coupon id | "pc:<promo id>"
  discountLabel?: string; // human label for pc: choices (the code string)
  planFrom?: string;
  planTo?: string;
  trialDays?: number;
  hasDefaultPm?: boolean;
  // Hub area the flow was entered from — Back buttons return here when an
  // action (e.g. Overview) is listed in more than one hub.
  originHub?: string;
  // Dispute console + block flow state.
  disputeId?: string;
  blockCandidates?: { kind: string; value: string }[];
  blockSel?: string[]; // selected candidates, "kind|value"
  blockReason?: string;
  blockReturn?: string; // re-render id of the panel the block flow was opened from
  targetDiscordUserId?: string;
  promoCodeId?: string;
  paymentMethodId?: string;
  couponId?: string;
  // Where the discount confirm panel's Back/Cancel returns (varies by entry point:
  // the subs hub vs. an individual subscription view).
  discountBackId?: string;
  custSnapshot?: {
    name: string;
    email: string;
    phone: string;
    description: string;
    address: Stripe.Address | null;
    businessName: string;
    individualName: string;
    shipping: Stripe.Customer.Shipping | null;
    invoicePrefix: string;
    nextInvoiceSequence: number | null;
    invoiceFooter: string;
    invoiceCustomFields: { name: string; value: string }[];
    amountTaxDisplay: string;
    metadata: Record<string, string>;
  };
}

export type AdminGateInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | ModalSubmitInteraction;

// ---- origin-aware Back navigation (billadmin_nav_back:<token>) ----

// Deep-but-bounded: 12 levels of panel nesting is beyond anything the UI can
// realistically produce; beyond that the oldest entries are dropped.
export const NAV_STACK_MAX = 12;

// Records the CURRENT panel's re-render custom-id right before navigating into
// another panel, so that panel's Back can restore this one. Consecutive
// duplicates are collapsed (re-entering the same panel must not require two
// Back presses to leave).
export function pushNav(session: BillAdminSession, currentPanelId: string): void {
  if (session.navSkipPush) {
    session.navSkipPush = false;
    return;
  }
  session.nav ??= [];
  if (session.nav[session.nav.length - 1] === currentPanelId) return;
  session.nav.push(currentPanelId);
  if (session.nav.length > NAV_STACK_MAX) session.nav.splice(0, session.nav.length - NAV_STACK_MAX);
}

export function popNav(session: BillAdminSession): string | undefined {
  return session.nav?.pop();
}

export const FINGERPRINT_RE = /^[A-Za-z0-9]{8,64}$/;
// Sliding TTL: getOwnedSession refreshes the timestamp on every owned access.
export const SESSION_TTL_MS = 30 * 60 * 1000;

// The minimal interaction surface the (already deferred) renderers need.
export type RenderInteraction = { editReply: (payload: Panel) => Promise<unknown> };
// Renderers that also open a new panel session need the interaction id + user.
export type SessionRenderInteraction = RenderInteraction & { id: string; user: { id: string } };

export type RouteMatch = "exact" | "prefix";

// One entry of a hub's route table. The facade builds four Maps (one per kind)
// at construction and dispatches exact match first, then longest-prefix match.
export type RouteEntry =
  | { kind: "button"; id: string; match: RouteMatch; handler: (interaction: ButtonInteraction) => Promise<void> }
  | { kind: "select"; id: string; match: RouteMatch; handler: (interaction: StringSelectMenuInteraction) => Promise<void> }
  | { kind: "userSelect"; id: string; match: RouteMatch; handler: (interaction: UserSelectMenuInteraction) => Promise<void> }
  | { kind: "modal"; id: string; match: RouteMatch; handler: (interaction: ModalSubmitInteraction) => Promise<void> };

export interface RouteSource {
  routes: RouteEntry[];
}
