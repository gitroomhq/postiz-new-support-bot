import * as Sentry from "@sentry/node";
import { IntercomLink, IntercomOutboxEvent } from "../generated/prisma/client";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomClient, IntercomHttpError } from "./IntercomClient";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService, externalIdCandidates } from "./IntercomSyncService";
import { bodyHash, renderDiscordMarkdownToHtml } from "./renderDiscordMarkdown";
import { log } from "../util/logger";
import { withTickSpan, wasCaptured, metricCount, metricGauge, SPAN_STATUS_ERROR } from "../util/instrument";
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
// Pending-post reservations are crash leftovers after this long.
const PENDING_POST_RETENTION_MS = 60 * 60 * 1000;
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
  private schedLog = log.child("intercom:outbox");
  private lastDepthGaugeAt = 0;

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
      this.tick().catch((err) => {
        if (!wasCaptured(err)) this.schedLog.error("tick failed", err);
      });
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
        await this.store.cleanupPendingPosts(new Date(Date.now() - PENDING_POST_RETENTION_MS)).catch(() => {});
      }
      // Queue depth gauge at most once a minute — this polls every 5 seconds.
      if (Date.now() - this.lastDepthGaugeAt > 60_000) {
        this.lastDepthGaugeAt = Date.now();
        const counts = await this.store.counts().catch(() => null);
        if (counts) {
          metricGauge("intercom.outbox.queue_depth", counts.pending);
          metricGauge("intercom.outbox.dead_letters", counts.dead);
        }
      }
      const due = await this.store.listDueHeads(BATCH_LIMIT);
      if (due.length === 0) return;
      // Span only ticks with actual work (a 5s poller would otherwise emit
      // ~17k empty transactions per day).
      await withTickSpan("intercom-outbox", async () => {
        Sentry.getActiveSpan()?.setAttribute("queue.batch_size", due.length);
        for (const event of due) {
          await this.processEvent(event);
          await sleep(CALL_SPACING_MS);
        }
      });
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: IntercomOutboxEvent): Promise<void> {
    // One child span per queue event; the Intercom fetches nest underneath.
    await Sentry.startSpan(
      {
        name: `outbox.${event.type}`,
        op: "queue.process",
        attributes: {
          "queue.event_id": event.id,
          "queue.event_type": event.type,
          "ticket.thread_id": event.ticketThreadId,
          "queue.attempts": event.attempts,
        },
      },
      async (span) => {
        try {
          await this.execute(event);
          await this.store.markSuccess(event.id);
          metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "ok" });
        } catch (e) {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "processing_failed" });
          await this.handleFailure(event, e);
        }
      }
    );
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
          this.schedLog.error("404 self-heal failed", healError, { "ticket.thread_id": event.ticketThreadId });
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
      this.schedLog.warn("intercom.outbox.dead_letter", {
        "queue.event_id": event.id,
        "queue.event_type": event.type,
        "ticket.thread_id": event.ticketThreadId,
        "queue.attempts": event.attempts,
        "error.message": message.slice(0, 512),
        "queue.reason": "permanent_error",
      });
      metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "dead" });
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
      this.schedLog.warn("intercom.outbox.dead_letter", {
        "queue.event_id": event.id,
        "queue.event_type": event.type,
        "ticket.thread_id": event.ticketThreadId,
        "queue.attempts": attempts,
        "error.message": message.slice(0, 512),
        "queue.reason": "max_attempts",
      });
      metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "dead" });
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
    metricCount("intercom.outbox.processed", 1, { type: event.type, outcome: "retry" });
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
  // a duplicate conversation. Every finishing step below is idempotent, so a
  // re-run ("Retry failed" on a dead ensure) completes whatever is missing.
  private async ensureBridge(threadId: string, payload: EnsurePayload): Promise<void> {
    let link = await this.store.getLink(threadId);
    let created = false;

    if (!link) {
      const { contactId, externalId } = await this.resolveContact(externalIdCandidates(payload, threadId), payload);
      // Live tickets: the customer's rendered question IS the opening message
      // (native created_at carries the timestamp — no text prefixes). Backfill:
      // a generic import header; the transcript replay supplies the content.
      const opening =
        payload.questionAsOpening !== false && payload.question?.trim()
          ? renderDiscordMarkdownToHtml(payload.question)
          : `🎫 Discord ticket${payload.categoryLabel ? ` (${payload.categoryLabel})` : ""} — transcript imported from Discord`;
      const conversationId = await this.client.createConversation(contactId, opening, payload.createdAtIso);
      link = await this.store.createLink(threadId, contactId, externalId, conversationId);
      created = true;
    }

    const ticketId = link.ticketId ?? (await this.attachTicket(threadId, link.conversationId, link.contactId, payload));

    // One static context card as an internal note on first creation. Live data
    // (plan, charges) comes from the Canvas Kit inbox app, not from sync.
    if (created) {
      const contextLines = [
        `<b>Discord ticket</b>`,
        payload.customerDisplayName ? `Customer: ${escapeHtmlText(payload.customerDisplayName)}` : null,
        payload.categoryLabel ? `Category: ${escapeHtmlText(payload.categoryLabel)}` : null,
        payload.postizUserId ? `Postiz user: ${escapeHtmlText(payload.postizUserId)}` : null,
        payload.threadUrl ? `<a href="${payload.threadUrl}">Open Discord thread</a>` : `Thread: ${threadId}`,
      ].filter(Boolean);
      await this.postAdminNote(threadId, link.conversationId, `<p>${contextLines.join("<br>")}</p>`, undefined, true).catch(
        (e) =>
          this.schedLog.warn("context note failed", {
            "ticket.thread_id": threadId,
            "error.message": e instanceof Error ? e.message : String(e),
          })
      );
    }

    // Ticket attributes; the definitions may not exist yet ("/config → Ensure
    // Attributes" or a one-time manual creation fixes that) — degrade.
    const attributes: Record<string, unknown> = { [TICKET_ATTR_THREAD]: threadId };
    if (payload.priorityLabel) attributes[TICKET_ATTR_PRIORITY] = payload.priorityLabel;
    try {
      await this.withAuthor((a) => this.client.updateTicket(ticketId, { attributes, adminId: a }));
    } catch (e) {
      if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) throw e;
    }

    // Initial ticket state. A freshly converted ticket often already sits in
    // the mapped state (the type's default) — Intercom rejects that with
    // 400 "Cannot transition ticket to the same state", which for the bridge
    // means: already done.
    const stateId = payload.statusTagId
      ? this.settingsStore.tagById(payload.statusTagId)?.intercomTicketStateId ?? null
      : null;
    if (stateId) {
      try {
        await this.withAuthor((a) => this.client.updateTicket(ticketId, { stateId, adminId: a }));
      } catch (e) {
        if (!isSameStateError(e)) throw e;
      }
      await this.store.setLastSyncedStateId(threadId, stateId);
    }

    await this.markDiscordOrigin(threadId, link.conversationId);

    // Team routing (Intercom's workflow triggers can't see API-created
    // conversations/tickets, so the bridge assigns directly). Permanent
    // failures degrade with an audit warning — a wrong/deleted team id must
    // not dead-letter tickets — and only apply on creation: later reassignment
    // by agents is never overridden.
    const teamId = this.settingsStore.intercomTeamId();
    if (teamId) {
      try {
        await this.withAuthor((a) => this.client.assignConversationToTeam(link.conversationId, teamId, a));
        await this.withAuthor((a) => this.client.updateTicket(ticketId, { assigneeId: teamId, adminId: a }));
      } catch (e) {
        if (!isPermanent4xx(e)) throw e;
        void this.audit.log({
          title: "🌉 Intercom team assignment failed",
          severity: "warn",
          actor: "Intercom bridge",
          threadId,
          fields: [
            { name: "Team", value: teamId, inline: true },
            { name: "Error", value: (e instanceof Error ? e.message : String(e)).slice(0, 1024), inline: false },
          ],
        });
      }
    }

    // Conversation open/close parity: API-created conversations start open.
    const target: "open" | "closed" = payload.closed || payload.resolved ? "closed" : "open";
    if (target === "closed" && link.lastSyncedOpen !== "closed") {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, false, a));
    }
    if (link.lastSyncedOpen !== target) {
      await this.store.setLastSyncedOpen(threadId, target);
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
      this.schedLog.warn("conversation tagging failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await this.client.setConversationAttributes(conversationId, {
        [CONV_ATTR_ORIGIN]: "Discord",
        [TICKET_ATTR_THREAD]: threadId,
      });
    } catch (e) {
      if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) {
        this.schedLog.warn("conversation attributes failed", {
          "intercom.conversation_id": conversationId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Resolve the contact for a ticket, cascading down the external_id candidates
  // (canonical Postiz id → discord:{userId} → thread-scoped). Returns the id
  // that actually worked so the caller records it on the link.
  private async resolveContact(
    candidates: string[],
    payload: EnsurePayload
  ): Promise<{ contactId: string; externalId: string }> {
    await this.ensureContactAttributeDefinitions();

    // Reuse an existing contact under ANY candidate namespace first. This keeps
    // a post-wipe fallback contact (minted under discord:{id} while the Postiz
    // id sat in the deletion grace) authoritative: once the canonical id frees
    // up, later tickets still find and reuse it here instead of duplicating.
    for (const externalId of candidates) {
      const existing = await this.client.findContactByExternalId(externalId);
      if (existing) return { contactId: existing.id, externalId };
    }

    const name = payload.customerDisplayName || `Discord user ${payload.customerId ?? candidates[0]}`;
    const customAttributes: Record<string, unknown> = {
      ...(payload.customerId ? { discord_user_id: payload.customerId } : {}),
      ...(payload.stripeCustomerId ? { stripe_customer_id: payload.stripeCustomerId } : {}),
    };

    // Create under the first candidate that isn't locked. A blocked id 409s with
    // the conflicting record's id in the body; if it's merely archived we
    // unarchive and reuse it, but if it's mid-permanent-deletion (a prior wipe's
    // DELETE — "not restorable") we can neither reuse nor recreate under it for
    // ~7 days, so we fall through to the next namespace.
    for (let i = 0; i < candidates.length; i++) {
      const externalId = candidates[i];
      // Custom attributes only on the canonical attempt — a fallback create must
      // not be derailed by a missing attribute definition.
      const contactId = await this.resolveContactForId(externalId, name, i === 0 ? customAttributes : undefined);
      if (contactId) return { contactId, externalId };
      this.schedLog.warn("intercom external_id locked in deletion grace, trying fallback namespace", {
        "intercom.external_id": externalId,
      });
    }

    // Every candidate is in the grace window (all namespaces wiped within 7 days
    // — practically impossible given the unique thread-scoped tail).
    throw new IntercomHttpError(422, "Intercom contact resolve: all external_id candidates are in the deletion grace window");
  }

  // Get the contact id for one exact external_id, or null when that id is
  // unusable because a prior wipe left it mid-permanent-deletion (caller then
  // tries the next namespace). Throws on any other failure.
  private async resolveContactForId(
    externalId: string,
    name: string,
    customAttributes: Record<string, unknown> | undefined
  ): Promise<string | null> {
    try {
      const created = await this.client.createContact({ externalId, name, customAttributes });
      return created.id;
    } catch (e) {
      if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 409 || e.status === 422))) throw e;

      // Conflict with an archived/deleting record whose id is in the 409 body.
      const archivedId = archivedContactId(e);
      if (archivedId) {
        try {
          await this.client.unarchiveContact(archivedId);
          return archivedId; // was merely archived → reactivated, reuse.
        } catch (unarchiveErr) {
          if (isContactNotRestorable(unarchiveErr)) return null; // permanent-deletion grace → next namespace.
          throw unarchiveErr;
        }
      }

      // A create race (contact now exists) or a custom-attribute rejection —
      // search, then retry the create once without custom attributes.
      const found = await this.client.searchContactByExternalId(externalId);
      if (found) return found.id;
      const created = await this.client.createContact({ externalId, name });
      return created.id;
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

  // Reserve → call → confirm: the pending-post row is written BEFORE the API
  // call so a webhook that beats the confirm still recognizes the part as our
  // own (body-hash match) — replaces the old fixed-sleep race. On failure the
  // reservation is released; a retry re-reserves.
  private async postAdminNote(
    threadId: string,
    conversationId: string,
    body: string,
    createdAtIso?: string,
    alreadyHtml = false
  ): Promise<void> {
    const html = alreadyHtml ? body : renderDiscordMarkdownToHtml(body);
    const pendingId = await this.store.reservePendingPost(threadId, "c", bodyHash(html));
    try {
      const { partId } = await this.withAuthor((a) =>
        this.client.replyAsAdmin(conversationId, { adminId: a, body: html, note: true, createdAtIso })
      );
      if (partId) await this.store.recordEchoPart("c", partId, threadId);
    } finally {
      await this.store.deletePendingPost(pendingId).catch(() => {});
    }
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

  // Payloads stay plain Discord markdown in the DB; rendering to Intercom HTML
  // happens here at the choke point, so queued events survive renderer changes.
  private async executeMessage(threadId: string, payload: MessagePayload): Promise<void> {
    const link = await this.requireLink(threadId);
    const { urls, lines } = this.splitAttachments(payload);
    const body = renderDiscordMarkdownToHtml(`${payload.content}${lines}`);

    const send = async (attachmentUrls: string[], finalBody: string): Promise<void> => {
      if (payload.direction === "incoming") {
        // Contact-authored parts are never relayed back (the webhook handler
        // only processes admin/bot authors) — no echo bookkeeping needed.
        await this.client.replyAsContact(link.conversationId, {
          intercomUserId: link.contactId,
          body: finalBody,
          createdAtIso: payload.externalCreatedAtIso,
          attachmentUrls,
        });
        return;
      }
      // Outgoing (admin-authored): reserve → call → confirm, see postAdminNote.
      const pendingId = await this.store.reservePendingPost(threadId, "c", bodyHash(finalBody));
      try {
        const { partId } = await this.withAuthor((a) =>
          this.client.replyAsAdmin(link.conversationId, {
            adminId: a,
            body: finalBody,
            createdAtIso: payload.externalCreatedAtIso,
            attachmentUrls,
          })
        );
        if (partId) await this.store.recordEchoPart("c", partId, threadId);
      } finally {
        await this.store.deletePendingPost(pendingId).catch(() => {});
      }
    };

    try {
      await send(urls, body);
    } catch (e) {
      // attachment_urls rejected (non-image, dead link, …) → fold into the body.
      if (urls.length > 0 && e instanceof IntercomHttpError && (e.status === 400 || e.status === 422)) {
        const folded = `${body}<p>${urls.map((u) => `📎 <a href="${u}">${u}</a>`).join("<br>")}</p>`;
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
      try {
        await this.withAuthor((a) => this.client.updateTicket(link.ticketId!, { stateId, adminId: a }));
      } catch (e) {
        // "Cannot transition ticket to the same state" — already there
        // (e.g. an agent moved it while the mode was push, or two bot tags
        // map to one Intercom state). Success for the bridge.
        if (!isSameStateError(e)) throw e;
      }
      await this.store.setLastSyncedStateId(threadId, stateId);
    }

    // Conversation open/close parity (closing statuses close the conversation),
    // same damper pattern via lastSyncedOpen. Messages-only mirroring: no
    // transition note — the ticket state itself is the record.
    const target: "open" | "closed" = payload.closed || payload.resolved ? "closed" : "open";
    if (link.lastSyncedOpen !== target) {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, target === "open", a));
      await this.store.setLastSyncedOpen(threadId, target);
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
        // Attribute definition missing — degrade (messages-only mirroring, no note).
        if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) throw e;
      }
    }
  }

  // CSAT lands as a ticket attribute only (messages-only mirroring).
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
  }
}

function isPermanent4xx(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

// Intercom rejects a transition to the ticket's current state with a 400 —
// for the bridge that outcome IS the desired end state.
function isSameStateError(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status === 400 && /same state/i.test(e.message);
}

// The create-contact 409 for an archived record embeds its id, e.g. "An
// archived contact matching those details already exists with id=abc123".
function archivedContactId(e: unknown): string | null {
  if (!(e instanceof IntercomHttpError)) return null;
  const m = /archived contact.*?id=(\w+)/i.exec(e.message);
  return m ? m[1] : null;
}

// Unarchive rejects a contact already inside Intercom's permanent-deletion grace
// ("...marked for permanent deletion and is not restorable") — its external_id
// stays locked for ~7 days, so the resolver must fall through to another id.
function isContactNotRestorable(e: unknown): boolean {
  return e instanceof IntercomHttpError && /(not restorable|permanent deletion)/i.test(e.message);
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
