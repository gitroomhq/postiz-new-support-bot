import { test } from "node:test";
import assert from "node:assert/strict";
import { SentryFeedbackImporter } from "../SentryFeedbackImporter";
import { IntercomHttpError, type IntercomClient } from "../../intercom/IntercomClient";
import type { SentryFeedbackClient, SentryFeedbackContext, SentryFeedbackIssue } from "../SentryFeedbackClient";
import type { SentryFeedbackStore } from "../SentryFeedbackStore";
import type { SettingsStore } from "../../config/SettingsStore";

// Hand-rolled fakes (assignment.test.ts style): every Intercom/Sentry/store
// interaction lands in `ops` so call ORDER is assertable.

interface Harness {
  importer: SentryFeedbackImporter;
  ops: string[];
  ledger: Map<string, { status: string }>;
  recorded: Array<{ lastSyncAt: Date; watermarkAt?: Date }>;
}

interface HarnessOpts {
  issues?: SentryFeedbackIssue[];
  contexts?: Record<string, SentryFeedbackContext>;
  existingLedgerIds?: string[];
  emailMatches?: Array<{ id: string; role: "user" | "lead" | null }>;
  watermark?: Date;
  enabled?: boolean;
  configured?: boolean;
  teamId?: string | null;
  ticketTypeId?: string | null;
  projectSlugs?: string[];
  createContact409?: boolean;
  searchAfter409?: Array<{ id: string; role: "user" | "lead" | null }>;
  failNthConversation?: number; // the Nth createConversation call throws
  convertFails?: "permanent" | "permanent-with-existing" | "transient";
  noteFails?: boolean;
}

const issue = (id: string, iso: string, project = "postiz-web"): SentryFeedbackIssue => ({
  id,
  shortId: `POSTIZ-${id}`,
  title: "User Feedback",
  firstSeen: iso,
  permalink: `https://sentry.io/x/${id}`,
  projectSlug: project,
});

const context = (email: string | null, message = "hello"): SentryFeedbackContext => ({
  contactEmail: email,
  name: "Someone",
  message,
  identity: { userId: null, email, orgId: null, stripeCustomerId: null },
  url: "https://app.example.com/page",
});

function makeHarness(opts: HarnessOpts = {}): Harness {
  const ops: string[] = [];
  const ledger = new Map<string, { status: string }>((opts.existingLedgerIds ?? []).map((id) => [id, { status: "imported" }]));
  const recorded: Array<{ lastSyncAt: Date; watermarkAt?: Date }> = [];

  const sentry = {
    async listFeedbackIssues() {
      ops.push("sentry.list");
      return { items: opts.issues ?? [], nextCursor: null };
    },
    async getFeedbackContext(issueId: string) {
      ops.push(`sentry.context:${issueId}`);
      const ctx = opts.contexts?.[issueId];
      if (!ctx) throw new Error(`no context stubbed for ${issueId}`);
      return ctx;
    },
  } as unknown as SentryFeedbackClient;

  let contactSeq = 0;
  let convCallCount = 0;
  let after409 = false;
  const intercom = {
    async searchContactsByEmail(email: string) {
      ops.push(`ic.search:${email}`);
      if (after409 && opts.searchAfter409) return opts.searchAfter409;
      return opts.emailMatches ?? [];
    },
    async createEmailContact(input: { email: string }) {
      ops.push(`ic.createContact:${input.email}`);
      if (opts.createContact409) {
        after409 = true;
        throw new IntercomHttpError(409, "duplicate contact");
      }
      contactSeq++;
      return { id: `contact-${contactSeq}` };
    },
    async createConversation(contactId: string, _body: string, _createdAtIso?: string, fromType = "user") {
      ops.push(`ic.createConversation:${contactId}:${fromType}`);
      convCallCount++;
      if (opts.failNthConversation === convCallCount) throw new IntercomHttpError(500, "boom");
      return `conv-${contactId}`;
    },
    async replyAsAdmin(conversationId: string, input: { note?: boolean }) {
      ops.push(`ic.note:${conversationId}:${input.note ? "note" : "reply"}`);
      if (opts.noteFails) throw new IntercomHttpError(500, "note boom");
      return { partId: "p1" };
    },
    async findOrCreateTag(name: string) {
      ops.push(`ic.tag.ensure:${name}`);
      return { id: "tag-1" };
    },
    async tagConversation(conversationId: string) {
      ops.push(`ic.tag.apply:${conversationId}`);
    },
    async assignConversationToTeam(conversationId: string, teamId: string) {
      ops.push(`ic.assign:${conversationId}:${teamId}`);
    },
    async convertToTicket(conversationId: string, ticketTypeId: string, attributes?: Record<string, unknown>) {
      ops.push(`ic.convert:${conversationId}:${ticketTypeId}:${attributes ? "attrs" : "bare"}`);
      if (opts.convertFails === "transient") throw new IntercomHttpError(500, "convert boom");
      if (opts.convertFails === "permanent" || opts.convertFails === "permanent-with-existing") {
        throw new IntercomHttpError(422, "cannot convert");
      }
      return { ticketId: `ticket-${conversationId}` };
    },
    async getConversationTicketId(conversationId: string) {
      ops.push(`ic.ticketOf:${conversationId}`);
      return opts.convertFails === "permanent-with-existing" ? `ticket-existing-${conversationId}` : null;
    },
    async updateTicket(ticketId: string, input: { assigneeId?: string }) {
      ops.push(`ic.ticketAssign:${ticketId}:${input.assigneeId ?? "?"}`);
    },
  } as unknown as IntercomClient;

  const store = {
    async getByIssueId(id: string) {
      return ledger.get(id) ?? null;
    },
    async insertImported(data: { sentryIssueId: string }) {
      ops.push(`store.imported:${data.sentryIssueId}`);
      ledger.set(data.sentryIssueId, { status: "imported" });
    },
    async insertSkipped(data: { sentryIssueId: string }) {
      ops.push(`store.skipped:${data.sentryIssueId}`);
      ledger.set(data.sentryIssueId, { status: "skipped_no_email" });
    },
    async setTicketId(sentryIssueId: string, ticketId: string) {
      ops.push(`store.ticket:${sentryIssueId}:${ticketId}`);
    },
  } as unknown as SentryFeedbackStore;

  const settings = {
    intercomConfigured: () => opts.configured ?? true,
    sentryFeedbackConfigured: () => opts.configured ?? true,
    sentryReadEnabled: () => opts.enabled ?? true,
    intercomAdminId: () => "admin-1",
    intercomAuthorAdminId: () => "admin-1",
    sentryFeedbackWatermarkAt: () => opts.watermark ?? new Date("2026-07-20T10:00:00Z"),
    sentryFeedbackProjectSlugs: () => opts.projectSlugs ?? [],
    sentryFeedbackTeamId: () => opts.teamId ?? null,
    sentryFeedbackTicketTypeId: () => opts.ticketTypeId ?? null,
    recordSentryFeedbackSync: async (data: { lastSyncAt: Date; watermarkAt?: Date }) => {
      recorded.push(data);
    },
  } as unknown as SettingsStore;

  return { importer: new SentryFeedbackImporter(sentry, intercom, store, settings), ops, ledger, recorded };
}

test("unconfigured or disabled ticks skip without touching Sentry or Intercom", async () => {
  const off = makeHarness({ configured: false });
  assert.equal((await off.importer.tick(false)).skipped, true);
  assert.deepEqual(off.ops, []);

  const disabled = makeHarness({ enabled: false, issues: [issue("1", "2026-07-20T11:00:00Z")] });
  assert.equal((await disabled.importer.tick(false)).skipped, true);
  assert.deepEqual(disabled.ops, []);
});

test("force runs a disabled-but-configured tick (Sync Now semantics)", async () => {
  const h = makeHarness({ enabled: false, issues: [], contexts: {} });
  const result = await h.importer.tick(true);
  assert.equal(result.skipped, false);
  assert.deepEqual(h.ops, ["sentry.list"]);
});

test("anonymous feedback is skipped into the ledger with zero Intercom calls", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context(null) },
  });
  const result = await h.importer.tick(false);
  assert.equal(result.skippedNoEmail, 1);
  assert.equal(result.imported, 0);
  assert.deepEqual(h.ops, ["sentry.list", "sentry.context:1", "store.skipped:1"]);
  assert.equal(h.recorded[0].watermarkAt?.toISOString(), "2026-07-20T11:00:00.000Z");
});

test("existing user-role contact is reused; conversation → ledger → decorations in order", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [
      { id: "lead-9", role: "lead" },
      { id: "user-7", role: "user" },
    ],
    teamId: "team-3",
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.deepEqual(h.ops, [
    "sentry.list",
    "sentry.context:1",
    "ic.search:a@b.c",
    "ic.createConversation:user-7:user",
    "store.imported:1",
    "ic.assign:conv-user-7:team-3",
    "ic.note:conv-user-7:note",
    "ic.tag.ensure:sentry-feedback",
    "ic.tag.apply:conv-user-7",
  ]);
});

test("lead-only match is reused with fromType lead", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [{ id: "lead-9", role: "lead" }],
  });
  await h.importer.tick(false);
  assert.ok(h.ops.includes("ic.createConversation:lead-9:lead"));
});

test("no match creates an email contact; a 409 falls back to one re-search", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [],
    createContact409: true,
    searchAfter409: [{ id: "user-42", role: "user" }],
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.ok(h.ops.includes("ic.createContact:a@b.c"));
  assert.ok(h.ops.includes("ic.createConversation:user-42:user"));
});

test("a decoration failure does not fail the item (ledger row already committed)", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    noteFails: true,
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
  assert.ok(h.ops.includes("store.imported:1"));
  assert.ok(h.ops.includes("ic.tag.apply:conv-user-7")); // later decorations still ran
  assert.equal(h.recorded[0].watermarkAt?.toISOString(), "2026-07-20T11:00:00.000Z");
});

test("an item failure freezes the watermark; earlier successes advance it", async () => {
  const h = makeHarness({
    issues: [
      issue("1", "2026-07-20T11:00:00Z"),
      issue("2", "2026-07-20T12:00:00Z"),
      issue("3", "2026-07-20T13:00:00Z"),
    ],
    contexts: { "1": context("a@b.c"), "2": context("fail@b.c"), "3": context("c@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    // All items share contact user-7 → the second createConversation call IS item 2.
    failNthConversation: 2,
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 2);
  assert.equal(result.errors, 1);
  // Watermark stops at item 1 (the last terminal before the failure).
  assert.equal(h.recorded[0].watermarkAt?.toISOString(), "2026-07-20T11:00:00.000Z");
  // Item 3 is ledger-protected for the retry tick.
  assert.ok(h.ledger.has("3"));
});

test("ledger hits dedup without Intercom calls and still advance the watermark (cap-safe path)", async () => {
  const issues = Array.from({ length: 30 }, (_, i) =>
    issue(`i${i}`, `2026-07-20T11:${String(i).padStart(2, "0")}:00Z`)
  );
  const h = makeHarness({
    issues,
    existingLedgerIds: issues.map((i) => i.id),
  });
  const result = await h.importer.tick(false);
  assert.equal(result.deduped, 25); // MAX_IMPORTS_PER_TICK
  assert.equal(result.capped, true);
  assert.equal(result.imported, 0);
  assert.ok(!h.ops.some((op) => op.startsWith("ic.")));
  // Watermark advanced through the 25 processed items only.
  assert.equal(h.recorded[0].watermarkAt?.toISOString(), "2026-07-20T11:24:00.000Z");
});

test("ticket type set: convert lands right after the ledger commit, ticket gets the team too", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    ticketTypeId: "tt-9",
    teamId: "team-3",
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.deepEqual(h.ops, [
    "sentry.list",
    "sentry.context:1",
    "ic.search:a@b.c",
    "ic.createConversation:user-7:user",
    "store.imported:1",
    "ic.convert:conv-user-7:tt-9:attrs",
    "store.ticket:1:ticket-conv-user-7",
    "ic.assign:conv-user-7:team-3",
    "ic.ticketAssign:ticket-conv-user-7:team-3",
    "ic.note:conv-user-7:note",
    "ic.tag.ensure:sentry-feedback",
    "ic.tag.apply:conv-user-7",
  ]);
});

test("permanent convert failure adopts an existing conversion instead of degrading", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    ticketTypeId: "tt-9",
    convertFails: "permanent-with-existing",
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
  assert.ok(h.ops.includes("ic.ticketOf:conv-user-7"));
  assert.ok(h.ops.includes("store.ticket:1:ticket-existing-conv-user-7"));
});

test("convert failure is best-effort: the conversation import stands", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z")],
    contexts: { "1": context("a@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    ticketTypeId: "tt-9",
    convertFails: "transient",
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.equal(result.errors, 0);
  assert.ok(!h.ops.some((op) => op.startsWith("store.ticket:")));
  assert.ok(h.ops.includes("ic.note:conv-user-7:note")); // later decorations still ran
  assert.equal(h.recorded[0].watermarkAt?.toISOString(), "2026-07-20T11:00:00.000Z");
});

test("project allowlist filters client-side", async () => {
  const h = makeHarness({
    issues: [issue("1", "2026-07-20T11:00:00Z", "other-app"), issue("2", "2026-07-20T12:00:00Z", "postiz-web")],
    contexts: { "2": context("a@b.c") },
    emailMatches: [{ id: "user-7", role: "user" }],
    projectSlugs: ["postiz-web"],
  });
  const result = await h.importer.tick(false);
  assert.equal(result.imported, 1);
  assert.ok(!h.ops.includes("sentry.context:1"));
});
