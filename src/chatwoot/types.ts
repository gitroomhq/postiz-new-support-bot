// Outbox event taxonomy for the Chatwoot bridge. Events are enqueued by
// ChatwootSyncService and executed in per-ticket FIFO order by the
// ChatwootOutboxScheduler. Payloads are stored as JSON, so keep them plain.

export type ChatwootPriority = "low" | "medium" | "high" | "urgent";

export type OutboxEventType = "ensure_conversation" | "message" | "note" | "status" | "priority" | "csat";

// Creates (or adopts) the contact + conversation and writes the ChatwootLink.
// Always the first event for a ticket; later events require the link.
export interface EnsureConversationPayload {
  customerId: string | null;
  customerDisplayName: string | null;
  postizUserId?: string | null;
  stripeCustomerId?: string | null;
  categoryLabel?: string | null;
  statusSlug: string;
  statusLabel: string;
  closed: boolean;
  resolved: boolean;
  priority: ChatwootPriority | null;
  createdAtIso: string;
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
  externalCreatedAtIso?: string;
  attachments?: MessageAttachmentRef[];
}

export interface NotePayload {
  content: string;
  externalCreatedAtIso?: string;
}

export interface StatusPayload {
  statusSlug: string;
  statusLabel: string;
  fromLabel?: string | null;
  actorName: string;
  closed: boolean;
  resolved: boolean;
  // false when the transition is already covered elsewhere (e.g. backfill history notes)
  note: boolean;
}

export interface PriorityPayload {
  priority: ChatwootPriority | null;
  priorityLabel: string;
  fromLabel?: string | null;
  actorName: string;
  note: boolean;
}

export interface CsatPayload {
  score: number;
  comment?: string | null;
}

export type OutboxPayload =
  | EnsureConversationPayload
  | MessagePayload
  | NotePayload
  | StatusPayload
  | PriorityPayload
  | CsatPayload;

// ---- Chatwoot API shapes (only the fields the bridge reads) ----

export interface ChatwootContact {
  id: number;
  identifier?: string | null;
  name?: string | null;
}

export interface ChatwootConversationRef {
  id: number;
  // display_id is what Application API paths and webhook payloads use; on create
  // responses it may be absent (id == display_id for conversations in practice —
  // verified against the API; we store whichever is present, preferring display_id).
  display_id?: number;
}

// content_attributes stamped onto every message the bridge creates. The webhook
// handler drops messages carrying discord_bridge to prevent echo loops.
// (Index signature keeps it assignable to the client's Record<string, unknown>.)
export interface BridgeContentAttributes extends Record<string, unknown> {
  discord_bridge: true;
  discord_message_id?: string;
  external_created_at?: string;
}

// ---- Webhook payloads (subset) ----

export interface ChatwootWebhookSender {
  id?: number;
  name?: string;
  available_name?: string;
  avatar_url?: string;
  type?: string; // "user" (agent) | "contact" | "agent_bot"
}

export interface ChatwootWebhookEvent {
  event?: string;
  // message_created fields
  id?: number;
  content?: string | null;
  // Chatwoot sends message_type as a string in webhooks ("incoming"/"outgoing"),
  // but tolerate the numeric enum (0/1) seen in some payloads.
  message_type?: string | number;
  private?: boolean;
  content_attributes?: Record<string, unknown>;
  sender?: ChatwootWebhookSender;
  attachments?: Array<{ data_url?: string; file_name?: string }>;
  conversation?: {
    id?: number;
    display_id?: number;
    status?: string;
  };
  // conversation_status_changed fields (event object IS the conversation)
  status?: string;
  display_id?: number;
}
