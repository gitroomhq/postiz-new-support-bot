// Bounded in-memory holding pen for workflow starts/signals that failed while
// the Temporal server was unreachable. Flushed FIFO on recovery. Deliberately
// NOT durable (user decision): a bot restart mid-outage loses the buffer —
// webhook-driven work is redelivered by the sender (we answer 503), and
// timer-driven work self-heals from DB state once workflows resume.

export interface BufferedOp {
  kind: "start" | "signal" | "signalWithStart";
  workflowType?: string;
  workflowId: string;
  signalName?: string;
  args: unknown[];
  signalArgs?: unknown[];
  options?: Record<string, unknown>;
  enqueuedAt: number;
  attempts: number;
}

export class RetryBuffer {
  private ops: BufferedOp[] = [];
  private dropped = 0;

  constructor(private capacity = 500) {}

  // Drop-OLDEST on overflow: the newest events are the ones most likely to
  // still matter (old ones have often been superseded or redelivered).
  push(op: BufferedOp): { dropped: BufferedOp | null } {
    this.ops.push(op);
    if (this.ops.length > this.capacity) {
      this.dropped++;
      return { dropped: this.ops.shift() ?? null };
    }
    return { dropped: null };
  }

  // Removes and returns everything, oldest first.
  drain(): BufferedOp[] {
    const out = this.ops;
    this.ops = [];
    return out;
  }

  size(): number {
    return this.ops.length;
  }

  capacityOf(): number {
    return this.capacity;
  }

  droppedTotal(): number {
    return this.dropped;
  }
}
