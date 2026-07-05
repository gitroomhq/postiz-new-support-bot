import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { loadConfig } from "./config";
import { SettingsStore } from "./config/SettingsStore";
import { CannedResponseStore } from "./config/CannedResponseStore";
import { EscalationTierStore } from "./config/EscalationTierStore";
import { SessionStore } from "./auth/SessionStore";
import { OAuthManager } from "./auth/OAuthManager";
import { PostizApiClient } from "./bot/PostizApiClient";
import { ClaudeCodeRunner } from "./bot/ClaudeCodeRunner";
import { GitHubClient } from "./bot/GitHubClient";
import { StripeClient } from "./bot/StripeClient";
import { BillingAdmin } from "./bot/BillingAdmin";
import { CategoryRegistry } from "./bot/CategoryRegistry";
import { TicketStore } from "./bot/TicketStore";
import { StatusService } from "./bot/StatusService";
import { AuditLogger } from "./bot/AuditLogger";
import { ReminderScheduler } from "./bot/ReminderScheduler";
import { RecloseScheduler } from "./bot/RecloseScheduler";
import { StatusReportService } from "./bot/StatusReportService";
import { StatusReportScheduler } from "./bot/StatusReportScheduler";
import { DiscordBot } from "./bot/DiscordBot";
import { ensureSchema } from "./db/ensureSchema";
import { HowToCategory, BugsCategory, BillingCategory } from "./categories";
import { IntercomClient } from "./intercom/IntercomClient";
import { IntercomStore } from "./intercom/IntercomStore";
import { IntercomSyncService } from "./intercom/IntercomSyncService";
import { IntercomOutboxScheduler } from "./intercom/IntercomOutboxScheduler";
import { IntercomWebhookHandler } from "./intercom/IntercomWebhookHandler";
import { IntercomInboxScheduler } from "./intercom/IntercomInboxScheduler";
import { IntercomInboxApp } from "./intercom/IntercomInboxApp";
import { initSentry } from "./util/logger";

async function main() {
  const config = loadConfig();
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  console.log("Connected to database");

  await ensureSchema(prisma);
  console.log("Schema ensured");

  const sessionStore = new SessionStore(prisma);
  const settingsStore = new SettingsStore(prisma);
  await settingsStore.load();
  // DSN lives in BotSettings (the deploy has no editable .env), so Sentry can
  // only come up after settings load. Everything before this logs to stdout.
  initSentry(settingsStore.sentryDsn());
  const cannedStore = new CannedResponseStore(prisma);
  await cannedStore.load();
  const tierStore = new EscalationTierStore(prisma);
  await tierStore.load();
  if (await tierStore.seedFromLegacySupportRole(settingsStore.supportRoleId())) {
    console.log("Seeded escalation tier 1 from legacy support role");
  }
  const ticketStore = new TicketStore(prisma);
  const auditLogger = new AuditLogger(settingsStore);
  const intercomStore = new IntercomStore(prisma);
  const intercomClient = new IntercomClient(settingsStore);
  const intercomSync = new IntercomSyncService(settingsStore, intercomStore, sessionStore, ticketStore);
  const statusService = new StatusService(ticketStore, auditLogger, settingsStore, intercomSync);
  const intercomWebhookHandler = new IntercomWebhookHandler(
    settingsStore,
    ticketStore,
    statusService,
    intercomStore,
    intercomSync,
    auditLogger
  );
  const oauthManager = new OAuthManager(config, sessionStore);
  const apiClient = new PostizApiClient(config);
  const claudeRunner = new ClaudeCodeRunner(process.cwd());
  const githubClient = new GitHubClient(config);
  const stripeClient = new StripeClient(config);
  const billingAdmin = new BillingAdmin(config, stripeClient, sessionStore, settingsStore, auditLogger);

  const categoryRegistry = new CategoryRegistry()
    .register(new HowToCategory())
    .register(new BugsCategory())
    .register(new BillingCategory(stripeClient, sessionStore, settingsStore, statusService, ticketStore, auditLogger, tierStore));

  // The bridge resolves category ids to their human labels via the registry
  // ("billing" → "💳 Billing" instead of the raw id in Intercom).
  const categoryLabelResolver = (id: string | null): string | null => {
    if (!id) return null;
    return categoryRegistry.getAll().find((c) => c.id === id)?.label ?? id;
  };
  intercomSync.setCategoryLabelResolver(categoryLabelResolver);

  const intercomInboxApp = new IntercomInboxApp(
    settingsStore,
    intercomStore,
    ticketStore,
    sessionStore,
    stripeClient,
    categoryLabelResolver
  );

  const reportService = new StatusReportService(settingsStore, ticketStore, categoryRegistry);

  const bot = new DiscordBot(
    config,
    settingsStore,
    ticketStore,
    statusService,
    sessionStore,
    oauthManager,
    apiClient,
    claudeRunner,
    githubClient,
    categoryRegistry,
    reportService,
    cannedStore,
    auditLogger,
    tierStore,
    intercomSync,
    intercomStore,
    intercomClient,
    intercomWebhookHandler,
    billingAdmin,
    intercomInboxApp
  );
  // The client exists as soon as the constructor ran; nothing fires before login.
  auditLogger.bindClient(bot.client);
  intercomWebhookHandler.bindClient(bot.client);
  intercomInboxApp.bindClient(bot.client);
  // Thread URLs need the guild id, only known once the client is ready —
  // resolved lazily per call.
  intercomSync.setThreadUrlBuilder((threadId) => {
    const guild = bot.client.guilds.cache.first();
    return guild ? `https://discord.com/channels/${guild.id}/${threadId}` : null;
  });
  await bot.start();

  const reminderScheduler = new ReminderScheduler(bot.client, settingsStore, ticketStore, statusService, auditLogger, tierStore);
  reminderScheduler.start();

  const statusReportScheduler = new StatusReportScheduler(bot.client, settingsStore, reportService);
  statusReportScheduler.start();

  const recloseScheduler = new RecloseScheduler(bot.client, ticketStore, auditLogger);
  recloseScheduler.start();

  const intercomOutboxScheduler = new IntercomOutboxScheduler(
    intercomClient,
    intercomStore,
    settingsStore,
    ticketStore,
    intercomSync,
    auditLogger
  );
  intercomOutboxScheduler.start();

  const intercomInboxScheduler = new IntercomInboxScheduler(intercomStore, intercomWebhookHandler, auditLogger);
  intercomInboxScheduler.start();

  // Clean expired pending auths every 5 minutes
  setInterval(() => sessionStore.cleanExpiredPending(), 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    reminderScheduler.stop();
    statusReportScheduler.stop();
    recloseScheduler.stop();
    intercomOutboxScheduler.stop();
    intercomInboxScheduler.stop();
    bot.client.destroy();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
