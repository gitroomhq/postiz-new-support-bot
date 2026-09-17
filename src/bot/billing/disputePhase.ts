// The cutover phases for the two dispute pipelines. They are deliberately
// SEPARATE settings: writing evidence and refunding money are different risks,
// and an operator will reasonably want the evidence pipeline running on auto
// long before any refund fires without a human.
//
// Each phase is a superset of the one before it, so moving up never removes a
// capability, and moving back down is always safe.
export const DISPUTE_PHASES = ["none", "manual", "manualplus", "auto"] as const;
export type DisputePhase = (typeof DISPUTE_PHASES)[number];

export function isDisputePhase(v: string): v is DisputePhase {
  return (DISPUTE_PHASES as readonly string[]).includes(v);
}

const ORDER: Record<DisputePhase, number> = { none: 0, manual: 1, manualplus: 2, auto: 3 };

/** True when `phase` is at or above `atLeast`. */
export function phaseAtLeast(phase: DisputePhase, atLeast: DisputePhase): boolean {
  return ORDER[phase] >= ORDER[atLeast];
}

// EVIDENCE pipeline.
//   none        nothing happens
//   manual      a Build button exists in Discord and in the panel
//   manualplus  the pack is built and staged automatically when a dispute
//               arrives, and never submitted
//   auto        as manualplus, plus it submits itself near the deadline when
//               nobody has touched it and every gate passes
export const EVIDENCE_PHASE_LABELS: Record<DisputePhase, string> = {
  none: "Off",
  manual: "Manual: a Build button, nothing automatic",
  manualplus: "Manual plus: auto-build and stage, never submit",
  auto: "Auto: also submits near the deadline if untouched",
};

// RESOLVE pipeline (refund-to-prevent).
//   none        nothing happens
//   manual      only today's Refund to Prevent button; nothing is recorded
//   manualplus  proposals are recorded and alerted, and a human presses Execute
//   auto        proposals execute themselves once the veto window expires
export const RESOLVE_PHASE_LABELS: Record<DisputePhase, string> = {
  none: "Off",
  manual: "Manual: the Refund to Prevent button only",
  manualplus: "Manual plus: propose and alert, a human executes",
  auto: "Auto: executes after the veto window unless vetoed",
};

/** Evidence: may a pack be built and staged without being asked? */
export function autoStages(phase: DisputePhase): boolean {
  return phaseAtLeast(phase, "manualplus");
}

/** Evidence: may a pack submit itself to the bank? */
export function autoSubmits(phase: DisputePhase): boolean {
  return phase === "auto";
}

/** Resolve: should the engine evaluate and record proposals at all? */
export function proposes(phase: DisputePhase): boolean {
  return phaseAtLeast(phase, "manualplus");
}

/** Resolve: may a recorded proposal fire without a human pressing Execute? */
export function autoExecutes(phase: DisputePhase): boolean {
  return phase === "auto";
}
