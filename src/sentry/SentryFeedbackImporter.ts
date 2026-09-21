import type { SettingsStore } from "../config/SettingsStore";
import { IntercomHttpError, type IntercomClient } from "../intercom/IntercomClient";
import { ensureEmailContact } from "../intercom/emailContact";
import type { SentryFeedbackTickResult } from "../temporal/types";
import { log, redactSecrets } from "../util/logger";
import {
  advanceWatermark,
  buildConversationBody,
  buildMetadataNote,
  buildTicketAttributes,
  planFeedbackWalk,
} from "./feedbackFormat";
import type { SentryFeedbackClient, SentryFeedbackIssue } from "./SentryFeedbackClient";
import { MAX_ITEM_ATTEMPTS, type SentryFeedbackStore } from "./SentryFeedbackStore";
import type { PostizOrgLinkStore } from "../postiz/PostizOrgLinkStore";

const syncLog = log.child("sentry:feedback");

// Re-scanned window behind the watermark every tick — absorbs Sentry
// ingestion/indexing lag around the floor; the ledger dedups the re-reads.
const WATERMARK_OVERLAP_MS = 10 * 60 * 1000;
// 10 pages × 100 = the listing bound per tick; anything past it surfaces on
// the next tick because the watermark only advances through processed items.
const MAX_PAGES = 10;
// Import cap per tick, counted in IMPORTS — items already in the ledger cost
// one row of a query that has already run, so they are walked for free.
// Counting them against this cap is what let a window of 24 known items plus
// one permanent failure starve every newer submission for thirteen days.
const MAX_IMPORTS_PER_TICK = 25;
// Politeness pacing between Intercom writes (shared sweep idiom).
const WRITE_SPACING_MS = 400;
// Wall-clock budget for one tick, comfortably inside the activity's 10-minute
// start-to-close. A tick that runs out stops where it is and records what it
// finished: the watermark only ever advances through completed items, so the
// next tick resumes exactly where this one stopped. Without a budget a tick
// that outgrows its timeouts is killed SERVER-SIDE, which discards the whole
// run including the work it had already done, and every later tick repeats it
// and dies the same way.
const TICK_BUDGET_MS = 6 * 60_000;
const FEEDBACK_TAG = "sentry-feedback";
// The stored failure reason is rendered in a Discord embed, so it is trimmed
// to one line and capped. Redacted as defense in depth: an upstream error body
// is echoed into the message and nobody controls what it contains.
const MAX_STORED_ERROR_CHARS = 300;

function describeTickError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return trimStoredError(redactSecrets(raw));
}

function trimStoredError(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim() || "unknown error";
  return clean.length > MAX_STORED_ERROR_CHARS ? `${clean.slice(0, MAX_STORED_ERROR_CHARS - 1)}…` : clean;
}

// Per-tick state every item-level step shares: the counters it reports into,
// the admin it writes as, the pacing/heartbeat hooks, and the memoized tag.
interface WalkContext {
  adminId: string;
  result: SentryFeedbackTickResult;
  paceWrite: () => Promise<void>;
  beat: () => void;
  ensureTag: () => Promise<string>;
  // Newest item failure, surfaced on the /config panel so a tick that imports
  // nothing because of a bad item never again reads as "completed".
  lastItemError: string | null;
}

// Sentry User Feedback widget → Intercom: each feedback issue becomes ONE
// contact-initiated conversation (the submitter's email is the contact), so
// agents reply in Intercom and the reply reaches the submitter through
// Intercom's email fallback. Sentry is strictly read-only. Anonymous
// submissions (no contact_email) are skipped into the ledger for audit.
export class SentryFeedbackImporter {
  constructor(
    private sentry: SentryFeedbackClient,
    private intercom: IntercomClient,
    private store: SentryFeedbackStore,
    private settingsStore: SettingsStore,
    // Optional: every event read here may carry the organization and Stripe
    // customer together, which is the only place that pairing is observable.
    // Recording it is free, so it happens wherever an event is already loaded.
    private orgLinks?: PostizOrgLinkStore
  ) {}

  private contactAttrsEnsured = false;

  // Mirrors the account onto the Intercom CONTACT so it renders in Intercom's
  // own sidebar. Feedback submitters arrive with no Discord ticket behind them,
  // so the bridge's contact-attribute path never runs for them and this is the
  // only place they get identified natively.
  //
  // The definitions must exist before a value can be written; "already exists"
  // after the first run is the normal case, so every step is best-effort.
  private async stampContactIdentity(
    contactId: string,
    identity: { userId: string | null; orgId: string | null }
  ): Promise<void> {
    if (!identity.userId && !identity.orgId) return;
    // Guarded as a whole, not per call: this decorates an import that has
    // already succeeded, so nothing in here may turn a delivered conversation
    // into a failed item.
    try {
      if (!this.contactAttrsEnsured) {
        this.contactAttrsEnsured = true;
        await this.intercom
          .createContactAttribute("postiz_user_id", "Postiz platform user id resolved by the support bot")
          .catch(() => {});
        await this.intercom
          .createContactAttribute("postiz_org_id", "Postiz organization id resolved by the support bot")
          .catch(() => {});
      }
      await this.intercom.updateContact(contactId, {
        customAttributes: {
          ...(identity.userId ? { postiz_user_id: identity.userId } : {}),
          ...(identity.orgId ? { postiz_org_id: identity.orgId } : {}),
        },
      });
    } catch (e) {
      syncLog.warn("sentry feedback import: contact identity stamp failed", {
        "intercom.contact_id": contactId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Never allowed to disturb an import: the mapping is a side benefit.
  private async harvestLink(identity: { orgId: string | null; stripeCustomerId: string | null }): Promise<void> {
    if (!this.orgLinks) return;
    await this.orgLinks.recordIdentity(identity).catch((e) => {
      syncLog.warn("postiz org link record failed", {
        "error.message": e instanceof Error ? e.message : String(e),
      });
    });
  }

  // force = the /config "Sync Now" button: bypasses the enabled toggle (a
  // deliberate one-shot test) but never the configuration/watermark gate.
  //
  // Wrapper around run(): a tick that throws must still leave a trace. The
  // looper swallows activity failures (`.catch(() => {})`) and Temporal only
  // keeps them in its own history, so before this the sole symptom of a tick
  // failing every 15 minutes was a "Last sync" stamp that quietly stopped
  // moving. The reason is stamped here and the error is rethrown unchanged so
  // the activity still fails loudly for Sentry/Temporal.
  //
  // onProgress is the activity heartbeat, called from inside the work rather
  // than on a background timer: Temporal wants proof of PROGRESS, and a tick
  // that has stopped progressing has to be allowed to die.
  async tick(
    force: boolean,
    opts: { onProgress?: () => void; budgetMs?: number } = {}
  ): Promise<SentryFeedbackTickResult> {
    const beat = opts.onProgress ?? (() => {});
    const deadline = Date.now() + (opts.budgetMs ?? TICK_BUDGET_MS);
    const attemptAt = new Date();
    try {
      return await this.run(force, attemptAt, beat, () => Date.now() >= deadline);
    } catch (e) {
      await this.recordAttempt(attemptAt, describeTickError(e));
      throw e;
    }
  }

  // Stamps an attempt that did NOT complete (gated skip or failure): the sync
  // stamp is deliberately left where it was, so the panel can show a fresh
  // attempt next to a stale sync. Never allowed to mask the original failure.
  private async recordAttempt(attemptAt: Date, error: string): Promise<void> {
    await this.settingsStore.recordSentryFeedbackSync({ attemptAt, error }).catch((e) => {
      syncLog.warn("sentry feedback: recording the tick attempt failed", {
        "error.message": e instanceof Error ? e.message : String(e),
      });
    });
  }

  private async run(
    force: boolean,
    attemptAt: Date,
    beat: () => void,
    outOfTime: () => boolean
  ): Promise<SentryFeedbackTickResult> {
    const result: SentryFeedbackTickResult = {
      listed: 0,
      imported: 0,
      skippedNoEmail: 0,
      deduped: 0,
      failed: 0,
      recovered: 0,
      parked: 0,
      replayed: 0,
      replayExhausted: 0,
      errors: 0,
      capped: false,
      skipped: true,
      reason: null,
    };
    // Switched off is a state, not a fault: it needs no stamp (the panel says
    // "off" on its own) and must not write to BotSettings every 15 minutes.
    if (!this.settingsStore.sentryReadEnabled() && !force) return result;
    // Note/tag/assignment author — same resolution as the inactivity sweeper.
    const adminId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    // Every gate below IS a fault while the toggle is on: the operator expects
    // imports and gets none, so each one records which piece is missing.
    const gate = !this.settingsStore.intercomConfigured()
      ? "Intercom is not configured"
      : !this.settingsStore.sentryFeedbackConfigured()
        ? "Sentry read token, org slug or import floor missing"
        : !adminId
          ? "no Intercom admin id configured"
          : null;
    if (gate) {
      result.reason = gate;
      await this.recordAttempt(attemptAt, `skipped: ${gate}`);
      return result;
    }
    // Unreachable (the ladder above returns on a missing admin id); it keeps
    // the type narrowing in step with the gate.
    if (!adminId) return result;
    result.skipped = false;

    const now = new Date();
    // sentryFeedbackConfigured() guarantees the watermark exists.
    const watermark = this.settingsStore.sentryFeedbackWatermarkAt() as Date;
    const floor = new Date(watermark.getTime() - WATERMARK_OVERLAP_MS);

    // ---- list (newest-first pages; planFeedbackWalk re-sorts ascending) ----
    // A Sentry-side failure is held rather than thrown: the drains below talk
    // to a different API surface and must still run (and still record their
    // progress) while Sentry is refusing the listing. It is rethrown at the
    // end so the tick still counts as failed.
    const items: SentryFeedbackIssue[] = [];
    let listError: unknown = null;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      beat();
      if (outOfTime()) {
        result.capped = true;
        syncLog.warn("sentry.feedback.budget_hit", { "feedback.phase": "list", "feedback.page": page });
        break;
      }
      try {
        const res = await this.sentry.listFeedbackIssues({
          startIso: floor.toISOString(),
          endIso: now.toISOString(),
          cursor,
        });
        items.push(...res.items);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      } catch (e) {
        listError = e;
        result.errors++;
        syncLog.warn("sentry feedback: listing failed, the drains still run", {
          "feedback.page": page,
          "error.message": e instanceof Error ? e.message : String(e),
        });
        break;
      }
    }
    result.listed = items.length;

    // The org issues endpoint's `project` param wants numeric ids, so the
    // slug allowlist filters client-side (authoritative either way).
    const projectFilter = new Set(this.settingsStore.sentryFeedbackProjectSlugs());
    const scoped =
      projectFilter.size > 0
        ? items.filter((i) => i.projectSlug && projectFilter.has(i.projectSlug.toLowerCase()))
        : items;

    const eligible = planFeedbackWalk(scoped, floor);
    // One query for the whole page instead of one per item: the dedup verdict
    // has to be cheap, because every listed item is walked every tick until
    // the watermark passes it.
    const states: Map<string, { status: string; attempts: number }> =
      eligible.length > 0 ? await this.store.ledgerStates(eligible.map((i) => i.id)) : new Map();

    let lastWriteAt = 0;
    const paceWrite = async (): Promise<void> => {
      beat();
      const wait = lastWriteAt + WRITE_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastWriteAt = Date.now();
    };
    let tagId: string | null = null;
    const ctx: WalkContext = {
      adminId,
      result,
      paceWrite,
      beat,
      ensureTag: async () => {
        if (tagId === null) tagId = (await this.intercom.findOrCreateTag(FEEDBACK_TAG)).id;
        return tagId;
      },
      lastItemError: null,
    };

    // Ascending outcomes drive the watermark: it advances through terminal
    // items (imported, skipped, deduped, and failures the ledger accepted) and
    // freezes only at an item whose outcome could NOT be recorded — anything
    // else would replay that item forever.
    const outcomes: Array<{ feedbackAt: Date; terminal: boolean }> = [];
    let budget = MAX_IMPORTS_PER_TICK;

    for (const issue of eligible) {
      beat();
      // Stopping here is not a loss: `outcomes` already holds everything
      // finished, so the watermark advances past it and the remainder becomes
      // the next tick's work.
      if (outOfTime()) {
        result.capped = true;
        syncLog.warn("sentry.feedback.budget_hit", { "feedback.phase": "import", "feedback.done": outcomes.length });
        break;
      }
      const feedbackAt = new Date(issue.firstSeen);
      const state = states.get(issue.id);
      if (state) {
        // Already accounted for, whatever its outcome was. A failure counts
        // here too: retrying it is the drain's job, never the walk's, so one
        // bad submission can never again hold the queue behind it.
        if (state.status === "failed" && state.attempts >= MAX_ITEM_ATTEMPTS) result.parked++;
        else result.deduped++;
        outcomes.push({ feedbackAt, terminal: true });
        continue;
      }
      if (budget <= 0) {
        result.capped = true;
        syncLog.warn("sentry.feedback.cap_hit", { "feedback.remaining": eligible.length - outcomes.length });
        break;
      }
      budget--;
      outcomes.push({ feedbackAt, terminal: await this.processItem(issue, ctx) });
    }

    // Both drains share what is left of the import budget so a backlog cannot
    // flood Intercom in one pass; whatever is left over drains on later ticks.
    //
    // Isolated from the walk above on purpose. A drain is best-effort
    // background work, but it used to run INSIDE the tick's only success path,
    // so anything it threw (its candidate query included) discarded a walk
    // that had already imported and left the watermark where it was: the tick
    // then redid the same work every 15 minutes forever, importing nothing.
    let drainError: string | null = null;
    try {
      await this.retryFailedItems(ctx, MAX_IMPORTS_PER_TICK - result.imported, outOfTime);
    } catch (e) {
      result.errors++;
      drainError = `failure retry drain failed: ${describeTickError(e)}`;
      syncLog.warn("sentry feedback: failure retry drain failed, the import walk still counts", {
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await this.replaySkipped(result, MAX_IMPORTS_PER_TICK - result.imported, adminId, paceWrite, now, outOfTime, beat);
    } catch (e) {
      result.errors++;
      drainError = `${drainError ? `${drainError} · ` : ""}replay drain failed: ${describeTickError(e)}`;
      syncLog.warn("sentry feedback: replay drain failed, the import walk still counts", {
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }

    // A partial listing must not push the watermark past feedback it never
    // saw, so a failed listing records nothing but the attempt (the outer
    // catch does that) and leaves both stamps where they were.
    if (listError) throw listError;

    // Item failures are the panel's business too. Before this they lived only
    // in the logs, so a tick that imported nothing because a submission could
    // not be created still rendered as "completed".
    const problems: string[] = [];
    if (result.failed > 0) {
      problems.push(`${result.failed} item(s) failed${ctx.lastItemError ? `: ${ctx.lastItemError}` : ""}`);
    }
    if (drainError) problems.push(drainError);

    const newMark = advanceWatermark(outcomes, watermark);
    await this.settingsStore.recordSentryFeedbackSync({
      attemptAt,
      lastSyncAt: now,
      watermarkAt: newMark.getTime() > watermark.getTime() ? newMark : undefined,
      // The walk completed, so the sync stamp moves; a bad item or a failed
      // drain still leaves its reason on the panel rather than passing as
      // healthy.
      error: problems.length > 0 ? trimStoredError(problems.join(" · ")) : null,
    });
    syncLog.info("sentry.feedback_sync", {
      "feedback.listed": result.listed,
      "feedback.imported": result.imported,
      "feedback.skipped_no_email": result.skippedNoEmail,
      "feedback.deduped": result.deduped,
      "feedback.failed": result.failed,
      "feedback.recovered": result.recovered,
      "feedback.parked": result.parked,
      "feedback.replayed": result.replayed,
      "feedback.replay_exhausted": result.replayExhausted,
      "feedback.errors": result.errors,
      "feedback.capped": result.capped,
      "feedback.forced": force,
    });
    return result;
  }

  // One item, counted and recorded. Returns whether the outcome reached the
  // ledger: a failure that was WRITTEN is terminal (the drain owns it from
  // here), while one that could not be written keeps the watermark back so the
  // next tick sees the item again.
  private async processItem(issue: SentryFeedbackIssue, ctx: WalkContext): Promise<boolean> {
    try {
      const outcome = await this.importItem(issue, ctx);
      if (outcome === "imported") ctx.result.imported++;
      else ctx.result.skippedNoEmail++;
      return true;
    } catch (e) {
      ctx.result.errors++;
      ctx.result.failed++;
      ctx.lastItemError = describeTickError(e);
      syncLog.warn("sentry feedback import: item failed", {
        "sentry.issue_id": issue.id,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      try {
        await this.store.recordFailure({
          sentryIssueId: issue.id,
          sentryShortId: issue.shortId,
          projectSlug: issue.projectSlug,
          feedbackAt: new Date(issue.firstSeen),
          error: ctx.lastItemError,
        });
        return true;
      } catch (ledgerErr) {
        syncLog.warn("sentry feedback import: recording the item failure failed", {
          "sentry.issue_id": issue.id,
          "error.message": ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
        });
        return false;
      }
    }
  }

  // The import itself: contact → conversation → ledger → decorations. Shared
  // by the fresh walk and the failure retry drain, so a retried submission
  // lands exactly like a first-attempt one.
  private async importItem(issue: SentryFeedbackIssue, ctx: WalkContext): Promise<"imported" | "skipped"> {
    const feedbackAt = new Date(issue.firstSeen);
    const context = await this.sentry.getFeedbackContext(issue.id);
    ctx.beat();
    await this.harvestLink(context.identity);
    const email = context.contactEmail;
    if (!email) {
      await this.store.recordSkipped({
        sentryIssueId: issue.id,
        sentryShortId: issue.shortId,
        projectSlug: issue.projectSlug,
        contactName: context.name,
        pageUrl: context.url,
        feedbackAt,
        // Kept even without an email: an org or Stripe id still identifies
        // the account, and a later replay starts from these.
        postizUserId: context.identity.userId,
        postizOrgId: context.identity.orgId,
        stripeCustomerId: context.identity.stripeCustomerId,
      });
      return "skipped";
    }

    const match = await ensureEmailContact(
      this.intercom,
      { email, name: context.name },
      { beforeWrite: ctx.paceWrite, onWarn: (message, fields) => syncLog.warn(message, fields) }
    );
    await this.stampContactIdentity(match.id, context.identity);
    const fromType = match.role === "lead" ? "lead" : "user";

    await ctx.paceWrite();
    const conversationId = await this.intercom.createConversation(
      match.id,
      buildConversationBody(context.message ?? ""),
      issue.firstSeen,
      fromType
    );
    // Commit point — the ledger row lands directly after the only
    // non-idempotent call (create-then-record: a crash inside this window
    // can duplicate ONE conversation, which is visible and trivially
    // closed; recording first would silently lose feedback instead).
    await this.store.recordImported({
      sentryIssueId: issue.id,
      sentryShortId: issue.shortId,
      projectSlug: issue.projectSlug,
      contactEmail: email,
      contactName: context.name,
      intercomContactId: match.id,
      intercomConversationId: conversationId,
      pageUrl: context.url,
      feedbackAt,
      postizUserId: context.identity.userId,
      postizOrgId: context.identity.orgId,
      stripeCustomerId: context.identity.stripeCustomerId,
    });

    // Decorations are best-effort: the ledger row exists, so dedup and
    // the sweeper/SLA exemptions hold even when any of these fail.
    // Ticket conversion first ("normal ticket" parity): convert failure
    // leaves a plain conversation import standing — retrying the whole
    // item would duplicate the conversation instead.
    let ticketId: string | null = null;
    const ticketTypeId = this.settingsStore.sentryFeedbackTicketTypeId();
    if (ticketTypeId) {
      try {
        await ctx.paceWrite();
        ticketId = await this.convertFeedbackConversation(
          conversationId,
          ticketTypeId,
          buildTicketAttributes({ message: context.message })
        );
        await this.store.setTicketId(issue.id, ticketId);
      } catch (e) {
        ticketId = null;
        syncLog.warn("sentry feedback import: ticket conversion failed, staying a conversation", {
          "intercom.conversation_id": conversationId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Team routing directly after conversion (before note/tag): all
    // assignment-relevant writes land as early as possible — the balanced
    // admin pick itself is deliberately left to the enforcer's stray
    // sweep (the creation webhook skips imports to avoid churn).
    const teamId = this.settingsStore.sentryFeedbackTeamId();
    if (teamId) {
      try {
        await ctx.paceWrite();
        await this.intercom.assignConversationToTeam(conversationId, teamId, ctx.adminId);
      } catch (e) {
        syncLog.warn("sentry feedback import: team assignment failed", {
          "intercom.conversation_id": conversationId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
      if (ticketId) {
        // Bridge parity: the converted ticket gets the team too.
        try {
          await ctx.paceWrite();
          await this.intercom.updateTicket(ticketId, { assigneeId: teamId, adminId: ctx.adminId });
        } catch (e) {
          syncLog.warn("sentry feedback import: ticket team assignment failed", {
            "intercom.ticket_id": ticketId,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    try {
      await ctx.paceWrite();
      await this.intercom.replyAsAdmin(conversationId, {
        adminId: ctx.adminId,
        note: true,
        body: buildMetadataNote({
          pageUrl: context.url,
          shortId: issue.shortId,
          permalink: issue.permalink,
          identity: context.identity,
        }),
      });
    } catch (e) {
      syncLog.warn("sentry feedback import: metadata note failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    try {
      const tag = await ctx.ensureTag();
      await ctx.paceWrite();
      await this.intercom.tagConversation(conversationId, tag, ctx.adminId);
    } catch (e) {
      syncLog.warn("sentry feedback import: tag failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    return "imported";
  }

  // Re-runs submissions whose import failed. They are already behind the
  // watermark (that is the whole point of recording the failure), so the walk
  // will never see them again and this drain owns every retry — at most one
  // attempt per item per tick, until the attempt cap parks the row for good
  // and /config shows it.
  private async retryFailedItems(ctx: WalkContext, budget: number, outOfTime: () => boolean): Promise<void> {
    if (budget <= 0 || outOfTime()) return;
    const rows = await this.store.listFailedForRetry(budget);
    for (const row of rows) {
      if (outOfTime()) {
        ctx.result.capped = true;
        return;
      }
      ctx.beat();
      const before = ctx.result.imported;
      // The permalink is not on the ledger row, so the retried note carries
      // the short id alone.
      await this.processItem(
        {
          id: row.sentryIssueId,
          shortId: row.sentryShortId,
          title: null,
          firstSeen: row.feedbackAt.toISOString(),
          permalink: null,
          projectSlug: row.projectSlug,
        },
        ctx
      );
      if (ctx.result.imported > before) ctx.result.recovered++;
    }
  }

  // Re-examines submissions previously dropped as anonymous. The platform hides
  // the widget's email field and relies on the SDK filling it from the scope
  // user, so on builds that carry identity as tags instead the field arrives
  // empty and every submission looked anonymous. Those events did carry the
  // submitter, just somewhere the old reader did not look.
  //
  // One-shot by design: a row that still resolves to nothing is stamped and
  // left skipped, so the candidate set drains instead of being re-read forever.
  private async replaySkipped(
    result: SentryFeedbackTickResult,
    budget: number,
    adminId: string,
    paceWrite: () => Promise<void>,
    now: Date,
    outOfTime: () => boolean,
    beat: () => void
  ): Promise<void> {
    if (budget <= 0 || outOfTime()) return;

    const candidates = await this.store.listSkippedForRetry(budget);
    for (const row of candidates) {
      // The drain is the lowest-priority work in the tick, so it is the first
      // thing the budget takes back.
      if (outOfTime()) {
        result.capped = true;
        return;
      }
      try {
        const context = await this.sentry.getFeedbackContext(row.sentryIssueId);
        beat();
        await this.harvestLink(context.identity);
        const email = context.contactEmail;
        if (!email) {
          await this.store.markRetried(row.sentryIssueId, now);
          result.replayExhausted++;
          continue;
        }

        const match = await ensureEmailContact(
          this.intercom,
          { email, name: context.name ?? row.contactName },
          { beforeWrite: paceWrite, onWarn: (message, fields) => syncLog.warn(message, fields) }
        );
        await this.stampContactIdentity(match.id, context.identity);
        await paceWrite();
        const conversationId = await this.intercom.createConversation(
          match.id,
          buildConversationBody(context.message ?? ""),
          row.feedbackAt.toISOString(),
          match.role === "lead" ? "lead" : "user"
        );
        // Same commit ordering as a fresh import: the ledger row is updated
        // directly after the only non-idempotent call.
        await this.store.promoteToImported(row.sentryIssueId, {
          contactEmail: email,
          contactName: context.name ?? row.contactName,
          intercomContactId: match.id,
          intercomConversationId: conversationId,
          postizUserId: context.identity.userId,
          postizOrgId: context.identity.orgId,
          stripeCustomerId: context.identity.stripeCustomerId,
          retriedAt: now,
        });
        result.replayed++;

        // Best-effort note, matching a fresh import. The permalink is not on
        // the ledger row, so the note carries the short id alone.
        try {
          await paceWrite();
          await this.intercom.replyAsAdmin(conversationId, {
            adminId,
            note: true,
            body: buildMetadataNote({
              pageUrl: row.pageUrl,
              shortId: row.sentryShortId,
              permalink: null,
              identity: context.identity,
            }),
          });
        } catch (e) {
          syncLog.warn("sentry feedback replay: metadata note failed", {
            "intercom.conversation_id": conversationId,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      } catch (e) {
        // Left unstamped so a transient failure is retried on a later tick.
        result.errors++;
        syncLog.warn("sentry feedback replay: item failed", {
          "sentry.issue_id": row.sentryIssueId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // The bridge's attachTicket ladder minus the standalone rung: convert with
  // attributes → adopt an existing conversion (heal retry) → convert bare. No
  // unlinked-ticket fallback — a feedback ticket detached from its
  // conversation would orphan the email thread this feature exists for.
  private async convertFeedbackConversation(
    conversationId: string,
    ticketTypeId: string,
    attributes: Record<string, string>
  ): Promise<string> {
    try {
      return (await this.intercom.convertToTicket(conversationId, ticketTypeId, attributes)).ticketId;
    } catch (e) {
      if (e instanceof IntercomHttpError && e.status >= 400 && e.status < 500) {
        const existing = await this.intercom.getConversationTicketId(conversationId).catch(() => null);
        if (existing) return existing;
        return (await this.intercom.convertToTicket(conversationId, ticketTypeId)).ticketId;
      }
      throw e;
    }
  }
}
