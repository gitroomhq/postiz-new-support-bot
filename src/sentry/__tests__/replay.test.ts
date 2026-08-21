import { test } from "node:test";
import assert from "node:assert/strict";
import { SentryFeedbackImporter } from "../SentryFeedbackImporter";
import type { IntercomClient } from "../../intercom/IntercomClient";
import type { SentryFeedbackClient, SentryFeedbackContext } from "../SentryFeedbackClient";
import type { SentryFeedbackStore } from "../SentryFeedbackStore";
import type { SettingsStore } from "../../config/SettingsStore";

// Replay of submissions previously dropped as anonymous. These arrived while
// the reader only looked at contexts.feedback.contact_email, which the platform
// leaves empty on builds that carry the submitter as identity tags instead.

interface SkippedRow {
  sentryIssueId: string;
  sentryShortId: string | null;
  contactName: string | null;
  pageUrl: string | null;
  feedbackAt: Date;
}

interface HarnessOpts {
  rows?: SkippedRow[];
  contexts?: Record<string, SentryFeedbackContext>;
  contextThrows?: string[];
}

const skipped = (id: string): SkippedRow => ({
  sentryIssueId: id,
  sentryShortId: `POSTIZ-${id}`,
  contactName: "Someone",
  pageUrl: "https://app.example.com/page",
  feedbackAt: new Date("2026-08-01T10:00:00.000Z"),
});

const withIdentity = (email: string | null, over: Partial<SentryFeedbackContext> = {}): SentryFeedbackContext => ({
  contactEmail: email,
  name: "Someone",
  message: "it broke",
  url: "https://app.example.com/page",
  identity: { userId: "usr_1", email, orgId: "org_1", stripeCustomerId: "cus_1" },
  ...over,
});

function harness(opts: HarnessOpts = {}) {
  const ops: string[] = [];
  let breakStamp = false;
  const promoted: Array<{ id: string; email: string; orgId: string | null }> = [];
  const retried: string[] = [];

  const sentry = {
    async listFeedbackIssues() {
      return { items: [], nextCursor: null };
    },
    async getFeedbackContext(issueId: string) {
      if (opts.contextThrows?.includes(issueId)) throw new Error("sentry down");
      ops.push(`sentry.context:${issueId}`);
      return opts.contexts?.[issueId] ?? withIdentity(null);
    },
  } as unknown as SentryFeedbackClient;

  let conversationSeq = 0;
  const intercom = {
    async searchContactsByEmail(email: string) {
      ops.push(`intercom.search:${email}`);
      return [{ id: `contact_${email}`, role: "user" as const }];
    },
    async createConversation(contactId: string, _body: string, createdAt: string) {
      conversationSeq++;
      ops.push(`intercom.conversation:${contactId}:${createdAt}`);
      return `conv_${conversationSeq}`;
    },
    async replyAsAdmin(conversationId: string, input: { body: string }) {
      ops.push(`intercom.note:${conversationId}`);
      // The note is what carries the recovered ids to the agent.
      if (input.body.includes("org_1")) ops.push("note.has_org");
    },
    async createContactAttribute() {},
    async updateContact(contactId: string, input: { customAttributes?: Record<string, unknown> }) {
      if (breakStamp) throw new Error("attribute rejected");
      // The contact attributes are what make a feedback submitter identifiable
      // in Intercom's own sidebar; they have no Discord ticket behind them.
      ops.push(`intercom.contact_attrs:${contactId}:${Object.keys(input.customAttributes ?? {}).sort().join(",")}`);
    },
    async findOrCreateTag() {
      return { id: "tag_1" };
    },
    async tagConversation() {},
  } as unknown as IntercomClient;

  const store = {
    async getByIssueId() {
      return null;
    },
    async listSkippedForRetry(limit: number) {
      return (opts.rows ?? []).slice(0, limit);
    },
    async markRetried(sentryIssueId: string) {
      retried.push(sentryIssueId);
      ops.push(`store.retried:${sentryIssueId}`);
    },
    async promoteToImported(
      sentryIssueId: string,
      data: { contactEmail: string; postizOrgId?: string | null; intercomConversationId: string }
    ) {
      promoted.push({ id: sentryIssueId, email: data.contactEmail, orgId: data.postizOrgId ?? null });
      ops.push(`store.promoted:${sentryIssueId}:${data.intercomConversationId}`);
    },
  } as unknown as SentryFeedbackStore;

  const settings = {
    intercomConfigured: () => true,
    sentryFeedbackConfigured: () => true,
    sentryReadEnabled: () => true,
    intercomAdminId: () => "admin_1",
    intercomAuthorAdminId: () => "admin_1",
    sentryFeedbackWatermarkAt: () => new Date("2026-08-19T00:00:00.000Z"),
    sentryFeedbackProjectSlugs: () => [],
    sentryFeedbackTeamId: () => null,
    sentryFeedbackTicketTypeId: () => null,
    async recordSentryFeedbackSync() {},
  } as unknown as SettingsStore;

  return {
    importer: new SentryFeedbackImporter(sentry, intercom, store, settings),
    ops,
    promoted,
    retried,
    breakContactStamp: () => {
      breakStamp = true;
    },
  };
}

test("replay: a skipped row whose event carries an identity tag is imported after all", async () => {
  const h = harness({
    rows: [skipped("100")],
    contexts: { "100": withIdentity("recovered@example.com") },
  });
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 1);
  assert.equal(res.replayExhausted, 0);
  assert.deepEqual(h.promoted, [{ id: "100", email: "recovered@example.com", orgId: "org_1" }]);
  // Backdated to the original submission, not to replay time.
  assert.ok(h.ops.includes("intercom.conversation:contact_recovered@example.com:2026-08-01T10:00:00.000Z"));
  // The recovered ids reach the agent in the note.
  assert.ok(h.ops.includes("note.has_org"));
  assert.equal(h.retried.length, 0, "a promoted row is imported, not stamped as exhausted");
});

test("replay: a row with still no identity is stamped once and never retried again", async () => {
  const h = harness({ rows: [skipped("200")], contexts: { "200": withIdentity(null) } });
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 0);
  assert.equal(res.replayExhausted, 1);
  assert.deepEqual(h.retried, ["200"]);
  // No Intercom write at all for a genuinely anonymous submission.
  assert.ok(!h.ops.some((o) => o.startsWith("intercom.conversation")));
});

test("replay: a transient failure leaves the row unstamped so a later tick retries it", async () => {
  const h = harness({ rows: [skipped("300")], contextThrows: ["300"] });
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 0);
  assert.equal(res.replayExhausted, 0);
  assert.equal(res.errors, 1);
  assert.deepEqual(h.retried, [], "an unstamped row stays a candidate");
});

test("replay: shares the tick import budget so a backlog cannot flood Intercom at once", async () => {
  // Far more candidates than the per-tick cap of 25.
  const rows = Array.from({ length: 60 }, (_, i) => skipped(String(i)));
  const contexts = Object.fromEntries(
    rows.map((r) => [r.sentryIssueId, withIdentity(`user${r.sentryIssueId}@example.com`)])
  );
  const h = harness({ rows, contexts });
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 25);
  assert.equal(h.promoted.length, 25, "the remainder drains on later ticks");
});

test("replay: the contact identity stamp is decoration and cannot fail an import", async () => {
  // The stamp runs after the conversation exists. An Intercom that rejects the
  // attribute write (or a client missing the method entirely) must leave the
  // import standing rather than re-queueing a delivered conversation.
  const h = harness({ rows: [skipped("400")], contexts: { "400": withIdentity("x@example.com") } });
  h.breakContactStamp();
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 1);
  assert.equal(res.errors, 0);
  assert.equal(h.promoted.length, 1);
});

test("replay: mixed batch splits into recovered and exhausted without cross-contamination", async () => {
  const h = harness({
    rows: [skipped("1"), skipped("2"), skipped("3")],
    contexts: {
      "1": withIdentity("a@example.com"),
      "2": withIdentity(null),
      "3": withIdentity("c@example.com"),
    },
  });
  const res = await h.importer.tick(false);

  assert.equal(res.replayed, 2);
  assert.equal(res.replayExhausted, 1);
  assert.deepEqual(h.promoted.map((p) => p.id), ["1", "3"]);
  assert.deepEqual(h.retried, ["2"]);
});
