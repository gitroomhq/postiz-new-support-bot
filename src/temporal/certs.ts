import { X509Certificate, createPrivateKey } from "node:crypto";
import type { TLSConfig } from "@temporalio/client";
import { readFileSync, statSync } from "node:fs";
import { temporalTlsFilePaths, TEMPORAL_TLS_FILE_VARS } from "../config/env";
import { log } from "../util/logger";
import type { VaultService } from "../vault/VaultService";

// mTLS material for the Temporal connection. Vault KV is authoritative (no
// local encrypted fallback, unlike the token-shaped GLOBAL_SECRETS): the
// material is only needed while Temporal is enabled, and a cold Vault cache
// simply leaves the connection "down" until the probe loop warms it.
//
// The TEMPORAL_TLS_*_FILE env vars are the one bootstrap escape hatch, and
// unlike the other TEMPORAL_* vars they do NOT override: they are read only
// when KV holds no temporal entry at all, so a deploy that has already put its
// certs in Vault never silently switches to stale files on disk.

const certLog = log.child("temporal");

export interface TemporalTlsMaterial {
  clientCertPem: string;
  clientKeyPem: string;
  caPem: string | null;
}

// What the /config panel is allowed to see — never the PEM bodies themselves.
export interface TemporalCertInfo {
  fingerprint256: string;
  subject: string;
  notAfter: Date;
  daysLeft: number;
}

/** Where the material in use came from; null = none available. */
export type TemporalTlsSource = "vault" | "env-files";

// Builds the `tls` option shared by the client Connection and the worker's
// NativeConnection (both take the same TLSConfig). `undefined` is the SDK's
// plaintext mode — what a private-network frontend that terminates no TLS
// needs; handing it a TLSConfig instead dies in the handshake with a rustls
// InvalidContentType, because the ClientHello is answered in cleartext.
// Callers pass null material when TLS is off; the certs stay stored.
export function temporalTlsOptions(
  cfg: { tlsServerName: string | null },
  material: TemporalTlsMaterial | null
): TLSConfig | undefined {
  if (!material) return undefined;
  return {
    clientCertPair: {
      crt: Buffer.from(material.clientCertPem),
      key: Buffer.from(material.clientKeyPem),
    },
    ...(material.caPem ? { serverRootCACertificate: Buffer.from(material.caPem) } : {}),
    // SNI/cert-hostname override — needed when dialing by IP.
    ...(cfg.tlsServerName ? { serverNameOverride: cfg.tlsServerName } : {}),
  };
}

// Reads from the in-memory KV cache (sync), falling back to the PEM files named
// by TEMPORAL_TLS_CERT_FILE/KEY_FILE/CA_FILE. Null = not entered yet, cache
// cold, and no readable files. Field names match what the Certificates modal
// writes.
export function loadTemporalTls(vault: VaultService): TemporalTlsMaterial | null {
  const cert = vault.getCachedKvField("temporal", "clientCertPem");
  const key = vault.getCachedKvField("temporal", "clientKeyPem");
  if (!cert || !key) return loadTemporalTlsFromFiles();
  return { clientCertPem: cert, clientKeyPem: key, caPem: vault.getCachedKvField("temporal", "caPem") };
}

/** Which source the panels should name for the material currently in use. */
export function temporalTlsSource(vault: VaultService): TemporalTlsSource | null {
  if (vault.getCachedKvField("temporal", "clientCertPem") && vault.getCachedKvField("temporal", "clientKeyPem")) return "vault";
  return loadTemporalTlsFromFiles() ? "env-files" : null;
}

// Re-read only when a file's size/mtime moved, so a rotation on disk reaches
// the next reconnect without re-reading PEMs on every panel render.
type FileCacheEntry = { stamp: string; contents: string };
const fileCache = new Map<string, FileCacheEntry>();
const fileErrorsLogged = new Set<string>();

function readPemFile(path: string): string | null {
  try {
    const st = statSync(path);
    const stamp = `${st.size}:${st.mtimeMs}`;
    const cached = fileCache.get(path);
    if (cached?.stamp === stamp) return cached.contents;
    const contents = readFileSync(path, "utf8");
    fileCache.set(path, { stamp, contents });
    fileErrorsLogged.delete(path);
    return contents;
  } catch (e) {
    // Once per path until it reads again: this sits on the probe loop.
    if (!fileErrorsLogged.has(path)) {
      fileErrorsLogged.add(path);
      certLog.warn("temporal TLS file unreadable", {
        "temporal.tls_file": path,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
    fileCache.delete(path);
    return null;
  }
}

function loadTemporalTlsFromFiles(): TemporalTlsMaterial | null {
  const paths = temporalTlsFilePaths();
  if (!paths) return null;
  const clientCertPem = readPemFile(paths.cert);
  const clientKeyPem = readPemFile(paths.key);
  if (!clientCertPem || !clientKeyPem) return null;
  // A named-but-unreadable CA is a misconfiguration; failing closed here would
  // take the whole connection down, so it degrades to "no CA override" and the
  // readPemFile warning above carries the diagnosis.
  return { clientCertPem, clientKeyPem, caPem: paths.ca ? readPemFile(paths.ca) : null };
}

/** The env var names behind the file fallback, for panel copy. */
export const TLS_FILE_VARS = TEMPORAL_TLS_FILE_VARS;

// Parses the leaf cert for the panel readout. Returns null on garbage instead
// of throwing — the panel renders "unreadable" and the modal validation path
// uses validateCertPair() below for a hard error.
export function parseCertInfo(certPem: string): TemporalCertInfo | null {
  try {
    const x509 = new X509Certificate(certPem);
    const notAfter = new Date(x509.validTo);
    return {
      fingerprint256: x509.fingerprint256,
      subject: x509.subject.replace(/\n/g, ", "),
      notAfter,
      daysLeft: Math.floor((notAfter.getTime() - Date.now()) / 86_400_000),
    };
  } catch {
    return null;
  }
}

// Hard validation for the Certificates modal: reject garbage before it lands
// in Vault. Throws with a human-readable message (shown in the ephemeral
// reply); never includes any part of the submitted material.
export function validateCertPair(certPem: string, keyPem: string, caPem?: string | null): TemporalCertInfo {
  let info: TemporalCertInfo | null;
  try {
    info = parseCertInfo(certPem);
  } catch {
    info = null;
  }
  if (!info) throw new Error("Client certificate is not a valid PEM X.509 certificate.");
  try {
    createPrivateKey(keyPem);
  } catch {
    throw new Error("Client key is not a valid PEM private key.");
  }
  if (caPem) {
    try {
      // A CA input may be a chain; validating the first block catches the
      // common paste mistakes (wrong file, truncated content).
      new X509Certificate(caPem);
    } catch {
      throw new Error("CA certificate is not a valid PEM X.509 certificate.");
    }
  }
  if (info.daysLeft < 0) throw new Error("Client certificate is already expired.");
  return info;
}
