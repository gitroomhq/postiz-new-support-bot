import { ChatwootLink, ChatwootOutboxEvent } from "../generated/prisma/client";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { AttachmentFile, ChatwootClient, ChatwootHttpError } from "./ChatwootClient";
import { ChatwootStore } from "./ChatwootStore";
import { ChatwootSyncService } from "./ChatwootSyncService";
import {
  BridgeContentAttributes,
  CsatPayload,
  EnsureConversationPayload,
  MessagePayload,
  NotePayload,
  PriorityPayload,
  StatusPayload,
} from "./types";

const CHECK_INTERVAL_MS = 5 * 1000;
const BATCH_LIMIT = 25;
const CALL_SPACING_MS = 300;
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// Chatwoot's default attachment cap is 40 MB; stay under it.
const MAX_ATTACHMENT_BYTES = 39 * 1024 * 1024;

// Drains the chatwoot_outbox: per tick it takes the head event of each ticket
// queue (per-ticket FIFO — a failing event blocks only its own ticket) and
// executes the corresponding Chatwoot API calls. All transient failures retry
// with exponential backoff; permanent ones dead-letter with an audit warning.
export class ChatwootOutboxScheduler {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private client: ChatwootClient,
    private store: ChatwootStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private sync: ChatwootSyncService,
    private audit: AuditLogger
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Chatwoot outbox scheduler error:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // Mode "none" or missing connection: leave events queued; draining resumes
    // as soon as the bridge is re-enabled in /config. Overlap guard because a
    // slow batch (attachment downloads) can outlast the interval.
    if (this.draining) return;
    if (this.settingsStore.chatwootMode() === "none" || !this.settingsStore.chatwootConfigured()) return;

    this.draining = true;
    try {
      const due = await this.store.listDueHeads(BATCH_LIMIT);
      for (const event of due) {
        await this.processEvent(event);
        await sleep(CALL_SPACING_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: ChatwootOutboxEvent): Promise<void> {
    try {
      await this.execute(event);
      await this.store.markSuccess(event.id);
    } catch (e) {
      await this.handleFailure(event, e);
    }
  }

  private async handleFailure(event: ChatwootOutboxEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ChatwootHttpError && error.status === 404 && event.type !== "ensure_conversation") {
      // The linked conversation was deleted in Chatwoot. Drop the stale link and
      // rebuild: a fresh ensure_conversation is enqueued (it gets a NEW seq, but
      // the current event stays head of this ticket's queue — so bump its
      // nextAttemptAt past the ensure's… simpler: re-enqueueing ensure first
      // wouldn't order before this event. Instead, self-heal inline: recreate
      // the conversation now, then retry this event on the next pass.
      const ticket = await this.ticketStore.getByThreadId(event.ticketThreadId);
      if (ticket) {
        await this.store.deleteLink(event.ticketThreadId);
        const payload = await this.sync.buildEnsurePayloadWithSession(ticket);
        try {
          await this.ensureConversation(event.ticketThreadId, payload);
        } catch (healError) {
          console.error(`Chatwoot 404 self-heal failed for ${event.ticketThreadId}:`, healError);
        }
        await this.retryOrDie(event, `404 — conversation recreated, retrying: ${message}`);
        return;
      }
    }

    const transient =
      !(error instanceof ChatwootHttpError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500;

    if (!transient) {
      await this.store.markDead(event.id, message);
      void this.audit.log({
        title: "🌉 Chatwoot push failed",
        severity: "warn",
        actor: "Chatwoot bridge",
        threadId: event.ticketThreadId,
        fields: [
          { name: "Event", value: event.type, inline: true },
          { name: "Error", value: message.slice(0, 1024), inline: false },
        ],
      });
      return;
    }

    const retryAfterMs =
      error instanceof ChatwootHttpError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : null;
    await this.retryOrDie(event, message, retryAfterMs);
  }

  private async retryOrDie(event: ChatwootOutboxEvent, message: string, retryAfterMs?: number | null): Promise<void> {
    const attempts = event.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markDead(event.id, message);
      void this.audit.log({
        title: "🌉 Chatwoot push dead-lettered",
        severity: "warn",
        actor: "Chatwoot bridge",
        threadId: event.ticketThreadId,
        fields: [
          { name: "Event", value: event.type, inline: true },
          { name: "Attempts", value: String(attempts), inline: true },
          { name: "Error", value: message.slice(0, 1024), inline: false },
        ],
      });
      return;
    }
    const backoff = retryAfterMs ?? Math.min(5000 * 2 ** attempts, MAX_BACKOFF_MS);
    await this.store.markRetry(event.id, attempts, new Date(Date.now() + backoff), message);
  }

  // ---- Executors ----

  private async execute(event: ChatwootOutboxEvent): Promise<void> {
    switch (event.type) {
      case "ensure_conversation":
        await this.ensureConversation(event.ticketThreadId, event.payload as unknown as EnsureConversationPayload);
        return;
      case "message":
        await this.executeMessage(event.ticketThreadId, event.payload as unknown as MessagePayload);
        return;
      case "note":
        await this.executeNote(event.ticketThreadId, event.payload as unknown as NotePayload);
        return;
      case "status":
        await this.executeStatus(event.ticketThreadId, event.payload as unknown as StatusPayload);
        return;
      case "priority":
        await this.executePriority(event.ticketThreadId, event.payload as unknown as PriorityPayload);
        return;
      case "csat":
        await this.executeCsat(event.ticketThreadId, event.payload as unknown as CsatPayload);
        return;
      default:
        throw new ChatwootHttpError(400, `Unknown outbox event type: ${event.type}`);
    }
  }

  private async ensureConversation(threadId: string, payload: EnsureConversationPayload): Promise<void> {
    const existing = await this.store.getLink(threadId);
    if (existing) return; // idempotent re-run (e.g. retried after a partial failure)

    const identifier = payload.customerId ?? `discord-thread:${threadId}`;
    const name = payload.customerDisplayName || `Discord user ${identifier}`;

    // Client API dedupes account-wide by identifier — create IS ensure.
    const contact = await this.client.ensureContact({
      identifier,
      name,
      customAttributes: {
        ...(payload.customerId ? { discord_user_id: payload.customerId } : {}),
        ...(payload.postizUserId ? { postiz_user_id: payload.postizUserId } : {}),
        ...(payload.stripeCustomerId ? { stripe_customer_id: payload.stripeCustomerId } : {}),
      },
    });

    const conversationId = await this.client.createConversation(contact.sourceId, {
      discord_thread_id: threadId,
      discord_status: payload.statusLabel,
      ...(payload.categoryLabel ? { discord_category: payload.categoryLabel } : {}),
      ...(payload.customerId ? { discord_user_id: payload.customerId } : {}),
    });
    await this.store.createLink(threadId, contact.contactId, contact.sourceId, conversationId);

    // Agent-side finishing via the bot token: labels, priority, explicit status
    // (client-created conversations start open — or pending when a bot is
    // attached to the inbox — so always set a deterministic state).
    const labels = [`status:${payload.statusSlug}`];
    if (payload.categoryLabel) labels.push(`category:${slugifyLabel(payload.categoryLabel)}`);
    await this.client.setLabels(conversationId, labels);
    if (payload.priority) await this.client.setPriority(conversationId, payload.priority);
    const target: "open" | "resolved" = payload.closed || payload.resolved ? "resolved" : "open";
    await this.client.setStatus(conversationId, target);
    await this.store.setLastSyncedStatus(threadId, target);
  }

  private async requireLink(threadId: string): Promise<ChatwootLink> {
    const link = await this.store.getLink(threadId);
    if (link) return link;
    // Defensive: an event slipped in without its ensure (shouldn't happen — the
    // sync service always enqueues ensure first). Rebuild and retry transiently.
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) throw new ChatwootHttpError(410, `No ticket for thread ${threadId}`);
    await this.ensureConversation(threadId, await this.sync.buildEnsurePayloadWithSession(ticket));
    const link2 = await this.store.getLink(threadId);
    if (!link2) throw new ChatwootHttpError(500, `Link creation failed for thread ${threadId}`);
    return link2;
  }

  private bridgeAttributes(extra?: { discordMessageId?: string; externalCreatedAtIso?: string }): BridgeContentAttributes {
    return {
      discord_bridge: true,
      ...(extra?.discordMessageId ? { discord_message_id: extra.discordMessageId } : {}),
      ...(extra?.externalCreatedAtIso ? { external_created_at: extra.externalCreatedAtIso } : {}),
    };
  }

  private async executeMessage(threadId: string, payload: MessagePayload): Promise<void> {
    const link = await this.requireLink(threadId);
    let content = payload.content;

    const files: AttachmentFile[] = [];
    for (const attachment of payload.attachments ?? []) {
      if (attachment.size > MAX_ATTACHMENT_BYTES) {
        content += `\n📎 Attachment not mirrored: ${attachment.filename} (too large)`;
        continue;
      }
      try {
        // Timeout so a hung CDN download can't freeze the drainer.
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        files.push({
          filename: attachment.filename,
          data: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get("content-type") ?? undefined,
        });
      } catch (e) {
        // Discord CDN URLs are signed and expire — old backfilled links may be dead.
        content += `\n📎 Attachment not mirrored: ${attachment.filename} (download failed)`;
      }
    }

    if (payload.direction === "incoming") {
      // Customer messages go through the Client API as the actual contact —
      // true attribution, no name prefix. (No content_attributes possible here;
      // loop safety: the webhook handler only ever relays outgoing messages.)
      await this.client.createContactMessage(link.contactSourceId, link.conversationId, content, files);
    } else {
      await this.client.createBotMessage(
        link.conversationId,
        { content, contentAttributes: this.bridgeAttributes(payload) },
        files
      );
    }
  }

  private async executeNote(threadId: string, payload: NotePayload): Promise<void> {
    const link = await this.requireLink(threadId);
    await this.client.createBotMessage(link.conversationId, {
      content: payload.content,
      private: true,
      contentAttributes: this.bridgeAttributes(payload),
    });
  }

  private async executeStatus(threadId: string, payload: StatusPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    const conversationId = link.conversationId;

    const existing = await this.client.getLabels(conversationId);
    const labels = existing.filter((l) => !l.startsWith("status:"));
    labels.push(`status:${payload.statusSlug}`);
    await this.client.setLabels(conversationId, labels);
    await this.client.setConversationCustomAttributes(conversationId, { discord_status: payload.statusLabel });

    // Conditional toggle guarded by lastSyncedStatus: bi-mode webhook-initiated
    // changes already updated Chatwoot, so the echo push becomes a no-op here.
    const target: "open" | "resolved" = payload.closed || payload.resolved ? "resolved" : "open";
    if (link.lastSyncedStatus !== target) {
      await this.client.setStatus(conversationId, target);
      await this.store.setLastSyncedStatus(threadId, target);
    }

    if (payload.note) {
      await this.client.createBotMessage(conversationId, {
        content: `Status: ${payload.fromLabel ?? "—"} → ${payload.statusLabel} — by ${payload.actorName}`,
        private: true,
        contentAttributes: this.bridgeAttributes(),
      });
    }
  }

  private async executePriority(threadId: string, payload: PriorityPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    await this.client.setPriority(link.conversationId, payload.priority);
    await this.client.setConversationCustomAttributes(link.conversationId, { discord_priority: payload.priorityLabel });
    if (payload.note) {
      await this.client.createBotMessage(link.conversationId, {
        content: `Priority: ${payload.fromLabel ?? "—"} → ${payload.priorityLabel} — by ${payload.actorName}`,
        private: true,
        contentAttributes: this.bridgeAttributes(),
      });
    }
  }

  private async executeCsat(threadId: string, payload: CsatPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    await this.client.setConversationCustomAttributes(link.conversationId, {
      discord_csat_score: payload.score,
      ...(payload.comment ? { discord_csat_comment: payload.comment } : {}),
    });
    await this.client.createBotMessage(link.conversationId, {
      content: `⭐ CSAT: ${payload.score}/5${payload.comment ? `\n${payload.comment}` : ""}`,
      private: true,
      contentAttributes: this.bridgeAttributes(),
    });
  }
}

function slugifyLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
