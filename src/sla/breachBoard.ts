import type { ClockKind } from "./clocks";

// Which clocks the last enforcement tick found breached, per conversation.
// Memory only: the queue uses it to say which SLA a ticket broke. Every tick
// re-evaluates every open conversation (about every five minutes), so an entry
// older than ENTRY_TTL_MS belongs to a conversation the enforcer no longer
// looks at (closed, snoozed, target removed) and is ignored. Until the first
// tick after a restart the queue simply says "SLA breached".

const ENTRY_TTL_MS = 30 * 60_000;
const PRUNE_ABOVE = 2000;

export interface SlaBreachSource {
  breached(conversationId: string): ClockKind[] | null;
}

export class SlaBreachBoard implements SlaBreachSource {
  private entries = new Map<string, { kinds: ClockKind[]; at: number }>();

  constructor(private now: () => number = Date.now) {}

  record(conversationId: string, kinds: ClockKind[]): void {
    if (kinds.length === 0) {
      this.entries.delete(conversationId);
      return;
    }
    this.entries.set(conversationId, { kinds: [...new Set(kinds)], at: this.now() });
    if (this.entries.size > PRUNE_ABOVE) this.prune();
  }

  breached(conversationId: string): ClockKind[] | null {
    const entry = this.entries.get(conversationId);
    if (!entry) return null;
    if (this.now() - entry.at > ENTRY_TTL_MS) {
      this.entries.delete(conversationId);
      return null;
    }
    return entry.kinds;
  }

  private prune(): void {
    const cutoff = this.now() - ENTRY_TTL_MS;
    for (const [id, entry] of this.entries) if (entry.at < cutoff) this.entries.delete(id);
  }
}

// The queue badge for a breached conversation.
export function breachLabel(kinds: ClockKind[] | null): string {
  if (!kinds || kinds.length === 0) return "SLA breached";
  const reply = kinds.some((k) => k === "first_reply" || k === "next_reply");
  const resolution = kinds.includes("resolution");
  if (reply && resolution) return "Reply and resolution SLA breached";
  return reply ? "Reply SLA breached" : "Resolution SLA breached";
}
