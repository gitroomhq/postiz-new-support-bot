import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConversationBody, buildMetadataNote, parseSentryLinkHeader } from "../feedbackFormat";

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
    feedbackAtIso: "2026-07-20T10:00:00Z",
  });
  assert.ok(note.includes("Eve &lt;script&gt;&quot;"));
  assert.ok(note.includes("&lt;eve@example.com&gt;"));
  assert.ok(note.includes('href="https://app.example.com/x?a=1&amp;b=2"'));
  assert.ok(note.includes("Open in Sentry"));
  assert.ok(note.includes("postiz-web"));
  assert.ok(note.includes("POSTIZ-1X"));
  assert.ok(note.includes("emailed to the submitter"));

  const bare = buildMetadataNote({
    name: null,
    email: "a@b.c",
    pageUrl: null,
    shortId: null,
    permalink: null,
    projectSlug: null,
    feedbackAtIso: "2026-07-20T10:00:00Z",
  });
  assert.ok(bare.includes("(no name)"));
  assert.ok(!bare.includes("<a "));
  assert.ok(!bare.includes("Page:"));
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
