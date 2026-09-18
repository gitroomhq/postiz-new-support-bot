import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { EvidencePackBuilder, type EvidencePack } from "../billing/evidence/EvidencePackBuilder";
import { resetStandingDocumentCache } from "../billing/evidence/standingDocuments";
import { confirmedOrgFor, type PostizOrgLookup, type PostizOrgSummary } from "../../postiz/PostizIdentityService";

// Two defects that showed up in production on one dispute: a history timeline
// of two dozen identical hourly entries, and a provenance line claiming the
// platform account was used on a dispute whose account link cannot be proven.

// ---- staging the same text twice ----

function stageHarness(currentEvidence: Record<string, string>) {
  const calls: string[] = [];
  const builder = new EvidencePackBuilder(
    {} as never,
    {} as never,
    {} as never,
    {
      recordAutoPack: async () => {
        calls.push("recordAutoPack");
      },
    } as never,
    {
      stageFields: async () => {
        calls.push("stageFields");
      },
    } as never,
    {} as never,
    null,
    null,
    {
      record: async (e: { kind: string }) => {
        calls.push(`event:${e.kind}`);
      },
    } as never
  );
  const dispute = { id: "dp_1", reason: "subscription_canceled", evidence: currentEvidence } as unknown as Stripe.Dispute;
  const pack = {
    reason: "general",
    fields: { product_description: "The subscription renewed as disclosed.", customer_name: "Ada" },
    rendered: [],
    score: 0,
    templateVersion: "2026-09-17.1",
    facts: { reach: { charge: true, sub: false, billing: false, postiz: false, usage: false, cards: false, support: false } },
  } as unknown as EvidencePack;
  return { builder, dispute, pack, calls };
}

test("staging: identical text is not re-staged, so the timeline does not fill with hourly duplicates", async () => {
  // The looper rebuilds every hour to catch facts that arrive late. The
  // templates are deterministic, so an untouched dispute rebuilds byte for byte
  // and would otherwise collect a Stripe write, a history entry and a build
  // metric every hour until its deadline.
  const h = stageHarness({
    product_description: "The subscription renewed as disclosed.",
    customer_name: "Ada",
  });
  const result = await h.builder.stage(h.dispute, h.pack, false);
  assert.equal(result.unchanged, true);
  assert.deepEqual(h.calls, [], "nothing written, and above all no pack_staged entry");
  // The score still comes back, because the caller goes on to decide about
  // submitting and needs to know how strong what IS staged is.
  assert.equal(typeof result.pack.score, "number");
  assert.deepEqual(result.staged, ["product_description", "customer_name"]);
});

test("staging: a single changed field is a real restage, and so is a first one", async () => {
  const changed = stageHarness({
    product_description: "The subscription renewed as disclosed.",
    customer_name: "Someone else",
  });
  const res = await changed.builder.stage(changed.dispute, changed.pack, false);
  assert.equal(res.unchanged, false);
  assert.deepEqual(changed.calls, ["stageFields", "recordAutoPack", "event:pack_staged"]);

  const first = stageHarness({});
  const firstRes = await first.builder.stage(first.dispute, first.pack, false);
  assert.equal(firstRes.unchanged, false);
  assert.ok(first.calls.includes("event:pack_staged"), "the first staging is always worth recording");
});

// ---- whose organisation is it ----

const org = (over: Partial<PostizOrgSummary> = {}): PostizOrgSummary =>
  ({
    orgId: "org_1",
    orgName: "Acme",
    tier: "PRO",
    paymentId: "cus_me",
    orgDeleted: false,
    customerMatches: true,
    ownerProvider: "google",
    ownerActivated: true,
    subPeriod: "MONTHLY",
    ...over,
  }) as PostizOrgSummary;

const lookup = (orgs: PostizOrgSummary[], state: PostizOrgLookup["state"] = "found"): PostizOrgLookup => ({
  state,
  orgs,
  via: "customer",
});

test("org gate: a search hit that is not provably this customer licenses no claim", () => {
  // "found" only says the search returned rows. The list is sorted to put a
  // confirmed match first, so orgs[0] on its own is a preference, and a
  // preference stated to a bank as fact is how a whole response gets thrown out.
  assert.equal(confirmedOrgFor(lookup([org({ customerMatches: false, paymentId: "cus_someone_else" })])), null);

  // A platform too old to echo the payment id back cannot confirm anything
  // either, and "probably" is not a thing evidence may say.
  assert.equal(confirmedOrgFor(lookup([org({ customerMatches: null, paymentId: null })])), null);

  // Nor does a deleted organisation describe a live account.
  assert.equal(confirmedOrgFor(lookup([org({ orgDeleted: true })])), null);
});

test("org gate: a proven match is used, and is picked out of a crowd of near-misses", () => {
  const confirmed = confirmedOrgFor(
    lookup([
      org({ orgId: "org_other", customerMatches: false, paymentId: "cus_someone_else" }),
      org({ orgId: "org_null", customerMatches: null, paymentId: null }),
      org({ orgId: "org_mine" }),
    ])
  );
  assert.equal(confirmed?.orgId, "org_mine");
});

test("org gate: every non-found state answers with nothing", () => {
  for (const state of ["off", "none", "timeout", "error"] as const) {
    assert.equal(confirmedOrgFor(lookup([org()], state)), null, state);
  }
});

// ---- answered, but not enough to cite ----

test("provenance: a quality refusal is not reported as a dead feed", async () => {
  // The two failures this separates, both seen in production on one dispute:
  // a customer with a single paid invoice (Stripe answered; the pack refuses to
  // call one line a payment history) and a Postiz search that returned an
  // organisation we cannot prove is this customer's. Reported as "no data",
  // both look like a broken integration, and the Grafana coverage chart, whose
  // whole job is spotting a feed that went quiet, counts them as outages.
  const calls: Array<{ kind: string; detail: unknown }> = [];
  const builder = new EvidencePackBuilder(
    {} as never,
    {} as never,
    {} as never,
    { recordAutoPack: async () => {} } as never,
    { stageFields: async () => {} } as never,
    {} as never,
    null,
    null,
    { record: async (e: { kind: string; detail: unknown }) => calls.push(e) } as never
  );
  const pack = {
    reason: "general",
    fields: { product_description: "text" },
    rendered: [],
    score: 0,
    templateVersion: "t",
    facts: {
      charge: { id: "ch_1" },
      billing: null,
      postiz: null,
      sub: null,
      usage: null,
      cards: null,
      support: null,
      // Stripe returned invoices and the platform answered; neither cleared the
      // bar to be cited.
      reach: { charge: true, sub: false, billing: true, postiz: true, usage: false, cards: false, support: false },
    },
  } as unknown as EvidencePack;

  await builder.stage({ id: "dp_1", reason: "subscription_canceled", evidence: {} } as unknown as Stripe.Dispute, pack, false);
  const detail = calls[0].detail as { sources: Record<string, boolean>; reached: Record<string, boolean> };

  // What was CITED is unchanged, so every entry written before this still reads
  // the same way.
  assert.equal(detail.sources.paymentHistory, false);
  assert.equal(detail.sources.postizAccount, false);
  // What ANSWERED is new, and is what tells the two cases apart.
  assert.equal(detail.reached.paymentHistory, true);
  assert.equal(detail.reached.postizAccount, true);
  assert.equal(detail.reached.supportHistory, false, "a source that truly said nothing still reads as nothing");
});

// ---- standing policy documents ----

function docHarness(
  opts: { held?: Record<string, string>; currentEvidence?: Record<string, string>; masterUnreadable?: boolean } = {}
) {
  const updates: Array<{ evidence: Record<string, unknown>; submit: boolean; key: string }> = [];
  const uploads: string[] = [];
  const reads: string[] = [];
  const held = opts.held ?? { refund_policy: "file_refund", cancellation_policy: "file_cancel" };
  const store = {
    bySlot: async () =>
      new Map(Object.entries(held).map(([slot, stripeFileId]) => [slot, { slot, stripeFileId, fileName: `${slot}.pdf` }])),
  };
  let uploadSeq = 0;
  const stripe = {
    updateDisputeEvidence: async (_id: string, evidence: Record<string, unknown>, submit: boolean, key: string) => {
      updates.push({ evidence, submit, key });
    },
    getEvidenceFileWithContents: async (fileId: string) => {
      reads.push(fileId);
      if (opts.masterUnreadable) return { filename: "x.pdf", sizeBytes: 0, mimeType: null, data: null, skipped: "unsupported_type" };
      return { filename: `${fileId}.pdf`, sizeBytes: 10, mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 x"), skipped: null };
    },
    uploadDisputeEvidenceFile: async (name: string) => {
      uploadSeq += 1;
      uploads.push(name);
      return { id: `copy_${uploadSeq}` };
    },
  };
  const builder = new EvidencePackBuilder(
    stripe as never,
    {} as never,
    {} as never,
    { recordAutoPack: async () => {} } as never,
    { stageFields: async () => {} } as never,
    {} as never,
    null,
    null,
    { record: async () => {} } as never,
    store as never
  );
  const dispute = {
    id: "dp_1",
    status: "needs_response",
    reason: "subscription_canceled",
    evidence: opts.currentEvidence ?? {},
  } as unknown as Stripe.Dispute;
  const pack = {
    reason: "general",
    fields: { product_description: "text" },
    rendered: [],
    score: 0,
    templateVersion: "t",
    facts: { reach: { charge: true, sub: false, billing: false, postiz: false, usage: false, cards: false, support: false } },
  } as unknown as EvidencePack;
  return { builder, dispute, pack, updates, uploads, reads };
}

test("documents: the standing policies are stamped into empty slots, staged not submitted", async () => {
  const h = docHarness();
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.deepEqual(res.documents.sort(), ["cancellation_policy", "refund_policy"]);
  assert.equal(h.updates.length, 1, "one update call for the whole set");
  // A COPY per slot, never the stored id: Stripe binds an evidence file to one
  // dispute, so reusing the master is refused on the second dispute that needs
  // it, which is exactly how this shipped broken.
  assert.deepEqual(h.updates[0].evidence, { refund_policy: "copy_1", cancellation_policy: "copy_2" });
  // The bank sees nothing until Submit evidence, exactly like every other
  // thing this builder writes.
  assert.equal(h.updates[0].submit, false);
});

test("documents: a slot a human already filled is never overwritten", async () => {
  // Same rule the receipt follows: a proof someone uploaded by hand beats a
  // standing document every time.
  const h = docHarness({ currentEvidence: { refund_policy: "file_uploaded_by_a_person" } });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.deepEqual(res.documents, ["cancellation_policy"]);
  assert.deepEqual(h.updates[0].evidence, { cancellation_policy: "copy_1" });
});

test("documents: a policy uploaded later still reaches a dispute whose text has not changed", async () => {
  // The whole reason the attach runs before the unchanged guard. Without it a
  // document added today would never reach any dispute already staged, because
  // deterministic templates rebuild to the same words forever.
  const h = docHarness({ currentEvidence: { product_description: "text" } });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.equal(res.unchanged, false, "attaching a document is a real change");
  assert.deepEqual(res.documents.sort(), ["cancellation_policy", "refund_policy"]);

  // And once they are in place, the hourly rebuild goes quiet again.
  const settled = docHarness({
    currentEvidence: { product_description: "text", refund_policy: "file_refund", cancellation_policy: "file_cancel" },
  });
  const second = await settled.builder.stage(settled.dispute, settled.pack, false);
  assert.equal(second.unchanged, true);
  assert.deepEqual(settled.updates, [], "nothing written at all");
});

test("documents: a dispute past answering is left alone, and no documents means no call", async () => {
  const closed = docHarness();
  (closed.dispute as unknown as { status: string }).status = "lost";
  const res = await closed.builder.stage(closed.dispute, closed.pack, false);
  assert.deepEqual(res.documents, []);
  assert.deepEqual(closed.updates, []);

  const none = docHarness({ held: {} });
  await none.builder.stage(none.dispute, none.pack, false);
  assert.deepEqual(none.updates, [], "an empty library costs no Stripe call");
});

test("documents: a button that attaches nothing says WHY, rather than looking broken", async () => {
  // Reported from production: pressing Rebuild on a dispute with no usage feed
  // and no support history attached neither generated document and said
  // nothing about it, which is indistinguishable from a dead button. The
  // documents were right to refuse; the silence was the defect.
  const h = docHarness({ held: {} });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.deepEqual(res.documents, []);
  const why = Object.fromEntries(res.documentsSkipped.map((s) => [s.slot, s.why]));
  assert.match(why.service_documentation, /published nothing|no usage feed/);
  assert.match(why.customer_communication, /no support conversation/);
});

test("documents: a slot a human filled is reported separately from a document that could not be built", async () => {
  // The two need different words: one is the system protecting an upload, the
  // other is a fact we do not have.
  const h = docHarness({ currentEvidence: { refund_policy: "file_from_a_person" } });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.ok(res.documentsSkipped.some((s) => s.slot === "refund_policy" && s.why === "slot already filled"));
  assert.ok(res.documentsSkipped.some((s) => s.slot === "service_documentation" && s.why !== "slot already filled"));
});

test("documents: an EMPTY library says so, per slot, instead of returning quietly", async () => {
  // The state that reads as a broken feature. An operator who believes they
  // uploaded a policy and sees nothing attached cannot tell a failed upload
  // from a working one unless the pack names the slots it found nothing in.
  const h = docHarness({ held: {} });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  const why = Object.fromEntries(res.documentsSkipped.map((s) => [s.slot, s.why]));
  for (const slot of ["refund_policy", "cancellation_policy", "uncategorized_file"]) {
    assert.match(why[slot] ?? "", /no document uploaded/, slot);
  }
  assert.deepEqual(h.updates, [], "an empty library costs no Stripe call");
});

test("documents: an attach that THROWS is reported, not just logged", async () => {
  // Swallowed into a log line, a Stripe rejection here looks exactly like a
  // feature that quietly does nothing, which is how this went unexplained.
  const h = docHarness();
  const builder = h.builder as unknown as { stripe: { updateDisputeEvidence: () => Promise<void> } };
  builder.stripe.updateDisputeEvidence = async () => {
    throw new Error("idempotency_error");
  };
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.deepEqual(res.documents, []);
  assert.ok(
    res.documentsSkipped.some((s) => /attach failed: idempotency_error/.test(s.why)),
    JSON.stringify(res.documentsSkipped)
  );
});

test("documents: two disputes each get their OWN copy, because Stripe binds a file to one dispute", async () => {
  // The bug this feature shipped with. Stamping the stored id onto a second
  // dispute is refused with "That file is already attached to something else",
  // so the first dispute answered consumed every policy and every dispute after
  // it silently received nothing.
  //
  // One harness, so both disputes share a Stripe: that is what makes "the ids
  // differ" mean anything.
  resetStandingDocumentCache();
  const h = docHarness();
  await h.builder.stage(h.dispute, h.pack, false);
  const other = { ...h.dispute, id: "dp_2", evidence: {} } as unknown as Stripe.Dispute;
  await h.builder.stage(other, h.pack, false);

  assert.equal(h.updates.length, 2, "both disputes were stamped");
  const first = Object.values(h.updates[0].evidence);
  const second = Object.values(h.updates[1].evidence);
  assert.equal(new Set([...first, ...second]).size, 4, "four distinct files for two slots across two disputes");
  for (const id of [...first, ...second]) {
    assert.ok(id !== "file_refund" && id !== "file_cancel", "the stored master is never stamped onto a dispute");
  }
  assert.equal(h.uploads.length, 4, "a fresh upload per slot per dispute");
});

test("documents: the master is downloaded once per process, not once per dispute", async () => {
  // A 4MB policy fetched again for every dispute would be a real cost for no
  // gain: the bytes never change while the id does not.
  resetStandingDocumentCache();
  const h = docHarness();
  await h.builder.stage(h.dispute, h.pack, false);
  const readsAfterFirst = h.reads.length;
  assert.equal(readsAfterFirst, 2, "one read per master on the first pass");

  const again = docHarness();
  await again.builder.stage(again.dispute, again.pack, false);
  assert.deepEqual(again.reads, [], "the second dispute reuses the cached bytes");
  assert.equal(Object.keys(again.updates[0].evidence).length, 2, "and still gets fresh copies");
});

test("documents: an unreadable master fails ONE slot, and the rest still attach", async () => {
  resetStandingDocumentCache();
  const h = docHarness({ masterUnreadable: true });
  const res = await h.builder.stage(h.dispute, h.pack, false);
  assert.deepEqual(res.documents, []);
  assert.deepEqual(h.updates, [], "nothing is stamped when nothing could be copied");
  const why = res.documentsSkipped.filter((s) => /master file unreadable/.test(s.why));
  assert.equal(why.length, 2, JSON.stringify(res.documentsSkipped));
});
