import type {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import type { SlaCondition } from "../../sla/types";

// Shared types for the /intercom admin module (facade + hubs). Deliberately a
// separate copy from src/bot/billing/types.ts: the billing session shape is
// Stripe-specific and those files are hot — the ~40 lines of overlap are the
// cheaper coupling.

export type Panel = { embeds: EmbedBuilder[]; components: ActionRowBuilder<MessageActionRowComponentBuilder>[] };

export type AdminGateInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export type RouteMatch = "exact" | "prefix";

export type RouteEntry =
  | { kind: "button"; id: string; match: RouteMatch; handler: (interaction: ButtonInteraction) => Promise<void> }
  | { kind: "select"; id: string; match: RouteMatch; handler: (interaction: StringSelectMenuInteraction) => Promise<void> }
  | { kind: "modal"; id: string; match: RouteMatch; handler: (interaction: ModalSubmitInteraction) => Promise<void> };

export interface RouteSource {
  routes: RouteEntry[];
}

// Working copy of an SLA rule inside the guided builder (create or edit).
export interface SlaRuleDraft {
  ruleId: string | null; // null = creating a new rule
  name: string;
  target: string;
  enabled: boolean;
  conditions: SlaCondition[];
}

// Per-panel state, keyed by the creating interaction id (the token embedded in
// component customIds). Navigation is static (every Back button carries its
// explicit target), so no nav stack — the session only holds flow state.
export interface IcAdminSession {
  ownerUserId: string;
  createdAt: number;
  page?: number; // SLA rules list page
  ruleId?: string; // rule shown in the detail panel
  draft?: SlaRuleDraft; // guided-builder working copy
  pendingKey?: string; // condition dimension awaiting its op/value step
  pendingOp?: string;
  pendingAttrName?: string; // intercom.attribute: picked definition awaiting its value
  lastExprAttempt?: string; // failed expression text — "Fix Expression" re-prompt
  pinRef?: { threadId: string } | { conversationId: string };
}

// Sliding TTL: getOwnedSession refreshes the timestamp on every owned access.
export const SESSION_TTL_MS = 30 * 60 * 1000;

// Exact ids win; otherwise the longest matching registered prefix wins.
export class RouteTable<I> {
  private exact = new Map<string, (interaction: I) => Promise<void>>();
  private prefixes: Array<{ id: string; handler: (interaction: I) => Promise<void> }> = [];

  add(id: string, match: RouteMatch, handler: (interaction: I) => Promise<void>): void {
    if (match === "exact") {
      this.exact.set(id, handler);
    } else {
      this.prefixes.push({ id, handler });
      this.prefixes.sort((a, b) => b.id.length - a.id.length);
    }
  }

  find(id: string): ((interaction: I) => Promise<void>) | null {
    const exact = this.exact.get(id);
    if (exact) return exact;
    for (const entry of this.prefixes) {
      if (id.startsWith(entry.id)) return entry.handler;
    }
    return null;
  }
}
