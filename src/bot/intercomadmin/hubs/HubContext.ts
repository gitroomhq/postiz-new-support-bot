import type { Client, ThreadChannel } from "discord.js";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { EscalationTierStore } from "../../../config/EscalationTierStore";
import type { TicketStore } from "../../TicketStore";
import type { AuditLogger } from "../../AuditLogger";
import type { IntercomStore } from "../../../intercom/IntercomStore";
import type { IntercomClient } from "../../../intercom/IntercomClient";
import type { IntercomSyncService } from "../../../intercom/IntercomSyncService";
import type { IntercomWebhookHandler } from "../../../intercom/IntercomWebhookHandler";
import type { TemporalProducers } from "../../../temporal/producers";
import type { SlaRuleStore } from "../../../sla/SlaRuleStore";
import type { SlaService } from "../../../sla/SlaService";
import type { BridgeSourceMessage } from "../../../intercom/IntercomSyncService";
import type { SessionManager } from "../SessionManager";

// Late-bound Discord surface: the client (and the thread-history fetcher that
// lives on DiscordBot) exist only after the bot is constructed.
export interface DiscordBinding {
  client: Client;
  fetchAllThreadMessages: (thread: ThreadChannel) => Promise<BridgeSourceMessage[]>;
}

// Shared dependency bundle handed to every /intercom hub.
export interface HubContext {
  settingsStore: SettingsStore;
  tierStore: EscalationTierStore;
  categories: () => Array<{ id: string; label: string }>;
  ticketStore: TicketStore;
  intercomStore: IntercomStore;
  intercomClient: IntercomClient;
  intercomSync: IntercomSyncService;
  intercomWebhook: IntercomWebhookHandler;
  producers: TemporalProducers;
  slaRules: SlaRuleStore;
  slaService: SlaService;
  sessions: SessionManager;
  auditLogger: AuditLogger;
  // "⚙️ Config updated" embed, same shape as DiscordBot.auditConfig.
  auditConfig: (interaction: { user: { displayName: string; displayAvatarURL(): string } }, change: string) => void;
  discord: () => DiscordBinding | null;
}
