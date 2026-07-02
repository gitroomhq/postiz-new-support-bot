import { PrismaClient, EscalationTier } from "../generated/prisma/client";

// Ordered staff ladder (position 0 = lowest). Tier 0 gets new-ticket pings and
// its members are added to ticket threads; membership in any tier role counts as
// staff. Replaces the legacy single BotSettings.supportRoleId, which survives
// only as a fallback while no tiers are configured. Mirrors CannedResponseStore's
// cached-list pattern so permission checks never hit the DB.
export class EscalationTierStore {
  private tiers: EscalationTier[] = [];

  constructor(private prisma: PrismaClient) {}

  async load(): Promise<void> {
    this.tiers = await this.prisma.escalationTier.findMany({ orderBy: { position: "asc" } });
  }

  list(): EscalationTier[] {
    return this.tiers;
  }

  byId(id: string | null | undefined): EscalationTier | undefined {
    if (!id) return undefined;
    return this.tiers.find((t) => t.id === id);
  }

  lowest(): EscalationTier | undefined {
    return this.tiers[0];
  }

  // All roles that count as staff; the legacy support role while no tiers exist.
  staffRoleIds(fallbackRoleId: string | null): string[] {
    if (this.tiers.length > 0) return this.tiers.map((t) => t.roleId);
    return fallbackRoleId ? [fallbackRoleId] : [];
  }

  // Role pinged (and added) on new tickets: the lowest tier.
  newTicketRoleId(fallbackRoleId: string | null): string | null {
    return this.lowest()?.roleId ?? fallbackRoleId;
  }

  // Role that currently owns a ticket: its escalation tier, else the base tier.
  // A stale tier id (tier deleted) falls back to the base tier too.
  pingRoleIdFor(escalationTierId: string | null | undefined, fallbackRoleId: string | null): string | null {
    return this.byId(escalationTierId)?.roleId ?? this.newTicketRoleId(fallbackRoleId);
  }

  async add(name: string, roleId: string): Promise<EscalationTier> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name is required.");
    const created = await this.prisma.escalationTier.create({
      data: { name: trimmed, roleId, position: this.tiers.length },
    });
    await this.load();
    return created;
  }

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name is required.");
    await this.prisma.escalationTier.update({ where: { id }, data: { name: trimmed } });
    await this.load();
  }

  async remove(id: string): Promise<void> {
    const remaining = this.tiers.filter((t) => t.id !== id);
    await this.prisma.$transaction([
      this.prisma.escalationTier.delete({ where: { id } }),
      ...remaining.map((t, i) =>
        this.prisma.escalationTier.update({ where: { id: t.id }, data: { position: i } })
      ),
    ]);
    await this.load();
  }

  // Swap the tier with its neighbor (dir -1 = toward the bottom of the ladder).
  async move(id: string, dir: -1 | 1): Promise<void> {
    const idx = this.tiers.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const other = idx + dir;
    if (other < 0 || other >= this.tiers.length) return;
    const order = [...this.tiers];
    [order[idx], order[other]] = [order[other], order[idx]];
    await this.prisma.$transaction(
      order.map((t, i) => this.prisma.escalationTier.update({ where: { id: t.id }, data: { position: i } }))
    );
    await this.load();
  }

  // One-time migration: turn the legacy support role into tier 0 so existing
  // installs keep working. No-op once any tier exists, so it's safe on every boot.
  async seedFromLegacySupportRole(supportRoleId: string | null): Promise<boolean> {
    if (this.tiers.length > 0 || !supportRoleId) return false;
    await this.prisma.escalationTier.create({
      data: { name: "Support", roleId: supportRoleId, position: 0 },
    });
    await this.load();
    return true;
  }
}
