import { DashboardCredential, PrismaClient } from "../../generated/prisma/client";
import { decryptSecret, encryptSecret, isTransitCiphertext } from "../../util/crypto";
import type { VaultService } from "../../vault/VaultService";
import type { WebAuthnCredential } from "@simplewebauthn/server";
import { hashPassphrase, verifyPassphrase } from "./passphrase";
import { verifyTotp } from "./totp";

// Per-admin dashboard credentials (dashboard_credentials): any number of
// passkey/totp rows plus one passphrase row. Passkey public keys and scrypt
// hashes are not secrets; the TOTP secret is Transit-first encrypted (local
// enc:v1 fallback — SessionStore.accessToken idiom), so env-key rotation
// doesn't orphan it while Vault storage is active.

export class CredentialStore {
  private vault: VaultService | null = null;

  constructor(private prisma: PrismaClient) {}

  // Late-bound (SettingsStore.bindVault idiom).
  bindVault(vault: VaultService): void {
    this.vault = vault;
  }

  // ---- passphrase (one row per admin, upserted) ----

  async setPassphrase(discordUserId: string, passphrase: string): Promise<void> {
    const hash = hashPassphrase(passphrase);
    const existing = await this.prisma.dashboardCredential.findFirst({
      where: { discordUserId, kind: "passphrase", revokedAt: null },
    });
    if (existing) {
      await this.prisma.dashboardCredential.update({ where: { id: existing.id }, data: { hash } });
    } else {
      await this.prisma.dashboardCredential.create({ data: { discordUserId, kind: "passphrase", hash } });
    }
  }

  async hasPassphrase(discordUserId: string): Promise<boolean> {
    return (
      (await this.prisma.dashboardCredential.findFirst({
        where: { discordUserId, kind: "passphrase", revokedAt: null },
      })) != null
    );
  }

  // Constant-time; runs the dummy scrypt when no passphrase exists.
  async checkPassphrase(discordUserId: string, passphrase: string): Promise<boolean> {
    const row = await this.prisma.dashboardCredential.findFirst({
      where: { discordUserId, kind: "passphrase", revokedAt: null },
    });
    const ok = verifyPassphrase(passphrase, row?.hash ?? null);
    if (ok && row) {
      await this.prisma.dashboardCredential.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    }
    return ok;
  }

  // ---- passkeys ----

  async addPasskey(input: {
    discordUserId: string;
    label: string;
    credential: WebAuthnCredential;
    backedUp: boolean;
  }): Promise<void> {
    await this.prisma.dashboardCredential.create({
      data: {
        discordUserId: input.discordUserId,
        kind: "passkey",
        label: input.label.slice(0, 80),
        credentialId: input.credential.id,
        publicKey: Buffer.from(input.credential.publicKey).toString("base64url"),
        signCount: input.credential.counter,
        transports: input.credential.transports?.join(",") ?? null,
        backupState: input.backedUp,
      },
    });
  }

  async listPasskeys(discordUserId: string): Promise<DashboardCredential[]> {
    return this.prisma.dashboardCredential.findMany({
      where: { discordUserId, kind: "passkey", revokedAt: null },
      orderBy: { createdAt: "asc" },
    });
  }

  // Usernameless login: resolve the asserted credential id across ALL admins.
  async findPasskeyByCredentialId(credentialId: string): Promise<DashboardCredential | null> {
    const row = await this.prisma.dashboardCredential.findUnique({ where: { credentialId } });
    return row && row.kind === "passkey" && !row.revokedAt ? row : null;
  }

  toWebAuthnCredential(row: DashboardCredential): WebAuthnCredential | null {
    if (!row.credentialId || !row.publicKey) return null;
    return {
      id: row.credentialId,
      publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64url")),
      counter: row.signCount ?? 0,
      transports: row.transports ? (row.transports.split(",") as WebAuthnCredential["transports"]) : undefined,
    };
  }

  // Sign-count clone detection is WARN-only (platform authenticators
  // legitimately report 0) — the caller decides what to do with `regressed`.
  async recordPasskeyUse(id: string, newCounter: number): Promise<{ regressed: boolean }> {
    const row = await this.prisma.dashboardCredential.findUnique({ where: { id } });
    const regressed = row?.signCount != null && row.signCount > 0 && newCounter > 0 && newCounter < row.signCount;
    await this.prisma.dashboardCredential.update({
      where: { id },
      data: { signCount: newCounter, lastUsedAt: new Date() },
    });
    return { regressed };
  }

  // ---- TOTP ----

  async setTotp(discordUserId: string, secret: Buffer, label: string): Promise<void> {
    const vault = this.vault;
    const enc =
      (vault?.storageActive() && vault.state() === "up" ? await vault.transitEncrypt(secret.toString("base64")) : null) ??
      encryptSecret(secret.toString("base64"));
    // One active TOTP per admin: revoke any previous enrollment.
    await this.prisma.dashboardCredential.updateMany({
      where: { discordUserId, kind: "totp", revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.dashboardCredential.create({
      data: { discordUserId, kind: "totp", label: label.slice(0, 80), secretEnc: enc },
    });
  }

  async hasTotp(discordUserId: string): Promise<boolean> {
    return (
      (await this.prisma.dashboardCredential.findFirst({ where: { discordUserId, kind: "totp", revokedAt: null } })) !=
      null
    );
  }

  // Verifies + consumes the step (replay guard persisted on the row). null
  // secret (Vault down + Transit row) fails closed.
  async checkTotp(discordUserId: string, code: string): Promise<boolean> {
    const row = await this.prisma.dashboardCredential.findFirst({
      where: { discordUserId, kind: "totp", revokedAt: null },
    });
    if (!row?.secretEnc) return false;
    const rawB64 = isTransitCiphertext(row.secretEnc)
      ? ((await this.vault?.transitDecrypt(row.secretEnc)) ?? null)
      : decryptSecret(row.secretEnc);
    if (!rawB64) return false;
    const result = verifyTotp(Buffer.from(rawB64, "base64"), code, row.lastUsedStep);
    if (!result.ok) return false;
    await this.prisma.dashboardCredential.update({
      where: { id: row.id },
      data: { lastUsedStep: result.step, lastUsedAt: new Date() },
    });
    return true;
  }

  // ---- shared ----

  async listForUser(discordUserId: string): Promise<DashboardCredential[]> {
    return this.prisma.dashboardCredential.findMany({
      where: { discordUserId, revokedAt: null },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    });
  }

  async revoke(discordUserId: string, id: string): Promise<boolean> {
    const res = await this.prisma.dashboardCredential.updateMany({
      // Scoped to the owner: nobody revokes someone else's credential from the web.
      where: { id, discordUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count > 0;
  }

  // Discord-side "Reset my credentials": revoke everything for one admin.
  async revokeAll(discordUserId: string): Promise<number> {
    const res = await this.prisma.dashboardCredential.updateMany({
      where: { discordUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count;
  }
}
