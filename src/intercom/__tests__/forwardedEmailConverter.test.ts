import { test } from "node:test";
import assert from "node:assert/strict";
import { ForwarderRoster } from "../forwarderRoster";
import { ForwardedEmailConverter } from "../ForwardedEmailConverter";
import { IntercomHttpError, type IntercomClient } from "../IntercomClient";
import type { ForwardConvertStore } from "../ForwardConvertStore";
import type { SettingsStore } from "../../config/SettingsStore";
import type { AuditLogger } from "../../bot/AuditLogger";

// Hand-rolled fakes (importer.test.ts style): every Intercom/store interaction
// lands in `ops` so call ORDER is assertable.

type Src = Awaited<ReturnType<IntercomClient["getConversationSource"]>>;

const GMAIL_BODY = [
  "---------- Forwarded message ---------",
  "From: Jane Customer <jane@example.com>",
  "Date: Mon, Jul 20, 2026 at 3:14 PM",
  "Subject: Cannot connect Instagram",
  "To: Nevo <nevo@postiz.com>",
  "",
  "Connecting Instagram fails with error 400.",
].join("\n");

function makeSrc(overrides: Partial<Src> = {}): Src {
  return {
    createdAt: new Date("2026-07-20T15:20:00Z"),
    open: true,
    state: "open",
    subject: "Fwd: Cannot connect Instagram",
    authorType: "user",
    authorId: "contact-nevo",
    authorEmail: "nevo@postiz.com",
    bodyPlain: GMAIL_BODY,
    attachments: [],
    teamAssigneeId: null,
    hasAgentPart: false,
    ...overrides,
  };
}

interface HarnessOpts {
  enabled?: boolean;
  configured?: boolean;
  adminId?: string | null;
  src?: Src;
  emailMatches?: Array<{ id: string; role: "user" | "lead" }>;
  create409?: "archived" | "raced" | null;
  searchAfter409?: Array<{ id: string; role: "user" | "lead" }>;
  ledgerOriginal?: string | null; // pre-seed a row keyed by this ORIGINAL id
  ledgerNew?: string | null; // pre-seed a row keyed by this NEW id
  tagFails?: boolean;
  contactReplyFails?: boolean;
  extraEmails?: string[];
}

interface Harness {
  converter: ForwardedEmailConverter;
  ops: string[];
  inserted: Array<Record<string, unknown>>;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const ops: string[] = [];
  const inserted: Array<Record<string, unknown>> = [];

  const settings = {
    forwardConvertEnabled: () => opts.enabled ?? true,
    intercomConfigured: () => opts.configured ?? true,
    intercomAdminId: () => (opts.adminId === undefined ? "adm-author" : opts.adminId),
    intercomAuthorAdminId: () => null,
    forwardConvertTagName: () => "email",
    forwardConvertCloseNote: () => null,
    forwardConvertExtraEmails: () => opts.extraEmails ?? [],
  } as unknown as SettingsStore;

  const byOriginal = new Map<string, Record<string, unknown>>();
  const byNew = new Map<string, Record<string, unknown>>();
  if (opts.ledgerOriginal) {
    byOriginal.set(opts.ledgerOriginal, {
      originalConversationId: opts.ledgerOriginal,
      newConversationId: "prior-new",
      customerEmail: "prior@example.com",
    });
  }
  if (opts.ledgerNew) byNew.set(opts.ledgerNew, { newConversationId: opts.ledgerNew, customerEmail: "x@example.com" });
  const store = {
    async getByOriginalConversationId(id: string) {
      return byOriginal.get(id) ?? null;
    },
    async getByNewConversationId(id: string) {
      return byNew.get(id) ?? null;
    },
    async insertConverted(data: Record<string, unknown>) {
      ops.push("store.insert");
      inserted.push(data);
      byOriginal.set(String(data.originalConversationId), data);
      byNew.set(String(data.newConversationId), data);
    },
    async setAttachmentsReuploaded(id: string) {
      ops.push(`store.reuploaded:${id}`);
    },
  } as unknown as ForwardConvertStore;

  let after409 = false;
  const client = {
    async listAdmins() {
      ops.push("ic.admins");
      return [
        { id: "a-nevo", name: "Nevo", email: "nevo@postiz.com", avatarUrl: null, awayModeEnabled: false, hasInboxSeat: false },
        { id: "a-agent", name: "Agent", email: "agent@postiz.com", avatarUrl: null, awayModeEnabled: false, hasInboxSeat: true },
      ];
    },
    async getConversationSource(id: string) {
      ops.push(`ic.source:${id}`);
      return opts.src ?? makeSrc();
    },
    async searchContactsByEmail(email: string) {
      ops.push(`ic.search:${email}`);
      if (after409 && opts.searchAfter409) return opts.searchAfter409;
      return opts.emailMatches ?? [];
    },
    async createEmailContact(input: { email: string }) {
      ops.push(`ic.createContact:${input.email}`);
      if (opts.create409 === "archived") {
        after409 = true;
        throw new IntercomHttpError(409, "An archived contact matching those details already exists with id=arch1");
      }
      if (opts.create409 === "raced") {
        after409 = true;
        throw new IntercomHttpError(409, "duplicate contact");
      }
      return { id: "contact-new" };
    },
    async unarchiveContact(id: string) {
      ops.push(`ic.unarchive:${id}`);
    },
    async createConversation(contactId: string, _body: string, _iso?: string, fromType = "user") {
      ops.push(`ic.createConv:${contactId}:${fromType}`);
      return "new-conv-1";
    },
    async assignConversationToTeam(conversationId: string, teamId: string) {
      ops.push(`ic.team:${conversationId}:${teamId}`);
    },
    async findOrCreateTag(name: string) {
      ops.push(`ic.tag.ensure:${name}`);
      if (opts.tagFails) throw new IntercomHttpError(500, "tag boom");
      return { id: "tag-1" };
    },
    async tagConversation(conversationId: string) {
      ops.push(`ic.tag.apply:${conversationId}`);
    },
    async replyAsContact(conversationId: string, input: { attachmentUrls?: string[] }) {
      ops.push(`ic.contactReply:${conversationId}:${input.attachmentUrls?.length ?? 0}`);
      if (opts.contactReplyFails) throw new IntercomHttpError(500, "reply boom");
      return { partId: "p1" };
    },
    async replyAsAdmin(conversationId: string, input: { note?: boolean; attachmentUrls?: string[] }) {
      ops.push(`ic.adminNote:${conversationId}:${input.note ? "note" : "reply"}:${input.attachmentUrls?.length ?? 0}`);
      return { partId: "p2" };
    },
    async setConversationOpen(conversationId: string, open: boolean) {
      ops.push(`ic.open:${conversationId}:${open}`);
    },
  } as unknown as IntercomClient;

  const audit = { log: async () => undefined } as unknown as AuditLogger;
  const roster = new ForwarderRoster(settings, client);
  return { converter: new ForwardedEmailConverter(settings, client, store, audit, roster), ops, inserted };
}

test("auto: happy path converts, commits create-then-insert, decorates and closes the original", async () => {
  const h = makeHarness({ src: makeSrc({ teamAssigneeId: "42" }) });
  const outcome = await h.converter.maybeConvertOnCreate("orig-1");
  assert.equal(outcome, "converted");

  const row = h.inserted[0];
  assert.equal(row.originalConversationId, "orig-1");
  assert.equal(row.newConversationId, "new-conv-1");
  assert.equal(row.customerEmail, "jane@example.com");
  assert.equal(row.forwarderAdminId, "a-nevo");
  assert.equal(row.trigger, "auto");

  // Order: create → ledger insert → decorations; original closed at the end.
  assert.ok(h.ops.indexOf("ic.createConv:contact-new:user") < h.ops.indexOf("store.insert"));
  assert.ok(h.ops.indexOf("store.insert") < h.ops.indexOf("ic.tag.ensure:email"));
  assert.ok(h.ops.includes("ic.team:new-conv-1:42"));
  assert.ok(h.ops.includes("ic.tag.apply:new-conv-1"));
  assert.ok(h.ops.includes("ic.adminNote:new-conv-1:note:0")); // provenance
  assert.ok(h.ops.includes("ic.adminNote:orig-1:note:0")); // close note
  assert.ok(h.ops.includes("ic.open:orig-1:false"));
});

test("auto: disabled toggle short-circuits with zero client calls", async () => {
  const h = makeHarness({ enabled: false });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "skipped");
  assert.deepEqual(h.ops, []);
});

test("auto: ledger hit by original id is idempotent-converted without client calls", async () => {
  const h = makeHarness({ ledgerOriginal: "orig-1" });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.deepEqual(h.ops, []);
});

test("auto: a recreated conversation never re-triggers (ledger by new id)", async () => {
  const h = makeHarness({ ledgerNew: "new-conv-9" });
  assert.equal(await h.converter.maybeConvertOnCreate("new-conv-9"), "skipped");
  assert.deepEqual(h.ops, []);
});

test("auto: payload pre-filter skips non-forward subjects and non-lite authors without a GET", async () => {
  const h1 = makeHarness();
  assert.equal(await h1.converter.maybeConvertOnCreate("c1", { subject: "Re: hello" }), "skipped");
  assert.ok(!h1.ops.some((o) => o.startsWith("ic.source")));

  const h2 = makeHarness();
  assert.equal(
    await h2.converter.maybeConvertOnCreate("c1", { subject: "Fwd: hello", author: { email: "agent@postiz.com" } }),
    "skipped"
  );
  assert.ok(!h2.ops.some((o) => o.startsWith("ic.source")));

  const h3 = makeHarness();
  assert.equal(
    await h3.converter.maybeConvertOnCreate("c1", { subject: "Fwd: hello", author: { email: "customer@elsewhere.com" } }),
    "skipped"
  );
  assert.ok(!h3.ops.some((o) => o.startsWith("ic.source")));
});

test("auto: fetched-state guards — agent part, closed, non-lite author", async () => {
  for (const src of [
    makeSrc({ hasAgentPart: true }),
    makeSrc({ open: false }),
    makeSrc({ authorEmail: "agent@postiz.com" }),
  ]) {
    const h = makeHarness({ src });
    assert.equal(await h.converter.maybeConvertOnCreate("c1"), "skipped");
    assert.ok(!h.ops.some((o) => o.startsWith("ic.createConv")));
  }
});

test("auto: refuses when the parsed sender is the forwarder or any teammate", async () => {
  const selfForward = GMAIL_BODY.replace("Jane Customer <jane@example.com>", "Nevo <nevo@postiz.com>");
  const h1 = makeHarness({ src: makeSrc({ bodyPlain: selfForward }) });
  assert.equal(await h1.converter.maybeConvertOnCreate("c1"), "skipped");

  const internal = GMAIL_BODY.replace("jane@example.com", "agent@postiz.com");
  const h2 = makeHarness({ src: makeSrc({ bodyPlain: internal }) });
  assert.equal(await h2.converter.maybeConvertOnCreate("c1"), "skipped");
  assert.ok(!h2.ops.some((o) => o.startsWith("ic.createConv")));
});

test("auto: lead-role match creates as lead and re-uploads via admin NOTE, never a contact reply", async () => {
  const h = makeHarness({
    emailMatches: [{ id: "lead-1", role: "lead" }],
    src: makeSrc({ attachments: [{ name: "log.txt", url: "https://cdn/x", contentType: "text/plain" }] }),
  });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.includes("ic.createConv:lead-1:lead"));
  assert.ok(h.ops.some((o) => o.startsWith("ic.adminNote:new-conv-1:note:1")));
  assert.ok(!h.ops.some((o) => o.startsWith("ic.contactReply")));
});

test("auto: archived-contact 409 unarchives and reuses the archived id", async () => {
  const h = makeHarness({ create409: "archived" });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.includes("ic.unarchive:arch1"));
  assert.ok(h.ops.includes("ic.createConv:arch1:user"));
});

test("auto: plain 409 re-searches and reuses the race winner", async () => {
  const h = makeHarness({ create409: "raced", searchAfter409: [{ id: "raced-1", role: "user" }] });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.includes("ic.createConv:raced-1:user"));
});

test("auto: decoration failure stays best-effort — tag boom still closes the original", async () => {
  const h = makeHarness({ tagFails: true });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.includes("ic.open:orig-1:false"));
});

test("auto: attachments chunk at 10 per part and stamp the reupload flag", async () => {
  const attachments = Array.from({ length: 12 }, (_, i) => ({
    name: `f${i}.png`,
    url: `https://cdn/${i}`,
    contentType: "image/png",
  }));
  const h = makeHarness({ emailMatches: [{ id: "u-1", role: "user" }], src: makeSrc({ attachments }) });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.includes("ic.contactReply:new-conv-1:10"));
  assert.ok(h.ops.includes("ic.contactReply:new-conv-1:2"));
  assert.ok(h.ops.includes("store.reuploaded:orig-1"));
});

test("auto: failed re-upload degrades to a link note and skips the flag", async () => {
  const h = makeHarness({
    emailMatches: [{ id: "u-1", role: "user" }],
    contactReplyFails: true,
    src: makeSrc({ attachments: [{ name: "a.png", url: "https://cdn/a", contentType: "image/png" }] }),
  });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "converted");
  assert.ok(h.ops.some((o) => o.startsWith("ic.adminNote:new-conv-1:note"))); // fallback link note
  assert.ok(!h.ops.some((o) => o.startsWith("store.reuploaded")));
});

test("auto: a listed extra address counts as a forwarder without any seat", async () => {
  const h = makeHarness({
    extraEmails: ["nevo.personal@gmail.com"],
    src: makeSrc({ authorEmail: "nevo.personal@gmail.com" }),
  });
  assert.equal(
    await h.converter.maybeConvertOnCreate("orig-1", { subject: "Fwd: x", author: { email: "nevo.personal@gmail.com" } }),
    "converted"
  );
  assert.equal(h.inserted[0].forwarderEmail, "nevo.personal@gmail.com");
});

test("auto: a listed extra address is refused as the conversion TARGET", async () => {
  const toListed = GMAIL_BODY.replace("jane@example.com", "nevo.personal@gmail.com");
  const h = makeHarness({ extraEmails: ["nevo.personal@gmail.com"], src: makeSrc({ bodyPlain: toListed }) });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "skipped");
  assert.ok(!h.ops.some((o) => o.startsWith("ic.createConv")));
});

test("auto: an unparseable forward stays untouched (no conversion, no writes)", async () => {
  const h = makeHarness({ src: makeSrc({ bodyPlain: "no headers here" }) });
  assert.equal(await h.converter.maybeConvertOnCreate("orig-1"), "skipped");
  assert.ok(!h.ops.some((o) => o.startsWith("ic.createConv")));
});
