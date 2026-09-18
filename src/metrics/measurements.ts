// Which Influx measurements can be rebuilt from Postgres, and which cannot.
//
// This is the list the analytics rebuild deletes. Getting an entry wrong is
// expensive in exactly one of two directions, and both are silent:
//
//   A measurement wrongly listed as REBUILDABLE is deleted and then not fully
//   restored — history destroyed, with nothing to restore it from.
//
//   A measurement wrongly listed as FIXED survives the wipe while its mirror is
//   re-emitted around it, so the bucket ends up holding both the old points and
//   the new ones.
//
// So the two lists are exhaustive over everything the exporter writes, and
// `rebuildMeasurements.test.ts` proves it by parsing MetricsExporter.ts: adding
// a measurement without classifying it fails the build rather than discovering
// itself during a wipe.

// Backed by a Postgres mirror that holds every field and tag of the point, so
// the series can be reconstructed exactly. The mirror is named for each one
// because "can this be rebuilt" is really the question "from what".
export const REBUILDABLE_MEASUREMENTS = [
  "money_out", //             StripeMoneyOut
  "dispute_outcomes", //      StripeDispute (terminal rows)
  "subscription_events", //   StripeSubscriptionEvent
  "dispute_event", //         DisputeEvent
  "dispute_auto_resolve", //  DisputeAutoResolve
  "ai_runs", //               AiRun
] as const;

// Everything else. Two kinds, both un-rebuildable for the same underlying
// reason — nothing durable records the individual point:
//
//   GAUGES sampled on a timer (bot_health, plan_mix, sla_enforce, …). The
//   series IS the history; Postgres holds only the current value.
//
//   COUNTERS with no mirror. billing_events is the important one: 43 call sites
//   recording who did what from where, and billing_actions stores only a
//   dedup key, not the event. dispute_evidence_pack / _source / pack_build /
//   dispute_response are per-build measurements whose inputs are not retained.
//
// These are never deleted, so their history survives a rebuild untouched.
export const FIXED_MEASUREMENTS = [
  "billing_events",
  "plan_mix",
  "dispute_snapshot",
  "dispute_modes",
  "dispute_evidence_pack",
  "dispute_pack_build",
  "dispute_evidence_source",
  "dispute_response",
  "money_out_sweep",
  "sla_enforce",
  "ticket_snapshot_totals",
  "intercom_queue",
  "intercom_webhook",
  "bot_health",
  "vault_health",
] as const;

export type RebuildableMeasurement = (typeof REBUILDABLE_MEASUREMENTS)[number];

const REBUILDABLE_SET: ReadonlySet<string> = new Set(REBUILDABLE_MEASUREMENTS);

export function isRebuildable(measurement: string): boolean {
  return REBUILDABLE_SET.has(measurement);
}
