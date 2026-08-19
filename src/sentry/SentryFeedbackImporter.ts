import type { SettingsStore } from "../config/SettingsStore";
import { IntercomHttpError, type IntercomClient } from "../intercom/IntercomClient";
import type { SentryFeedbackTickResult } from "../temporal/types";
import { log } from "../util/logger";
import {
  advanceWatermark,
  buildConversationBody,
  buildMetadataNote,
  buildTicketAttributes,
  planFeedbackWalk,
} from "./feedbackFormat";
import type { SentryFeedbackClient, SentryFeedbackIssue } from "./SentryFeedbackClient";
import type { SentryFeedbackStore } from "./SentryFeedbackStore";
import type { PostizOrgLinkStore } from "../postiz/PostizOrgLinkStore";

const syncLog = log.child("sentry:feedback");

// Re-scanned window behind the watermark every tick — absorbs Sentry
// ingestion/indexing lag around the floor; the ledger dedups the re-reads.
const WATERMARK_OVERLAP_MS = 10 * 60 * 1000;
// 10 pages × 100 = the listing bound per tick; anything past it surfaces on
// the next tick because the watermark only advances through processed items.
const MAX_PAGES = 10;
// Import cap per tick (each import = up to ~5 Intercom writes). Overflow is
// logged and picked up next tick — never a silent drop.
const MAX_IMPORTS_PER_TICK = 25;
// Politeness pacing between Intercom writes (shared sweep idiom).
const WRITE_SPACING_MS = 400;
const FEEDBACK_TAG = "sentry-feedback";

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
  async tick(force: boolean): Promise<SentryFeedbackTickResult> {
    const result: SentryFeedbackTickResult = {
      listed: 0,
      imported: 0,
      skippedNoEmail: 0,
      deduped: 0,
      replayed: 0,
      replayExhausted: 0,
      errors: 0,
      capped: false,
      skipped: true,
    };
    if (!this.settingsStore.intercomConfigured()) return result;
    if (!this.settingsStore.sentryFeedbackConfigured()) return result;
    if (!this.settingsStore.sentryReadEnabled() && !force) return result;
    // Note/tag/assignment author — same resolution as the inactivity sweeper.
    const adminId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    if (!adminId) return result;
    result.skipped = false;

    const now = new Date();
    // sentryFeedbackConfigured() guarantees the watermark exists.
    const watermark = this.settingsStore.sentryFeedbackWatermarkAt() as Date;
    const floor = new Date(watermark.getTime() - WATERMARK_OVERLAP_MS);

    // ---- list (newest-first pages; planFeedbackWalk re-sorts ascending) ----
    const items: SentryFeedbackIssue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.sentry.listFeedbackIssues({
        startIso: floor.toISOString(),
        endIso: now.toISOString(),
        cursor,
      });
      items.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    result.listed = items.length;

    // The org issues endpoint's `project` param wants numeric ids, so the
    // slug allowlist filters client-side (authoritative either way).
    const projectFilter = new Set(this.settingsStore.sentryFeedbackProjectSlugs());
    const scoped =
      projectFilter.size > 0
        ? items.filter((i) => i.projectSlug && projectFilter.has(i.projectSlug.toLowerCase()))
        : items;

    const { todo, overflow } = planFeedbackWalk(scoped, floor, MAX_IMPORTS_PER_TICK);
    if (overflow > 0) {
      result.capped = true;
      syncLog.warn("sentry.feedback.cap_hit", { "feedback.remaining": overflow });
    }

    // Ascending outcomes drive the watermark: it advances through terminal
    // items and freezes at the first failure (retried next tick; the ledger
    // dedups everything committed behind it).
    const outcomes: Array<{ feedbackAt: Date; terminal: boolean }> = [];
    let lastWriteAt = 0;
    const paceWrite = async (): Promise<void> => {
      const wait = lastWriteAt + WRITE_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastWriteAt = Date.now();
    };
    let tagId: string | null = null;

    for (const issue of todo) {
      const feedbackAt = new Date(issue.firstSeen);
      try {
        if (await this.store.getByIssueId(issue.id)) {
          result.deduped++;
          outcomes.push({ feedbackAt, terminal: true });
          continue;
        }
        const context = await this.sentry.getFeedbackContext(issue.id);
        await this.harvestLink(context.identity);
        const email = context.contactEmail;
        if (!email) {
          await this.store.insertSkipped({
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
          result.skippedNoEmail++;
          outcomes.push({ feedbackAt, terminal: true });
          continue;
        }

        const match = await this.ensureContact(email, context.name, paceWrite);
        const fromType = match.role === "lead" ? "lead" : "user";

        await paceWrite();
        const conversationId = await this.intercom.createConversation(
          match.id,
          buildConversationBody(context.message ?? ""),
          issue.firstSeen,
          fromType
        );
        // Commit point — the ledger row lands directly after the only
        // non-idempotent call (create-then-insert: a crash inside this window
        // can duplicate ONE conversation, which is visible and trivially
        // closed; insert-first would silently lose feedback instead).
        await this.store.insertImported({
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
        result.imported++;
        outcomes.push({ feedbackAt, terminal: true });

        // Decorations are best-effort: the ledger row exists, so dedup and
        // the sweeper/SLA exemptions hold even when any of these fail.
        // Ticket conversion first ("normal ticket" parity): convert failure
        // leaves a plain conversation import standing — retrying the whole
        // item would duplicate the conversation instead.
        let ticketId: string | null = null;
        const ticketTypeId = this.settingsStore.sentryFeedbackTicketTypeId();
        if (ticketTypeId) {
          try {
            await paceWrite();
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
            await paceWrite();
            await this.intercom.assignConversationToTeam(conversationId, teamId, adminId);
          } catch (e) {
            syncLog.warn("sentry feedback import: team assignment failed", {
              "intercom.conversation_id": conversationId,
              "error.message": e instanceof Error ? e.message : String(e),
            });
          }
          if (ticketId) {
            // Bridge parity: the converted ticket gets the team too.
            try {
              await paceWrite();
              await this.intercom.updateTicket(ticketId, { assigneeId: teamId, adminId });
            } catch (e) {
              syncLog.warn("sentry feedback import: ticket team assignment failed", {
                "intercom.ticket_id": ticketId,
                "error.message": e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
        try {
          await paceWrite();
          await this.intercom.replyAsAdmin(conversationId, {
            adminId,
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
          if (tagId === null) tagId = (await this.intercom.findOrCreateTag(FEEDBACK_TAG)).id;
          await paceWrite();
          await this.intercom.tagConversation(conversationId, tagId, adminId);
        } catch (e) {
          syncLog.warn("sentry feedback import: tag failed", {
            "intercom.conversation_id": conversationId,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      } catch (e) {
        result.errors++;
        outcomes.push({ feedbackAt, terminal: false });
        syncLog.warn("sentry feedback import: item failed", {
          "sentry.issue_id": issue.id,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Replay shares the tick's import budget so a large backlog cannot flood
    // Intercom in one pass; whatever is left over drains on later ticks.
    await this.replaySkipped(result, MAX_IMPORTS_PER_TICK - result.imported, adminId, paceWrite, now);

    const newMark = advanceWatermark(outcomes, watermark);
    await this.settingsStore.recordSentryFeedbackSync({
      lastSyncAt: now,
      watermarkAt: newMark.getTime() > watermark.getTime() ? newMark : undefined,
    });
    syncLog.info("sentry.feedback_sync", {
      "feedback.listed": result.listed,
      "feedback.imported": result.imported,
      "feedback.skipped_no_email": result.skippedNoEmail,
      "feedback.deduped": result.deduped,
      "feedback.replayed": result.replayed,
      "feedback.replay_exhausted": result.replayExhausted,
      "feedback.errors": result.errors,
      "feedback.capped": result.capped,
      "feedback.forced": force,
    });
    return result;
  }

  // Intercom contact for a submitter email: prefer an existing user-role match
  // (a real customer record), reuse a lead-only match as-is, else create.
  private async ensureContact(
    email: string,
    name: string | null,
    paceWrite: () => Promise<void>
  ): Promise<{ id: string; role: string | null }> {
    const matches = await this.intercom.searchContactsByEmail(email);
    const found = matches.find((m) => m.role === "user") ?? matches.find((m) => m.role === "lead") ?? null;
    if (found) return found;

    await paceWrite();
    try {
      return { id: (await this.intercom.createEmailContact({ email, name })).id, role: "user" };
    } catch (e) {
      // 409 = create raced an existing/archived record — one re-search; still
      // nothing → item failure (retried next tick).
      if (!(e instanceof IntercomHttpError && e.status === 409)) throw e;
      const retry = await this.intercom.searchContactsByEmail(email);
      const raced = retry.find((m) => m.role === "user") ?? retry[0] ?? null;
      if (!raced) throw e;
      return raced;
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
    now: Date
  ): Promise<void> {
    if (budget <= 0) return;

    const candidates = await this.store.listSkippedForRetry(budget);
    for (const row of candidates) {
      try {
        const context = await this.sentry.getFeedbackContext(row.sentryIssueId);
        await this.harvestLink(context.identity);
        const email = context.contactEmail;
        if (!email) {
          await this.store.markRetried(row.sentryIssueId, now);
          result.replayExhausted++;
          continue;
        }

        const match = await this.ensureContact(email, context.name ?? row.contactName, paceWrite);
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
