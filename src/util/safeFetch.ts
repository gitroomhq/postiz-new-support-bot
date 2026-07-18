import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF-hardened wrapper around global fetch for URLs whose value is influenced
// by external systems (Intercom webhook attachment/inline-image URLs, Stripe
// file URLs, Discord-CDN dispute evidence). Never let one of those URLs steer a
// server-side request at an internal address — the bot process holds a
// full-access Stripe key and Vault access, so metadata/internal-service SSRF is
// a real escalation path.
//
// Defenses (all must pass, on the initial URL and on every redirect hop):
//  - https only (http allowed solely for explicit localhost dev opt-in).
//  - Host allowlist (exact host or a ".suffix" parent-domain match).
//  - DNS resolution → reject any answer in a private/loopback/link-local/ULA
//    range (defeats an allowlisted host whose DNS points inward, and rebind).
//  - redirect: "manual" — we re-validate each Location ourselves rather than
//    trusting undici's default auto-follow.

export interface SafeFetchOptions {
  // Allowed hosts. An entry starting with "." matches that domain and any
  // subdomain (".intercomcdn.com" ⇒ media.intercomcdn.com); otherwise exact.
  allowHosts: string[];
  // Max redirect hops to follow (each re-validated). Default 3.
  maxRedirects?: number;
  // Per-attempt abort signal (callers pass their own timeout budget).
  signal?: AbortSignal;
  // Opt-in http for localhost dev only.
  allowLocalhostHttp?: boolean;
  // Extra request headers (e.g. an Authorization the caller only wants sent
  // once the host has been asserted).
  headers?: Record<string, string>;
}

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly reason: "scheme" | "host" | "private_ip" | "too_many_redirects" | "bad_url"
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

function hostAllowed(host: string, allowHosts: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowHosts) {
    const e = entry.toLowerCase();
    if (e.startsWith(".")) {
      if (h === e.slice(1) || h.endsWith(e)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

// RFC1918 / loopback / link-local / CGNAT / ULA / unspecified — the ranges an
// SSRF payload aims for. Operates on a resolved IP literal.
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable ⇒ refuse
    const [a, b] = p;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true; // link-local + ULA
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
    const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not an IP literal ⇒ refuse (we only pass resolved literals here)
}

// Validate scheme + host allowlist + that every DNS answer is public.
async function assertSafeUrl(raw: string, opts: SafeFetchOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError(`unparseable url`, "bad_url");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(opts.allowLocalhostHttp && isLocalhost && url.protocol === "http:")) {
    throw new SafeFetchError(`scheme not allowed: ${url.protocol}`, "scheme");
  }
  if (!hostAllowed(url.hostname, opts.allowHosts)) {
    throw new SafeFetchError(`host not allowlisted: ${url.hostname}`, "host");
  }
  // If the host is already an IP literal, validate it directly; else resolve.
  if (isIP(url.hostname)) {
    if (isPrivateIp(url.hostname)) throw new SafeFetchError(`private ip: ${url.hostname}`, "private_ip");
    return url;
  }
  const answers = await lookup(url.hostname, { all: true }).catch(() => {
    throw new SafeFetchError(`dns resolution failed: ${url.hostname}`, "host");
  });
  if (!answers.length) throw new SafeFetchError(`no dns answer: ${url.hostname}`, "host");
  for (const a of answers) {
    if (isPrivateIp(a.address)) throw new SafeFetchError(`resolves to private ip: ${a.address}`, "private_ip");
  }
  return url;
}

// Drop-in for `fetch` with SSRF guards. Throws SafeFetchError on any policy
// violation (callers decide the fallback — e.g. relay a masked link instead).
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, opts);
    const res = await fetch(current, {
      redirect: "manual",
      signal: opts.signal,
      headers: opts.headers,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location")!;
      // Resolve relative redirects against the current URL, then re-validate.
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new SafeFetchError(`too many redirects`, "too_many_redirects");
}
