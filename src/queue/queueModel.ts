import type { IntercomWebhookPart } from "../intercom/types";
import { isMessagePart, newestCustomerMessageAt } from "../intercom/replyState";

// The Intercom Queue's pure core: what Intercom's search hands back, parsed
// into the projection the queue reads, and the one question the whole page is
// about: is this conversation waiting on a reply from us?
//
// "Us" means a person. Intercom's statistics already leave Fin out of
// last_admin_reply_at (the customer-responded sweep relies on the same
// reading), so the default decision needs nothing but the search page. The two
// opt-in toggles (Fin replies count, internal notes count) need the parts and
// are applied on top by extraReplyAfter.

export type QueueKind = "first" | "followup";
export type QueueSla = "ok" | "at_risk" | "breached";

export interface QueueTicketInfo {
  id: string;
  stateId: string | null;
  stateCategory: string | null; // submitted | in_progress | waiting_on_customer | resolved
  stateLabel: string | null;
  typeId: string | null;
  typeName: string | null;
}

// One open conversation as the search projection describes it. Times are unix
// seconds.
export interface QueueConversation {
  id: string;
  state: string; // open | snoozed | closed
  createdAt: number;
  updatedAt: number;
  waitingSince: number | null;
  snoozedUntil: number | null;
  priority: boolean;
  title: string;
  excerpt: string;
  customerName: string | null;
  customerEmail: string | null;
  sourceAuthorType: string | null;
  teamId: string | null;
  adminAssigneeId: string | null;
  tagIds: string[];
  // The linked ticket as the conversation itself names it. Undocumented in
  // the 2.15 spec but present in practice; the ticket search is the primary
  // source and this the fallback.
  ticketId: string | null;
  ticketInline: QueueTicketInfo | null;
  lastContactReplyAt: number | null;
  lastAdminReplyAt: number | null;
  slaStatus: QueueSla | null;
  slaTarget: string | null;
}

// A conversation that waits on us: what every view lists.
export interface QueueItem {
  id: string;
  title: string;
  excerpt: string;
  customerName: string | null;
  customerEmail: string | null;
  snoozed: boolean;
  snoozedUntil: number | null;
  priority: boolean;
  teamId: string | null; // null: the Unassigned inbox
  assigneeId: string | null; // null: no person (Operator, Fin and the bridge's own admin count as none)
  tagIds: string[];
  ticket: QueueTicketInfo | null;
  kind: QueueKind; // first: no teammate reply yet; followup: the customer wrote again
  waitingSince: number; // unix seconds: the customer's oldest unanswered message
  lastContactAt: number;
  updatedAt: number;
  slaStatus: QueueSla | null;
  slaTarget: string | null;
}

export interface ClassifyOptions {
  excludedTeamIds: ReadonlySet<string>;
  excludedTagIds: ReadonlySet<string>;
  excludedTicketTypeIds: ReadonlySet<string>;
  // Lower-cased type names, for a ticket whose type arrived without an id.
  excludedTicketTypeNames: ReadonlySet<string>;
  // Operator/Fin and the bridge's own admin: an assignment to them is no
  // assignment to a person.
  botAdminIds: ReadonlySet<string>;
}

const CONTACT_TYPES = new Set(["user", "lead", "contact"]);
const EXCLUDED_CATEGORIES = new Set(["waiting_on_customer", "resolved"]);
const SLA_VALUES = new Set<QueueSla>(["ok", "at_risk", "breached"]);
const SLA_STATUS_ATTRIBUTE = "SLA Status";
const SLA_TARGET_ATTRIBUTE = "SLA Target";

// ---- parsing (hostile-shaped input: every field is checked) ----

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function idOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

// Intercom uses 0 / "0" for "nobody".
function assigneeId(v: unknown): string | null {
  const id = idOf(v);
  return id && id !== "0" ? id : null;
}

function unix(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

// Intercom bodies and subjects are HTML. The page renders text only, so tags
// go and the common entities are decoded.
export function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (_, e: string) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function ticketTypeOf(v: unknown): { id: string | null; name: string | null } {
  if (typeof v === "string") return { id: null, name: str(v) };
  const o = obj(v);
  return { id: idOf(o?.id), name: str(o?.name) };
}

function ticketStateOf(v: unknown): { id: string | null; category: string | null; label: string | null } {
  if (typeof v === "string") return { id: null, category: str(v), label: null };
  const o = obj(v);
  return {
    id: idOf(o?.id),
    category: str(o?.category),
    label: str(o?.internal_label) ?? str(o?.external_label),
  };
}

// A ticket search hit (POST /tickets/search).
export function parseTicket(raw: unknown): QueueTicketInfo | null {
  const o = obj(raw);
  const id = idOf(o?.id);
  if (!o || !id) return null;
  const state = ticketStateOf(o.ticket_state);
  const type = ticketTypeOf(o.ticket_type);
  return { id, stateId: state.id, stateCategory: state.category, stateLabel: state.label, typeId: type.id, typeName: type.name };
}

// When a ticket last changed (unix seconds; 0 when it does not say). Newer
// copies win when a webhook read and a search read race.
export function ticketUpdatedAt(raw: unknown): number {
  const o = obj(raw);
  return unix(o?.updated_at) ?? unix(o?.created_at) ?? 0;
}

// The parts a conversation GET carries (the Fin / notes toggles read them).
export function partsOf(raw: unknown): IntercomWebhookPart[] {
  const list = obj(obj(raw)?.conversation_parts)?.conversation_parts;
  return Array.isArray(list) ? list.filter((p): p is IntercomWebhookPart => obj(p) != null) : [];
}

// A conversation search hit (POST /conversations/search) or a conversation
// GET: both are the same conversation object.
export function parseConversation(raw: unknown): QueueConversation | null {
  const o = obj(raw);
  const id = idOf(o?.id);
  if (!o || !id) return null;
  const source = obj(o.source);
  const author = obj(source?.author);
  const stats = obj(o.statistics);
  const custom = obj(o.custom_attributes) ?? {};
  const tags = obj(o.tags);
  const ticket = obj(o.ticket);

  let ticketInline: QueueTicketInfo | null = null;
  const ticketId = idOf(ticket?.id);
  if (ticket && ticketId) {
    // The inline ticket names its state as a category string plus a label.
    const state = ticketStateOf(ticket.ticket_state ?? ticket.state);
    const type = ticketTypeOf(ticket.ticket_type);
    ticketInline = {
      id: ticketId,
      stateId: state.id,
      stateCategory: state.category,
      stateLabel: state.label ?? str(ticket.ticket_custom_state_admin_label),
      typeId: type.id,
      typeName: type.name,
    };
  }

  const subject = plainText(str(source?.subject));
  const body = plainText(str(source?.body));
  const titleRaw = str(o.title);
  const ticketAttrs = obj(ticket?.custom_attributes);
  const ticketTitle = str(obj(ticketAttrs?.["_default_title_"])?.value);
  const title = clip(plainText(titleRaw) || subject || plainText(ticketTitle) || clip(body, 80) || `Conversation ${id}`, 140);

  const slaRaw = str(custom[SLA_STATUS_ATTRIBUTE]);
  const authorType = str(author?.type);
  const contactAuthored = authorType != null && CONTACT_TYPES.has(authorType);

  return {
    id,
    state: str(o.state) ?? (o.open === false ? "closed" : "open"),
    createdAt: unix(o.created_at) ?? 0,
    updatedAt: unix(o.updated_at) ?? unix(o.created_at) ?? 0,
    waitingSince: unix(o.waiting_since),
    snoozedUntil: unix(o.snoozed_until),
    priority: o.priority === "priority",
    title,
    excerpt: clip(body, 180),
    customerName: contactAuthored ? str(author?.name) : null,
    customerEmail: contactAuthored ? str(author?.email) : null,
    sourceAuthorType: authorType,
    teamId: assigneeId(o.team_assignee_id),
    adminAssigneeId: assigneeId(o.admin_assignee_id),
    tagIds: (Array.isArray(tags?.tags) ? (tags!.tags as unknown[]) : [])
      .map((t) => idOf(obj(t)?.id))
      .filter((t): t is string => t != null),
    ticketId,
    ticketInline,
    lastContactReplyAt: unix(stats?.last_contact_reply_at),
    lastAdminReplyAt: unix(stats?.last_admin_reply_at),
    slaStatus: slaRaw && SLA_VALUES.has(slaRaw as QueueSla) ? (slaRaw as QueueSla) : null,
    slaTarget: str(custom[SLA_TARGET_ATTRIBUTE]),
  };
}

// The ticket a conversation carries: the ticket search first (it names the
// custom state and the type id), then the conversation's own inline copy. A
// converted ticket keeps its conversation's id, so a conversation that names
// no ticket is looked up under its own id.
export function resolveTicket(conv: QueueConversation, tickets: ReadonlyMap<string, QueueTicketInfo>): QueueTicketInfo | null {
  if (conv.ticketId) return tickets.get(conv.ticketId) ?? conv.ticketInline;
  return tickets.get(conv.id) ?? null;
}

// ---- the decision ----

// null = not waiting on us (closed, a state that excludes it, excluded by
// settings, or a teammate spoke last).
export function classify(conv: QueueConversation, ticket: QueueTicketInfo | null, opts: ClassifyOptions): QueueItem | null {
  if (conv.state === "closed") return null;
  if (ticket?.stateCategory && EXCLUDED_CATEGORIES.has(ticket.stateCategory)) return null;
  if (conv.teamId && opts.excludedTeamIds.has(conv.teamId)) return null;
  if (conv.tagIds.some((t) => opts.excludedTagIds.has(t))) return null;
  if (ticket) {
    if (ticket.typeId && opts.excludedTicketTypeIds.has(ticket.typeId)) return null;
    if (!ticket.typeId && ticket.typeName && opts.excludedTicketTypeNames.has(ticket.typeName.toLowerCase())) return null;
  }

  // The opening message counts as the customer's when they wrote it; an
  // outbound conversation nobody answered waits on nobody.
  const contactAuthored = conv.sourceAuthorType != null && CONTACT_TYPES.has(conv.sourceAuthorType);
  const lastContact = conv.lastContactReplyAt ?? (contactAuthored ? conv.createdAt : null);
  if (lastContact == null || lastContact <= 0) return null;
  if (conv.lastAdminReplyAt != null && conv.lastAdminReplyAt >= lastContact) return null;

  const kind: QueueKind = conv.lastAdminReplyAt == null ? "first" : "followup";
  // Intercom's waiting_since is exactly "the customer's oldest unanswered
  // message". Without it: the conversation start for a first reply, the
  // newest customer message for a follow-up (the closest the statistics get).
  let waitingSince = conv.waitingSince ?? (kind === "first" ? conv.createdAt || lastContact : lastContact);
  if (waitingSince > lastContact) waitingSince = lastContact;

  const assignee = conv.adminAssigneeId && !opts.botAdminIds.has(conv.adminAssigneeId) ? conv.adminAssigneeId : null;
  return {
    id: conv.id,
    title: conv.title,
    excerpt: conv.excerpt,
    customerName: conv.customerName,
    customerEmail: conv.customerEmail,
    snoozed: conv.state === "snoozed",
    snoozedUntil: conv.snoozedUntil,
    priority: conv.priority,
    teamId: conv.teamId,
    assigneeId: assignee,
    tagIds: conv.tagIds,
    ticket,
    kind,
    waitingSince,
    lastContactAt: lastContact,
    updatedAt: conv.updatedAt,
    slaStatus: conv.slaStatus,
    slaTarget: conv.slaTarget,
  };
}

// The opt-in toggles: a Fin reply, or a teammate's internal note, newer than
// the customer's last message also counts as replied. Read from the parts.
export function extraReplyAfter(
  parts: readonly IntercomWebhookPart[],
  lastContactStat: number,
  opts: { fin: boolean; notes: boolean; finAdminIds: ReadonlySet<string>; botAdminIds: ReadonlySet<string> }
): boolean {
  if (!opts.fin && !opts.notes) return false;
  const since = Math.max(newestCustomerMessageAt(parts) ?? 0, lastContactStat);
  for (const p of parts) {
    if ((p.created_at ?? 0) <= since) continue;
    const type = p.author?.type ?? "";
    const id = p.author?.id != null ? String(p.author.id) : "";
    if (opts.fin && isMessagePart(p) && (type === "bot" || (type === "admin" && opts.finAdminIds.has(id)))) return true;
    // A note by a person. The bot's own notes (SLA breach, agent-idle
    // reminders) would otherwise mark the very tickets they flag as answered.
    if (opts.notes && p.part_type === "note" && p.redacted !== true && type === "admin" && id && !opts.botAdminIds.has(id)) return true;
  }
  return false;
}

// Longest waiting first; the id breaks ties so pages are stable.
export function compareWaiting(a: QueueItem, b: QueueItem): number {
  return a.waitingSince - b.waitingSince || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---- scopes ----

export type QueueScope =
  | { kind: "global" }
  | { kind: "mine" }
  | { kind: "inbox"; id: string } // a team id, or "unassigned"
  | { kind: "person"; id: string }; // an admin id, or "none"

export const UNASSIGNED_INBOX = "unassigned";
export const NO_PERSON = "none";
const SCOPE_ID_RE = /^\d{1,20}$/;

export function scopeKey(scope: QueueScope): string {
  return scope.kind === "inbox" || scope.kind === "person" ? `${scope.kind}:${scope.id}` : scope.kind;
}

export function parseScopeKey(key: unknown): QueueScope | null {
  if (key === "global" || key === "mine") return { kind: key };
  if (typeof key !== "string") return null;
  const [kind, id, extra] = key.split(":");
  if (extra !== undefined || !id) return null;
  if (kind === "inbox" && (id === UNASSIGNED_INBOX || SCOPE_ID_RE.test(id))) return { kind, id };
  if (kind === "person" && (id === NO_PERSON || SCOPE_ID_RE.test(id))) return { kind, id };
  return null;
}

export function inScope(item: QueueItem, scope: QueueScope, meId: string): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "mine":
      return item.assigneeId === meId;
    case "inbox":
      return scope.id === UNASSIGNED_INBOX ? item.teamId == null : item.teamId === scope.id;
    case "person":
      return scope.id === NO_PERSON ? item.assigneeId == null : item.assigneeId === scope.id;
  }
}

// ---- filters (shared by all three views) ----

export interface QueueFilters {
  kind: QueueKind | null;
  priorityOnly: boolean;
  sla: QueueSla | "none" | null;
  includeSnoozed: boolean;
}

export function parseFilters(raw: Record<string, string>): QueueFilters {
  return {
    kind: raw.kind === "first" || raw.kind === "followup" ? raw.kind : null,
    priorityOnly: raw.priority === "only",
    sla: raw.sla === "ok" || raw.sla === "at_risk" || raw.sla === "breached" || raw.sla === "none" ? raw.sla : null,
    includeSnoozed: raw.snoozed === "include",
  };
}

// Everything except the kind filter (the count cards show both kinds).
export function applyBaseFilters(items: readonly QueueItem[], f: QueueFilters): QueueItem[] {
  return items.filter(
    (i) =>
      (f.includeSnoozed || !i.snoozed) &&
      (!f.priorityOnly || i.priority) &&
      (f.sla == null || (f.sla === "none" ? i.slaStatus == null : i.slaStatus === f.sla))
  );
}

export function applyFilters(items: readonly QueueItem[], f: QueueFilters): QueueItem[] {
  return applyBaseFilters(items, f).filter((i) => f.kind == null || i.kind === f.kind);
}

// ---- randomizer ----

// Older tickets are likelier: the weight is the wait in seconds (a floor of a
// minute keeps a brand-new ticket in the draw). rng returns [0, 1).
export function weightedPick<T extends { waitingSince: number }>(pool: readonly T[], nowSec: number, rng: () => number): T | null {
  if (pool.length === 0) return null;
  const weights = pool.map((i) => Math.max(60, nowSec - i.waitingSince));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.min(Math.max(rng(), 0), 0.999999999) * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// ---- formatting ----

// The teammate-facing Intercom host for the workspace's region.
export function intercomAppHost(region: "us" | "eu" | "au"): string {
  return region === "eu" ? "https://app.eu.intercom.com" : region === "au" ? "https://app.au.intercom.com" : "https://app.intercom.com";
}

// "just now", "12m", "3h 12m", "2d 4h".
export function waitLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
