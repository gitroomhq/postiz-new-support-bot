import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { SettingsStore } from "../../config/SettingsStore";
import { StripeClient } from "../StripeClient";
import { BlockedEntity } from "../../generated/prisma/client";
import { BlockStore, normalizeBlockValue, type BlockKind } from "./BlockStore";
import { log } from "../../util/logger";

const blockLog = log.child("block-service");

export interface RadarListSpec {
  alias: string;
  name: string;
  itemType: Stripe.Radar.ValueListCreateParams.ItemType;
  settingsKey: "radarListCardId" | "radarListEmailId" | "radarListCustomerId" | "radarListIpId";
}

// One Radar value list per blockable identifier kind. The alias is what a
// Dashboard rule references (@alias) — treat it as a stable public name.
export const RADAR_LISTS: Record<BlockKind, RadarListSpec> = {
  card_fingerprint: {
    alias: "support_bot_blocked_card_fingerprints",
    name: "Support bot — blocked card fingerprints",
    itemType: "card_fingerprint",
    settingsKey: "radarListCardId",
  },
  email: {
    alias: "support_bot_blocked_emails",
    name: "Support bot — blocked emails",
    itemType: "email",
    settingsKey: "radarListEmailId",
  },
  customer_id: {
    alias: "support_bot_blocked_customers",
    name: "Support bot — blocked customers",
    itemType: "customer_id",
    settingsKey: "radarListCustomerId",
  },
  ip_address: {
    alias: "support_bot_blocked_ips",
    name: "Support bot — blocked IPs",
    itemType: "ip_address",
    settingsKey: "radarListIpId",
  },
};

export interface BlockEntry {
  kind: BlockKind;
  value: string;
}

export interface BlockOptions {
  reason: string;
  source: "manual" | "auto_dispute";
  actorId?: string | null;
  actorName?: string | null;
  customerId?: string | null;
  disputeId?: string | null;
  // customer_id entries also cancel every active subscription when true.
  cancelSubs: boolean;
}

export interface BlockResult {
  kind: BlockKind;
  value: string;
  ok: boolean;
  alreadyBlocked: boolean;
  error?: string;
  cancelledSubs?: string[];
  failedSubs?: string[];
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

// The bridge between the local blocklist (BlockStore) and Stripe Radar value
// lists. Shared by the /billing block flow, the webhook auto-block, and the
// /config provisioning button. Every step is individually idempotent so a
// Temporal activity retry or a double click converges instead of duplicating.
export class BlockService {
  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: BlockStore
  ) {}

  // Resolve (or create) the Radar value list for a kind, persisting the id.
  private async ensureListId(kind: BlockKind): Promise<string> {
    const spec = RADAR_LISTS[kind];
    const stored = this.settings.radarListId(kind);
    if (stored) return stored;
    const existing = await this.stripe.findValueListByAlias(spec.alias);
    const list = existing ?? (await this.stripe.createValueList(spec.alias, spec.name, spec.itemType, `radar-list-${spec.alias}`));
    await this.settings.updateRadarLists({ [spec.settingsKey]: list.id });
    return list.id;
  }

  // Provision all four lists (the /config button). Never throws — per-kind status.
  async ensureRadarLists(): Promise<Array<{ kind: BlockKind; alias: string; listId: string | null; created: boolean; error?: string }>> {
    const out: Array<{ kind: BlockKind; alias: string; listId: string | null; created: boolean; error?: string }> = [];
    for (const kind of Object.keys(RADAR_LISTS) as BlockKind[]) {
      const spec = RADAR_LISTS[kind];
      try {
        const had = this.settings.radarListId(kind) ?? (await this.stripe.findValueListByAlias(spec.alias))?.id ?? null;
        const listId = await this.ensureListId(kind);
        out.push({ kind, alias: spec.alias, listId, created: !had });
      } catch (error) {
        out.push({ kind, alias: spec.alias, listId: null, created: false, error: (error as Error).message });
      }
    }
    return out;
  }

  // Add one identifier to Radar (skip-if-present) and mirror it locally.
  private async blockOne(entry: BlockEntry, opts: BlockOptions): Promise<BlockResult> {
    const value = normalizeBlockValue(entry.kind, entry.value);
    const already = await this.store.getByKindValue(entry.kind, value);

    let radarItemId = already?.radarItemId ?? null;
    try {
      let listId = await this.ensureListId(entry.kind);
      if (!radarItemId) {
        const existingItem = await this.stripe.findValueListItem(listId, value);
        if (existingItem) {
          radarItemId = existingItem.id;
        } else {
          try {
            radarItemId = (await this.stripe.addValueListItem(listId, value, `radar-item-${entry.kind}-${sha1(value)}`)).id;
          } catch (error) {
            const code = (error as Stripe.errors.StripeError).code;
            if (code === "resource_missing") {
              // The stored list was deleted in the Dashboard — re-provision once.
              await this.settings.updateRadarLists({ [RADAR_LISTS[entry.kind].settingsKey]: null });
              listId = await this.ensureListId(entry.kind);
              radarItemId = (await this.stripe.addValueListItem(listId, value, `radar-item-${entry.kind}-${sha1(value)}`)).id;
            } else {
              // Duplicate-create races surface as invalid_request — re-check.
              const raced = await this.stripe.findValueListItem(listId, value);
              if (!raced) throw error;
              radarItemId = raced.id;
            }
          }
        }
      }
    } catch (error) {
      blockLog.warn("radar item creation failed", {
        "block.kind": entry.kind,
        "block.error": (error as Error).message,
      });
      return { kind: entry.kind, value, ok: false, alreadyBlocked: !!already, error: (error as Error).message };
    }

    await this.store.upsert({
      kind: entry.kind,
      value,
      reason: opts.reason,
      source: opts.source,
      actorId: opts.actorId ?? null,
      actorName: opts.actorName ?? null,
      customerId: opts.customerId ?? null,
      disputeId: opts.disputeId ?? null,
      radarItemId,
    });

    const result: BlockResult = { kind: entry.kind, value, ok: true, alreadyBlocked: !!already };
    if (entry.kind === "customer_id" && opts.cancelSubs) {
      const cancel = await this.stripe
        .cancelAllActiveSubscriptions(value, `block-cancel-${value}`)
        .catch((error) => {
          blockLog.warn("block sub-cancel failed", { "block.error": (error as Error).message });
          return { cancelled: [] as string[], failed: ["(lookup failed)"] };
        });
      result.cancelledSubs = cancel.cancelled;
      result.failedSubs = cancel.failed;
    }
    return result;
  }

  // Block a batch of identifiers; per-entry outcomes, never throws as a whole.
  async block(entries: BlockEntry[], opts: BlockOptions): Promise<BlockResult[]> {
    const results: BlockResult[] = [];
    for (const entry of entries) {
      results.push(await this.blockOne(entry, opts));
    }
    return results;
  }

  // Webhook auto-block: whatever identifiers the charge yields (fingerprint,
  // email, customer). Sub-cancellation is owned by the separate auto-cancel
  // toggle, so cancelSubs stays false here.
  async autoBlockFromCharge(chargeId: string, disputeId: string, customerId: string | null): Promise<BlockResult[]> {
    const ids = await this.stripe.getChargeBlockIdentifiers(chargeId);
    const entries: BlockEntry[] = [];
    if (ids.cardFingerprint) entries.push({ kind: "card_fingerprint", value: ids.cardFingerprint });
    if (ids.email) entries.push({ kind: "email", value: ids.email });
    const cus = ids.customerId ?? customerId;
    if (cus) entries.push({ kind: "customer_id", value: cus });
    if (entries.length === 0) return [];
    return this.block(entries, {
      reason: `Auto-block on dispute ${disputeId}`,
      source: "auto_dispute",
      customerId: cus,
      disputeId,
      cancelSubs: false,
    });
  }

  // Remove the Radar item (tolerating an already-deleted one) and the local row.
  async unblock(rowId: string): Promise<{ removed: BlockedEntity; radarRemoved: boolean } | null> {
    const row = await this.store.get(rowId);
    if (!row) return null;
    let radarRemoved = false;
    if (row.radarItemId) {
      try {
        await this.stripe.deleteValueListItem(row.radarItemId);
        radarRemoved = true;
      } catch (error) {
        const code = (error as Stripe.errors.StripeError).code;
        if (code !== "resource_missing") throw error; // real failure: keep the row so Radar and DB stay in sync
        radarRemoved = true;
      }
    }
    const removed = await this.store.remove(rowId);
    return removed ? { removed, radarRemoved } : null;
  }
}
