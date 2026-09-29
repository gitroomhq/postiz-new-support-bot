import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { classifySubject, eventRank, parseWebhookEvent, svixSignatureValid } from "../DeliveryLogStore";
import { DeliveryLogService } from "../DeliveryLogService";
import { matchesFilter } from "../EmailDeliverabilityService";

// The delivery log is fed by a webhook anyone on the internet can POST to, so
// the signature check is the whole gate; and the backfill walks a list that
// has no date filter, so where it stops is the whole budget.

const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;

function sign(body: string, id: string, ts: number, secret = SECRET): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

const bounced = (over: Record<string, unknown> = {}) => ({
  type: "email.bounced",
  created_at: "2026-09-20T10:00:05.000Z",
  data: {
    email_id: "em_1",
    created_at: "2026-09-20T10:00:00.000Z",
    from: "Postiz <no-reply@postiz.com>",
    to: ["Jamie@Example.com"],
    subject: "Reset your password",
    bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
    ...over,
  },
});

test("svix: a correct signature passes, anything altered or stale fails", () => {
  const body = JSON.stringify(bounced());
  const now = 1_790_000_000_000;
  const ts = now / 1000;
  const headers = { id: "msg_1", timestamp: String(ts), signature: sign(body, "msg_1", ts) };
  assert.equal(svixSignatureValid(Buffer.from(body), headers, SECRET, now), true);
  // Rotation: several signatures, one of them good.
  assert.equal(
    svixSignatureValid(Buffer.from(body), { ...headers, signature: `v1,AAAA ${headers.signature}` }, SECRET, now),
    true
  );
  assert.equal(svixSignatureValid(Buffer.from(body + " "), headers, SECRET, now), false, "body changed");
  assert.equal(svixSignatureValid(Buffer.from(body), { ...headers, id: "msg_2" }, SECRET, now), false, "id changed");
  assert.equal(svixSignatureValid(Buffer.from(body), headers, SECRET, now + 10 * 60_000), false, "replayed later");
  assert.equal(
    svixSignatureValid(Buffer.from(body), headers, `whsec_${Buffer.from("another-secret-another-secret!!").toString("base64")}`, now),
    false,
    "other secret"
  );
  assert.equal(svixSignatureValid(Buffer.from(body), { ...headers, signature: null }, SECRET, now), false);
});

test("webhook parsing: bounce reason, lowercased recipient, event time vs send time", () => {
  const e = parseWebhookEvent(bounced());
  assert.ok(e);
  assert.equal(e.type, "bounced");
  assert.equal(e.recipient, "jamie@example.com");
  assert.equal(e.detail, "Permanent / General: mailbox does not exist");
  assert.equal(e.sentAt.toISOString(), "2026-09-20T10:00:00.000Z");
  assert.equal(e.occurredAt.toISOString(), "2026-09-20T10:00:05.000Z");
  // Engagement and non-email events are not logged.
  assert.equal(parseWebhookEvent({ ...bounced(), type: "email.opened" }), null);
  assert.equal(parseWebhookEvent({ ...bounced(), type: "contact.created" }), null);
  assert.equal(parseWebhookEvent(bounced({ to: [] })), null);
});

test("Postiz subjects classify; notifications fall to other", () => {
  assert.equal(classifySubject("Activate your account"), "activation");
  assert.equal(classifySubject("Reset your password"), "password_reset");
  assert.equal(classifySubject('Sam invited you to join "Acme"'), "invite");
  assert.equal(classifySubject("Your Postiz login was changed"), "login_changed");
  assert.equal(classifySubject("Your post failed to publish"), "other");
  assert.equal(classifySubject(null), "other");
});

test("a later stage wins a timestamp tie", () => {
  assert.ok(eventRank("delivered") > eventRank("sent"));
  assert.ok(eventRank("bounced") > eventRank("delivered"));
  assert.ok(eventRank("delivered") > eventRank("delivery_delayed"));
});

function service(opts: { secret?: string | null; pages?: Array<{ items: unknown[]; hasMore: boolean }> } = {}) {
  const ingested: Array<{ id: string; type: string }> = [];
  const backfilled: string[] = [];
  const cleared: string[] = [];
  const pages = [...(opts.pages ?? [])];
  const afters: Array<string | null> = [];
  const settings = {
    resendWebhookSecret: () => (opts.secret === undefined ? SECRET : opts.secret),
    resendEnabled: () => true,
  };
  const client = {
    configured: () => true,
    clearCache: (e: string) => void cleared.push(e),
    listEmails: async (o: { after?: string | null }) => {
      afters.push(o.after ?? null);
      return pages.shift() ?? { items: [], hasMore: false };
    },
  };
  const store = {
    ingest: async (id: string, e: { type: string }) => {
      if (ingested.some((x) => x.id === id)) return false;
      ingested.push({ id, type: e.type });
      return true;
    },
    insertBackfill: async (rows: Array<{ id: string }>) => {
      backfilled.push(...rows.map((r) => r.id));
      return rows.length;
    },
  };
  const svc = new DeliveryLogService(settings as never, client as never, store as never, null);
  return { svc, ingested, backfilled, cleared, afters };
}

test("webhook: unsigned is refused, signed is stored once, a bounce clears the lookup cache", async () => {
  const body = JSON.stringify(bounced());
  const ts = Math.floor(Date.now() / 1000);
  const headers = { id: "msg_9", timestamp: String(ts), signature: sign(body, "msg_9", ts) };

  const off = service({ secret: null });
  assert.equal(await off.svc.handleWebhook(Buffer.from(body), headers), "forbidden", "no secret = nothing accepted");

  const h = service();
  assert.equal(await h.svc.handleWebhook(Buffer.from(body), { ...headers, signature: "v1,bad" }), "forbidden");
  assert.equal(h.ingested.length, 0);
  assert.equal(await h.svc.handleWebhook(Buffer.from(body), headers), "stored");
  assert.equal(await h.svc.handleWebhook(Buffer.from(body), headers), "duplicate");
  assert.deepEqual(h.ingested, [{ id: "msg_9", type: "bounced" }]);
  assert.deepEqual(h.cleared, ["jamie@example.com"]);
});

test("backfill: pages newest first and stops at the first email older than a month", async () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  const day = 86_400_000;
  const mk = (id: string, daysAgo: number) => ({
    id,
    to: ["a@example.com"],
    from: null,
    subject: "Reset your password",
    createdAt: new Date(now - daysAgo * day),
    lastEvent: "delivered",
  });
  const h = service({
    pages: [
      { items: [mk("e1", 1), mk("e2", 10)], hasMore: true },
      { items: [mk("e3", 29), mk("e4", 31)], hasMore: true },
      { items: [mk("e5", 40)], hasMore: false },
    ],
  });
  const r = await h.svc.backfill({ nowMs: now });
  assert.deepEqual(h.backfilled, ["e1", "e2", "e3"]);
  assert.deepEqual(h.afters, [null, "e2"], "the third page is never fetched");
  assert.equal(r.created, 3);
});
