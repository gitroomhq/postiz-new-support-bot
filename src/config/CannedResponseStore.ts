import { PrismaClient, CannedResponse } from "../generated/prisma/client";

// Admin-managed reply templates for /canned. Mirrors SettingsStore's cached-list pattern
// so autocomplete reads never hit the DB.
export class CannedResponseStore {
  private responses: CannedResponse[] = [];

  constructor(private prisma: PrismaClient) {}

  async load(): Promise<void> {
    this.responses = await this.prisma.cannedResponse.findMany({ orderBy: { name: "asc" } });
  }

  list(): CannedResponse[] {
    return this.responses;
  }

  getByName(name: string): CannedResponse | undefined {
    const normalized = normalizeName(name);
    return this.responses.find((r) => r.name === normalized);
  }

  getById(id: string): CannedResponse | undefined {
    return this.responses.find((r) => r.id === id);
  }

  async add(name: string, content: string): Promise<CannedResponse> {
    const normalized = normalizeName(name);
    if (!normalized) throw new Error("Name is required.");
    if (this.getByName(normalized)) {
      throw new Error(`A canned response named \`${normalized}\` already exists.`);
    }
    const created = await this.prisma.cannedResponse.create({
      data: { name: normalized, content },
    });
    await this.load();
    return created;
  }

  async edit(id: string, name: string, content: string): Promise<CannedResponse> {
    const normalized = normalizeName(name);
    if (!normalized) throw new Error("Name is required.");
    const clash = this.getByName(normalized);
    if (clash && clash.id !== id) {
      throw new Error(`A canned response named \`${normalized}\` already exists.`);
    }
    const updated = await this.prisma.cannedResponse.update({
      where: { id },
      data: { name: normalized, content },
    });
    await this.load();
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.prisma.cannedResponse.delete({ where: { id } });
    await this.load();
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}
