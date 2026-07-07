import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { loadConfig } from "./config";
import { SettingsStore } from "./config/SettingsStore";
import { CannedResponseStore } from "./config/CannedResponseStore";
import { EscalationTierStore } from "./config/EscalationTierStore";
import { SessionStore } from "./auth/SessionStore";
import { OAuthManager } from "./auth/OAuthManager";
import { ClaudeCodeRunner } from "./bot/ClaudeCodeRunner";
import { GitHubClient } from "./bot/GitHubClient";
import { StripeClient } from "./bot/StripeClient";
import { StripeWebhookHandler } from "./bot/StripeWebhookHandler";
import { BillingAdmin } from "./bot/BillingAdmin";
import { CategoryRegistry } from "./bot/CategoryRegistry";
import { TicketStore } from "./bot/TicketStore";
import { StatusService } from "./bot/StatusService";
import { AuditLogger } from "./bot/AuditLogger";
import { ReminderScheduler } from "./bot/ReminderScheduler";
import { RecloseScheduler } from "./bot/RecloseScheduler";
import { StatusReportService } from "./bot/StatusReportService";
import { StatusReportScheduler } from "./bot/StatusReportScheduler";
import { KnowledgeBaseScheduler } from "./bot/KnowledgeBaseScheduler";
import { DiscordBot } from "./bot/DiscordBot";
import { ensureSchema } from "./db/ensureSchema";
import { verifySchema } from "./db/verifySchema";
import { HowToCategory, BugsCategory, BillingCategory } from "./categories";
import { IntercomClient } from "./intercom/IntercomClient";
import { IntercomStore } from "./intercom/IntercomStore";
import { IntercomSyncService } from "./intercom/IntercomSyncService";
import { IntercomOutboxScheduler } from "./intercom/IntercomOutboxScheduler";
import { IntercomWebhookHandler } from "./intercom/IntercomWebhookHandler";
import { IntercomInboxScheduler } from "./intercom/IntercomInboxScheduler";
import { IntercomInboxApp } from "./intercom/IntercomInboxApp";
import { initSentry, shutdownSentry, captureFatal, log } from "./util/logger";
import { setAiRecordContent, withTickSpan } from "./util/instrument";

const bootLog = log.child("bootstrap");

async function main() {
  const config = loadConfig();
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  bootLog.info("database connected");

  await ensureSchema(prisma);
  bootLog.info("schema ensured");

  const sessionStore = new SessionStore(prisma);
  const settingsStore = new SettingsStore(prisma);
  await settingsStore.load();
  // DSN + knobs live in BotSettings (the deploy has no editable .env), so
  // Sentry can only come up after settings load. Auto-instrumentation still
  // works because `--require @sentry/node/preload` registered the require
  // hooks before any module loaded. Everything before this logs to stdout.
  initSentry(settingsStore.sentryConfig());
  setAiRecordContent(settingsStore.sentryAiRecordContent());
  // Warn (or throw under SCHEMA_DRIFT_STRICT) if ensureSchema fell out of sync
  // with schema.prisma. Placed after initSentry so the warning reaches Sentry.
  // Strict (dev/CI, via an env var prod can't set) fails loudly; otherwise it
  // only logs so it can never brick a deploy.
  const schemaStrict = process.env.SCHEMA_DRIFT_STRICT === "1";
  try {
    await verifySchema(prisma, { strict: schemaStrict });
  } catch (e) {
    if (schemaStrict) throw e;
    bootLog.error("schema verification failed", e);
  }
  const cannedStore = new CannedResponseStore(prisma);
  await cannedStore.load();
  const tierStore = new EscalationTierStore(prisma);
  await tierStore.load();
  if (await tierStore.seedFromLegacySupportRole(settingsStore.supportRoleId())) {
    bootLog.info("seeded escalation tier 1 from legacy support role");
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
  const claudeRunner = new ClaudeCodeRunner(process.cwd());
  const kbScheduler = new KnowledgeBaseScheduler(settingsStore, process.cwd());
  const githubClient = new GitHubClient(config);
  const stripeClient = new StripeClient(config);
  const stripeWebhookHandler = new StripeWebhookHandler(settingsStore, sessionStore, stripeClient);
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
    kbScheduler,
    stripeWebhookHandler,
    intercomInboxApp
  );
  // The client exists as soon as the constructor ran; nothing fires before login.
  auditLogger.bindClient(bot.client);
  intercomWebhookHandler.bindClient(bot.client);
  intercomInboxApp.bindClient(bot.client);
  stripeWebhookHandler.bindClient(bot.client);
  // Thread URLs need the guild id, only known once the client is ready —
  // resolved lazily per call.
  intercomSync.setThreadUrlBuilder((threadId) => {
    const guild = bot.client.guilds.cache.first();
    return guild ? `https://discord.com/channels/${guild.id}/${threadId}` : null;
  });
  await bot.start();

  // The callback server is listening now (bot.start() started it), so the Stripe
  // endpoint can point at a reachable URL. Idempotent + non-fatal.
  stripeWebhookHandler.ensureEndpoint().catch((e) => bootLog.error("stripe webhook registration failed", e));

  const reminderScheduler = new ReminderScheduler(bot.client, settingsStore, ticketStore, statusService, auditLogger, tierStore);
  reminderScheduler.start();

  const statusReportScheduler = new StatusReportScheduler(bot.client, settingsStore, reportService);
  statusReportScheduler.start();

  const recloseScheduler = new RecloseScheduler(bot.client, ticketStore, auditLogger);
  recloseScheduler.start();

  // Periodically git-pull the cloned Postiz source/docs so AI answers track upstream.
  kbScheduler.start();

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

  // Clean expired pending auths + old Stripe webhook dedup rows every 5 minutes.
  setInterval(() => {
    withTickSpan("clean-pending-auths", () => sessionStore.cleanExpiredPending()).catch((e) =>
      log.child("scheduler:clean-pending").error("tick failed", e)
    );
    withTickSpan("clean-stripe-events", () => sessionStore.cleanOldStripeEvents()).catch((e) =>
      log.child("scheduler:clean-stripe-events").error("tick failed", e)
    );
  }, 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    bootLog.info("shutting down");
    reminderScheduler.stop();
    statusReportScheduler.stop();
    recloseScheduler.stop();
    kbScheduler.stop();
    intercomOutboxScheduler.stop();
    intercomInboxScheduler.stop();
    bot.client.destroy();
    await prisma.$disconnect();
    // Flush buffered events/spans/logs before the process dies.
    await shutdownSentry(2000);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (err) => {
  // Raw stderr (not console.*): the console bridge would double-capture, and
  // captureFatal below already reports + flushes the exception when Sentry is up.
  process.stderr.write(`Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  await captureFatal(err);
  process.exit(1);
});
