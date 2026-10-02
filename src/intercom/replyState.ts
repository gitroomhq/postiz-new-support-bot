import type { IntercomTicketState, IntercomTicketStateChange, IntercomWebhookPart } from "./types";

// Customer-responded ticket state, the pure half. A customer reply moves an
// Intercom ticket into the operator-picked "Customer responded" state and the
// bot remembers where it came from; the next teammate reply puts it back.
// ReplyStateService does the I/O; everything here is deterministic and
// unit-tested.

// A customer reply only moves tickets sitting in one of these categories
// (operator decision). Resolved tickets keep Intercom's own reopen behavior.
export const TRIGGER_CATEGORIES: ReadonlySet<string> = new Set(["submitted", "in_progress", "waiting_on_customer"]);

// Actor names on the Discord status changes this flow causes. The customer
// reply flip in DiscordBot (and the timer self-heal) stamps the first; the
// outbound status push recognises it so a flip landing after the
// customer-responded write does not overwrite it.
export const CUSTOMER_REPLY_ACTOR = "Customer reply";
export const AGENT_REPLY_ACTOR = "Agent reply";

// Clock skew allowance between a customer's part and Intercom's own state
// transition, which lands a second or so after it.
const AUTO_TRANSITION_SKEW_S = 5;

// The category our reply returns the ticket to. Going back to Submitted after
// a teammate just answered, or to Resolved on a reopened conversation, is
// wrong, so both land on Waiting on customer; so does an unknown history
// (operator decision).
export function restoreCategory(base: string | null | undefined): "in_progress" | "waiting_on_customer" {
  return base === "in_progress" ? "in_progress" : "waiting_on_customer";
}

const DEFAULT_LABELS: Record<string, string> = {
  submitted: "submitted",
  in_progress: "in progress",
  waiting_on_customer: "waiting on customer",
  resolved: "resolved",
};

// The concrete state for a category: the one carrying Intercom's default label
// when the workspace has several in that category, else the first. Never the
// customer-responded state itself, and never an archived one.
export function pickStateForCategory(
  states: readonly IntercomTicketState[],
  category: string,
  excludeId: string | null
): IntercomTicketState | null {
  const pool = states.filter((s) => s.category === category && s.id !== excludeId && !s.archived);
  const preferred = DEFAULT_LABELS[category];
  return pool.find((s) => s.internalLabel.trim().toLowerCase() === preferred) ?? pool[0] ?? null;
}

// The state change that produced the ticket's current state: the newest one.
function newestChange(changes: readonly IntercomTicketStateChange[]): IntercomTicketStateChange | null {
  let newest: IntercomTicketStateChange | null = null;
  for (const c of changes) {
    if (!newest || c.createdAt >= newest.createdAt) newest = c;
  }
  return newest;
}

// Intercom moves a ticket from Waiting on customer (or Resolved) to In progress
// by itself the moment the customer replies, and that can land before the bot
// reads the ticket. Returns the category the ticket had BEFORE that built-in
// transition, or null when the current state was not produced by it: the
// transition must be the newest change, land at or after the reply, go into
// In progress, and not come from a person or an API app.
export function autoTransitionOrigin(
  changes: readonly IntercomTicketStateChange[],
  replyAtSec: number,
  isHumanAdmin: (authorId: string | null) => boolean
): string | null {
  const c = newestChange(changes);
  if (!c) return null;
  if (c.createdAt < replyAtSec - AUTO_TRANSITION_SKEW_S) return null;
  if (c.current !== "in_progress") return null;
  if (c.previous !== "waiting_on_customer" && c.previous !== "resolved") return null;
  if (c.appPackageCode) return null;
  if (c.authorType === "admin" && isHumanAdmin(c.authorId)) return null;
  return c.previous;
}

// Same question answered from CONVERSATION parts, for when the ticket parts
// carry no category history: a non-human, non-API state update right after the
// customer's reply, with nothing changing the state after it, is Intercom's
// built-in transition. Conversation parts don't say which category it left, so
// the conversation's open/close trail decides: closed before the reply means
// it was Resolved, otherwise Waiting on customer.
export function autoTransitionOriginFromParts(
  parts: readonly IntercomWebhookPart[],
  replyAtSec: number,
  isHumanAdmin: (authorId: string | null) => boolean
): string | null {
  const stateParts = parts.filter((p) => (p.part_type ?? "").startsWith("ticket_state_updated"));
  let newest: IntercomWebhookPart | null = null;
  for (const p of stateParts) {
    if (!newest || (p.created_at ?? 0) >= (newest.created_at ?? 0)) newest = p;
  }
  if (!newest) return null;
  if ((newest.created_at ?? 0) < replyAtSec - AUTO_TRANSITION_SKEW_S) return null;
  if (newest.app_package_code) return null;
  const authorId = newest.author?.id != null ? String(newest.author.id) : null;
  if (newest.author?.type === "admin" && isHumanAdmin(authorId)) return null;
  // Open/close trail strictly before the customer's reply.
  let lastOpenClose: IntercomWebhookPart | null = null;
  for (const p of parts) {
    if (p.part_type !== "open" && p.part_type !== "close") continue;
    if ((p.created_at ?? 0) >= replyAtSec) continue;
    if (!lastOpenClose || (p.created_at ?? 0) >= (lastOpenClose.created_at ?? 0)) lastOpenClose = p;
  }
  return lastOpenClose?.part_type === "close" ? "resolved" : "waiting_on_customer";
}

// No restore row (state set by hand, or before this shipped): the category
// the ticket left when it entered its current state, from the history. An
// in-category move made by an API app is this bot's own write right after
// Intercom's built-in move, and says nothing; the change before it does.
export function previousCategoryFromHistory(
  changes: readonly IntercomTicketStateChange[],
  currentCategory: string | null
): string | null {
  const ordered = [...changes].sort((a, b) => b.createdAt - a.createdAt);
  for (const c of ordered) {
    if (currentCategory && c.current !== currentCategory) continue;
    if (c.appPackageCode && c.previous === c.current) continue;
    return c.previous;
  }
  return null;
}

const CONTACT_TYPES = new Set(["user", "lead", "contact"]);

function hasContent(part: IntercomWebhookPart): boolean {
  const body = part.body ?? "";
  if (/<img\b/i.test(body)) return true;
  if ((part.attachments ?? []).some((a) => Boolean(a.url))) return true;
  return body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim().length > 0;
}

// A part that carries a message to or from the customer: comments, plus the
// assignment/open/close parts a reply rides on when it is sent together with
// that action (reply-and-assign, reply-and-close). Notes never count.
export function isMessagePart(part: IntercomWebhookPart): boolean {
  if (part.redacted === true) return false;
  const type = part.part_type;
  if (!type || type === "comment" || type === "quick_reply") return hasContent(part);
  if (type === "assignment" || type === "open" || type === "close") return hasContent(part);
  return false;
}

// A teammate's reply: a message part authored by a real admin. The bridge's
// own identities (Operator, the configured fallback admin) and every bot (Fin,
// workflows) are excluded: per the operator, only people count as "we
// responded".
export function isHumanReply(part: IntercomWebhookPart, isHumanAdmin: (authorId: string | null) => boolean): boolean {
  if (!isMessagePart(part)) return false;
  if (part.author?.type !== "admin") return false;
  return isHumanAdmin(part.author.id != null ? String(part.author.id) : null);
}

export function isCustomerMessage(part: IntercomWebhookPart): boolean {
  return isMessagePart(part) && CONTACT_TYPES.has(part.author?.type ?? "");
}

// Newest customer message time (unix seconds) among the given parts.
export function newestCustomerMessageAt(parts: readonly IntercomWebhookPart[]): number | null {
  let at: number | null = null;
  for (const p of parts) {
    if (!isCustomerMessage(p)) continue;
    const t = p.created_at ?? 0;
    if (at == null || t > at) at = t;
  }
  return at;
}

// Who spoke last, for the one-time sweep. Teammates always count as us. On a
// bridged conversation the bridge's own posts count too: that is how a Discord
// staff reply reaches Intercom. Fin and other bots never count.
export function lastSpeaker(
  parts: readonly IntercomWebhookPart[],
  opts: { bridged: boolean; isHumanAdmin: (authorId: string | null) => boolean; isBridgeAuthor: (authorId: string | null) => boolean }
): "customer" | "us" | null {
  let newest: { at: number; who: "customer" | "us" } | null = null;
  for (const p of parts) {
    if (!isMessagePart(p)) continue;
    const authorId = p.author?.id != null ? String(p.author.id) : null;
    let who: "customer" | "us" | null = null;
    if (CONTACT_TYPES.has(p.author?.type ?? "")) who = "customer";
    else if (p.author?.type === "admin" && opts.isHumanAdmin(authorId)) who = "us";
    else if (opts.bridged && opts.isBridgeAuthor(authorId)) who = "us";
    if (!who) continue;
    const at = p.created_at ?? 0;
    if (!newest || at >= newest.at) newest = { at, who };
  }
  return newest?.who ?? null;
}
