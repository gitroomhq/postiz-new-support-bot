import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { SubscriptionEventStore } from "./SubscriptionEventStore";
import { classifySubscriptionEvent, type PreviousAttributes, type SubscriptionMovement } from "./subscriptionEvents";
import { planTagsFromSubscription, subscriptionMrrMinor } from "./segments";
import { emitSubscriptionEvent, exportPlanMix } from "../../metrics/MetricsExporter";
import { flushInflux, influxActive } from "../../metrics/InfluxWriter";
import { log } from "../../util/logger";

const subLog = log.child("subscription-events");

// Stripe retains events for ~30 days. Nothing reaches further back, so this is
// the hard ceiling on the replay, not a tuning knob.
const REPLAY_WINDOW_DAYS = 30;
const REPLAY_PAGE_SIZE = 100;
const REPLAY_MAX_PAGES = 400;
const REPLAY_FLUSH_EVERY = 200;

const LIFECYCLE_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

// Runaway guard on the plan-mix sweep. An account with more active
// subscriptions than this gets a truncated gauge rather than an unbounded walk.
const PLAN_MIX_MAX_PAGES = 50;

export interface SubscriptionReplayResult {
  scanned: number;
  movements: number;
  created: number;
  points: number;
  truncated: boolean;
}

export interface PlanMixResult {
  scanned: number;
  truncated: boolean;
  plans: Array<{ planTier: string; planPeriod: string; subscriptions: number; mrrMinor: number }>;
}

// The churn half of the money analytics: signups, plan changes and
// cancellations, as counts and as signed MRR movement.
//
// Deliberately NOT part of the money-out ledger. A cancellation moves no money
// on the day it happens — it removes future revenue — so folding the two
// together would count a refund-and-cancel as two separate losses. They are
// different questions and they live in different measurements.
export class SubscriptionEventService {
  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: SubscriptionEventStore
  ) {}

  coverage(): ReturnType<SubscriptionEventStore["coverage"]> {
    return this.store.coverage();
  }

  // ---- live path ----

  // One Stripe subscription webhook. Best-effort by construction: a metrics gap
  // must never fail webhook processing, because a throw here would make Stripe
  // redeliver an event whose other half already ran.
  async recordEvent(event: Stripe.Event): Promise<number> {
    if (!this.settings.subscriptionEventsEnabled()) return 0;
    const sub = event.data.object as Stripe.Subscription;
    const previous = (event.data.previous_attributes ?? null) as PreviousAttributes;
    const occurredAt = new Date(event.created * 1000);
    const movements = classifySubscriptionEvent(event.type, sub, previous, occurredAt);
    if (movements.length === 0) return 0;
    return this.persistAndEmit(event.id, "webhook", movements);
  }

  // ---- history replay ----

  // One-time import of the last 30 days of subscription events, so the churn
  // dashboard is not blank on the day it ships.
  //
  // Idempotent throughout: rows key on the Stripe event id plus the movement
  // name, and points carry each movement's real timestamp, so identical points
  // overwrite instead of double-counting. Running it twice is free.
  async replayHistory(onProgress?: () => void): Promise<SubscriptionReplayResult> {
    const result: SubscriptionReplayResult = {
      scanned: 0,
      movements: 0,
      created: 0,
      points: 0,
      truncated: false,
    };
    const createdGte = Math.floor((Date.now() - REPLAY_WINDOW_DAYS * 86_400_000) / 1000);
    let startingAfter: string | undefined;
    let sinceFlush = 0;

    for (let page = 0; page < REPLAY_MAX_PAGES; page++) {
      const { events, hasMore } = await this.stripe.listEventsByType({
        types: LIFECYCLE_EVENT_TYPES,
        createdGte,
        limit: REPLAY_PAGE_SIZE,
        ...(startingAfter ? { startingAfter } : {}),
      });
      onProgress?.();
      if (events.length === 0) break;

      for (const event of events) {
        result.scanned++;
        const sub = event.data.object as Stripe.Subscription;
        const previous = (event.data.previous_attributes ?? null) as PreviousAttributes;
        const movements = classifySubscriptionEvent(
          event.type,
          sub,
          previous,
          new Date(event.created * 1000)
        );
        if (movements.length === 0) continue;
        result.movements += movements.length;
        const emitted = await this.persistAndEmit(event.id, "replay", movements);
        result.created += emitted;
        result.points += emitted;
        sinceFlush += emitted;
        // The Influx client silently DROPS points once its 5000-line buffer
        // fills, which on a busy 30 days would quietly lose most of the import.
        if (sinceFlush >= REPLAY_FLUSH_EVERY) {
          sinceFlush = 0;
          await flushInflux();
        }
      }

      if (!hasMore) break;
      startingAfter = events[events.length - 1].id;
      if (page === REPLAY_MAX_PAGES - 1) result.truncated = true;
    }

    await flushInflux();
    await this.settings.updateSubscriptionEvents({ subscriptionReplayDoneAt: new Date() }).catch(() => undefined);
    return result;
  }

  // Rebuild the Influx series from the local mirror, at historical timestamps.
  // Needed exactly once, when Influx is switched on AFTER a replay already ran —
  // every other path emits inline as it writes.
  async reemitAll(onProgress?: () => void): Promise<number> {
    if (!influxActive()) return 0;
    let points = 0;
    let sinceFlush = 0;
    for await (const batch of this.store.iterateAll()) {
      onProgress?.();
      for (const row of batch) {
        emitSubscriptionEvent(row);
        points++;
        if (++sinceFlush >= REPLAY_FLUSH_EVERY) {
          sinceFlush = 0;
          await flushInflux();
        }
      }
    }
    await flushInflux();
    return points;
  }

  // ---- installed base ----

  // The plan-mix gauge. Churn counts mean nothing without it: ten cancellations
  // out of twenty customers and ten out of two thousand are not the same event,
  // and a chart that shows only the ten cannot tell them apart.
  async snapshotPlanMix(): Promise<PlanMixResult> {
    const byPlan = new Map<string, { planTier: string; planPeriod: string; subscriptions: number; mrrMinor: number }>();
    let scanned = 0;
    let truncated = true;
    let startingAfter: string | undefined;

    for (let page = 0; page < PLAN_MIX_MAX_PAGES; page++) {
      const { subscriptions, hasMore } = await this.stripe.listAllSubscriptions({
        status: "active",
        limit: 100,
        ...(startingAfter ? { startingAfter } : {}),
      });
      for (const sub of subscriptions) {
        scanned++;
        const plan = planTagsFromSubscription(sub);
        const key = `${plan.planTier}:${plan.planPeriod}`;
        const entry = byPlan.get(key) ?? {
          planTier: plan.planTier as string,
          planPeriod: plan.planPeriod as string,
          subscriptions: 0,
          mrrMinor: 0,
        };
        entry.subscriptions++;
        entry.mrrMinor += subscriptionMrrMinor(sub);
        byPlan.set(key, entry);
      }
      if (!hasMore || subscriptions.length === 0) {
        truncated = false;
        break;
      }
      startingAfter = subscriptions[subscriptions.length - 1].id;
    }

    for (const entry of byPlan.values()) exportPlanMix(entry);
    return { scanned, truncated, plans: [...byPlan.values()] };
  }

  // ---- shared ----

  // Write the movements, then emit a point for each one that was genuinely new.
  // Emitting only for new rows is what keeps a replay over ground already
  // covered silent instead of re-counting it.
  private async persistAndEmit(
    eventId: string,
    source: "webhook" | "replay",
    movements: SubscriptionMovement[]
  ): Promise<number> {
    // One Stripe event can carry several movements, so the row key is the event
    // id plus the movement name — unique per movement, stable across replays.
    const rows = movements.map((movement) => ({ id: `${eventId}:${movement.event}`, source, movement }));
    let fresh: Awaited<ReturnType<SubscriptionEventStore["insertNew"]>>;
    try {
      fresh = await this.store.insertNew(rows);
    } catch (error) {
      subLog.warn("subscription event write failed", {
        "stripe.event_id": eventId,
        "error.message": String(error),
      });
      return 0;
    }
    // From the PERSISTED rows, so this point and the one a rebuild produces
    // from the same row are identical rather than merely similar.
    for (const row of fresh) emitSubscriptionEvent(row);
    return fresh.length;
  }
}
