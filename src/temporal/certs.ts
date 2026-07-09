import { X509Certificate, createPrivateKey } from "node:crypto";
import type { VaultService } from "../vault/VaultService";

// mTLS material for the Temporal connection. Vault-only by design (no local
// encrypted fallback, unlike the token-shaped GLOBAL_SECRETS): the material is
// only needed while Temporal is enabled, and a cold Vault cache simply leaves
// the connection "down" until the probe loop warms it.

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

// Reads from the in-memory KV cache (sync); null = not entered yet or cache
// cold. Field names match what the Certificates modal writes.
export function loadTemporalTls(vault: VaultService): TemporalTlsMaterial | null {
  const cert = vault.getCachedKvField("temporal", "clientCertPem");
  const key = vault.getCachedKvField("temporal", "clientKeyPem");
  if (!cert || !key) return null;
  return { clientCertPem: cert, clientKeyPem: key, caPem: vault.getCachedKvField("temporal", "caPem") };
}

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
