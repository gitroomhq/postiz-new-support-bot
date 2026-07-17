import type { IntercomAdmin } from "./types";

// Pure hybrid balancer for bot-driven conversation assignment (Intercom
// Advanced lost native workload management). Round-robin rotation order with
// a load gate: teammates whose open assigned count is ABOVE the pool average
// are skipped this round; when everyone is above (impossible with a strict
// > comparison on a uniform pool) the fewest-open member wins. Away and
// excluded teammates never receive new work; their queues are never drained.

export interface PoolMember {
  id: string;
  name: string;
  openCount: number;
  away: boolean;
  excluded: boolean;
}

export function buildPool(
  teamAdminIds: string[],
  admins: IntercomAdmin[],
  operatorAdminId: string | null,
  excludedIds: Set<string>,
  openCounts: Map<string, number>,
): PoolMember[] {
  const byId = new Map(admins.map((a) => [a.id, a]));
  const members: PoolMember[] = [];
  for (const id of teamAdminIds) {
    if (operatorAdminId && id === operatorAdminId) continue; // never assign Fin/Operator
    const admin = byId.get(id);
    if (!admin) continue; // deleted/unknown admin still listed on the team
    if (admin.hasInboxSeat === false) continue; // lite seats can't work the inbox
    members.push({
      id,
      name: admin.name ?? id,
      openCount: openCounts.get(id) ?? 0,
      away: admin.awayModeEnabled === true,
      excluded: excludedIds.has(id),
    });
  }
  return members;
}

export interface PickResult {
  adminId: string;
  nextCursor: string;
}

// Rotation order = eligible members sorted by id, starting AFTER the cursor
// (the last bot-assigned admin). Strictly-greater-than-average load skip, so
// a uniform pool degrades to plain round-robin.
export function pickAssignee(members: PoolMember[], cursor: string | null): PickResult | null {
  const eligible = members.filter((m) => !m.away && !m.excluded);
  if (eligible.length === 0) return null;
  const ring = [...eligible].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const avg = ring.reduce((s, m) => s + m.openCount, 0) / ring.length;
  // Start index: first member strictly after the cursor id (wraps).
  let start = 0;
  if (cursor != null) {
    const idx = ring.findIndex((m) => m.id > cursor);
    start = idx === -1 ? 0 : idx;
  }
  for (let i = 0; i < ring.length; i++) {
    const m = ring[(start + i) % ring.length];
    if (m.openCount <= avg) return { adminId: m.id, nextCursor: m.id };
  }
  // Everyone above average can't happen with strict >, but guard anyway:
  // fall back to the least-loaded member in ring order from the cursor.
  let best = ring[start % ring.length];
  for (let i = 1; i < ring.length; i++) {
    const m = ring[(start + i) % ring.length];
    if (m.openCount < best.openCount) best = m;
  }
  return { adminId: best.id, nextCursor: best.id };
}
