import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceConversationAttributeValue,
  formatStoredAttributeValue,
  resolveConversationAttribute,
  type ConversationAttributeDef,
} from "../conversationAttributeWrite";

const DEFS: ConversationAttributeDef[] = [
  { name: "SLA Target", archived: false, dataType: "string" },
  { name: "Refund Amount", archived: false, dataType: "float" },
  { name: "Escalated", archived: false, dataType: "boolean" },
  { name: "Follow Up At", archived: false, dataType: "date" },
  { name: "Seats", archived: false, dataType: "integer" },
  { name: "Priority", archived: true, dataType: "string" },
];

// ---- name resolution ----

test("resolves an exact attribute name", () => {
  const result = resolveConversationAttribute(DEFS, "SLA Target");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.def.dataType, "string");
});

test("trims surrounding whitespace before matching", () => {
  assert.equal(resolveConversationAttribute(DEFS, "  Seats  ").ok, true);
});

test("accepts an unambiguous case-insensitive match", () => {
  const result = resolveConversationAttribute(DEFS, "sla target");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.def.name, "SLA Target");
});

test("refuses a case-insensitive match when two definitions collide", () => {
  const colliding = [
    { name: "Plan", archived: false, dataType: "string" },
    { name: "plan", archived: false, dataType: "string" },
  ];
  const result = resolveConversationAttribute(colliding, "PLAN");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /capitalisation/);
});

test("exact match wins over a case-insensitive sibling", () => {
  const colliding = [
    { name: "Plan", archived: false, dataType: "string" },
    { name: "plan", archived: false, dataType: "integer" },
  ];
  const result = resolveConversationAttribute(colliding, "plan");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.def.dataType, "integer");
});

test("rejects an archived attribute instead of writing to it", () => {
  const result = resolveConversationAttribute(DEFS, "Priority");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /archived/);
});

test("suggests near matches for an unknown name", () => {
  const result = resolveConversationAttribute(DEFS, "refund");
  assert.equal(result.ok, false);
  const error = result.ok === false ? result.error : "";
  assert.match(error, /Did you mean/);
  assert.match(error, /Refund Amount/);
  // Archived definitions are never suggested.
  assert.doesNotMatch(error, /Priority/);
});

test("lists available attributes when nothing resembles the input", () => {
  const result = resolveConversationAttribute(DEFS, "zzz");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /Available: /);
});

test("explains an empty workspace attribute list", () => {
  const result = resolveConversationAttribute([], "Anything");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /no conversation attributes defined/);
});

// ---- value coercion ----

test("passes text through unchanged", () => {
  const result = coerceConversationAttributeValue("string", " 4 business hours ");
  assert.equal(result.ok && result.value, "4 business hours");
});

test("coerces booleans from common spellings", () => {
  for (const raw of ["true", "TRUE", "yes", "1", "on"]) {
    const result = coerceConversationAttributeValue("boolean", raw);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, true);
  }
  for (const raw of ["false", "No", "0", "off"]) {
    const result = coerceConversationAttributeValue("boolean", raw);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, false);
  }
});

test("rejects a non-boolean for a boolean attribute", () => {
  const result = coerceConversationAttributeValue("boolean", "maybe");
  assert.equal(result.ok, false);
});

test("coerces integers and rejects decimals for integer attributes", () => {
  const ok = coerceConversationAttributeValue("integer", "-12");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value, -12);
  assert.equal(coerceConversationAttributeValue("integer", "1.5").ok, false);
  assert.equal(coerceConversationAttributeValue("integer", "12abc").ok, false);
});

test("coerces floats", () => {
  const result = coerceConversationAttributeValue("float", "19.99");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 19.99);
  assert.equal(coerceConversationAttributeValue("float", "abc").ok, false);
  assert.equal(coerceConversationAttributeValue("float", "").ok, false);
});

test("converts dates to unix seconds", () => {
  const result = coerceConversationAttributeValue("date", "2026-07-27");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, Date.parse("2026-07-27T00:00:00Z") / 1000);
});

test("takes bare digits as an already-unix date", () => {
  const result = coerceConversationAttributeValue("date", "1753574400");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 1753574400);
});

test("rejects an unparseable date", () => {
  assert.equal(coerceConversationAttributeValue("date", "next tuesday").ok, false);
});

test("treats an unknown data type as text", () => {
  const result = coerceConversationAttributeValue(null, "anything");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, "anything");
});

test("the null keyword clears any attribute type", () => {
  for (const dataType of ["string", "boolean", "integer", "date"]) {
    const result = coerceConversationAttributeValue(dataType, "NULL");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, null);
  }
});

// ---- read-back formatting ----

test("formats stored values, rendering dates as ISO", () => {
  assert.equal(formatStoredAttributeValue(null, "string"), "_(not set)_");
  assert.equal(formatStoredAttributeValue(undefined, "string"), "_(not set)_");
  assert.equal(formatStoredAttributeValue(true, "boolean"), "`true`");
  assert.equal(formatStoredAttributeValue(42, "integer"), "`42`");
  assert.match(formatStoredAttributeValue(1753574400, "date"), /2025-07-27T00:00:00.000Z/);
  assert.equal(formatStoredAttributeValue("hi", "string"), "`hi`");
});

test("truncates an overlong stored value", () => {
  const formatted = formatStoredAttributeValue("x".repeat(500), "string");
  assert.ok(formatted.length < 320);
  assert.match(formatted, /…$/);
});
