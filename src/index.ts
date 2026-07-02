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
import { CategoryRegistry } from "./bot/CategoryRegistry";
import { TicketStore } from "./bot/TicketStore";
import { StatusService } from "./bot/StatusService";
import { AuditLogger } from "./bot/AuditLogger";
import { ReminderScheduler } from "./bot/ReminderScheduler";
import { StatusReportService } from "./bot/StatusReportService";
import { StatusReportScheduler } from "./bot/StatusReportScheduler";
import { DiscordBot } from "./bot/DiscordBot";
import { ensureSchema } from "./db/ensureSchema";
import { HowToCategory, BugsCategory, BillingCategory } from "./categories";

async function main() {
  const config = loadConfig();

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  console.log("Connected to database");

  await ensureSchema(prisma);
  console.log("Schema ensured");

  const sessionStore = new SessionStore(prisma);
  const settingsStore = new SettingsStore(prisma);
  await settingsStore.load();
  const cannedStore = new CannedResponseStore(prisma);
  await cannedStore.load();
  const tierStore = new EscalationTierStore(prisma);
  await tierStore.load();
  if (await tierStore.seedFromLegacySupportRole(settingsStore.supportRoleId())) {
    console.log("Seeded escalation tier 1 from legacy support role");
  }
  const ticketStore = new TicketStore(prisma);
  const auditLogger = new AuditLogger(settingsStore);
  const statusService = new StatusService(ticketStore, auditLogger);
  const oauthManager = new OAuthManager(config, sessionStore);
  const apiClient = new PostizApiClient(config);
  const claudeRunner = new ClaudeCodeRunner(process.cwd());
  const githubClient = new GitHubClient(config);
  const stripeClient = new StripeClient(config);

  const categoryRegistry = new CategoryRegistry()
    .register(new HowToCategory())
    .register(new BugsCategory())
    .register(new BillingCategory(stripeClient, sessionStore, settingsStore, statusService, ticketStore, auditLogger, tierStore));

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
    tierStore
  );
  // The client exists as soon as the constructor ran; nothing fires before login.
  auditLogger.bindClient(bot.client);
  await bot.start();

  const reminderScheduler = new ReminderScheduler(bot.client, settingsStore, ticketStore, statusService, auditLogger, tierStore);
  reminderScheduler.start();

  const statusReportScheduler = new StatusReportScheduler(bot.client, settingsStore, reportService);
  statusReportScheduler.start();

  // Clean expired pending auths every 5 minutes
  setInterval(() => sessionStore.cleanExpiredPending(), 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    reminderScheduler.stop();
    statusReportScheduler.stop();
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
