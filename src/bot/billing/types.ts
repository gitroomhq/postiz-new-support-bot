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
  subscriptionId?: string;
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
  targetDiscordUserId?: string;
  promoCodeId?: string;
  paymentMethodId?: string;
  couponId?: string;
  custSnapshot?: {
    name: string;
    email: string;
    phone: string;
    description: string;
    address: Stripe.Address | null;
  };
}

export type AdminGateInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | UserSelectMenuInteraction
  | ModalSubmitInteraction;

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
