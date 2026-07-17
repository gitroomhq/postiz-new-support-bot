import { PrismaClient, SlaState } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { SlaRuleStore } from "./SlaRuleStore";
import { SlaFactsLoader } from "./facts";
import { evaluateRules } from "./evaluate";
import { SlaDim, SlaEvaluation, SlaFacts } from "./types";
import { IntercomStore } from "../intercom/IntercomStore";
import { IntercomClient, IntercomHttpError } from "../intercom/IntercomClient";
import { TicketStore } from "../bot/TicketStore";
import { SessionStore } from "../auth/SessionStore";
import { AuditLogger } from "../bot/AuditLogger";
import { TemporalProducers } from "../temporal/producers";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";

const slaLog = log.child("sla");

// The SLA manager's brain: evaluates the rule list against a subject and
// keeps the "SLA Target" conversation attribute in sync (the Intercom
// Workflow does the actual native Apply SLA). Trigger entry points never
// throw; the apply core throws IntercomHttpError on transient write failures
// so the caller's retry machinery (per-ticket outbox delivery / inbound
// activity retry / next sweep) owns redelivery.

export type SlaSubjectRef = { threadId: string } | { conversationId: string };

export interface SlaApplyResult {
  outcome: "written" | "unchanged" | "pinned" | "skipped" | "error";
  target: string | null;
  ruleId: string | null;
  reason?: string;
}

export type SlaTriggerReason = "created" | "status" | "customer_reply" | "refund_review" | "stripe" | "manual";

const ALL_DIMS: SlaDim[] = [
  "category", "status", "open", "exempt", "mirrored",
  "stripe.linked", "stripe.paying", "stripe.dispute", "stripe.refund_review", "stripe.plan", "stripe.spend",
  "intercom.team", "intercom.kind", "intercom.ticket_type", "intercom.tag", "intercom.assignee",
  "intercom.attribute", "keyword",
];
const MAX_TICKETS_PER_STRIPE_TRIGGER = 25;

export class SlaService {
  constructor(
    private prisma: PrismaClient,
    private settingsStore: SettingsStore,
    private ruleStore: SlaRuleStore,
    private facts: SlaFactsLoader,
    private intercomStore: IntercomStore,
    private intercomClient: IntercomClient,
    private ticketStore: TicketStore,
    private sessionStore: SessionStore,
    private auditLogger: AuditLogger,
    private producers: TemporalProducers | null
  ) {}

  // ---- trigger entry points (fire-and-forget safe, never throw) ----

  async onTicketTrigger(threadId: string, reason: SlaTriggerReason): Promise<void> {
    try {
      if (!this.settingsStore.slaEnabled() || !this.settingsStore.intercomConfigured()) return;
      if (this.producers?.routable()) {
        // Ride the per-ticket FIFO outbox: ordered after any pending ensure,
        // payload null = target computed at delivery time (stale events
        // converge to current rules).
        await this.producers.intercomEnqueue(threadId, "sla", null);
        return;
      }
      await this.applyForBridged(threadId, `direct:${reason}`);
    } catch (e) {
      slaLog.warn("sla.trigger.failed", {
        "ticket.thread_id": threadId,
        "sla.reason": reason,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Stripe-side change (dispute opened, subscription change, …): re-evaluate
  // every open ticket of the affected customer.
  async onStripeCustomerTrigger(stripeCustomerId: string): Promise<void> {
    try {
      if (!this.settingsStore.slaEnabled()) return;
      this.facts.invalidateStripeCustomer(stripeCustomerId);
      const discordIds = await this.sessionStore.findDiscordIdsByStripeId(stripeCustomerId);
      let count = 0;
      for (const discordId of discordIds) {
        const tickets = await this.ticketStore.listOpenByCustomerId(discordId);
        for (const ticket of tickets) {
          if (count >= MAX_TICKETS_PER_STRIPE_TRIGGER) return;
          count++;
          await this.onTicketTrigger(ticket.threadId, "stripe");
        }
      }
    } catch (e) {
      slaLog.warn("sla.stripe_trigger.failed", {
        "stripe.customer_id": stripeCustomerId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Rule list changed → nudge the sweep so every open subject converges soon.
  onRulesChanged(): void {
    void this.producers?.slaRunNow().catch(() => undefined);
  }

  // ---- apply core ----

  // Bridged ticket (executor "sla" case, sweep, direct fallback). Throws
  // IntercomHttpError on transient write failure.
  async applyForBridged(threadId: string, reason: string): Promise<SlaApplyResult> {
    if (!this.settingsStore.slaEnabled()) return this.skipped("disabled");
    if (!this.settingsStore.intercomConfigured()) return this.skipped("intercom-unconfigured");

    const stateId = `t:${threadId}`;
    const state = await this.getState(stateId);

    const loaded = await this.facts.forBridged(threadId, this.dimsFor(state));
    if (!loaded) return this.skipped("no-ticket");
    if (!loaded.conversationId) return this.skipped("no-conversation");
    if (loaded.facts.open === false) return this.skipped("closed");

    return this.evaluateAndWrite({
      stateId,
      kind: "bridged",
      threadId,
      conversationId: loaded.conversationId,
      ticketId: loaded.ticketId,
      facts: loaded.facts,
      state,
      reason,
      liveValue: undefined,
    });
  }

  // Native conversation (inbound webhook, sweep). Throws IntercomHttpError on
  // transient write failure.
  async applyForNative(conversationId: string, reason: string): Promise<SlaApplyResult> {
    if (!this.settingsStore.slaEnabled()) return this.skipped("disabled");
    if (!this.settingsStore.slaNativeEnabled()) return this.skipped("native-disabled");
    if (!this.settingsStore.intercomConfigured()) return this.skipped("intercom-unconfigured");

    const stateId = `c:${conversationId}`;
    const state = await this.getState(stateId);

    const loaded = await this.facts.forNative(conversationId);
    if (!loaded) return this.skipped("no-conversation");
    if (!loaded.open) return this.skipped("closed");

    const attrName = this.settingsStore.slaAttributeName();
    const live = loaded.customAttributes[attrName];
    return this.evaluateAndWrite({
      stateId,
      kind: "native",
      conversationId,
      facts: loaded.facts,
      state,
      reason,
      liveValue: typeof live === "string" ? live : undefined,
    });
  }

  // ---- UI surface ----

  // "Which rule matches subject X" — full facts + per-condition trace, NO write.
  async preview(ref: SlaSubjectRef): Promise<{
    facts: SlaFacts;
    evaluation: SlaEvaluation;
    effectiveTarget: string | null;
    pinned: { target: string; byName: string | null; at: Date | null } | null;
    lastWrittenTarget: string | null;
    conversationId: string | null;
  } | null> {
    const allDims = new Set<SlaDim>(ALL_DIMS);
    let facts: SlaFacts;
    let conversationId: string | null;
    let stateId: string;
    if ("threadId" in ref) {
      const loaded = await this.facts.forBridged(ref.threadId, allDims);
      if (!loaded) return null;
      facts = loaded.facts;
      conversationId = loaded.conversationId;
      stateId = `t:${ref.threadId}`;
    } else {
      const loaded = await this.facts.forNative(ref.conversationId);
      if (!loaded) return null;
      facts = loaded.facts;
      conversationId = ref.conversationId;
      stateId = `c:${ref.conversationId}`;
    }
    const state = await this.getState(stateId);
    const evaluation = evaluateRules(this.ruleStore.snapshot(), facts);
    const effectiveTarget = state?.pinnedTarget ?? evaluation.winner?.target ?? this.settingsStore.slaDefaultTarget();
    return {
      facts,
      evaluation,
      effectiveTarget,
      pinned: state?.pinnedTarget
        ? { target: state.pinnedTarget, byName: state.pinnedByName, at: state.pinnedAt }
        : null,
      lastWrittenTarget: state?.lastWrittenTarget ?? null,
      conversationId,
    };
  }

  // Manual per-subject override: rules skip pinned subjects until unpinned.
  async pin(ref: SlaSubjectRef, target: string, actor: { id: string; name: string }): Promise<SlaApplyResult> {
    if (!this.settingsStore.slaTargetExists(target)) {
      return { outcome: "error", target: null, ruleId: null, reason: `unknown target "${target}"` };
    }
    const stateId = this.stateIdFor(ref);
    await this.prisma.slaState.upsert({
      where: { id: stateId },
      create: {
        id: stateId,
        kind: "threadId" in ref ? "bridged" : "native",
        pinnedTarget: target,
        pinnedById: actor.id,
        pinnedByName: actor.name,
        pinnedAt: new Date(),
      },
      update: { pinnedTarget: target, pinnedById: actor.id, pinnedByName: actor.name, pinnedAt: new Date() },
    });
    void this.auditLogger.log({
      title: "🎯 SLA target pinned",
      actor: actor.name,
      threadId: "threadId" in ref ? ref.threadId : undefined,
      description: `Pinned to \`${target}\`${"conversationId" in ref ? ` (conversation ${ref.conversationId})` : ""} — rules are bypassed until unpinned.`,
      severity: "info",
    });
    return this.applyRef(ref, "pin");
  }

  async unpin(ref: SlaSubjectRef, actor: { id: string; name: string }): Promise<SlaApplyResult> {
    const stateId = this.stateIdFor(ref);
    await this.prisma.slaState.updateMany({
      where: { id: stateId },
      data: { pinnedTarget: null, pinnedById: null, pinnedByName: null, pinnedAt: null },
    });
    void this.auditLogger.log({
      title: "🎯 SLA pin removed",
      actor: actor.name,
      threadId: "threadId" in ref ? ref.threadId : undefined,
      description: "Rules apply again from the next evaluation.",
      severity: "neutral",
    });
    return this.applyRef(ref, "unpin");
  }

  async getPinState(ref: SlaSubjectRef): Promise<SlaState | null> {
    return this.getState(this.stateIdFor(ref));
  }

  status(): {
    enabled: boolean;
    nativeEnabled: boolean;
    attributeName: string;
    defaultTarget: string | null;
    ruleCount: number;
    enabledRuleCount: number;
  } {
    return {
      enabled: this.settingsStore.slaEnabled(),
      nativeEnabled: this.settingsStore.slaNativeEnabled(),
      attributeName: this.settingsStore.slaAttributeName(),
      defaultTarget: this.settingsStore.slaDefaultTarget(),
      ruleCount: this.ruleStore.count(),
      enabledRuleCount: this.ruleStore.enabledCount(),
    };
  }

  async pinnedCount(): Promise<number> {
    return this.prisma.slaState.count({ where: { pinnedTarget: { not: null } } });
  }

  // One-shot cleanup for the pre-fix era: kick notes were authored as the
  // Operator/Fin bot (which the Workflow trigger ignores) and lack the
  // automation marker. For every known SLA subject: redact those stale notes
  // (Intercom has NO hard-delete for parts — they become "message deleted"
  // placeholders) and, where a target is currently written, post a fresh
  // human-authored kick — which also finally fires the Workflow and applies
  // the SLA those conversations never got.
  async cleanupOldKickNotes(): Promise<{ subjects: number; redacted: number; rekicked: number; failures: number }> {
    const result = { subjects: 0, redacted: 0, rekicked: 0, failures: 0 };
    const pause = () => new Promise((r) => setTimeout(r, 200));
    const states = await this.prisma.slaState.findMany({ where: { conversationId: { not: null } } });
    for (const state of states) {
      const conversationId = state.conversationId!;
      result.subjects++;
      try {
        const parts = await this.intercomClient.getConversationPartsSince(conversationId, 0);
        const stale = parts.filter(
          (p) =>
            p.id != null &&
            !p.redacted &&
            (p.part_type === "note" || p.part_type === "comment") &&
            typeof p.body === "string" &&
            p.body.includes("SLA target") &&
            !p.body.includes("automated by the support bot")
        );
        let redactedAny = false;
        for (const part of stale) {
          await this.intercomClient.redactConversationPart(conversationId, String(part.id));
          result.redacted++;
          redactedAny = true;
          await pause();
        }
        // Fresh, correctly-authored kick — only when the subject actually has
        // a written target (also fires the Workflow the old note couldn't).
        if (redactedAny && state.lastWrittenTarget) {
          const threadId = state.id.startsWith("t:") ? state.id.slice(2) : undefined;
          await this.noteKick(
            state.id,
            state.kind === "bridged" ? "bridged" : "native",
            conversationId,
            threadId,
            state.lastWrittenTarget || null,
            state.lastKickPartId
          );
          result.rekicked++;
        }
        await pause();
      } catch (e) {
        result.failures++;
        slaLog.warn("sla.note_cleanup.failed", {
          "intercom.conversation_id": conversationId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
    slaLog.info("sla.note_cleanup.completed", {
      "sla.cleanup_subjects": result.subjects,
      "sla.cleanup_redacted": result.redacted,
      "sla.cleanup_rekicked": result.rekicked,
      "sla.cleanup_failures": result.failures,
    });
    return result;
  }

  // Setup verification for the /intercom Verify Setup button: the API can
  // LIST conversation attributes but cannot create them, and it cannot see
  // SLAs/Workflows at all — so this checks what it can and returns the manual
  // runbook for the rest.
  async verifySetup(): Promise<{ attributeExists: boolean; attributeName: string; runbook: string[] }> {
    const attributeName = this.settingsStore.slaAttributeName();
    let attributeExists = false;
    try {
      const attrs = await this.intercomClient.listConversationDataAttributes();
      attributeExists = attrs.some((a) => a.name === attributeName && !a.archived);
    } catch (e) {
      slaLog.warn("sla.verify.attr_list_failed", { "error.message": e instanceof Error ? e.message : String(e) });
    }
    const targets = this.settingsStore.slaTargets();
    const noteKick = this.settingsStore.slaNoteKickEnabled();
    const runbook = [
      attributeExists
        ? `✅ Conversation attribute **${attributeName}** exists.`
        : `❌ Create a **List** conversation attribute named exactly **${attributeName}** (Intercom → Settings → Data → Conversations — the API cannot create it). Options: ${targets.map((t) => `\`${t.value}\``).join(", ") || "add targets first"}.`,
      "2. **Bridged tickets Workflow**: trigger **Teammate adds a note**, context **Customer tickets ONLY** (ticket contexts have no channel gate — API conversations never match a channel, so conversation-scoped triggers won't fire for bridged tickets). Branch on the **ticket attribute** `" +
        attributeName +
        "` (Ensure Ticket Attributes in the Bridge hub creates it; the bot mirrors every target onto it) → native **Apply SLA** per branch.",
      "3. **Native conversations Workflow** (only if you enable *Native* here): same trigger, context **Conversations**, ALL channels selected — native conversations come from real channels, so the gate is fine there. Branch on the conversation attribute → Apply SLA. The two Workflows cover disjoint subjects (bridged tickets vs native conversations), so SLAs are never double-applied.",
      "4. The bot posts a small internal note on every target change" +
        (noteKick ? "" : " — ⚠️ the note kick is currently OFF here, so nothing fires those triggers") +
        "; it always lands AFTER the attribute writes, so branches read fresh values. Test once: flip a target on a test ticket and confirm the Workflow applied the SLA.",
      "5. Developer Hub → your app → Webhooks: manually subscribe `conversation.user.created` and `conversation.user.replied` (needed for native-conversation rules; bridged tickets work without them).",
      "6. Enable SLA here (and *Native conversations* if wanted). The 30-min sweep heals anything a webhook misses.",
    ];
    return { attributeExists, attributeName, runbook };
  }

  // ---- internals ----

  private async applyRef(ref: SlaSubjectRef, reason: string): Promise<SlaApplyResult> {
    try {
      return "threadId" in ref
        ? await this.applyForBridged(ref.threadId, reason)
        : await this.applyForNative(ref.conversationId, reason);
    } catch (e) {
      return { outcome: "error", target: null, ruleId: null, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private stateIdFor(ref: SlaSubjectRef): string {
    return "threadId" in ref ? `t:${ref.threadId}` : `c:${ref.conversationId}`;
  }

  private skipped(reason: string): SlaApplyResult {
    return { outcome: "skipped", target: null, ruleId: null, reason };
  }

  private async getState(id: string): Promise<SlaState | null> {
    return this.prisma.slaState.findUnique({ where: { id } }).catch(() => null);
  }

  // Pinned subjects don't need expensive facts; everything else needs the
  // dims the enabled rules reference.
  private dimsFor(state: SlaState | null): Set<SlaDim> {
    return state?.pinnedTarget ? new Set<SlaDim>() : this.ruleStore.referencedDims();
  }

  private async evaluateAndWrite(input: {
    stateId: string;
    kind: "bridged" | "native";
    threadId?: string;
    conversationId: string;
    ticketId?: string | null;
    facts: SlaFacts;
    state: SlaState | null;
    reason: string;
    liveValue: string | undefined;
  }): Promise<SlaApplyResult> {
    const { stateId, kind, conversationId, facts, state, reason } = input;

    let target: string | null;
    let ruleId: string | null = null;
    let pinned = false;
    if (state?.pinnedTarget) {
      target = state.pinnedTarget;
      pinned = true;
    } else {
      const evaluation = evaluateRules(this.ruleStore.snapshot(), facts);
      target = evaluation.winner?.target ?? this.settingsStore.slaDefaultTarget();
      ruleId = evaluation.winner?.ruleId ?? null;
    }

    // Dedup: our ledger first, live attribute as a second belt (native only —
    // it comes free with the facts GET).
    const lastWritten = state?.lastWrittenTarget ?? null;
    const effectiveWritten = target ?? ""; // clearing = writing ""
    const alreadyOurs = lastWritten === effectiveWritten || (lastWritten == null && target == null);
    const alreadyLive = input.liveValue !== undefined && input.liveValue === effectiveWritten;
    if (alreadyOurs || alreadyLive) {
      await this.upsertState(stateId, kind, conversationId, target, ruleId, alreadyLive ? effectiveWritten : lastWritten, null);
      return { outcome: pinned ? "pinned" : "unchanged", target, ruleId, reason: "no change" };
    }

    // Two INDEPENDENT writes: the conversation attribute (canonical value,
    // used by the native-conversations Workflow and visible on every
    // conversation) and — for converted Customer tickets — the TICKET
    // attribute mirror (ticket-context Workflow triggers have NO channel
    // gate, so the bridged-ticket SLA Workflow branches on this one). Either
    // definition may be missing in Intercom (conversation attributes are
    // UI-only to create; ticket attributes come from Ensure Ticket
    // Attributes) — a permanent 4xx on one must not block the other.
    // Transient failures (5xx/429) rethrow for the retry machinery.
    const attrName = this.settingsStore.slaAttributeName();
    const isTransient = (e: unknown) => e instanceof IntercomHttpError && (e.status >= 500 || e.status === 429);
    let convError: string | null = null;
    try {
      await this.intercomClient.setConversationAttributes(conversationId, { [attrName]: effectiveWritten });
    } catch (e) {
      if (isTransient(e)) throw e; // outbox/activity retry or next sweep owns it
      convError = e instanceof Error ? e.message : String(e);
      slaLog.warn("sla.conversation_attr.degraded", {
        "intercom.conversation_id": conversationId,
        "error.message": convError,
      });
    }
    let ticketOk = false;
    if (input.ticketId) {
      const adminId = this.settingsStore.intercomAuthorAdminId();
      try {
        await this.intercomClient.updateTicket(input.ticketId, {
          attributes: { [attrName]: effectiveWritten },
          ...(adminId ? { adminId } : {}),
        });
        ticketOk = true;
      } catch (e) {
        if (isTransient(e)) throw e;
        slaLog.warn("sla.ticket_attr.degraded", {
          "intercom.ticket_id": input.ticketId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (convError != null && !ticketOk) {
      // NOTHING landed — surface it (Verify Setup shows the missing pieces).
      await this.upsertState(stateId, kind, conversationId, target, ruleId, lastWritten, convError);
      slaLog.warn("sla.write.permanent_failure", {
        "intercom.conversation_id": conversationId,
        "sla.target": effectiveWritten,
        "error.message": convError,
      });
      metricCount("sla.writes", 1, { outcome: "permanent_error" });
      return { outcome: "error", target, ruleId, reason: convError };
    }

    await this.upsertState(stateId, kind, conversationId, target, ruleId, effectiveWritten, null);
    await this.noteKick(stateId, kind, conversationId, input.threadId, target, state?.lastKickPartId ?? null);
    slaLog.info("sla.target.written", {
      "intercom.conversation_id": conversationId,
      "sla.kind": kind,
      "sla.target": effectiveWritten,
      "sla.rule_id": ruleId ?? undefined,
      "sla.pinned": pinned,
      "sla.reason": reason,
    });
    metricCount("sla.writes", 1, { outcome: "written" });
    return { outcome: pinned ? "pinned" : "written", target, ruleId };
  }

  // Internal note on every target CHANGE. Two jobs: agent-visible signal in
  // the inbox, and the Workflow kick — Intercom has NO attribute-change
  // trigger, so the SLA Workflow uses trigger "Teammate adds a note" and
  // branches on the freshly-written attribute (the note always lands AFTER
  // the attribute writes). AUTHORSHIP MATTERS: the trigger ignores notes
  // authored by the Operator/Fin BOT (empirically verified — "Teammate" means
  // a human admin), so the kick is authored as the configured HUMAN fallback
  // admin, never the Operator. Best-effort — never fails the write.
  private async noteKick(
    stateId: string,
    kind: "bridged" | "native",
    conversationId: string,
    threadId: string | undefined,
    target: string | null,
    previousPartId: string | null
  ): Promise<void> {
    if (!this.settingsStore.slaNoteKickEnabled()) return;
    // Authored as a human teammate (trigger requirement) — the marker keeps
    // agents from mistaking it for something that teammate wrote themselves.
    const content = `${target ? `🎯 SLA target: <b>${target}</b>` : "🎯 SLA target cleared"} — <i>automated by the support bot</i>`;
    // Human admin ONLY — the dedicated SLA note author when set, else the
    // general fallback admin. Never intercomAuthorAdminId(): that prefers the
    // Operator/Fin bot, whose notes do NOT fire "Teammate adds a note".
    const adminId = this.settingsStore.slaNoteAdminId() ?? this.settingsStore.intercomAdminId();
    if (!adminId) {
      slaLog.warn("sla.note_kick.no_human_admin", {
        "intercom.conversation_id": conversationId,
        "sla.hint": "pick a fallback admin in /config → Integrations → Intercom — the SLA Workflow trigger ignores Fin-authored notes",
      });
      return;
    }
    try {
      // Supersede the previous kick: redact it so the conversation only ever
      // shows the CURRENT target (Intercom has no hard-delete for parts — it
      // becomes a "message deleted" placeholder). Best-effort: a failed
      // redaction never blocks the new kick.
      if (previousPartId) {
        await this.intercomClient.redactConversationPart(conversationId, previousPartId).catch(() => undefined);
      }
      const { partId } = await this.intercomClient.replyAsAdmin(conversationId, { adminId, body: content, note: true });
      if (kind === "bridged" && threadId && partId) {
        // Echo-register so the noted-webhook doesn't relay the kick into the
        // Discord thread. Registered right after the POST returns — the
        // webhook echo travels through the Temporal inbox, so it can't win
        // the race in practice. (Native conversations have no link → the
        // noted-webhook drops them without this.)
        await this.intercomStore.recordEchoPart("c", partId, threadId).catch(() => undefined);
      }
      await this.prisma.slaState.updateMany({ where: { id: stateId }, data: { lastKickPartId: partId ?? null } });
    } catch (e) {
      slaLog.warn("sla.note_kick.failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async upsertState(
    id: string,
    kind: "bridged" | "native",
    conversationId: string,
    lastTarget: string | null,
    lastRuleId: string | null,
    lastWrittenTarget: string | null,
    lastWriteError: string | null
  ): Promise<void> {
    const now = new Date();
    await this.prisma.slaState.upsert({
      where: { id },
      create: { id, kind, conversationId, lastTarget, lastRuleId, lastWrittenTarget, lastEvaluatedAt: now, lastWriteError },
      update: { conversationId, lastTarget, lastRuleId, lastWrittenTarget, lastEvaluatedAt: now, lastWriteError },
    });
  }
}
