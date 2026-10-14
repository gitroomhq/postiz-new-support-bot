import type { Prisma, PrismaClient } from "../generated/prisma/client";
import type { QueueCache, QueueSaved } from "./QueueData";
import type { QueueConversation, QueueSla, QueueTicketInfo } from "./queueModel";

// The Intercom Queue's last list in Postgres (queue_cache, one row), so a
// restart shows it at once while the boot scan catches up. QueueData writes
// it behind (debounced, only after a change) and reads it once at boot.

const ROW_ID = 1;
const FORMAT = 1;
const MAX_ENTRIES = 20_000;
const SLA_VALUES = new Set<string>(["ok", "at_risk", "breached"]);

// The slice of PrismaClient the store touches (a fake in tests).
export type QueueCacheDb = Pick<PrismaClient, "queueCache">;

export class QueueCacheStore implements QueueCache {
  constructor(private db: QueueCacheDb) {}

  async load(): Promise<QueueSaved | null> {
    const row = await this.db.queueCache.findUnique({ where: { id: ROW_ID } });
    return row ? restoreSaved(row.data, row.savedAt.getTime()) : null;
  }

  async save(state: QueueSaved): Promise<void> {
    const data = {
      v: FORMAT,
      truncated: state.truncated,
      conversations: state.conversations,
      tickets: state.tickets,
    } as unknown as Prisma.InputJsonValue;
    const savedAt = new Date(state.savedAt);
    await this.db.queueCache.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, data, savedAt },
      update: { data, savedAt },
    });
  }
}

// The stored JSON, checked field by field: an entry written by another build
// (or edited by hand) is dropped rather than trusted.
export function restoreSaved(data: unknown, savedAt: number): QueueSaved | null {
  const o = obj(data);
  if (!o || o.v !== FORMAT || !Array.isArray(o.conversations) || !Array.isArray(o.tickets)) return null;
  const conversations: QueueConversation[] = [];
  for (const raw of o.conversations.slice(0, MAX_ENTRIES)) {
    const c = restoreConversation(raw);
    if (c) conversations.push(c);
  }
  const tickets: QueueSaved["tickets"] = [];
  for (const raw of o.tickets.slice(0, MAX_ENTRIES)) {
    const entry = obj(raw);
    const ticket = restoreTicket(entry?.ticket);
    const updatedAt = num(entry?.updatedAt);
    if (ticket && updatedAt != null) tickets.push({ ticket, updatedAt });
  }
  return { savedAt, truncated: o.truncated === true, conversations, tickets };
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// undefined = the field is malformed (the entry is dropped).
function optStr(v: unknown): string | null | undefined {
  return v === null ? null : typeof v === "string" ? v : undefined;
}

function optNum(v: unknown): number | null | undefined {
  return v === null ? null : num(v) ?? undefined;
}

function restoreTicket(v: unknown): QueueTicketInfo | null {
  const o = obj(v);
  if (!o || typeof o.id !== "string" || !o.id) return null;
  const fields = [o.stateId, o.stateCategory, o.stateLabel, o.typeId, o.typeName].map(optStr);
  if (fields.some((f) => f === undefined)) return null;
  const [stateId, stateCategory, stateLabel, typeId, typeName] = fields as Array<string | null>;
  return { id: o.id, stateId, stateCategory, stateLabel, typeId, typeName };
}

function restoreConversation(v: unknown): QueueConversation | null {
  const o = obj(v);
  if (!o || typeof o.id !== "string" || !o.id || typeof o.state !== "string") return null;
  const createdAt = num(o.createdAt);
  const updatedAt = num(o.updatedAt);
  if (createdAt == null || updatedAt == null) return null;
  if (typeof o.priority !== "boolean" || typeof o.title !== "string" || typeof o.excerpt !== "string") return null;
  if (!Array.isArray(o.tagIds) || !o.tagIds.every((t) => typeof t === "string")) return null;
  const strs = [o.customerName, o.customerEmail, o.sourceAuthorType, o.teamId, o.adminAssigneeId, o.ticketId, o.slaTarget].map(optStr);
  const nums = [o.waitingSince, o.snoozedUntil, o.lastContactReplyAt, o.lastAdminReplyAt].map(optNum);
  if (strs.some((f) => f === undefined) || nums.some((f) => f === undefined)) return null;
  const [customerName, customerEmail, sourceAuthorType, teamId, adminAssigneeId, ticketId, slaTarget] = strs as Array<string | null>;
  const [waitingSince, snoozedUntil, lastContactReplyAt, lastAdminReplyAt] = nums as Array<number | null>;
  const ticketInline = o.ticketInline === null ? null : restoreTicket(o.ticketInline);
  if (o.ticketInline !== null && !ticketInline) return null;
  const slaStatus = o.slaStatus === null ? null : typeof o.slaStatus === "string" && SLA_VALUES.has(o.slaStatus) ? (o.slaStatus as QueueSla) : undefined;
  if (slaStatus === undefined) return null;
  return {
    id: o.id,
    state: o.state,
    createdAt,
    updatedAt,
    waitingSince,
    snoozedUntil,
    priority: o.priority,
    title: o.title,
    excerpt: o.excerpt,
    customerName,
    customerEmail,
    sourceAuthorType,
    teamId,
    adminAssigneeId,
    tagIds: o.tagIds as string[],
    ticketId,
    ticketInline,
    lastContactReplyAt,
    lastAdminReplyAt,
    slaStatus,
    slaTarget,
  };
}
