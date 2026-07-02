import { PrismaClient, CannedResponse } from "../generated/prisma/client";

// Reply templates for /canned. ownerId null = shared with the whole team;
// otherwise the template is personal to that Discord user. Mirrors SettingsStore's
// cached-list pattern so autocomplete reads never hit the DB.
export class CannedResponseStore {
  private responses: CannedResponse[] = [];

  constructor(private prisma: PrismaClient) {}

  async load(): Promise<void> {
    this.responses = await this.prisma.cannedResponse.findMany({ orderBy: { name: "asc" } });
  }

  // Everything a user can see: team-wide templates plus their own personal ones.
  listFor(userId: string): CannedResponse[] {
    return this.responses.filter((r) => !r.ownerId || r.ownerId === userId);
  }

  // Autocomplete submits ids; hand-typed input arrives as a name. A personal
  // template shadows a team one with the same name for its owner. Never resolves
  // another user's personal template.
  resolve(idOrName: string, userId: string): CannedResponse | undefined {
    const byId = this.responses.find((r) => r.id === idOrName);
    if (byId) return !byId.ownerId || byId.ownerId === userId ? byId : undefined;
    const name = normalizeName(idOrName);
    const visible = this.listFor(userId);
    return visible.find((r) => r.name === name && r.ownerId === userId) ?? visible.find((r) => r.name === name);
  }

  getExact(name: string, ownerId: string | null): CannedResponse | undefined {
    const normalized = normalizeName(name);
    return this.responses.find((r) => r.name === normalized && r.ownerId === ownerId);
  }

  async add(name: string, content: string, ownerId: string | null): Promise<CannedResponse> {
    const normalized = normalizeName(name);
    if (!normalized) throw new Error("Name is required.");
    if (this.getExact(normalized, ownerId)) {
      throw new Error(
        ownerId
          ? `You already have a personal canned response named \`${normalized}\`.`
          : `A team canned response named \`${normalized}\` already exists.`
      );
    }
    const created = await this.prisma.cannedResponse.create({
      data: { name: normalized, content, ownerId },
    });
    await this.load();
    return created;
  }

  async remove(id: string): Promise<void> {
    await this.prisma.cannedResponse.delete({ where: { id } });
    await this.load();
  }
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
