import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomInboxApp, collapse } from "../IntercomInboxApp";
import type { PostizIdentityService } from "../../postiz/PostizIdentityService";

// The canvas card is the agent-facing view inside the Intercom inbox. The case
// that matters most is the one it used to refuse outright: a conversation this
// bot did not create (email, website, Sentry feedback), where the contact's
// email is the only identifier available.

type Row = { type: string; text?: string };

const account = (over: Record<string, unknown> = {}) => ({
  membershipId: "uo_1",
  userId: "usr_1",
  name: "Jamie",
  email: "jamie@example.com",
  orgId: "org_1",
  orgName: "Acme",
  role: "ADMIN",
  tier: "PRO",
  ...over,
});

const stamped = (over: Record<string, unknown> = {}) =>
  ({ postizOrgId: "org_1", postizTier: "PRO", postizRole: "ADMIN", ...over }) as never;

function render(identity: PostizIdentityService | undefined) {
  const app = new IntercomInboxApp(
    {} as never, {} as never, {} as never, {} as never, {} as never,
    () => null, {} as never, {} as never, {} as never, {} as never,
    identity
  );
  return async (input: unknown): Promise<string[]> => {
    const rows = (await (app as unknown as {
      postizSection(i: unknown): Promise<Row[]>;
    }).postizSection(input)) as Row[];
    return rows.map((r) => r.text ?? r.type);
  };
}

const identityReturning = (value: unknown, calls?: string[]) =>
  ({
    async resolve(term: string) {
      calls?.push(term);
      if (value instanceof Error) throw value;
      return value;
    },
  }) as unknown as PostizIdentityService;

test("an emailed-in customer with no Discord ticket is identified from their contact email", async () => {
  // This is the whole point: before the platform search existed, this
  // conversation was anonymous to us.
  const calls: string[] = [];
  const rows = await render(identityReturning(account(), calls))({
    stampedUserId: null,
    email: "jamie@example.com",
    stamped: null,
  });
  assert.deepEqual(calls, ["jamie@example.com"]);
  assert.ok(rows.some((r) => r.includes("User ID:") && r.includes("usr_1")));
  assert.ok(rows.some((r) => r.includes("Organization:") && r.includes("Acme")));
  assert.ok(rows.some((r) => r.includes("Plan:") && r.includes("PRO") && r.includes("ADMIN")));
});

test("a bridged ticket prefers its stamped id over the contact email", async () => {
  const calls: string[] = [];
  await render(identityReturning(account(), calls))({
    stampedUserId: "usr_stamped",
    email: "someone-else@example.com",
    stamped: stamped(),
  });
  assert.deepEqual(calls, ["usr_stamped"]);
});

test("a plan that changed since the ticket opened is called out", async () => {
  const rows = await render(identityReturning(account({ tier: "ULTIMATE" })))({
    stampedUserId: "usr_1",
    email: null,
    stamped: stamped({ postizTier: "PRO" }),
  });
  assert.ok(rows.some((r) => r.includes("Plan:") && r.includes("ULTIMATE")));
  assert.ok(rows.some((r) => r.includes("Plan at ticket open:") && r.includes("PRO")));
});

test("an unchanged plan does not repeat itself", async () => {
  const rows = await render(identityReturning(account({ tier: "PRO" })))({
    stampedUserId: "usr_1",
    email: null,
    stamped: stamped({ postizTier: "PRO" }),
  });
  assert.ok(!rows.some((r) => r.includes("Plan at ticket open")));
});

test("a failing lookup degrades to the stamped identity instead of vanishing", async () => {
  const rows = await render(identityReturning(new Error("platform down")))({
    stampedUserId: "usr_1",
    email: null,
    stamped: stamped(),
  });
  assert.ok(rows.some((r) => r.includes("User ID:") && r.includes("usr_1")));
  assert.ok(rows.some((r) => r.includes("Organization:") && r.includes("org_1")));
  assert.ok(rows.some((r) => r.includes("Live lookup:") && r.includes("unavailable")));
});

test("a failing lookup on an email-only conversation still shows the email", async () => {
  const rows = await render(identityReturning(new Error("down")))({
    stampedUserId: null,
    email: "jamie@example.com",
    stamped: null,
  });
  assert.ok(rows.some((r) => r.includes("Email:") && r.includes("jamie@example.com")));
  assert.ok(rows.some((r) => r.includes("Live lookup:")));
});

test("with no lookup configured the section says so rather than looking empty", async () => {
  const rows = await render(undefined)({ stampedUserId: "usr_1", email: null, stamped: stamped() });
  assert.ok(rows.some((r) => r.includes("Live lookup:") && r.includes("not configured")));
});

test("a conversation with neither an account nor an email says it is unidentified", async () => {
  const rows = await render(identityReturning(account()))({ stampedUserId: null, email: null, stamped: null });
  assert.ok(rows.some((r) => r.includes("Not identified")));
});

// ---- row collapsing (the duplicate ULTIMATE/failed-charge rows) ----

test("collapse: identical rows fold into one with a count", () => {
  const rows = collapse(
    [
      { label: "$1.00", value: "failed · 2026-08-20" },
      { label: "$1.00", value: "failed · 2026-08-20" },
      { label: "$1.00", value: "failed · 2026-08-20" },
    ],
    3
  );
  assert.deepEqual(rows, [{ label: "$1.00", value: "failed · 2026-08-20 (×3)" }]);
});

test("collapse: distinct rows are kept separate and uncounted", () => {
  const rows = collapse(
    [
      { label: "ULTIMATE MONTHLY", value: "canceled" },
      { label: "STANDARD MONTHLY", value: "canceled" },
    ],
    3
  );
  assert.deepEqual(rows, [
    { label: "ULTIMATE MONTHLY", value: "canceled" },
    { label: "STANDARD MONTHLY", value: "canceled" },
  ]);
});

test("collapse: overflow past the limit is reported, never silently dropped", () => {
  const rows = collapse(
    [
      { label: "a", value: "1" },
      { label: "b", value: "2" },
      { label: "c", value: "3" },
      { label: "d", value: "4" },
      { label: "e", value: "5" },
    ],
    3
  );
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], { label: "…", value: "2 more not shown" });
});

test("collapse: an empty list stays empty", () => {
  assert.deepEqual(collapse([], 3), []);
});
