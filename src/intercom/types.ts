// Outbox event taxonomy for the Intercom bridge. Events are enqueued by
// IntercomSyncService and executed in per-ticket FIFO order by the
// IntercomOutboxScheduler. Payloads are stored as JSON, so keep them plain.
//
// Bridge object model: one Discord ticket maps to an Intercom CONVERSATION
// (the transcript — customer messages as contact-authored comments, staff/AI
// mirror + agent replies as admin comments, notes as conversation notes) plus
// a linked customer TICKET created via convert (type = bot category, custom
// ticket state = bot status tag, CSAT as ticket attributes).

export type OutboxEventType =
  | "ensure"
  | "message"
  | "note"
  | "status"
  // Legacy skip-only member: the priority axis is removed, but durable queued
  // events may still carry the type — the executor skips it. Removable once
  // no queued events can still carry it.
  | "priority"
  | "csat"
  // Agent-idle reminder for a bridged ticket: internal note + reopen so the
  // conversation resurfaces in the Intercom inbox.
  | "agent_reminder"
  | "message_edit"
  | "message_delete"
  // SLA re-evaluation (payload always null — target computed at delivery
  // time by SlaService.applyForBridged).
  | "sla";

// Creates (or adopts) the contact, conversation and converted ticket, and
// writes the IntercomLink. Always the first event for a ticket; later events
// require the link. Resumable: the link row is written as soon as the
// conversation exists (ticketId null until convert succeeds).
export interface EnsurePayload {
  customerId: string | null;
  customerDisplayName: string | null;
  postizUserId?: string | null; // primary external_id source
  stripeCustomerId?: string | null;
  categoryId: string | null; // ticket-type map key ("howto" | "bugs" | "billing")
  categoryLabel?: string | null;
  // Discord-only ticket (refund flow): true = the executor short-circuits the
  // ensure; explicit false = a flipped refund ticket (customer typed — must
  // ensure normally). Absent on payloads queued before the flag existed — the
  // executor falls back to the legacy (categoryId, question) refund predicate.
  intercomExempt?: boolean;
  question?: string | null; // _default_description_ of the converted ticket
  // true (live tickets): the rendered question doubles as the conversation's
  // opening message. false (backfill): the transcript replay carries the
  // content, so the opening message is a generic import header.
  questionAsOpening?: boolean;
  // https://discord.com/channels/{guildId}/{threadId} — context note + canvas.
  threadUrl?: string | null;
  statusTagId: string | null; // initial ticket state resolved at execute time
  statusLabel: string;
  closed: boolean;
  resolved: boolean;
  createdAtIso: string; // backdates conversation (created_at)
  // Current Discord avatar URL — refreshed onto the Intercom contact so repeat
  // customers don't show under a blank avatar / years-old identity.
  customerAvatarUrl?: string | null;
}

export interface MessageAttachmentRef {
  url: string;
  filename: string;
  size: number;
}

export interface MessagePayload {
  direction: "incoming" | "outgoing";
  content: string;
  discordMessageId?: string;
  externalCreatedAtIso?: string; // → created_at on the reply (real backdating)
  attachments?: MessageAttachmentRef[];
  // "urls": pass image CDN links as attachment_urls (live mirror — Intercom
  // ingests them immediately). "links": append all as text (backfill — signed
  // Discord URLs are likely expired by then).
  attachmentMode?: "urls" | "links";
}

export interface NotePayload {
  content: string;
  externalCreatedAtIso?: string;
}

// Messages-only mirroring: status events update the ticket object
// (state / attributes) but never post transcript notes. Old queued payloads
// may still carry a legacy `note` field — executors ignore it.
export interface StatusPayload {
  // Mapping to an Intercom ticket state is resolved at execute time (the
  // /config mapping can change while the event is queued).
  statusTagId: string | null;
  statusLabel: string;
  fromLabel?: string | null;
  actorName: string;
  closed: boolean;
  resolved: boolean;
  // Backfill tail: re-assert conversation open/close even when the damper says
  // it's already there — the replayed contact messages auto-reopen the
  // conversation in Intercom behind the damper's back.
  forceOpenSync?: boolean;
}

export interface CsatPayload {
  score: number;
  comment?: string | null;
}

// Agent-idle reminder on a bridged ticket (checkTicketTimers SUPPORT target):
// executed as an internal note + conversation reopen.
export interface AgentReminderPayload {
  idleDays: number;
  threadUrl: string | null;
  // Rendered per-tag override for the note's first line ({days} already
  // substituted); absent/null = built-in default. Optional so payloads queued
  // before this field existed still execute.
  noteText?: string | null;
}

// Intercom has no part-edit/delete API, so edits and deletions mirror as
// APPENDED parts ("✏️ edited …" / "🗑️ deleted"). Only messages the delivery
// ledger has confirmed as mirrored produce these (checked at execute time).
export interface MessageEditPayload {
  discordMessageId: string;
  editedAtIso: string; // dedup stamp — repeated edits of one message each mirror once
  direction: "incoming" | "outgoing";
  authorName: string;
  content: string; // the NEW message content, Discord markdown
  attachments?: MessageAttachmentRef[];
}

export interface MessageDeletePayload {
  discordMessageId: string;
  direction: "incoming" | "outgoing";
  authorName: string | null; // null when the deleted message wasn't cached
}

export type OutboxPayload =
  | EnsurePayload
  | MessagePayload
  | NotePayload
  | StatusPayload
  | CsatPayload
  | AgentReminderPayload
  | MessageEditPayload
  | MessageDeletePayload;

// ---- Inactivity sweeper shapes (native/unbridged workspace objects) ----

export interface IntercomSweepConversation {
  id: string;
  state: string; // "open" | "closed" | "snoozed"
  createdAt: Date | null;
  waitingSince: Date | null; // customer waiting for a teammate since (NRT clock anchor)
  snoozedUntil: Date | null;
  firstAdminReplyAt: Date | null; // raw statistics — may be Fin/Operator
  lastContactReplyAt: Date | null;
  lastAdminReplyAt: Date | null;
  teamAssigneeId: string | null;
  adminAssigneeId: string | null;
  customAttributes: Record<string, unknown>;
}

export interface IntercomSweepTicket {
  id: string;
  category: string | null; // "Customer" | "Back-office" | "Tracker"
  updatedAt: Date | null;
  createdAt: Date | null;
  teamAssigneeId: string | null;
}

// ---- Intercom API shapes (only the fields the bridge reads) ----

export interface IntercomAdmin {
  id: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  awayModeEnabled?: boolean;
  hasInboxSeat?: boolean;
}

export interface IntercomTicketType {
  id: string;
  name: string;
  category?: string | null; // "Customer" | "Back-office" | "Tracker"
  attributeNames: string[];
  attributes: IntercomTicketTypeAttribute[];
}

export interface IntercomTicketTypeAttribute {
  id: string;
  name: string;
  archived: boolean;
}

export interface IntercomTicketState {
  id: string;
  category?: string | null; // submitted | in_progress | waiting_on_customer | resolved
  internalLabel: string;
  archived: boolean;
}

// ---- Webhook payloads (subset) ----

export interface IntercomWebhookAuthor {
  id?: string | number;
  type?: string; // "admin" | "bot" | "team" | "user" | "lead"
  name?: string | null;
  avatar?: { image_url?: string | null } | string | null;
}

export interface IntercomWebhookPart {
  id?: string | number;
  part_type?: string; // "comment" | "note" | "open" | "close" | ...
  body?: string | null;
  created_at?: number;
  author?: IntercomWebhookAuthor;
  attachments?: Array<{ url?: string | null; name?: string | null }>;
  // True once an agent deleted the part — set both in conversation_part.redacted
  // payloads and on parts fetched via the conversation GET.
  redacted?: boolean;
}

// data.item for conversation.* topics.
export interface IntercomConversationItem {
  type?: string;
  id?: string | number;
  conversation_parts?: { conversation_parts?: IntercomWebhookPart[] };
  admin_assignee_id?: number | string | null; // balanced assignment + assignee SLA dim
  team_assignee_id?: number | string | null; // scopes the balanced-assignment pool + per-team config
  snoozed_until?: number | null;
  tags?: { tags?: Array<{ id?: string | number; name?: string | null }> };
  // Native priority level (none/low/medium/high/urgent) — READ-only via the
  // public API; older payloads may carry the legacy "priority"/"not_priority".
  priority?: string | null;
}

// data.item for ticket.* topics.
export interface IntercomTicketItem {
  type?: string;
  id?: string | number;
  // category: submitted | in_progress | waiting_on_customer | resolved
  ticket_state?: { id?: string | number; category?: string | null } | string | null;
  ticket_parts?: { ticket_parts?: IntercomWebhookPart[] };
}

export interface IntercomWebhookEvent {
  type?: string; // "notification_event"
  id?: string; // notification event id — inbox dedup key for Intercom's retry
  topic?: string;
  data?: { item?: IntercomConversationItem | IntercomTicketItem };
}
