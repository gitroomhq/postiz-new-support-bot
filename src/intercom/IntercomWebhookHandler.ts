import { AttachmentPayload, Client, EmbedBuilder, ThreadChannel, Webhook } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { StatusService } from "../bot/StatusService";
import { AuditLogger } from "../bot/AuditLogger";
import { COLORS } from "../util/embeds";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService } from "./IntercomSyncService";
import { IntercomClient } from "./IntercomClient";
import { bodyHash } from "./renderDiscordMarkdown";
import { isPermanent4xx } from "./IntercomEventExecutor";
import { TemporalBufferedError, type TemporalProducers } from "../temporal/producers";
import { INTERCOM_MAX_ECHO_DEFERS } from "../temporal/types";
import { log } from "../util/logger";
import { safeFetch } from "../util/safeFetch";
import {
  IntercomConversationItem,
  IntercomTicketItem,
  IntercomWebhookEvent,
  IntercomWebhookPart,
} from "./types";

// Thrown while the thread still has in-flight outbound content that could be
// the origin of this part — the inbox workflow retries shortly instead of
// risking a double-post. Bounded: after MAX_DEFER_ATTEMPTS the part is relayed
// anyway (a rare duplicate beats a lost agent reply).
export class DeferEchoError extends Error {
  constructor() {
    super("outbound content in flight — deferring echo decision");
    this.name = "DeferEchoError";
  }
}

// The webhook topics the bridge handles — the SINGLE source for every place
// that instructs the operator what to subscribe in the Developer Hub (panel,
// secrets-modal follow-up). Subscriptions are Developer-Hub-only (no public
// API), so drift between instruction texts silently disables features.
// Over-subscribing is harmless: accept() drops anything not in this list
// BEFORE it reaches Temporal, so "click everything" costs only the HTTP
// delivery itself (conversation.user.replied is the noisiest extra — it fires
// once per customer message the bridge mirrors).
export const INTERCOM_WEBHOOK_TOPICS = [
  "conversation.admin.replied",
  "conversation.operator.replied",
  "conversation.admin.noted",
  "conversation.admin.closed",
  "conversation.admin.opened",
  "conversation.admin.snoozed",
  "conversation.admin.unsnoozed",
  // conversation.priority.updated left this list with the priority axis
  // (agent-rip) — unsubscribe it in the Developer Hub; deliveries drop at the
  // door until then.
  "ticket.state.updated",
  "ticket.admin.replied",
  "ticket.note.created",
  // SLA manager triggers for NATIVE (unbridged) conversations: creation and
  // customer replies re-run the SLA rules. Bridged conversations return early
  // (one indexed link lookup) — the Discord-side hooks own them. Requires the
  // manual Developer Hub subscription like every other topic here.
  "conversation.user.created",
  "conversation.user.replied",
  // Balanced assignment + the intercom.assignee SLA rule dim: keeps the
  // assignment-echo damper (IntercomLink.lastAssigneeId) fresh and re-runs
  // SLA rules when a teammate takes over. Manual Developer Hub subscription
  // required (new since the bot-native SLA engine).
  "conversation.admin.assigned",
] as const;

// Shared with intercomInboxWorkflow's defer loop — see INTERCOM_MAX_ECHO_DEFERS.
const MAX_DEFER_ATTEMPTS = INTERCOM_MAX_ECHO_DEFERS;

// Handled but deliberately NOT in INTERCOM_WEBHOOK_TOPICS: that const feeds the
// operator-facing subscription instructions, which stay unchanged by operator
// choice — the topic is accepted at the door and simply never fires until it
// is subscribed manually in the Developer Hub.
const EXTRA_HANDLED_TOPICS = ["conversation_part.redacted"] as const;

const HANDLED_TOPICS: ReadonlySet<string> = new Set([...INTERCOM_WEBHOOK_TOPICS, ...EXTRA_HANDLED_TOPICS]);

// Discord "Unknown Message" — the relayed/origin message is already gone.
const DISCORD_UNKNOWN_MESSAGE = 10008;
// Discord "Missing Permissions" — bot lacks Manage Messages for the origin delete.
const DISCORD_MISSING_PERMISSIONS = 50013;

// Native re-upload cap for relayed Intercom attachments: Discord's baseline
// upload limit for bots. Bigger files keep the 📎 link fallback.
const MAX_RELAY_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_RELAY_FILES = 10;
// Per-file and TOTAL download deadlines. The total must stay well inside the
// inbound activity's 1-minute startToCloseTimeout — a relay that dawdles past
// it re-runs as a Temporal retry (the part-id claim drops it, losing the reply).
const RELAY_DOWNLOAD_TIMEOUT_MS = 10_000;
const RELAY_DOWNLOAD_BUDGET_MS = 30_000;

// Intercom's attachment / inline-image CDN hosts (suffix match). Relay
// downloads are restricted to these; an unlisted host degrades to a masked 📎
// link (safe fallback) rather than a server-side fetch — see safeFetch.
const INTERCOM_CDN_HOSTS = [
  ".intercomcdn.com",
  ".intercomcdn.eu",
  ".intercomcdn.au",
  ".intercomusercontent.com",
  ".intercomassets.com",
  ".intercom-attachments-1.com",
  ".intercom-attachments-2.com",
  ".intercom-attachments-3.com",
  ".intercom-attachments-4.com",
  ".intercom-attachments-5.com",
  ".intercom-attachments-6.com",
  ".intercom-attachments-7.com",
  ".intercom-attachments-8.com",
  ".intercom-attachments-9.com",
];

// Discord "Unknown Channel" — the thread was deleted, not a transient failure.
const DISCORD_UNKNOWN_CHANNEL = 10003;

// Handles inbound Intercom webhooks. The HTTP route only calls accept()
// (a signal into the per-conversation workflow); the processInboundEvent
// activity drives process(), which THROWS on transient failures so the
// workflow retries — nothing is lost to a crash mid-handle.
//
// Echo suppression is layered: part-id ledger (claimPart) → pending-post
// body-hash match (reserve→confirm handshake with the outbox) → bounded defer
// while outbound content is in flight → relay.
//
// Constructed before the Discord client exists (CallbackServer needs the
// handler at bot construction time), so the client is bound late.
export class IntercomWebhookHandler {
  private client: Client | null = null;

  // Throttle for the webhook-health stamp (one settings write per minute, not
  // per event).
  private lastInboundStampMs = 0;
  private wbLog = log.child("intercom:webhook");

  constructor(
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private store: IntercomStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger,
    private intercomClient: IntercomClient
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // Temporal seam: inbound events are signalled into the per-conversation
  // intercomInboxWorkflow (dedup via its deliveryId ring) whenever Temporal is
  // configured — even while the worker is paused, the signal parks server-side
  // and processes on resume. A buffered signal (Temporal down) throws so the
  // route answers 500 and Intercom's single retry redelivers.
  private temporalProducers: TemporalProducers | null = null;

  // SLA manager — bound late from index.ts; handles the native-conversation
  // trigger topics (conversation.user.created / .replied) and the bridged
  // assignee-change re-eval (the intercom.assignee rule dim).
  private slaService: {
    applyForNative(conversationId: string, reason: string): Promise<unknown>;
    onTicketTrigger(threadId: string, reason: "assignee"): Promise<void>;
  } | null = null;

  setSlaService(service: {
    applyForNative(conversationId: string, reason: string): Promise<unknown>;
    onTicketTrigger(threadId: string, reason: "assignee"): Promise<void>;
  }): void {
    this.slaService = service;
  }

  // Balanced assignment — bound late from index.ts.
  private assignmentService: {
    maybeAssignOnCreate(conversationId: string, teamId: string | null, threadId: string | null, ticketId: string | null): Promise<void>;
    maybeReassignOnCustomerReply(
      conversationId: string,
      currentAssigneeId: string | null,
      teamId: string | null,
      threadId: string | null,
      ticketId: string | null
    ): Promise<void>;
  } | null = null;

  setAssignmentService(service: NonNullable<IntercomWebhookHandler["assignmentService"]>): void {
    this.assignmentService = service;
  }

  // Sentry feedback import ledger — bound late. Creation-time balanced
  // assignment must not race the importer's own paced decoration writes.
  private sentryFeedbackStore: { getByConversationId(conversationId: string): Promise<unknown> } | null = null;

  setSentryFeedbackStore(store: NonNullable<IntercomWebhookHandler["sentryFeedbackStore"]>): void {
    this.sentryFeedbackStore = store;
  }

  // SLA enforcement engine — bound late; owns the unsnooze re-anchor for the
  // next-reply clock.
  private slaEnforcer: { reanchorAfterUnsnooze(conversationId: string): Promise<void> } | null = null;

  setSlaEnforcer(enforcer: { reanchorAfterUnsnooze(conversationId: string): Promise<void> }): void {
    this.slaEnforcer = enforcer;
  }

  setTemporalProducers(producers: TemporalProducers): void {
    this.temporalProducers = producers;
  }

  // HTTP-route half: durably queue the event and return. Never relays inline
  // while Temporal is configured. Returns false for duplicate deliveries.
  async accept(body: unknown): Promise<boolean> {
    // Webhook-health stamp: this call only happens after HMAC verification, so
    // it proves subscription + secret are alive (shown on the /config panel).
    const nowMs = Date.now();
    if (nowMs - this.lastInboundStampMs > 60_000) {
      this.lastInboundStampMs = nowMs;
      void this.settingsStore.setIntercomLastInboundAt(new Date()).catch(() => {});
    }
    const event = body as IntercomWebhookEvent;
    const topic = event?.topic;
    if (!topic || topic === "ping") return true;
    // Door filter: operators may subscribe every topic in the Developer Hub —
    // anything the bridge doesn't handle is dropped HERE, before it costs a
    // Temporal signal / inbox workflow (conversation.user.replied alone would
    // otherwise fire once per mirrored customer message). process() keeps its
    // unknown-topic default as a backstop.
    if (!HANDLED_TOPICS.has(topic)) return true;
    if (this.temporalProducers?.routable()) {
      // Per-item serialization key: conversation id for conversation.* topics,
      // ticket id for ticket.* — handlers are convergent/damped, so distinct
      // workflows per kind are fine (matches the old durable queue's guarantees).
      const itemId = (event?.data?.item as { id?: unknown } | undefined)?.id;
      const key = itemId != null ? String(itemId) : null;
      if (!key) return true; // nothing to key on — same as an unknown topic: drop
      const r = await this.temporalProducers.inboundIntercomEvent(key, {
        deliveryId: event.id ?? null,
        topic,
        payload: body,
      });
      if (!r.ok && r.buffered) {
        throw new TemporalBufferedError("intercom event buffered — Intercom should redeliver");
      }
      return r.ok;
    }
    // Direct fallback (Temporal unconfigured — bootstrap state): best-effort
    // inline handling with no durable queue. Echo decisions can't defer here,
    // so process with the defer budget exhausted (a rare duplicate beats a
    // lost agent reply); a transient throw becomes a 500 and Intercom's single
    // retry redelivers.
    await this.process(topic, body, MAX_DEFER_ATTEMPTS);
    return true;
  }

  // Scheduler half: dispatch one queued event. Throws on transient failure
  // (retried by the inbox scheduler with backoff).
  async process(topic: string, body: unknown, attempt: number): Promise<void> {
    const event = body as IntercomWebhookEvent;
    const item = event?.data?.item;
    switch (topic) {
      case "conversation.admin.replied":
      case "conversation.operator.replied":
        await this.handleConversationReply(item as IntercomConversationItem, attempt);
        return;
      case "conversation.admin.noted":
        await this.handleConversationNoted(item as IntercomConversationItem);
        return;
      case "conversation.admin.closed":
        await this.handleConversationOpenState(item as IntercomConversationItem, "closed", attempt);
        return;
      case "conversation.admin.opened":
        await this.handleConversationOpenState(item as IntercomConversationItem, "open", attempt);
        return;
      case "conversation.admin.snoozed":
        await this.handleConversationSnoozed(item as IntercomConversationItem);
        return;
      case "conversation.admin.unsnoozed":
        await this.handleConversationUnsnoozed(item as IntercomConversationItem);
        return;
      case "ticket.state.updated":
        await this.handleTicketStateUpdated(item as IntercomTicketItem);
        return;
      case "ticket.admin.replied":
        await this.handleTicketReply(item as IntercomTicketItem, attempt);
        return;
      case "ticket.note.created":
        await this.handleTicketNoteCreated(item as IntercomTicketItem);
        return;
      case "conversation_part.redacted":
        await this.handlePartRedacted(item as IntercomConversationItem | undefined);
        return;
      case "conversation.user.created":
      case "conversation.user.replied":
        await this.handleInboundConversationActivity(item as IntercomConversationItem | undefined, topic);
        return;
      case "conversation.admin.assigned":
        await this.handleAdminAssigned(item as IntercomConversationItem | undefined);
        return;
      default:
        return; // unknown topic — drop
    }
  }

  // Inbound customer activity. Two jobs:
  //  - assignment: creation assigns natives to the pool (bridged creation is
  //    hooked in ensureBridge); a customer reply landing on an away/gone
  //    assignee re-routes (bridged AND native — covers reopens).
  //  - SLA rules for NATIVE conversations. Bridged conversations return early
  //    — their Discord-side hooks fire in the same flow that mirrored the
  //    message, and the per-ticket outbox owns ordering.
  // Transient SlaService failures rethrow → the inbox scheduler's retry
  // machinery redelivers. Assignment is best-effort by construction.
  private async handleInboundConversationActivity(
    item: IntercomConversationItem | undefined,
    topic: string
  ): Promise<void> {
    const conversationId = item?.id != null ? String(item.id) : null;
    if (!conversationId) return;
    const link = await this.store.getLinkByConversationId(conversationId).catch(() => null);
    // The conversation's team scopes its balanced-assignment pool + config
    // (Intercom's own routing rules set team_assignee_id; bridged tickets carry
    // the bot's routing team).
    const teamId =
      item?.team_assignee_id != null && String(item.team_assignee_id) !== "0" ? String(item.team_assignee_id) : null;
    if (this.assignmentService) {
      if (topic === "conversation.user.created" && !link) {
        // Sentry feedback imports skip the creation balancer: Intercom builds
        // this payload at DELIVERY time, so it can already carry the team the
        // importer routed mid-decoration — balancing here races the importer's
        // remaining team-routing writes (observed assign→unassign churn). The
        // enforcer's stray sweep balances imports once the dust settles and
        // mirrors the pick onto the converted ticket.
        const feedback = this.sentryFeedbackStore
          ? await this.sentryFeedbackStore.getByConversationId(conversationId).catch(() => null)
          : null;
        if (!feedback) {
          await this.assignmentService.maybeAssignOnCreate(conversationId, teamId, null, null).catch(() => undefined);
        }
      } else if (topic === "conversation.user.replied") {
        const assigneeId = item?.admin_assignee_id != null && String(item.admin_assignee_id) !== "0"
          ? String(item.admin_assignee_id)
          : null;
        await this.assignmentService
          .maybeReassignOnCustomerReply(conversationId, assigneeId, teamId, link?.ticketThreadId ?? null, link?.ticketId ?? null)
          .catch(() => undefined);
      }
    }
    if (link) return; // bridged — Discord-side SLA hooks own it
    if (!this.slaService) return;
    await this.slaService.applyForNative(conversationId, topic);
  }

  // Assignee changed (bot or human). Bridged: refresh the lastAssigneeId
  // damper and — only for HUMAN (non-echo) changes — re-run the SLA rules
  // (the intercom.assignee dim can flip the target). Native: re-run rules
  // directly. Never moves the rotation cursor: fairness comes from live load
  // counts, and a human grab shouldn't skip anyone's turn.
  private async handleAdminAssigned(item: IntercomConversationItem | undefined): Promise<void> {
    const conversationId = item?.id != null ? String(item.id) : null;
    if (!conversationId) return;
    const assigneeId =
      item?.admin_assignee_id != null && String(item.admin_assignee_id) !== "0" ? String(item.admin_assignee_id) : null;
    const link = await this.store.getLinkByConversationId(conversationId).catch(() => null);
    if (link) {
      const previous = link.lastAssigneeId ?? null;
      if (previous === assigneeId) return; // our own assignment echoing back
      await this.store.setLastAssigneeId(link.ticketThreadId, assigneeId).catch(() => undefined);
      await this.slaService?.onTicketTrigger(link.ticketThreadId, "assignee").catch(() => undefined);
      return;
    }
    await this.slaService?.applyForNative(conversationId, "conversation.admin.assigned").catch(() => undefined);
  }

  // Agent deleted (redacted) a message in Intercom → reflect on the Discord
  // side. The message map tells this apart by direction:
  //  - "in":   a relayed agent reply → delete the relayed Discord message;
  //  - "out":  a mirrored Discord message (customer/staff) → delete the ORIGIN
  //            Discord message (leaked-secret parity; Manage Messages needed).
  // ("note"-direction rows are historical only — inbound note storage was
  // removed with the agent-rip; their delete below no-ops on Unknown Message.)
  // The bridge's own redactions (Discord delete/edit → redact) pre-stamp
  // redactedAt on the map row, so their webhook echo drops here.
  //
  // Payload shape: Intercom ships data.item as the CONVERSATION for this topic
  // (the Developer Hub webhook reference lists its item type as Conversation),
  // with the affected part(s) flagged `redacted: true` inside
  // conversation_parts — and deletion payloads can be minimal, carrying no
  // parts at all, so an API fetch of the full part list is the reliable
  // fallback. A part-shaped item is still accepted in case older payload
  // versions deliver the part directly.
  private async handlePartRedacted(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() === "none") return;
    if (!item || item.id == null) return;

    if (item.type === "conversation_part") {
      await this.reflectRedactedPart(String(item.id));
      return;
    }
    // Shape guard: treating an unknown item kind's id as a conversation id is
    // harmless (the link lookup below misses), but only conversation-shaped
    // (or untyped) items proceed.
    if (item.type && item.type !== "conversation") return;

    const conversationId = String(item.id);
    const link = await this.store.getLinkByConversationId(conversationId);
    if (!link) return; // Intercom-native conversation — not ours

    const redactedOf = (parts?: IntercomWebhookPart[]) =>
      (parts ?? []).filter((p) => p.redacted === true && p.id != null);

    let redactedParts = redactedOf(item.conversation_parts?.conversation_parts);
    if (redactedParts.length === 0) {
      // Minimal payload — pull every part and reflect all redacted ones.
      // Convergent: already-reflected parts drop on their redactedAt stamp,
      // never-bridged ones only tombstone. A permanent 4xx (conversation
      // deleted) leaves nothing to reflect; transient errors throw so the
      // inbox workflow retries.
      try {
        redactedParts = redactedOf(await this.intercomClient.getConversationPartsSince(conversationId, 0));
      } catch (e) {
        if (isPermanent4xx(e)) return;
        throw e;
      }
    }
    for (const part of redactedParts) {
      await this.reflectRedactedPart(String(part.id));
    }
  }

  // Reflect one redacted conversation part onto Discord via its map row.
  private async reflectRedactedPart(partId: string): Promise<void> {
    const map = await this.store.getMessageMapByPartId(partId);
    if (!map) {
      // Unknown part: never relayed/mirrored, or pre-feature. Claim the id so
      // an in-flight relay racing this redaction can't post deleted content
      // (the reply relay claims the same key first in the normal order). The
      // thread id is unknown here — the claim row is purely a tombstone.
      await this.store.claimPart("c", partId, "").catch(() => {});
      return;
    }
    if (map.redactedAt) return; // the bridge's own redact echoing back, or a duplicate delivery

    // Stamp first (damps the origin delete's messageDelete → message_delete
    // round trip), roll back on transient failure so the retry can run again.
    await this.store.setMessageMapRedactedAt(map.id, new Date());
    try {
      await this.deleteDiscordMessageForRedaction(map);
    } catch (e) {
      await this.store.setMessageMapRedactedAt(map.id, null).catch(() => {});
      throw e;
    }
  }

  // Delete the Discord half of a redacted part. Relayed replies ("in") go
  // through the relay webhook when possible; origin messages ("out") need
  // Manage Messages — a permission rejection degrades to an audit warning
  // instead of retrying forever.
  private async deleteDiscordMessageForRedaction(map: {
    ticketThreadId: string;
    direction: string;
    discordMessageId: string;
    via: string | null;
  }): Promise<void> {
    const thread = await this.requireThread(map.ticketThreadId);
    if (!thread) return; // thread permanently gone — nothing left to delete

    if (map.direction === "in" && map.via === "webhook") {
      const webhook = await this.getRelayWebhook(thread);
      if (webhook) {
        try {
          await webhook.deleteMessage(map.discordMessageId, thread.id);
          return;
        } catch (e) {
          if ((e as { code?: number }).code === DISCORD_UNKNOWN_MESSAGE) return; // already gone
          // Webhook rotated/deleted — fall through to the bot-side delete.
        }
      }
    }

    let message;
    try {
      message = await thread.messages.fetch(map.discordMessageId);
    } catch (e) {
      if ((e as { code?: number }).code === DISCORD_UNKNOWN_MESSAGE) return; // already gone
      throw e; // transient — retried by the inbox workflow
    }
    try {
      await message.delete();
    } catch (e) {
      if ((e as { code?: number }).code === DISCORD_UNKNOWN_MESSAGE) return;
      if ((e as { code?: number }).code === DISCORD_MISSING_PERMISSIONS) {
        void this.audit.log({
          title: "⚠️ Intercom redaction not reflected",
          severity: "warn",
          actor: "Intercom bridge",
          threadId: map.ticketThreadId,
          fields: [
            { name: "Message", value: map.discordMessageId, inline: true },
            { name: "Reason", value: "Bot lacks Manage Messages — delete the Discord message manually.", inline: false },
          ],
        });
        return;
      }
      throw e;
    }
    // Successful reflections are deliberately silent (user request) — only the
    // Missing Permissions degradation above is audit-worthy, since it needs a
    // manual delete.
  }

  private async handleConversationReply(item: IntercomConversationItem | undefined, attempt: number): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return; // Intercom-native conversation — not ours

    const parts = item.conversation_parts?.conversation_parts ?? [];
    await this.relayReplyParts("c", "conversation.admin.replied", String(item.id), link, parts, attempt);
    await this.diffTags(link.ticketThreadId, item);
  }

  private async handleTicketReply(item: IntercomTicketItem | undefined, attempt: number): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;

    const parts = item.ticket_parts?.ticket_parts ?? [];
    await this.relayReplyParts("t", "ticket.admin.replied", String(item.id), link, parts, attempt);
  }

  // Reply-topic relay with an API fallback: Intercom's reply payload sometimes
  // carries only a side-effect part and NOT the comment itself. When the agent
  // replies and assigns/closes/reopens in ONE composer action, the reply body
  // rides ON that state part and no comment part exists anywhere — the
  // candidate filter relays those directly. When the payload still has no
  // relayable content (e.g. a bare assignment while the comment rides another
  // delivery), pull the recent parts from the API and run them through the
  // normal relay path (the part-id ledger dedups anything already handled
  // elsewhere).
  private async relayReplyParts(
    kind: "c" | "t",
    topic: string,
    itemId: string,
    link: { ticketThreadId: string; conversationId: string },
    parts: IntercomWebhookPart[],
    attempt: number
  ): Promise<void> {
    const relayable = (list: IntercomWebhookPart[]) => list.filter((p) => this.isRelayCandidate(p));

    if (relayable(parts).length > 0) {
      for (const part of parts) {
        await this.processAgentPart(kind, link.ticketThreadId, part, attempt);
      }
      return;
    }

    // No comment in the payload — fetch the conversation's recent parts.
    const sinceUnix = Math.floor(Date.now() / 1000) - 15 * 60;
    const fetched = await this.intercomClient.getConversationPartsSince(link.conversationId, sinceUnix).catch(() => []);
    const fetchedRelayable = relayable(fetched);
    if (fetchedRelayable.length > 0) {
      // Fetched parts are conversation parts regardless of the trigger topic.
      for (const part of fetchedRelayable) {
        await this.processAgentPart("c", link.ticketThreadId, part, attempt);
      }
      return;
    }

    // Still nothing — surface it (Discord-visible; prod has no log access):
    // an agent reply may be vanishing and this is the only trace.
    const shape =
      parts.length === 0
        ? "payload carried NO parts (API fallback also found none)"
        : `${parts
            .map((p) => `type=${p.part_type ?? "?"} author=${p.author?.type ?? "?"} id=${p.id ?? "?"}`)
            .join(" · ")
            .slice(0, 900)} (API fallback also found none)`;
    void this.audit.log({
      title: "🌉 Intercom reply not relayable",
      severity: "warn",
      actor: "Intercom bridge",
      threadId: link.ticketThreadId,
      fields: [
        { name: "Topic", value: topic, inline: true },
        { name: "Item", value: itemId, inline: true },
        { name: "Parts", value: shape, inline: false },
      ],
    });
  }

  // Manual-heal entry (Heal Message Gaps button): feed API-fetched
  // conversation parts straight through the normal relay path — repairs agent
  // replies whose webhook relay was dropped (e.g. the reply-and-assign
  // `assignment` shape before the candidate filter covered it). Deliberately
  // NO API fallback and NO "not relayable" audit: most healed tickets have no
  // new agent content, which is the expected case, not a warning. Returns the
  // number of candidate parts fed through — already-relayed and bridge-created
  // ones no-op on the part-id claim, so the count is "re-checked", not
  // "reposted". bi-only: relaying is meaningless in push/none, and a heal in
  // push mode must not blast agent warnings across every conversation.
  async relayHealedParts(threadId: string, parts: IntercomWebhookPart[]): Promise<number> {
    if (this.settingsStore.intercomMode() !== "bi") return 0;
    let candidates = 0;
    for (const part of parts) {
      if (!this.isRelayCandidate(part)) continue;
      candidates++;
      // Defer budget exhausted (like the none→bi gap heal): this is a manual
      // pass with no retry loop behind it; layers 1+2 still cover in-flight
      // echoes, and a rare duplicate beats a lost agent reply.
      await this.processAgentPart("c", threadId, part, MAX_DEFER_ATTEMPTS);
    }
    return candidates;
  }

  // Filter for parts that may carry a customer-facing agent message.
  // Contact-authored parts can only be our own mirror (customers have no
  // Intercom access) — only admin/bot/team authors pass. `comment` and
  // `quick_reply` ARE replies; `assignment`/`close`/`open` are state parts
  // that carry the reply body when the agent replied-and-assigned,
  // replied-and-closed, or replied on a closed conversation in ONE composer
  // action — Intercom ships NO separate comment part for those (observed live
  // 2026-07-16: reply-and-auto-assign delivered only a body-bearing
  // `assignment` part, so the old comment-only filter dropped the reply and
  // the API fallback found nothing either). State parts qualify only when
  // they actually carry content: a bare assignment/open/close is a pure state
  // event, and counting it as relayable would short-circuit the API fallback
  // that hunts for the real comment. `note`-typed parts stay excluded on
  // every path — notes are internal-only (they surface via the noted topics
  // as staff-note audit embeds, never in the customer thread). Redacted parts
  // never relay: full-history heal fetches see agent-deleted parts, and their
  // tombstone must not reach the customer.
  private isRelayCandidate(part: IntercomWebhookPart): boolean {
    if (part.id == null || part.redacted === true) return false;
    const authorType = part.author?.type;
    if (authorType && !["admin", "bot", "team"].includes(authorType)) return false;
    const type = part.part_type;
    if (!type || type === "comment" || type === "quick_reply") return true;
    if (type !== "assignment" && type !== "close" && type !== "open") return false;
    const { text, images } = extractAgentBody(part.body ?? "");
    return text.trim().length > 0 || images.length > 0 || (part.attachments ?? []).some((a) => Boolean(a.url));
  }

  // Shared relay path for agent-authored reply-bearing parts, conversation- or
  // ticket-side. Claims each part exactly once; push mode warns instead of
  // relaying; bi mode posts the embed into the Discord thread.
  private async processAgentPart(kind: "c" | "t", threadId: string, part: IntercomWebhookPart, attempt: number): Promise<void> {
    if (!this.isRelayCandidate(part)) return;

    // Layer 1 — part-id ledger: false = the bridge created this part (recorded
    // at post time) or another delivery already claimed it.
    if (!(await this.store.claimPart(kind, String(part.id), threadId))) return;

    // Everything past the claim can fail transiently (Discord fetch/send). Any
    // throw must roll the claims back, or the Temporal retry finds the part
    // already claimed, early-returns, and the reply is silently lost while the
    // activity reports success.
    let relayKey: string | null = null;
    try {
      const partHash = bodyHash(part.body ?? "");
      const bridgeAuthor = this.isBridgeAuthor(part);

      if (bridgeAuthor) {
        // Layer 2 — reserve→confirm handshake: a matching pending-post row means
        // this is our own in-flight post whose confirm hasn't landed yet. Record
        // the part id so a duplicate delivery is also caught, then drop.
        if (await this.store.matchAndDeletePendingPost(threadId, partHash)) {
          await this.store.recordEchoPart(kind, String(part.id), threadId).catch(() => {});
          return;
        }
        // Operator/Fin-authored parts are AMBIGUOUS, not always ours: the
        // bridge authors its posts as the Operator (withAuthor, no seat
        // cost), but a live Fin answers customers under the same identity —
        // the old unconditional identity drop here silently swallowed every
        // genuine Fin reply. Echo suppression stays layered and deterministic
        // instead: the part-id claim (layer 1) kills everything the confirm
        // step recorded, the pending-post match above covers in-flight posts,
        // and the defer below holds the reserve→confirm race window. The one
        // Operator-specific guard left is content-shaped: 🤖-prefixed text is
        // backfill-mirrored bot output (composeMessage stamps it, nobody
        // hand-types it) — the exact shape that once echoed back into Discord
        // as "Fin" under backfill load.
        const operatorId = this.settingsStore.intercomOperatorAdminId();
        const partAuthorId = part.author?.id != null ? String(part.author.id) : null;
        if (
          operatorId &&
          partAuthorId === operatorId &&
          extractAgentBody(part.body ?? "").text.trim().startsWith("🤖")
        ) {
          await this.store.recordEchoPart(kind, String(part.id), threadId).catch(() => {});
          return;
        }
        // Layer 3 — bounded defer (every bridge-capable author, Operator
        // included): outbound content still queued for this thread could
        // produce this exact part — hold until the confirm lands, then the
        // retried claim collides. The catch below rolls the claim back so the
        // retry can claim again. `attempt` is the echo-defer count (tracked
        // separately from real-failure attempts), so deferral can't exhaust
        // the retry budget.
        if (attempt < MAX_DEFER_ATTEMPTS && (await this.hasPendingOutboundContent(threadId))) {
          throw new DeferEchoError();
        }
      }

      const mode = this.settingsStore.intercomMode();
      if (mode === "push") {
        // One-way mirror: warn the agent (once per conversation) that replies here
        // don't reach the customer. markAgentWarned is the race-safe claim.
        if (await this.store.markAgentWarned(threadId)) {
          await this.sync.enqueueAgentWarning(threadId);
        }
        return;
      }

      const { text: bodyText, images: inlineImages } = extractAgentBody(part.body ?? "");
      const attachmentRefs = dedupeByUrl([
        ...(part.attachments ?? [])
          .filter((a): a is { url: string; name?: string | null } => Boolean(a.url))
          .map((a) => ({ url: a.url, name: a.name ?? null })),
        ...inlineImages,
      ]);
      if (!bodyText && attachmentRefs.length === 0) return; // genuinely empty part — nothing to relay, keep the claim

      // Layer 4 — cross-topic duplicate guard (same reply arriving on another
      // topic with a different part id). DB-backed: survives restarts. The
      // duplicate pair keeps its author and created_at across topics, so both
      // scope the key: body hash alone collapsed DISTINCT replies with the
      // same normalized text ("test" then "Test") inside the freshness window
      // into one relay — silent loss, hit live 2026-07-15 once customer-type
      // converts made both topics fire for every reply.
      relayKey = `reply:${part.author?.id ?? "a?"}:${part.created_at ?? "t?"}:${bodyHash(
        [part.body ?? "", ...attachmentRefs.map((a) => a.url)].join("\n")
      )}`;
      if (!(await this.store.claimRelay(threadId, relayKey))) return;

      const thread = await this.requireThread(threadId);
      if (!thread) return; // thread permanently deleted — link disconnected

      const avatar = part.author?.avatar;
      let avatarUrl = typeof avatar === "string" ? avatar : avatar?.image_url ?? null;
      if (!avatarUrl && part.author?.id != null) {
        // Payloads don't always carry the author avatar — the /admins cache does.
        const admin = await this.lookupAdmin(String(part.author.id));
        avatarUrl = admin?.avatarUrl ?? null;
        if (!avatarUrl) {
          this.wbLog.info("agent avatar unresolved (payload + /admins both empty)", {
            "intercom.admin_id": String(part.author.id),
            "intercom.admin_known": admin != null,
          });
        }
      }
      const authorName = part.author?.name || "Intercom agent";

      // Native attachment rendering: download and re-upload as real Discord
      // files (images render inline, no 📎 link line); download failures and
      // oversized files keep the 📎 masked-link fallback.
      const { files, linkLines } = await this.downloadRelayAttachments(attachmentRefs);
      const description = truncateEmbedText([bodyText, linkLines.join("\n")].filter(Boolean).join("\n\n"), 4096);

      // Posting into an archived thread: un-archive, send, re-archive. The lock
      // state stays untouched, and the message is bot/webhook-authored, so
      // handleMessage ignores it (no reclose interference, no re-mirror).
      const wasArchived = thread.archived === true;
      if (wasArchived) await thread.setArchived(false).catch(() => {});
      const ticket = await this.ticketStore.getByThreadId(threadId);
      try {
        // Preferred: webhook impersonation — the reply renders as if the agent
        // wrote natively in Discord (their name + Intercom avatar as the
        // message author). Falls back to the neutral embed when the bot lacks
        // Manage Webhooks or the webhook send fails.
        // Ping cadence: cm → am(ping) → am(no ping) → cm → am(ping) — mention
        // the customer only on the FIRST agent reply of each exchange turn, so
        // an agent sending several messages in a row pings once, and the next
        // ping arrives only after the customer has spoken again.
        const ping = ticket ? await this.shouldPingCustomer(thread, ticket).catch(() => true) : false;
        const pingedCustomerId = ping ? ticket?.customerId ?? null : null;
        const mention = pingedCustomerId ? `<@${pingedCustomerId}>` : "";
        const content = truncateEmbedText([mention, description].filter(Boolean).join("\n"), 2000);
        let via: "webhook" | "bot" = "webhook";
        let messageId = await this.relayViaWebhook(thread, pingedCustomerId, authorName, avatarUrl, {
          content,
          files,
        });
        if (!messageId) {
          via = "bot";
          const embed = new EmbedBuilder()
            .setColor(COLORS.brand)
            .setAuthor({ name: authorName, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
            .setTimestamp();
          if (description) embed.setDescription(description);
          const sent = await thread.send({
            content: pingedCustomerId ? `<@${pingedCustomerId}>` : undefined,
            embeds: [embed],
            files,
            allowedMentions: { users: pingedCustomerId ? [pingedCustomerId] : [] },
          });
          messageId = sent.id;
        }
        // Message map: lets an Intercom-side redaction of this part delete the
        // relayed Discord message again. Best-effort — a lost row only means
        // that one reply can't be auto-removed later.
        await this.store
          .recordMessageMap({
            ticketThreadId: threadId,
            direction: "in",
            discordMessageId: messageId,
            partId: String(part.id),
            via,
          })
          .catch(() => {});
      } finally {
        if (wasArchived) await thread.setArchived(true).catch(() => {});
      }
    } catch (e) {
      await this.releaseClaim(kind, String(part.id));
      if (relayKey) await this.store.releaseRelay(threadId, relayKey).catch(() => {});
      throw e;
    }
  }

  private isBridgeAuthor(part: IntercomWebhookPart): boolean {
    const authorId = part.author?.id != null ? String(part.author.id) : null;
    if (!authorId) return false;
    return (
      authorId === this.settingsStore.intercomOperatorAdminId() || authorId === this.settingsStore.intercomAdminId()
    );
  }

  // How long a turn's no-ping suppression lasts: consecutive agent messages
  // within this window ping once; an agent message landing later than this
  // after the previous relay pings again even without customer activity.
  private static readonly RELAY_PING_SUPPRESSION_MS = 3 * 60 * 60 * 1000;

  // True when the customer has been active since the last relayed agent
  // message — i.e. this relay is the first agent reply of the current exchange
  // turn — OR the previous relay is older than the 3h suppression window (a
  // stale turn re-pings). Customer activity = their newest in-thread message,
  // floored at the ticket's creation (the modal question is customer activity
  // even though the "Your question" embed is bot-authored). The last-relay
  // side comes from the message map's "in" rows, which cover both webhook and
  // embed-fallback relays. Fails open to true — a duplicate ping beats a
  // missed one.
  private async shouldPingCustomer(
    thread: ThreadChannel,
    ticket: { customerId: string | null; createdAt: Date }
  ): Promise<boolean> {
    if (!ticket.customerId) return false;
    const lastRelayAt = await this.store.getLatestInboundRelayAt(thread.id);
    if (!lastRelayAt) return true; // first agent contact on this ticket
    if (Date.now() - lastRelayAt.getTime() >= IntercomWebhookHandler.RELAY_PING_SUPPRESSION_MS) return true;
    let lastCustomerAt = ticket.createdAt.getTime();
    const messages = await thread.messages.fetch({ limit: 25 }).catch(() => null);
    // Window miss (customer's last message >25 back) means a long agent chain
    // — exactly the no-ping case, so the floor result is already right.
    for (const message of messages?.values() ?? []) {
      if (message.author.id === ticket.customerId && message.createdTimestamp > lastCustomerAt) {
        lastCustomerAt = message.createdTimestamp;
      }
    }
    return lastCustomerAt > lastRelayAt.getTime();
  }

  // Positive attribution gate for inbound events that would REOPEN a closed
  // Discord ticket: true only when the newest authored part is a non-bridge
  // admin/team. Contact ("user"/"lead") activity is by definition the bridge's
  // own mirror (customers have no Intercom access), bot/workflow and
  // unattributed parts are Intercom reacting to bridge activity — none of
  // those may boot a closed ticket. Better to drop a rare ambiguous agent
  // action (they can reopen in Discord) than to mass-reopen on every replay.
  private attributedToRealAgent(parts: IntercomWebhookPart[] | undefined): boolean {
    const author = [...(parts ?? [])].reverse().find((p) => p.author?.type)?.author;
    if (!author || (author.type !== "admin" && author.type !== "team")) return false;
    const id = author.id != null ? String(author.id) : null;
    if (!id) return false;
    return id !== this.settingsStore.intercomOperatorAdminId() && id !== this.settingsStore.intercomAdminId();
  }

  private async hasPendingOutboundContent(threadId: string): Promise<boolean> {
    // Pending-posts (the reserve→confirm handshake) is the in-flight signal;
    // queued-but-unsent workflow outbox events can't have created a part yet,
    // so they don't need to defer the echo decision.
    return this.store.hasPendingPosts(threadId);
  }

  // Rolls back a claimPart so a deferred retry can claim again.
  private async releaseClaim(kind: "c" | "t", partId: string): Promise<void> {
    await this.store.releaseClaim(kind, partId).catch(() => {});
  }

  // Intercom internal notes → the existing staff-note store (visible via
  // /note list + the staff-only audit channel; never in the customer-visible
  // thread). These rows must never mirror back to Intercom — Discord→Intercom
  // note mirroring no longer exists, keep it that way.
  private async handleConversationNoted(item: IntercomConversationItem | undefined): Promise<void> {
    if (!item || item.id == null) return;
    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    for (const part of item.conversation_parts?.conversation_parts ?? []) {
      await this.processNotePart("c", link.ticketThreadId, part);
    }
  }

  private async handleTicketNoteCreated(item: IntercomTicketItem | undefined): Promise<void> {
    if (!item || item.id == null) return;
    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;
    for (const part of item.ticket_parts?.ticket_parts ?? []) {
      await this.processNotePart("t", link.ticketThreadId, part);
    }
  }

  private async processNotePart(kind: "c" | "t", threadId: string, part: IntercomWebhookPart): Promise<void> {
    if (part.id == null) return;
    // Claim first: bridge-authored notes (context card, agent warning,
    // convert fallback) were recorded at post time and fail the claim here.
    if (!(await this.store.claimPart(kind, String(part.id), threadId))) return;
    // Same rollback contract as processAgentPart: a throw after the claim must
    // release it or the retried delivery silently drops the note.
    let relayKey: string | null = null;
    try {
      if (
        this.isBridgeAuthor(part) &&
        (await this.store.matchAndDeletePendingPost(threadId, bodyHash(part.body ?? "")))
      ) {
        await this.store.recordEchoPart(kind, String(part.id), threadId).catch(() => {});
        return;
      }
      // (No unconditional Operator drop here: the bridge's own notes —
      // context card, agent warning, corrective note — are recorded at post
      // time and die on the claim above or the pending match. An
      // Operator-authored note that survives both is a genuine Fin note and
      // surfaces like any staff note; see processAgentPart.)
      if (this.settingsStore.intercomMode() !== "bi") {
        // Not relayed in push/none — release so a real agent note isn't
        // permanently consumed while the mode is off. Bridge-authored notes
        // (agent warning, context card) stay claimed: a redelivery landing
        // after a flip to bi must never relay the bridge's own note as a
        // "Staff note (from Intercom)".
        if (!this.isBridgeAuthor(part)) await this.releaseClaim(kind, String(part.id));
        return;
      }

      const text = truncateEmbedText(htmlToDiscordText(part.body ?? ""), 1900);
      if (!text) return;
      // The same note can surface on both the conversation and the ticket topic.
      // Distinct key space from replies ("note:" vs "reply:") — identical text
      // in a note and a reply must not collide. Author + created_at scope the
      // key so two distinct same-text notes don't collapse (see processAgentPart).
      relayKey = `note:${part.author?.id ?? "a?"}:${part.created_at ?? "t?"}:${bodyHash(part.body ?? "")}`;
      if (!(await this.store.claimRelay(threadId, relayKey))) return;

      // Notes are not stored locally anymore (agent-rip: /note is gone and
      // agents read their own notes in Intercom) — the audit embed is the only
      // Discord-side record; the claims above still dedup redeliveries.
      const authorName = part.author?.name || "Intercom agent";
      void this.audit.log({
        title: "📝 Staff note (from Intercom)",
        severity: "info",
        actor: authorName,
        threadId,
        fields: [{ name: "Note", value: text.slice(0, 1024), inline: false }],
      });
    } catch (e) {
      await this.releaseClaim(kind, String(part.id));
      if (relayKey) await this.store.releaseRelay(threadId, relayKey).catch(() => {});
      throw e;
    }
  }

  // Agent changed the ticket's (custom) state in Intercom → map back to the
  // status tag configured for that state.
  private async handleTicketStateUpdated(item: IntercomTicketItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const state = item.ticket_state;
    const stateId = state && typeof state === "object" && state.id != null ? String(state.id) : null;
    if (!stateId) return; // system enum only — nothing to map

    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;
    // Our own PUT echoes back as this topic — the pushed state id marks it.
    if (link.lastSyncedStateId === stateId) return;

    // Resolving the ticket in Intercom (resolved-category state) also closes
    // the conversation — agents expect resolve to clear it from the inbox,
    // and Intercom itself leaves it open. Damper-first so the close's own
    // webhook echo is suppressed; safe for any author (closing is never the
    // boot-a-ticket-open failure mode).
    const stateCategory =
      state && typeof state === "object" && typeof state.category === "string" ? state.category : null;
    if (stateCategory === "resolved" && link.lastSyncedOpen !== "closed") {
      const adminId = this.settingsStore.intercomAuthorAdminId();
      if (adminId) {
        const prevOpen = link.lastSyncedOpen === "open" ? ("open" as const) : null;
        await this.store.setLastSyncedOpen(link.ticketThreadId, "closed");
        try {
          await this.intercomClient.setConversationOpen(link.conversationId, false, adminId);
        } catch {
          await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
        }
      }
    }

    const tag = this.settingsStore.tags().find((t) => t.intercomTicketStateId === stateId);
    if (!tag) return; // unmapped state — Intercom-only concept, ignore

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;
    if (ticket.statusTagId === tag.id) return; // already there (echo or no-op)

    // Intercom auto-transitions ticket states on conversation activity —
    // INCLUDING every message the bridge itself mirrors (customer reply →
    // in_progress, staff reply → waiting_on_customer). Those must never drive
    // the Discord status: the bot owns its own waiting-for-customer/team
    // logic, and the auto-transitions would shuffle every ticket on every
    // mirrored message. Positive agent attribution required for ALL inbound
    // state changes; the damper above only covers states the bridge pushed.
    if (!this.attributedToRealAgent(item.ticket_parts?.ticket_parts)) {
      this.wbLog.info("inbound state change dropped — no non-bridge agent attribution", {
        "intercom.ticket_id": String(item.id),
        "ticket.thread_id": link.ticketThreadId,
        "intercom.state_id": stateId,
      });
      return;
    }

    // Pre-mark the synced state so the push-back triggered by applyStatus
    // skips its ticket update (Intercom already has this state). Rolled back on
    // failure — otherwise the retry short-circuits on the damper above and the
    // Intercom-side state change is silently lost.
    const prevStateId = link.lastSyncedStateId;
    await this.store.setLastSyncedStateId(link.ticketThreadId, stateId);
    try {
      const thread = await this.requireThread(link.ticketThreadId);
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, tag, { actorName: "Intercom agent" });
    } catch (e) {
      await this.store.setLastSyncedStateId(link.ticketThreadId, prevStateId).catch(() => {});
      throw e;
    }
  }

  // Conversation closed/reopened in Intercom (bi): minimum close/reopen parity.
  // Converges with ticket.state.updated — whichever arrives first wins, the
  // other becomes a no-op via the statusTagId damper.
  private async handleConversationOpenState(
    item: IntercomConversationItem | undefined,
    target: "open" | "closed",
    attempt: number
  ): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;

    // Reply-and-close / reply-on-closed ship the agent's message ON the
    // close/open part of THIS topic — admin.replied may not fire at all, and
    // when it does, the part-id claim makes the second arrival a no-op. Relay
    // content-bearing parts BEFORE any state damping: the bridge's own state
    // pushes produce bare parts, which the candidate filter drops anyway.
    for (const part of item.conversation_parts?.conversation_parts ?? []) {
      if (this.isRelayCandidate(part)) {
        await this.processAgentPart("c", link.ticketThreadId, part, attempt);
      }
    }

    // The bridge's own close/open (status parity push) echoes back here.
    if (link.lastSyncedOpen === target) return;

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;

    const prevOpen = link.lastSyncedOpen === "open" || link.lastSyncedOpen === "closed" ? link.lastSyncedOpen : null;

    if (target === "closed") {
      const closingTag = this.settingsStore.closingTag();
      if (!closingTag) return;
      if (ticket.statusTagId === closingTag.id) return;

      // Damper pre-mark with rollback on failure (see handleTicketStateUpdated).
      await this.store.setLastSyncedOpen(link.ticketThreadId, "closed");
      try {
        const thread = await this.requireThread(link.ticketThreadId);
        if (!thread) return;
        await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Intercom agent" });
      } catch (e) {
        await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
        throw e;
      }
      return;
    }

    // target === "open": Intercom auto-reopens conversations on all kinds of
    // activity the bridge itself causes (mirrored contact replies, ticket
    // state/attribute writes) — and payload shapes vary, so the rule is
    // POSITIVE ATTRIBUTION: only a reopen provably authored by a real,
    // non-bridge agent may touch the Discord status. Everything else is the
    // bridge's own echo or ambiguous — drop it (and if it was our own admin
    // write that reopened a closed conversation, restore the close).
    const openParts = item.conversation_parts?.conversation_parts ?? [];
    const openPart = openParts.find((p) => p.part_type === "open") ?? openParts[openParts.length - 1];
    if (openPart && this.isBridgeAuthor(openPart)) {
      if (link.lastSyncedOpen === "closed") {
        const adminId = this.settingsStore.intercomAuthorAdminId();
        if (adminId) {
          await this.intercomClient.setConversationOpen(link.conversationId, false, adminId).catch(() => {});
        }
      }
      return;
    }
    if (!this.attributedToRealAgent(openParts)) {
      this.wbLog.info("inbound reopen dropped — not attributable to a non-bridge agent", {
        "intercom.conversation_id": String(item.id),
        "ticket.thread_id": link.ticketThreadId,
      });
      return;
    }

    // Reopen only if the ticket is actually done/closed.
    if (!ticket.closed) return;
    const initialTag = this.settingsStore.initialTag();
    if (!initialTag || ticket.statusTagId === initialTag.id) return;

    await this.store.setLastSyncedOpen(link.ticketThreadId, "open");
    try {
      const thread = await this.requireThread(link.ticketThreadId);
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, initialTag, { actorName: "Intercom agent" });
    } catch (e) {
      await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
      throw e;
    }
  }

  // Agent snoozed in Intercom → configurable snooze status tag in Discord.
  // TicketStore.setStatus persists prevStatusTagId, which unsnooze restores.
  // The snooze tag must be reminder-free, non-closing and unmapped to an
  // Intercom state (the /config picker enforces/warns) — that keeps the
  // reminder scheduler quiet and the executeStatus echo a no-op.
  private async handleConversationSnoozed(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const snoozeTagId = this.settingsStore.intercomSnoozeStatusTagId();
    if (!snoozeTagId) return;
    const snoozeTag = this.settingsStore.tagById(snoozeTagId);
    if (!snoozeTag) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.closed || ticket.statusTagId === snoozeTag.id) return;

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyStatus(thread, ticket, snoozeTag, { actorName: "Intercom agent" });

    const until = item.snoozed_until ? `<t:${item.snoozed_until}:f>` : "later";
    await thread
      .send({
        embeds: [
          new EmbedBuilder().setColor(COLORS.neutral).setDescription(`⏸️ Snoozed in Intercom until ${until}.`),
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // Unsnooze (agent action or customer-reply auto-unsnooze) → restore the tag
  // the ticket had before the snooze. Note the loop: a customer reply in
  // Discord mirrors as a contact reply → Intercom auto-unsnoozes → this
  // handler restores the Discord tag. That is the desired end state.
  private async handleConversationUnsnoozed(item: IntercomConversationItem | undefined): Promise<void> {
    if (!item || item.id == null) return;

    // SLA next-reply re-anchor (bridged AND native, any mode): a snooze is a
    // deliberate park — the clock restarts from the unsnooze, not from the
    // customer's original waiting_since.
    await this.slaEnforcer?.reanchorAfterUnsnooze(String(item.id)).catch(() => undefined);

    if (this.settingsStore.intercomMode() !== "bi") return;

    const snoozeTagId = this.settingsStore.intercomSnoozeStatusTagId();
    if (!snoozeTagId) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.statusTagId !== snoozeTagId) return;

    const restoreTag =
      (ticket.prevStatusTagId ? this.settingsStore.tagById(ticket.prevStatusTagId) : undefined) ??
      this.settingsStore.initialTag();
    if (!restoreTag || restoreTag.id === snoozeTagId) return;

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyStatus(thread, ticket, restoreTag, { actorName: "Intercom agent" });
    await thread
      .send({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription("▶️ Unsnoozed in Intercom.")],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // (Native Intercom priority is agents' own tool — never synced to Discord.
  // conversation.priority.updated left the topic list and drops at the door
  // until unsubscribed in the Developer Hub.)

  // Tag changes made in Intercom → one diff embed in the Discord thread.
  // There is no untag webhook topic, so the diff runs on every conversation
  // event that carries tags. Bridge-managed names are skipped; the bridge's
  // own tagging updates lastTagsJson at tag time so it never echoes here.
  private async diffTags(threadId: string, item: IntercomConversationItem): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    const tagList = item.tags?.tags;
    if (!tagList) return;

    const current = tagList.map((t) => t.name).filter((n): n is string => Boolean(n));
    const link = await this.store.getLink(threadId);
    if (!link) return;
    const previous = Array.isArray(link.lastTagsJson) ? (link.lastTagsJson as string[]) : null;

    // First sighting: just baseline, don't narrate history.
    if (previous === null) {
      await this.store.setLastTags(threadId, current);
      return;
    }

    // Managed tags never narrate into the thread: "Discord" (bridge marker)
    // and the SLA breach tag (the enforcer pre-stamps lastTagsJson, this is
    // the second belt — SLA alerts are Intercom-only by design).
    const isManaged = (name: string) => name === "Discord" || name === this.settingsStore.slaBreachTagName();
    const added = current.filter((t) => !previous.includes(t) && !isManaged(t));
    const removed = previous.filter((t) => !current.includes(t) && !isManaged(t));
    if (added.length === 0 && removed.length === 0) return;

    await this.store.setLastTags(threadId, current);
    const thread = await this.fetchThread(threadId);
    if (!thread) return;
    const parts = [...added.map((t) => `+${t}`), ...removed.map((t) => `−${t}`)].join(" ");
    await thread
      .send({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription(`🏷️ Intercom tags: ${parts}`)],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // ---- Agent-reply webhook impersonation ----
  // One bot-owned webhook per parent channel (cached; threads post through the
  // parent with threadId). Webhook messages carry author.bot=true, so the
  // messageCreate mirror skips them — same loop safety as the embed path.

  private static readonly RELAY_WEBHOOK_NAME = "Intercom Agent Relay";
  private relayWebhooks = new Map<string, Webhook>();

  // Returns the sent message's id (recorded in the message map for redaction
  // reflection), or null when the webhook path is unavailable — the caller's
  // embed fallback owns failure.
  private async relayViaWebhook(
    thread: ThreadChannel,
    customerId: string | null,
    authorName: string,
    avatarUrl: string | null,
    message: { content: string; files?: AttachmentPayload[] }
  ): Promise<string | null> {
    const send = async (webhook: Webhook): Promise<string> => {
      const sent = await webhook.send({
        ...(message.content ? { content: message.content } : {}),
        ...(message.files?.length ? { files: message.files } : {}),
        username: sanitizeWebhookUsername(authorName),
        ...(avatarUrl ? { avatarURL: avatarUrl } : {}),
        threadId: thread.id,
        allowedMentions: { users: customerId ? [customerId] : [] },
      });
      return sent.id;
    };
    try {
      const webhook = await this.getRelayWebhook(thread);
      if (!webhook) return null;
      return await send(webhook);
    } catch {
      // Stale cache (webhook deleted by a mod) — refetch once, then give up to
      // the embed fallback. Never throw: the caller's fallback owns failure.
      this.relayWebhooks.delete(thread.parentId ?? "");
      try {
        const webhook = await this.getRelayWebhook(thread);
        if (!webhook) return null;
        return await send(webhook);
      } catch {
        return null;
      }
    }
  }

  // Download Intercom attachments (signed CDN URLs — fetch them NOW, they
  // expire) for native re-upload. Failures and files past the upload cap fall
  // back to 📎 masked links; never throws.
  private async downloadRelayAttachments(
    refs: Array<{ url: string; name: string | null }>
  ): Promise<{ files: AttachmentPayload[]; linkLines: string[] }> {
    const files: AttachmentPayload[] = [];
    const linkLines: string[] = [];
    const deadline = Date.now() + RELAY_DOWNLOAD_BUDGET_MS;
    for (const ref of refs) {
      const name = ref.name || filenameFromUrl(ref.url);
      const budgetLeft = deadline - Date.now();
      if (files.length >= MAX_RELAY_FILES || budgetLeft <= 0) {
        linkLines.push(`📎 [${name}](${ref.url})`);
        continue;
      }
      try {
        // SSRF guard: ref.url comes from webhook payload (attachment / inline
        // <img> src). An off-CDN or internal-address URL degrades to a masked
        // link via the catch below rather than driving a server-side fetch.
        const res = await safeFetch(ref.url, {
          allowHosts: INTERCOM_CDN_HOSTS,
          signal: AbortSignal.timeout(Math.min(RELAY_DOWNLOAD_TIMEOUT_MS, budgetLeft)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > MAX_RELAY_UPLOAD_BYTES) throw new Error("attachment exceeds upload cap");
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_RELAY_UPLOAD_BYTES) {
          throw new Error("attachment empty or exceeds upload cap");
        }
        files.push({ attachment: buffer, name });
      } catch {
        linkLines.push(`📎 [${name}](${ref.url})`);
      }
    }
    return { files, linkLines };
  }

  private async getRelayWebhook(thread: ThreadChannel): Promise<Webhook | null> {
    const parentId = thread.parentId;
    if (!parentId || !this.client) return null;
    const cached = this.relayWebhooks.get(parentId);
    if (cached) return cached;

    const parent = thread.parent ?? (await this.client.channels.fetch(parentId).catch(() => null));
    if (!parent || parent.isThread() || !("fetchWebhooks" in parent)) return null;
    try {
      const hooks = await parent.fetchWebhooks();
      const botAvatar = this.client?.user?.displayAvatarURL({ extension: "png", size: 256 });
      const existing = hooks.find(
        (h) => h.owner?.id === this.client?.user?.id && h.name === IntercomWebhookHandler.RELAY_WEBHOOK_NAME
      );
      // Default avatar = the bot's own: shows whenever a per-message agent
      // avatar can't be resolved (never the gray Discord placeholder). Also
      // backfilled onto webhooks created before this default existed.
      if (existing && !existing.avatar && botAvatar) {
        await existing.edit({ avatar: botAvatar }).catch(() => {});
      }
      const mine =
        existing ??
        (await parent.createWebhook({
          name: IntercomWebhookHandler.RELAY_WEBHOOK_NAME,
          avatar: botAvatar ?? undefined,
          reason: "Intercom bridge: agent replies render under the agent's own name",
        }));
      this.relayWebhooks.set(parentId, mine);
      return mine;
    } catch {
      return null; // Missing Manage Webhooks — embed fallback
    }
  }

  // Admin id → display name/avatar, cached 10 min (webhook payloads don't
  // always carry the author's avatar, and assignment events would otherwise
  // pay a full /admins listing each; lookups are purely cosmetic).
  private adminCache: { at: number; admins: Map<string, { name: string | null; avatarUrl: string | null }> } | null =
    null;

  private async lookupAdmin(adminId: string): Promise<{ name: string | null; avatarUrl: string | null } | null> {
    const now = Date.now();
    if (!this.adminCache || now - this.adminCache.at > 10 * 60 * 1000) {
      try {
        const admins = await this.intercomClient.listAdmins();
        this.adminCache = {
          at: now,
          admins: new Map(admins.map((a) => [a.id, { name: a.name ?? null, avatarUrl: a.avatarUrl ?? null }] as const)),
        };
      } catch {
        return this.adminCache?.admins.get(adminId) ?? null; // stale beats nothing
      }
    }
    return this.adminCache.admins.get(adminId) ?? null;
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }

  // Strict thread fetch for relay/state handlers: throws on transient Discord
  // failures (the inbox workflow retries); a permanently-deleted thread
  // (Unknown Channel) disconnects the link and returns null so the event —
  // and every future event on this conversation — stops dead-lettering.
  private async requireThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) throw new Error("Discord client not bound yet");
    let channel;
    try {
      channel = await this.client.channels.fetch(threadId);
    } catch (e) {
      if ((e as { code?: number }).code === DISCORD_UNKNOWN_CHANNEL) {
        await this.disconnectDeletedThread(threadId);
        return null;
      }
      throw e;
    }
    if (channel?.isThread()) return channel as ThreadChannel;
    await this.disconnectDeletedThread(threadId);
    return null;
  }

  // The Discord thread is gone for good: drop the link (deleteLink's count
  // makes this exactly-once under concurrent inbound events), leave a note in
  // the Intercom conversation, and audit.
  private async disconnectDeletedThread(threadId: string): Promise<void> {
    const link = await this.store.getLink(threadId);
    if (!link) return;
    const removed = await this.store.deleteLink(threadId);
    if (removed === 0) return; // another handler already disconnected it

    const adminId = this.settingsStore.intercomAuthorAdminId();
    if (adminId) {
      await this.intercomClient
        .replyAsAdmin(link.conversationId, {
          adminId,
          body: "<p>⚠️ The linked Discord thread was deleted — this conversation is no longer bridged. Replies here will not reach the customer.</p>",
          note: true,
        })
        .catch(() => {});
    }
    void this.audit.log({
      title: "🔌 Intercom bridge disconnected",
      severity: "warn",
      actor: "Intercom bridge",
      threadId,
      fields: [
        { name: "Reason", value: "Discord thread deleted", inline: false },
        { name: "Conversation", value: link.conversationId, inline: true },
      ],
    });
  }
}

// Intercom part bodies are HTML → readable Discord text for embeds/notes.
// Block boundaries become SINGLE newlines so the Discord message mirrors the
// agent's line layout exactly (Intercom's composer emits one <p>/<div> per
// Enter, rendered single-spaced — a "\n\n" join reads as extra blank lines,
// and unhandled <div> boundaries used to collapse everything into one
// paragraph).
function htmlToDiscordText(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
      .replace(/<\/div>\s*<div[^>]*>/gi, "\n")
      .replace(/<\/(p|div|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<blockquote[^>]*>/gi, "\n> ")
      .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "*$2*")
      // Inline-pasted screenshots live in the body as <img>, not in
      // `attachments` — without this an image-only agent reply renders empty
      // and the customer receives nothing.
      .replace(/<img[^>]*src="([^"]+)"[^>]*\/?>/gi, (_m, src) => `📷 [image](${src})`)
      .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, url, text) => (url === text ? url : `[${text}](${url})`))
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      // &amp; must decode LAST: decoding it first turns "&amp;lt;" into "&lt;"
      // which the next rule then double-decodes into "<".
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

// Agent reply body → Discord text + the inline images it embeds. Inline <img>
// tags are pulled OUT of the text (they re-upload natively alongside
// `attachments`); Intercom's literal "[Image]" / '[Image "name.png"]' body
// placeholders (attachment-only replies) are stripped — the file itself
// arrives separately, so the placeholder is pure noise in Discord.
function extractAgentBody(html: string): { text: string; images: Array<{ url: string; name: string | null }> } {
  const images: Array<{ url: string; name: string | null }> = [];
  const withoutImages = html.replace(/<img[^>]*src="([^"]+)"[^>]*\/?>/gi, (_m, src: string) => {
    images.push({ url: src, name: null });
    return "";
  });
  const text = htmlToDiscordText(withoutImages)
    .replace(/\[Image(?:\s+"[^"]*")?\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images };
}

function dedupeByUrl<T extends { url: string }>(refs: T[]): T[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.url)) return false;
    seen.add(ref.url);
    return true;
  });
}

function filenameFromUrl(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return base || "attachment";
  } catch {
    return "attachment";
  }
}

// Discord rejects webhook usernames containing "discord"/"clyde" (any case)
// and caps them at 80 chars.
function sanitizeWebhookUsername(name: string): string {
  const cleaned = name.replace(/discord|clyde/gi, "").trim().slice(0, 80);
  return cleaned || "Intercom agent";
}

// Embed-safe truncation: ellipsis marker, never splits a surrogate pair (a
// lone surrogate makes Discord reject the whole embed).
function truncateEmbedText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
