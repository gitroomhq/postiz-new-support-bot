import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client";
import { parseResendDate, type SentEmail } from "./ResendClient";

// The Resend delivery log: what happened to each email Resend sent for the
// team, keyed by recipient so support can answer "I never got the email".
// Resend's own API cannot list emails by recipient, so the rows come from the
// webhook (every event, as it happens) and a one-month backfill (each email's
// last status only). Metadata only: subject, sender, status, reason. Never a
// body. Rows are kept for RETENTION_DAYS and purged by the cleanup tick.

export const RETENTION_DAYS = 180;
export const BACKFILL_DAYS = 30;

// Deliverability events only (operator decision): opens and clicks are not
// subscribed, stored or shown.
export const WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.complained",
  "email.suppressed",
] as const;

export type EmailCategory = "activation" | "password_reset" | "invite" | "login_changed" | "other";

export const CATEGORY_LABELS: Record<EmailCategory, string> = {
  activation: "Activation",
  password_reset: "Password reset",
  invite: "Team invite",
  login_changed: "Login changed",
  other: "Other",
};

export const EVENT_LABELS: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  delivery_delayed: "Delayed",
  bounced: "Bounced",
  failed: "Failed",
  complained: "Marked as spam",
  suppressed: "Suppressed",
  queued: "Queued",
  scheduled: "Scheduled",
  canceled: "Canceled",
};

// Events that mean the mail did not arrive (or the recipient rejected it).
export const PROBLEM_EVENTS = new Set(["bounced", "failed", "complained", "suppressed", "delivery_delayed"]);

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as EmailCategory] ?? category;
}

// Postiz sends without Resend tags, so the subject is the only tell. These are
// the fixed subjects in postiz-app (auth.service.ts, organization.service.ts,
// users.service.ts); every notification and digest subject falls to "other".
export function classifySubject(subject: string | null | undefined): EmailCategory {
  const s = (subject ?? "").trim();
  if (/^activate your account$/i.test(s)) return "activation";
  if (/^reset your password$/i.test(s)) return "password_reset";
  if (/ invited you to join "/i.test(s)) return "invite";
  if (/^your postiz login was changed$/i.test(s)) return "login_changed";
  return "other";
}

// Svix signing, as Resend uses it: base64(HMAC-SHA256(secret, "id.ts.body")),
// where the secret is the base64 part after "whsec_". The header may carry
// several space-separated "v1,<sig>" entries (during a rotation); any match
// passes. Timestamps outside the tolerance are refused so a captured delivery
// cannot be replayed later.
const SVIX_TOLERANCE_S = 5 * 60;

export function svixSignatureValid(
  raw: Buffer,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  secret: string,
  nowMs: number = Date.now()
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SVIX_TOLERANCE_S) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export interface LoggedEmail {
  id: string;
  recipient: string;
  fromAddress: string | null;
  subject: string | null;
  category: string;
  sentAt: Date;
  lastEvent: string;
  lastEventAt: Date;
  detail: string | null;
  source: string;
}

export interface LoggedEvent {
  type: string;
  occurredAt: Date;
  detail: string | null;
}

// Parsed from one webhook delivery; null when it is not an email event we log.
export interface ParsedEvent {
  emailId: string;
  type: string;
  occurredAt: Date;
  recipient: string;
  from: string | null;
  subject: string | null;
  sentAt: Date;
  detail: string | null;
}

type WebhookBody = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    created_at?: unknown;
    to?: unknown;
    from?: unknown;
    subject?: unknown;
    bounce?: { type?: unknown; subType?: unknown; message?: unknown } | null;
    failed?: { reason?: unknown } | null;
    suppressed?: { type?: unknown; message?: unknown } | null;
  };
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseWebhookEvent(body: unknown): ParsedEvent | null {
  const b = body as WebhookBody | null;
  const fullType = str(b?.type);
  if (!fullType || !(WEBHOOK_EVENTS as readonly string[]).includes(fullType)) return null;
  const data = b?.data;
  const emailId = str(data?.email_id);
  const to = Array.isArray(data?.to) ? data.to.map(str).filter((t): t is string => t != null) : [str(data?.to)].filter((t): t is string => t != null);
  if (!emailId || !to.length) return null;
  const type = fullType.slice("email.".length);
  const occurredAt = parseResendDate(b?.created_at) ?? new Date();
  let detail: string | null = null;
  if (type === "bounced" && data?.bounce) {
    const kind = [str(data.bounce.type), str(data.bounce.subType)].filter(Boolean).join(" / ");
    const msg = str(data.bounce.message);
    detail = [kind, msg].filter(Boolean).join(": ") || null;
  } else if (type === "failed" && data?.failed) {
    detail = str(data.failed.reason);
  } else if (type === "suppressed" && data?.suppressed) {
    detail = str(data.suppressed.message) ?? str(data.suppressed.type);
  }
  return {
    emailId,
    type,
    occurredAt,
    recipient: to[0].toLowerCase(),
    from: str(data?.from),
    subject: str(data?.subject),
    sentAt: parseResendDate(data?.created_at) ?? occurredAt,
    detail: detail ? detail.slice(0, 1000) : null,
  };
}

export class DeliveryLogStore {
  constructor(private prisma: PrismaClient) {}

  // One webhook delivery. The event row is keyed by the Svix message id, so a
  // redelivery changes nothing. The email row keeps whichever event happened
  // LAST (webhooks arrive out of order); on a timestamp tie the later stage
  // wins, so "sent" never overwrites a "delivered" stamped the same millisecond.
  // Returns false for a duplicate delivery.
  async ingest(messageId: string, e: ParsedEvent): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "resend_email_events" ("id", "emailId", "type", "occurredAt", "detail")
      VALUES (${messageId}, ${e.emailId}, ${e.type}, ${e.occurredAt}, ${e.detail})
      ON CONFLICT ("id") DO NOTHING`;
    if (inserted === 0) return false;
    const rank = eventRank(e.type);
    await this.prisma.$executeRaw`
      INSERT INTO "resend_emails"
        ("id", "recipient", "fromAddress", "subject", "category", "sentAt", "lastEvent", "lastEventAt", "detail", "source", "updatedAt")
      VALUES (${e.emailId}, ${e.recipient}, ${e.from}, ${e.subject}, ${classifySubject(e.subject)}, ${e.sentAt},
              ${e.type}, ${e.occurredAt}, ${e.detail}, 'webhook', NOW())
      ON CONFLICT ("id") DO UPDATE SET
        "fromAddress" = COALESCE("resend_emails"."fromAddress", EXCLUDED."fromAddress"),
        "subject" = COALESCE("resend_emails"."subject", EXCLUDED."subject"),
        "category" = CASE WHEN "resend_emails"."subject" IS NULL THEN EXCLUDED."category" ELSE "resend_emails"."category" END,
        "source" = 'webhook',
        "lastEvent" = CASE WHEN (EXCLUDED."lastEventAt" > "resend_emails"."lastEventAt" OR (EXCLUDED."lastEventAt" = "resend_emails"."lastEventAt" AND ${rank} >= CASE "resend_emails"."lastEvent" WHEN 'sent' THEN 1 WHEN 'delivery_delayed' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END)) THEN EXCLUDED."lastEvent" ELSE "resend_emails"."lastEvent" END,
        "detail" = CASE WHEN (EXCLUDED."lastEventAt" > "resend_emails"."lastEventAt" OR (EXCLUDED."lastEventAt" = "resend_emails"."lastEventAt" AND ${rank} >= CASE "resend_emails"."lastEvent" WHEN 'sent' THEN 1 WHEN 'delivery_delayed' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END)) THEN EXCLUDED."detail" ELSE "resend_emails"."detail" END,
        "lastEventAt" = CASE WHEN (EXCLUDED."lastEventAt" > "resend_emails"."lastEventAt" OR (EXCLUDED."lastEventAt" = "resend_emails"."lastEventAt" AND ${rank} >= CASE "resend_emails"."lastEvent" WHEN 'sent' THEN 1 WHEN 'delivery_delayed' THEN 2 WHEN 'delivered' THEN 3 ELSE 4 END)) THEN EXCLUDED."lastEventAt" ELSE "resend_emails"."lastEventAt" END,
        "updatedAt" = NOW()`;
    return true;
  }

  // Backfilled rows never overwrite a webhook row: the webhook knows more.
  // Returns how many were new.
  async insertBackfill(emails: SentEmail[]): Promise<number> {
    let created = 0;
    for (const m of emails) {
      const recipient = m.to[0]?.trim().toLowerCase();
      if (!recipient || !m.createdAt) continue;
      // An open or a click implies delivery; the log does not track engagement.
      const lastEvent = m.lastEvent === "opened" || m.lastEvent === "clicked" ? "delivered" : (m.lastEvent ?? "sent");
      const n = await this.prisma.$executeRaw`
        INSERT INTO "resend_emails"
          ("id", "recipient", "fromAddress", "subject", "category", "sentAt", "lastEvent", "lastEventAt", "detail", "source", "updatedAt")
        VALUES (${m.id}, ${recipient}, ${m.from}, ${m.subject}, ${classifySubject(m.subject)}, ${m.createdAt},
                ${lastEvent}, ${m.createdAt}, NULL, 'backfill', NOW())
        ON CONFLICT ("id") DO NOTHING`;
      created += n;
    }
    return created;
  }

  // Newest first, across one or more addresses (one person is often known by
  // their contact, Postiz and Stripe addresses).
  async listFor(recipients: string[], page: number, pageSize: number): Promise<{ rows: LoggedEmail[]; total: number }> {
    const keys = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
    if (!keys.length) return { rows: [], total: 0 };
    const where = { recipient: { in: keys } };
    const [rows, total] = await Promise.all([
      this.prisma.resendEmail.findMany({
        where,
        orderBy: { sentAt: "desc" },
        skip: Math.max(0, page) * pageSize,
        take: pageSize,
      }),
      this.prisma.resendEmail.count({ where }),
    ]);
    return { rows, total };
  }

  async get(emailId: string): Promise<LoggedEmail | null> {
    return this.prisma.resendEmail.findUnique({ where: { id: emailId } });
  }

  async eventsFor(emailId: string): Promise<LoggedEvent[]> {
    return this.prisma.resendEmailEvent.findMany({
      where: { emailId },
      orderBy: { occurredAt: "asc" },
      select: { type: true, occurredAt: true, detail: true },
      take: 50,
    });
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const [emails, events] = await Promise.all([
      this.prisma.resendEmail.deleteMany({ where: { sentAt: { lt: cutoff } } }),
      this.prisma.resendEmailEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } }),
    ]);
    return emails.count + events.count;
  }
}

// Pipeline stage, for ordering events that share a timestamp.
export function eventRank(type: string): number {
  switch (type) {
    case "sent":
      return 1;
    case "delivery_delayed":
      return 2;
    case "delivered":
      return 3;
    default:
      return 4; // bounced, failed, complained, suppressed: terminal
  }
}
