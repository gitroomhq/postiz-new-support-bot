import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { safeFetch } from "../../util/safeFetch";

// YubiKey OTP (Yubico OTP scheme, NOT WebAuthn): the key types a one-time
// password whose prefix is the key's public ID; the encrypted part is
// verified remotely against a Yubico validation server (YubiCloud by
// default). We store only the public ID per admin — replay protection lives
// in the validation server's session/usage counters, and we additionally
// bind each request to a random nonce and (when an API secret is set) an
// HMAC-SHA1 request/response signature.

export const YUBICO_DEFAULT_VERIFY_URL = "https://api.yubico.com/wsapi/2.0/verify";

// Modhex: the keyboard-layout-independent alphabet YubiKeys type.
const MODHEX_RE = /^[cbdefghijklnrtuv]+$/;

export interface ParsedYubiOtp {
  publicId: string; // modhex prefix identifying the key (typically 12 chars)
  otp: string; // full normalized OTP
}

// A Yubico OTP is 32 modhex chars of ciphertext preceded by a 0-16 char
// public ID. We require a non-empty public ID (we need it to look the key
// up), so 33-48 total.
export function parseYubiOtp(raw: string): ParsedYubiOtp | null {
  const otp = raw.trim().toLowerCase();
  if (otp.length < 33 || otp.length > 48) return null;
  if (!MODHEX_RE.test(otp)) return null;
  return { publicId: otp.slice(0, otp.length - 32), otp };
}

export type YubiVerifyReason =
  | "not_configured"
  | "bad_otp"
  | "replayed_otp"
  | "bad_signature"
  | "backend_error"
  | "unreachable";

export interface YubiVerifyConfig {
  clientId: string;
  apiSecret: string | null; // base64; enables request/response signing
  verifyUrl: string | null; // null = YubiCloud
}

// Minimal fetch-shaped dependency so tests can inject a fake transport.
export type YubiFetch = (url: string, opts: { allowHosts: string[]; signal?: AbortSignal }) => Promise<Response>;

function signParams(params: Record<string, string>, secretB64: string): string {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHmac("sha1", Buffer.from(secretB64, "base64")).update(message).digest("base64");
}

function ctEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Parses the plaintext "key=value" response body. Values may contain "="
// (the base64 signature does), so split on the first separator only.
function parseResponse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// Verifies one OTP against the validation server. Fails CLOSED on any
// transport error, signature mismatch or echo mismatch — a yubikey login
// must never succeed on ambiguity.
export async function verifyYubiOtp(
  otp: string,
  config: YubiVerifyConfig,
  fetchImpl: YubiFetch = safeFetch
): Promise<{ ok: true } | { ok: false; reason: YubiVerifyReason }> {
  if (!config.clientId) return { ok: false, reason: "not_configured" };
  const nonce = randomBytes(16).toString("hex");
  const params: Record<string, string> = { id: config.clientId, otp, nonce };
  if (config.apiSecret) params.h = signParams({ id: config.clientId, otp, nonce }, config.apiSecret);
  const base = (config.verifyUrl ?? YUBICO_DEFAULT_VERIFY_URL).replace(/\?.*$/, "");
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return { ok: false, reason: "not_configured" };
  }
  let body: string;
  try {
    const res = await fetchImpl(`${base}?${query}`, { allowHosts: [host], signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: "backend_error" };
    body = await res.text();
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const fields = parseResponse(body);
  // The response must echo OUR otp and nonce — otherwise a replayed/foreign
  // validation response is being spliced in.
  if (fields.otp !== otp || fields.nonce !== nonce) return { ok: false, reason: "bad_signature" };
  if (config.apiSecret) {
    const h = fields.h ?? "";
    const expected = signParams(
      Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "h")),
      config.apiSecret
    );
    if (!h || !ctEqual(h, expected)) return { ok: false, reason: "bad_signature" };
  }
  switch (fields.status) {
    case "OK":
      return { ok: true };
    case "REPLAYED_OTP":
    case "REPLAYED_REQUEST":
      return { ok: false, reason: "replayed_otp" };
    case "BAD_OTP":
    case "NO_SUCH_CLIENT":
      return { ok: false, reason: "bad_otp" };
    case "BAD_SIGNATURE":
      return { ok: false, reason: "bad_signature" };
    default:
      // MISSING_PARAMETER / OPERATION_NOT_ALLOWED / BACKEND_ERROR /
      // NOT_ENOUGH_ANSWERS / anything unknown.
      return { ok: false, reason: "backend_error" };
  }
}
