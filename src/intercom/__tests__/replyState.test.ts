import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoTransitionOrigin,
  autoTransitionOriginFromParts,
  isHumanReply,
  lastSpeaker,
  newestCustomerMessageAt,
  pickStateForCategory,
  previousCategoryFromHistory,
  restoreCategory,
} from "../replyState";
import type { IntercomTicketState, IntercomTicketStateChange, IntercomWebhookPart } from "../types";

const OPERATOR = "11005726";
const isHuman = (id: string | null) => id != null && id !== OPERATOR;

const STATES: IntercomTicketState[] = [
  { id: "s1", category: "submitted", internalLabel: "Submitted", archived: false },
  { id: "p0", category: "in_progress", internalLabel: "Investigating", archived: false },
  { id: "p1", category: "in_progress", internalLabel: "In Progress", archived: false },
  { id: "cr", category: "in_progress", internalLabel: "Customer responded", archived: false },
  { id: "w0", category: "waiting_on_customer", internalLabel: "Waiting for return", archived: true },
  { id: "w1", category: "waiting_on_customer", internalLabel: "Waiting on Customer", archived: false },
  { id: "r1", category: "resolved", internalLabel: "Resolved", archived: false },
];

function change(previous: string, current: string, createdAt: number, extra: Partial<IntercomTicketStateChange> = {}): IntercomTicketStateChange {
  return { previous, current, createdAt, authorType: "bot", authorId: OPERATOR, appPackageCode: null, ...extra };
}

test("restoreCategory: Submitted, Resolved and unknown history land on Waiting on customer", () => {
  assert.equal(restoreCategory("submitted"), "waiting_on_customer");
  assert.equal(restoreCategory("resolved"), "waiting_on_customer");
  assert.equal(restoreCategory(null), "waiting_on_customer");
  assert.equal(restoreCategory("waiting_on_customer"), "waiting_on_customer");
  assert.equal(restoreCategory("in_progress"), "in_progress");
});

test("pickStateForCategory prefers Intercom's default label and skips the customer-responded and archived states", () => {
  assert.equal(pickStateForCategory(STATES, "in_progress", "cr")?.id, "p1");
  assert.equal(pickStateForCategory(STATES, "waiting_on_customer", "cr")?.id, "w1");
  const noDefault = STATES.filter((s) => s.id !== "p1");
  assert.equal(pickStateForCategory(noDefault, "in_progress", "cr")?.id, "p0");
  assert.equal(pickStateForCategory(STATES, "in_progress", null)?.id, "p1");
  assert.equal(pickStateForCategory([], "in_progress", "cr"), null);
});

test("autoTransitionOrigin recognises Intercom's own Waiting on customer to In progress move", () => {
  const changes = [change("submitted", "waiting_on_customer", 900, { authorType: "admin", authorId: "42" }), change("waiting_on_customer", "in_progress", 1001)];
  assert.equal(autoTransitionOrigin(changes, 1000, isHuman), "waiting_on_customer");
  assert.equal(autoTransitionOrigin([change("resolved", "in_progress", 1001)], 1000, isHuman), "resolved");
});

test("autoTransitionOrigin ignores people, API apps, stale moves and moves that are not the newest", () => {
  assert.equal(autoTransitionOrigin([change("waiting_on_customer", "in_progress", 1001, { authorType: "admin", authorId: "42" })], 1000, isHuman), null);
  assert.equal(autoTransitionOrigin([change("waiting_on_customer", "in_progress", 1001, { appPackageCode: "discord-support-bot" })], 1000, isHuman), null);
  assert.equal(autoTransitionOrigin([change("waiting_on_customer", "in_progress", 500)], 1000, isHuman), null);
  const thenSomeoneMoved = [change("waiting_on_customer", "in_progress", 1001), change("in_progress", "in_progress", 1002, { authorType: "admin", authorId: "42" })];
  assert.equal(autoTransitionOrigin(thenSomeoneMoved, 1000, isHuman), null);
  assert.equal(autoTransitionOrigin([change("submitted", "in_progress", 1001)], 1000, isHuman), null);
  assert.equal(autoTransitionOrigin([], 1000, isHuman), null);
});

// The live shape (conversation 215476172035382): teammate replies, sets the
// state, the customer answers, and Fin's identity logs Intercom's own move a
// second later.
const LIVE_PARTS: IntercomWebhookPart[] = [
  { id: "a", part_type: "assignment", body: "<p>We checked on our end.</p>", created_at: 1790790873, author: { id: "11060768", type: "admin" } },
  { id: "b", part_type: "ticket_state_updated_by_admin", body: null, created_at: 1790790879, author: { id: "11060768", type: "admin" } },
  { id: "c", part_type: "comment", body: "<p>Hi, I did check my junk folder.</p>", created_at: 1790791012, author: { id: "u1", type: "user" } },
  { id: "d", part_type: "ticket_state_updated_by_admin", body: null, created_at: 1790791013, author: { id: OPERATOR, type: "bot" }, app_package_code: null },
];

test("autoTransitionOriginFromParts reads the live conversation shape as Waiting on customer", () => {
  assert.equal(autoTransitionOriginFromParts(LIVE_PARTS, 1790791012, isHuman), "waiting_on_customer");
});

test("autoTransitionOriginFromParts: a close before the reply means it was Resolved", () => {
  const parts: IntercomWebhookPart[] = [
    { id: "x", part_type: "close", body: null, created_at: 1790790900, author: { id: "11060768", type: "admin" } },
    ...LIVE_PARTS.slice(2),
  ];
  assert.equal(autoTransitionOriginFromParts(parts, 1790791012, isHuman), "resolved");
});

test("autoTransitionOriginFromParts ignores a person's state change, the bot's own writes and old moves", () => {
  const human = [...LIVE_PARTS.slice(0, 3), { ...LIVE_PARTS[3], author: { id: "11060768", type: "admin" } }];
  assert.equal(autoTransitionOriginFromParts(human, 1790791012, isHuman), null);
  const ours = [...LIVE_PARTS.slice(0, 3), { ...LIVE_PARTS[3], app_package_code: "discord-support-bot" }];
  assert.equal(autoTransitionOriginFromParts(ours, 1790791012, isHuman), null);
  assert.equal(autoTransitionOriginFromParts(LIVE_PARTS.slice(0, 3), 1790791012, isHuman), null);
});

test("previousCategoryFromHistory returns where the ticket came from into its current category", () => {
  const changes = [change("submitted", "waiting_on_customer", 10), change("waiting_on_customer", "in_progress", 20), change("in_progress", "in_progress", 30)];
  assert.equal(previousCategoryFromHistory(changes, "in_progress"), "in_progress");
  assert.equal(previousCategoryFromHistory(changes.slice(0, 2), "in_progress"), "waiting_on_customer");
  assert.equal(previousCategoryFromHistory([], "in_progress"), null);
  // Intercom's own move, then this bot's in-category write into the state.
  const ours = [change("waiting_on_customer", "in_progress", 20), change("in_progress", "in_progress", 21, { appPackageCode: "discord-support-bot" })];
  assert.equal(previousCategoryFromHistory(ours, "in_progress"), "waiting_on_customer");
});

test("isHumanReply: people only, messages only", () => {
  const admin = { id: "42", type: "admin" };
  assert.equal(isHumanReply({ id: "1", part_type: "comment", body: "<p>hi</p>", author: admin }, isHuman), true);
  assert.equal(isHumanReply({ id: "1", part_type: "assignment", body: "<p>reply and assign</p>", author: admin }, isHuman), true);
  assert.equal(isHumanReply({ id: "1", part_type: "assignment", body: null, author: admin }, isHuman), false);
  assert.equal(isHumanReply({ id: "1", part_type: "note", body: "<p>internal</p>", author: admin }, isHuman), false);
  assert.equal(isHumanReply({ id: "1", part_type: "comment", body: "<p>Fin</p>", author: { id: OPERATOR, type: "bot" } }, isHuman), false);
  assert.equal(isHumanReply({ id: "1", part_type: "comment", body: "<p>bridge</p>", author: { id: OPERATOR, type: "admin" } }, isHuman), false);
  assert.equal(isHumanReply({ id: "1", part_type: "comment", body: "<p>gone</p>", author: admin, redacted: true }, isHuman), false);
  assert.equal(isHumanReply({ id: "1", part_type: "comment", body: '<p><img src="x"></p>', author: admin }, isHuman), true);
});

test("newestCustomerMessageAt picks the newest contact message", () => {
  assert.equal(newestCustomerMessageAt(LIVE_PARTS), 1790791012);
  assert.equal(newestCustomerMessageAt([]), null);
});

test("lastSpeaker: Fin never answers for us, the bridge does on bridged tickets", () => {
  const customer = { id: "c", part_type: "comment", body: "<p>?</p>", created_at: 100, author: { id: "u1", type: "user" } };
  const fin = { id: "f", part_type: "comment", body: "<p>Fin here</p>", created_at: 200, author: { id: OPERATOR, type: "bot" } };
  const human = { id: "h", part_type: "comment", body: "<p>Agent</p>", created_at: 300, author: { id: "42", type: "admin" } };
  const bridge = { id: "b", part_type: "comment", body: "<p>**Staff:** hi</p>", created_at: 200, author: { id: OPERATOR, type: "bot" } };
  const isBridgeAuthor = (id: string | null) => id === OPERATOR;
  assert.equal(lastSpeaker([customer, fin], { bridged: false, isHumanAdmin: isHuman, isBridgeAuthor }), "customer");
  assert.equal(lastSpeaker([customer, fin, human], { bridged: false, isHumanAdmin: isHuman, isBridgeAuthor }), "us");
  assert.equal(lastSpeaker([customer, bridge], { bridged: true, isHumanAdmin: isHuman, isBridgeAuthor }), "us");
  assert.equal(lastSpeaker([bridge, { ...customer, created_at: 300 }], { bridged: true, isHumanAdmin: isHuman, isBridgeAuthor }), "customer");
  assert.equal(lastSpeaker([], { bridged: true, isHumanAdmin: isHuman, isBridgeAuthor }), null);
});
