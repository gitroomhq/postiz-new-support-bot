import { defineQuery, defineSignal, defineUpdate } from "@temporalio/workflow";
import {
  SIG_DISPUTES_RUN_NOW,
  SIG_HUMAN_MESSAGE,
  SIG_INBOUND_EVENT,
  SIG_INTERCOM_CLEAR_OUTBOX,
  SIG_INTERCOM_ENQUEUE,
  SIG_KB_REFRESH_NOW,
  SIG_NOOP,
  SIG_REMINDERS_PAUSED,
  SIG_INACTIVITY_RUN_NOW,
  SIG_SLA_RUN_NOW,
  SIG_SLA_ENFORCE_RUN_NOW,
  SIG_REQUEST_STATUS_CHANGE,
  SIG_TICKET_CREATED,
  UPD_APPLY_STATUS,
  QRY_TICKET_STATE,
  type ApplyStatusResult,
  type HumanMessageSignal,
  type IcEvent,
  type IcEventType,
  type InboundEventSignal,
  type RemindersPausedSignal,
  type StatusChangeRequest,
  type TicketCreatedSignal,
  type TicketSnapshot,
} from "../types";

// Typed signal/update/query definitions. Names are shared string constants
// (types.ts) so Node-side producers can signal without importing this module.

export const ticketCreatedSignal = defineSignal<[TicketCreatedSignal]>(SIG_TICKET_CREATED);
export const humanMessageSignal = defineSignal<[HumanMessageSignal]>(SIG_HUMAN_MESSAGE);
export const intercomEnqueueSignal = defineSignal<[{ type: IcEventType; payload: unknown | null }]>(SIG_INTERCOM_ENQUEUE);
// Bridge reset/wipe: drop every queued (pre-wipe) Intercom event and forget the
// link — queued events would otherwise resurrect the data the operator wiped.
export const intercomClearOutboxSignal = defineSignal(SIG_INTERCOM_CLEAR_OUTBOX);
export const remindersPausedSignal = defineSignal<[RemindersPausedSignal]>(SIG_REMINDERS_PAUSED);
export const requestStatusChangeSignal = defineSignal<[StatusChangeRequest]>(SIG_REQUEST_STATUS_CHANGE);
export const noopSignal = defineSignal(SIG_NOOP);
export const inboundEventSignal = defineSignal<[InboundEventSignal]>(SIG_INBOUND_EVENT);
export const kbRefreshNowSignal = defineSignal(SIG_KB_REFRESH_NOW);
export const disputesRunNowSignal = defineSignal(SIG_DISPUTES_RUN_NOW);
export const inactivityRunNowSignal = defineSignal(SIG_INACTIVITY_RUN_NOW);
export const slaRunNowSignal = defineSignal(SIG_SLA_RUN_NOW);
export const slaEnforceRunNowSignal = defineSignal(SIG_SLA_ENFORCE_RUN_NOW);

export const applyStatusUpdate = defineUpdate<ApplyStatusResult, [StatusChangeRequest]>(UPD_APPLY_STATUS);

export const getStateQuery = defineQuery<{ snapshot: TicketSnapshot | null; outbox: IcEvent[]; outboxDepth: number }>(
  QRY_TICKET_STATE
);
