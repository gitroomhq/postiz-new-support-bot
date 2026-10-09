// Ticket blocks (/config → General → Ticket Blocks): Discord roles whose
// holders can't open tickets from the Discord support panel. Intercom
// Messenger, email and the Sentry feedback import are not affected. Pure
// decisions only; DiscordBot does the Discord and database work.

export const MAX_TICKET_BLOCK_ROLES = 10;

// Shown to a blocked member. Deliberately generic: no role name, no reason.
export const TICKET_BLOCKED_MESSAGE = "You can't open support tickets on Discord. Please contact support another way.";

// The member could not be looked up while block roles are configured. Refusing
// is the safe side: letting it through would skip the block entirely.
export const TICKET_BLOCK_UNVERIFIED_MESSAGE = "We couldn't check your server membership. Please try again in a moment.";

// Actor names on the status changes the block makes (audit channel, history).
export const TICKET_BLOCK_ACTOR = "System (ticket block)";
export const TICKET_UNBLOCK_ACTOR = "System (ticket block lifted)";

// Internal notes for agents reading the Intercom inbox; the thread stays silent.
export const TICKET_BLOCK_CLOSE_NOTE = "Closed automatically. The customer was blocked from opening tickets on Discord.";
export const TICKET_UNBLOCK_REOPEN_NOTE = "Reopened automatically. The customer's Discord ticket block was lifted.";

// How far back an audit entry may be to count as the role add behind a member
// event (only consulted when the member wasn't cached, see blockTransition).
export const BLOCK_AUDIT_WINDOW_MS = 5 * 60_000;

// Effective block: holds a block role and isn't staff (staff are always exempt).
export function isTicketBlocked(roleIds: Iterable<string>, blockRoleIds: readonly string[], isStaff: boolean): boolean {
  if (isStaff || blockRoleIds.length === 0) return false;
  const block = new Set(blockRoleIds);
  for (const id of roleIds) if (block.has(id)) return true;
  return false;
}

export type BlockTransition = "block" | "unblock" | "none";

// What a member event means for the member's tickets. `before` is null when the
// member wasn't cached, so the earlier state is unknown:
// - still blocked: only a block role added just now counts (`roleJustAdded`,
//   read from the audit log), so a member who held the role before it was
//   configured is never closed out later by an unrelated profile change;
// - not blocked: reopen whatever a block closed. That is a no-op without such
//   tickets, and correct whenever there are some, because the block is gone.
export function blockTransition(before: boolean | null, after: boolean, roleJustAdded = false): BlockTransition {
  if (before === null) {
    if (!after) return "unblock";
    return roleJustAdded ? "block" : "none";
  }
  if (!before && after) return "block";
  if (before && !after) return "unblock";
  return "none";
}

// The slice of a discord.js audit log entry the role-add check reads.
export interface RoleAuditEntry {
  targetId: string | null;
  createdTimestamp: number;
  changes: ReadonlyArray<{ key: string; new?: unknown }>;
}

// True when a recent MemberRoleUpdate entry added one of the block roles to
// this member.
export function auditShowsBlockRoleAdded(
  entries: Iterable<RoleAuditEntry>,
  memberId: string,
  blockRoleIds: readonly string[],
  nowMs: number,
  windowMs = BLOCK_AUDIT_WINDOW_MS
): boolean {
  const block = new Set(blockRoleIds);
  for (const entry of entries) {
    if (entry.targetId !== memberId || nowMs - entry.createdTimestamp > windowMs) continue;
    for (const change of entry.changes) {
      if (change.key !== "$add" || !Array.isArray(change.new)) continue;
      if (change.new.some((role) => block.has((role as { id?: string })?.id ?? ""))) return true;
    }
  }
  return false;
}

export type BlockRoleSelection = { ok: true; roleIds: string[] } | { ok: false; error: string };

const SNOWFLAKE_RE = /^\d{17,20}$/;

// Validates a /config role pick. The guild id doubles as the @everyone role id.
export function validateBlockRoleSelection(
  values: readonly string[],
  opts: { guildId: string | null; staffRoleIds: readonly string[] }
): BlockRoleSelection {
  const roleIds = [...new Set(values)];
  if (roleIds.length > MAX_TICKET_BLOCK_ROLES) {
    return { ok: false, error: `Pick at most ${MAX_TICKET_BLOCK_ROLES} block roles.` };
  }
  if (roleIds.some((id) => !SNOWFLAKE_RE.test(id))) {
    return { ok: false, error: "That selection contains an invalid role." };
  }
  if (opts.guildId && roleIds.includes(opts.guildId)) {
    return { ok: false, error: "@everyone can't be a block role: it would block every member." };
  }
  const staff = roleIds.find((id) => opts.staffRoleIds.includes(id));
  if (staff) {
    return { ok: false, error: `<@&${staff}> is a staff role. Staff are never blocked, so it would have no effect.` };
  }
  return { ok: true, roleIds };
}
