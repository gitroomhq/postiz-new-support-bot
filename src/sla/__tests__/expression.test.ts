import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpression, serializeExpression, serializeCondition, EXPRESSION_KEYS } from "../expression";
import { ParseContext, SlaCondition } from "../types";

const ctx: ParseContext = {
  categories: [{ id: "billing" }, { id: "bugs" }, { id: "howto", label: "How-To" }],
  tags: [
    { id: "tag_open", label: "Open", emoji: "🟢" },
    { id: "tag_wait", label: "Waiting for Customer", emoji: "⏳" },
  ],
};

function parseOk(text: string): SlaCondition[] {
  const res = parseExpression(text, ctx);
  assert.equal(res.ok, true, `expected ok parse for: ${text} — ${JSON.stringify(res)}`);
  return (res as { ok: true; conditions: SlaCondition[] }).conditions;
}

function parseErrors(text: string) {
  const res = parseExpression(text, ctx);
  assert.equal(res.ok, false, `expected parse errors for: ${text}`);
  return (res as { ok: false; errors: { pos: number; len: number; message: string; hint?: string }[] }).errors;
}

test("parses every dimension and operator", () => {
  const conditions = parseOk(
    [
      "category=billing",
      "category!=bugs",
      'status="Waiting for Customer"',
      "status!=Open",
      "open=true",
      "exempt=false",
      "mirrored=true",
      "stripe.linked=true",
      "stripe.paying=true",
      "stripe.dispute=false",
      "stripe.refund_review=true",
      "stripe.plan=price_123",
      "stripe.plan!=price_456",
      'stripe.plan~"pro|team"',
      "stripe.spend>100",
      "stripe.spend>=100.5",
      "stripe.spend<20",
      "stripe.spend<=0",
      "intercom.team=Billing",
      "intercom.team!=12345",
      "intercom.kind=ticket",
      "intercom.ticket_type=99",
      "intercom.tag=vip",
      "intercom.tag!=spam",
      "intercom.assignee=42",
      "intercom.assignee!=99",
      "attr:Sentiment=positive",
      'attr:"AI Title"~"refund"',
      "attr:Sentiment=*",
      'attr:"AI Title"!=*',
      'keyword~"refund"',
      'keyword!~"newsletter"',
    ].join(" AND ")
  );
  assert.equal(conditions.length, 32);
  assert.deepEqual(conditions[2], { dim: "status", op: "eq", tagId: "tag_wait" });
  assert.deepEqual(conditions[24], { dim: "intercom.assignee", op: "eq", value: "42" });
  assert.deepEqual(conditions[26], { dim: "intercom.attribute", name: "Sentiment", op: "eq", value: "positive" });
  assert.deepEqual(conditions[27], { dim: "intercom.attribute", name: "AI Title", op: "matches", value: "refund" });
  assert.deepEqual(conditions[28], { dim: "intercom.attribute", name: "Sentiment", op: "set" });
  assert.deepEqual(conditions[29], { dim: "intercom.attribute", name: "AI Title", op: "not_set" });
});

test("name resolution is case-insensitive and accepts emoji/id for status", () => {
  assert.deepEqual(parseOk("status=open")[0], { dim: "status", op: "eq", tagId: "tag_open" });
  assert.deepEqual(parseOk('status="🟢"')[0], { dim: "status", op: "eq", tagId: "tag_open" });
  assert.deepEqual(parseOk("status=tag_open")[0], { dim: "status", op: "eq", tagId: "tag_open" });
  assert.deepEqual(parseOk("category=BILLING")[0], { dim: "category", op: "eq", value: "billing" });
  assert.deepEqual(parseOk('category="How-To"')[0], { dim: "category", op: "eq", value: "howto" });
});

test("AND is case-insensitive", () => {
  assert.equal(parseOk("open=true and exempt=false").length, 2);
});

test("positioned errors: unknown key, bad op, unknown name, OR, garbage", () => {
  const unknownKey = parseErrors("nonsense=1");
  assert.equal(unknownKey[0].pos, 0);
  assert.match(unknownKey[0].message, /unknown key/);
  assert.match(unknownKey[0].hint ?? "", /category/);

  const badOp = parseErrors("keyword=refund");
  assert.match(badOp[0].message, /not supported for keyword/);

  const unknownTag = parseErrors('status="Nope"');
  assert.match(unknownTag[0].message, /unknown status tag/);
  assert.equal(unknownTag[0].pos, "status=".length);

  const orErr = parseErrors("open=true OR exempt=true");
  assert.match(orErr[0].message, /OR is not supported/);

  const unterminated = parseErrors('keyword~"abc');
  assert.match(unterminated[0].message, /unterminated/);

  const empty = parseErrors("   ");
  assert.match(empty[0].message, /empty/);

  const boolBad = parseErrors("open=yes");
  assert.match(boolBad[0].message, /true or false/);

  const spendBad = parseErrors('stripe.spend>="lots"');
  assert.match(spendBad[0].message, /needs a number/);

  const badRegex = parseErrors('keyword~"("');
  assert.match(badRegex[0].message, /invalid regex/);
});

test("multiple value errors are all reported", () => {
  const errors = parseErrors("category=nope AND status=missing");
  assert.equal(errors.length, 2);
});

test("serialize ⇄ parse round-trip for every dimension", () => {
  const conditions: SlaCondition[] = [
    { dim: "category", op: "eq", value: "billing" },
    { dim: "category", op: "neq", value: "howto" },
    { dim: "status", op: "eq", tagId: "tag_wait" },
    { dim: "open", op: "eq", value: true },
    { dim: "exempt", op: "eq", value: false },
    { dim: "mirrored", op: "eq", value: true },
    { dim: "stripe.linked", op: "eq", value: true },
    { dim: "stripe.paying", op: "eq", value: false },
    { dim: "stripe.dispute", op: "eq", value: true },
    { dim: "stripe.refund_review", op: "eq", value: false },
    { dim: "stripe.plan", op: "matches", value: "pro|team" },
    { dim: "stripe.plan", op: "eq", value: "price_123" },
    { dim: "stripe.spend", op: "gte", value: 250.75 },
    { dim: "intercom.team", op: "eq", value: "Billing Team" },
    { dim: "intercom.kind", op: "eq", value: "ticket" },
    { dim: "intercom.ticket_type", op: "neq", value: "42" },
    { dim: "intercom.tag", op: "has", value: "vip" },
    { dim: "intercom.tag", op: "not_has", value: "spam" },
    { dim: "intercom.assignee", op: "eq", value: "42" },
    { dim: "intercom.attribute", name: "Sentiment", op: "eq", value: "positive" },
    { dim: "intercom.attribute", name: 'Weird "Name"', op: "matches", value: "a|b" },
    { dim: "intercom.attribute", name: "Sentiment", op: "set" },
    { dim: "intercom.attribute", name: "AI Title", op: "not_set" },
    { dim: "keyword", op: "matches", value: "refund me \"now\" \\ please" },
    { dim: "keyword", op: "not_matches", value: "unsubscribe" },
  ];
  const text = serializeExpression(conditions, ctx);
  const back = parseExpression(text, ctx);
  assert.equal(back.ok, true, `round-trip parse failed: ${text} — ${JSON.stringify(back)}`);
  assert.deepEqual((back as { ok: true; conditions: SlaCondition[] }).conditions, conditions);
});

test("serialization renders ids as current labels and quotes when needed", () => {
  assert.equal(serializeCondition({ dim: "status", op: "eq", tagId: "tag_wait" }, ctx), 'status="Waiting for Customer"');
  assert.equal(serializeCondition({ dim: "intercom.attribute", name: "AI Title", op: "set" }, ctx), 'attr:"AI Title"=*');
  assert.equal(serializeCondition({ dim: "keyword", op: "matches", value: "refund" }, ctx), 'keyword~"refund"');
  // deleted tag falls back to the raw id (parse will flag it — intended)
  assert.equal(serializeCondition({ dim: "status", op: "eq", tagId: "gone" }, ctx), "status=gone");
});

test("EXPRESSION_KEYS covers all documented dims", () => {
  for (const key of ["category", "status", "open", "exempt", "mirrored", "stripe.linked", "stripe.paying", "stripe.dispute", "stripe.refund_review", "stripe.plan", "stripe.spend", "intercom.team", "intercom.assignee", "intercom.kind", "intercom.ticket_type", "intercom.tag", "keyword"]) {
    assert.ok(EXPRESSION_KEYS.includes(key), `missing key ${key}`);
  }
});
