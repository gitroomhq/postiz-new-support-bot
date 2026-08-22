import { test } from "node:test";
import assert from "node:assert/strict";
import { ForwarderDetacher } from "../ForwarderDetacher";
import { ForwarderRoster } from "../forwarderRoster";
import type { IntercomClient } from "../IntercomClient";
import type { SettingsStore } from "../../config/SettingsStore";
import type { AuditLogger } from "../../bot/AuditLogger";
import { IntercomHttpError } from "../IntercomClient";

interface HarnessOpts {
  participants?: Array<{ id: string; email: string | null }>;
  extraEmails?: string[];
  admins?: Array<{ id: string; email: string; hasInboxSeat: boolean }>;
  enabled?: boolean;
  detachEnabled?: boolean;
  removeStatus?: number; // make the remove call fail with this HTTP status
}

function makeHarness(opts: HarnessOpts = {}) {
  const removed: string[] = [];
  const notes: string[] = [];

  const settings = {
    forwardConvertEnabled: () => opts.enabled !== false,
    forwardDetachForwarder: () => opts.detachEnabled !== false,
    intercomConfigured: () => true,
    intercomAdminId: () => "admin-1",
    intercomAuthorAdminId: () => "admin-1",
    forwardConvertExtraEmails: () => opts.extraEmails ?? ["ops@postiz.com"],
  } as unknown as SettingsStore;

  const client = {
    async listAdmins() {
      return (
        opts.admins ?? [
          { id: "a-full", email: "agent@postiz.com", hasInboxSeat: true },
          { id: "a-lite", email: "lite@postiz.com", hasInboxSeat: false },
        ]
      );
    },
    async listConversationParticipants() {
      return (
        opts.participants ?? [
          { id: "c-fwd", email: "ops@postiz.com" },
          { id: "c-cust", email: "jane@example.com" },
        ]
      );
    },
    async removeConversationParticipant(_conversationId: string, contactId: string) {
      if (opts.removeStatus === 404 || opts.removeStatus === 405) return "unsupported" as const;
      if (opts.removeStatus) throw new IntercomHttpError(opts.removeStatus, "boom");
      removed.push(contactId);
      return "removed" as const;
    },
    async replyAsAdmin(_conversationId: string, input: { note?: boolean; body: string }) {
      notes.push(`${input.note ? "note" : "reply"}:${input.body}`);
      return { partId: "p1" };
    },
  } as unknown as IntercomClient;

  const audit = { log: async () => undefined } as unknown as AuditLogger;
  const roster = new ForwarderRoster(settings, client);
  return { detacher: new ForwarderDetacher(settings, client, roster, audit), removed, notes };
}

test("detaches a listed extra forwarder and leaves the real customer", async () => {
  const h = makeHarness();
  assert.equal(await h.detacher.maybeDetach("conv-1"), "detached");
  assert.deepEqual(h.removed, ["c-fwd"]);
});

test("detaches a lite-seat teammate too (same roster as the converter)", async () => {
  const h = makeHarness({
    participants: [
      { id: "c-lite", email: "lite@postiz.com" },
      { id: "c-cust", email: "jane@example.com" },
    ],
  });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "detached");
  assert.deepEqual(h.removed, ["c-lite"]);
});

test("REFUSES when every participant is a forwarder — never empties a conversation", async () => {
  const h = makeHarness({
    participants: [
      { id: "c-fwd", email: "ops@postiz.com" },
      { id: "c-lite", email: "lite@postiz.com" },
    ],
  });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "skipped");
  assert.deepEqual(h.removed, [], "an internal thread must be left intact");
});

test("no-op on a single participant, however forwarder-ish they look", async () => {
  const h = makeHarness({ participants: [{ id: "c-fwd", email: "ops@postiz.com" }] });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "skipped");
  assert.deepEqual(h.removed, []);
});

test("no-op when nobody on the thread is a forwarder (two genuine customers)", async () => {
  const h = makeHarness({
    participants: [
      { id: "c-1", email: "jane@example.com" },
      { id: "c-2", email: "john@example.com" },
    ],
  });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "skipped");
  assert.deepEqual(h.removed, []);
});

test("a FULL-seat teammate is not a forwarder: Intercom already handles those, and the roster is the single definition", async () => {
  const h = makeHarness({
    participants: [
      { id: "c-full", email: "agent@postiz.com" },
      { id: "c-cust", email: "jane@example.com" },
    ],
    extraEmails: [],
  });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "skipped");
  assert.deepEqual(h.removed, []);
});

test("posts an internal NOTE, never a customer-visible comment", async () => {
  const h = makeHarness();
  await h.detacher.maybeDetach("conv-1");
  assert.equal(h.notes.length, 1);
  assert.ok(h.notes[0].startsWith("note:"), "a comment would email the customer and stamp first_admin_reply_at");
  assert.match(h.notes[0], /ops@postiz\.com/);
});

test("both toggles gate it independently", async () => {
  assert.equal(await makeHarness({ enabled: false }).detacher.maybeDetach("conv-1"), "skipped");
  assert.equal(await makeHarness({ detachEnabled: false }).detacher.maybeDetach("conv-1"), "skipped");
});

test("an unsupported endpoint disables the feature instead of looping on it forever", async () => {
  const h = makeHarness({ removeStatus: 404 });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "unsupported");
  // Latched off: the sweep must stop re-probing an endpoint this workspace
  // does not have.
  assert.equal(h.detacher.needsCheck(["a", "b"]), false);
  assert.equal(await h.detacher.maybeDetach("conv-2"), "skipped");
});

test("a transient failure never throws and stays retryable next pass", async () => {
  const h = makeHarness({ removeStatus: 500 });
  assert.equal(await h.detacher.maybeDetach("conv-1"), "skipped");
  assert.equal(h.detacher.needsCheck(["a", "b"]), true, "500 must NOT latch the feature off");
});

test("needsCheck is the cheap sweep pre-filter: one participant is never worth a read", () => {
  const h = makeHarness();
  assert.equal(h.detacher.needsCheck([]), false);
  assert.equal(h.detacher.needsCheck(["only-one"]), false);
  assert.equal(h.detacher.needsCheck(["a", "b"]), true);
});
