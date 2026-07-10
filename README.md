# Postiz Support Bot

A Discord-first customer support bot for [Postiz](https://github.com/gitroomhq/postiz-app) (the open-source social-media scheduler). Each support request becomes a private Discord thread with emoji status/priority tags; an AI attempts a first answer, and staff manage the ticket lifecycle. It bridges tickets to Intercom and provides a full Stripe billing console (customer self-service refunds + a staff admin panel).

## How it works

- **Discord** (`discord.js` v14): the whole UI. Customers open tickets from a panel; staff use slash commands (`/status`, `/priority`, `/note`, `/reminders`, `/escalate`, `/canned`, `/charge`, `/billing`, `/search-tickets`, `/ai`, `/report`, `/config`, `/setup`).
- **AI answers** (`@anthropic-ai/claude-code` CLI): the bot spawns the `claude` CLI with its working directory set to `search/`, where the **Postiz source and docs are cloned** (`search/postiz-app`, `search/postiz-docs`). The model grounds answers by `Read`/`Glob`/`Grep`-ing that real code — there is no vector store. Models are configurable in `/config → AI & Knowledge`. A scheduler refreshes those snapshots periodically (GitHub tarball download + atomic swap — the runtime image has no git binary) so answers track upstream. Staff `/ai` runs can additionally use a **read-only** Stripe MCP server and a customer-scoped read-only Postiz MCP. The tool-less `/ai summarize`/`draft` run on a cheaper model **via the direct Messages API** (`src/bot/LightAiRunner.ts` — no CLI spawn overhead).
- **AI ticket scoring** (`src/scoring/`): closed tickets are evaluated by a cheap model via the Anthropic **Message Batches API** (flat 50% discount + a prompt-cached rubric, ≈$0.005/ticket): CX score (with a stored one-sentence rationale), customer sentiment, per-staff agent quality, resolution/FCR/escalation classification, and topic/root-cause tagging; precomputed response/resolution timings feed the rubric. Batches run on a `/config`-set interval (default every 6h); reopened tickets re-score after re-close; trivially short tickets are skipped. Surfaced via `/ai score` (which also shows queued-in-batch state), an AI-quality section + drill-down in `/report`, and Grafana. Everything (enable, interval, model, batch size, daily budget cap, historical backfill, and a live view of the in-flight batch) lives in `/config → Analytics`.
- **InfluxDB export** (`src/metrics/`): optional InfluxDB 2.x exporter for *everything* — ticket lifecycle events, response times, CSAT, AI usage & cost per run (also persisted to the `ai_runs` table), AI quality scores, billing events (refunds/discounts/charge reviews/disputes/fraud warnings), Intercom queue depths and periodic backlog gauges. Connection (url/org/bucket/token — token encrypted at rest) is set in `/config → Analytics`, which also offers a one-time historical backfill. Five ready-made Grafana dashboards live in `grafana/dashboards/`.
- **Intercom bridge** (`src/intercom/`): optional two-way sync (`none` / `push` / `bi`) of each Discord ticket to an Intercom conversation + customer ticket, with a durable outbox/inbox, echo-suppression, and a Canvas Kit inbox sidebar. HMAC-verified webhooks.
- **Stripe** (`src/bot/StripeClient.ts`, `BillingAdmin`, `src/bot/billing/`): customer self-service "refund & cancel" with guardrails (amount cap, per-24h velocity global + per-user, min membership age), plus a large staff `/billing` admin console. Dispute / early-fraud-warning **webhooks** are registered programmatically (no dashboard access needed) and alert staff.
- **Observability** (`@sentry/node`): errors, gen_ai spans, wide-event logs, and metrics. DSN and all knobs are set at runtime via `/config → Sentry`. The Sentry release is the 6-char git SHA — the same id as the Temporal worker deployment version.
- **Temporal** (`src/temporal/`): ALL background work runs on a self-hosted [Temporal](https://temporal.io) server — long-lived per-ticket workflows (reminders, auto-close, re-close, the Intercom outbox pump), per-conversation inbound workflows, looping singletons (KB refresh, scoring with per-batch child workflows, snapshots, cleanup), a Schedule for the status report, and short workflows per Stripe event / refund / AI run / manual score. There is no legacy scheduler fallback anymore; `temporalEnabled` is a worker **pause** switch (`/config → Temporal`): OFF drains the worker and background work pauses — fire-and-forget signals keep landing server-side and process on resume, synchronous staff actions (status/priority, refunds, `/ai`) fall back to direct in-process execution. Custom search attributes (`ticketThreadId`, `ticketStatus`, `conversationId`, `aiKind`) are registered automatically over the operator API and attached to starts once confirmed.

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

- **Loopers** (`kb-refresh`, `scoring-loop`, `metrics-snapshot`, `cleanup-loop`): change their bodies freely, but bump the workflow's entry in `LOOPER_GENERATIONS` (`src/temporal/types.ts`) **in the same commit**. `ensureBaseline()` terminates a running singleton whose memo generation differs and starts a fresh run — safe because loopers are stateless between ticks (scoring re-adopts SUBMITTED batches from Postgres).
- **Stateful long-lived workflows** (`ticketWorkflow` — its outbox carries non-refetchable Discord payloads — and `intercomInboxWorkflow`): any change to the order/type of emitted commands (activities, timers, children) must use `patched('<id>')` dual-path code, removed only after all pre-change runs have completed or continued-as-new (ticket retention is 14 days past close ⇒ two releases minimum). Terminate is NOT acceptable for these.
- **Short workflows** (stripe/refund/AI/score/status children): same `patched()` rule when in-flight runs matter; the exposure window is only the seconds around a deploy.

**Rollback past the legacy-cleanup release**: in the Temporal UI terminate `scoring-loop` and any `scoring-batch-*` runs, redeploy the old SHA (auto re-promotes; its own `ensureSchema` recreates the dropped queue tables empty), then toggle `/config → Temporal` OFF→ON.

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
