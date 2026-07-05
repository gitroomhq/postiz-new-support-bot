import type { BotConfig } from "../../../config";
import type { StripeClient } from "../../StripeClient";
import type { SessionStore } from "../../../auth/SessionStore";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { SessionManager } from "../SessionManager";
import type { PriceBook } from "../PriceBook";
import type { AdminAudit } from "../AdminAudit";

// Shared dependency bundle handed to every hub (and the target resolver).
export interface HubContext {
  config: BotConfig;
  stripe: StripeClient;
  sessions: SessionManager;
  priceBook: PriceBook;
  audit: AdminAudit;
  sessionStore: SessionStore;
  settingsStore: SettingsStore;
}
