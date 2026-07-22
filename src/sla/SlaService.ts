import { PrismaClient, SlaState } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { SlaRuleStore } from "./SlaRuleStore";
import { SlaFactsLoader } from "./facts";
import { evaluateRules } from "./evaluate";
import { SlaDim, SlaEvaluation, SlaFacts, hasClockDurations } from "./types";
import { IntercomStore } from "../intercom/IntercomStore";
import { IntercomClient, IntercomHttpError } from "../intercom/IntercomClient";
import { TicketStore } from "../bot/TicketStore";
import { SessionStore } from "../auth/SessionStore";
import { AuditLogger } from "../bot/AuditLogger";
import { TemporalProducers } from "../temporal/producers";
import type { SentryFeedbackStore } from "../sentry/SentryFeedbackStore";
import type { ForwardConvertStore } from "../intercom/ForwardConvertStore";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";

const slaLog = log.child("sla");

// The SLA manager's brain: evaluates the rule list against a subject and
// keeps the "SLA Target" conversation attribute in sync. The bot IS the SLA
// engine (Intercom Advanced has no native SLAs): the attribute is inbox
// visibility + Workflow/view branching input, and the 5-min SlaEnforcer
// looper runs the actual business-time clocks against it. Trigger entry
// points never throw; the apply core throws IntercomHttpError on transient
// write failures so the caller's retry machinery (per-ticket outbox delivery
// / inbound activity retry / next sweep) owns redelivery.

export type SlaSubjectRef = { threadId: string } | { conversationId: string };

export interface SlaApplyResult {
  outcome: "written" | "unchanged" | "pinned" | "skipped" | "error";
  target: string | null;
  ruleId: string | null;
  reason?: string;
}

export type SlaTriggerReason = "created" | "status" | "customer_reply" | "refund_review" | "stripe" | "manual" | "assignee";

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
    private producers: TemporalProducers | null,
    private feedbackStore: SentryFeedbackStore | null = null,
    private forwardConvertStore: ForwardConvertStore | null = null
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
    if (!this.settingsStore.intercomConfigured()) return this.skipped("intercom-unconfigured");
    // Imported Sentry feedback is not a support request: no SLA target, no
    // clocks (the enforcer skips them too). Single choke point — sweep,
    // webhook hooks and manual apply all route through here.
    if (this.feedbackStore && (await this.feedbackStore.getByConversationId(conversationId))) {
      return this.skipped("sentry-feedback-import");
    }
    // A converted forward's ORIGINAL is a closed teammate-authored husk; when
    // the forwarder mails the same thread again Intercom auto-reopens it and
    // the replied hook lands here — it must never grow SLA targets or clocks.
    // (The RECREATED conversation has no ledger row by original id, so it
    // flows through as a normal native subject.)
    if (this.forwardConvertStore && (await this.forwardConvertStore.getByOriginalConversationId(conversationId))) {
      return this.skipped("forward-converted-original");
    }

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
      description: `Pinned to \`${target}\`${"conversationId" in ref ? ` (conversation ${ref.conversationId})` : ""}; rules are bypassed until unpinned.`,
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
    attributeName: string;
    defaultTarget: string | null;
    ruleCount: number;
    enabledRuleCount: number;
  } {
    return {
      enabled: this.settingsStore.slaEnabled(),
      attributeName: this.settingsStore.slaAttributeName(),
      defaultTarget: this.settingsStore.slaDefaultTarget(),
      ruleCount: this.ruleStore.count(),
      enabledRuleCount: this.ruleStore.enabledCount(),
    };
  }

  async pinnedCount(): Promise<number> {
    return this.prisma.slaState.count({ where: { pinnedTarget: { not: null } } });
  }

  // Setup verification for the /intercom Verify Setup button. The bot is the
  // SLA engine now — no Workflows, no kick notes — but two conversation
  // attributes must exist (the API can LIST conversation attributes yet
  // cannot create them) and three webhook topics need their manual Developer
  // Hub subscriptions. Checks what the API can see; returns the manual
  // runbook for the rest. The enforcement-looper liveness check lives in the
  // SLA hub's Verify handler (it has the Temporal producers).
  async verifySetup(): Promise<{ attributeExists: boolean; statusAttributeExists: boolean; attributeName: string; runbook: string[] }> {
    const attributeName = this.settingsStore.slaAttributeName();
    const statusAttributeName = this.settingsStore.slaStatusAttributeName();
    let attributeExists = false;
    let statusAttributeExists = false;
    try {
      const attrs = await this.intercomClient.listConversationDataAttributes();
      attributeExists = attrs.some((a) => a.name === attributeName && !a.archived);
      statusAttributeExists = attrs.some((a) => a.name === statusAttributeName && !a.archived);
    } catch (e) {
      slaLog.warn("sla.verify.attr_list_failed", { "error.message": e instanceof Error ? e.message : String(e) });
    }
    let breachTagExists = false;
    try {
      const tags = await this.intercomClient.listTags();
      const tagName = this.settingsStore.slaBreachTagName().toLowerCase();
      breachTagExists = tags.some((t) => t.name.toLowerCase() === tagName);
    } catch {
      /* informational only — the enforcer find-or-creates it */
    }
    const targets = this.settingsStore.slaTargets();
    const withClocks = targets.filter(hasClockDurations);
    const targetValues = new Set(targets.map((t) => t.value));
    const rulesMissingClocks = this.ruleStore
      .snapshot()
      .filter((r) => r.enabled && (!targetValues.has(r.target) || !withClocks.some((t) => t.value === r.target)))
      .map((r) => r.target);
    const oh = this.settingsStore.officeHoursEnabled() ? this.settingsStore.officeHours() : undefined;
    const runbook = [
      attributeExists
        ? `✅ Conversation attribute **${attributeName}** exists.`
        : `❌ Create a **List** conversation attribute named exactly **${attributeName}** (Intercom → Settings → Data → Conversations; the API cannot create it). Options: ${targets.map((t) => `\`${t.value}\``).join(", ") || "add targets first"}.`,
      statusAttributeExists
        ? `✅ Conversation attribute **${statusAttributeName}** exists.`
        : `❌ Create a **List** conversation attribute named exactly **${statusAttributeName}** with options \`ok\`, \`at_risk\`, \`breached\` (the enforcement looper writes it; writes 4xx until it exists).`,
      `${withClocks.length > 0 ? "✅" : "❌"} ${withClocks.length}/${targets.length} target(s) have clock durations` +
        (withClocks.length === 0 ? ". Set durations in Targets, or no clock ever runs." : ".") +
        (rulesMissingClocks.length > 0
          ? ` ⚠️ Enabled rule target(s) without clocks: ${[...new Set(rulesMissingClocks)].map((t) => `\`${t}\``).join(", ")}.`
          : ""),
      oh === undefined
        ? "▫️ Office hours disabled: clocks run on wall clock (24/7)."
        : oh === null
          ? "❌ Office hours are enabled but the schedule is invalid; clocks fall back to wall clock until fixed."
          : `✅ Office hours: ${oh.tz}, clocks pause outside the schedule.`,
      breachTagExists
        ? `✅ Breach tag **${this.settingsStore.slaBreachTagName()}** exists.`
        : `▫️ Breach tag **${this.settingsStore.slaBreachTagName()}** will be created on first breach.`,
      "Developer Hub → your app → Webhooks: manually subscribe `conversation.user.created`, `conversation.user.replied` and `conversation.admin.assigned` (native rules, reopen-reassignment and the assignee dim need them; bridged target evaluation works without them).",
      "Old Expert-tier leftovers: delete the two Apply-SLA Workflows in Intercom if they still exist; native SLAs are gone on Advanced and the bot no longer posts kick notes.",
      "Ticket-attribute mirror: /intercom → Bridge → Ensure Ticket Attributes (unchanged; bridged Customer tickets mirror the target attribute).",
    ];
    return { attributeExists, statusAttributeExists, attributeName, runbook };
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
