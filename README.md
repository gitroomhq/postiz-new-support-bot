# Postiz Support Bot

A Discord-first customer support bot for [Postiz](https://github.com/gitroomhq/postiz-app) (the open-source social-media scheduler). Each support request becomes a private Discord thread with emoji status/priority tags; an AI attempts a first answer, and staff manage the ticket lifecycle. It bridges tickets to Intercom and provides a full Stripe billing console (customer self-service refunds + a staff admin panel).

## How it works

- **Discord** (`discord.js` v14): the whole UI. Customers open tickets from a panel; staff use slash commands (`/status`, `/priority`, `/note`, `/reminders`, `/escalate`, `/canned`, `/charge`, `/billing`, `/search-tickets`, `/ai`, `/report`, `/config`, `/setup`).
- **AI answers** (`@anthropic-ai/claude-code` CLI): the bot spawns the `claude` CLI with its working directory set to `search/`, where the **Postiz source and docs are cloned** (`search/postiz-app`, `search/postiz-docs`). The model grounds answers by `Read`/`Glob`/`Grep`-ing that real code — there is no vector store. Models are configurable in `/config → AI & Knowledge` (a cheaper model is used for the tool-less `/ai summarize`/`draft`). A scheduler `git pull`s the clones periodically so answers track upstream. Staff `/ai` runs can additionally use a **read-only** Stripe MCP server and a customer-scoped read-only Postiz MCP.
- **Intercom bridge** (`src/intercom/`): optional two-way sync (`none` / `push` / `bi`) of each Discord ticket to an Intercom conversation + customer ticket, with a durable outbox/inbox, echo-suppression, and a Canvas Kit inbox sidebar. HMAC-verified webhooks.
- **Stripe** (`src/bot/StripeClient.ts`, `BillingAdmin`, `src/bot/billing/`): customer self-service "refund & cancel" with guardrails (amount cap, per-24h velocity global + per-user, min membership age), plus a large staff `/billing` admin console. Dispute / early-fraud-warning **webhooks** are registered programmatically (no dashboard access needed) and alert staff.
- **Observability** (`@sentry/node`): errors, gen_ai spans, wide-event logs, and metrics. DSN and all knobs are set at runtime via `/config → Sentry`.

## Data model

Prisma + PostgreSQL (`prisma/schema.prisma`). The deploy environment can't run the Prisma CLI, so the app **creates/updates its own schema at boot** via idempotent `CREATE TABLE / ALTER TABLE ... IF NOT EXISTS` statements in `src/db/ensureSchema.ts`.

> **Any change to `schema.prisma` must be mirrored by hand in `ensureSchema.ts`** (and in the manifest in `src/db/verifySchema.ts`). On boot, `verifySchema` compares the live columns against that manifest and warns on drift — set `SCHEMA_DRIFT_STRICT=1` (dev/CI only) to make it throw instead.

## Runtime configuration

Almost everything is configured live through the admin-only **`/config`** panel and stored in a single `BotSettings` row — the deploy has **no editable `.env`**, so new settings must be `/config`-configurable rather than new env vars.

### Environment variables

**Required:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `STRIPE_SECRET_KEY`, `DATABASE_URL`. Also `ANTHROPIC_API_KEY` for the AI CLI.

**Optional** (feature-gating, or first-boot seeds that `/config` then owns): `DISCORD_THREADS_CHANNEL_ID`, `DISCORD_SUPPORT_ROLE_ID`, `POSTIZ_FRONTEND_URL`, `POSTIZ_API_URL`, `POSTIZ_CLIENT_ID`, `POSTIZ_CLIENT_SECRET`, `POSTIZ_CALLBACK_URL`, `GH_BOT_TOKEN`, `GH_BOT_REPO`, `STRIPE_DISCOUNT_COUPON_ID`, `SERVER_PORT` (default 3000), `SENTRY_DSN`, `INTERCOM_*`, `SCHEMA_DRIFT_STRICT`.

> **Secrets at rest** (Postiz OAuth access tokens, Intercom credentials, the Stripe webhook signing secret) are encrypted with AES-256-GCM. The key is derived (HKDF) from `STRIPE_SECRET_KEY` + `DATABASE_URL` + `DISCORD_TOKEN`, so a database dump alone cannot decrypt them. Rotating any of those three orphans existing ciphertext (fail-soft: affected users re-auth / secrets are re-entered).

## Setup

```bash
pnpm install          # postinstall shallow-clones postiz-app + postiz-docs into search/
pnpm build            # prisma generate && tsc
pnpm start            # node (with Sentry preload) dist/index.js
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
├── server/             # Express callback + webhook server
├── db/                 # ensureSchema + verifySchema
└── util/               # embeds, logger (Sentry), crypto, instrument
```
