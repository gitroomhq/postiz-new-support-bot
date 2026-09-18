import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { renderTextPdf, wrap, COLUMNS } from "../billing/evidence/pdf/textPdf";
import { redactAuthor, redactForBank } from "../billing/evidence/redact";
import {
  attachGeneratedDocuments,
  buildTranscriptDocument,
  buildUsageDocument,
} from "../billing/evidence/generatedDocuments";
import type { EvidenceFacts } from "../billing/evidence/tokens";

// The two evidence documents built from a dispute's own facts, and the
// dependency-free PDF writer underneath them.

// ---- the PDF itself ----

test("pdf: the output is a structurally valid PDF whose xref points at real objects", () => {
  // A reader that cannot resolve an object shows a blank page, and nobody finds
  // out until an analyst does. So the offsets are checked, not assumed.
  const pdf = renderTextPdf([{ text: "Title", bold: true }, { text: "" }, { text: "Body line" }]);
  const raw = pdf.toString("latin1");
  assert.ok(raw.startsWith("%PDF-1.4\n"));
  assert.ok(raw.trimEnd().endsWith("%%EOF"));

  const startxref = Number(raw.slice(raw.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
  assert.equal(raw.slice(startxref, startxref + 4), "xref", "startxref must land on the table");

  const offsets = [...raw.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.ok(offsets.length >= 6, "catalog, pages, two fonts, and at least one page/content pair");
  offsets.forEach((offset, i) => {
    assert.match(raw.slice(offset, offset + 20), new RegExp(`^${i + 1} 0 obj`), `object ${i + 1} is where xref says`);
  });
});

test("pdf: parentheses, backslashes and non-Latin characters cannot break the content stream", () => {
  // An unescaped bracket in a customer's message would corrupt every page after
  // it, which is the sort of thing that only shows up in the one document that
  // mattered.
  const raw = renderTextPdf([{ text: "a (b) c \\ d 中文 e" }]).toString("latin1");
  assert.ok(raw.includes("(a \\(b\\) c \\\\ d ?? e) Tj"), raw.slice(raw.indexOf("BT"), raw.indexOf("ET")));
});

test("pdf: long text pages, and wrapping never silently drops words", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ text: `line ${i}` }));
  const raw = renderTextPdf(many).toString("latin1");
  const pageCount = Number(/\/Count (\d+)/.exec(raw)![1]);
  assert.ok(pageCount >= 3, `expected several pages, got ${pageCount}`);
  assert.ok(raw.includes("(line 149) Tj"), "the last line is still rendered");

  const wrapped = wrap("the quick brown fox ".repeat(40).trim());
  assert.ok(wrapped.every((l) => l.length <= COLUMNS));
  assert.equal(wrapped.join(" ").split(/\s+/).length, 160, "every word survives the wrap");

  // A single unbreakable token longer than the line is broken rather than lost.
  const long = wrap("x".repeat(COLUMNS * 2 + 5));
  assert.equal(long.join("").length, COLUMNS * 2 + 5);
});

// ---- redaction ----

test("redaction: card numbers, third-party emails, phones and URL credentials are stripped", () => {
  const keepEmail = "ada@example.com";
  const text =
    "My card 4242 4242 4242 4242 was charged. Contact me at ada@example.com or my colleague bob@other.com, " +
    "phone +44 20 7946 0958. Reset link https://app.postiz.com/reset?token=abc123def";
  const out = redactForBank(text, { keepEmail });

  assert.ok(!out.includes("4242 4242 4242 4242"), out);
  assert.ok(!out.includes("bob@other.com"), out);
  assert.ok(!out.includes("7946 0958"), out);
  assert.ok(!out.includes("abc123def"), out);
  // The customer's own address is already elsewhere in the evidence, so masking
  // it only makes the document harder to follow.
  assert.ok(out.includes("ada@example.com"), out);
  // The path survives, so the analyst can still see where they were sent.
  assert.ok(out.includes("https://app.postiz.com/reset"), out);
  // A redaction that eats the following space, or strands a "+", reads as a
  // document that was mishandled, which invites doubt about the rest of it.
  assert.ok(!/\[redacted\][A-Za-z]/.test(out), out);
  assert.ok(!/[+]\s*\[redacted\]/.test(out), out);
  assert.ok(out.includes("charged."), "text after a redaction keeps its spacing");
});

test("redaction: identifiers that only look sensitive are left alone", () => {
  // Over-redaction costs context in every document; these are the cases most
  // likely to trip a lazy pattern.
  const out = redactForBank("Invoice A-4471 for order 100238 on 2026-09-17, plan 5 channels");
  assert.equal(out, "Invoice A-4471 for order 100238 on 2026-09-17, plan 5 channels");
});

test("redaction: a support agent is a role, not a person", () => {
  assert.equal(redactAuthor("agent Ada Lovelace"), "Postiz Support");
  assert.equal(redactAuthor("agent"), "Postiz Support");
  assert.equal(redactAuthor("customer"), "Customer");
});

// ---- the documents ----

const dispute = { id: "dp_1", status: "needs_response", evidence: {} } as unknown as Stripe.Dispute;

const facts = (over: Partial<EvidenceFacts> = {}): EvidenceFacts =>
  ({
    dispute: { id: "dp_1", amountText: "$29.00", reason: "subscription_canceled", openedIso: "2026-09-10T00:00:00.000Z", dueIso: null },
    charge: { dateIso: "2026-08-01T00:00:00.000Z", amountText: "$29.00" },
    customer: { id: "cus_1", email: "ada@example.com" },
    usage: {
      published: 42,
      publishedDeleted: 3,
      publishedBeforeCharge: 30,
      publishedSinceCharge: 12,
      deletedAfterDispute: 2,
      firstPublishedIso: "2026-02-01T00:00:00.000Z",
      lastPublishedIso: "2026-09-12T00:00:00.000Z",
      perPlatform: [{ platform: "linkedin", count: 30 }],
      perPlatformSinceCharge: [],
      channelsLive: 4,
      channelsDeleted: 0,
      channelsDuringPeriod: 4,
      channels: [{ name: "Acme", platform: "linkedin", connectedIso: "2026-02-01T00:00:00.000Z", deletedIso: null, disabled: false }],
      recentPosts: [],
      recentPostsSinceCharge: [{ publishedIso: "2026-09-12T00:00:00.000Z", platform: "linkedin", url: "https://li.example/p/1" }],
      queued: 6,
      lastSignInIso: null,
    },
    support: {
      historyLines: null,
      conversationCount: 1,
      firstContactIso: "2026-08-05T00:00:00.000Z",
      lastContactIso: "2026-08-05T00:00:00.000Z",
      noRefundRequest: true,
      transcript: [
        {
          conversationId: "c1",
          startedAtIso: "2026-08-05T00:00:00.000Z",
          messages: [
            { atIso: "2026-08-05T00:00:00.000Z", author: "customer", text: "How do I schedule? my card 4242424242424242" },
            { atIso: "2026-08-05T01:00:00.000Z", author: "agent Ada", text: "Open the calendar view." },
          ],
          clipped: false,
        },
      ],
    },
    reach: { charge: true, sub: true, billing: true, postiz: true, usage: true, cards: true, support: true },
    ...over,
  }) as unknown as EvidenceFacts;

test("usage document: states the counts, including the ones that do not flatter us", () => {
  const text = buildUsageDocument(dispute, facts())!
    .map((l) => l.text)
    .join("\n");
  assert.match(text, /Published BEFORE the disputed charge.+30/);
  assert.match(text, /Published AFTER the disputed charge.+12/);
  // Concealing a deletion an analyst can find elsewhere discredits the page it
  // sits on, so both awkward numbers are stated outright.
  assert.match(text, /Published and later deleted by the account.+3/);
  assert.match(text, /Deleted AFTER this dispute was opened.+2/);
  assert.match(text, /https:\/\/li\.example\/p\/1/);
  assert.match(text, /not estimates/);
});

test("usage document: an account that published nothing gets no document at all", () => {
  // A document that has to hedge argues less than no document.
  assert.equal(buildUsageDocument(dispute, facts({ usage: null })), null);
  const silent = facts();
  (silent.usage as unknown as { published: number }).published = 0;
  assert.equal(buildUsageDocument(dispute, silent), null);
});

test("transcript document: reproduces the exchange, redacted, and says that it redacted", () => {
  const text = buildTranscriptDocument(dispute, facts())!
    .map((l) => l.text)
    .join("\n");
  assert.match(text, /How do I schedule\?/);
  assert.ok(!text.includes("4242424242424242"), "a card number never leaves the building");
  assert.ok(!text.includes("Ada"), "the agent's personal name is not evidence");
  assert.match(text, /Postiz Support:/);
  assert.match(text, /Customer:/);
  // An analyst who is not told the page was edited assumes the worst of it.
  assert.match(text, /replaced with \[redacted\]/);
  assert.equal(buildTranscriptDocument(dispute, facts({ support: null })), null);
});

test("documents: uploaded once, never over a human's file, and staged not submitted", async () => {
  const uploads: string[] = [];
  const updates: Array<{ evidence: Record<string, unknown>; submit: boolean }> = [];
  const stripe = {
    uploadDisputeEvidenceFile: async (name: string, data: Buffer, type: string) => {
      assert.equal(type, "application/pdf");
      assert.ok(data.length > 500, "a real document, not an empty page");
      uploads.push(name);
      return { id: `file_${uploads.length}` };
    },
    updateDisputeEvidence: async (_id: string, evidence: Record<string, unknown>, submit: boolean) => {
      updates.push({ evidence, submit });
    },
  };

  const both = await attachGeneratedDocuments(stripe as never, dispute, facts());
  assert.deepEqual(both.attached, ["service_documentation", "customer_communication"]);
  assert.equal(updates[0].submit, false);
  assert.equal(uploads.length, 2);

  // A slot a human filled is left alone, and nothing is even built for it.
  uploads.length = 0;
  updates.length = 0;
  const taken = { ...dispute, evidence: { service_documentation: "file_from_a_person" } } as unknown as Stripe.Dispute;
  const one = await attachGeneratedDocuments(stripe as never, taken, facts());
  assert.deepEqual(one.attached, ["customer_communication"]);
  assert.equal(uploads.length, 1, "no PDF is rendered for a slot that cannot take it");
  assert.ok(one.skipped.some((s) => s.slot === "service_documentation" && s.why === "slot already filled"));

  // A dispute past answering is left entirely alone.
  uploads.length = 0;
  const closed = { ...dispute, status: "lost" } as unknown as Stripe.Dispute;
  assert.deepEqual((await attachGeneratedDocuments(stripe as never, closed, facts())).attached, []);
  assert.equal(uploads.length, 0);
});
