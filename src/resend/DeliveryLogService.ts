import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "../bot/AuditLogger";
import { metricCount } from "../util/instrument";
import { log } from "../util/logger";
import {
  BACKFILL_DAYS,
  RETENTION_DAYS,
  WEBHOOK_EVENTS,
  parseWebhookEvent,
  svixSignatureValid,
  type DeliveryLogStore,
  type LoggedEmail,
  type LoggedEvent,
} from "./DeliveryLogStore";
import { ResendHttpError, type ResendClient } from "./ResendClient";
import type { DeliveryActor } from "./EmailDeliverabilityService";

const logLog = log.child("resend-log");

// Share links show the whole email, live reset and activation links included,
// so they are admin-only (checked by every caller) and short-lived.
export const SHARE_TTL = "2 hours";
export const SHARE_TTL_LABEL = "2 hours";
export const WEBHOOK_PATH = "/resend/webhook";

export type WebhookOutcome = "stored" | "duplicate" | "ignored" | "forbidden";

// The delivery log end to end: registering the Resend webhook that feeds it,
// verifying and storing deliveries, the one-month backfill, the 180-day purge,
// the per-address history every support surface reads, and admin share links.
export class DeliveryLogService {
  // Starts the backfill as a Temporal workflow; bound in index.ts. Resolves
  // false when Temporal could not take it, and the backfill then runs in
  // process (it is idempotent, so a restart mid-run only means pressing again).
  private backfillStarter: (() => Promise<boolean>) | null = null;
  private inProcessBackfill: Promise<void> | null = null;

  constructor(
    private settings: SettingsStore,
    private client: ResendClient,
    private store: DeliveryLogStore,
    private audit?: AuditLogger | null
  ) {}

  bindBackfillStarter(starter: () => Promise<boolean>): void {
    this.backfillStarter = starter;
  }

  // "started" | "running" (in-process one already going) | "in-process".
  async startBackfill(): Promise<"started" | "running" | "in-process"> {
    if (await this.backfillStarter?.().catch(() => false)) return "started";
    if (this.inProcessBackfill) return "running";
    this.inProcessBackfill = this.backfill()
      .then((r) => this.recordBackfill(`ok: ${r.created} emails imported (${r.scanned} scanned)`))
      .catch((e) => this.recordBackfill(`failed: ${describe(e)}`).catch(() => {}))
      .finally(() => {
        this.inProcessBackfill = null;
      });
    return "in-process";
  }

  // The log is readable whenever Resend support is on; it only fills while a
  // webhook is registered.
  enabled(): boolean {
    return this.settings.resendEnabled() && this.client.configured();
  }

  webhookRegistered(): boolean {
    return Boolean(this.settings.resendWebhookId() && this.settings.resendWebhookSecret());
  }

  webhookUrl(): string | null {
    const base = this.settings.publicBaseUrl();
    return base ? `${base.replace(/\/+$/, "")}${WEBHOOK_PATH}` : null;
  }

  // ---- webhook ----

  // Verifies before parsing anything. A valid delivery we do not log (another
  // event type, no recipient) is still a 200, so Resend does not retry it.
  async handleWebhook(
    raw: Buffer,
    headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
  ): Promise<WebhookOutcome> {
    const secret = this.settings.resendWebhookSecret();
    if (!secret || !svixSignatureValid(raw, headers, secret)) {
      metricCount("resend.webhooks", 1, { outcome: "forbidden" });
      return "forbidden";
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      metricCount("resend.webhooks", 1, { outcome: "ignored" });
      return "ignored";
    }
    const parsed = parseWebhookEvent(body);
    if (!parsed) {
      metricCount("resend.webhooks", 1, { outcome: "ignored" });
      return "ignored";
    }
    const fresh = await this.store.ingest(headers.id!, parsed);
    // A delivery event can change what the suppression lookup answers.
    if (fresh && (parsed.type === "bounced" || parsed.type === "complained" || parsed.type === "suppressed")) {
      this.client.clearCache(parsed.recipient);
    }
    const outcome: WebhookOutcome = fresh ? "stored" : "duplicate";
    metricCount("resend.webhooks", 1, { outcome, event: parsed.type });
    return outcome;
  }

  // Creates the webhook on the Resend team (replacing the one this bot made
  // before, if any) and stores its signing secret. Needs a Full access key and
  // a public URL. The caller starts the backfill afterwards.
  async registerWebhook(actor: DeliveryActor): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const url = this.webhookUrl();
    if (!url) return { ok: false, error: "No public URL is set (/config → Billing → Stripe Webhooks sets it)." };
    if (!this.client.configured()) return { ok: false, error: "No Resend API key is configured." };
    try {
      const previous = this.settings.resendWebhookId();
      if (previous) await this.client.deleteWebhook(previous).catch(() => false);
      const created = await this.client.createWebhook(url, WEBHOOK_EVENTS);
      await this.settings.setResendWebhook({ id: created.id, secret: created.signingSecret });
      void this.audit?.log({
        title: "✉️ Resend delivery webhook registered",
        severity: "info",
        actor: actor.name,
        fields: [
          { name: "Endpoint", value: url, inline: false },
          { name: "Events", value: WEBHOOK_EVENTS.join(", "), inline: false },
        ],
      });
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }

  async removeWebhook(actor: DeliveryActor): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = this.settings.resendWebhookId();
    try {
      if (id) await this.client.deleteWebhook(id);
      await this.settings.setResendWebhook({ id: null, secret: null });
      void this.audit?.log({ title: "✉️ Resend delivery webhook removed", severity: "warn", actor: actor.name });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }

  // The text every /config surface shows after a register press.
  async registerAndBackfill(actor: DeliveryActor): Promise<{ ok: boolean; text: string }> {
    const r = await this.registerWebhook(actor);
    if (!r.ok) return { ok: false, text: `Could not register the webhook: ${r.error}` };
    const started = await this.startBackfill();
    const tail =
      started === "running"
        ? "A month import is already running."
        : started === "in-process"
          ? "Importing the last month now (Temporal was unavailable, so it runs in this process; press again if the bot restarts before it finishes)."
          : "Importing the last month in the background.";
    return { ok: true, text: `Webhook registered at ${r.url}. ${tail}` };
  }

  // ---- backfill ----

  // Pages GET /emails newest-first until an email older than BACKFILL_DAYS
  // shows up. The client's own throttle keeps this well under the team's rate
  // limit (Postiz sends on the same budget). `after` resumes a walk a retried
  // activity left behind; `onPage` is the heartbeat.
  async backfill(opts: {
    after?: string | null;
    onPage?: (cursor: string, scanned: number) => void;
    nowMs?: number;
  } = {}): Promise<{ scanned: number; created: number }> {
    const cutoff = (opts.nowMs ?? Date.now()) - BACKFILL_DAYS * 86_400_000;
    let after = opts.after ?? null;
    let scanned = 0;
    let created = 0;
    for (;;) {
      const page = await this.client.listEmails({ after, limit: 100 });
      const inWindow = page.items.filter((m) => m.createdAt && m.createdAt.getTime() >= cutoff);
      created += await this.store.insertBackfill(inWindow);
      scanned += page.items.length;
      const last = page.items[page.items.length - 1];
      const reachedEnd =
        !page.hasMore || !last || inWindow.length < page.items.length || (last.createdAt && last.createdAt.getTime() < cutoff);
      if (reachedEnd) break;
      after = last.id;
      opts.onPage?.(after, scanned);
    }
    return { scanned, created };
  }

  async recordBackfill(status: string): Promise<void> {
    await this.settings.recordResendBackfill(status);
    logLog.info("resend backfill finished", { "resend.backfill_status": status });
  }

  // ---- retention ----

  async purge(nowMs: number = Date.now()): Promise<number> {
    return this.store.purgeOlderThan(new Date(nowMs - RETENTION_DAYS * 86_400_000));
  }

  // ---- reads ----

  async historyFor(email: string, page: number, pageSize: number): Promise<{ rows: LoggedEmail[]; total: number }> {
    return this.store.listFor([email], page, pageSize);
  }

  async historyForMany(emails: string[], page: number, pageSize: number): Promise<{ rows: LoggedEmail[]; total: number }> {
    return this.store.listFor(emails, page, pageSize);
  }

  async email(emailId: string): Promise<{ email: LoggedEmail; events: LoggedEvent[] } | null> {
    const row = await this.store.get(emailId);
    if (!row) return null;
    return { email: row, events: await this.store.eventsFor(emailId) };
  }

  // Admin-only (callers check): a link that shows the email as sent. Audited
  // with who asked and which email, never the link itself.
  async share(emailId: string, actor: DeliveryActor): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const row = await this.store.get(emailId).catch(() => null);
    try {
      const shared = await this.client.shareEmail(emailId, SHARE_TTL);
      if (!shared) return { ok: false, error: "Resend no longer has that email." };
      void this.audit?.log({
        title: "🔗 Resend email share link created",
        severity: "warn",
        actor: actor.name,
        fields: [
          { name: "Email", value: row?.subject ? `${row.subject.slice(0, 100)} (${emailId})` : emailId, inline: false },
          ...(row ? [{ name: "Recipient", value: row.recipient, inline: true }] : []),
          { name: "Valid for", value: SHARE_TTL_LABEL, inline: true },
          { name: "From", value: actor.surface, inline: true },
        ],
      });
      return { ok: true, url: shared.url };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof ResendHttpError) {
    if (e.code === "restricted_api_key") return "The Resend key can only send email; a Full access key is needed.";
    if (e.status === 429) return "Resend is rate limiting; try again in a moment.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
