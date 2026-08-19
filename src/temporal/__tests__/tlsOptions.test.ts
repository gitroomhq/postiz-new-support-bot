import { test } from "node:test";
import assert from "node:assert/strict";
import { temporalTlsOptions } from "../certs";
import { FIXTURE_CERT_PEM, FIXTURE_KEY_PEM } from "./certFixture";

// The SDK reads a falsy `tls` as "plaintext". Both connect sites (client
// Connection + worker NativeConnection) go through this helper, so the two can
// never disagree about whether the hop is encrypted.

const MATERIAL = { clientCertPem: FIXTURE_CERT_PEM, clientKeyPem: FIXTURE_KEY_PEM, caPem: null };

test("no material = undefined, the SDK's plaintext mode", () => {
  assert.equal(temporalTlsOptions({ tlsServerName: null }, null), undefined);
  // A stored SNI must not resurrect TLS on its own.
  assert.equal(temporalTlsOptions({ tlsServerName: "frontend.example.com" }, null), undefined);
});

test("material builds the mTLS pair, with SNI only when set", () => {
  const plain = temporalTlsOptions({ tlsServerName: null }, MATERIAL);
  assert.ok(plain?.clientCertPair);
  assert.equal(plain.clientCertPair.crt.toString(), FIXTURE_CERT_PEM);
  assert.equal(plain.clientCertPair.key.toString(), FIXTURE_KEY_PEM);
  assert.equal("serverNameOverride" in plain, false);
  assert.equal("serverRootCACertificate" in plain, false);

  const withSni = temporalTlsOptions({ tlsServerName: "frontend.example.com" }, MATERIAL);
  assert.equal(withSni?.serverNameOverride, "frontend.example.com");
});

test("a CA is passed through when present", () => {
  const opts = temporalTlsOptions({ tlsServerName: null }, { ...MATERIAL, caPem: FIXTURE_CERT_PEM });
  assert.equal(opts?.serverRootCACertificate?.toString(), FIXTURE_CERT_PEM);
});
