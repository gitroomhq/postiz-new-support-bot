import { IntercomLink, IntercomOutboxEvent } from "../generated/prisma/client";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomClient, IntercomHttpError } from "./IntercomClient";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService, externalIdFor, formatTimestamp } from "./IntercomSyncService";
import {
  CsatPayload,
  EnsurePayload,
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
// Echo-part rows only matter while a webhook for them can still arrive.
const ECHO_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ECHO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Intercom accepts at most 10 attachment URLs per message.
const MAX_ATTACHMENT_URLS = 10;

// Ticket attributes the bridge writes. Auto-created via the /config "Ensure
// attributes" action; executors degrade (skip the attribute) when missing.
export const TICKET_ATTR_PRIORITY = "Priority";
export const TICKET_ATTR_CSAT = "CSAT";
export const TICKET_ATTR_THREAD = "Discord Thread";
// "Came from Discord" markers on the conversation itself: a tag (find-or-create
// via API, works with zero setup) and an Origin attribute (definition is
// UI-managed, so it only lands once created in the workspace).
export const CONVERSATION_TAG = "Discord";
export const CONV_ATTR_ORIGIN = "Origin";

// Drains the intercom_outbox: per tick it takes the head event of each ticket
// queue (per-ticket FIFO — a failing event blocks only its own ticket) and
// executes the corresponding Intercom API calls. All transient failures retry
// with exponential backoff; permanent ones dead-letter with an audit warning.
export class IntercomOutboxScheduler {
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private lastEchoCleanupAt = 0;
  private contactAttrsEnsured = false;
  private discordTagId: string | null = null;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Intercom outbox scheduler error:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // Mode "none" or missing connection: leave events queued; draining resumes
    // as soon as the bridge is re-enabled in /config. Overlap guard because a
    // slow batch can outlast the interval.
    if (this.draining) return;
    if (this.settingsStore.intercomMode() === "none" || !this.settingsStore.intercomConfigured()) return;

    this.draining = true;
    try {
      if (Date.now() - this.lastEchoCleanupAt > ECHO_CLEANUP_INTERVAL_MS) {
        this.lastEchoCleanupAt = Date.now();
        await this.store.cleanupEchoParts(new Date(Date.now() - ECHO_RETENTION_MS)).catch(() => {});
      }
      const due = await this.store.listDueHeads(BATCH_LIMIT);
      for (const event of due) {
        await this.processEvent(event);
        await sleep(CALL_SPACING_MS);
      }
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: IntercomOutboxEvent): Promise<void> {
    try {
      await this.execute(event);
      await this.store.markSuccess(event.id);
    } catch (e) {
      await this.handleFailure(event, e);
    }
  }

  private async handleFailure(event: IntercomOutboxEvent, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof IntercomHttpError && error.status === 404 && event.type !== "ensure") {
      // A linked remote object was deleted in Intercom. Figure out which half
      // died, self-heal inline, then retry this event on the next pass.
      const ticket = await this.ticketStore.getByThreadId(event.ticketThreadId);
      if (ticket) {
        try {
          const link = await this.store.getLink(event.ticketThreadId);
          const payload = await this.sync.buildEnsurePayloadWithSession(ticket);
          if (link && link.ticketId && (await this.client.conversationExists(link.conversationId))) {
            // Ticket deleted, conversation alive → re-convert only.
            await this.store.setTicketId(event.ticketThreadId, null);
            await this.attachTicket(event.ticketThreadId, link.conversationId, link.contactId, payload);
          } else {
            // Conversation gone (or no usable link) → full rebuild.
            await this.store.deleteLink(event.ticketThreadId);
            await this.ensureBridge(event.ticketThreadId, payload);
          }
        } catch (healError) {
          console.error(`Intercom 404 self-heal failed for ${event.ticketThreadId}:`, healError);
        }
        await this.retryOrDie(event, `404 — remote object recreated, retrying: ${message}`);
        return;
      }
    }

    const transient =
      !(error instanceof IntercomHttpError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500;

    if (!transient) {
      await this.store.markDead(event.id, message);
      void this.audit.log({
        title: "🌉 Intercom push failed",
        severity: "warn",
        actor: "Intercom bridge",
        threadId: event.ticketThreadId,
        fields: [
          { name: "Event", value: event.type, inline: true },
          { name: "Error", value: message.slice(0, 1024), inline: false },
        ],
      });
      return;
    }

    const retryAfterMs =
      error instanceof IntercomHttpError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : null;
    await this.retryOrDie(event, message, retryAfterMs);
  }

  private async retryOrDie(event: IntercomOutboxEvent, message: string, retryAfterMs?: number | null): Promise<void> {
    const attempts = event.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.store.markDead(event.id, message);
      void this.audit.log({
        title: "🌉 Intercom push dead-lettered",
        severity: "warn",
        actor: "Intercom bridge",
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

  // ---- Author resolution ----

  // Every admin-side call needs an admin_id. Preferred author: the auto-detected
  // Operator/Fin bot (no seat cost). Whether Intercom accepts bot authorship is
  // not guaranteed, so on a rejection-shaped error we retry with the configured
  // human admin — and only persist the "Operator rejected" verdict when the
  // fallback actually succeeded (a 404 for a deleted conversation would
  // otherwise falsely disable the Operator forever).
  private async withAuthor<T>(fn: (adminId: string) => Promise<T>): Promise<T> {
    const operator = this.settingsStore.intercomOperatorAdminId();
    const fallback = this.settingsStore.intercomAdminId();
    const primary = operator ?? fallback;
    if (!primary) throw new IntercomHttpError(503, "No Intercom authoring admin configured (set one in /config → Intercom)");
    try {
      return await fn(primary);
    } catch (e) {
      const rejectable =
        e instanceof IntercomHttpError && (e.status === 403 || e.status === 404 || e.status === 422);
      if (!rejectable || !operator || !fallback || operator === fallback || primary !== operator) throw e;
      const result = await fn(fallback); // a failure here propagates — the admin wasn't the problem
      await this.settingsStore.updateIntercom({ intercomOperatorAdminId: null });
      void this.audit.log({
        title: "🌉 Intercom Operator authorship rejected",
        severity: "warn",
        actor: "Intercom bridge",
        fields: [{ name: "Fallback", value: `Now authoring as configured admin ${fallback}`, inline: false }],
      });
      return result;
    }
  }

  // ---- Executors ----

  private async execute(event: IntercomOutboxEvent): Promise<void> {
    switch (event.type) {
      case "ensure":
        await this.ensureBridge(event.ticketThreadId, event.payload as unknown as EnsurePayload);
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
        throw new IntercomHttpError(400, `Unknown outbox event type: ${event.type}`);
    }
  }

  // Contact + conversation + converted ticket, resumable: the link row is
  // written the moment the conversation exists (ticketId null), so a retry
  // after a mid-ensure failure resumes at the convert step instead of creating
  // a duplicate conversation.
  private async ensureBridge(threadId: string, payload: EnsurePayload): Promise<void> {
    let link = await this.store.getLink(threadId);
    if (link?.ticketId) return; // idempotent re-run

    if (!link) {
      const externalId = externalIdFor(payload, threadId);
      const contactId = await this.resolveContact(externalId, payload);
      const header =
        `🎫 Discord ticket${payload.categoryLabel ? ` (${payload.categoryLabel})` : ""}` +
        ` — opened ${formatTimestamp(new Date(payload.createdAtIso))} — thread ${threadId}`;
      const conversationId = await this.client.createConversation(contactId, header, payload.createdAtIso);
      link = await this.store.createLink(threadId, contactId, externalId, conversationId);
    }

    const ticketId = await this.attachTicket(threadId, link.conversationId, link.contactId, payload);

    // Initial ticket state + attributes. Attribute failures degrade to
    // state-only (the definitions may not exist yet — /config "Ensure
    // attributes" or a one-time manual creation fixes that).
    const stateId = payload.statusTagId
      ? this.settingsStore.tagById(payload.statusTagId)?.intercomTicketStateId ?? null
      : null;
    const attributes: Record<string, unknown> = { [TICKET_ATTR_THREAD]: threadId };
    if (payload.priorityLabel) attributes[TICKET_ATTR_PRIORITY] = payload.priorityLabel;
    try {
      await this.withAuthor((a) => this.client.updateTicket(ticketId, { stateId: stateId ?? undefined, attributes, adminId: a }));
    } catch (e) {
      if (e instanceof IntercomHttpError && (e.status === 400 || e.status === 422) && stateId) {
        await this.withAuthor((a) => this.client.updateTicket(ticketId, { stateId, adminId: a }));
      } else if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) {
        throw e;
      }
    }
    if (stateId) await this.store.setLastSyncedStateId(threadId, stateId);

    await this.markDiscordOrigin(threadId, link.conversationId);

    // Conversation open/close parity: API-created conversations start open.
    if (payload.closed || payload.resolved) {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, false, a));
      await this.store.setLastSyncedOpen(threadId, "closed");
    } else {
      await this.store.setLastSyncedOpen(threadId, "open");
    }
  }

  // Best-effort "came from Discord" markers on the conversation. Never fails
  // the ensure: the tag needs no setup (find-or-create, cached per process);
  // the attributes 4xx until their definitions are created in the Intercom UI
  // and are skipped silently until then.
  private async markDiscordOrigin(threadId: string, conversationId: string): Promise<void> {
    try {
      if (!this.discordTagId) {
        this.discordTagId = (await this.client.findOrCreateTag(CONVERSATION_TAG)).id;
      }
      const tagId = this.discordTagId;
      await this.withAuthor((a) => this.client.tagConversation(conversationId, tagId, a));
    } catch (e) {
      this.discordTagId = null; // stale cache (tag deleted in Intercom) — recreate next time
      console.warn(`Intercom: tagging conversation ${conversationId} failed:`, e instanceof Error ? e.message : e);
    }
    try {
      await this.client.setConversationAttributes(conversationId, {
        [CONV_ATTR_ORIGIN]: "Discord",
        [TICKET_ATTR_THREAD]: threadId,
      });
    } catch (e) {
      if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) {
        console.warn(`Intercom: conversation attributes for ${conversationId} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  // find → create (with contact attributes) → conflict/attr fallbacks.
  private async resolveContact(externalId: string, payload: EnsurePayload): Promise<string> {
    await this.ensureContactAttributeDefinitions();

    const existing = await this.client.findContactByExternalId(externalId);
    if (existing) return existing.id;

    const name = payload.customerDisplayName || `Discord user ${payload.customerId ?? externalId}`;
    const customAttributes: Record<string, unknown> = {
      ...(payload.customerId ? { discord_user_id: payload.customerId } : {}),
      ...(payload.stripeCustomerId ? { stripe_customer_id: payload.stripeCustomerId } : {}),
    };
    try {
      const created = await this.client.createContact({ externalId, name, customAttributes });
      return created.id;
    } catch (e) {
      if (e instanceof IntercomHttpError && (e.status === 400 || e.status === 409 || e.status === 422)) {
        // Either a create race (contact exists) or a custom-attribute problem.
        const found = await this.client.searchContactByExternalId(externalId);
        if (found) return found.id;
        const created = await this.client.createContact({ externalId, name });
        return created.id;
      }
      throw e;
    }
  }

  // Contact custom attributes must be predefined; best-effort once per process
  // ("already exists" errors after the first run are the normal case).
  private async ensureContactAttributeDefinitions(): Promise<void> {
    if (this.contactAttrsEnsured) return;
    this.contactAttrsEnsured = true;
    for (const [name, description] of [
      ["discord_user_id", "Discord user id of the support-bot customer"],
      ["stripe_customer_id", "Stripe customer id from the support bot"],
    ] as const) {
      await this.client.createContactAttribute(name, description).catch(() => {});
    }
  }

  // Convert the conversation into a customer ticket (the only linked path for
  // customer types). Degrade ladder: convert with attributes → convert bare →
  // unlinked ticket + cross-reference note.
  private async attachTicket(
    threadId: string,
    conversationId: string,
    contactId: string,
    payload: EnsurePayload
  ): Promise<string> {
    const ticketTypeId = this.settingsStore.intercomTicketTypeIdFor(payload.categoryId);
    if (!ticketTypeId) {
      // Config gap, not a data error — retry transiently until a mapping exists.
      throw new IntercomHttpError(503, "No Intercom ticket type mapped (configure /config → Intercom → Ticket types)");
    }
    const title = `${payload.customerDisplayName ?? payload.customerId ?? "Discord"} — ${payload.categoryLabel ?? payload.categoryId ?? "Support"}`;
    const attributes = {
      _default_title_: title.slice(0, 250),
      _default_description_: (payload.question ?? `Discord ticket thread ${threadId}`).slice(0, 4000),
    };

    let ticketId: string;
    try {
      ticketId = (await this.client.convertToTicket(conversationId, ticketTypeId, attributes)).ticketId;
    } catch (e) {
      if (!isPermanent4xx(e)) throw e;
      try {
        ticketId = (await this.client.convertToTicket(conversationId, ticketTypeId)).ticketId;
      } catch (e2) {
        if (!isPermanent4xx(e2)) throw e2;
        try {
          // create+link is valid for back-office/tracker types — still a real
          // Intercom-side link, just not via convert.
          ticketId = (
            await this.client.createTicket({
              ticketTypeId,
              contactId,
              createdAtIso: payload.createdAtIso,
              conversationToLinkId: conversationId,
            })
          ).ticketId;
        } catch (e3) {
          if (!isPermanent4xx(e3)) throw e3;
          ticketId = (
            await this.client.createTicket({ ticketTypeId, contactId, createdAtIso: payload.createdAtIso })
          ).ticketId;
          await this.postAdminNote(
            threadId,
            conversationId,
            `🔗 Convert was rejected — created a standalone Intercom ticket instead: ${ticketId}`
          ).catch(() => {});
          void this.audit.log({
            title: "🌉 Intercom convert failed — unlinked ticket created",
            severity: "warn",
            actor: "Intercom bridge",
            threadId,
            fields: [{ name: "Ticket", value: ticketId, inline: true }],
          });
        }
      }
    }
    await this.store.setTicketId(threadId, ticketId);
    return ticketId;
  }

  private async requireLink(threadId: string): Promise<IntercomLink> {
    const link = await this.store.getLink(threadId);
    if (link?.ticketId) return link;
    // Defensive: an event slipped in without a completed ensure (shouldn't
    // happen — the sync service always enqueues ensure first). Rebuild inline.
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) throw new IntercomHttpError(410, `No ticket for thread ${threadId}`);
    await this.ensureBridge(threadId, await this.sync.buildEnsurePayloadWithSession(ticket));
    const link2 = await this.store.getLink(threadId);
    if (!link2) throw new IntercomHttpError(500, `Link creation failed for thread ${threadId}`);
    return link2;
  }

  private async postAdminNote(threadId: string, conversationId: string, body: string, createdAtIso?: string): Promise<void> {
    const { partId } = await this.withAuthor((a) =>
      this.client.replyAsAdmin(conversationId, { adminId: a, body, note: true, createdAtIso })
    );
    if (partId) await this.store.recordEchoPart("c", partId, threadId);
  }

  // Image URLs (Intercom documents attachment_urls as image URLs, ≤10) go as
  // real attachments in "urls" mode; everything else — and everything in
  // "links" mode (backfill: signed Discord URLs are expired) — as body lines.
  private splitAttachments(payload: MessagePayload): { urls: string[]; lines: string } {
    const urls: string[] = [];
    const lineList: string[] = [];
    for (const attachment of payload.attachments ?? []) {
      if (payload.attachmentMode === "urls" && urls.length < MAX_ATTACHMENT_URLS && isImageUrl(attachment.url)) {
        urls.push(attachment.url);
      } else {
        lineList.push(`📎 ${attachment.filename}: ${attachment.url}`);
      }
    }
    return { urls, lines: lineList.length > 0 ? `\n${lineList.join("\n")}` : "" };
  }

  private async executeMessage(threadId: string, payload: MessagePayload): Promise<void> {
    const link = await this.requireLink(threadId);
    const { urls, lines } = this.splitAttachments(payload);
    const body = `${payload.content}${lines}`;

    const send = async (attachmentUrls: string[], finalBody: string): Promise<void> => {
      if (payload.direction === "incoming") {
        await this.client.replyAsContact(link.conversationId, {
          intercomUserId: link.contactId,
          body: finalBody,
          createdAtIso: payload.externalCreatedAtIso,
          attachmentUrls,
        });
      } else {
        const { partId } = await this.withAuthor((a) =>
          this.client.replyAsAdmin(link.conversationId, {
            adminId: a,
            body: finalBody,
            createdAtIso: payload.externalCreatedAtIso,
            attachmentUrls,
          })
        );
        if (partId) await this.store.recordEchoPart("c", partId, threadId);
      }
    };

    try {
      await send(urls, body);
    } catch (e) {
      // attachment_urls rejected (non-image, dead link, …) → fold into the body.
      if (urls.length > 0 && e instanceof IntercomHttpError && (e.status === 400 || e.status === 422)) {
        const folded = `${body}\n${urls.map((u) => `📎 ${u}`).join("\n")}`;
        await send([], folded);
        return;
      }
      throw e;
    }
  }

  private async executeNote(threadId: string, payload: NotePayload): Promise<void> {
    const link = await this.requireLink(threadId);
    await this.postAdminNote(threadId, link.conversationId, payload.content, payload.externalCreatedAtIso);
  }

  private async executeStatus(threadId: string, payload: StatusPayload): Promise<void> {
    const link = await this.requireLink(threadId);

    // Ticket state, mapping resolved now (the /config mapping may have changed
    // while the event was queued). Guarded by lastSyncedStateId: bi-mode
    // webhook-initiated changes already updated Intercom, so the echo push
    // becomes a no-op here.
    const tag = payload.statusTagId ? this.settingsStore.tagById(payload.statusTagId) : undefined;
    const stateId = tag?.intercomTicketStateId ?? null;
    if (link.ticketId && stateId && link.lastSyncedStateId !== stateId) {
      await this.withAuthor((a) => this.client.updateTicket(link.ticketId!, { stateId, adminId: a }));
      await this.store.setLastSyncedStateId(threadId, stateId);
    }

    // Conversation open/close parity (closing statuses close the conversation),
    // same damper pattern via lastSyncedOpen.
    const target: "open" | "closed" = payload.closed || payload.resolved ? "closed" : "open";
    if (link.lastSyncedOpen !== target) {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, target === "open", a));
      await this.store.setLastSyncedOpen(threadId, target);
    }

    if (payload.note) {
      await this.postAdminNote(
        threadId,
        link.conversationId,
        `Status: ${payload.fromLabel ?? "—"} → ${payload.statusLabel} — by ${payload.actorName}`
      );
    }
  }

  private async executePriority(threadId: string, payload: PriorityPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    if (link.ticketId) {
      try {
        await this.withAuthor((a) =>
          this.client.updateTicket(link.ticketId!, { attributes: { [TICKET_ATTR_PRIORITY]: payload.priorityLabel }, adminId: a })
        );
      } catch (e) {
        // Attribute definition missing → the narration note below still records it.
        if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) throw e;
      }
    }
    if (payload.note) {
      await this.postAdminNote(
        threadId,
        link.conversationId,
        `Priority: ${payload.fromLabel ?? "—"} → ${payload.priorityLabel} — by ${payload.actorName}`
      );
    }
  }

  private async executeCsat(threadId: string, payload: CsatPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    if (link.ticketId) {
      try {
        await this.withAuthor((a) =>
          this.client.updateTicket(link.ticketId!, { attributes: { [TICKET_ATTR_CSAT]: `${payload.score}/5` }, adminId: a })
        );
      } catch (e) {
        if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) throw e;
      }
    }
    await this.postAdminNote(
      threadId,
      link.conversationId,
      `⭐ CSAT: ${payload.score}/5${payload.comment ? `\n${payload.comment}` : ""}`
    );
  }
}

function isPermanent4xx(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

function isImageUrl(url: string): boolean {
  try {
    return /\.(png|jpe?g|gif|webp)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
