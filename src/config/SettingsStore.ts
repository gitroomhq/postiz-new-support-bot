import { Prisma, PrismaClient, BotSettings, StatusTag, PriorityTag } from "../generated/prisma/client";

export type ReminderTarget = "SUPPORT" | "CUSTOMER";

export type IntercomMode = "none" | "push" | "bi";
export type IntercomRegion = "us" | "eu" | "au";

// Totals stored after each scheduled report so the next one can show trend deltas.
export type ReportSnapshot = {
  openTotal: number;
  doneTotal: number;
  total: number;
  overdueTotal: number;
  // Absent in snapshots stored before this field existed; those simply show no delta.
  awaitingTotal?: number;
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
  // autoCloseAfter on Resolved is read as DAYS of customer silence before the ticket
  // is auto-closed (locked); on reminder tags it counts reminder rounds instead.
  { emoji: "✅", label: "Resolved", reminderEnabled: false, autoCloseAfter: 3 },
  { emoji: "📁", label: "Closed", closesThread: true, reminderEnabled: false },
];

export interface PriorityInput {
  emoji: string;
  label: string;
  isInitial?: boolean;
}

const DEFAULT_PRIORITIES: PriorityInput[] = [
  { emoji: "⬜", label: "Very Low" },
  { emoji: "🟩", label: "Low" },
  { emoji: "🟨", label: "Medium", isInitial: true },
  { emoji: "🟧", label: "High" },
  { emoji: "🟥", label: "Very High" },
  { emoji: "🚨", label: "Critical" },
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
  private priorityList: PriorityTag[] = [];

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

    if ((await this.prisma.priorityTag.count()) === 0) {
      await this.prisma.priorityTag.createMany({
        data: DEFAULT_PRIORITIES.map((p, i) => ({
          emoji: p.emoji,
          label: p.label,
          isInitial: p.isInitial ?? false,
          sortOrder: i,
        })),
      });
    }
    await this.refreshPriorities();
  }

  private async refreshTags(): Promise<void> {
    this.tagList = await this.prisma.statusTag.findMany({ orderBy: { sortOrder: "asc" } });
  }

  private async refreshPriorities(): Promise<void> {
    this.priorityList = await this.prisma.priorityTag.findMany({ orderBy: { sortOrder: "asc" } });
  }

  threadsChannelId(): string | null {
    return this.settings.threadsChannelId;
  }

  // Deprecated: staff roles live in EscalationTierStore now. This survives only
  // as the fallback while no tiers are configured (and to seed tier 1 once).
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
 
  reportHour(): number | null {
    return this.settings.reportHour;
  }
 
  reportMinute(): number | null {
    return this.settings.reportMinute;
  }
 
  reportTimezone(): string {
    return this.settings.reportTimezone;
  }

  overdueThresholdDays(): number {
    return this.settings.overdueThresholdDays;
  }

  reportLastRunAt(): Date | null {
    return this.settings.reportLastRunAt;
  }

  // 0 = disabled for both ticket limits.
  maxOpenTicketsPerUser(): number {
    return this.settings.maxOpenTicketsPerUser;
  }

  ticketCooldownMinutes(): number {
    return this.settings.ticketCooldownMinutes;
  }

  billingAuditChannelId(): string | null {
    return this.settings.billingAuditChannelId;
  }

  auditLogChannelId(): string | null {
    return this.settings.auditLogChannelId;
  }

  // null = guardrail disabled. Amount is in minor units of refundMaxAmountCurrency.
  refundMaxAmount(): number | null {
    return this.settings.refundMaxAmount;
  }

  refundMaxAmountCurrency(): string {
    return this.settings.refundMaxAmountCurrency;
  }

  refundMaxPer24h(): number | null {
    return this.settings.refundMaxPer24h;
  }

  refundMinMemberAgeDays(): number | null {
    return this.settings.refundMinMemberAgeDays;
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

  priorities(): PriorityTag[] {
    return this.priorityList;
  }

  priorityById(id: string): PriorityTag | undefined {
    return this.priorityList.find((p) => p.id === id);
  }

  priorityByEmoji(emoji: string): PriorityTag | undefined {
    return this.priorityList.find((p) => p.emoji === emoji);
  }

  initialPriority(): PriorityTag | undefined {
    return this.priorityList.find((p) => p.isInitial);
  }

  // ---- Intercom bridge ----
  // Credentials can come from the DB (/config panel, wins) or from env vars —
  // the deploy may provide either; the panel edits the DB copy live.

  intercomMode(): IntercomMode {
    const mode = this.settings.intercomMode;
    return mode === "push" || mode === "bi" ? mode : "none";
  }

  intercomRegion(): IntercomRegion {
    const region = this.settings.intercomRegion ?? process.env.INTERCOM_REGION;
    return region === "eu" || region === "au" ? region : "us";
  }

  intercomAccessToken(): string | null {
    return this.settings.intercomAccessToken ?? process.env.INTERCOM_ACCESS_TOKEN ?? null;
  }

  intercomClientSecret(): string | null {
    return this.settings.intercomClientSecret ?? process.env.INTERCOM_CLIENT_SECRET ?? null;
  }

  intercomAdminId(): string | null {
    return this.settings.intercomAdminId ?? process.env.INTERCOM_ADMIN_ID ?? null;
  }

  intercomOperatorAdminId(): string | null {
    return this.settings.intercomOperatorAdminId;
  }

  // Identity used for admin-side API calls: the auto-detected Operator/Fin bot
  // when available (no seat cost), otherwise the configured admin.
  intercomAuthorAdminId(): string | null {
    return this.intercomOperatorAdminId() ?? this.intercomAdminId();
  }

  intercomTicketTypeMap(): Record<string, string> {
    const map = this.settings.intercomTicketTypeMap as unknown;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      return map as Record<string, string>;
    }
    return {};
  }

  intercomTicketTypeIdFor(categoryId: string | null): string | null {
    const map = this.intercomTicketTypeMap();
    return (categoryId ? map[categoryId] : undefined) ?? map["_default"] ?? null;
  }

  intercomConfigured(): boolean {
    return Boolean(this.intercomAccessToken() && this.intercomAuthorAdminId() && this.intercomTicketTypeIdFor(null));
  }

  async updateIntercom(data: {
    intercomMode?: IntercomMode;
    intercomRegion?: IntercomRegion;
    intercomAccessToken?: string | null;
    intercomClientSecret?: string | null;
    intercomAdminId?: string | null;
    intercomOperatorAdminId?: string | null;
    intercomTicketTypeMap?: Record<string, string> | null;
  }): Promise<void> {
    const { intercomTicketTypeMap, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        // Nullable JSON columns need the DbNull sentinel instead of null.
        ...(intercomTicketTypeMap !== undefined
          ? { intercomTicketTypeMap: intercomTicketTypeMap ?? Prisma.DbNull }
          : {}),
      },
    });
  }

  async setTagIntercomState(tagId: string, stateId: string | null): Promise<void> {
    await this.prisma.statusTag.update({ where: { id: tagId }, data: { intercomTicketStateId: stateId } });
    await this.refreshTags();
  }

  async updateGeneral(data: {
    threadsChannelId?: string | null;
    supportRoleId?: string | null;
    githubRepo?: string | null;
    aiSolveEnabled?: boolean;
    maxOpenTicketsPerUser?: number;
    ticketCooldownMinutes?: number;
    auditLogChannelId?: string | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateBilling(data: {
    billingAuditChannelId?: string | null;
    refundMaxAmount?: number | null;
    refundMaxAmountCurrency?: string;
    refundMaxPer24h?: number | null;
    refundMinMemberAgeDays?: number | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateReport(data: {
    reportChannelId?: string | null;
    reportEnabled?: boolean;
    reportIntervalHours?: number;
    reportHour?: number | null;
    reportMinute?: number | null;
    reportTimezone?: string;
    overdueThresholdDays?: number;
  }): Promise<void> {
    const merged = { ...this.settings, ...data };
    const usesScheduledTime = merged.reportHour != null && merged.reportMinute != null;

    // reportLastRunAt records actual posts; the scheduler's once-per-day guard relies on that.
    // Only interval mode rebases it on enable, so the first post lands one full interval out
    // instead of firing immediately on the next tick. In scheduled-time mode we leave it
    // untouched: stamping "now" would make the daily guard skip today's scheduled run (the
    // original bug), and clearing it would let a later reconfigure re-post on a day a report
    // already went out (the double-post).
    const rebase = data.reportEnabled === true && !this.settings.reportEnabled && !usesScheduledTime;

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
    // Status and priority emojis must stay disjoint — thread-title parsing tells
    // the two slots apart by which list the emoji belongs to.
    if (this.priorityByEmoji(input.emoji.trim())) {
      throw new Error(`The emoji ${input.emoji.trim()} is already used by a priority.`);
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
      if (this.priorityByEmoji(input.emoji.trim())) {
        throw new Error(`The emoji ${input.emoji.trim()} is already used by a priority.`);
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

  async addPriority(input: PriorityInput): Promise<PriorityTag> {
    const emoji = input.emoji.trim();
    if (this.priorityByEmoji(emoji)) {
      throw new Error(`A priority with the emoji ${emoji} already exists.`);
    }
    if (this.tagByEmoji(emoji)) {
      throw new Error(`The emoji ${emoji} is already used by a status tag.`);
    }
    const nextOrder = this.priorityList.reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;
    const created = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.priorityTag.updateMany({ data: { isInitial: false } });
      }
      return tx.priorityTag.create({
        data: {
          emoji,
          label: input.label.trim(),
          isInitial: input.isInitial ?? false,
          sortOrder: nextOrder,
        },
      });
    });
    await this.refreshPriorities();
    return created;
  }

  async editPriority(id: string, input: Partial<PriorityInput>): Promise<PriorityTag> {
    if (input.emoji) {
      const emoji = input.emoji.trim();
      const clash = this.priorityByEmoji(emoji);
      if (clash && clash.id !== id) {
        throw new Error(`A priority with the emoji ${emoji} already exists.`);
      }
      if (this.tagByEmoji(emoji)) {
        throw new Error(`The emoji ${emoji} is already used by a status tag.`);
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.priorityTag.updateMany({ where: { id: { not: id } }, data: { isInitial: false } });
      }
      return tx.priorityTag.update({
        where: { id },
        data: {
          ...(input.emoji !== undefined ? { emoji: input.emoji.trim() } : {}),
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.isInitial !== undefined ? { isInitial: input.isInitial } : {}),
        },
      });
    });
    await this.refreshPriorities();
    return updated;
  }

  // Deletes a priority, reassigning any open tickets that used it to the initial
  // priority. Returns the threadIds of reassigned tickets so callers can rename them.
  async removePriority(id: string): Promise<{ reassignedThreadIds: string[]; initial: PriorityTag }> {
    const priority = this.priorityById(id);
    if (!priority) throw new Error("Priority not found.");
    if (priority.isInitial) throw new Error("The initial priority can't be removed. Mark another priority as initial first.");
    const initial = this.initialPriority();
    if (!initial) throw new Error("No initial priority is configured.");

    const affected = await this.prisma.ticket.findMany({
      where: { priorityTagId: id, closed: false },
      select: { threadId: true },
    });

    await this.prisma.$transaction([
      this.prisma.ticket.updateMany({
        where: { priorityTagId: id },
        data: { priorityTagId: initial.id },
      }),
      this.prisma.priorityTag.delete({ where: { id } }),
    ]);

    await this.refreshPriorities();
    return { reassignedThreadIds: affected.map((t) => t.threadId), initial };
  }
}
