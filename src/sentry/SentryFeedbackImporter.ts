import type { SettingsStore } from "../config/SettingsStore";
import { IntercomHttpError, type IntercomClient } from "../intercom/IntercomClient";
import type { SentryFeedbackTickResult } from "../temporal/types";
import { log } from "../util/logger";
import { advanceWatermark, buildConversationBody, buildMetadataNote, planFeedbackWalk } from "./feedbackFormat";
import type { SentryFeedbackClient, SentryFeedbackIssue } from "./SentryFeedbackClient";
import type { SentryFeedbackStore } from "./SentryFeedbackStore";

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
// Politeness pacing between Intercom writes (InactivitySweeper idiom).
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
    private settingsStore: SettingsStore
  ) {}

  // force = the /config "Sync Now" button: bypasses the enabled toggle (a
  // deliberate one-shot test) but never the configuration/watermark gate.
  async tick(force: boolean): Promise<SentryFeedbackTickResult> {
    const result: SentryFeedbackTickResult = {
      listed: 0,
      imported: 0,
      skippedNoEmail: 0,
      deduped: 0,
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
        const email = context.contactEmail;
        if (!email) {
          await this.store.insertSkipped({
            sentryIssueId: issue.id,
            sentryShortId: issue.shortId,
            projectSlug: issue.projectSlug,
            contactName: context.name,
            pageUrl: context.url,
            feedbackAt,
          });
          result.skippedNoEmail++;
          outcomes.push({ feedbackAt, terminal: true });
          continue;
        }

        // Contact: prefer an existing user-role match (real customer record);
        // a lead-only match is reused as-is (fromType "lead"); else create.
        const matches = await this.intercom.searchContactsByEmail(email);
        let match = matches.find((m) => m.role === "user") ?? matches.find((m) => m.role === "lead") ?? null;
        if (!match) {
          await paceWrite();
          try {
            match = { id: (await this.intercom.createEmailContact({ email, name: context.name })).id, role: "user" };
          } catch (e) {
            // 409 = create raced an existing/archived record — one re-search;
            // still nothing → item failure (retried next tick).
            if (!(e instanceof IntercomHttpError && e.status === 409)) throw e;
            const retry = await this.intercom.searchContactsByEmail(email);
            match = retry.find((m) => m.role === "user") ?? retry[0] ?? null;
            if (!match) throw e;
          }
        }
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
        });
        result.imported++;
        outcomes.push({ feedbackAt, terminal: true });

        // Decorations are best-effort: the ledger row exists, so dedup and
        // the sweeper/SLA exemptions hold even when any of these fail.
        try {
          await paceWrite();
          await this.intercom.replyAsAdmin(conversationId, {
            adminId,
            note: true,
            body: buildMetadataNote({
              name: context.name,
              email,
              pageUrl: context.url,
              shortId: issue.shortId,
              permalink: issue.permalink,
              projectSlug: issue.projectSlug,
              feedbackAtIso: issue.firstSeen,
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
      "feedback.errors": result.errors,
      "feedback.capped": result.capped,
      "feedback.forced": force,
    });
    return result;
  }
}
