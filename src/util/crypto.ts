import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { log } from "./logger";

// Application-level encryption (AES-256-GCM) for secrets stored in Postgres:
// Postiz OAuth access tokens, the Intercom app credentials, and the Stripe
// webhook signing secret. Goal: a database dump alone must not yield usable
// credentials.
//
// KEY DERIVATION — the crux. The AES key is HKDF-derived from three secrets that
// are always present in the deploy environment but are NOT stored in the app's
// own database: STRIPE_SECRET_KEY, DATABASE_URL and DISCORD_TOKEN. So decryption
// needs the live environment, not just a table dump. Combining all three raises
// the bar to "DB dump PLUS every env secret"; the tradeoff is that rotating ANY
// of the three orphans existing ciphertext. decryptSecret fails SOFT (returns
// null) in that case, and the affected secret is simply re-entered / re-authed.
// A new dedicated key env var can't be used because the deploy env is fixed, so
// an already-present secret is reused as the key source instead.

const VERSION = "v1";
const PREFIX = `enc:${VERSION}:`;
// Domain-separation constants baked into the derivation (these are not secrets).
const SALT = "postiz-support-bot:secret-enc:v1";
const INFO = "aes-256-gcm secret wrap";

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const stripe = process.env.STRIPE_SECRET_KEY;
  const db = process.env.DATABASE_URL;
  const discord = process.env.DISCORD_TOKEN;
  if (!stripe || !db || !discord) {
    // All three are required() at config load, so this can't happen at runtime;
    // guard anyway so a misconfigured shell fails loudly instead of deriving a
    // weak key from partial input.
    throw new Error(
      "crypto: STRIPE_SECRET_KEY, DATABASE_URL and DISCORD_TOKEN must all be set to derive the encryption key."
    );
  }
  // NUL separators keep the concatenation unambiguous (no secret contains \x00).
  const ikm = `${stripe}\x00${db}\x00${discord}`;
  cachedKey = Buffer.from(hkdfSync("sha256", ikm, SALT, INFO, 32));
  return cachedKey;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

// Returns the value unchanged when empty (preserves "cleared" semantics) or when
// already encrypted (no double-wrap). Format: enc:v1:<ivB64>:<tagB64>:<ctB64>.
// Base64 never contains ':', so the 5-part split on read is unambiguous.
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

// Transparent decrypt. A non-`enc:` value is legacy plaintext and is returned
// verbatim — this is the lazy migration: old rows keep working, and the next
// write re-persists them encrypted. On any failure (tampering, or a rotated key
// source) it logs and returns null so callers treat the secret as absent rather
// than crashing.
export function decryptSecret(value: string): string | null {
  if (!isEncrypted(value)) return value;
  try {
    const [, , ivB64, tagB64, ctB64] = value.split(":");
    if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed ciphertext envelope");
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    log.child("crypto").error("secret decrypt failed", e);
    return null;
  }
}
