import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction, type Client, EmbedBuilder } from "discord.js";
import type { ApprovalStore, BillingApproval } from "../bot/billing/ApprovalStore";
import { changedFields, fieldList, parseStoredDetails } from "../bot/billing/customerDetails";
import { COLORS } from "../util/embeds";
import { log } from "../util/logger";
import type { SupportAuth, SupportStaffDirectory } from "./SupportAuth";
import { SUPPORT_BASE_PATH } from "./SupportAuth";

const dLog = log.child("support:discord");

// The Discord half of the support dashboard: the /support command (a sign-in
// code), the sign-in DM, the staff check behind every session, and the DM that
// tells a requester what became of their change request.

export const SUPPORT_COMMAND = {
  name: "support",
  description: "Sign in to the support dashboard (support/admin only)",
};

// Outcomes a requester is told about. WITHDRAWN is their own doing.
const TOLD_STATUSES = ["EXECUTED", "REJECTED", "REFUSED", "EXPIRED"];
const SWEEP_EVERY_MS = 10 * 60_000;
// An undelivered outcome DM is retried this long after the request closed.
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface SupportDiscordSettings {
  supportDashEnabled(): boolean;
  resolvedPublicBaseUrl(): string | null;
}

export class SupportDiscord implements SupportStaffDirectory {
  private client: Client | null = null;
  private auth: SupportAuth | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private settings: SupportDiscordSettings,
    private approvals: ApprovalStore,
    // Display name of a staff member (Administrator or a support tier role),
    // null when not staff; throws when Discord cannot be asked.
    private staffLookup: (discordUserId: string) => Promise<{ name: string } | null>
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  bindAuth(auth: SupportAuth): void {
    this.auth = auth;
  }

  // ---- SupportStaffDirectory ----

  staff(discordUserId: string): Promise<{ name: string } | null> {
    return this.staffLookup(discordUserId);
  }

  async dm(discordUserId: string, text: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send({ content: text });
      return true;
    } catch (e) {
      dLog.warn("support DM failed", { "discord.user_id": discordUserId, "error.message": e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  // ---- /support (the caller already checked support role or admin) ----

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.settings.supportDashEnabled() || !this.auth) {
      await interaction.reply({ content: "The support dashboard is switched off.", flags: 64 });
      return;
    }
    const member = interaction.member;
    const name =
      (member && "displayName" in member && typeof member.displayName === "string" ? member.displayName : null) ??
      interaction.user.globalName ??
      interaction.user.username;
    const { code, minutes } = this.auth.issueCode(interaction.user.id, name);
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle("Support dashboard sign-in")
      .setDescription(`Enter this code on the support dashboard:\n**\`${code}\`**\nIt works once, for ${minutes} minutes.`);
    const url = this.pageUrl();
    const components = url
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel("Open support dashboard"))]
      : [];
    await interaction.reply({ embeds: [embed], components, flags: 64 });
  }

  // ---- outcome DMs ----

  // BillingActionService calls this when an admin closes an approval.
  onOutcome(approvalId: string): void {
    void this.approvals
      .get(approvalId)
      .then((row) => (row && row.origin === "support" && TOLD_STATUSES.includes(row.status) ? this.tell(row) : undefined))
      .catch((e) => dLog.warn("support outcome DM failed", { "error.message": e instanceof Error ? e.message : String(e) }));
  }

  // Expired requests have no event of their own, and a restart can drop a DM:
  // a slow sweep catches both.
  startSweep(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref?.();
    void this.sweep();
  }

  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<void> {
    try {
      const rows = await this.approvals.listUnnotified("support", TOLD_STATUSES, new Date(Date.now() - RETRY_WINDOW_MS), 25);
      for (const row of rows) await this.tell(row);
    } catch (e) {
      dLog.warn("support outcome sweep failed", { "error.message": e instanceof Error ? e.message : String(e) });
    }
  }

  private async tell(row: BillingApproval): Promise<void> {
    if (!(await this.approvals.claimNotify(row.id))) return;
    if (!(await this.dm(row.requestedById, outcomeMessage(row, this.pageUrl())))) await this.approvals.releaseNotify(row.id);
  }

  private pageUrl(): string | null {
    const base = this.settings.resolvedPublicBaseUrl();
    return base && /^https:\/\//.test(base) ? `${base}${SUPPORT_BASE_PATH}` : null;
  }
}

export function outcomeMessage(row: BillingApproval, pageUrl: string | null): string {
  const p = row.paramsJson && typeof row.paramsJson === "object" && !Array.isArray(row.paramsJson) ? (row.paramsJson as Record<string, unknown>) : {};
  const before = parseStoredDetails(p.before);
  const after = parseStoredDetails(p.after);
  const what = before && after ? fieldList(changedFields(before, after)).toLowerCase() : "billing details";
  const who = (typeof p.customerName === "string" && p.customerName) || row.stripeCustomerId || "the customer";
  let line: string;
  switch (row.status) {
    case "EXECUTED":
      line = `**Approved:** ${row.reviewerName ?? "An admin"} applied your change to ${who} (${what}).`;
      break;
    case "REJECTED":
      line = `**Rejected:** ${row.reviewerName ?? "An admin"} rejected your change to ${who} (${what})${row.reviewNote ? `: ${row.reviewNote}` : "."}`;
      break;
    case "REFUSED":
      line = `**Not applied:** ${who} changed since you asked (${row.errorText ?? "details changed"}). File a new request if it is still needed.`;
      break;
    default:
      line = `**Expired:** your change to ${who} (${what}) got no decision within 7 days.`;
  }
  const link = pageUrl && row.stripeCustomerId ? `\n${pageUrl}/customer/${row.stripeCustomerId}` : "";
  return `${line}${link}`;
}
