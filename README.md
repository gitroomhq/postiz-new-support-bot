# Postiz Support Bot

A Discord-first customer support bot for [Postiz](https://github.com/gitroomhq/postiz-app) (the open-source social-media scheduler). Each support request becomes a private Discord thread that is bridged to Intercom, where agents work it — Discord is the customer's channel, Intercom is the agents'. The bot also runs the inactivity automation Intercom can't (reminders + auto-close for bridged tickets AND native workspace conversations), and provides a full Stripe billing console (customer self-service refunds + a staff admin panel). Refund-request tickets stay Discord-only (never mirrored).

## How it works

- **Discord** (`discord.js` v14): the customer UI + the Stripe-side staff tooling Intercom doesn't cover. Customers open tickets from a panel; the slash commands are `/setup`, `/config`, `/intercom`, `/search-tickets`, `/postiz`, `/email`, `/charge`, `/billing` (plus the `/debug-attribute` diagnostic). All other agent actions (status, notes, reminders, escalation, canned replies, AI assist, reports) were retired in the **agent-rip** release: agents work tickets in Intercom.
- **Dispute evidence** (`src/bot/billing/evidence/`): `/billing → Disputes` and the web panel build evidence packs from a deterministic template corpus (operator overrides live in the panel's template editor), filled in with real Stripe, Postiz-usage and support facts. No model writes evidence: the `claude` CLI runner and `LightAiRunner` are orphaned (constructed, never called) until a follow-up removes them together with the knowledge-base refresh of `search/`, the cloned Postiz source and docs the template wording was written against. Every dispute also carries a fight-or-accept **verdict** (see [Dispute verdict](#dispute-verdict-fight-or-accept)).
- **InfluxDB export** (`src/metrics/`): optional InfluxDB 2.x exporter for billing events (refunds/discounts/charge reviews/disputes/fraud warnings), dispute gauges, the dispute automation surface (auto-resolve outcomes, evidence-pack strength, fact-source coverage, per-dispute history events and the two cutover phases), money-out with segment tags, subscription churn, Intercom bridge health (queue depths, webhook outcomes, inactivity sweeps) and a bot-health heartbeat. Connection (url/org/bucket/token — token encrypted at rest) is set in `/config → Analytics`. Grafana dashboards live in `grafana/dashboards/` (user-managed).
- **Intercom bridge** (`src/intercom/`): optional two-way sync (`none` / `push` / `bi`) of each Discord ticket to an Intercom conversation + customer ticket, with a durable outbox/inbox, echo-suppression, and a Canvas Kit inbox sidebar. HMAC-verified webhooks.
- **Stripe** (`src/bot/StripeClient.ts`, `BillingAdmin`, `src/bot/billing/`): customer self-service "refund & cancel" with guardrails (amount cap, per-24h velocity global + per-user, min membership age), plus a large staff `/billing` admin console. Dispute / early-fraud-warning **webhooks** are registered programmatically (no dashboard access needed) and alert staff.
- **Observability** (`@sentry/node`): errors, gen_ai spans, wide-event logs, and metrics. DSN and all knobs are set at runtime via `/config → Sentry`. The Sentry release is the 6-char git SHA — the same id as the Temporal worker deployment version.
- **Temporal** (`src/temporal/`): ALL background work runs on a self-hosted [Temporal](https://temporal.io) server — long-lived per-ticket workflows (reminders, auto-close, re-close, the Intercom outbox pump), per-conversation inbound workflows, looping singletons (KB refresh, snapshots, cleanup, disputes, the Intercom inactivity sweeper, the 30-min SLA target sweep, and the 5-min `sla-enforce` SLA-clock + balanced-assignment sweep), and short workflows per Stripe event / refund. There is no legacy scheduler fallback anymore; `temporalEnabled` is a worker **pause** switch (`/config → Temporal`): OFF drains the worker and background work pauses — fire-and-forget signals keep landing server-side and process on resume, synchronous actions (status changes, refunds) fall back to direct in-process execution. Custom search attributes (`ticketThreadId`, `ticketStatus`, `conversationId`, `aiKind`) are registered automatically over the operator API and attached to starts once confirmed.
- **Inactivity automation**: Intercom's workflow triggers never fire on API-created conversations, so the bot owns reminders/auto-close for the whole workspace. Bridged tickets: per-status-tag settings (`/config → Workflow → Manage Tags`) — customer nags ping the customer in the Discord thread; agent nags post an internal note + reopen the Intercom conversation (unmirrored refund tickets fall back to a Discord staff-role ping). Native (unbridged) conversations/tickets: the `intercom-inactivity-loop` sweeper (`/config → Intercom → Inactivity`, ships OFF) — agent-idle notes, customer-idle outbound nags, auto-close after N unanswered nags (native tickets get notes only, never auto-close).

## Data model

Prisma + PostgreSQL (`prisma/schema.prisma`). The deploy environment can't run the Prisma CLI, so the app **creates/updates its own schema at boot** via idempotent `CREATE TABLE / ALTER TABLE ... IF NOT EXISTS` statements in `src/db/ensureSchema.ts`.

> **Any change to `schema.prisma` must be mirrored by hand in `ensureSchema.ts`** (and in the manifest in `src/db/verifySchema.ts`). On boot, `verifySchema` compares the live columns against that manifest and warns on drift — set `SCHEMA_DRIFT_STRICT=1` (dev/CI only) to make it throw instead.

## Runtime configuration

Almost everything is configured live through the admin-only **`/config`** panel and stored in a single `BotSettings` row — the deploy has **no editable `.env`**, so new settings must be `/config`-configurable rather than new env vars. The one exception is the infrastructure layer underneath `/config` itself (Vault + Temporal), where a set env var *overrides* the stored value; see below.

### Environment variables

**Required:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `STRIPE_SECRET_KEY`, `DATABASE_URL`. Also `ANTHROPIC_API_KEY` for the AI CLI.

**Optional** (feature-gating, or first-boot seeds that `/config` then owns): `DISCORD_THREADS_CHANNEL_ID`, `DISCORD_SUPPORT_ROLE_ID`, `POSTIZ_FRONTEND_URL`, `POSTIZ_API_URL`, `POSTIZ_CLIENT_ID`, `POSTIZ_CLIENT_SECRET`, `POSTIZ_CALLBACK_URL`, `GH_BOT_TOKEN`, `GH_BOT_REPO`, `STRIPE_DISCOUNT_COUPON_ID`, `SERVER_PORT` (default 3000), `SENTRY_DSN`, `INTERCOM_*`, `SCHEMA_DRIFT_STRICT`, `RESEND_API_KEY`.

**`RESEND_API_KEY` is a fallback, not an override**: it is used only while `/config → Integrations → Resend` holds no key of its own, and a stored key wins. That is the reverse of `POSTIZ_ADMIN_TOKEN` (which pins the Postiz admin key) and of the infrastructure pins below, on purpose: a deploy's variable is often the sending-only key Postiz itself uses, which cannot read the suppression list, and a Full access replacement has to be settable by someone with no access to the environment.

**Infrastructure overrides (`VAULT_*` / `TEMPORAL_*`)**: these, with `POSTIZ_ADMIN_TOKEN`, are the only env vars that **win over `/config`**. Vault holds the Temporal mTLS certs, Temporal runs the background work, and `/config` is only reachable once the bot is up, so a deploy needs a way to pin the bootstrap layer regardless of what the database holds. Setting one pins the value; leaving it blank hands the setting back to Discord. Both panels label every pinned field and keep accepting edits, which are stored in `BotSettings` and take effect as soon as the variable is removed.

- **Vault** (`/config → Vault`): `VAULT_ENABLED`, `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_KV_MOUNT`, `VAULT_KV_BASE_PATH`, `VAULT_TRANSIT_MOUNT`, `VAULT_TRANSIT_KEY`.
- **Temporal** (`/config → Temporal → Connection`): `TEMPORAL_ENABLED` (worker pause switch), `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEMPORAL_DEPLOYMENT_NAME`, `TEMPORAL_TLS_SERVER_NAME`. Booleans accept `1/true/yes/on` and `0/false/no/off`; anything else is ignored with a warning.
- **Temporal mTLS certs are the exception to the exception**: Vault KV (`<kvBasePath>/temporal`, written by `/config → Temporal → Certificates`) stays authoritative, and `TEMPORAL_TLS_CERT_FILE` / `TEMPORAL_TLS_KEY_FILE` / `TEMPORAL_TLS_CA_FILE` are read *only* when KV holds no `temporal` entry, so a deploy that already keeps its certs in Vault never falls back to stale files on disk. Cert and key are required together; the CA is optional. The panel names whichever source is live.

The worker build id comes from `dist/temporal/buildInfo.json`, stamped by `pnpm build` with the git SHA — or, on a `.git`-less build machine, a content hash of `dist/` so every deploy still gets a unique id (`GIT_SHA` env remains a CI fallback; the panel flags a degenerate `x.y.z` id).

### Temporal server prerequisites

- Self-hosted Temporal **≥ 1.28** with [Worker Deployment Versioning](https://docs.temporal.io/worker-deployments) enabled (dynamic config `system.enableDeploymentVersions: true`) and SQL visibility (for `CountWorkflowExecutions`).
- A dedicated namespace (retention ≥ 14 days recommended — ticket workflows stay open 14 days past close).
- mTLS client cert/key (+ optional CA) — entered via `/config → Temporal → Certificates`, stored in **Vault KV** under `<kvBasePath>/temporal` (no local fallback; Vault must be up). Cert rotation needs a Temporal off/on toggle or a restart.
- On every boot the worker registers its build (deployment `TEMPORAL_DEPLOYMENT_NAME`, build id = the `buildInfo.json` stamp: git SHA, or a `dist/` content hash on `.git`-less builds) and **auto-promotes it to the deployment's Current Version**; re-deploying an older build re-promotes its id (that's the rollback story). Workflows default to AUTO_UPGRADE. **Never deploy from a dirty tree** — with git present the build id is the commit SHA, so a dirty deploy replays a different bundle under the previous version id (content-hash stamps don't have this problem).
- The bot registers its custom **search attributes** idempotently over the operator gRPC API on every connect (status line + `Ensure Search Attributes` button in the panel; `Test Connection` doubles as repair). The mTLS client identity therefore needs operator-API permission for `AddSearchAttributes`.
- `--worker-only` runs a process that only polls the task queue (logs into Discord for activities, no commands/HTTP) — the future split topology.

### Workflow compatibility policy (AUTO_UPGRADE, single in-process worker)

Every deploy replays running workflows against the new bundle — a changed command sequence wedges them with nondeterminism task failures. Rules:

- **Loopers** (`kb-refresh`, `metrics-snapshot`, `cleanup-loop`, `disputes-loop`, `intercom-inactivity-loop`, `sla-sweep`, `sla-enforce`, `sentry-feedback-sync`): change their bodies freely, but bump the workflow's entry in `LOOPER_GENERATIONS` (`src/temporal/types.ts`) **in the same commit**. `ensureBaseline()` terminates a running singleton whose memo generation differs and starts a fresh run — safe because loopers are stateless between ticks.
- **Retiring a singleton/Schedule**: add it to `RETIRED_SINGLETONS` / `RETIRED_WORKFLOW_QUERIES` / `RETIRED_SCHEDULES` (`src/temporal/types.ts`) and remove it from `SINGLETONS` in the same commit — `ensureBaseline()` terminates/deletes retired ids on every boot before the worker polls (the agent-rip release retired `scoring-loop`, its `scoring-batch-*` children and the `status-report` Schedule this way). A retired id must never be re-added.
- **Stateful long-lived workflows** (`ticketWorkflow` — its outbox carries non-refetchable Discord payloads — and `intercomInboxWorkflow`): any change to the order/type of emitted commands (activities, timers, children) must use `patched('<id>')` dual-path code, removed only after all pre-change runs have completed or continued-as-new (ticket retention is 14 days past close ⇒ two releases minimum). Terminate is NOT acceptable for these.
- **Short workflows** (stripe/refund/AI/score/status children): same `patched()` rule when in-flight runs matter; the exposure window is only the seconds around a deploy.

**Rollback past the legacy-cleanup release**: in the Temporal UI terminate `scoring-loop` and any `scoring-batch-*` runs, redeploy the old SHA (auto re-promotes; its own `ensureSchema` recreates the dropped queue tables empty), then toggle `/config → Temporal` OFF→ON.

**Rollback past the agent-rip release**: replay-safe in both directions (the release shipped `ticket.workflow.ts` byte-identical; all timer changes are activity-side). The old build recreates `scoring-loop` + the `status-report` Schedule on boot; the new `intercom-inactivity-loop` wedges quietly under the old build (unknown type — terminate it in the UI if staying rolled back). NOT undone by rollback: resolved tags stay `closesThread=true` (the ✅ transition locks immediately under old code) and stripped thread titles re-decorate on the next status change. `agentRipMigratedAt` + `intercom_sweep_state` are unknown-extra columns to the old build (harmless; the flag also prevents a double sweep on re-deploy).

**Priority-removal release notes**: the `applyPriorityUpdate` handler left `ticketWorkflow` — replay-safe for clean histories (`setHandler` emits no commands). The only at-risk runs are ticketWorkflows started 2026-07-09→13 that actually received an `applyPriority` update: those wedge with a nondeterminism task failure on the first post-deploy replay — terminate the run in the Temporal UI, then use the ticket's Heal Message Gaps button to re-sync the mirror. Rollback past this release is safe: the old build re-registers the handler/stub and its `ensureSchema` recreates `priority_tags`/`priorityTagId` where missing. Post-deploy: click `/config → Intercom → Ensure Attributes` once (archives the stale "Priority" ticket attribute in Intercom), and confirm `conversation.priority.updated` is unsubscribed in the Developer Hub.

**Agent-rip follow-up release (N+1) checklist**: after this release proves out (DB backup first) — drop tables `canned_responses`, `ticket_scores`, `scoring_batches`, `ticket_ai_runs`, `ticket_notes`, `priority_tags` (priority CODE already fully removed in the priority-removal release; only the orphaned table/column DDL remains); drop `tickets.escalationTierId`/`priorityTagId` (+FKs), `remindersPaused`, `firstResponseAt`, `aiAnswer` (KEEP `reminderCount`/`lastReminderAt`/`recloseAt` — the timer engine lives); drop the `bot_settings` AI/scoring/report orphans (KEEP `aiModel`, `aiModelLight`, `aiEffortAsk`, `aiMaxBudgetUsdAsk` — dispute evidence; KEEP `reminderTarget` on status_tags — it doubles as the waiting-on-customer marker; KEEP `backfillDone`; the former sentry-read orphans `sentryReadEnabled`/`sentryReadToken`/`sentryOrgSlug`/`sentryProjectSlug`/`sentryReadRegion` are NO LONGER orphans — the Sentry feedback import revived them); mirror every drop in `ensureSchema.ts` (destructive-convergence block) + `verifySchema.ts`; remove the `aiRunWorkflow`/`scoreOneWorkflow`/`publishStatusReportWorkflow` tombstones + their activity stubs; remove the legacy `"priority"` skip case in `IntercomEventExecutor` + the skip-only `"priority"` members of `OutboxEventType`/`IcEventType` (safe once pre-removal outboxes have drained); remove `AgentRipMigration` + its `index.ts` wiring (the flag column stays).

**Active `patched()` ids**: `intercom-ensure-park` (ticketWorkflow pump: a dead ensure parks the queue instead of hot-looping) — introduced in the bi-mode hardening release; removable two releases later per the rule above.

> **Intercom webhook runbook**: while Temporal is down every `POST /intercom/webhook` answers 500 (deliberate — Intercom's retry redelivers). *Sustained* failures can make Intercom auto-disable the subscription with only an email notice; the bridge then stays inbound-dead after recovery. Alert on the `intercom_webhook` Influx measurement (`outcome=rejected` = bad/rotated client secret, Intercom does NOT retry 4xx; `outcome=error/buffered` = enqueue failures), and after any prolonged outage check Developer Hub → your app → Webhooks and re-enable the subscription if needed. The `/config → Intercom` panel shows the last verified inbound webhook.

> **Secrets at rest** (Postiz OAuth access tokens, Intercom credentials, the Stripe webhook signing secret) are encrypted with AES-256-GCM. The key is derived (HKDF) from `STRIPE_SECRET_KEY` + `DATABASE_URL` + `DISCORD_TOKEN`, so a database dump alone cannot decrypt them. Rotating any of those three orphans existing ciphertext (fail-soft: affected users re-auth / secrets are re-entered).

### SLA engine + balanced assignment setup (one-time, manual Intercom steps)

The Intercom workspace runs on the **Advanced** plan, which has no native SLAs, workload management or team office hours — so **the bot owns all three**. Admin-defined rules (`/intercom → SLA Manager`) pick a **target** per conversation and write it to the `SLA Target` conversation attribute (inbox visibility + Advanced-plan view/Workflow branching); each target carries **business-minute clocks** (first-reply / next-reply / resolution) that the 5-minute `sla-enforce` looper runs. The API can't create conversation attributes, so a couple of steps are manual (the **Verify Setup** button checks them live):

1. **Old Workflows** (migration only): delete the two Apply-SLA Workflows from the Expert era — native SLAs are gone and the bot no longer posts kick notes. Nothing new to build in Intercom Workflows.
2. **Attributes**: Intercom → Settings → Data → Conversations → create two **List** attributes — `SLA Target` (one option per registered target value, `/intercom → SLA Manager → Targets`) and `SLA Status` with exactly the options `ok`, `at_risk`, `breached` (the enforcement looper writes it; writes 4xx until it exists).
3. **Ticket attribute**: `/intercom → Bridge → Ensure Ticket Attributes` — creates the `SLA Target` **ticket** attribute (the bot mirrors each target onto the converted ticket for Tickets views; the API *can* create ticket attributes).
4. **Webhooks**: Developer Hub → your app → Webhooks → subscribe `conversation.user.created`, `conversation.user.replied` and `conversation.admin.assigned` (native-conversation SLA rules, reopen-reassignment and the `intercom.assignee` rule dim need them; bridged target evaluation and creation-time assignment work without them).
5. **Targets + clocks**: `/intercom → SLA Manager → Targets` — set per-target durations (blank clock = disabled for that target); **Warn %** (global at-risk threshold, default 80%). **Office Hours** are **per team** (Expert's team office hours): `/intercom → SLA Manager → Office Hours` opens a team picker — set a **Workspace default** schedule (timezone, per-weekday windows, holidays) plus any per-team overrides. A conversation's SLA clocks pause on **its own team's** hours; teams without custom hours inherit the default. Only SLA clocks pause; everything else runs 24/7.
6. **Assignment** is **per team** (Expert's workload management): `/intercom → Assignment` opens a team picker. Each team balances a conversation within **its own** members minus Operator/Fin minus that team's exclusion list; a **Workspace default** covers teams you don't customize. Review each team's live pool + open counts, set exclusions, toggle it on. Hybrid balancer (round-robin, skip above-average load, fewest-open fallback); away teammates get no new work; human assignments are never overridden. A conversation is balanced within whatever team it already sits on (Intercom routing rules / the bridge's routing team).
7. **Verify Setup**, then toggle **SLA: on**.
8. Optional: Advanced-plan inbox views / Workflows can still filter and branch on `SLA Target`, `SLA Status`, and the `sla-breached` tag.

Alerts stay **inside Intercom** (agent Discord pings were retired): at-risk flips the `SLA Status` attribute; a breach also adds the `sla-breached` tag and one internal note per breached clock. Rules are priority-ordered (first enabled match wins, conditions AND-ed) over ticket basics, Stripe customer state, Intercom data and keywords; no match writes the default target. Target evaluation fires on ticket creation, status changes, customer replies, assignee changes, Stripe events and the native webhooks (30-min `sla-sweep` safety net); the clocks + assignment stray-sweep run every 5 min (`sla-enforce`).

### Customer responded ticket state

When a customer replies, the Intercom ticket moves into a "Customer responded" state, so the inbox shows at a glance which tickets wait on the team. When a teammate replies, the ticket goes back to the state it had before the customer wrote. Intercom can't do the second half itself (it has no memory of the previous state, and its Workflows never see the bridge's API-created conversations), so the bot does both.

- **Triggers**: a customer reply on a ticket in **Submitted**, **In progress** or **Waiting on customer** (any custom state in those categories). Resolved tickets keep Intercom's own reopen behavior. Only Customer-category ticket types; plain conversations have no ticket state and are skipped.
- **What counts as our reply**: a person replying in the Intercom inbox, or a staff message in a bridged Discord thread. Fin, bots, the bot's own automated messages and internal notes never count.
- **Where it goes back to**: the exact state from before the customer's reply. Two exceptions land on Waiting on customer instead: a ticket that was still Submitted, and a ticket in Customer responded with no record of where it came from (set by hand, or before this shipped) whose ticket history doesn't say either.
- **Intercom's own move**: Intercom itself moves Waiting on customer to In progress the moment a customer replies. The bot reads the ticket history to see through that, so the restore still returns to Waiting on customer.
- **Manual changes win**: if someone changes the state by hand (or replies and sets a state in one go) while the ticket is in Customer responded, the pending restore is dropped. Closed or snoozed conversations are never written to (a ticket write would reopen them).
- **Bridged Discord tickets**: the change rides the ticket's outbox, behind the message that caused it. On our reply the Discord status goes back too (for example Waiting for Developer back to Waiting for Customer, so customer reminders and auto-close keep working), and the Intercom state follows the tag mapping.

Setup (`/intercom → Automation`, mirrored in the web panel's Automation hub):

1. In Intercom, create the state (Settings → Tickets → ticket states), preferably in the **In progress** category, and enable it on every Customer ticket type you use. Tickets whose type lacks it are skipped. In progress is the safe category: Intercom's own automatic move only starts from Waiting on customer and Resolved, so it never fights this one.
2. **Pick State**, then switch **Customer Responded: on**. Nothing changes until both are set.
3. Optional: **Sync Now** moves every open ticket whose customer spoke last into the state (one pass, results shown when it finishes).

No new webhook subscriptions: it uses `conversation.admin.replied` (the bridge's topic list) and `conversation.user.replied` (the SLA setup above). Flips are silent (no notes, no audit entries); the Discord status changes on bridged tickets are ordinary status changes. Restore rows older than 90 days are dropped by the cleanup tick.

### Resolve on close

Fin closes a conversation when the customer goes idle but leaves its ticket in In progress or Waiting on customer, and Workflows, the customer-idle sweep and teammates can do the same. The bot moves every closed ticket whose state is outside the Resolved category into a Resolved state. **On by default**; nothing to set up.

- **Which tickets**: Customer-category tickets that are closed and in Submitted, In progress or Waiting on customer (any custom state in those categories). Any Resolved-category state already set is kept, so a teammate's deliberate custom resolved state is never overwritten. Back-office and Tracker tickets are left alone (a Tracker's state change reaches every linked customer).
- **Which state**: the one picked under **Close State**, or with **Auto** (the default) each ticket type's own Resolved state. A type that does not have the picked state enabled also gets its own.
- **When**: inline on `conversation.admin.closed` (already in the bridge's topic list, works in every bridge mode), plus a sweep on the 5-minute SLA enforce tick as the backstop for closes whose webhook never arrives. The bot's own customer-idle auto-close writes the state just before it closes.
- **Backfill**: the first sweeps after it is switched on walk every closed, unresolved ticket (60 writes per tick) until a full pass finds nothing left, then stamp the backfill as done and only look at tickets touched in the last two hours. Switching it off and on again repeats the backfill, so closes made while it was off are caught up.
- **Bridged Discord tickets**: a closing status pushes the Resolved state even when the closing tag is unmapped or mapped to another state (a tag mapped to a Resolved state keeps its mapping). A bridged ticket closed in Intercom while its Discord thread is still open is left to the bridge's open/close parity.
- **Reopen guard**: a ticket write on a closed conversation can reopen it, so the write carries `open: false`, and a ticket that still comes back open is closed again (logged as `state write reopened the ticket`).
- **Customer responded**: resolving a ticket drops its pending Customer responded restore.

Writes are silent (`skip_notifications`, no notes). `/intercom → Automation` shows the status, the backfill and the last sweep; the web panel's Automation hub mirrors it.

### Sentry feedback → Intercom import

Sentry's User Feedback widget is write-only for users — nobody can answer them there. The `sentry-feedback-sync` looper (15 min, plus a webhook accelerator) turns each **widget** feedback item into an Intercom conversation authored by an email contact matching the submitter: agents reply in Intercom, Intercom's email fallback delivers the reply (imported contacts never have Messenger sessions), and the submitter's email answer threads back into the same conversation. Sentry itself is strictly read-only; anonymous submissions are skipped (counted on the panel); there is **no backfill** — the first enable stamps an import floor.

Setup (`/config → Integrations → Sentry Feedback`):

1. In Sentry, create an **org auth token** with `org:read`, `project:read`, `event:read` and paste it via **Credentials** (Vault-routed like every global secret).
2. Set **Org & Projects** (org slug required; project slugs optional allowlist; region `us`/`eu`).
3. Optional real-time trigger: Sentry → Settings → Developer Settings → **internal integration** → webhook URL `POST <public-url>/sentry/webhook` (Issue events on), paste its **client secret** via Credentials. Unsigned/unverified posts get 403; the poll alone also works.
4. Optional **Ticket Type** — when set, every new import is immediately converted into a ticket of that type (Customer category recommended — one unified inbox object, same convert path as the bridge; conversion is best-effort, a failure leaves the plain conversation standing). Optional **Team Routing** — imported conversations (and their converted tickets) get team-assigned on creation, and thereby balanced by the assignment engine if that team has it enabled.
5. Toggle **Enabled: on** (stamps the import floor on first enable) — **Sync Now** forces a one-shot test run.

Imported conversations are tagged `sentry-feedback`, carry an internal metadata note (submitter, page URL, Sentry link — the conversation itself is backdated to the submission time), get agent-idle reminder notes (once — the ticket sweep skips converted imports), and are **never** customer-nagged, auto-closed or SLA-clocked.

### Resend: email suppression and the delivery log

Postiz sends its activation, password-reset and notification mail through [Resend](https://resend.com). Two things decide whether a customer gets it:

- **the suppression list**: an address that hard-bounces or files a spam complaint lands on the Resend team's suppression list, and every later email to it is silently dropped. That is how a customer ends up never receiving the mail that would let them log in.
- **the delivery log**: what happened to each email Resend sent (sent, delivered, delayed, bounced, failed, marked as spam, suppressed), with the receiving server's reason. Resend's API cannot list emails by recipient, so the bot keeps its own log, fed by a Resend webhook, and keeps it for 180 days. Opens and clicks are not tracked. Postiz sends without Resend tags, so each email is classified by its subject (activation, password reset, team invite, login changed, other).

Where support sees them:

- the **Intercom inbox sidebar**: the main card shows one identity line (name, email, Postiz plan, Stripe subscription status) and only the warnings that are true right now (email suppressed, last email bounced/failed/spam/delayed, delinquent, blocked, open dispute, refund review or approvals pending). Everything else sits behind buttons: **Postiz Account** (with the [AI credit reset](#ai-credit-reset)), **E-Mail Deliverability** (suppression status and removal for the contact, Postiz and Stripe addresses, *Check another address*, and the delivery log ten to a page, each email openable for its event timeline), **Billing** (subscriptions, charges, the refund review and approvals) and **Discord Ticket** (only for bridged conversations). The old *Open Stripe Panel* link and its web page are gone;
- **`/email [address]`** in Discord: support role and admins only, checked at runtime on the command and on every button, menu and modal, with ephemeral replies. With an address it opens that address (suppression, Postiz account, delivery log with a menu to open each email); without one it opens a hub with *Look up address*;
- the **web customer page**, *Postiz & Email* tab: linked accounts, the *Email delivery* card (the Stripe email and the owner of each linked Postiz organisation; removal takes a typed CONFIRM) and the *Delivery log* table. The customer page now has tabs (Overview, Billing, Postiz & Email, Details); the rail keeps only Insights and Manage.

Any teammate on those surfaces may remove an address. Every removal goes to the audit channel (who, from which surface, what the address was suppressed for), and the sidebar also leaves an internal note on the conversation. When the address belongs to a Postiz account that was never activated, each surface offers **Resend activation email**, which calls Postiz's own `/auth/resend-activation` route.

Admin-only tools (Discord Administrator permission in `/email`, the dashboard admin role on the web, re-checked on every press):

- **Share link**: on any logged email (`/email` email view, web *Delivery log* rows). Resend returns a link that shows the email exactly as sent, body included, valid for **2 hours**. A reset or activation email carries a live link, so the link is shown only to the admin who asked and the audit entry records who shared which email, never the link. The web action also checks that the email went to that customer.
- **Suppression list** (the `/email` hub): browse the list with a filter (origin any/bounce/complaint/manual, recipient domain, date range), ten to a page, and **Remove all N** matches. The removal re-scans with the same filter instead of trusting the preview, removes in batches of 100, needs `REMOVE <n>` typed, and audits one summary entry. A scan stops after 20,000 entries.

Setup (`/config → Integrations → Resend`, or the Integrations hub of the web panel):

1. In the Resend team Postiz sends from, create a **Full access** API key (a sending-only key cannot read the suppression list or register a webhook) and paste it via **API Key**. It is stored like every global secret (Vault KV entry `resend`, or local encryption) and never echoed back. Without one, `RESEND_API_KEY` from the environment is used.
2. **Test Connection** must answer *Full access* and list that team's sending domains.
3. Toggle **Enabled: on** (ships off).
4. **Register Webhook** (needs the public URL from Billing → Stripe Webhooks): creates a webhook on the Resend team pointing at `POST <public-url>/resend/webhook` for the seven delivery events, and stores its Svix signing secret as the global secret `resendWebhookSecret` (Vault KV entry `resend`). It then imports the last month from Resend's history (a Temporal workflow, or in process when Temporal is down; each imported email carries only its last status). Pressing it again replaces the webhook. **Remove Webhook** deletes it; the log keeps what it has. Unsigned or stale deliveries get 403.

Lookups are throttled to about four requests a second and cached for a minute, because Resend's limit of 10 requests a second is per team and Postiz's own sending draws on it too. The webhook uses none of that budget.

### AI credit reset

The sidebar's **Postiz Account** view can give an organization its AI images or AI videos for the current billing period back, through the platform's superadmin `POST /public/v1/credits/reset` (postiz-app `4c5d42a`). The platform deletes the period's usage rows, so the organization gets its full monthly allowance again; nothing undoes it.

- **Who**: any teammate who can open the card.
- **Which organization**: the *Postiz account email* field starts with the conversation's Postiz account (or the contact's email) and can be changed to any address. On every press the bot resolves the address on the platform: only accounts whose email is exactly that address count, deleted users and organizations are skipped, and an address in more than one organization is refused rather than guessed. The confirm step names the organization (name and id); the reset itself re-resolves the address and refuses when it no longer points at the organization that was confirmed. The request names the organization in `x-postiz-org`; without it the route would reset the bot's own organization.
- **Repeats**: every reset is recorded (`postiz_credit_resets`: organization, kind, the email entered, how many credits came back, who, which conversation). The confirm step shows the last reset of the same kind for that organization and flags it with a warning when it is under 31 days old, but still allows the reset.
- **Trail**: an internal note on the conversation, an audit channel entry, and the record above.
- **Needs**: the Postiz lookup (`/config → Integrations → Postiz`: base URL, superadmin API key, Enabled). With it off the section is not shown. A platform older than `4c5d42a` answers 404, which the card reports as needing a platform update; an organization without a subscription is reported as having no plan credits to reset.

### Dispute verdict: fight or accept

A complete evidence pack is not a winning one, and fighting a case that cannot be won costs the countered-dispute fee on top of the loss. So every dispute carries a **verdict**, Fight or Accept, from fixed rules in `src/bot/billing/disputeVerdict.ts`. First match wins:

1. a refund already issued on the disputed charge: **Fight**;
2. an annual charge: **Fight**;
3. a *subscription canceled* claim where support saw a request to cancel before the charge: **Accept**;
4. 3-D Secure authenticated, or Visa Compelling Evidence 3.0 qualified: **Fight**;
5. very little data, meaning any one of: the customer's first successful payment, an evidence pack below the thin-data bar (default 40%), or a card never verified by 3-D Secure, CVC or postcode on this or an earlier charge: **Accept**;
6. any weak signal: Postiz usage (posts before or after the charge, channels connected in the paid period, queued posts), support contact before the dispute (Intercom conversations or Discord tickets), or a cancel claim Stripe disproves: **Fight**;
7. otherwise: **Accept**.

A source that did not answer (Postiz usage, support history, payment history) never counts as a "no". It makes the verdict *provisional*: shown everywhere, but nothing automatic acts on it.

- **When it is decided**: the disputes looper keeps a verdict on every open dispute, re-evaluated daily, at most 10 per hourly tick inside a 5-minute budget. In manualplus and auto, where the pack is built on the dispute webhook, a provisional verdict is made there first (the webhook never calls Intercom). *Recompute* on the web dispute page decides one on the spot.
- **Submitting**: every submit path (Discord `/billing`, the web panel, auto-submit) goes through one gate. Submitting against anything but a Fight verdict needs a typed reason, kept in the dispute's history as an override; the automation never gets one, so auto-submit only ever sends Fight verdicts. A complete Accept, or a human's Accept, gets no reminder or escalation pings: letting it lapse loses it exactly as accepting would.
- **Auto-accept**: only when evidence runs in **auto** mode, only on formal chargebacks, only on a complete Accept nobody has edited or a human's own override to Accept, never on a dispute opted out of automation, and only inside the same window before the deadline as auto-submit. The dispute is accepted as lost and an alert names the rule that decided it. In manual and manualplus nothing is accepted automatically.
- **Inquiries**: auto-resolve still refunds them to keep them off the dispute ratio, except annual charges, which it never refunds (guardrail `annual_charge`).
- **Override**: *Override verdict* on the web dispute page (typed CONFIRM plus a reason) wins over the rules everywhere, auto-submit and auto-accept included. The thin-data bar lives in the web panel's Disputes hub, under *Fight or accept*.
- **Backtest**: *Disputes → Analysis → Run backtest* (admins) evaluates every decided chargeback from the last 365 days as if it had just arrived, counting usage, support contact and payments up to each dispute's own date, in looper batches of 15. A verdict made while a dispute was live is kept as it was shown; a re-run re-decides earlier backtest verdicts under the current settings. The Analysis tab groups decided chargebacks by reason, network code, card brand, verdict or deciding rule, with fought vs unanswered, win rate and the dispute fees the money-out ledger recorded.
- **Changing the rules**: bump `VERDICT_VERSION`. Open disputes are then re-decided over the next ticks, and a backtest treats older backtest verdicts as stale.

Keep Stripe's own Smart Disputes auto-response off, or Stripe submits evidence on disputes the verdict concedes.

## Setup

```bash
pnpm install          # postinstall shallow-clones postiz-app + postiz-docs into search/
pnpm build            # prisma generate && tsc && workflow bundle (dist/temporal/workflow-bundle.js)
pnpm start            # node (with Sentry preload) dist/index.js
pnpm test             # unit tests (node:test)
pnpm test:temporal    # opt-in Temporal time-skipping integration tests (downloads a test server binary)
# dev: pnpm dev       # ts-node
```

`DATABASE_URL` must point at a PostgreSQL database; the app ensures its own schema on boot. An externally reachable URL (`POSTIZ_CALLBACK_URL` origin, or `/config → Billing → Webhooks → Set Public URL`) is needed for the Postiz OAuth callback, Intercom webhooks, Stripe webhooks, and the optional Sentry feedback webhook.

## Layout

```
src/
├── index.ts            # bootstrap / dependency wiring
├── config/             # loadConfig + SettingsStore (BotSettings) + canned/escalation stores
├── auth/               # Postiz OAuth + SessionStore
├── bot/                # DiscordBot (core), ClaudeCodeRunner, StripeClient, billing/, schedulers, TicketStore…
├── categories/         # customer ticket categories (How-To, Bugs, Billing)
├── intercom/           # two-way Intercom bridge
├── adminpanel/         # web admin panel hubs (/config and /intercom settings on the web)
├── dashboard/          # web billing console (customers, disputes, payments, ...)
├── metrics/            # InfluxDB writer + exporters + snapshot scheduler
├── postiz/             # Postiz platform lookups (identity, usage feed)
├── resend/             # Resend client, suppression tooling, delivery log (webhook, backfill)
├── sentry/             # Sentry feedback → Intercom import
├── sla/                # SLA clocks, balanced assignment, office hours
├── server/             # Express callback + webhook server
├── temporal/           # Temporal platform (service/worker/producers) + workflows/ + activities/
├── vault/              # Vault KV/Transit secret storage
├── db/                 # ensureSchema + verifySchema
└── util/               # embeds, logger (Sentry), crypto, instrument
grafana/dashboards/     # 8 importable Grafana dashboards (InfluxDB 2.x / Flux)
```
