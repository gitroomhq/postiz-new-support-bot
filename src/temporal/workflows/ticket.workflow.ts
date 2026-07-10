import {
  allHandlersFinished,
  condition,
  continueAsNew,
  executeChild,
  proxyActivities,
  setHandler,
  sleep,
  startChild,
  upsertMemo,
  upsertSearchAttributes,
  workflowInfo,
} from "@temporalio/workflow";
import type {
  CoreActivities,
  IcEvent,
  IntercomDeliveryResult,
  StatusChangeRequest,
  StatusChangeResult,
  TicketCreatedSignal,
  TicketSnapshot,
  TicketWorkflowInput,
} from "../types";
import {
  autoAnswerChildId,
  intercomDeliveryChildId,
  SA_AI_KIND,
  SA_TICKET_STATUS,
  SA_TICKET_THREAD_ID,
  statusChangeChildId,
} from "../types";
import {
  applyPriorityUpdate,
  applyStatusUpdate,
  getStateQuery,
  humanMessageSignal,
  intercomEnqueueSignal,
  noopSignal,
  remindersPausedSignal,
  requestStatusChangeSignal,
  ticketCreatedSignal,
} from "./definitions";
import { autoAnswerWorkflow } from "./ai.workflow";
import { intercomDeliveryWorkflow } from "./intercom.workflow";
import { statusChangeWorkflow } from "./status.workflow";

const DAY_MS = 24 * 60 * 60 * 1000;
// The workflow keeps listening for reopen/re-close/late CSAT for 14 quiet days
// after close, then completes; a later event signal-with-starts a fresh run
// that rehydrates from Postgres (user decision).
const RETENTION_MS = 14 * DAY_MS;
// Reminder / resolved-auto-close scan cadence — matches the legacy
// ReminderScheduler's 30-minute tick; also the config-freshness bound (tag
// edits in /config are picked up within one scan).
const TIMER_SCAN_MS = 30 * 60 * 1000;
// Re-check cadence for a paused Intercom pump (mode "none"/unconfigured).
const PUMP_DISABLED_RECHECK_MS = 30 * 60 * 1000;
const HISTORY_SOFT_LIMIT = 10_000;

const quick = proxyActivities<CoreActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

// One evaluation does several Discord fetches and possibly sends a reminder —
// single attempt; the next scan retries naturally.
const timers = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

// The long-lived per-ticket owner: all durable timers (reminders, resolved
// auto-close, re-close deadline, retention) + the per-ticket Intercom outbox
// pump + status/priority changes as child workflows.
export async function ticketWorkflow(input: TicketWorkflowInput): Promise<void> {
  const threadId = input.threadId;
  const outbox: IcEvent[] = input.carry?.outbox ?? [];
  let outboxSeq = input.carry?.outboxSeq ?? 0;
  let statusSeq = input.carry?.statusSeq ?? 0;
  let hasIntercomLink = input.carry?.hasIntercomLink ?? false;
  let lastEventMs: number | null = input.carry?.lastEventMs ?? null;

  let snap: TicketSnapshot | null = null;
  let nudge = false;
  let stopping = false;
  let creation: TicketCreatedSignal | null = null;
  let autoAnswerRunning = false;
  let statusChangesRunning = 0;
  let lastTimerCheckMs = 0;

  const touch = (): void => {
    lastEventMs = now();
    nudge = true;
  };
  const now = (): number => Date.now(); // workflow sandbox: deterministic workflow time

  const enqueueIc = (type: IcEvent["type"], payload: unknown | null): void => {
    outbox.push({ seq: outboxSeq++, type, payload });
    touch();
  };

  // Search attributes are attached to this workflow's start only after the
  // producer confirmed server-side registration — their presence is therefore
  // the deterministic, replay-safe gate for every SA command this run issues
  // (an upsert naming an unregistered attribute fails the workflow task).
  const saEnabled = workflowInfo().typedSearchAttributes.get(SA_TICKET_THREAD_ID) != null;
  let lastStatusSa: string | null | undefined; // undefined = never synced this run
  const syncStatusSa = (label: string | null): void => {
    if (!saEnabled || label === lastStatusSa) return;
    lastStatusSa = label;
    // null unsets — a ticket without a tag drops out of status queries.
    upsertSearchAttributes([{ key: SA_TICKET_STATUS, value: label }]);
  };

  // Serializes status/priority changes (replaces the legacy per-thread
  // promise chains in StatusService).
  let statusChain: Promise<unknown> = Promise.resolve();
  const runStatusChange = (req: StatusChangeRequest): Promise<StatusChangeResult> => {
    const run = async (): Promise<StatusChangeResult> => {
      statusChangesRunning++;
      try {
        const res = await executeChild(statusChangeWorkflow, {
          workflowId: statusChangeChildId(threadId, statusSeq++),
          args: [{ threadId, ...req }],
          ...(saEnabled ? { typedSearchAttributes: [{ key: SA_TICKET_THREAD_ID, value: threadId }] } : {}),
        });
        if (res.applied && snap) {
          // Refresh the completion-relevant fields immediately; the next timer
          // scan reloads the full snapshot (reminder counters, recloseAt).
          snap.closed = res.closed;
          snap.closedAtMs = res.closed ? now() : null;
          snap.statusTagId = res.statusTagId;
          snap.statusLabel = res.statusLabel;
          snap.tagClosesThread = res.closesThread;
          snap.tagIsResolved = res.isResolved;
          snap.lastStatusChangeAtMs = now();
          snap.remindersPaused = false; // cleared on every status change (schema rule)
          if (!res.closed) snap.recloseAtMs = null;
          syncStatusSa(res.statusLabel);
        }
        return res;
      } finally {
        statusChangesRunning--;
        touch();
      }
    };
    const next = statusChain.then(run, run);
    statusChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  // ---- handlers (registered before the first activity so signal-with-start
  // deliveries are never dropped) ----

  setHandler(ticketCreatedSignal, (p: TicketCreatedSignal) => {
    creation = p;
    touch();
  });

  setHandler(humanMessageSignal, (p) => {
    if (snap?.exists && snap.closed && snap.tagClosesThread) {
      // Chatter in a closed thread: re-close after 30 quiet minutes; every
      // message pushes the deadline (DB stamp already written by the handler).
      snap.recloseAtMs = p.atMs + 30 * 60 * 1000;
    }
    touch();
  });

  setHandler(intercomEnqueueSignal, (p) => {
    enqueueIc(p.type, p.payload);
  });

  setHandler(remindersPausedSignal, (p) => {
    if (snap) snap.remindersPaused = p.paused;
    touch();
  });

  setHandler(requestStatusChangeSignal, (p) => {
    void runStatusChange(p).catch(() => {});
  });

  setHandler(noopSignal, () => {
    touch();
  });

  setHandler(applyStatusUpdate, async (req) => {
    try {
      const res = await runStatusChange(req);
      return { ok: res.applied, reason: res.reason };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  });

  setHandler(applyPriorityUpdate, async (req) => {
    try {
      await quick.applyPriorityStep({ ...req, threadId });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  setHandler(getStateQuery, () => ({ snapshot: snap, outbox: outbox.slice(0, 10), outboxDepth: outbox.length }));

  // ---- initial state ----

  snap = await quick.loadTicketState(threadId);
  hasIntercomLink = hasIntercomLink || snap.hasIntercomLink;
  // Also re-establishes ticketStatus after Continue-As-New without relying on
  // server-side attribute carry-over.
  syncStatusSa(snap.statusLabel);

  // ---- Intercom pump fiber: strictly one delivery child at a time per ticket
  // (per-ticket FIFO); its own fiber so a delivery retrying for hours never
  // delays reminders or signal handling. ----

  let pumpExited = false;
  const pump = async (): Promise<void> => {
    try {
      for (;;) {
        await condition(() => stopping || outbox.length > 0);
        if (stopping) return;
        if (!(await quick.intercomEnabled())) {
          // Leave events queued; draining resumes when the bridge is
          // re-enabled in /config (re-check every 30 minutes).
          await condition(() => stopping, PUMP_DISABLED_RECHECK_MS);
          if (stopping) return;
          continue;
        }
        // ensure-first invariant: never deliver content before the bridge
        // exists — synthesize an ensure head (payload composed at delivery).
        if (outbox[0].type !== "ensure" && !hasIntercomLink) {
          outbox.unshift({ seq: outboxSeq++, type: "ensure", payload: null });
        }
        const ev = outbox[0];
        let res: IntercomDeliveryResult;
        try {
          res = await executeChild(intercomDeliveryWorkflow, {
            workflowId: intercomDeliveryChildId(threadId, ev.seq),
            args: [{ threadId, event: ev }],
            ...(saEnabled ? { typedSearchAttributes: [{ key: SA_TICKET_THREAD_ID, value: threadId }] } : {}),
          });
        } catch (e) {
          // A delivery child can only fail like this on a non-retryable
          // orchestration error — drop the event rather than wedging the queue.
          res = { outcome: "dead", error: e instanceof Error ? e.message : String(e) };
        }
        if (ev.type === "ensure" && res.outcome === "ok") hasIntercomLink = true;
        outbox.shift();
        touch();
      }
    } finally {
      pumpExited = true;
      nudge = true;
    }
  };
  void pump();

  // ---- main loop: timers + creation + Continue-As-New + completion ----

  for (;;) {
    // Next wake: reminder/auto-close scan, exact re-close deadline, retention.
    let wake = Number.POSITIVE_INFINITY;
    if (snap.exists) {
      const remindable = !snap.closed || snap.tagIsResolved;
      if (remindable) wake = Math.min(wake, lastTimerCheckMs + TIMER_SCAN_MS);
      if (snap.recloseAtMs != null) wake = Math.min(wake, snap.recloseAtMs);
      if (snap.closed) {
        wake = Math.min(wake, Math.max(snap.closedAtMs ?? snap.lastStatusChangeAtMs, lastEventMs ?? 0) + RETENTION_MS);
      }
    }
    const timeoutMs = Number.isFinite(wake) ? Math.max(wake - now(), 1_000) : undefined;
    if (timeoutMs != null) await condition(() => nudge, timeoutMs);
    else await condition(() => nudge);
    nudge = false;

    // Ticket creation: enqueue the Intercom ensure and kick the auto-answer
    // child (or the plain staff ping) exactly once. (Read through a cast:
    // the assignment happens in a signal handler closure, invisible to CFA.)
    const c = creation as TicketCreatedSignal | null;
    if (c) {
      creation = null;
      if (snap.exists === false) snap = await quick.loadTicketState(threadId);
      syncStatusSa(snap.statusLabel);
      // Static UI context for the Temporal UI (ids only — no question text).
      // Gated like every SA command: upsertMemo emits a history command, so an
      // ungated call would replay-mismatch runs started before this release.
      if (saEnabled) upsertMemo({ categoryId: c.categoryId, aiSolve: c.aiSolve });
      enqueueIc("ensure", null);
      // aiSolve=false needs nothing here: the modal handler already pinged
      // staff inline (that path never left the interactive segment).
      if (c.aiSolve) {
        autoAnswerRunning = true;
        const handle = await startChild(autoAnswerWorkflow, {
          workflowId: autoAnswerChildId(threadId),
          args: [
            {
              threadId,
              categoryId: c.categoryId,
              question: c.question,
              customerId: c.customerId,
              displayName: c.displayName,
            },
          ],
          ...(saEnabled
            ? {
                typedSearchAttributes: [
                  { key: SA_TICKET_THREAD_ID, value: threadId },
                  { key: SA_AI_KIND, value: "auto_answer" },
                ],
              }
            : {}),
        });
        void handle
          .result()
          .catch(() => {})
          .finally(() => {
            autoAnswerRunning = false;
            nudge = true;
          });
      }
    }

    const busy = statusChangesRunning > 0 || autoAnswerRunning;

    // Continue-As-New before the 50k event limit — only at a drain point.
    if (
      (workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > HISTORY_SOFT_LIMIT) &&
      !busy &&
      (creation as TicketCreatedSignal | null) == null
    ) {
      stopping = true;
      await condition(() => pumpExited);
      await condition(allHandlersFinished);
      await continueAsNew<typeof ticketWorkflow>({
        threadId,
        carry: { outbox, outboxSeq, statusSeq, hasIntercomLink, lastEventMs },
      });
    }

    if (!snap.exists) {
      // Ticket row gone (or never loaded): once nothing is queued or running,
      // there is nothing left to own.
      if (outbox.length === 0 && !busy) break;
      // Signals may arrive for a row created after the start raced the write.
      snap = await quick.loadTicketState(threadId);
      if (!snap.exists) {
        await sleep(5_000);
        continue;
      }
      syncStatusSa(snap.statusLabel);
    }

    // Timer evaluation: the activity re-reads ticket + tag + Discord and does
    // exactly what the legacy schedulers did for this one ticket (reminder,
    // waiting-auto-close, resolved-auto-close, re-close with staleness guard).
    const tNow = now();
    const scanDue = (!snap.closed || snap.tagIsResolved) && tNow - lastTimerCheckMs >= TIMER_SCAN_MS;
    const recloseDue = snap.recloseAtMs != null && tNow >= snap.recloseAtMs;
    if (snap.exists && (scanDue || recloseDue) && statusChangesRunning === 0) {
      lastTimerCheckMs = tNow;
      try {
        const r = await timers.checkTicketTimers(threadId);
        snap = r.snapshot;
        hasIntercomLink = hasIntercomLink || r.snapshot.hasIntercomLink;
        syncStatusSa(snap.statusLabel);
        if (r.statusChange) void runStatusChange(r.statusChange).catch(() => {});
      } catch {
        // Evaluation failed (Discord hiccup) — the next scan retries.
      }
    }

    // Completion: closed, quiet past retention, outbox drained, nothing running.
    if (snap.exists && snap.closed && outbox.length === 0 && !busy) {
      const quietSince = Math.max(snap.closedAtMs ?? snap.lastStatusChangeAtMs, lastEventMs ?? 0);
      if (now() - quietSince >= RETENTION_MS) break;
    }
  }

  stopping = true;
  nudge = true;
  await condition(() => pumpExited);
  await condition(allHandlersFinished);
}
