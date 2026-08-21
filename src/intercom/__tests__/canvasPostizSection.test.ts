import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomInboxApp } from "../IntercomInboxApp";
import type { PostizIdentityService } from "../../postiz/PostizIdentityService";

// The canvas card is the agent-facing view inside the Intercom inbox. Its rule
// is "fetched at render time, nothing stale", so the live lookup supplies the
// email and current plan while the ticket's stamped id decides WHICH account.
// A lookup that is off, slow or failing must degrade, never blank the section.

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

const ticket = (over: Record<string, unknown> = {}) =>
  ({ postizUserId: "usr_1", postizOrgId: "org_1", postizTier: "PRO", postizRole: "ADMIN", ...over }) as never;

function appWith(identity: PostizIdentityService | undefined) {
  const app = new IntercomInboxApp(
    {} as never, {} as never, {} as never, {} as never, {} as never,
    () => null, {} as never, {} as never, {} as never,
    identity
  );
  return async (t: unknown, sessionId: string | null = null): Promise<string[]> => {
    const rows = (await (app as unknown as {
      postizSection(t: unknown, s: string | null): Promise<Row[]>;
    }).postizSection(t, sessionId)) as Row[];
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

test("a resolved account shows the id, email, name, organization, role and plan", async () => {
  const render = appWith(identityReturning(account()));
  const rows = await render(ticket());
  assert.ok(rows.some((r) => r.includes("User ID:") && r.includes("usr_1")));
  assert.ok(rows.some((r) => r.includes("Email:") && r.includes("jamie@example.com")));
  assert.ok(rows.some((r) => r.includes("Name:") && r.includes("Jamie")));
  assert.ok(rows.some((r) => r.includes("Organization:") && r.includes("Acme") && r.includes("org_1")));
  assert.ok(rows.some((r) => r.includes("Role:") && r.includes("ADMIN")));
  assert.ok(rows.some((r) => r.includes("Plan:") && r.includes("PRO")));
});

test("the stamped id is what gets looked up, not the self-linked session id", async () => {
  const calls: string[] = [];
  const render = appWith(identityReturning(account(), calls));
  await render(ticket({ postizUserId: "usr_stamped" }), "usr_session");
  assert.deepEqual(calls, ["usr_stamped"]);
});

test("falls back to the session id when the ticket was never resolved", async () => {
  const calls: string[] = [];
  const render = appWith(identityReturning(account(), calls));
  await render(ticket({ postizUserId: null }), "usr_session");
  assert.deepEqual(calls, ["usr_session"]);
});

test("a plan that changed since the ticket opened is called out", async () => {
  // This is exactly the drift the billing panel can repair, so an agent
  // reading the conversation should see both numbers.
  const render = appWith(identityReturning(account({ tier: "ULTIMATE" })));
  const rows = await render(ticket({ postizTier: "PRO" }));
  assert.ok(rows.some((r) => r.includes("Plan:") && r.includes("ULTIMATE")));
  assert.ok(rows.some((r) => r.includes("Plan at ticket open:") && r.includes("PRO")));
});

test("an unchanged plan does not repeat itself", async () => {
  const render = appWith(identityReturning(account({ tier: "PRO" })));
  const rows = await render(ticket({ postizTier: "PRO" }));
  assert.ok(!rows.some((r) => r.includes("Plan at ticket open")));
});

test("a failing lookup degrades to the stamped identity instead of vanishing", async () => {
  const render = appWith(identityReturning(new Error("platform down")));
  const rows = await render(ticket());
  assert.ok(rows.some((r) => r.includes("User ID:") && r.includes("usr_1")));
  assert.ok(rows.some((r) => r.includes("Organization:") && r.includes("org_1")));
  assert.ok(rows.some((r) => r.includes("Plan (at ticket open):") && r.includes("PRO")));
  assert.ok(rows.some((r) => r.includes("Live lookup:") && r.includes("unavailable")));
});

test("with no lookup configured the section still shows what the ticket knows", async () => {
  const render = appWith(undefined);
  const rows = await render(ticket());
  assert.ok(rows.some((r) => r.includes("User ID:") && r.includes("usr_1")));
  assert.ok(rows.some((r) => r.includes("Live lookup:") && r.includes("not configured")));
});

test("a customer with no Postiz identity anywhere gets one honest line", async () => {
  const render = appWith(identityReturning(account()));
  const rows = await render(ticket({ postizUserId: null }), null);
  assert.deepEqual(rows, ["👤 No Postiz account linked."]);
});
