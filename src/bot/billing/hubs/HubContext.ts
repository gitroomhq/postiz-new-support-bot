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
import type { ClaudeCodeRunner } from "../../ClaudeCodeRunner";
import type { LightAiRunner } from "../../LightAiRunner";
import type { IntercomClient } from "../../../intercom/IntercomClient";
import type { ApprovalStore } from "../ApprovalStore";
import type { BillingActionService } from "../actions/BillingActionService";

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
  // Evidence drafting runs on the Claude Code CLI (Read/Glob/Grep over the
  // cloned Postiz source + docs) so policy fields can cite real terms.
  claudeRunner: ClaudeCodeRunner;
  // Evidence REVIEW runs tool-less on the cheap model (aiModelLight) — the
  // staged text plus the evidence files as vision/document blocks.
  lightAi: LightAiRunner;
  // Customer support history for the evidence draft (customer_communication
  // material). Reads no-op gracefully when the bridge is off.
  intercom: IntercomClient;
  // Intercom canvas/panel billing-action approvals (ApprovalsHub).
  approvalStore: ApprovalStore;
  billingActions: BillingActionService;
}
