import type { BotConfig } from "../../../config";
import type { StripeClient } from "../../StripeClient";
import type { SessionStore } from "../../../auth/SessionStore";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { SessionManager } from "../SessionManager";
import type { PriceBook } from "../PriceBook";
import type { AdminAudit } from "../AdminAudit";
import type { DisputeStore } from "../DisputeStore";
import type { BlockStore } from "../BlockStore";
import type { BlockService } from "../BlockService";
import type { BillingQolStore } from "../BillingQolStore";
import type { CachedRatioEngine } from "../disputeRatio";
import type { LightAiRunner } from "../../LightAiRunner";

// Shared dependency bundle handed to every hub (and the target resolver).
export interface HubContext {
  config: BotConfig;
  stripe: StripeClient;
  sessions: SessionManager;
  priceBook: PriceBook;
  audit: AdminAudit;
  sessionStore: SessionStore;
  settingsStore: SettingsStore;
  // Dispute console + blocklist + QoL (notes/bookmarks/watch) dependencies.
  disputeStore: DisputeStore;
  blockStore: BlockStore;
  blockService: BlockService;
  qolStore: BillingQolStore;
  ratio: CachedRatioEngine;
  lightAiRunner: LightAiRunner;
}
