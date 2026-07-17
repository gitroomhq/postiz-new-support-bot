import type { SettingsStore } from "../config/SettingsStore";
import type { IntercomClient } from "./IntercomClient";
import type { IntercomStore } from "./IntercomStore";
import type { SlaSweepResult } from "../temporal/types";
import type { SlaService } from "../sla/SlaService";
import { log } from "../util/logger";

const sweepLog = log.child("sla:sweep");

// Politeness pacing after an actual Intercom WRITE (dedup makes most items
// zero-write, so a steady-state sweep runs at read speed).
const WRITE_SPACING_MS = 400;
// Backstop for a first run against a large workspace: stop writing after this
// many attribute PUTs and finish on later ticks. Logged when hit — never a
// silent cap.
const MAX_WRITES_PER_SWEEP = 100;

// SLA safety sweep: pages every open conversation in the workspace and
// re-runs the SLA rules against each — bridged via the linked thread id,
// native directly (when slaNativeEnabled). This is the convergence backstop
// behind the event triggers: it heals missed webhooks (unsubscribed Developer
// Hub topics), dead-lettered "sla" outbox events, mid-flight rule edits
// (mutations fire the runNow signal) and the refund exempt→mirrored flip
// edge. Per-item best-effort; SlaService's lastWrittenTarget dedup keeps
// unchanged subjects write-free.
export class SlaSweeper {
  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private slaService: SlaService
  ) {}

  // force = the /intercom "Run Now" button / rules-changed signal. Unlike the
  // inactivity sweeper, force does NOT bypass the enabled toggle — an SLA
  // attribute write is externally visible, so the toggle always gates; force
  // only annotates the reason for tracing.
  async sweep(force: boolean): Promise<SlaSweepResult> {
    const result: SlaSweepResult = { scanned: 0, written: 0, unchanged: 0, errors: 0, skipped: true };
    if (!this.settingsStore.intercomConfigured() || !this.settingsStore.slaEnabled()) return result;
    result.skipped = false;

    const nativeEnabled = this.settingsStore.slaNativeEnabled();
    let cursor: string | null = null;
    let writesCapped = false;

    do {
      const page = await this.client.searchOpenConversations(cursor);
      for (const conv of page.items) {
        result.scanned++;
        try {
          const link = await this.store.getLinkByConversationId(conv.id).catch(() => null);
          if (!link && !nativeEnabled) continue;
          const applied = link
            ? await this.slaService.applyForBridged(link.ticketThreadId, force ? "sweep:forced" : "sweep")
            : await this.slaService.applyForNative(conv.id, force ? "sweep:forced" : "sweep");
          if (applied.outcome === "written" || (applied.outcome === "pinned" && applied.reason !== "no change")) {
            result.written++;
            if (result.written >= MAX_WRITES_PER_SWEEP) {
              writesCapped = true;
              break;
            }
            await sleep(WRITE_SPACING_MS);
          } else if (applied.outcome === "error") {
            result.errors++;
          } else {
            result.unchanged++;
          }
        } catch (e) {
          result.errors++;
          sweepLog.warn("sla.sweep.item_failed", {
            "intercom.conversation_id": conv.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
      cursor = page.nextStartingAfter;
    } while (cursor && !writesCapped);

    if (writesCapped) {
      sweepLog.warn("sla.sweep.write_cap_hit", {
        "sla.sweep_write_cap": MAX_WRITES_PER_SWEEP,
        "sla.sweep_scanned": result.scanned,
      });
    }
    sweepLog.info("sla.sweep.completed", {
      "sla.sweep_scanned": result.scanned,
      "sla.sweep_written": result.written,
      "sla.sweep_unchanged": result.unchanged,
      "sla.sweep_errors": result.errors,
      "sla.sweep_forced": force,
    });
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
