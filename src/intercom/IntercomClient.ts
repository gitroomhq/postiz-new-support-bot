import { SettingsStore } from "../config/SettingsStore";
import { bodyHash } from "./renderDiscordMarkdown";
import {
  IntercomAdmin,
  IntercomSweepConversation,
  IntercomSweepTicket,
  IntercomTicketState,
  IntercomTicketType,
  IntercomWebhookPart,
} from "./types";

// Thrown for non-2xx responses so the outbox scheduler can classify transient
// (retry) vs permanent (dead-letter) failures by HTTP status.
export class IntercomHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "IntercomHttpError";
  }
}

const API_VERSION = "2.15";

// Single-credential client: one access token (Bearer) for everything, pinned
// to a fixed API version. Contact-authored posts use the reply endpoint's
// `type:"user"` variant; admin-side actions carry an explicit admin_id (the
// author resolution — Operator first, configured admin fallback — lives in the
// outbox scheduler, not here).
//
// Settings come from SettingsStore (edited live via /config), so every call
// re-reads them and changes apply without a restart. No multipart anywhere:
// attachments are passed by URL only.
export class IntercomClient {
  constructor(private settingsStore: SettingsStore) {}

  private baseUrl(): string {
    switch (this.settingsStore.intercomRegion()) {
      case "eu":
        return "https://api.eu.intercom.io";
      case "au":
        return "https://api.au.intercom.io";
      default:
        return "https://api.intercom.io";
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.settingsStore.intercomAccessToken() ?? ""}`,
      "Intercom-Version": API_VERSION,
      Accept: "application/json",
    };
  }

  // Every call gets a hard timeout: a single hung request must never freeze the
  // outbox drainer (its overlap guard would otherwise block all future ticks).
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private async parse<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const errors = (error as { errors?: Array<{ message?: string }> }).errors;
      const detail =
        errors?.map((e) => e.message).filter(Boolean).join("; ") ||
        (error as { message?: string }).message ||
        response.statusText;
      // Intercom rate limiting: no documented Retry-After; derive the wait from
      // X-RateLimit-Reset (unix seconds) when present.
      let retryAfterSeconds: number | undefined;
      const retryAfter = parseInt(response.headers.get("retry-after") ?? "", 10);
      if (Number.isFinite(retryAfter)) {
        retryAfterSeconds = retryAfter;
      } else if (response.status === 429) {
        const reset = parseInt(response.headers.get("x-ratelimit-reset") ?? "", 10);
        if (Number.isFinite(reset)) {
          retryAfterSeconds = Math.max(1, reset - Math.floor(Date.now() / 1000));
        }
      }
      throw new IntercomHttpError(response.status, `Intercom ${what} ${response.status}: ${detail}`, retryAfterSeconds);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async json<T>(path: string, method: string, body: unknown, what: string): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(IntercomClient.REQUEST_TIMEOUT_MS),
    });
    return this.parse<T>(response, what);
  }

  // ---- Identity ----

  async getMe(): Promise<{ id: string; name?: string | null; email?: string | null; region?: string | null }> {
    const data = await this.json<{ id?: string | number; name?: string; email?: string; app?: { region?: string } }>(
      "/me",
      "GET",
      undefined,
      "me"
    );
    if (data.id == null) throw new IntercomHttpError(500, "Intercom me: missing id in response");
    return { id: String(data.id), name: data.name ?? null, email: data.email ?? null, region: data.app?.region ?? null };
  }

  async listAdmins(): Promise<IntercomAdmin[]> {
    // display_avatar=true: without it the endpoint omits avatars entirely
    // (defaults to false); the avatar arrives as a plain URL string here.
    const data = await this.json<{
      admins?: Array<{ id?: string | number; name?: string; email?: string; avatar?: { image_url?: string | null } | string | null }>;
    }>("/admins?display_avatar=true", "GET", undefined, "admins");
    return (data.admins ?? [])
      .filter((a) => a.id != null)
      .map((a) => ({
        id: String(a.id),
        name: a.name ?? null,
        email: a.email ?? null,
        avatarUrl: typeof a.avatar === "string" ? a.avatar : a.avatar?.image_url ?? null,
      }));
  }

  async listTeams(): Promise<Array<{ id: string; name: string }>> {
    const data = await this.json<{ teams?: Array<{ id?: string | number; name?: string }> }>(
      "/teams",
      "GET",
      undefined,
      "teams"
    );
    return (data.teams ?? [])
      .filter((t) => t.id != null)
      .map((t) => ({ id: String(t.id), name: t.name ?? `Team ${t.id}` }));
  }

  private teamNameCache: { fetchedAt: number; byId: Map<string, string> } | null = null;

  // Team id → name via one cached /teams fetch (~5 min TTL, so a team created
  // or renamed mid-window resolves late). Never throws — team names only
  // decorate reminder notes and must not fail them.
  async getTeamNameCached(teamId: string): Promise<string | null> {
    const TTL_MS = 5 * 60_000;
    try {
      if (!this.teamNameCache || Date.now() - this.teamNameCache.fetchedAt >= TTL_MS) {
        const teams = await this.listTeams();
        this.teamNameCache = { fetchedAt: Date.now(), byId: new Map(teams.map((t) => [t.id, t.name])) };
      }
      return this.teamNameCache.byId.get(teamId) ?? null;
    } catch {
      return this.teamNameCache?.byId.get(teamId) ?? null;
    }
  }

  // ---- Contacts ----

  async findContactByExternalId(externalId: string): Promise<{ id: string } | null> {
    try {
      const data = await this.json<{ id?: string | number }>(
        `/contacts/find_by_external_id/${encodeURIComponent(externalId)}`,
        "GET",
        undefined,
        "contact find"
      );
      return data.id != null ? { id: String(data.id) } : null;
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 404) return null;
      throw e;
    }
  }

  // Fallback lookup for create-conflicts (find_by_external_id should normally hit).
  async searchContactByExternalId(externalId: string): Promise<{ id: string } | null> {
    const data = await this.json<{ data?: Array<{ id?: string | number }> }>(
      "/contacts/search",
      "POST",
      { query: { field: "external_id", operator: "=", value: externalId } },
      "contact search"
    );
    const hit = data.data?.[0];
    return hit?.id != null ? { id: String(hit.id) } : null;
  }

  // role "user" + external_id, deliberately NO email — the customer lives in
  // Discord and Intercom must never gain an email channel to them (delivery is
  // the webhook → Discord relay).
  async createContact(input: {
    externalId: string;
    name: string;
    customAttributes?: Record<string, unknown>;
    avatarUrl?: string;
  }): Promise<{ id: string }> {
    const data = await this.json<{ id?: string | number }>(
      "/contacts",
      "POST",
      {
        role: "user",
        external_id: input.externalId,
        name: input.name,
        ...(input.avatarUrl ? { avatar: input.avatarUrl } : {}),
        ...(input.customAttributes && Object.keys(input.customAttributes).length > 0
          ? { custom_attributes: input.customAttributes }
          : {}),
      },
      "contact create"
    );
    if (data.id == null) throw new IntercomHttpError(500, "Intercom contact create: missing id in response");
    return { id: String(data.id) };
  }

  // Intercom's "delete contact" only ARCHIVES; find/search are blind to
  // archived records, so a re-created contact 409s ("...archived contact...
  // id=X"). Reactivating by id lets the contact author conversations again.
  // Idempotent for retries — unarchiving a live contact returns it, not an error.
  async unarchiveContact(contactId: string): Promise<void> {
    await this.json(`/contacts/${encodeURIComponent(contactId)}/unarchive`, "POST", undefined, "contact unarchive");
  }

  // Existence/archived probe for the 404 self-heal: a merged or hard-deleted
  // contact must be re-resolved, an archived one merely unarchived.
  async getContact(contactId: string): Promise<{ id: string; archived: boolean } | null> {
    try {
      const data = await this.json<{ id?: string | number; archived?: boolean }>(
        `/contacts/${encodeURIComponent(contactId)}`,
        "GET",
        undefined,
        "contact get"
      );
      return data.id != null ? { id: String(data.id), archived: data.archived === true } : null;
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 404) return null;
      throw e;
    }
  }

  // Refreshes display identity on an existing contact (Discord names drift;
  // avatar was never set at create time). Never adds an email.
  async updateContact(contactId: string, input: { name?: string | null; avatarUrl?: string | null }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.name) body.name = input.name;
    if (input.avatarUrl) body.avatar = input.avatarUrl;
    if (Object.keys(body).length === 0) return;
    await this.json(`/contacts/${encodeURIComponent(contactId)}`, "PUT", body, "contact update");
  }

  // Contact custom attributes must be predefined in the workspace; this creates
  // the definition (idempotence handled by the caller treating "exists" as ok).
  async createContactAttribute(name: string, description: string): Promise<void> {
    await this.json("/data_attributes", "POST", { name, description, model: "contact", data_type: "string" }, "data attribute create");
  }

  // Email lookup for the dispute-evidence context: a Stripe customer's email →
  // Intercom contact ids (an email can map to lead + user duplicates).
  async searchContactIdsByEmail(email: string): Promise<string[]> {
    const data = await this.json<{ data?: Array<{ id?: string | number }> }>(
      "/contacts/search",
      "POST",
      { query: { field: "email", operator: "=", value: email }, pagination: { per_page: 10 } },
      "contact search by email"
    );
    return (data.data ?? []).map((c) => (c.id != null ? String(c.id) : null)).filter((id): id is string => !!id);
  }

  // ---- Conversations ----

  // Newest conversations a contact participates in — the dispute-evidence
  // context pulls their transcripts as customer_communication material.
  async searchConversationsByContact(
    contactId: string,
    limit = 5
  ): Promise<Array<{ id: string; createdAt: Date | null }>> {
    const data = await this.json<{
      conversations?: Array<{ id?: string | number; created_at?: number }>;
    }>(
      "/conversations/search",
      "POST",
      {
        query: { field: "contact_ids", operator: "=", value: contactId },
        pagination: { per_page: Math.min(limit, 25) },
      },
      "conversation search"
    );
    return (data.conversations ?? [])
      .filter((c) => c.id != null)
      .map((c) => ({ id: String(c.id), createdAt: c.created_at ? new Date(c.created_at * 1000) : null }))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  // Full conversation rendered as plaintext (display_as=plaintext strips
  // Intercom's HTML bodies): the opening message plus every human-authored
  // comment, in order. Notes and bot parts are skipped — evidence needs the
  // actual customer/agent exchange.
  async getConversationTranscript(
    conversationId: string
  ): Promise<Array<{ author: string; at: Date | null; text: string }>> {
    const data = await this.json<{
      created_at?: number;
      source?: { body?: string | null; author?: { type?: string; name?: string | null } };
      conversation_parts?: {
        conversation_parts?: Array<{
          part_type?: string;
          body?: string | null;
          created_at?: number;
          author?: { type?: string; name?: string | null };
        }>;
      };
    }>(`/conversations/${encodeURIComponent(conversationId)}?display_as=plaintext`, "GET", undefined, "conversation get");

    const authorLabel = (author?: { type?: string; name?: string | null }) =>
      author?.type === "admin" || author?.type === "team" ? `agent${author.name ? ` ${author.name}` : ""}` : "customer";
    const out: Array<{ author: string; at: Date | null; text: string }> = [];
    if (data.source?.body?.trim()) {
      out.push({
        author: authorLabel(data.source.author),
        at: data.created_at ? new Date(data.created_at * 1000) : null,
        text: data.source.body.trim(),
      });
    }
    for (const part of data.conversation_parts?.conversation_parts ?? []) {
      if (part.part_type !== "comment" || !part.body?.trim()) continue;
      if (part.author?.type === "bot") continue;
      out.push({
        author: authorLabel(part.author),
        at: part.created_at ? new Date(part.created_at * 1000) : null,
        text: part.body.trim(),
      });
    }
    return out;
  }

  // The ticket a conversation was converted into (null when never converted).
  // Used by attachTicket to adopt an existing conversion instead of degrading
  // to a standalone ticket when convert 4xxes with "already converted".
  async getConversationTicketId(conversationId: string): Promise<string | null> {
    const data = await this.json<{ ticket?: { id?: string | number } | null }>(
      `/conversations/${encodeURIComponent(conversationId)}`,
      "GET",
      undefined,
      "conversation get"
    );
    return data.ticket?.id != null ? String(data.ticket.id) : null;
  }

  // Raw conversation parts (HTML bodies, author ids, attachments) newer than
  // `sinceUnixSeconds` — the none→bi gap heal feeds these through the normal
  // webhook relay path.
  async getConversationPartsSince(
    conversationId: string,
    sinceUnixSeconds: number
  ): Promise<IntercomWebhookPart[]> {
    const data = await this.json<{
      conversation_parts?: { conversation_parts?: IntercomWebhookPart[] };
    }>(`/conversations/${encodeURIComponent(conversationId)}`, "GET", undefined, "conversation get");
    return (data.conversation_parts?.conversation_parts ?? []).filter(
      (p) => (p.created_at ?? 0) > sinceUnixSeconds
    );
  }

  // Contact-initiated conversation. The response is a Message object; the
  // conversation id lives in its conversation_id field.
  async createConversation(contactId: string, body: string, createdAtIso?: string): Promise<string> {
    const data = await this.json<{ conversation_id?: string | number }>(
      "/conversations",
      "POST",
      {
        from: { type: "user", id: contactId },
        body,
        ...(createdAtIso ? { created_at: toUnix(createdAtIso) } : {}),
      },
      "conversation create"
    );
    if (data.conversation_id == null) {
      throw new IntercomHttpError(500, "Intercom conversation create: missing conversation_id in response");
    }
    return String(data.conversation_id);
  }

  async conversationExists(conversationId: string): Promise<boolean> {
    try {
      await this.json(`/conversations/${encodeURIComponent(conversationId)}`, "GET", undefined, "conversation get");
      return true;
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 404) return false;
      throw e;
    }
  }

  // Posts as the contact (true attribution, no name prefix). Loop safety for
  // these rests on the webhook handler only relaying admin/bot-authored parts.
  // Returns the created part id (same body-hash resolution as replyAsAdmin) so
  // the message map can power later redaction; null when unresolvable.
  async replyAsContact(
    conversationId: string,
    input: { intercomUserId: string; body: string; createdAtIso?: string; attachmentUrls?: string[] }
  ): Promise<{ partId: string | null }> {
    const data = await this.json<{
      conversation_parts?: {
        conversation_parts?: Array<{ id?: string | number; body?: string | null; author?: { type?: string } }>;
      };
    }>(
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      "POST",
      {
        message_type: "comment",
        type: "user",
        intercom_user_id: input.intercomUserId,
        body: input.body,
        ...(input.createdAtIso ? { created_at: toUnix(input.createdAtIso) } : {}),
        ...(input.attachmentUrls?.length ? { attachment_urls: input.attachmentUrls } : {}),
      },
      "contact reply"
    );
    const parts = data.conversation_parts?.conversation_parts ?? [];
    const sentHash = bodyHash(input.body);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      const authorType = part.author?.type;
      if (part.id != null && (authorType === "user" || authorType === "lead") && bodyHash(part.body ?? "") === sentHash) {
        return { partId: String(part.id) };
      }
    }
    return { partId: null };
  }

  // Redacts (deletes) a conversation part — Intercom replaces the content with
  // a native "This message was deleted" tombstone. 404 = part/conversation
  // gone, 403 = token lacks the redact permission; both are the caller's cue
  // to fall back to the appended-note mirror.
  async redactConversationPart(conversationId: string, conversationPartId: string): Promise<void> {
    await this.json(
      "/conversations/redact",
      "POST",
      {
        type: "conversation_part",
        conversation_id: conversationId,
        conversation_part_id: conversationPartId,
      },
      "conversation part redact"
    );
  }

  // Admin comment or note. Returns the id of the just-created part so the
  // caller can record it in the echo ledger. Resolution: newest part authored
  // by this admin whose normalized body matches what we sent (per-ticket FIFO
  // means the bridge never has two in-flight posts per conversation, so
  // ambiguity only arises with a same-admin human — the body match resolves
  // it); falls back to the newest same-author part.
  async replyAsAdmin(
    conversationId: string,
    input: { adminId: string; body: string; note?: boolean; createdAtIso?: string; attachmentUrls?: string[] }
  ): Promise<{ partId: string | null }> {
    const data = await this.json<{
      conversation_parts?: {
        conversation_parts?: Array<{ id?: string | number; body?: string | null; author?: { id?: string | number } }>;
      };
    }>(
      `/conversations/${encodeURIComponent(conversationId)}/reply`,
      "POST",
      {
        message_type: input.note ? "note" : "comment",
        type: "admin",
        admin_id: input.adminId,
        body: input.body,
        ...(input.createdAtIso ? { created_at: toUnix(input.createdAtIso) } : {}),
        ...(input.attachmentUrls?.length ? { attachment_urls: input.attachmentUrls } : {}),
      },
      "admin reply"
    );
    const parts = data.conversation_parts?.conversation_parts ?? [];
    const sentHash = bodyHash(input.body);
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.id != null && String(part.author?.id ?? "") === input.adminId && bodyHash(part.body ?? "") === sentHash) {
        return { partId: String(part.id) };
      }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.id != null && String(part.author?.id ?? "") === input.adminId) {
        return { partId: String(part.id) };
      }
    }
    const last = parts[parts.length - 1];
    return { partId: last?.id != null ? String(last.id) : null };
  }

  // Find-or-create by name (tag names are case-insensitive unique per workspace).
  async findOrCreateTag(name: string): Promise<{ id: string }> {
    const data = await this.json<{ id?: string | number }>("/tags", "POST", { name }, "tag create");
    if (data.id == null) throw new IntercomHttpError(500, "Intercom tag create: missing id in response");
    return { id: String(data.id) };
  }

  async tagConversation(conversationId: string, tagId: string, adminId: string): Promise<void> {
    await this.json(
      `/conversations/${encodeURIComponent(conversationId)}/tags`,
      "POST",
      { id: tagId, admin_id: adminId },
      "conversation tag"
    );
  }

  // Conversation custom attributes must be predefined in Intercom's UI
  // (Settings → Data → Conversations) — the data_attributes API only covers
  // contact/company models, so writes 4xx until the definitions exist.
  async setConversationAttributes(conversationId: string, attributes: Record<string, unknown>): Promise<void> {
    await this.json(
      `/conversations/${encodeURIComponent(conversationId)}`,
      "PUT",
      { custom_attributes: attributes },
      "conversation update"
    );
  }

  // Manage endpoint: route the conversation to a team inbox. Posting an
  // assignment part that re-routes to the team it is already on is rejected
  // with 422 "already assigned to the specified assignee" — but that IS the
  // desired end state (idempotent re-run of the creation-time assignment), so
  // it's swallowed as success rather than surfaced as a failure.
  async assignConversationToTeam(conversationId: string, teamId: string, adminId: string): Promise<void> {
    try {
      await this.json(
        `/conversations/${encodeURIComponent(conversationId)}/parts`,
        "POST",
        { message_type: "assignment", type: "team", admin_id: adminId, assignee_id: teamId },
        "conversation assignment"
      );
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 422 && /already assigned/i.test(e.message)) return;
      throw e;
    }
  }

  // Manage endpoint: close/open the conversation (admin-authored part).
  async setConversationOpen(conversationId: string, open: boolean, adminId: string): Promise<void> {
    await this.json(
      `/conversations/${encodeURIComponent(conversationId)}/parts`,
      "POST",
      open
        ? { message_type: "open", admin_id: adminId }
        : { message_type: "close", type: "admin", admin_id: adminId },
      open ? "conversation open" : "conversation close"
    );
  }

  // ---- Tickets ----

  // Convert is the ONLY way to get a conversation-bound customer ticket
  // (create-with-conversation_to_link_id is invalid for customer types).
  async convertToTicket(
    conversationId: string,
    ticketTypeId: string,
    attributes?: Record<string, unknown>
  ): Promise<{ ticketId: string }> {
    const data = await this.json<{ id?: string | number }>(
      `/conversations/${encodeURIComponent(conversationId)}/convert`,
      "POST",
      {
        ticket_type_id: ticketTypeId,
        ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
      },
      "convert to ticket"
    );
    if (data.id == null) throw new IntercomHttpError(500, "Intercom convert: missing ticket id in response");
    return { ticketId: String(data.id) };
  }

  // Fallback when convert is rejected. conversationToLinkId is valid for
  // back-office/tracker ticket types only (conversation↔customer-ticket links
  // can only be made by convert) — callers retry without it on rejection, and
  // the link then only exists in our DB, cross-referenced via notes.
  async createTicket(input: {
    ticketTypeId: string;
    contactId: string;
    attributes?: Record<string, unknown>;
    createdAtIso?: string;
    conversationToLinkId?: string;
  }): Promise<{ ticketId: string }> {
    const data = await this.json<{ id?: string | number }>(
      "/tickets",
      "POST",
      {
        ticket_type_id: input.ticketTypeId,
        contacts: [{ id: input.contactId }],
        ...(input.attributes && Object.keys(input.attributes).length > 0 ? { ticket_attributes: input.attributes } : {}),
        ...(input.createdAtIso ? { created_at: toUnix(input.createdAtIso) } : {}),
        ...(input.conversationToLinkId ? { conversation_to_link_id: input.conversationToLinkId } : {}),
        skip_notifications: true,
      },
      "ticket create"
    );
    if (data.id == null) throw new IntercomHttpError(500, "Intercom ticket create: missing id in response");
    return { ticketId: String(data.id) };
  }

  // Custom state transitions, attribute writes and assignment. admin_id is
  // numeric in this endpoint's schema ("needed for workflows"); assigneeId
  // accepts an admin OR team id.
  async updateTicket(
    ticketId: string,
    input: {
      stateId?: string;
      attributes?: Record<string, unknown>;
      adminId?: string;
      assigneeId?: string;
      // Ticket open/closed flag — separate from the state; false fully closes
      // the ticket (state alone leaves it listed as an open ticket).
      open?: boolean;
    }
  ): Promise<void> {
    const adminIdNum = input.adminId != null ? Number(input.adminId) : NaN;
    await this.json(
      `/tickets/${encodeURIComponent(ticketId)}`,
      "PUT",
      {
        ...(input.stateId ? { ticket_state_id: input.stateId } : {}),
        ...(input.attributes && Object.keys(input.attributes).length > 0 ? { ticket_attributes: input.attributes } : {}),
        ...(Number.isFinite(adminIdNum) ? { admin_id: adminIdNum } : {}),
        ...(input.assigneeId ? { assignee_id: input.assigneeId } : {}),
        ...(input.open !== undefined ? { open: input.open } : {}),
        skip_notifications: true,
      },
      "ticket update"
    );
  }

  async ticketExists(ticketId: string): Promise<boolean> {
    try {
      await this.json(`/tickets/${encodeURIComponent(ticketId)}`, "GET", undefined, "ticket get");
      return true;
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 404) return false;
      throw e;
    }
  }

  // ---- Inactivity sweeper reads/writes (native/unbridged objects) ----

  // Fresh idle-detection fields for ONE conversation — the sweeper's pre-close
  // re-check (its page snapshot can be minutes stale by the time a close
  // fires). Null on 404 (conversation deleted meanwhile).
  async getConversationIdleStats(conversationId: string): Promise<{
    state: string;
    createdAt: Date | null;
    lastContactReplyAt: Date | null;
    lastAdminReplyAt: Date | null;
    teamAssigneeId: string | null;
  } | null> {
    try {
      const data = await this.json<{
        state?: string;
        created_at?: number;
        team_assignee_id?: number | string | null;
        statistics?: {
          last_contact_reply_at?: number | null;
          last_admin_reply_at?: number | null;
        } | null;
      }>(`/conversations/${encodeURIComponent(conversationId)}`, "GET", undefined, "conversation get (idle stats)");
      return {
        state: data.state ?? "open",
        createdAt: data.created_at ? new Date(data.created_at * 1000) : null,
        lastContactReplyAt: data.statistics?.last_contact_reply_at
          ? new Date(data.statistics.last_contact_reply_at * 1000)
          : null,
        lastAdminReplyAt: data.statistics?.last_admin_reply_at
          ? new Date(data.statistics.last_admin_reply_at * 1000)
          : null,
        teamAssigneeId: data.team_assignee_id != null ? String(data.team_assignee_id) : null,
      };
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status === 404) return null;
      throw e;
    }
  }

  // One page of open conversations with the idle-detection fields. The sweeper
  // pages through the whole workspace; per_page 150 is the search maximum.
  async searchOpenConversations(startingAfter?: string | null): Promise<{
    items: IntercomSweepConversation[];
    nextStartingAfter: string | null;
  }> {
    const data = await this.json<{
      conversations?: Array<{
        id?: string | number;
        state?: string;
        created_at?: number;
        snoozed_until?: number | null;
        team_assignee_id?: number | string | null;
        statistics?: {
          last_contact_reply_at?: number | null;
          last_admin_reply_at?: number | null;
        } | null;
      }>;
      pages?: { next?: { starting_after?: string } | null };
    }>(
      "/conversations/search",
      "POST",
      {
        query: { field: "open", operator: "=", value: true },
        pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      },
      "conversation search (inactivity sweep)"
    );
    return {
      items: (data.conversations ?? [])
        .filter((c) => c.id != null)
        .map((c) => ({
          id: String(c.id),
          state: c.state ?? "open",
          createdAt: c.created_at ? new Date(c.created_at * 1000) : null,
          snoozedUntil: c.snoozed_until ? new Date(c.snoozed_until * 1000) : null,
          lastContactReplyAt: c.statistics?.last_contact_reply_at
            ? new Date(c.statistics.last_contact_reply_at * 1000)
            : null,
          lastAdminReplyAt: c.statistics?.last_admin_reply_at
            ? new Date(c.statistics.last_admin_reply_at * 1000)
            : null,
          teamAssigneeId: c.team_assignee_id != null ? String(c.team_assignee_id) : null,
        })),
      nextStartingAfter: data.pages?.next?.starting_after ?? null,
    };
  }

  // One page of open tickets (native back-office/tracker work items included).
  async searchOpenTickets(startingAfter?: string | null): Promise<{
    items: IntercomSweepTicket[];
    nextStartingAfter: string | null;
  }> {
    const data = await this.json<{
      tickets?: Array<{
        id?: string | number;
        open?: boolean;
        updated_at?: number;
        created_at?: number;
        category?: string;
        team_assignee_id?: number | string | null;
      }>;
      pages?: { next?: { starting_after?: string } | null };
    }>(
      "/tickets/search",
      "POST",
      {
        query: { field: "open", operator: "=", value: true },
        pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      },
      "ticket search (inactivity sweep)"
    );
    return {
      items: (data.tickets ?? [])
        .filter((t) => t.id != null)
        .map((t) => ({
          id: String(t.id),
          category: t.category ?? null,
          updatedAt: t.updated_at ? new Date(t.updated_at * 1000) : null,
          createdAt: t.created_at ? new Date(t.created_at * 1000) : null,
          teamAssigneeId: t.team_assignee_id != null ? String(t.team_assignee_id) : null,
        })),
      nextStartingAfter: data.pages?.next?.starting_after ?? null,
    };
  }

  // Admin note on a ticket (the sweeper's agent-idle nag for native tickets —
  // notes never notify the contact).
  async replyTicketAsAdmin(ticketId: string, input: { adminId: string; body: string; note?: boolean }): Promise<void> {
    await this.json(
      `/tickets/${encodeURIComponent(ticketId)}/reply`,
      "POST",
      {
        message_type: input.note === false ? "comment" : "note",
        type: "admin",
        admin_id: input.adminId,
        body: input.body,
      },
      "ticket admin reply"
    );
  }

  // ---- Deletion (the /config "Wipe Intercom data" button) ----
  // Conversations and tickets are hard-deleted — they aren't keyed by
  // external_id, so they recreate cleanly on the next backfill. Contacts are
  // ARCHIVED, not deleted: DELETE /contacts is a *permanent* delete with a
  // 7-day grace during which the external_id can't be reused, which would block
  // the very next backfill. Archiving is reversible (see unarchiveContact), so a
  // re-backfill reuses the same contact via the create-409 → unarchive path.

  async deleteConversation(conversationId: string): Promise<void> {
    await this.json(`/conversations/${encodeURIComponent(conversationId)}`, "DELETE", undefined, "conversation delete");
  }

  async deleteTicket(ticketId: string): Promise<void> {
    await this.json(`/tickets/${encodeURIComponent(ticketId)}`, "DELETE", undefined, "ticket delete");
  }

  async archiveContact(contactId: string): Promise<void> {
    await this.json(`/contacts/${encodeURIComponent(contactId)}/archive`, "POST", undefined, "contact archive");
  }

  // ---- Workspace metadata (/config pickers + attribute bootstrap) ----

  async listTicketTypes(): Promise<IntercomTicketType[]> {
    const data = await this.json<{
      data?: Array<{
        id?: string | number;
        name?: string;
        category?: string;
        ticket_type_attributes?: { data?: Array<{ name?: string }> } | Array<{ name?: string }>;
      }>;
    }>("/ticket_types", "GET", undefined, "ticket types");
    return (data.data ?? [])
      .filter((t) => t.id != null)
      .map((t) => {
        const rawAttrs = t.ticket_type_attributes;
        const attrList = Array.isArray(rawAttrs) ? rawAttrs : rawAttrs?.data ?? [];
        return {
          id: String(t.id),
          name: t.name ?? `Ticket type ${t.id}`,
          category: t.category ?? null,
          attributeNames: attrList.map((a) => a.name ?? "").filter(Boolean),
        };
      });
  }

  async listTicketStates(): Promise<IntercomTicketState[]> {
    const data = await this.json<{
      data?: Array<{ id?: string | number; category?: string; internal_label?: string; external_label?: string; archived?: boolean }>;
    }>("/ticket_states", "GET", undefined, "ticket states");
    return (data.data ?? [])
      .filter((s) => s.id != null)
      .map((s) => ({
        id: String(s.id),
        category: s.category ?? null,
        internalLabel: s.internal_label ?? s.external_label ?? `State ${s.id}`,
        archived: s.archived === true,
      }));
  }

  async createTicketTypeAttribute(ticketTypeId: string, name: string, description: string): Promise<void> {
    await this.json(
      `/ticket_types/${encodeURIComponent(ticketTypeId)}/attributes`,
      "POST",
      { name, description, data_type: "string", visible_on_create: false },
      "ticket type attribute create"
    );
  }
}

function toUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
