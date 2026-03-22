import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { loadConfig } from "./config";
import { SessionStore } from "./auth/SessionStore";
import { OAuthManager } from "./auth/OAuthManager";
import { PostizApiClient } from "./bot/PostizApiClient";
import { ClaudeCodeRunner } from "./bot/ClaudeCodeRunner";
import { GitHubClient } from "./bot/GitHubClient";
import { StripeClient } from "./bot/StripeClient";
import { CategoryRegistry } from "./bot/CategoryRegistry";
import { DiscordBot } from "./bot/DiscordBot";
import { HowToCategory, BugsCategory, BillingCategory } from "./categories";
import { ThreadStore } from "./auth/ThreadStore";

async function main() {
  const config = loadConfig();

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  console.log("Connected to database");

  const sessionStore = new SessionStore(prisma);
  const threadStore = new ThreadStore(prisma);
  const oauthManager = new OAuthManager(config, sessionStore);
  const apiClient = new PostizApiClient(config);
  const claudeRunner = new ClaudeCodeRunner(process.cwd());
  const githubClient = new GitHubClient(config);
  const stripeClient = new StripeClient(config);

  const categoryRegistry = new CategoryRegistry()
    .register(new HowToCategory())
    .register(new BugsCategory())
    .register(new BillingCategory(stripeClient, sessionStore));

  const bot = new DiscordBot(config, sessionStore, oauthManager, apiClient, claudeRunner, githubClient, categoryRegistry, threadStore);
  await bot.start();

  // Clean expired pending auths every 5 minutes
  setInterval(() => sessionStore.cleanExpiredPending(), 5 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    bot.stop();
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
