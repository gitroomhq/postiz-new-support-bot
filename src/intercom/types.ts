// Outbox event taxonomy for the Intercom bridge. Events are enqueued by
// IntercomSyncService and executed in per-ticket FIFO order by the
// IntercomOutboxScheduler. Payloads are stored as JSON, so keep them plain.
//
// Bridge object model: one Discord ticket maps to an Intercom CONVERSATION
// (the transcript — customer messages as contact-authored comments, staff/AI
// mirror + agent replies as admin comments, notes as conversation notes) plus
// a linked customer TICKET created via convert (type = bot category, custom
// ticket state = bot status tag, Priority/CSAT as ticket attributes).

export type OutboxEventType = "ensure" | "message" | "note" | "status" | "priority" | "csat";

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
  question?: string | null; // _default_description_ of the converted ticket
  statusTagId: string | null; // initial ticket state resolved at execute time
  statusLabel: string;
  closed: boolean;
  resolved: boolean;
  priorityLabel: string | null; // verbatim "🟧 High" — Priority ticket attribute
  createdAtIso: string; // backdates conversation (created_at)
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

export interface StatusPayload {
  // Mapping to an Intercom ticket state is resolved at execute time (the
  // /config mapping can change while the event is queued).
  statusTagId: string | null;
  statusLabel: string;
  fromLabel?: string | null;
  actorName: string;
  closed: boolean;
  resolved: boolean;
  // false when the transition is already covered elsewhere (e.g. backfill history notes)
  note: boolean;
}

export interface PriorityPayload {
  priorityLabel: string; // verbatim "🟧 High"
  fromLabel?: string | null;
  actorName: string;
  note: boolean;
}

export interface CsatPayload {
  score: number;
  comment?: string | null;
}

export type OutboxPayload =
  | EnsurePayload
  | MessagePayload
  | NotePayload
  | StatusPayload
  | PriorityPayload
  | CsatPayload;

// ---- Intercom API shapes (only the fields the bridge reads) ----

export interface IntercomAdmin {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface IntercomTicketType {
  id: string;
  name: string;
  category?: string | null; // "Customer" | "Back-office" | "Tracker"
  attributeNames: string[];
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
}

// data.item for conversation.* topics.
export interface IntercomConversationItem {
  type?: string;
  id?: string | number;
  conversation_parts?: { conversation_parts?: IntercomWebhookPart[] };
}

// data.item for ticket.* topics.
export interface IntercomTicketItem {
  type?: string;
  id?: string | number;
  ticket_state?: { id?: string | number } | string | null;
  ticket_parts?: { ticket_parts?: IntercomWebhookPart[] };
}

export interface IntercomWebhookEvent {
  type?: string; // "notification_event"
  topic?: string;
  data?: { item?: IntercomConversationItem | IntercomTicketItem };
}
