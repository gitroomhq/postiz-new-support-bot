import { PrismaClient, BotSettings, StatusTag } from "../generated/prisma/client";

export type ReminderTarget = "SUPPORT" | "CUSTOMER";

// Totals stored after each scheduled report so the next one can show trend deltas.
export type ReportSnapshot = {
  openTotal: number;
  doneTotal: number;
  total: number;
};

export interface TagInput {
  emoji: string;
  label: string;
  isInitial?: boolean;
  closesThread?: boolean;
  reminderEnabled?: boolean;
  reminderDays?: number;
  reminderTarget?: ReminderTarget;
  autoCloseAfter?: number | null;
}

const DEFAULT_TAGS: TagInput[] = [
  { emoji: "🟢", label: "Open", isInitial: true, reminderEnabled: true, reminderDays: 3, reminderTarget: "SUPPORT" },
  { emoji: "🟡", label: "Ongoing", reminderEnabled: true, reminderDays: 3, reminderTarget: "SUPPORT" },
  { emoji: "🟠", label: "Waiting for Customer", reminderEnabled: true, reminderDays: 3, reminderTarget: "CUSTOMER", autoCloseAfter: 3 },
  { emoji: "🔵", label: "Waiting for Developer", reminderEnabled: true, reminderDays: 5, reminderTarget: "SUPPORT" },
  { emoji: "🟣", label: "Testing", reminderEnabled: true, reminderDays: 5, reminderTarget: "SUPPORT" },
  { emoji: "✅", label: "Resolved", reminderEnabled: false },
  { emoji: "📁", label: "Closed", closesThread: true, reminderEnabled: false },
];

export function isUnicodeEmoji(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (s.includes(":") || s.includes("<") || s.includes(">")) return false;
  if (/[A-Za-z0-9]/.test(s)) return false;
  if (Array.from(s).length > 8) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

export class SettingsStore {
  private settings!: BotSettings;
  private tagList: StatusTag[] = [];

  constructor(private prisma: PrismaClient) {}

  async load(): Promise<void> {
    let settings = await this.prisma.botSettings.findUnique({ where: { id: "global" } });
    if (!settings) {
      settings = await this.prisma.botSettings.create({
        data: {
          id: "global",
          threadsChannelId: process.env.DISCORD_THREADS_CHANNEL_ID || null,
          supportRoleId: process.env.DISCORD_SUPPORT_ROLE_ID || null,
          githubRepo: process.env.GH_BOT_REPO || null,
        },
      });
    }
    this.settings = settings;

    if ((await this.prisma.statusTag.count()) === 0) {
      await this.prisma.statusTag.createMany({
        data: DEFAULT_TAGS.map((t, i) => ({
          emoji: t.emoji,
          label: t.label,
          isInitial: t.isInitial ?? false,
          closesThread: t.closesThread ?? false,
          reminderEnabled: t.reminderEnabled ?? false,
          reminderDays: t.reminderDays ?? 3,
          reminderTarget: t.reminderTarget ?? "SUPPORT",
          autoCloseAfter: t.autoCloseAfter ?? null,
          sortOrder: i,
        })),
      });
    }
    await this.refreshTags();
  }

  private async refreshTags(): Promise<void> {
    this.tagList = await this.prisma.statusTag.findMany({ orderBy: { sortOrder: "asc" } });
  }

  threadsChannelId(): string | null {
    return this.settings.threadsChannelId;
  }

  supportRoleId(): string | null {
    return this.settings.supportRoleId;
  }

  githubRepo(): string | null {
    return this.settings.githubRepo;
  }

  aiSolveEnabled(): boolean {
    return this.settings.aiSolveEnabled;
  }

  backfillDone(): boolean {
    return this.settings.backfillDone;
  }

  reportChannelId(): string | null {
    return this.settings.reportChannelId;
  }

  reportEnabled(): boolean {
    return this.settings.reportEnabled;
  }

  reportIntervalHours(): number {
    return this.settings.reportIntervalHours;
  }

  reportTimezone(): string {
    return this.settings.reportTimezone;
  }

  reportLastRunAt(): Date | null {
    return this.settings.reportLastRunAt;
  }

  reportLastSnapshot(): ReportSnapshot | null {
    const snap = this.settings.reportLastSnapshot as unknown;
    if (snap && typeof snap === "object" && "openTotal" in snap) {
      return snap as ReportSnapshot;
    }
    return null;
  }

  tags(): StatusTag[] {
    return this.tagList;
  }

  tagById(id: string): StatusTag | undefined {
    return this.tagList.find((t) => t.id === id);
  }

  tagByEmoji(emoji: string): StatusTag | undefined {
    return this.tagList.find((t) => t.emoji === emoji);
  }

  initialTag(): StatusTag | undefined {
    return this.tagList.find((t) => t.isInitial);
  }

  closingTag(): StatusTag | undefined {
    return this.tagList.find((t) => t.closesThread);
  }

  async updateGeneral(data: {
    threadsChannelId?: string | null;
    supportRoleId?: string | null;
    githubRepo?: string | null;
    aiSolveEnabled?: boolean;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateReport(data: {
    reportChannelId?: string | null;
    reportEnabled?: boolean;
    reportIntervalHours?: number;
    reportTimezone?: string;
  }): Promise<void> {
    // Enabling the report (re)bases the cadence clock so the first post lands one full
    // interval from now rather than firing immediately on the next scheduler tick.
    const rebase = data.reportEnabled === true && !this.settings.reportEnabled;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { ...data, ...(rebase ? { reportLastRunAt: new Date() } : {}) },
    });
  }

  async recordReportRun(snapshot: ReportSnapshot): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { reportLastRunAt: new Date(), reportLastSnapshot: snapshot },
    });
  }

  async markBackfillDone(): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { backfillDone: true },
    });
  }

  async addTag(input: TagInput): Promise<StatusTag> {
    if (this.tagByEmoji(input.emoji.trim())) {
      throw new Error(`A tag with the emoji ${input.emoji.trim()} already exists.`);
    }
    const nextOrder = this.tagList.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
    const created = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.statusTag.updateMany({ data: { isInitial: false } });
      }
      return tx.statusTag.create({
        data: {
          emoji: input.emoji.trim(),
          label: input.label.trim(),
          isInitial: input.isInitial ?? false,
          closesThread: input.closesThread ?? false,
          reminderEnabled: input.reminderEnabled ?? false,
          reminderDays: input.reminderDays ?? 3,
          reminderTarget: input.reminderTarget ?? "SUPPORT",
          autoCloseAfter: input.autoCloseAfter ?? null,
          sortOrder: nextOrder,
        },
      });
    });
    await this.refreshTags();
    return created;
  }

  async editTag(id: string, input: Partial<TagInput>): Promise<StatusTag> {
    if (input.emoji) {
      const clash = this.tagByEmoji(input.emoji.trim());
      if (clash && clash.id !== id) {
        throw new Error(`A tag with the emoji ${input.emoji.trim()} already exists.`);
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.statusTag.updateMany({ where: { id: { not: id } }, data: { isInitial: false } });
      }
      return tx.statusTag.update({
        where: { id },
        data: {
          ...(input.emoji !== undefined ? { emoji: input.emoji.trim() } : {}),
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.isInitial !== undefined ? { isInitial: input.isInitial } : {}),
          ...(input.closesThread !== undefined ? { closesThread: input.closesThread } : {}),
          ...(input.reminderEnabled !== undefined ? { reminderEnabled: input.reminderEnabled } : {}),
          ...(input.reminderDays !== undefined ? { reminderDays: input.reminderDays } : {}),
          ...(input.reminderTarget !== undefined ? { reminderTarget: input.reminderTarget } : {}),
          ...(input.autoCloseAfter !== undefined ? { autoCloseAfter: input.autoCloseAfter } : {}),
        },
      });
    });
    await this.refreshTags();
    return updated;
  }

  // Deletes a tag, reassigning any open tickets that used it back to the initial
  // tag. Returns the threadIds of reassigned tickets so callers can rename them.
  async removeTag(id: string): Promise<{ reassignedThreadIds: string[]; initial: StatusTag }> {
    const tag = this.tagById(id);
    if (!tag) throw new Error("Tag not found.");
    if (tag.isInitial) throw new Error("The initial tag can't be removed. Mark another tag as initial first.");
    const initial = this.initialTag();
    if (!initial) throw new Error("No initial tag is configured.");

    const affected = await this.prisma.ticket.findMany({
      where: { statusTagId: id, closed: false },
      select: { threadId: true },
    });

    await this.prisma.$transaction([
      this.prisma.ticket.updateMany({
        where: { statusTagId: id },
        data: {
          statusTagId: initial.id,
          lastStatusChangeAt: new Date(),
          lastReminderAt: null,
          reminderCount: 0,
          closed: false,
          closedAt: null,
        },
      }),
      this.prisma.statusTag.delete({ where: { id } }),
    ]);

    await this.refreshTags();
    return { reassignedThreadIds: affected.map((t) => t.threadId), initial };
  }
}
