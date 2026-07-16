# Postiz Support Bot

A Discord-first customer support bot for [Postiz](https://github.com/gitroomhq/postiz-app) (the open-source social-media scheduler). Each support request becomes a private Discord thread that is bridged to Intercom, where agents work it — Discord is the customer's channel, Intercom is the agents'. The bot also runs the inactivity automation Intercom can't (reminders + auto-close for bridged tickets AND native workspace conversations), and provides a full Stripe billing console (customer self-service refunds + a staff admin panel). Refund-request tickets stay Discord-only (never mirrored).

## How it works

- **Discord** (`discord.js` v14): the customer UI + the Stripe-side staff tooling Intercom doesn't cover. Customers open tickets from a panel; the surviving slash commands are `/setup`, `/config`, `/search-tickets`, `/charge`, `/billing`. All other agent actions (status, notes, reminders, escalation, canned replies, AI assist, reports) were retired in the **agent-rip** release — agents work tickets in Intercom.
- **Dispute-evidence AI** (`@anthropic-ai/claude-code` CLI): `/billing → Disputes` drafts dispute evidence by spawning the `claude` CLI with its working directory set to `search/`, where the **Postiz source and docs are cloned** (`search/postiz-app`, `search/postiz-docs`) — policy text is grounded in real code/docs. The model + speed limits live in `/config → AI (dispute evidence)`; a scheduler refreshes the snapshots periodically (GitHub tarball download + atomic swap — the runtime image has no git binary). Short dispute summaries run on a cheaper model **via the direct Messages API** (`src/bot/LightAiRunner.ts`).
- **InfluxDB export** (`src/metrics/`): optional InfluxDB 2.x exporter for billing events (refunds/discounts/charge reviews/disputes/fraud warnings), dispute gauges, AI usage & cost per run (also persisted to the `ai_runs` table), Intercom bridge health (queue depths, webhook outcomes, inactivity sweeps) and a bot-health heartbeat. Connection (url/org/bucket/token — token encrypted at rest) is set in `/config → Analytics`. Grafana dashboards live in `grafana/dashboards/` (user-managed).
- **Intercom bridge** (`src/intercom/`): optional two-way sync (`none` / `push` / `bi`) of each Discord ticket to an Intercom conversation + customer ticket, with a durable outbox/inbox, echo-suppression, and a Canvas Kit inbox sidebar. HMAC-verified webhooks.
- **Stripe** (`src/bot/StripeClient.ts`, `BillingAdmin`, `src/bot/billing/`): customer self-service "refund & cancel" with guardrails (amount cap, per-24h velocity global + per-user, min membership age), plus a large staff `/billing` admin console. Dispute / early-fraud-warning **webhooks** are registered programmatically (no dashboard access needed) and alert staff.
- **Observability** (`@sentry/node`): errors, gen_ai spans, wide-event logs, and metrics. DSN and all knobs are set at runtime via `/config → Sentry`. The Sentry release is the 6-char git SHA — the same id as the Temporal worker deployment version.
- **Temporal** (`src/temporal/`): ALL background work runs on a self-hosted [Temporal](https://temporal.io) server — long-lived per-ticket workflows (reminders, auto-close, re-close, the Intercom outbox pump), per-conversation inbound workflows, looping singletons (KB refresh, snapshots, cleanup, disputes, the Intercom inactivity sweeper), and short workflows per Stripe event / refund. There is no legacy scheduler fallback anymore; `temporalEnabled` is a worker **pause** switch (`/config → Temporal`): OFF drains the worker and background work pauses — fire-and-forget signals keep landing server-side and process on resume, synchronous actions (status changes, refunds) fall back to direct in-process execution. Custom search attributes (`ticketThreadId`, `ticketStatus`, `conversationId`, `aiKind`) are registered automatically over the operator API and attached to starts once confirmed.
- **Inactivity automation**: Intercom's workflow triggers never fire on API-created conversations, so the bot owns reminders/auto-close for the whole workspace. Bridged tickets: per-status-tag settings (`/config → Workflow → Manage Tags`) — customer nags ping the customer in the Discord thread; agent nags post an internal note + reopen the Intercom conversation (unmirrored refund tickets fall back to a Discord staff-role ping). Native (unbridged) conversations/tickets: the `intercom-inactivity-loop` sweeper (`/config → Intercom → Inactivity`, ships OFF) — agent-idle notes, customer-idle outbound nags, auto-close after N unanswered nags (native tickets get notes only, never auto-close).

## Data model

Prisma + PostgreSQL (`prisma/schema.prisma`). The deploy environment can't run the Prisma CLI, so the app **creates/updates its own schema at boot** via idempotent `CREATE TABLE / ALTER TABLE ... IF NOT EXISTS` statements in `src/db/ensureSchema.ts`.

> **Any change to `schema.prisma` must be mirrored by hand in `ensureSchema.ts`** (and in the manifest in `src/db/verifySchema.ts`). On boot, `verifySchema` compares the live columns against that manifest and warns on drift — set `SCHEMA_DRIFT_STRICT=1` (dev/CI only) to make it throw instead.

## Runtime configuration

Almost everything is configured live through the admin-only **`/config`** panel and stored in a single `BotSettings` row — the deploy has **no editable `.env`**, so new settings must be `/config`-configurable rather than new env vars.

### Environment variables

**Required:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `STRIPE_SECRET_KEY`, `DATABASE_URL`. Also `ANTHROPIC_API_KEY` for the AI CLI.

**Optional** (feature-gating, or first-boot seeds that `/config` then owns): `DISCORD_THREADS_CHANNEL_ID`, `DISCORD_SUPPORT_ROLE_ID`, `POSTIZ_FRONTEND_URL`, `POSTIZ_API_URL`, `POSTIZ_CLIENT_ID`, `POSTIZ_CLIENT_SECRET`, `POSTIZ_CALLBACK_URL`, `GH_BOT_TOKEN`, `GH_BOT_REPO`, `STRIPE_DISCOUNT_COUPON_ID`, `SERVER_PORT` (default 3000), `SENTRY_DSN`, `INTERCOM_*`, `SCHEMA_DRIFT_STRICT`.

**Temporal**: the connection (address `host:port`, namespace, task queue, deployment name, TLS server-name/SNI override for dialing by IP) is edited live via **`/config → Temporal → Connection`** and stored in `BotSettings` — no env access needed. The `TEMPORAL_*` env vars exist only as optional first-boot fallbacks (like `INTERCOM_*`). The worker build id comes from `dist/temporal/buildInfo.json`, stamped by `pnpm build` with the git SHA — or, on a `.git`-less build machine, a content hash of `dist/` so every deploy still gets a unique id (`GIT_SHA` env remains a CI fallback; the panel flags a degenerate `x.y.z` id).

### Temporal server prerequisites

- Self-hosted Temporal **≥ 1.28** with [Worker Deployment Versioning](https://docs.temporal.io/worker-deployments) enabled (dynamic config `system.enableDeploymentVersions: true`) and SQL visibility (for `CountWorkflowExecutions`).
- A dedicated namespace (retention ≥ 14 days recommended — ticket workflows stay open 14 days past close).
- mTLS client cert/key (+ optional CA) — entered via `/config → Temporal → Certificates`, stored in **Vault KV** under `<kvBasePath>/temporal` (no local fallback; Vault must be up). Cert rotation needs a Temporal off/on toggle or a restart.
- On every boot the worker registers its build (deployment `TEMPORAL_DEPLOYMENT_NAME`, build id = the `buildInfo.json` stamp: git SHA, or a `dist/` content hash on `.git`-less builds) and **auto-promotes it to the deployment's Current Version**; re-deploying an older build re-promotes its id (that's the rollback story). Workflows default to AUTO_UPGRADE. **Never deploy from a dirty tree** — with git present the build id is the commit SHA, so a dirty deploy replays a different bundle under the previous version id (content-hash stamps don't have this problem).
- The bot registers its custom **search attributes** idempotently over the operator gRPC API on every connect (status line + `Ensure Search Attributes` button in the panel; `Test Connection` doubles as repair). The mTLS client identity therefore needs operator-API permission for `AddSearchAttributes`.
- `--worker-only` runs a process that only polls the task queue (logs into Discord for activities, no commands/HTTP) — the future split topology.

### Workflow compatibility policy (AUTO_UPGRADE, single in-process worker)

Every deploy replays running workflows against the new bundle — a changed command sequence wedges them with nondeterminism task failures. Rules:

- **Loopers** (`kb-refresh`, `metrics-snapshot`, `cleanup-loop`, `disputes-loop`, `intercom-inactivity-loop`): change their bodies freely, but bump the workflow's entry in `LOOPER_GENERATIONS` (`src/temporal/types.ts`) **in the same commit**. `ensureBaseline()` terminates a running singleton whose memo generation differs and starts a fresh run — safe because loopers are stateless between ticks.
- **Retiring a singleton/Schedule**: add it to `RETIRED_SINGLETONS` / `RETIRED_WORKFLOW_QUERIES` / `RETIRED_SCHEDULES` (`src/temporal/types.ts`) and remove it from `SINGLETONS` in the same commit — `ensureBaseline()` terminates/deletes retired ids on every boot before the worker polls (the agent-rip release retired `scoring-loop`, its `scoring-batch-*` children and the `status-report` Schedule this way). A retired id must never be re-added.
- **Stateful long-lived workflows** (`ticketWorkflow` — its outbox carries non-refetchable Discord payloads — and `intercomInboxWorkflow`): any change to the order/type of emitted commands (activities, timers, children) must use `patched('<id>')` dual-path code, removed only after all pre-change runs have completed or continued-as-new (ticket retention is 14 days past close ⇒ two releases minimum). Terminate is NOT acceptable for these.
- **Short workflows** (stripe/refund/AI/score/status children): same `patched()` rule when in-flight runs matter; the exposure window is only the seconds around a deploy.

**Rollback past the legacy-cleanup release**: in the Temporal UI terminate `scoring-loop` and any `scoring-batch-*` runs, redeploy the old SHA (auto re-promotes; its own `ensureSchema` recreates the dropped queue tables empty), then toggle `/config → Temporal` OFF→ON.

**Rollback past the agent-rip release**: replay-safe in both directions (the release shipped `ticket.workflow.ts` byte-identical; all timer changes are activity-side). The old build recreates `scoring-loop` + the `status-report` Schedule on boot; the new `intercom-inactivity-loop` wedges quietly under the old build (unknown type — terminate it in the UI if staying rolled back). NOT undone by rollback: resolved tags stay `closesThread=true` (the ✅ transition locks immediately under old code) and stripped thread titles re-decorate on the next status change. `agentRipMigratedAt` + `intercom_sweep_state` are unknown-extra columns to the old build (harmless; the flag also prevents a double sweep on re-deploy).

**Priority-removal release notes**: the `applyPriorityUpdate` handler left `ticketWorkflow` — replay-safe for clean histories (`setHandler` emits no commands). The only at-risk runs are ticketWorkflows started 2026-07-09→13 that actually received an `applyPriority` update: those wedge with a nondeterminism task failure on the first post-deploy replay — terminate the run in the Temporal UI, then use the ticket's Heal Message Gaps button to re-sync the mirror. Rollback past this release is safe: the old build re-registers the handler/stub and its `ensureSchema` recreates `priority_tags`/`priorityTagId` where missing. Post-deploy: click `/config → Intercom → Ensure Attributes` once (archives the stale "Priority" ticket attribute in Intercom), and confirm `conversation.priority.updated` is unsubscribed in the Developer Hub.

**Agent-rip follow-up release (N+1) checklist**: after this release proves out (DB backup first) — drop tables `canned_responses`, `ticket_scores`, `scoring_batches`, `ticket_ai_runs`, `ticket_notes`, `priority_tags` (priority CODE already fully removed in the priority-removal release; only the orphaned table/column DDL remains); drop `tickets.escalationTierId`/`priorityTagId` (+FKs), `remindersPaused`, `firstResponseAt`, `aiAnswer` (KEEP `reminderCount`/`lastReminderAt`/`recloseAt` — the timer engine lives); drop the `bot_settings` AI/scoring/report/sentry-read orphans (KEEP `aiModel`, `aiModelLight`, `aiEffortAsk`, `aiMaxBudgetUsdAsk` — dispute evidence; KEEP `reminderTarget` on status_tags — it doubles as the waiting-on-customer marker; KEEP `backfillDone`); mirror every drop in `ensureSchema.ts` (destructive-convergence block) + `verifySchema.ts`; remove the `aiRunWorkflow`/`scoreOneWorkflow`/`publishStatusReportWorkflow` tombstones + their activity stubs; remove the legacy `"priority"` skip case in `IntercomEventExecutor` + the skip-only `"priority"` members of `OutboxEventType`/`IcEventType` (safe once pre-removal outboxes have drained); remove `AgentRipMigration` + its `index.ts` wiring (the flag column stays); drop the `sentryReadToken` entry from the Vault secret registry together with its column.

**Active `patched()` ids**: `intercom-ensure-park` (ticketWorkflow pump: a dead ensure parks the queue instead of hot-looping) — introduced in the bi-mode hardening release; removable two releases later per the rule above.

> **Intercom webhook runbook**: while Temporal is down every `POST /intercom/webhook` answers 500 (deliberate — Intercom's retry redelivers). *Sustained* failures can make Intercom auto-disable the subscription with only an email notice; the bridge then stays inbound-dead after recovery. Alert on the `intercom_webhook` Influx measurement (`outcome=rejected` = bad/rotated client secret, Intercom does NOT retry 4xx; `outcome=error/buffered` = enqueue failures), and after any prolonged outage check Developer Hub → your app → Webhooks and re-enable the subscription if needed. The `/config → Intercom` panel shows the last verified inbound webhook.

> **Secrets at rest** (Postiz OAuth access tokens, Intercom credentials, the Stripe webhook signing secret) are encrypted with AES-256-GCM. The key is derived (HKDF) from `STRIPE_SECRET_KEY` + `DATABASE_URL` + `DISCORD_TOKEN`, so a database dump alone cannot decrypt them. Rotating any of those three orphans existing ciphertext (fail-soft: affected users re-auth / secrets are re-entered).

## Setup

```bash
pnpm install          # postinstall shallow-clones postiz-app + postiz-docs into search/
pnpm build            # prisma generate && tsc && workflow bundle (dist/temporal/workflow-bundle.js)
pnpm start            # node (with Sentry preload) dist/index.js
pnpm test             # unit tests (node:test)
pnpm test:temporal    # opt-in Temporal time-skipping integration tests (downloads a test server binary)
# dev: pnpm dev       # ts-node
```

`DATABASE_URL` must point at a PostgreSQL database; the app ensures its own schema on boot. An externally reachable URL (`POSTIZ_CALLBACK_URL` origin, or `/config → Billing → Webhooks → Set Public URL`) is needed for the Postiz OAuth callback, Intercom webhooks, and Stripe webhooks.

## Layout

```
src/
├── index.ts            # bootstrap / dependency wiring
├── config/             # loadConfig + SettingsStore (BotSettings) + canned/escalation stores
├── auth/               # Postiz OAuth + SessionStore
├── bot/                # DiscordBot (core), ClaudeCodeRunner, StripeClient, billing/, schedulers, TicketStore…
├── categories/         # customer ticket categories (How-To, Bugs, Billing)
├── intercom/           # two-way Intercom bridge
├── mcp/                # read-only Stripe MCP server (spawned for /ai)
├── metrics/            # InfluxDB writer + exporters + snapshot scheduler
├── scoring/            # AI ticket scoring (Batch API pipeline + scheduler)
├── server/             # Express callback + webhook server
├── temporal/           # Temporal platform (service/worker/producers) + workflows/ + activities/
├── db/                 # ensureSchema + verifySchema
└── util/               # embeds, logger (Sentry), crypto, instrument
grafana/dashboards/     # 5 importable Grafana dashboards (InfluxDB 2.x / Flux)
```
