# Postiz Support Bot

A Discord-first customer support bot for [Postiz](https://github.com/gitroomhq/postiz-app) (the open-source social-media scheduler). Each support request becomes a private Discord thread with emoji status/priority tags; an AI attempts a first answer, and staff manage the ticket lifecycle. It bridges tickets to Intercom and provides a full Stripe billing console (customer self-service refunds + a staff admin panel).

## How it works

- **Discord** (`discord.js` v14): the whole UI. Customers open tickets from a panel; staff use slash commands (`/status`, `/priority`, `/note`, `/reminders`, `/escalate`, `/canned`, `/charge`, `/billing`, `/search-tickets`, `/ai`, `/report`, `/config`, `/setup`).
- **AI answers** (`@anthropic-ai/claude-code` CLI): the bot spawns the `claude` CLI with its working directory set to `search/`, where the **Postiz source and docs are cloned** (`search/postiz-app`, `search/postiz-docs`). The model grounds answers by `Read`/`Glob`/`Grep`-ing that real code — there is no vector store. Models are configurable in `/config → AI & Knowledge`. A scheduler `git pull`s the clones periodically so answers track upstream. Staff `/ai` runs can additionally use a **read-only** Stripe MCP server and a customer-scoped read-only Postiz MCP. The tool-less `/ai summarize`/`draft` run on a cheaper model **via the direct Messages API** (`src/bot/LightAiRunner.ts` — no CLI spawn overhead).
- **AI ticket scoring** (`src/scoring/`): closed tickets are evaluated by a cheap model via the Anthropic **Message Batches API** (flat 50% discount + a prompt-cached rubric, ≈$0.005/ticket): CX score, customer sentiment, per-staff agent quality, resolution/FCR/escalation classification, and topic/root-cause tagging. Batches run on a `/config`-set interval (default every 6h); reopened tickets re-score after re-close; trivially short tickets are skipped. Surfaced via `/ai score`, an AI-quality section + drill-down in `/report`, and Grafana. Everything (enable, interval, model, batch size, daily budget cap, historical backfill) lives in `/config → Analytics`.
- **InfluxDB export** (`src/metrics/`): optional InfluxDB 2.x exporter for *everything* — ticket lifecycle events, response times, CSAT, AI usage & cost per run (also persisted to the `ai_runs` table), AI quality scores, billing events (refunds/discounts/charge reviews/disputes/fraud warnings), Intercom queue depths and periodic backlog gauges. Connection (url/org/bucket/token — token encrypted at rest) is set in `/config → Analytics`, which also offers a one-time historical backfill. Five ready-made Grafana dashboards live in `grafana/dashboards/`.
- **Intercom bridge** (`src/intercom/`): optional two-way sync (`none` / `push` / `bi`) of each Discord ticket to an Intercom conversation + customer ticket, with a durable outbox/inbox, echo-suppression, and a Canvas Kit inbox sidebar. HMAC-verified webhooks.
- **Stripe** (`src/bot/StripeClient.ts`, `BillingAdmin`, `src/bot/billing/`): customer self-service "refund & cancel" with guardrails (amount cap, per-24h velocity global + per-user, min membership age), plus a large staff `/billing` admin console. Dispute / early-fraud-warning **webhooks** are registered programmatically (no dashboard access needed) and alert staff.
- **Observability** (`@sentry/node`): errors, gen_ai spans, wide-event logs, and metrics. DSN and all knobs are set at runtime via `/config → Sentry`. The Sentry release is the 6-char git SHA — the same id as the Temporal worker deployment version.
- **Temporal** (`src/temporal/`): all background work can run on a self-hosted [Temporal](https://temporal.io) server instead of the legacy in-process `setInterval` schedulers — long-lived per-ticket workflows (reminders, auto-close, re-close, the Intercom outbox pump), per-conversation inbound workflows, looping singletons (KB refresh, scoring, snapshots, cleanup), a Schedule for the status report, and short workflows per Stripe event / refund / AI run. Toggled live via `/config → Temporal` (kill switch `temporalEnabled`); the one-time **Run Migration Import** starts workflows for existing open tickets and replays pending queue rows.

## Data model

Prisma + PostgreSQL (`prisma/schema.prisma`). The deploy environment can't run the Prisma CLI, so the app **creates/updates its own schema at boot** via idempotent `CREATE TABLE / ALTER TABLE ... IF NOT EXISTS` statements in `src/db/ensureSchema.ts`.

> **Any change to `schema.prisma` must be mirrored by hand in `ensureSchema.ts`** (and in the manifest in `src/db/verifySchema.ts`). On boot, `verifySchema` compares the live columns against that manifest and warns on drift — set `SCHEMA_DRIFT_STRICT=1` (dev/CI only) to make it throw instead.

## Runtime configuration

Almost everything is configured live through the admin-only **`/config`** panel and stored in a single `BotSettings` row — the deploy has **no editable `.env`**, so new settings must be `/config`-configurable rather than new env vars.

### Environment variables

**Required:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `STRIPE_SECRET_KEY`, `DATABASE_URL`. Also `ANTHROPIC_API_KEY` for the AI CLI.

**Optional** (feature-gating, or first-boot seeds that `/config` then owns): `DISCORD_THREADS_CHANNEL_ID`, `DISCORD_SUPPORT_ROLE_ID`, `POSTIZ_FRONTEND_URL`, `POSTIZ_API_URL`, `POSTIZ_CLIENT_ID`, `POSTIZ_CLIENT_SECRET`, `POSTIZ_CALLBACK_URL`, `GH_BOT_TOKEN`, `GH_BOT_REPO`, `STRIPE_DISCOUNT_COUPON_ID`, `SERVER_PORT` (default 3000), `SENTRY_DSN`, `INTERCOM_*`, `SCHEMA_DRIFT_STRICT`.

**Temporal** (all optional; the feature is gated by the `/config → Temporal` toggle): `TEMPORAL_ADDRESS` (`host:port` of the mTLS frontend), `TEMPORAL_NAMESPACE` (create it yourself on the server), `TEMPORAL_TASK_QUEUE` (default `support-bot`), `TEMPORAL_DEPLOYMENT_NAME` (default `support-bot`), `GIT_SHA` (build-id fallback for `.git`-less deploys).

### Temporal server prerequisites

- Self-hosted Temporal **≥ 1.28** with [Worker Deployment Versioning](https://docs.temporal.io/worker-deployments) enabled (dynamic config `system.enableDeploymentVersions: true`) and SQL visibility (for `CountWorkflowExecutions`).
- A dedicated namespace (retention ≥ 14 days recommended — ticket workflows stay open 14 days past close).
- mTLS client cert/key (+ optional CA) — entered via `/config → Temporal → Certificates`, stored in **Vault KV** under `<kvBasePath>/temporal` (no local fallback; Vault must be up). Cert rotation needs a Temporal off/on toggle or a restart.
- On every boot the worker registers its build (deployment `TEMPORAL_DEPLOYMENT_NAME`, build id = `git rev-parse --short=6 HEAD`) and **auto-promotes it to the deployment's Current Version**; re-deploying an older SHA re-promotes it (that's the rollback story). Workflows default to AUTO_UPGRADE.
- Rollout: deploy with the toggle OFF (legacy schedulers unchanged) → enter certs → **Test Connection** → toggle ON → **Run Migration Import** → verify in the Temporal UI + audit channel. The toggle is the kill switch back to legacy at any time.
- `--worker-only` runs a process that only polls the task queue (logs into Discord for activities, no commands/HTTP) — the future split topology.

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
