import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TICKET_BLOCK_ROLES,
  auditShowsBlockRoleAdded,
  blockTransition,
  isTicketBlocked,
  validateBlockRoleSelection,
} from "../ticketBlock";

// Ticket blocks: a block role stops a member opening Discord tickets, getting
// one closes their open tickets, losing it reopens the ones the block closed.

const BLOCK = "111111111111111111";
const OTHER_BLOCK = "222222222222222222";
const PLAIN = "333333333333333333";
const STAFF = "444444444444444444";
const GUILD = "555555555555555555";
const MEMBER = "666666666666666666";

test("a member is blocked by any configured block role", () => {
  assert.equal(isTicketBlocked([PLAIN, OTHER_BLOCK], [BLOCK, OTHER_BLOCK], false), true);
  assert.equal(isTicketBlocked([PLAIN], [BLOCK, OTHER_BLOCK], false), false);
});

test("staff are never blocked, and no block roles means nobody is", () => {
  assert.equal(isTicketBlocked([BLOCK], [BLOCK], true), false);
  assert.equal(isTicketBlocked([BLOCK], [], false), false);
});

test("a known earlier state turns role changes into block and unblock", () => {
  assert.equal(blockTransition(false, true), "block");
  assert.equal(blockTransition(true, false), "unblock");
  assert.equal(blockTransition(true, true), "none");
  assert.equal(blockTransition(false, false), "none");
});

test("an uncached blocked member is only closed out when the role was just added", () => {
  // Held the role before it was configured, then changed a nickname: untouched.
  assert.equal(blockTransition(null, true), "none");
  assert.equal(blockTransition(null, true, true), "block");
});

test("an uncached member who is not blocked gets block-closed tickets back", () => {
  assert.equal(blockTransition(null, false), "unblock");
  assert.equal(blockTransition(null, false, true), "unblock");
});

test("the audit check finds a recent block role add for this member only", () => {
  const now = 1_000_000_000;
  const entry = (over: Partial<{ targetId: string; at: number; key: string; roles: string[] }>) => ({
    targetId: over.targetId ?? MEMBER,
    createdTimestamp: over.at ?? now - 1_000,
    changes: [{ key: over.key ?? "$add", new: (over.roles ?? [BLOCK]).map((id) => ({ id, name: "r" })) }],
  });
  assert.equal(auditShowsBlockRoleAdded([entry({})], MEMBER, [BLOCK], now), true);
  assert.equal(auditShowsBlockRoleAdded([entry({ targetId: "777777777777777777" })], MEMBER, [BLOCK], now), false);
  assert.equal(auditShowsBlockRoleAdded([entry({ key: "$remove" })], MEMBER, [BLOCK], now), false);
  assert.equal(auditShowsBlockRoleAdded([entry({ roles: [PLAIN] })], MEMBER, [BLOCK], now), false);
  assert.equal(auditShowsBlockRoleAdded([entry({ at: now - 10 * 60_000 })], MEMBER, [BLOCK], now), false);
  assert.equal(
    auditShowsBlockRoleAdded([{ targetId: MEMBER, createdTimestamp: now, changes: [{ key: "$add" }] }], MEMBER, [BLOCK], now),
    false
  );
});

test("a valid role pick is deduplicated and accepted, an empty pick clears", () => {
  assert.deepEqual(validateBlockRoleSelection([BLOCK, BLOCK, OTHER_BLOCK], { guildId: GUILD, staffRoleIds: [STAFF] }), {
    ok: true,
    roleIds: [BLOCK, OTHER_BLOCK],
  });
  assert.deepEqual(validateBlockRoleSelection([], { guildId: GUILD, staffRoleIds: [] }), { ok: true, roleIds: [] });
});

test("@everyone, staff roles, malformed ids and too many roles are refused", () => {
  const opts = { guildId: GUILD, staffRoleIds: [STAFF] };
  assert.equal(validateBlockRoleSelection([GUILD], opts).ok, false);
  assert.equal(validateBlockRoleSelection([BLOCK, STAFF], opts).ok, false);
  assert.equal(validateBlockRoleSelection(["not-a-role"], opts).ok, false);
  const many = Array.from({ length: MAX_TICKET_BLOCK_ROLES + 1 }, (_, i) => String(100000000000000000n + BigInt(i)));
  assert.equal(validateBlockRoleSelection(many, opts).ok, false);
  assert.equal(validateBlockRoleSelection(many.slice(0, MAX_TICKET_BLOCK_ROLES), opts).ok, true);
});
