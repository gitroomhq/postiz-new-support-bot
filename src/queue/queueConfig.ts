// Shared by the two config surfaces (/intercom → Queue, the web Queue hub)
// and the page itself: is sign-in ready, and if not, what is missing.

export const QUEUE_EXCLUSION_KINDS = ["teams", "tags", "ticketTypes"] as const;
export type QueueExclusionKind = (typeof QUEUE_EXCLUSION_KINDS)[number];

// Intercom OAuth client ids are UUID-shaped; secrets are long URL-safe tokens.
export const QUEUE_CLIENT_ID_RE = /^[A-Za-z0-9-]{8,100}$/;
export const QUEUE_CLIENT_SECRET_RE = /^[A-Za-z0-9._~-]{8,200}$/;

export interface QueueReadinessSettings {
  queueEnabled(): boolean;
  queueOauthClientId(): string | null;
  queueOauthClientSecret(): string | null;
  intercomConfigured(): boolean;
  resolvedPublicBaseUrl(): string | null;
}

export interface QueueReadiness {
  ok: boolean;
  missing: string[];
  pageUrl: string | null;
  callbackUrl: string | null;
}

export function queueReadiness(s: QueueReadinessSettings): QueueReadiness {
  const missing: string[] = [];
  if (!s.queueEnabled()) missing.push("switched off");
  if (!s.queueOauthClientId()) missing.push("no OAuth client ID");
  if (!s.queueOauthClientSecret()) missing.push("no OAuth client secret");
  if (!s.intercomConfigured()) missing.push("the bridge's Intercom connection (/config → Integrations → Intercom)");
  const base = httpsBase(s.resolvedPublicBaseUrl());
  if (!base) missing.push("an https public URL (/config → Billing → Webhooks → Set Public URL)");
  return {
    ok: missing.length === 0,
    missing,
    pageUrl: base ? `${base}/queue` : null,
    callbackUrl: base ? `${base}/queue/oauth/callback` : null,
  };
}

// The public origin when it is https (localhost allowed for development).
export function httpsBase(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !local) return null;
    return u.origin;
  } catch {
    return null;
  }
}
