import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryTail, type BridgeSourceMessage } from "../IntercomSyncService";

// Healed messages keep their original timestamps and land mid-history, so the
// heal leaves a note after them and, when the customer had the last word,
// moves the ticket to Customer responded.

const CUSTOMER = "cust";
const msg = (id: string, authorId: string, iso: string, bot = false): BridgeSourceMessage => ({
  discordMessageId: id,
  authorId,
  authorName: authorId,
  authorIsBot: bot,
  content: "hi",
  attachments: [],
  createdAt: new Date(iso),
});
const open = { closed: false, customerId: CUSTOMER, statusTagId: "tag-ongoing" };

test("nothing recovered: no tail", () => {
  assert.deepEqual(recoveryTail(open, [msg("1", CUSTOMER, "2026-09-02T18:55:00Z")], [], true), []);
});

test("the note names how many and when, and the customer-last flip carries the base tag", () => {
  const all = [
    msg("1", CUSTOMER, "2026-09-02T18:55:00Z"),
    msg("2", "staff", "2026-09-02T19:00:00Z"),
    msg("3", CUSTOMER, "2026-10-31T20:22:00Z"),
    msg("4", "bot", "2026-10-31T21:18:00Z", true),
  ];
  const tail = recoveryTail(open, all, all.slice(0, 3), true);
  assert.equal(tail[0].type, "note");
  assert.match((tail[0].payload as { content: string }).content, /3 messages .* from 2026-09-02 to 2026-10-31/);
  assert.deepEqual(tail[1], { type: "reply_state", payload: { kind: "customer", baseTagId: "tag-ongoing" } });
});

test("no flip when staff spoke last, the ticket is closed, reply state is off, or the last word was already delivered", () => {
  const staffLast = [msg("1", CUSTOMER, "2026-09-02T18:55:00Z"), msg("2", "staff", "2026-09-02T19:00:00Z")];
  assert.equal(recoveryTail(open, staffLast, staffLast, true).length, 1);
  const customerLast = [msg("1", "staff", "2026-09-02T18:55:00Z"), msg("2", CUSTOMER, "2026-09-02T19:00:00Z")];
  assert.equal(recoveryTail({ ...open, closed: true }, customerLast, customerLast, true).length, 1);
  assert.equal(recoveryTail(open, customerLast, customerLast, false).length, 1);
  assert.equal(recoveryTail(open, customerLast, customerLast.slice(0, 1), true).length, 1);
});

test("one message on one day reads in the singular", () => {
  const one = [msg("1", CUSTOMER, "2026-10-30T20:02:00Z")];
  const note = (recoveryTail(open, one, one, false)[0].payload as { content: string }).content;
  assert.match(note, /^🔁 1 message from the Discord thread .* It sits at its original time on 2026-10-30: scroll up to read it\.$/);
});
