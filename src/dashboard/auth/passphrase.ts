import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Server-side passphrase hashing for the dashboard's standing login. scrypt
// with a self-describing parameter string so parameters can be raised later
// without invalidating stored hashes:
//   scrypt:N=32768,r=8,p=1:<saltB64>:<hashB64>
// Hashes are NOT secrets (no reversible material) — stored plain in
// dashboard_credentials.hash, immune to crypto-key rotation.

const N = 32768; // 2^15
const R = 8;
const P = 1;
const KEYLEN = 32;
// N=2^15 needs ~34MB; node's default maxmem is 32MB.
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSPHRASE_LENGTH = 12;

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:N=${N},r=${R},p=${P}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

// Constant-time verify. `stored` may be null/garbage — a full dummy scrypt run
// happens anyway so "unknown user" and "wrong passphrase" are indistinguishable
// by timing (anti-oracle).
export function verifyPassphrase(passphrase: string, stored: string | null): boolean {
  const parsed = parse(stored);
  const target = parsed ?? DUMMY;
  const hash = scryptSync(passphrase, target.salt, target.hash.length, {
    N: target.N,
    r: target.r,
    p: target.p,
    maxmem: MAXMEM,
  });
  const ok = hash.length === target.hash.length && timingSafeEqual(hash, target.hash);
  return parsed != null && ok;
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string | null): Parsed | null {
  if (!stored) return null;
  const m = /^scrypt:N=(\d+),r=(\d+),p=(\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return null;
  const n = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // Bound the parameters so a corrupted row can never DoS the process.
  if (!Number.isInteger(n) || n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 4) return null;
  try {
    return { N: n, r, p, salt: Buffer.from(m[4], "base64"), hash: Buffer.from(m[5], "base64") };
  } catch {
    return null;
  }
}

// Fixed dummy target for the anti-oracle path (same parameters as real hashes).
const DUMMY: Parsed = {
  N,
  r: R,
  p: P,
  salt: Buffer.from("ZHVtbXktc2FsdC0wMDA=", "base64"),
  hash: Buffer.alloc(KEYLEN),
};
