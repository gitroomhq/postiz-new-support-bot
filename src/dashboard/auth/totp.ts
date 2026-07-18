import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

// Dependency-free RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) — the
// dashboard's fallback second factor when no passkey is reachable. The
// accepted step is persisted (dashboard_credentials.lastUsedStep) so a
// captured code can never be replayed within its window.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// ±1 step of clock skew.
const WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer | null {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

// Verify within ±WINDOW steps; the matched step must be NEWER than the last
// accepted one (replay guard). Constant-time code compare.
export function verifyTotp(
  secret: Buffer,
  code: string,
  lastUsedStep: number | null,
  nowMs = Date.now()
): { ok: true; step: number } | { ok: false } {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false };
  const now = currentStep(nowMs);
  for (let offset = -WINDOW; offset <= WINDOW; offset++) {
    const step = now + offset;
    if (step <= (lastUsedStep ?? -1)) continue;
    if (ctEqual(totpCode(secret, step), clean)) return { ok: true, step };
  }
  return { ok: false };
}

export function otpauthUri(accountName: string, issuer: string, secret: Buffer): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  return (
    `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

// Constant-time comparison over hashes so differing lengths don't throw.
function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
