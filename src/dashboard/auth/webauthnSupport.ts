import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";

// Thin passkey layer for the dashboard: option generation, response
// verification and the single-use challenge ledger. RP identity derives from
// resolvedPublicBaseUrl() — rpID is its hostname, expectedOrigin the full
// origin, so the passkey assertion is cryptographically bound to OUR origin
// (this is what makes the login phishing-immune).

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_CHALLENGES = 200;

export interface RpIdentity {
  rpID: string; // hostname, e.g. "bot.example.com"
  origin: string; // "https://bot.example.com"
  rpName: string;
}

export function rpFromBaseUrl(baseUrl: string | null): RpIdentity | null {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    return { rpID: u.hostname, origin: u.origin, rpName: "Billing dashboard" };
  } catch {
    return null;
  }
}

// Outstanding WebAuthn challenges — in-memory, single-use, 2-min TTL. The
// challenge string itself is the key (it is server-generated 32-byte random).
export class ChallengeStore {
  private challenges = new Map<string, number>();

  remember(challenge: string): void {
    this.prune();
    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
    this.challenges.set(challenge, Date.now());
  }

  // True exactly once per challenge, inside the TTL.
  consume(challenge: string): boolean {
    this.prune();
    if (!this.challenges.has(challenge)) return false;
    this.challenges.delete(challenge);
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - CHALLENGE_TTL_MS;
    for (const [c, at] of this.challenges) {
      if (at < cutoff) this.challenges.delete(c);
    }
  }
}

export async function makeRegistrationOptions(
  rp: RpIdentity,
  userName: string,
  excludeCredentialIds: string[]
): Promise<{ options: Awaited<ReturnType<typeof generateRegistrationOptions>>; challenge: string }> {
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName,
    attestationType: "none",
    excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      // Discoverable credential + user verification: one-touch usernameless
      // login, biometric/PIN required.
      residentKey: "required",
      userVerification: "required",
    },
  });
  return { options, challenge: options.challenge };
}

export async function checkRegistration(
  rp: RpIdentity,
  response: RegistrationResponseJSON,
  expectedChallenge: string
): Promise<{ credential: WebAuthnCredential; backedUp: boolean } | null> {
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) return null;
    return { credential: result.registrationInfo.credential, backedUp: result.registrationInfo.credentialBackedUp };
  } catch {
    return null;
  }
}

export async function makeAuthenticationOptions(
  rp: RpIdentity
): Promise<{ options: Awaited<ReturnType<typeof generateAuthenticationOptions>>; challenge: string }> {
  // No allowCredentials: discoverable credentials make the browser offer
  // whatever passkeys exist for this rpID (usernameless, no enumeration).
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
  return { options, challenge: options.challenge };
}

export async function checkAuthentication(
  rp: RpIdentity,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: WebAuthnCredential
): Promise<{ newCounter: number } | null> {
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential,
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    return { newCounter: result.authenticationInfo.newCounter };
  } catch {
    return null;
  }
}
