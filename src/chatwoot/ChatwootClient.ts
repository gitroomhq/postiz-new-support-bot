import { createHmac } from "node:crypto";
import { SettingsStore } from "../config/SettingsStore";
import { ChatwootPriority } from "./types";

// Thrown for non-2xx responses so the outbox scheduler can classify transient
// (retry) vs permanent (dead-letter) failures by HTTP status.
export class ChatwootHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ChatwootHttpError";
  }
}

export interface AttachmentFile {
  filename: string;
  data: Buffer;
  contentType?: string;
}

// Two-credential client — the bridge deliberately has NO agent API key:
//
// - Contact side: public Client API (/public/api/v1/inboxes/{inbox_identifier})
//   authenticated only by knowing the inbox identifier, plus an optional
//   identity-validation HMAC (identifier_hash on contact endpoints). Customer
//   messages posted here are attributed to the real contact.
// - Agent side: an Agent Bot access token on /api/v1/accounts/{account_id}.
//   Bot tokens have a hard endpoint allowlist (conversations show/status/
//   priority/custom_attributes, message create incl. private + attachments,
//   labels index/create, assignments) — everything the bridge needs, nothing more.
//
// Settings come from SettingsStore (edited live via /config), so every call
// re-reads them and changes apply without a restart.
export class ChatwootClient {
  constructor(private settingsStore: SettingsStore) {}

  private baseUrl(): string {
    return (this.settingsStore.chatwootBaseUrl() ?? "").replace(/\/+$/, "");
  }

  private clientBase(): string {
    return `${this.baseUrl()}/public/api/v1/inboxes/${this.settingsStore.chatwootInboxIdentifier()}`;
  }

  private botBase(): string {
    return `${this.baseUrl()}/api/v1/accounts/${this.settingsStore.chatwootAccountId()}`;
  }

  private botHeaders(): Record<string, string> {
    return { api_access_token: this.settingsStore.chatwootBotToken() ?? "" };
  }

  // identifier_hash for inboxes with identity validation: HMAC-SHA256 hexdigest
  // of the identifier, keyed with the inbox's hmac_token. Omitted when no key is
  // configured (validation optional / not enforced).
  private identifierHash(identifier: string): string | null {
    const key = this.settingsStore.chatwootHmacKey();
    if (!key) return null;
    return createHmac("sha256", key).update(identifier).digest("hex");
  }

  private async parse<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new ChatwootHttpError(
        response.status,
        `Chatwoot ${what} ${response.status}: ${(error as any).message || (error as any).error || response.statusText}`,
        Number.isFinite(retryAfter) ? retryAfter : undefined
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Every call gets a hard timeout: a single hung request must never freeze the
  // outbox drainer (its overlap guard would otherwise block all future ticks).
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private async json<T>(url: string, method: string, headers: Record<string, string>, body: unknown, what: string): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ChatwootClient.REQUEST_TIMEOUT_MS),
    });
    return this.parse<T>(response, what);
  }

  private buildForm(fields: Record<string, string>, files: AttachmentFile[]): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    for (const file of files) {
      form.append(
        "attachments[]",
        new Blob([new Uint8Array(file.data)], { type: file.contentType ?? "application/octet-stream" }),
        file.filename
      );
    }
    return form;
  }

  // ---- Client API (contact side) ----

  // Create-or-adopt: Chatwoot dedupes account-wide by identifier, so posting an
  // existing identifier returns the same contact. source_id is the contact
  // identifier used in all later Client-API URLs.
  async ensureContact(input: {
    identifier: string;
    name: string;
    customAttributes?: Record<string, unknown>;
  }): Promise<{ sourceId: string; contactId: number }> {
    const hash = this.identifierHash(input.identifier);
    const data = await this.json<{ source_id?: string; id?: number }>(
      `${this.clientBase()}/contacts`,
      "POST",
      {},
      {
        identifier: input.identifier,
        ...(hash ? { identifier_hash: hash } : {}),
        name: input.name,
        ...(input.customAttributes ? { custom_attributes: input.customAttributes } : {}),
      },
      "contact create"
    );
    if (!data.source_id || data.id == null) {
      throw new ChatwootHttpError(500, "Chatwoot contact create: missing source_id/id in response");
    }
    return { sourceId: data.source_id, contactId: data.id };
  }

  // Returns the account-scoped display_id — the same id webhooks carry and bot
  // endpoints address, so it can be stored directly as the conversation key.
  // Note: with the inbox's "Lock to single conversation" enabled Chatwoot
  // returns the contact's existing conversation instead of a new one — that
  // setting must stay OFF for the bridge.
  async createConversation(contactSourceId: string, customAttributes?: Record<string, unknown>): Promise<number> {
    const data = await this.json<{ id?: number }>(
      `${this.clientBase()}/contacts/${encodeURIComponent(contactSourceId)}/conversations`,
      "POST",
      {},
      customAttributes ? { custom_attributes: customAttributes } : {},
      "conversation create"
    );
    if (data.id == null) throw new ChatwootHttpError(500, "Chatwoot conversation create: missing id in response");
    return data.id;
  }

  // Posts as the contact (message_type incoming, sender = contact). The Client
  // API accepts no content_attributes, so incoming messages carry no bridge
  // stamp — loop safety for them rests on the webhook handler relaying only
  // outgoing messages.
  async createContactMessage(
    contactSourceId: string,
    conversationDisplayId: number,
    content: string,
    files: AttachmentFile[] = []
  ): Promise<void> {
    const url = `${this.clientBase()}/contacts/${encodeURIComponent(contactSourceId)}/conversations/${conversationDisplayId}/messages`;
    if (files.length === 0) {
      await this.json(url, "POST", {}, { content }, "contact message");
      return;
    }
    const response = await fetch(url, {
      method: "POST",
      body: this.buildForm({ content }, files),
      signal: AbortSignal.timeout(ChatwootClient.REQUEST_TIMEOUT_MS * 2),
    });
    await this.parse(response, "contact message");
  }

  // ---- Agent Bot API (agent side; conversation addressed by display_id) ----

  async createBotMessage(
    conversationDisplayId: number,
    input: {
      content: string;
      private?: boolean;
      contentAttributes?: Record<string, unknown>;
    },
    files: AttachmentFile[] = []
  ): Promise<void> {
    const url = `${this.botBase()}/conversations/${conversationDisplayId}/messages`;
    if (files.length === 0) {
      await this.json(
        url,
        "POST",
        this.botHeaders(),
        {
          content: input.content,
          message_type: "outgoing",
          ...(input.private ? { private: true } : {}),
          ...(input.contentAttributes ? { content_attributes: input.contentAttributes } : {}),
        },
        "bot message"
      );
      return;
    }
    // Multipart: content_attributes goes as a JSON string field (the message
    // builder parses string values).
    const fields: Record<string, string> = { content: input.content, message_type: "outgoing" };
    if (input.private) fields.private = "true";
    if (input.contentAttributes) fields.content_attributes = JSON.stringify(input.contentAttributes);
    const response = await fetch(url, {
      method: "POST",
      headers: this.botHeaders(),
      body: this.buildForm(fields, files),
      signal: AbortSignal.timeout(ChatwootClient.REQUEST_TIMEOUT_MS * 2),
    });
    await this.parse(response, "bot message");
  }

  async getLabels(conversationDisplayId: number): Promise<string[]> {
    const data = await this.json<{ payload?: string[] }>(
      `${this.botBase()}/conversations/${conversationDisplayId}/labels`,
      "GET",
      this.botHeaders(),
      undefined,
      "labels"
    );
    return data.payload ?? [];
  }

  // Chatwoot's label create replaces the conversation's full label list.
  async setLabels(conversationDisplayId: number, labels: string[]): Promise<void> {
    await this.json(
      `${this.botBase()}/conversations/${conversationDisplayId}/labels`,
      "POST",
      this.botHeaders(),
      { labels },
      "labels"
    );
  }

  // Explicit target status (open | resolved | pending | snoozed).
  async setStatus(conversationDisplayId: number, status: "open" | "resolved"): Promise<void> {
    await this.json(
      `${this.botBase()}/conversations/${conversationDisplayId}/toggle_status`,
      "POST",
      this.botHeaders(),
      { status },
      "toggle_status"
    );
  }

  async setPriority(conversationDisplayId: number, priority: ChatwootPriority | null): Promise<void> {
    await this.json(
      `${this.botBase()}/conversations/${conversationDisplayId}/toggle_priority`,
      "POST",
      this.botHeaders(),
      { priority },
      "toggle_priority"
    );
  }

  async setConversationCustomAttributes(conversationDisplayId: number, attributes: Record<string, unknown>): Promise<void> {
    await this.json(
      `${this.botBase()}/conversations/${conversationDisplayId}/custom_attributes`,
      "POST",
      this.botHeaders(),
      { custom_attributes: attributes },
      "custom_attributes"
    );
  }
}
