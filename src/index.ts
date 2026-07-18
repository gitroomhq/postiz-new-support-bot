import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { loadConfig } from "./config";
import { SettingsStore } from "./config/SettingsStore";
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
import { AgentRipMigration } from "./bot/AgentRipMigration";
import { KnowledgeBaseScheduler } from "./bot/KnowledgeBaseScheduler";
import { DiscordBot } from "./bot/DiscordBot";
import { ensureSchema } from "./db/ensureSchema";
import { verifySchema } from "./db/verifySchema";
import { HowToCategory, BugsCategory, BillingCategory } from "./categories";
import { IntercomClient } from "./intercom/IntercomClient";
import { IntercomStore } from "./intercom/IntercomStore";
import { IntercomSyncService } from "./intercom/IntercomSyncService";
import { IntercomEventExecutor } from "./intercom/IntercomEventExecutor";
import { IntercomWebhookHandler } from "./intercom/IntercomWebhookHandler";
import { IntercomInboxApp } from "./intercom/IntercomInboxApp";
import { InactivitySweeper } from "./intercom/InactivitySweeper";
import { initSentry, shutdownSentry, captureFatal, log, reconfigureSentry } from "./util/logger";
import { safe, setAiRecordContent } from "./util/instrument";
import { initInflux, reconfigureInflux, shutdownInflux } from "./metrics/InfluxWriter";
import { VaultService } from "./vault/VaultService";
import { VaultMigrator } from "./vault/VaultMigrator";
import { SnapshotScheduler } from "./metrics/SnapshotScheduler";
import { AiRunStore } from "./bot/AiRunStore";
import { LightAiRunner } from "./bot/LightAiRunner";
import { DisputeStore } from "./bot/billing/DisputeStore";
import { BlockStore } from "./bot/billing/BlockStore";
import { BillingQolStore } from "./bot/billing/BillingQolStore";
import { BlockService } from "./bot/billing/BlockService";
import { RefundCoreService } from "./bot/billing/RefundCoreService";
import { ApprovalStore } from "./bot/billing/ApprovalStore";
import { BillingActionService } from "./bot/billing/actions/BillingActionService";
import { PanelTokens } from "./intercom/panel/PanelTokens";
import { PanelSessions } from "./intercom/panel/PanelSessions";
import { IntercomPanel } from "./intercom/panel/IntercomPanel";
import { SlaRuleStore } from "./sla/SlaRuleStore";
import { SlaFactsLoader } from "./sla/facts";
import { SlaService } from "./sla/SlaService";
import { SlaSweeper } from "./intercom/SlaSweeper";
import { SlaEnforcer } from "./intercom/SlaEnforcer";
import { AssignmentService } from "./intercom/AssignmentService";
import { IntercomAdmin } from "./bot/IntercomAdmin";
import { AdminPanelTokens } from "./adminpanel/AdminPanelTokens";
import { AdminPanelSessions } from "./adminpanel/AdminPanelSessions";
import { AdminPanel } from "./adminpanel/AdminPanel";
import { AdminPanelDiscord } from "./adminpanel/AdminPanelDiscord";
import { DashboardTokens } from "./dashboard/DashboardTokens";
import { StandingDashboardAuth } from "./dashboard/DashboardAuth";
import { CredentialStore } from "./dashboard/auth/CredentialStore";
import { DashboardDbSessions } from "./dashboard/auth/DashboardDbSessions";
import { DashboardAudit } from "./dashboard/auth/DashboardAudit";
import { Dashboard } from "./dashboard/Dashboard";
import { DashboardDiscord } from "./dashboard/DashboardDiscord";
import { DashboardActionGateway } from "./dashboard/DashboardActions";
import { GlobalSearch } from "./dashboard/search/GlobalSearch";
import { HomeMetrics } from "./dashboard/metrics/HomeMetrics";
import { makeHomeSection } from "./dashboard/sections/homeSection";
import { makeBalancesSection } from "./dashboard/sections/balancesSection";
import { makeCustomersSection } from "./dashboard/sections/customersSection";
import { makePaymentsSection } from "./dashboard/sections/paymentsSection";
import { makeSubscriptionsSection } from "./dashboard/sections/subscriptionsSection";
import { makeInvoicesSection } from "./dashboard/sections/invoicesSection";
import { makeApprovalsSection } from "./dashboard/sections/approvalsSection";
import { makeSecuritySection } from "./dashboard/sections/securitySection";
import { GuildSnapshotProvider } from "./adminpanel/guildSnapshot";
import { generalHub } from "./adminpanel/sections/generalHub";
import { makeIntegrationsHub } from "./adminpanel/sections/integrationsHub";
import { makeAiAnalyticsHub } from "./adminpanel/sections/aiAnalyticsHub";
import { makeInfraHub } from "./adminpanel/sections/infraHub";
import { makeAuditBillingHub } from "./adminpanel/sections/auditBillingHub";
import { makeWorkflowHub } from "./adminpanel/sections/workflowHub";
import { makeAccessHub } from "./adminpanel/sections/accessHub";
import { makeDashboardHub } from "./adminpanel/sections/dashboardHub";
import { makeAutomationHub } from "./adminpanel/sections/automationHub";
import { makeBridgeHub } from "./adminpanel/sections/bridgeHub";
import { makeMaintenanceHub } from "./adminpanel/sections/maintenanceHub";
import { makeSlaHub } from "./adminpanel/sections/slaHub";
import { makeAssignmentHub } from "./adminpanel/sections/assignmentHub";
import { CachedRatioEngine } from "./bot/billing/disputeRatio";
import { DisputeMonitor } from "./bot/billing/DisputeMonitor";
import { TemporalService } from "./temporal/TemporalService";
import { TemporalWorkerManager } from "./temporal/TemporalWorkerManager";
import { TemporalProducers } from "./temporal/producers";
import { createActivities } from "./temporal/activities";
import { resolveBuildId } from "./temporal/buildId";

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

  // One-time agent-rip migration, DB phase — BEFORE settingsStore.load() so
  // the tag cache (closingTag, tagById) sees the resolved→closing flip from
  // the first instruction. Idempotent; re-runs until the Discord phase stamps
  // the flag after bot.start().
  const ripPhase1 = await AgentRipMigration.runDbPhase(prisma).catch((e) => {
    bootLog.error("agent-rip DB migration failed — continuing, retried next boot", e);
    return { migrated: false, tagsFlipped: 0 };
  });

  const sessionStore = new SessionStore(prisma);
  const settingsStore = new SettingsStore(prisma);
  await settingsStore.load();
  // DSN + knobs live in BotSettings (the deploy has no editable .env), so
  // Sentry can only come up after settings load. Auto-instrumentation still
  // works because `--require @sentry/node/preload` registered the require
  // hooks before any module loaded. Everything before this logs to stdout.
  initSentry(settingsStore.sentryConfig());
  setAiRecordContent(settingsStore.sentryAiRecordContent());
  // Vault comes up between Sentry (whose DSN is deliberately plaintext in the
  // DB, so error reporting never depends on Vault) and Influx (whose token may
  // live in Vault KV). init() is a bounded warm-up: a down Vault delays boot
  // by ≤5s and the bot starts degraded; the probe loop recovers it later.
  // AuditLogger moves up here because VaultService posts transition embeds
  // through it (it no-ops until the Discord client is bound below).
  const auditLogger = new AuditLogger(settingsStore);
  const vaultService = new VaultService(settingsStore, auditLogger);
  settingsStore.bindVault(vaultService);
  sessionStore.bindVault(vaultService);
  await vaultService.init();
  const vaultMigrator = new VaultMigrator(prisma, settingsStore, sessionStore, vaultService);
  // Temporal connection layer: certs come from the Vault KV cache (the
  // "temporal" integration entry), address/namespace from BotSettings via
  // /config → Temporal → Connection (env vars are first-boot fallbacks only —
  // the deploy has no .env access). init() is a bounded warm-up like Vault's —
  // a down/unconfigured Temporal means the probe loop keeps trying, never a
  // dead boot.
  const temporalService = new TemporalService(settingsStore, vaultService, auditLogger);
  const temporalProducers = new TemporalProducers(temporalService, settingsStore);
  await temporalService.init();
  temporalService.start();
  // On recovery: lift outage-fallback enc:v1 rows into Vault, then rebuild the
  // Influx exporter (its token resolves again once the KV cache is warm).
  // Under the Temporal regime the upgrade job runs as the vaultUpgradeWorkflow
  // (dedup by workflow id) instead of inline.
  vaultService.onRecovered(async () => {
    if (temporalProducers.enabled()) await temporalProducers.startVaultUpgrade();
    else await vaultMigrator.runUpgradeJob();
  });
  vaultService.onRecovered(() => reconfigureInflux(settingsStore.influxConfig()));
  // Certs may have (re)appeared with the recovered KV cache.
  vaultService.onRecovered(() => temporalService.reconfigure());
  vaultService.start();
  // Lift stragglers from a previous run (no-op when everything is clean).
  if (temporalProducers.enabled()) {
    safe(
      temporalProducers.startVaultUpgrade().then(() => undefined),
      "vault:upgrade"
    );
  } else {
    safe(vaultMigrator.runUpgradeJob(), "vault:upgrade");
  }
  // InfluxDB export follows the same DB-configured pattern; inert until the
  // /config → Analytics connection is complete and enabled.
  initInflux(settingsStore.influxConfig());
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
  const tierStore = new EscalationTierStore(prisma);
  await tierStore.load();
  if (await tierStore.seedFromLegacySupportRole(settingsStore.supportRoleId())) {
    bootLog.info("seeded escalation tier 1 from legacy support role");
  }
  const ticketStore = new TicketStore(prisma);
  const intercomStore = new IntercomStore(prisma);
  const intercomClient = new IntercomClient(settingsStore);
  const intercomSync = new IntercomSyncService(settingsStore, intercomStore, sessionStore, ticketStore);
  // Shared Intercom API executor: the Temporal delivery activity and the
  // sync service's unconfigured-bootstrap direct fallback both delegate to
  // this one instance (shared caches).
  const intercomExecutor = new IntercomEventExecutor(
    intercomClient,
    intercomStore,
    settingsStore,
    ticketStore,
    intercomSync,
    auditLogger
  );
  intercomSync.setExecutor(intercomExecutor);
  const aiRunStore = new AiRunStore(prisma);
  const statusService = new StatusService(ticketStore, auditLogger, settingsStore, intercomSync);
  const intercomWebhookHandler = new IntercomWebhookHandler(
    settingsStore,
    ticketStore,
    statusService,
    intercomStore,
    intercomSync,
    auditLogger,
    intercomClient
  );
  const oauthManager = new OAuthManager(config, sessionStore);
  // ClaudeCodeRunner + LightAiRunner survive the agent-rip for the dispute
  // console (evidence drafts + summaries in /billing → Disputes).
  const claudeRunner = new ClaudeCodeRunner(process.cwd(), aiRunStore, () => settingsStore.stripeSecretKey());
  const lightAiRunner = new LightAiRunner(aiRunStore);
  const kbScheduler = new KnowledgeBaseScheduler(settingsStore, process.cwd());
  const githubClient = new GitHubClient(config);
  const stripeClient = new StripeClient(config, settingsStore);
  // Dispute console: local dispute mirror, blocklist (+ Radar bridge), team
  // notes/bookmarks, the shared ratio cache and the looper tick body.
  const disputeStore = new DisputeStore(prisma);
  const blockStore = new BlockStore(prisma);
  const qolStore = new BillingQolStore(prisma);
  const blockService = new BlockService(settingsStore, stripeClient, blockStore);
  const ratioEngine = new CachedRatioEngine(stripeClient);
  const disputeMonitor = new DisputeMonitor(settingsStore, sessionStore, stripeClient, disputeStore, blockStore, ratioEngine);
  const stripeWebhookHandler = new StripeWebhookHandler(settingsStore, sessionStore, stripeClient, disputeStore, blockService);
  // Intercom canvas/panel billing actions: approval queue + the shared
  // Discord-independent action brain (levels re-checked per request).
  const approvalStore = new ApprovalStore(prisma);
  const refundCoreService = new RefundCoreService(stripeClient, sessionStore);
  const billingActionService = new BillingActionService(
    approvalStore,
    settingsStore,
    stripeClient,
    sessionStore,
    blockService,
    refundCoreService,
    intercomStore,
    ticketStore,
    intercomExecutor,
    auditLogger
  );
  const panelTokens = new PanelTokens(settingsStore);
  // Shared between the Stripe panel (web) and the Intercom canvas (M10 passcode).
  const panelSessions = new PanelSessions();
  const intercomPanel = new IntercomPanel(
    settingsStore,
    intercomStore,
    ticketStore,
    sessionStore,
    stripeClient,
    disputeStore,
    billingActionService,
    panelTokens,
    panelSessions
  );
  const billingAdmin = new BillingAdmin(config, stripeClient, sessionStore, settingsStore, auditLogger, {
    disputeStore,
    blockStore,
    blockService,
    qolStore,
    ratio: ratioEngine,
    claudeRunner,
    lightAiRunner,
    intercom: intercomClient,
    approvalStore,
    billingActions: billingActionService,
  });

  // Shared refund money-movement core: Discord self-service + /charge approve
  // and the Intercom canvas/panel all run this one idempotent path.
  const billingCategory = new BillingCategory(stripeClient, sessionStore, settingsStore, statusService, ticketStore, auditLogger, tierStore, blockStore, refundCoreService);
  const categoryRegistry = new CategoryRegistry()
    .register(new HowToCategory())
    .register(new BugsCategory())
    .register(billingCategory);

  // Temporal seams: with the regime active these services route their durable
  // side effects into workflows (signals/updates) instead of DB queues and
  // in-process chains; every call site stays untouched.
  statusService.setTemporalProducers(temporalProducers);
  intercomSync.setTemporalProducers(temporalProducers);
  intercomWebhookHandler.setTemporalProducers(temporalProducers);
  stripeWebhookHandler.setTemporalProducers(temporalProducers);
  billingCategory.setTemporalProducers(temporalProducers);

  // ---- SLA manager (rules → "SLA Target" conversation attribute; the
  // bot-native SlaEnforcer looper runs the clocks — Advanced tier has no
  // native SLAs) ----
  const slaRuleStore = new SlaRuleStore(prisma, settingsStore, () =>
    categoryRegistry.getAll().map((c) => ({ id: c.id, label: c.label }))
  );
  await slaRuleStore.load();
  const slaFactsLoader = new SlaFactsLoader(
    ticketStore,
    intercomStore,
    intercomClient,
    sessionStore,
    disputeStore,
    stripeClient,
    settingsStore
  );
  const slaService = new SlaService(
    prisma,
    settingsStore,
    slaRuleStore,
    slaFactsLoader,
    intercomStore,
    intercomClient,
    ticketStore,
    sessionStore,
    auditLogger,
    temporalProducers
  );
  slaRuleStore.setOnChange(() => slaService.onRulesChanged());
  intercomExecutor.setSlaService(slaService);
  statusService.setSlaService(slaService);
  stripeWebhookHandler.setSlaService(slaService);
  intercomWebhookHandler.setSlaService(slaService);
  sessionStore.setSlaHook((threadId) => slaService.onTicketTrigger(threadId, "refund_review"));

  // ---- Balanced assignment + bot-native SLA enforcement (Advanced tier:
  // native SLAs/workload management are gone — the bot owns both) ----
  const assignmentService = new AssignmentService(intercomClient, intercomStore, settingsStore, (fn) =>
    intercomExecutor.withAuthor(fn)
  );
  intercomExecutor.setAssignmentService(assignmentService);
  intercomWebhookHandler.setAssignmentService(assignmentService);
  const slaEnforcer = new SlaEnforcer(
    prisma,
    intercomClient,
    intercomStore,
    settingsStore,
    (fn) => intercomExecutor.withAuthor(fn),
    assignmentService
  );
  intercomWebhookHandler.setSlaEnforcer(slaEnforcer);

  // /intercom admin panel (bridge/SLA/automation/maintenance hubs).
  const intercomAdmin = new IntercomAdmin(
    settingsStore,
    tierStore,
    () => categoryRegistry.getAll().map((c) => ({ id: c.id, label: c.label })),
    ticketStore,
    intercomStore,
    intercomClient,
    intercomSync,
    intercomWebhookHandler,
    auditLogger,
    temporalProducers,
    slaRuleStore,
    slaService,
    assignmentService
  );

  // The bridge resolves category ids to their human labels via the registry
  // ("billing" → "💳 Billing" instead of the raw id in Intercom).
  const categoryLabelResolver = (id: string | null): string | null => {
    if (!id) return null;
    return categoryRegistry.getAll().find((c) => c.id === id)?.label ?? id;
  };
  intercomSync.setCategoryLabelResolver(categoryLabelResolver);
  // Human amounts in the refund-flip context note (zero-decimal aware).
  intercomSync.setAmountFormatter((amountMinor, currency) => stripeClient.formatAmount(amountMinor, currency));

  const intercomInboxApp = new IntercomInboxApp(
    settingsStore,
    intercomStore,
    ticketStore,
    sessionStore,
    stripeClient,
    categoryLabelResolver,
    billingActionService,
    panelTokens,
    panelSessions
  );

  const bot = new DiscordBot(
    config,
    settingsStore,
    ticketStore,
    statusService,
    sessionStore,
    oauthManager,
    githubClient,
    categoryRegistry,
    auditLogger,
    tierStore,
    intercomSync,
    intercomStore,
    intercomClient,
    intercomWebhookHandler,
    billingAdmin,
    kbScheduler,
    stripeWebhookHandler,
    intercomInboxApp,
    { service: vaultService, migrator: vaultMigrator },
    { blockService, stripeClient, disputeStore },
    intercomPanel,
    intercomAdmin
  );
  // The client exists as soon as the constructor ran; nothing fires before login.
  bot.setSlaService(slaService);
  auditLogger.bindClient(bot.client);
  billingActionService.bindClient(bot.client);
  intercomWebhookHandler.bindClient(bot.client);
  intercomInboxApp.bindClient(bot.client);
  stripeWebhookHandler.bindClient(bot.client);
  disputeMonitor.bindClient(bot.client);
  // Thread URLs need the guild id, only known once the client is ready —
  // resolved lazily per call.
  intercomSync.setThreadUrlBuilder((threadId) => {
    const guild = bot.client.guilds.cache.first();
    return guild ? `https://discord.com/channels/${guild.id}/${threadId}` : null;
  });
  // Current Discord identity for the Intercom contact refresh (name drift,
  // avatar) — resolved lazily per ensure.
  intercomSync.setCustomerInfoResolver(async (userId) => {
    const user = await bot.client.users.fetch(userId).catch(() => null);
    if (!user) return null;
    const guild = bot.client.guilds.cache.first();
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    return {
      displayName: member?.displayName ?? user.displayName ?? user.username,
      avatarUrl: user.displayAvatarURL({ extension: "png", size: 128 }),
    };
  });
  // Admin web panel (/config + /intercom) — mirrors the Stripe-panel pattern.
  // Built after `bot` because the guild snapshot reads bot.client (created in the
  // DiscordBot constructor). Bound in before start() so CallbackServer gets the
  // route and the adminpanel_* interactions dispatch. M0 ships the General hub.
  const adminPanelTokens = new AdminPanelTokens(settingsStore);
  const adminPanelSessions = new AdminPanelSessions();
  const guildSnapshot = new GuildSnapshotProvider(() => bot.client);
  // Temporal worker-pause is defined after bot.start(); hold it late-bound so the
  // infra hub's toggle can reach it at request time.
  const temporalControl: { setEnabled: ((on: boolean) => Promise<void>) | null } = { setEnabled: null };
  // Dashboard credential reset is defined after the dashboard stack below —
  // held late-bound so the Dashboard hub's action can reach it at request time.
  const dashboardOps: { resetCredentials: ((userId: string) => Promise<number>) | null } = { resetCredentials: null };
  const fmtReport = (r: unknown): string =>
    r && typeof r === "object" ? Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(", ") : String(r);
  const listIntercomAdmins = () => intercomClient.listAdmins().then((a) => a.map((x) => ({ id: x.id, name: x.name ?? x.id })));
  const runInactivityNow = async () => fmtReport(await temporalProducers.inactivityRunNow());
  const runSlaNow = async () => fmtReport(await temporalProducers.slaEnforceRunNow());
  const adminHubs = [
    generalHub,
    makeWorkflowHub({ tiers: tierStore }),
    makeIntegrationsHub({
      listIntercomAdmins,
      reconfigureSentry: async () => {
        const r = await reconfigureSentry(settingsStore.sentryConfig());
        switch (r.status) {
          case "started": return "Sentry started.";
          case "updated": return r.restartNeeded.length ? `Applied live; restart needed for: ${r.restartNeeded.join(", ")}.` : "Sentry updated live.";
          case "stopped": return "Sentry stopped (DSN cleared).";
          case "restart-required": return "Saved — a restart is required to apply the DSN change.";
          case "disabled": return "Sentry is disabled (no DSN set).";
        }
      },
    }),
    makeAiAnalyticsHub({ refreshKbNow: () => kbScheduler.refreshNow() }),
    makeInfraHub({
      vaultReconfigure: async () => { await vaultService.reconfigure(); return "Vault client reloaded."; },
      vaultMigrate: async () => fmtReport(await vaultMigrator.migrate()),
      vaultReverse: async () => fmtReport(await vaultMigrator.reverse()),
      setTemporalEnabled: async (on) => { if (temporalControl.setEnabled) await temporalControl.setEnabled(on); },
    }),
    makeAuditBillingHub({
      applyWebhook: async (on) => { if (on) await stripeWebhookHandler.ensureEndpoint(true); else await stripeWebhookHandler.disableEndpoint(); },
      registerWebhook: async () => { const r = await stripeWebhookHandler.ensureEndpoint(true); return r.detail ? `${r.status}: ${r.detail}` : r.status; },
      provisionRadar: async () => {
        const rows = await blockService.ensureRadarLists();
        return rows.map((x) => `${x.kind}: ${x.created ? "created" : x.listId ? "exists" : "failed"}${x.error ? ` (${x.error})` : ""}`).join("; ");
      },
    }),
    makeDashboardHub({ resetCredentials: (userId) => dashboardOps.resetCredentials?.(userId) ?? Promise.resolve(0) }),
    makeAccessHub({ listIntercomAdmins }),
    makeBridgeHub({ listTeams: () => intercomClient.listTeams(), listTags: () => intercomClient.listTags() }),
    makeSlaHub({ ruleStore: slaRuleStore }),
    makeAssignmentHub({ listTeams: () => intercomClient.listTeams(), listIntercomAdmins, runSlaNow }),
    makeAutomationHub({ runInactivityNow }),
    makeMaintenanceHub({
      resetBridgeData: async () => fmtReport(await intercomStore.resetAll()),
      runInactivityNow,
      runSlaNow,
    }),
  ];
  const adminPanel = new AdminPanel(settingsStore, adminPanelTokens, adminPanelSessions, guildSnapshot, adminHubs);
  const adminPanelDiscord = new AdminPanelDiscord(settingsStore, adminPanelTokens, adminPanelSessions);
  bot.bindAdminPanel({ panel: adminPanel, discord: adminPanelDiscord });

  // Stripe dashboard (/dashboard) — the account-wide web surface replacing
  // /billing over time. Third panel on the panelMount substrate. Standing auth:
  // passkey → passphrase → Discord DM activation, DB-backed 8h/3d sessions;
  // the Discord-minted link + passcode stays as break-glass/bootstrap.
  const dashboardTokens = new DashboardTokens(settingsStore);
  const dashboardCredentials = new CredentialStore(prisma);
  dashboardCredentials.bindVault(vaultService);
  const dashboardDbSessions = new DashboardDbSessions(prisma);
  const dashboardAudit = new DashboardAudit(prisma);
  const dashboardAuth = new StandingDashboardAuth(
    settingsStore,
    dashboardTokens,
    dashboardDbSessions,
    dashboardCredentials,
    dashboardAudit
  );
  dashboardOps.resetCredentials = (userId) => dashboardAuth.resetCredentials(userId);
  const dashboardGateway = new DashboardActionGateway(billingActionService, stripeClient, sessionStore);
  const dashboardStores = { session: sessionStore, dispute: disputeStore, block: blockStore, qol: qolStore };
  const dashboardMetrics = new HomeMetrics(stripeClient, settingsStore, disputeStore);
  const dashboardSections = [
    makeHomeSection({ metrics: dashboardMetrics }),
    makeBalancesSection(),
    makePaymentsSection(),
    makeCustomersSection(),
    makeSubscriptionsSection(),
    makeInvoicesSection(),
    makeApprovalsSection(),
    makeSecuritySection({ credentials: dashboardCredentials, sessions: dashboardDbSessions, audit: dashboardAudit }),
  ];
  const dashboard = new Dashboard(settingsStore, dashboardAuth, dashboardSections, {
    stripe: stripeClient,
    settings: settingsStore,
    stores: dashboardStores,
    billing: { actions: billingActionService, gateway: dashboardGateway },
    search: new GlobalSearch(stripeClient, dashboardStores),
    metrics: dashboardMetrics,
  });
  const dashboardDiscord = new DashboardDiscord(settingsStore, dashboardTokens, dashboardAuth);
  dashboardAuth.bindNotifier(dashboardDiscord);
  dashboardDiscord.bindClient(bot.client);
  bot.bindDashboard({ panel: dashboard, discord: dashboardDiscord });

  // --worker-only: log the Discord client in (activities need it) but skip
  // slash-command registration + the HTTP surface; the Temporal worker always
  // runs. This is the future split-deployment topology.
  const workerOnly = process.argv.includes("--worker-only");
  await bot.start({ workerOnly });

  // The callback server is listening now (bot.start() started it), so the Stripe
  // endpoint can point at a reachable URL. Idempotent + non-fatal.
  if (!workerOnly) {
    stripeWebhookHandler.ensureEndpoint().catch((e) => bootLog.error("stripe webhook registration failed", e));
  }

  // ---- Activity tick-providers (bodies driven by the Temporal loopers) ----

  // Influx gauge snapshot body for the metricsSnapshotWorkflow's snapshotTick.
  const snapshotScheduler = new SnapshotScheduler(prisma, settingsStore);
  // Workspace inactivity sweeper body (native/unbridged Intercom objects).
  const inactivitySweeper = new InactivitySweeper(intercomClient, intercomStore, settingsStore);
  // SLA safety-sweep body (slaSweepWorkflow's slaSweepTick).
  const slaSweeper = new SlaSweeper(intercomClient, intercomStore, settingsStore, slaService);

  // ---- Temporal worker (all background work lives in workflows) ----

  const workerManager = new TemporalWorkerManager(temporalService, resolveBuildId());
  const activities = createActivities({
    settingsStore,
    ticketStore,
    statusService,
    sessionStore,
    auditLogger,
    tierStore,
    intercomStore,
    intercomSync,
    intercomExecutor,
    intercomWebhookHandler,
    inactivitySweeper,
    slaSweeper,
    slaEnforcer,
    kbScheduler,
    snapshotScheduler,
    stripeWebhookHandler,
    billingCategory,
    disputeMonitor,
    vaultMigrator,
    client: bot.client,
    producers: temporalProducers,
  });

  // Worker pause switch (also the /config toggle handler). ON: reconcile
  // looper generations + ensure the baseline singletons BEFORE the worker
  // polls — a stale-generation terminate landing first means a bump deploy
  // never surfaces nondeterminism task failures — then start the worker.
  // OFF: drain the worker; background work pauses (fire-and-forget signals
  // keep landing server-side and process on resume; sync seams fall back to
  // their direct in-process paths).
  const setWorkerActive = async (enabled: boolean): Promise<void> => {
    if (enabled) {
      await temporalProducers.ensureBaseline().catch((e) => bootLog.error("temporal baseline setup failed", e));
      await workerManager.start(activities as unknown as Record<string, unknown>);
    } else {
      await workerManager.shutdown();
    }
  };
  temporalControl.setEnabled = setWorkerActive;

  bot.bindTemporal({
    producers: temporalProducers,
    service: temporalService,
    workerManager,
    setEnabled: setWorkerActive,
  });

  // Temporal was down during boot (or the worker failed to start): once it
  // recovers, reconcile the baseline and bring the worker up if it should be.
  temporalService.onRecovered(async () => {
    if (!workerOnly && settingsStore.temporalEnabled() && !workerManager.running()) {
      await setWorkerActive(true);
    }
  });

  if (workerOnly) {
    // Worker role only: poll regardless of the pause switch (the flag exists so
    // a future split can run workers while the bot process owns the switch).
    await workerManager.start(activities as unknown as Record<string, unknown>);
    bootLog.info("running in --worker-only mode");
  } else if (settingsStore.temporalEnabled()) {
    try {
      await setWorkerActive(true);
      bootLog.info("temporal worker active", { "temporal.build_id": resolveBuildId() });
    } catch (e) {
      // Running workflow timers continue server-side; producers buffer; the
      // onRecovered hook above starts the worker when Temporal comes back.
      bootLog.error("temporal worker failed to start — background work is paused until it recovers", e);
      void auditLogger.log({
        title: "⏱️ Temporal worker failed to start",
        severity: "warn",
        description:
          "temporalEnabled is on but the worker could not start (Vault certs missing or server unreachable). " +
          "Background processing is paused — it resumes automatically when the connection recovers.",
        fields: [{ name: "Error", value: (e instanceof Error ? e.message : String(e)).slice(0, 1024), inline: false }],
      });
    }
  } else {
    bootLog.warn("temporal worker paused (temporalEnabled off) — background work does not run until it is re-enabled");
  }

  // One-time agent-rip migration, Discord phase: lock+archive currently-
  // resolved threads and strip legacy title emojis. Fire-and-forget, paced,
  // idempotent; only the interactive process runs it (a split worker process
  // must not double-rename). Stamps agentRipMigratedAt when done.
  if (!workerOnly && !ripPhase1.migrated) {
    const ripMigration = new AgentRipMigration(prisma, settingsStore, bot.client, auditLogger);
    void ripMigration
      .runDiscordPhase(ripPhase1.tagsFlipped)
      .catch((e) => bootLog.error("agent-rip Discord migration failed — retried next boot", e));
  }

  // Graceful shutdown
  const shutdown = async () => {
    bootLog.info("shutting down");
    // Drain in-flight activities before tearing down the Discord client and
    // Prisma — activities use both.
    await workerManager.shutdown(15_000);
    await temporalService.shutdown();
    vaultService.stop();
    bot.client.destroy();
    // Flush the buffered Influx points before the DB/Sentry teardown.
    await shutdownInflux(2000);
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
