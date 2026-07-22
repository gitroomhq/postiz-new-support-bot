import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForwardConversationBody,
  hasForwardSubject,
  isLikelyEmail,
  parseForwardedEmail,
  stripForwardPrefix,
} from "../forwardedEmailParse";

// Hand-built Gmail-EN plaintext fixtures (no real ones exist in-repo; shape
// matches display_as=plaintext of a stock Gmail inline forward).

const GMAIL = [
  "FYI, can you take this one?",
  "",
  "---------- Forwarded message ---------",
  "From: Jane Customer <jane@example.com>",
  "Date: Mon, Jul 20, 2026 at 3:14 PM",
  "Subject: Cannot connect my Instagram account",
  "To: Nevo <nevo@postiz.com>",
  "",
  "",
  "Hi,",
  "",
  "I tried connecting Instagram and it fails with error 400.",
  "",
  "Thanks,",
  "Jane",
].join("\n");

test("standard Gmail forward parses sender, subject and body", () => {
  const r = parseForwardedEmail("Fwd: Cannot connect my Instagram account", GMAIL);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.email, "jane@example.com");
  assert.equal(r.name, "Jane Customer");
  assert.equal(r.subject, "Cannot connect my Instagram account");
  assert.ok(r.bodyText.startsWith("Hi,"));
  assert.ok(r.bodyText.includes("error 400"));
  assert.ok(!r.bodyText.includes("Forwarded message"));
  assert.ok(!r.bodyText.includes("nevo@postiz.com"));
});

test("subject gate: no forward prefix fails, manual mode skips the gate", () => {
  const strict = parseForwardedEmail("Cannot connect", GMAIL);
  assert.equal(strict.ok, false);
  const manual = parseForwardedEmail("Cannot connect", GMAIL, { requireForwardSubject: false });
  assert.equal(manual.ok, true);
});

test("subject prefix variants and stripping", () => {
  assert.equal(hasForwardSubject("Fwd: x"), true);
  assert.equal(hasForwardSubject("FW: x"), true);
  assert.equal(hasForwardSubject("fwd:x"), true);
  assert.equal(hasForwardSubject("Re: x"), false);
  assert.equal(hasForwardSubject(null), false);
  assert.equal(stripForwardPrefix("Fwd: Fwd: Help me"), "Help me");
});

test("bare-email From line parses with null name", () => {
  const body = ["---------- Forwarded message ---------", "From: jane@example.com", "Subject: Hi", "", "Body here"].join("\n");
  const r = parseForwardedEmail("Fwd: Hi", body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.email, "jane@example.com");
  assert.equal(r.name, null);
  assert.equal(r.bodyText, "Body here");
});

test("quoted display name is unquoted", () => {
  const body = ['---------- Forwarded message ---------', 'From: "Customer, Jane" <jane@example.com>', "", "x"].join("\n");
  const r = parseForwardedEmail("Fwd: x", body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.name, "Customer, Jane");
});

test("no forward block fails with a reason", () => {
  const r = parseForwardedEmail("Fwd: hello", "just some text\nwith no headers");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /no forward block/);
});

test("nested double forward resolves to the FIRST block", () => {
  const body = [
    "---------- Forwarded message ---------",
    "From: Alice Middle <alice@example.com>",
    "Subject: Fwd: original",
    "",
    "passing along",
    "",
    "---------- Forwarded message ---------",
    "From: Bob Original <bob@example.com>",
    "Subject: original",
    "",
    "the real message",
  ].join("\n");
  const r = parseForwardedEmail("Fwd: Fwd: original", body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.email, "alice@example.com");
});

test("missing Subject header falls back to the stripped outer subject", () => {
  const body = ["---------- Forwarded message ---------", "From: Jane <jane@example.com>", "", "hello"].join("\n");
  const r = parseForwardedEmail("Fwd: Outer subject", body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.subject, "Outer subject");
});

test("marker-less body with a From header still parses (fallback path)", () => {
  const body = ["From: Jane <jane@example.com>", "Subject: direct", "", "hello there"].join("\n");
  const r = parseForwardedEmail("Fwd: direct", body);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.email, "jane@example.com");
  assert.equal(r.bodyText, "hello there");
});

test("isLikelyEmail accepts addresses and rejects junk", () => {
  assert.equal(isLikelyEmail("a@b.co"), true);
  assert.equal(isLikelyEmail(" a@b.co "), true);
  assert.equal(isLikelyEmail("not an email"), false);
  assert.equal(isLikelyEmail("a@b"), false);
});

test("buildForwardConversationBody escapes, structures and handles empties", () => {
  const html = buildForwardConversationBody("Sub <x>", "line1\nline2\n\npara2 <script>");
  assert.ok(html.startsWith("<p><b>Subject:</b> Sub &lt;x&gt;</p>"));
  assert.ok(html.includes("<p>line1<br>line2</p>"));
  assert.ok(html.includes("<p>para2 &lt;script&gt;</p>"));
  const empty = buildForwardConversationBody(null, "   ");
  assert.equal(empty, "<p>(empty forwarded message)</p>");
  const truncated = buildForwardConversationBody(null, "x".repeat(70_000));
  assert.ok(truncated.includes("[message truncated by import]"));
});
