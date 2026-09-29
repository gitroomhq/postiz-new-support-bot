import { test } from "node:test";
import assert from "node:assert/strict";
import { EmailDeliverabilityService, distinctEmails } from "../EmailDeliverabilityService";
import { ResendHttpError, type Suppression } from "../ResendClient";

const SUPPRESSION: Suppression = {
  id: "sup_1",
  email: "gone@example.com",
  origin: "bounce",
  sourceId: "em_1",
  createdAt: new Date("2026-09-12T10:00:00Z"),
};

function harness(opts: {
  enabled?: boolean;
  suppressed?: Record<string, Suppression | null | Error>;
  removeResult?: boolean | Error;
  base?: string | null;
} = {}) {
  const audits: Array<{ title: string; fields?: Array<{ name: string; value: string }> }> = [];
  const removed: string[] = [];
  const client = {
    configured: () => true,
    getSuppression: async (email: string) => {
      const v = opts.suppressed?.[email.toLowerCase()];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    getEmailSummary: async () => ({ id: "em_1", subject: "Activate your account", from: null, createdAt: null, lastEvent: "bounced" }),
    removeSuppression: async (email: string) => {
      removed.push(email);
      if (opts.removeResult instanceof Error) throw opts.removeResult;
      return opts.removeResult ?? true;
    },
    clearCache: () => {},
  };
  const svc = new EmailDeliverabilityService(
    { resendEnabled: () => opts.enabled ?? true, postizBaseUrl: () => (opts.base === undefined ? "https://api.postiz.test" : opts.base) } as never,
    client as never,
    { log: async (e: { title: string }) => void audits.push(e) } as never
  );
  return { svc, audits, removed };
}

test("addresses: deduplicated case-insensitively, invalid ones dropped, capped at three", () => {
  assert.deepEqual(
    distinctEmails(["A@x.com", null, "a@x.com", "not an email", "b@x.com", "c@x.com", "d@x.com"]),
    ["A@x.com", "b@x.com", "c@x.com"]
  );
});

test("status: suppressed with its cause, clear, and unknown on a failure; never throws; off is empty", async () => {
  const { svc } = harness({
    suppressed: { "gone@example.com": SUPPRESSION, "broken@example.com": new ResendHttpError(429, "rate_limit_exceeded", "slow down") },
  });
  const [gone, fine, broken] = await svc.statusFor(["gone@example.com", "fine@example.com", "broken@example.com"]);
  assert.equal(gone.state, "suppressed");
  assert.equal(gone.state === "suppressed" && gone.source?.subject, "Activate your account");
  assert.equal(fine.state, "clear");
  assert.equal(broken.state, "unknown");
  assert.match(broken.state === "unknown" ? broken.error : "", /rate limiting/);
  assert.deepEqual(await harness({ enabled: false }).svc.statusFor(["gone@example.com"]), []);
});

test("remove: audits who, from where and what it was; refuses junk; says when nothing was there", async () => {
  const h = harness({ suppressed: { "gone@example.com": SUPPRESSION } });
  const r = await h.svc.remove("gone@example.com", { surface: "intercom", id: "7", name: "Sam" }, { conversationId: "123" });
  assert.equal(r.kind, "removed");
  assert.deepEqual(h.removed, ["gone@example.com"]);
  assert.equal(h.audits.length, 1);
  const fields = Object.fromEntries((h.audits[0].fields ?? []).map((f) => [f.name, f.value]));
  assert.equal(fields.Address, "gone@example.com");
  assert.match(fields.Was, /hard bounce/);
  assert.equal(fields.From, "Intercom sidebar");
  assert.equal(fields["Intercom conversation"], "123");

  assert.equal((await h.svc.remove("nope", { surface: "discord", id: "1", name: "x" })).kind, "invalid");
  const absent = harness({ removeResult: false });
  assert.equal((await absent.svc.remove("x@example.com", { surface: "discord", id: "1", name: "x" })).kind, "not_suppressed");
  assert.equal(absent.audits.length, 0, "nothing removed, nothing audited");
});

test("remove: a sending-only key is explained, not reported as a bare 401", async () => {
  const h = harness({ removeResult: new ResendHttpError(401, "restricted_api_key", "restricted") });
  const r = await h.svc.remove("x@example.com", { surface: "dashboard", id: "1", name: "x" });
  assert.equal(r.kind, "error");
  assert.match(r.kind === "error" ? r.error : "", /Full access key/);
});

test("activation: posts the exact address to Postiz's own resend route and relays its refusal", async () => {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; body: string }> = [];
  let reply: { success: boolean; message?: string } = { success: true };
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    seen.push({ url, body: init.body });
    return new Response(JSON.stringify(reply), { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const h = harness();
    assert.deepEqual(await h.svc.resendActivation("new@example.com", { surface: "discord", id: "1", name: "x" }), { ok: true });
    assert.equal(seen[0].url, "https://api.postiz.test/auth/resend-activation");
    assert.deepEqual(JSON.parse(seen[0].body), { email: "new@example.com" });
    reply = { success: false, message: "Account is already activated" };
    const refused = await h.svc.resendActivation("new@example.com", { surface: "discord", id: "1", name: "x" });
    assert.deepEqual(refused, { ok: false, error: "Postiz: Account is already activated" });
    assert.equal((await harness({ base: null }).svc.resendActivation("a@b.co", { surface: "discord", id: "1", name: "x" })).ok, false);
  } finally {
    globalThis.fetch = original;
  }
});
