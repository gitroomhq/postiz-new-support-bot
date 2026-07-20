import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConversationBody, buildMetadataNote, buildTicketAttributes, parseSentryLinkHeader } from "../feedbackFormat";

test("buildConversationBody escapes HTML and keeps structure", () => {
  const body = buildConversationBody('Hello <script>alert("x")</script> & friends\n\nSecond para\nwith break');
  assert.equal(
    body,
    '<p>Hello &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends</p><p>Second para<br>with break</p>'
  );
});

test("buildConversationBody handles empty and whitespace-only messages", () => {
  assert.equal(buildConversationBody(""), "<p>(empty feedback message)</p>");
  assert.equal(buildConversationBody("  \n\n  "), "<p>(empty feedback message)</p>");
});

test("buildConversationBody truncates pathological messages with a marker", () => {
  const body = buildConversationBody("a".repeat(70_000));
  assert.ok(body.endsWith("<p><i>[message truncated by import]</i></p>"));
  assert.ok(body.length < 65_000);
});

test("buildMetadataNote escapes every field and renders links only when present", () => {
  const note = buildMetadataNote({
    name: 'Eve <script>"',
    email: "eve@example.com",
    pageUrl: "https://app.example.com/x?a=1&b=2",
    shortId: "POSTIZ-1X",
    permalink: "https://sentry.io/organizations/acme/issues/42/",
    projectSlug: "postiz-web",
  });
  assert.ok(note.includes("From: Eve &lt;script&gt;&quot; (eve@example.com)"));
  assert.ok(note.includes('href="https://app.example.com/x?a=1&amp;b=2"'));
  assert.ok(note.includes("Open in Sentry"));
  assert.ok(note.includes("postiz-web"));
  assert.ok(note.includes("POSTIZ-1X"));
  // The conversation itself is backdated — no timestamp line; and no
  // replies-are-emailed footer (removed by user request).
  assert.ok(!note.includes("Submitted"));
  assert.ok(!note.includes("emailed to the submitter"));

  const bare = buildMetadataNote({
    name: null,
    email: "a@b.c",
    pageUrl: null,
    shortId: null,
    permalink: null,
    projectSlug: null,
  });
  assert.ok(bare.includes("From: a@b.c"));
  assert.ok(!bare.includes("("));
  assert.ok(!bare.includes("<a "));
  assert.ok(!bare.includes("Page:"));
});

test("buildTicketAttributes composes title/description with caps and fallbacks", () => {
  const attrs = buildTicketAttributes({
    name: "Someone",
    email: "a@b.c",
    message: "  It broke  ",
    projectSlug: "postiz-web",
  });
  assert.equal(attrs._default_title_, "Someone — Feedback (postiz-web)");
  assert.equal(attrs._default_description_, "It broke");

  const bare = buildTicketAttributes({ name: null, email: "a@b.c", message: null, projectSlug: null });
  assert.equal(bare._default_title_, "a@b.c — Feedback");
  assert.equal(bare._default_description_, "(empty feedback message)");

  const long = buildTicketAttributes({
    name: "n".repeat(400),
    email: "a@b.c",
    message: "m".repeat(5000),
    projectSlug: null,
  });
  assert.equal(long._default_title_.length, 250);
  assert.equal(long._default_description_.length, 4000);
});

test("parseSentryLinkHeader extracts the next cursor only when results are pending", () => {
  const more =
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
  assert.equal(parseSentryLinkHeader(more), "0:100:0");

  const done =
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
    '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"';
  assert.equal(parseSentryLinkHeader(done), null);

  assert.equal(parseSentryLinkHeader(null), null);
  assert.equal(parseSentryLinkHeader('<https://x>; rel="previous"; results="true"; cursor="1:2:3"'), null);
});
