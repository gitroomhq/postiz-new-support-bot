import type { BotConfig } from "../../../config";
import type { StripeClient } from "../../StripeClient";
import type { SessionStore } from "../../../auth/SessionStore";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { SessionManager } from "../SessionManager";
import type { PriceBook } from "../PriceBook";
import type { AdminAudit } from "../AdminAudit";
import type { DisputeStore } from "../DisputeStore";
import type { DisputeEvidenceService } from "../DisputeEvidenceService";
import type { BlockStore } from "../BlockStore";
import type { BlockService } from "../BlockService";
import type { EvidencePackBuilder } from "../evidence/EvidencePackBuilder";
import type { AutoResolveStore } from "../AutoResolveStore";
import type { BillingQolStore } from "../BillingQolStore";
import type { CachedRatioEngine } from "../disputeRatio";
import type { ApprovalStore } from "../ApprovalStore";
import type { BillingActionService } from "../actions/BillingActionService";
import type { PostizIdentityService } from "../../../postiz/PostizIdentityService";

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
  // Shared evidence domain core (catalog/staging/files/submit/accept) — the
  // same instance backs the web dashboard's dispute workbench.
  disputeEvidence: DisputeEvidenceService;
  blockStore: BlockStore;
  blockService: BlockService;
  qolStore: BillingQolStore;
  ratio: CachedRatioEngine;
  // Deterministic evidence packs: the template corpus interpolated with real
  // Stripe, platform and support facts. No model is involved.
  evidencePack: EvidencePackBuilder;
  // Auto-resolve proposals, for the veto button on the alert message.
  autoResolveStore?: AutoResolveStore | null;
  // The engine, for accepting a proposal from the alert.
  autoResolve?: {
    executeNow(rowId: string): Promise<{ executed: number; blocked: number; failed: number; superseded: number }>;
  } | null;
  // Intercom canvas/panel billing-action approvals (ApprovalsHub).
  approvalStore: ApprovalStore;
  billingActions: BillingActionService;
  // Platform account lookup. Optional: the panel works without it, just
  // without the non-Discord resolution path.
  postizIdentity?: PostizIdentityService;
}
