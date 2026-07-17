import { IntercomLink, IntercomMessageMap } from "../generated/prisma/client";
import { TicketStore } from "../bot/TicketStore";
import { AuditLogger } from "../bot/AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomClient, IntercomHttpError } from "./IntercomClient";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService, externalIdCandidates, isIntercomExempt } from "./IntercomSyncService";
import { bodyHash, renderDiscordMarkdownToHtml } from "./renderDiscordMarkdown";
import { applyTeam } from "./reminderText";
import { log } from "../util/logger";
import {
  AgentReminderPayload,
  CsatPayload,
  EnsurePayload,
  MessageDeletePayload,
  MessageEditPayload,
  MessagePayload,
  NotePayload,
  OutboxEventType,
  StatusPayload,
} from "./types";

// Intercom accepts at most 10 attachment URLs per message.
const MAX_ATTACHMENT_URLS = 10;

// Ticket attributes the bridge writes. Auto-created via the /config "Ensure
// attributes" action; executors degrade (skip the attribute) when missing.
export const TICKET_ATTR_CSAT = "CSAT";
export const TICKET_ATTR_CSAT_COMMENT = "CSAT Comment";
export const TICKET_ATTR_THREAD = "Discord Thread";
// "Came from Discord" markers on the conversation itself: a tag (find-or-create
// via API, works with zero setup) and an Origin attribute (definition is
// UI-managed, so it only lands once created in the workspace).
export const CONVERSATION_TAG = "Discord";
export const CONV_ATTR_ORIGIN = "Origin";

// The Intercom API executor bodies, extracted from IntercomOutboxScheduler so
// BOTH regimes share one implementation (and its per-process caches):
//  - legacy: the outbox scheduler's drain loop wraps execute() with its own
//    retry/backoff/dead-letter bookkeeping;
//  - Temporal: the executeIntercomEvent activity wraps execute() and the
//    intercomDeliveryWorkflow owns the retry loop.
// Every step is idempotent / crash-resumable (link ladder, reserve→call→confirm
// pending posts, lastSynced* dampers) — a retry resumes whatever is missing.
export class IntercomEventExecutor {
  private contactAttrsEnsured = false;
  private discordTagId: string | null = null;
  // Last identity (name|avatar) pushed per contact — ensures re-run routinely
  // (every Continue-As-New re-synthesizes one), and a no-op PUT per re-ensure
  // across the fleet would waste real rate-limit budget.
  private contactIdentityPushed = new Map<string, string>();
  private execLog = log.child("intercom:exec");
  // SLA manager brain — late-bound (constructed after the executor in
  // index.ts); handles the "sla" outbox event. Same pattern as
  // IntercomSyncService.setExecutor.
  private slaService: { applyForBridged(threadId: string, reason: string): Promise<unknown> } | null = null;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger
  ) {}

  setSlaService(service: { applyForBridged(threadId: string, reason: string): Promise<unknown> }): void {
    this.slaService = service;
  }

  // ---- Author resolution ----

  // Every admin-side call needs an admin_id. Preferred author: the auto-detected
  // Operator/Fin bot (no seat cost). Whether Intercom accepts bot authorship is
  // not guaranteed, so on a rejection-shaped error we retry with the configured
  // human admin — and only persist the "Operator rejected" verdict when the
  // fallback actually succeeded (a 404 for a deleted conversation would
  // otherwise falsely disable the Operator forever).
  async withAuthor<T>(fn: (adminId: string) => Promise<T>): Promise<T> {
    const operator = this.settingsStore.intercomOperatorAdminId();
    const fallback = this.settingsStore.intercomAdminId();
    const primary = operator ?? fallback;
    if (!primary) throw new IntercomHttpError(503, "No Intercom authoring admin configured (set one in /config → Intercom)");
    try {
      return await fn(primary);
    } catch (e) {
      // Only permission-shaped statuses count as authorship rejection. 422 is a
      // generic validation error (bad state transition, etc.) — treating it as
      // "Operator can't author" could permanently disable the Operator on a
      // coincidental fallback success.
      const rejectable = e instanceof IntercomHttpError && (e.status === 403 || e.status === 404);
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

  // ---- Entry point ----

  // `beat` (optional): Temporal activity heartbeat, called between API steps —
  // multi-call events (ensure ≈ up to 15 sequential calls of up to 30s each)
  // would otherwise outlive the heartbeat timeout and retry CONCURRENTLY with
  // the still-running attempt, duplicating conversations.
  async execute(threadId: string, type: OutboxEventType, payload: unknown, beat?: () => void): Promise<void> {
    switch (type) {
      case "ensure": {
        // Exempt refund tickets aren't mirrored (emit-layer gate); the ONE
        // event that reaches this executor for them anyway is the ticket
        // workflow's creation-synthesized ensure — short-circuit it as a
        // success so the pump drains without creating anything. Payloads
        // composed since the per-ticket flag carry it resolved (explicit
        // false = a flipped refund ticket, which MUST ensure); stale queued
        // payloads without the field fall back to the legacy
        // (categoryId, question) refund predicate inside.
        const ensurePayload = payload as EnsurePayload;
        if (ensurePayload && isIntercomExempt(ensurePayload)) {
          this.execLog.info("ensure skipped (intercom-exempt ticket)", {
            "ticket.thread_id": threadId,
            "ticket.category_id": ensurePayload?.categoryId ?? "",
          });
          return;
        }
        await this.ensureBridge(threadId, ensurePayload, beat);
        return;
      }
      case "message":
        await this.executeMessage(threadId, payload as MessagePayload);
        return;
      case "note":
        await this.executeNote(threadId, payload as NotePayload);
        return;
      case "status":
        await this.executeStatus(threadId, payload as StatusPayload);
        return;
      case "priority":
        // Skip-only: the priority axis is removed, but durable queued events
        // may still carry the type. Drop with the N+1 cleanup.
        this.execLog.info("priority event skipped (axis removed)", { "ticket.thread_id": threadId });
        return;
      case "csat":
        await this.executeCsat(threadId, payload as CsatPayload);
        return;
      case "agent_reminder":
        await this.executeAgentReminder(threadId, payload as AgentReminderPayload);
        return;
      case "message_edit":
        await this.executeMessageEdit(threadId, payload as MessageEditPayload);
        return;
      case "message_delete":
        await this.executeMessageDelete(threadId, payload as MessageDeletePayload);
        return;
      case "sla":
        // Payload is always null — the target is computed NOW from the
        // current rules (stale queued events converge). Unbridged/exempt
        // tickets come back as a skipped result, never an error, so the
        // event drains without dead-lettering. Transient Intercom failures
        // throw IntercomHttpError → normal delivery retry machinery.
        if (this.slaService) await this.slaService.applyForBridged(threadId, "outbox");
        else this.execLog.warn("sla event with no SlaService bound — skipped", { "ticket.thread_id": threadId });
        return;
      default:
        throw new IntercomHttpError(400, `Unknown outbox event type: ${type}`);
    }
  }

  // A linked remote object was deleted in Intercom (404 on a non-ensure event).
  // Figure out which half died and rebuild it; the caller then retries the
  // original event. Checks CONTACT and TICKET halves explicitly — a contact
  // merged/hard-deleted by an agent 404s every replyAsContact, and re-converting
  // an already-converted conversation can never fix that (it just mints junk
  // standalone tickets).
  async selfHeal404(threadId: string, beat?: () => void): Promise<void> {
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    const link = await this.store.getLink(threadId);
    const payload = await this.sync.buildEnsurePayloadWithSession(ticket);
    if (link && (await this.client.conversationExists(link.conversationId))) {
      beat?.();
      // Contact half: merged/hard-deleted → re-resolve; archived → unarchive.
      let contactId = link.contactId;
      const contact = await this.client.getContact(link.contactId);
      if (!contact) {
        const resolved = await this.resolveContact(externalIdCandidates(payload, threadId), payload);
        await this.store.updateLinkContact(threadId, resolved.contactId, resolved.externalId);
        contactId = resolved.contactId;
      } else if (contact.archived) {
        await this.client.unarchiveContact(link.contactId);
      }
      beat?.();
      // Ticket half: re-convert only when it actually died (attachTicket adopts
      // an existing conversion instead of degrading to a standalone ticket).
      if (!link.ticketId || !(await this.client.ticketExists(link.ticketId))) {
        await this.store.setTicketId(threadId, null);
        await this.attachTicket(threadId, link.conversationId, contactId, payload);
      }
    } else {
      // Conversation gone (or no usable link) → full rebuild.
      await this.store.deleteLink(threadId);
      await this.ensureBridge(threadId, payload, beat);
    }
  }

  // ---- Executors ----

  // Contact + conversation + converted ticket, resumable: the link row is
  // written the moment the conversation exists (ticketId null), so a retry
  // after a mid-ensure failure resumes at the convert step instead of creating
  // a duplicate conversation. Every finishing step below is idempotent, so a
  // re-run ("Retry failed" on a dead ensure) completes whatever is missing.
  async ensureBridge(threadId: string, payload: EnsurePayload, beat?: () => void): Promise<void> {
    let link = await this.store.getLink(threadId);
    let created = false;

    if (!link) {
      const { contactId, externalId } = await this.resolveContact(externalIdCandidates(payload, threadId), payload, beat);
      beat?.();
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
    } else {
      // Reused link (re-ensure after Continue-As-New / self-heal): refresh the
      // contact's display identity — Discord names drift and the avatar was
      // historically never set. Best-effort, deduped per process.
      await this.refreshContactIdentity(link.contactId, payload).catch(() => {});
    }

    beat?.();
    const ticketId = link.ticketId ?? (await this.attachTicket(threadId, link.conversationId, link.contactId, payload));
    beat?.();

    // One static context card as an internal note on first creation. Live data
    // (plan, charges) comes from the Canvas Kit inbox app, not from sync.
    if (created) {
      const contextLines = [
        `<b>Discord ticket</b>`,
        payload.customerDisplayName ? `Customer: ${escapeHtmlText(payload.customerDisplayName)}` : null,
        payload.categoryLabel ? `Category: ${escapeHtmlText(payload.categoryLabel)}` : null,
        payload.postizUserId ? `Postiz user: ${escapeHtmlText(payload.postizUserId)}` : null,
        payload.stripeCustomerId ? `Stripe customer: ${escapeHtmlText(payload.stripeCustomerId)}` : null,
      ].filter(Boolean);
      await this.postAdminNote(threadId, link.conversationId, `<p>${contextLines.join("<br>")}</p>`, undefined, true).catch(
        (e) =>
          this.execLog.warn("context note failed", {
            "ticket.thread_id": threadId,
            "error.message": e instanceof Error ? e.message : String(e),
          })
      );
    }
    beat?.();

    // Ticket attributes; the definitions may not exist yet ("/config → Ensure
    // Attributes" or a one-time manual creation fixes that) — degrade.
    const attributes: Record<string, unknown> = { [TICKET_ATTR_THREAD]: threadId };
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
    beat?.();

    await this.markDiscordOrigin(threadId, link.conversationId);
    beat?.();

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
        // Re-ensure after a partial failure: "already assigned" IS the desired
        // end state — swallow it instead of spamming the audit channel.
        if (!isAlreadyAssignedError(e)) {
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
    }
    beat?.();

    // Conversation open/close parity: API-created conversations start open.
    // The ticket's own open flag follows suit — resolved state alone leaves it
    // listed among open tickets.
    const target: "open" | "closed" = payload.closed || payload.resolved ? "closed" : "open";
    if (target === "closed" && link.lastSyncedOpen !== "closed") {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, false, a));
      await this.setTicketOpenParity(ticketId, false);
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
      this.execLog.warn("conversation tagging failed", {
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
        this.execLog.warn("conversation attributes failed", {
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
    payload: EnsurePayload,
    beat?: () => void
  ): Promise<{ contactId: string; externalId: string }> {
    await this.ensureContactAttributeDefinitions();

    // Reuse an existing contact under ANY candidate namespace first. This keeps
    // a post-wipe fallback contact (minted under discord:{id} while the Postiz
    // id sat in the deletion grace) authoritative: once the canonical id frees
    // up, later tickets still find and reuse it here instead of duplicating.
    for (const externalId of candidates) {
      beat?.();
      const existing = await this.client.findContactByExternalId(externalId);
      if (existing) {
        // Refresh display identity on reuse — name drift, missing avatar.
        await this.refreshContactIdentity(existing.id, payload).catch(() => {});
        return { contactId: existing.id, externalId };
      }
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
      beat?.();
      // Custom attributes only on the canonical attempt — a fallback create must
      // not be derailed by a missing attribute definition.
      const contactId = await this.resolveContactForId(externalId, name, i === 0 ? customAttributes : undefined, payload);
      if (contactId) return { contactId, externalId };
      this.execLog.warn("intercom external_id locked in deletion grace, trying fallback namespace", {
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
    customAttributes: Record<string, unknown> | undefined,
    payload: EnsurePayload
  ): Promise<string | null> {
    const avatarUrl = payload.customerAvatarUrl ?? undefined;
    try {
      const created = await this.client.createContact({ externalId, name, customAttributes, avatarUrl });
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
      // search, then retry the create once without custom attributes. The retry
      // itself can conflict too (a differently-shaped 409/422 whose body didn't
      // parse above) — never let that dead-letter the ensure permanently; fall
      // through to the next external_id namespace instead.
      const found = await this.client.searchContactByExternalId(externalId);
      if (found) return found.id;
      try {
        const created = await this.client.createContact({ externalId, name, avatarUrl });
        return created.id;
      } catch (e2) {
        if (!(e2 instanceof IntercomHttpError && (e2.status === 400 || e2.status === 409 || e2.status === 422))) throw e2;
        const archivedId2 = archivedContactId(e2);
        if (archivedId2) {
          try {
            await this.client.unarchiveContact(archivedId2);
            return archivedId2;
          } catch (unarchiveErr) {
            if (isContactNotRestorable(unarchiveErr)) return null;
            throw unarchiveErr;
          }
        }
        const foundAgain = await this.client.searchContactByExternalId(externalId);
        if (foundAgain) return foundAgain.id;
        this.execLog.warn("contact create conflicted without a resolvable record, trying fallback namespace", {
          "intercom.external_id": externalId,
          "error.message": e2.message,
        });
        return null;
      }
    }
  }

  // Pushes name/avatar onto an existing contact, skipping when this process
  // already pushed the identical identity (re-ensures are routine).
  private async refreshContactIdentity(contactId: string, payload: EnsurePayload): Promise<void> {
    if (!payload.customerDisplayName && !payload.customerAvatarUrl) return;
    const stamp = `${payload.customerDisplayName ?? ""}|${payload.customerAvatarUrl ?? ""}`;
    if (this.contactIdentityPushed.get(contactId) === stamp) return;
    await this.client.updateContact(contactId, {
      name: payload.customerDisplayName,
      avatarUrl: payload.customerAvatarUrl ?? null,
    });
    if (this.contactIdentityPushed.size > 2000) this.contactIdentityPushed.clear();
    this.contactIdentityPushed.set(contactId, stamp);
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
      // A conversation can only be converted once — a heal retry hitting an
      // already-converted conversation must ADOPT the existing ticket, not
      // degrade down the ladder into a junk standalone one.
      const existingTicketId = await this.client.getConversationTicketId(conversationId).catch(() => null);
      if (existingTicketId) {
        await this.store.setTicketId(threadId, existingTicketId);
        return existingTicketId;
      }
      try {
        ticketId = (await this.client.convertToTicket(conversationId, ticketTypeId)).ticketId;
      } catch (e2) {
        if (!isPermanent4xx(e2)) throw e2;
        try {
          // create+link is valid for back-office/tracker types — still a real
          // Intercom-side link, just not via convert. For CUSTOMER types this
          // rung is expected to 4xx (conversation_to_link_id is rejected) and
          // fall through to the standalone rung below.
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

  // A ticketId-less link is fine for most events (they need the conversation;
  // the pending convert is the ensure's job to finish). NO inline rebuild when
  // the link is missing entirely: the pump's ensure-first invariant means a
  // missing link is a reset/wipe race — rebuilding here would resurrect the
  // bridge the operator just wiped. 410 is permanent → the event drops.
  private async requireLink(threadId: string): Promise<IntercomLink> {
    const link = await this.store.getLink(threadId);
    if (link) return link;
    throw new IntercomHttpError(410, `No Intercom link for thread ${threadId} (bridge reset/wiped?) — event dropped`);
  }

  // Reserve → call → confirm: the pending-post row is written BEFORE the API
  // call so a webhook that beats the confirm still recognizes the part as our
  // own (body-hash match). The reservation is released on success and on a
  // DEFINITE rejection (a 4xx response proves no part was created) — but kept
  // on ambiguous failures (timeout/network/5xx): the part may have landed, and
  // its webhook must still hash-match. The 1h sweep collects leftovers.
  private async releasePendingPost(pendingId: string, error?: unknown): Promise<void> {
    if (error !== undefined) {
      const definiteReject =
        error instanceof IntercomHttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
      if (!definiteReject) return;
    }
    await this.store.deletePendingPost(pendingId).catch(() => {});
  }

  // Public seam for the Intercom canvas/panel billing actions: internal notes
  // about queued/executed actions reuse the reserve→call→confirm echo ledger
  // and the Operator-first authoring exactly like bridge notes.
  async postPanelNote(threadId: string, conversationId: string, body: string): Promise<void> {
    await this.postAdminNote(threadId, conversationId, body);
  }

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
      await this.releasePendingPost(pendingId);
    } catch (e) {
      await this.releasePendingPost(pendingId, e);
      throw e;
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

  // Payloads stay plain Discord markdown in the DB/workflow state; rendering to
  // Intercom HTML happens here at the choke point, so queued events survive
  // renderer changes.
  private async executeMessage(threadId: string, payload: MessagePayload): Promise<void> {
    await this.deliverMessage(threadId, payload, payload.discordMessageId ?? null);
  }

  // Shared delivery core for message / message_edit / message_delete.
  // deliveryKey (kind "m" ledger): Intercom has no idempotency keys, so a
  // timeout-after-success retry would double-post — check before, record after.
  // The remaining duplicate window (crash between call and record) is the same
  // one the pending-post handshake already tolerates.
  private async deliverMessage(threadId: string, payload: MessagePayload, deliveryKey: string | null): Promise<void> {
    if (deliveryKey && (await this.store.hasDeliveredMessage(deliveryKey))) return;
    const link = await this.requireLink(threadId);
    const { urls, lines } = this.splitAttachments(payload);
    const body = renderDiscordMarkdownToHtml(`${payload.content}${lines}`);

    const send = async (attachmentUrls: string[], finalBody: string): Promise<string | null> => {
      if (payload.direction === "incoming") {
        // Contact-authored parts are never relayed back (the webhook handler
        // only processes admin/bot authors) — no echo bookkeeping needed.
        const { partId } = await this.client.replyAsContact(link.conversationId, {
          intercomUserId: link.contactId,
          body: finalBody,
          createdAtIso: payload.externalCreatedAtIso,
          attachmentUrls,
        });
        return partId;
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
        await this.releasePendingPost(pendingId);
        return partId;
      } catch (e) {
        await this.releasePendingPost(pendingId, e);
        throw e;
      }
    };

    let partId: string | null = null;
    try {
      partId = await send(urls, body);
    } catch (e) {
      // attachment_urls rejected (non-image, dead link, …) → fold into the body.
      if (urls.length > 0 && e instanceof IntercomHttpError && (e.status === 400 || e.status === 422)) {
        const folded = `${body}<p>${urls
          .map((u) => `📎 <a href="${escapeHtmlText(u)}">${escapeHtmlText(u)}</a>`)
          .join("<br>")}</p>`;
        partId = await send([], folded);
      } else {
        throw e;
      }
    }
    // Message map (delete/edit → redact reflection). Only for real Discord
    // message ids (snowflakes) — synthetic keys ("ai:…") aren't deletable.
    // Best-effort: a lost map row only degrades a later delete to the
    // appended-note fallback.
    if (partId && payload.discordMessageId && /^\d+$/.test(payload.discordMessageId)) {
      await this.store
        .recordMessageMap({
          ticketThreadId: threadId,
          direction: "out",
          discordMessageId: payload.discordMessageId,
          partId,
        })
        .catch(() => {});
    }
    if (deliveryKey) await this.store.recordDeliveredMessage(deliveryKey, threadId).catch(() => {});
  }

  // Edits: true reflection is redact-the-old + repost-the-new (Intercom has no
  // part-edit API). The repost re-records the message map, so later deletes
  // and further edits always hit the CURRENT part. Redaction failures degrade
  // to the historical appended-only mirror (the original stays visible). Only
  // fires for messages the ledger confirms were mirrored; each edit stamp
  // mirrors at most once.
  private async executeMessageEdit(threadId: string, payload: MessageEditPayload): Promise<void> {
    if (!(await this.store.hasDeliveredMessage(payload.discordMessageId))) return;
    const deliveryKey = `${payload.discordMessageId}:e${Date.parse(payload.editedAtIso) || payload.editedAtIso}`;
    if (await this.store.hasDeliveredMessage(deliveryKey)) return;
    const map = await this.store.getOutboundMessageMap(payload.discordMessageId);
    if (map && !map.redactedAt) await this.tryRedactPart(threadId, map);
    const prefix =
      payload.direction === "incoming" ? "✏️ Edited my earlier message:" : `✏️ **${payload.authorName}** edited an earlier message:`;
    await this.deliverMessage(
      threadId,
      {
        direction: payload.direction,
        content: `${prefix}\n${payload.content}`,
        // The repost adopts the original message id in the map (upsert), so the
        // NEXT edit/delete redacts this new part.
        discordMessageId: payload.discordMessageId,
        attachments: payload.attachments,
        attachmentMode: "urls",
      },
      deliveryKey
    );
  }

  // Deletes: redact the mirrored part (native Intercom tombstone — the content
  // actually disappears, which is the point for the leaked-secret case).
  // Pre-feature messages have no map row and fall back to the appended note.
  private async executeMessageDelete(threadId: string, payload: MessageDeletePayload): Promise<void> {
    if (!(await this.store.hasDeliveredMessage(payload.discordMessageId))) return;
    const deliveryKey = `${payload.discordMessageId}:del`;
    if (await this.store.hasDeliveredMessage(deliveryKey)) return;
    const map = await this.store.getOutboundMessageMap(payload.discordMessageId);
    if (map?.redactedAt) {
      // Already redacted — this Discord delete IS the reflection of an
      // Intercom-side redaction (or a retried attempt). Nothing to mirror.
      await this.store.recordDeliveredMessage(deliveryKey, threadId).catch(() => {});
      return;
    }
    if (map && (await this.tryRedactPart(threadId, map))) {
      await this.store.recordDeliveredMessage(deliveryKey, threadId).catch(() => {});
      return;
    }
    const content =
      payload.direction === "incoming"
        ? "🗑️ Deleted an earlier message."
        : `🗑️ ${payload.authorName ? `**${payload.authorName}** deleted an earlier message.` : "A Discord message was deleted."}`;
    await this.deliverMessage(threadId, { direction: payload.direction, content }, deliveryKey);
  }

  // Redact one mapped part. Pre-mark → call → rollback-only-on-DEFINITE-reject:
  // the redact triggers a conversation_part.redacted webhook, and the inbound
  // handler must find the stamp already set — otherwise it treats the bridge's
  // own redaction as an agent action and deletes the (edited, still existing)
  // Discord original. Ambiguous failures (timeout/5xx) KEEP the stamp for the
  // same reason: the redact may have landed and its webhook must still be
  // recognized as ours (mirrors the releasePendingPost contract). false =
  // definite rejection (no redact permission / part gone) — the caller
  // degrades to the appended-note mirror.
  private async tryRedactPart(threadId: string, map: IntercomMessageMap): Promise<boolean> {
    const link = await this.requireLink(threadId);
    await this.store.setMessageMapRedactedAt(map.id, new Date());
    try {
      await this.client.redactConversationPart(link.conversationId, map.partId);
      return true;
    } catch (e) {
      if (isPermanent4xx(e)) {
        await this.store.setMessageMapRedactedAt(map.id, null).catch(() => {});
        return false;
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
    let statePutHappened = false;
    const tag = payload.statusTagId ? this.settingsStore.tagById(payload.statusTagId) : undefined;
    const stateId = tag?.intercomTicketStateId ?? null;
    if (link.ticketId && stateId && link.lastSyncedStateId !== stateId) {
      try {
        await this.withAuthor((a) => this.client.updateTicket(link.ticketId!, { stateId, adminId: a }));
        statePutHappened = true;
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
    // transition note — the ticket state itself is the record. forceOpenSync
    // (backfill tail) bypasses the damper: the replay's contact messages
    // auto-reopened the conversation, and "already closed/open" is success.
    const target: "open" | "closed" = payload.closed || payload.resolved ? "closed" : "open";
    if (link.lastSyncedOpen !== target || payload.forceOpenSync) {
      try {
        await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, target === "open", a));
      } catch (e) {
        if (!(payload.forceOpenSync && isPermanent4xx(e))) throw e;
      }
      await this.setTicketOpenParity(link.ticketId, target === "open");
      await this.store.setLastSyncedOpen(threadId, target);
    } else if (target === "closed" && statePutHappened) {
      // The state PUT above auto-reopened the conversation in Intercom (any
      // ticket update does) but the parity damper says it's already closed —
      // re-assert the close or it sits open in the inbox.
      await this.reassertConversationClosed(threadId, link);
    }
  }

  // Intercom auto-reopens a conversation when the bridge updates the linked
  // ticket (state or attributes). When the bridge's last synced state is
  // closed, restore it — otherwise every post-close CSAT write leaves
  // the conversation open for agents (and fires an opened webhook).
  private async reassertConversationClosed(threadId: string, link: IntercomLink): Promise<void> {
    if (link.lastSyncedOpen !== "closed") return;
    try {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, false, a));
    } catch (e) {
      if (!isPermanent4xx(e)) throw e; // "already closed" & co — desired end state
    }
    await this.setTicketOpenParity(link.ticketId, false);
  }

  // Ticket open/closed parity: the ticket's open flag is SEPARATE from its
  // state — a resolved state alone leaves the ticket listed among open
  // tickets. Best-effort: parity must never dead-letter an event ("already
  // closed" and other rejection shapes are the desired end state). The flip's
  // webhook echo is bridge-authored, so the inbound attribution gate drops it.
  private async setTicketOpenParity(ticketId: string | null, open: boolean): Promise<void> {
    if (!ticketId) return;
    try {
      await this.withAuthor((a) => this.client.updateTicket(ticketId, { open, adminId: a }));
    } catch (e) {
      if (!isPermanent4xx(e)) throw e;
    }
  }

  // CSAT: score + the customer's comment. Intercom's native conversation_rating
  // is READ-ONLY via the public REST API (no rate endpoint; ratings originate
  // in Messenger, which these customers never see — verified against the API
  // docs, 1.0–2.15 + Preview), so attributes are the native ceiling:
  //  - ticket attributes "CSAT" + "CSAT Comment" (definitions auto-creatable
  //    via /config → Intercom → Ensure Attributes);
  //  - conversation custom attributes with the same names (definitions can NOT
  //    be API-created — Origin-marker pattern: 4xx-degrade until they are
  //    hand-created in Settings → Data → Conversations).
  // CSAT typically arrives AFTER the close — without the re-assert the
  // attribute writes reopen the conversation in Intercom.
  private async executeCsat(threadId: string, payload: CsatPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    const comment = payload.comment?.trim() ? payload.comment.trim().slice(0, 1024) : null;
    const ticketAttributes: Record<string, unknown> = { [TICKET_ATTR_CSAT]: `${payload.score}/5` };
    // Conversation-side CSAT is a NUMBER attribute (create it as Number in
    // Settings → Data → Conversations) so custom reports can aggregate it
    // (average/median); the ticket attribute keeps the legacy "n/5" string
    // its auto-created definition expects.
    const conversationAttributes: Record<string, unknown> = { [TICKET_ATTR_CSAT]: payload.score };
    if (comment) {
      ticketAttributes[TICKET_ATTR_CSAT_COMMENT] = comment;
      conversationAttributes[TICKET_ATTR_CSAT_COMMENT] = comment;
    }
    if (link.ticketId) {
      try {
        await this.withAuthor((a) => this.client.updateTicket(link.ticketId!, { attributes: ticketAttributes, adminId: a }));
      } catch (e) {
        if (!(e instanceof IntercomHttpError && (e.status === 400 || e.status === 422))) throw e;
      }
    }
    try {
      await this.client.setConversationAttributes(link.conversationId, conversationAttributes);
    } catch (e) {
      // Conversation attribute definitions are UI-only — degrade silently
      // until they exist (same contract as markDiscordOrigin).
      if (!isPermanent4xx(e)) throw e;
    }
    await this.reassertConversationClosed(threadId, link);
  }

  // Agent-idle reminder (bridged ticket, SUPPORT reminder target): internal
  // note + reopen so the conversation resurfaces in the Intercom inbox. The
  // reopen intentionally bypasses the lastSyncedOpen damper — surfacing the
  // conversation IS the point — and updates it afterwards so status parity
  // stays coherent. Echo safety: both parts are bridge-authored (attribution
  // gate drops the webhooks) and the note rides the pending-post handshake.
  private async executeAgentReminder(threadId: string, payload: AgentReminderPayload): Promise<void> {
    const link = await this.requireLink(threadId);
    // Team resolved at post time, not enqueue time — the payload can sit in
    // the outbox while the assignment changes.
    const teamName = await this.resolveAssignedTeamName(link.conversationId);
    // Per-tag override (operator-entered plain text → escaped) replaces the
    // default first line; the thread link and reopen stay either way.
    const raw = payload.noteText ?? `Waiting on an agent reply for ${Math.max(1, Math.round(payload.idleDays))} day(s).`;
    const firstLine = `⏰ <b>${escapeHtmlText(applyTeam(raw, teamName))}</b>`;
    await this.postAdminNote(threadId, link.conversationId, `<p>${firstLine}</p>`, undefined, true);
    try {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, true, a));
    } catch (e) {
      if (!isPermanent4xx(e)) throw e; // "already open" & co — desired end state
    }
    await this.store.setLastSyncedOpen(threadId, "open");
  }

  // Name of the team currently assigned to the conversation, falling back to
  // the configured routing team, then a generic label. Never throws — the
  // team name only decorates the reminder note, which must post regardless.
  private async resolveAssignedTeamName(conversationId: string): Promise<string> {
    const stats = await this.client.getConversationIdleStats(conversationId).catch(() => null);
    const teamId = stats?.teamAssigneeId ?? this.settingsStore.intercomTeamId();
    const name = teamId ? await this.client.getTeamNameCached(teamId).catch(() => null) : null;
    return name ?? "the support team";
  }
}

export function isPermanent4xx(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

// Intercom rejects a transition to the ticket's current state with a 400 —
// for the bridge that outcome IS the desired end state.
function isSameStateError(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status === 400 && /same state/i.test(e.message);
}

// Assigning a ticket/conversation to the assignee it already has is rejected
// with a 422 — also the desired end state (routine on ensure re-runs).
function isAlreadyAssignedError(e: unknown): boolean {
  return e instanceof IntercomHttpError && e.status === 422 && /already assigned/i.test(e.message);
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
