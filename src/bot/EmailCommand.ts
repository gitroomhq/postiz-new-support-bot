import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { COLORS, embed as makeEmbed } from "../util/embeds";
import {
  EMAIL_RE,
  describeFilter,
  describeSuppression,
  originLabel,
  type DeliveryStatus,
  type EmailDeliverabilityService,
  type SuppressionFilter,
  type SuppressionScan,
} from "../resend/EmailDeliverabilityService";
import { PROBLEM_EVENTS, categoryLabel, eventLabel, type LoggedEmail } from "../resend/DeliveryLogStore";
import { SHARE_TTL_LABEL, type DeliveryLogService } from "../resend/DeliveryLogService";
import type { PostizIdentityService } from "../postiz/PostizIdentityService";
import type { PostizAccount } from "../postiz/PostizClient";

// /email [address]: the Resend panel for support.
//
// With an address it opens that address: suppression status (and removal),
// the Postiz account, and the delivery log (every email Resend sent it, 10 to
// a page, each openable for its event timeline). Without one it opens a hub
// to look an address up. Admins (Discord Administrator permission) also get
// the suppression list browser with batch removal, and a share link on any
// logged email.
//
// Authz is the support role or Administrator, checked at RUNTIME on the
// command and again on every button, select and modal (registration shows the
// command to everyone who can see the channel, so it proves nothing). The
// admin-only actions re-check Administrator on every press as well. Replies
// are ephemeral. Components carry a short server-side token, bound to the
// user who ran the command, instead of the address itself: an email can be
// longer than a custom id may be, and a token cannot be edited into someone
// else's.

export const EMAIL_PREFIX = "emailcmd_";
const TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_CAP = 500;
const LOOKUP_TIMEOUT_MS = 3_000;
const PAGE_SIZE = 10;

export const EMAIL_COMMAND = {
  name: "email",
  description: "Email delivery for an address: suppression, delivery log, removal (support/admin only)",
  options: [
    {
      type: 3, // STRING
      name: "address",
      description: "The email address to open (leave empty for the hub)",
      required: false,
      max_length: 254,
    },
  ],
};

type View = "hub" | "address" | "email" | "list";

interface Session {
  userId: string;
  at: number;
  view: View;
  email: string | null;
  logPage: number;
  emailId: string | null;
  filter: SuppressionFilter;
  scan: SuppressionScan | null;
  listPage: number;
}

type Allow = (interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) => Promise<boolean>;
type IsAdmin = (interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction | ChatInputCommandInteraction) => boolean;

interface RenderOpts {
  confirm?: boolean;
  confirmBatch?: boolean;
  notice?: string;
  offerActivation?: boolean;
}

type Panel = { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] };

const EMPTY_FILTER: SuppressionFilter = { origin: "any", since: null, until: null, domain: null };

export class EmailCommand {
  private sessions = new Map<string, Session>();

  constructor(
    private delivery: () => EmailDeliverabilityService | null,
    private postiz: () => PostizIdentityService | null,
    // Replies with the refusal itself when it says no.
    private authorize: Allow,
    private deliveryLog: () => DeliveryLogService | null = () => null,
    private isAdmin: IsAdmin = () => false
  ) {}

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.authorize(interaction))) return;
    const svc = this.delivery();
    if (!svc?.enabled()) {
      await interaction.reply({
        embeds: [makeEmbed("Resend is not enabled. An admin can switch it on in /config → Integrations → Resend.", COLORS.warn)],
        flags: 64,
      });
      return;
    }
    const raw = interaction.options.getString("address", false)?.trim() ?? "";
    if (raw && !EMAIL_RE.test(raw)) {
      await interaction.reply({ embeds: [makeEmbed("That is not an email address.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferReply({ flags: 64 });
    const token = this.mint(interaction.user.id, raw || null);
    await interaction.editReply(await this.render(svc, token, this.sessions.get(token)!, {}, this.isAdmin(interaction)));
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.authorize(interaction))) return;
    const [action, token, arg] = interaction.customId.split(":");
    const session = await this.sessionFor(interaction, token);
    if (!session) return;
    const svc = this.delivery();
    if (!svc?.enabled()) {
      await interaction.reply({ embeds: [makeEmbed("Resend is no longer enabled.", COLORS.warn)], flags: 64 });
      return;
    }
    const admin = this.isAdmin(interaction);
    const name = action.slice(EMAIL_PREFIX.length);

    // Modal openers must answer first, before any defer.
    if (name === "lookup") {
      await interaction.showModal(lookupModal(token));
      return;
    }
    if (name === "filter") {
      if (!(await this.requireAdmin(interaction, admin))) return;
      await interaction.showModal(filterModal(token, session.filter));
      return;
    }
    if (name === "bconfirm") {
      if (!(await this.requireAdmin(interaction, admin))) return;
      const count = session.scan?.matches.length ?? 0;
      await interaction.showModal(batchConfirmModal(token, count));
      return;
    }
    if (name === "share") {
      if (!(await this.requireAdmin(interaction, admin))) return;
      await interaction.deferReply({ flags: 64 });
      const log = this.deliveryLog();
      const emailId = session.emailId;
      if (!log || !emailId) {
        await interaction.editReply({ embeds: [makeEmbed("That email is no longer open.", COLORS.warn)] });
        return;
      }
      const r = await log.share(emailId, discordActor(interaction));
      await interaction.editReply({
        embeds: [
          r.ok
            ? makeEmbed(
                `[Open the email as sent](${r.url})\nValid for ${SHARE_TTL_LABEL}. Anyone with this link sees the whole email, including any live reset or activation link: do not paste it where others can read it.`,
                COLORS.warn
              )
            : makeEmbed(`Could not create a link: ${r.error}`, COLORS.danger),
        ],
      });
      return;
    }

    await interaction.deferUpdate();
    const actor = discordActor(interaction);
    let opts: RenderOpts = {};

    switch (name) {
      case "hub":
        session.view = "hub";
        break;
      case "addr":
        session.view = "address";
        session.emailId = null;
        break;
      case "logp":
        session.view = "address";
        session.logPage = Math.max(0, Number(arg) || 0);
        break;
      case "list":
        if (!(await this.requireAdminEdit(interaction, admin, svc, token, session))) return;
        session.view = "list";
        session.listPage = 0;
        if (!session.scan) session.scan = await this.scan(svc, session.filter);
        break;
      case "listp":
        if (!(await this.requireAdminEdit(interaction, admin, svc, token, session))) return;
        session.view = "list";
        session.listPage = Math.max(0, Number(arg) || 0);
        break;
      case "rescan":
        if (!(await this.requireAdminEdit(interaction, admin, svc, token, session))) return;
        session.view = "list";
        session.listPage = 0;
        session.scan = await this.scan(svc, session.filter);
        break;
      case "batch":
        if (!(await this.requireAdminEdit(interaction, admin, svc, token, session))) return;
        session.view = "list";
        opts = { confirmBatch: true };
        break;
      case "rm":
        opts = { confirm: true };
        break;
      case "rmx": {
        if (!session.email) break;
        const result = await svc.remove(session.email, actor);
        if (result.kind === "removed") {
          const account = await this.accountFor(session.email);
          const offer = account?.userActivated === false;
          opts = {
            notice: `Removed from the suppression list. New mail from Postiz will be delivered.${
              offer ? " The Postiz account is not activated yet: resend the activation email below." : ""
            }`,
            offerActivation: offer,
          };
        } else {
          opts = {
            notice:
              result.kind === "not_suppressed"
                ? "It was not on the suppression list; nothing was removed."
                : result.kind === "error" || result.kind === "invalid"
                  ? result.error
                  : "Resend is not enabled.",
          };
        }
        break;
      }
      case "act": {
        if (!session.email) break;
        const sent = await svc.resendActivation(session.email, actor);
        opts = { notice: sent.ok ? "Postiz is sending a new activation email." : sent.error };
        break;
      }
      default:
        // Refresh, Cancel, or anything stale: a plain re-read.
        break;
    }
    await interaction.editReply(await this.render(svc, token, session, opts, admin));
  }

  // The delivery log's "open an email" menu.
  async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (!(await this.authorize(interaction))) return;
    const [, token] = interaction.customId.split(":");
    const session = await this.sessionFor(interaction, token);
    if (!session) return;
    const svc = this.delivery();
    if (!svc?.enabled()) {
      await interaction.reply({ embeds: [makeEmbed("Resend is no longer enabled.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    session.view = "email";
    session.emailId = interaction.values[0] ?? null;
    await interaction.editReply(await this.render(svc, token, session, {}, this.isAdmin(interaction)));
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!(await this.authorize(interaction))) return;
    const [action, token] = interaction.customId.split(":");
    const session = await this.sessionFor(interaction, token);
    if (!session) return;
    const svc = this.delivery();
    if (!svc?.enabled()) {
      await interaction.reply({ embeds: [makeEmbed("Resend is no longer enabled.", COLORS.warn)], flags: 64 });
      return;
    }
    const admin = this.isAdmin(interaction);
    const name = action.slice(EMAIL_PREFIX.length);

    if (name === "mlookup") {
      const email = interaction.fields.getTextInputValue("address").trim();
      if (!EMAIL_RE.test(email)) {
        await interaction.reply({ embeds: [makeEmbed("That is not an email address.", COLORS.warn)], flags: 64 });
        return;
      }
      await interaction.deferUpdate();
      session.email = email;
      session.view = "address";
      session.logPage = 0;
      session.emailId = null;
      await interaction.editReply(await this.render(svc, token, session, {}, admin));
      return;
    }

    if (!admin) {
      await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
      return;
    }

    if (name === "mfilter") {
      const parsed = parseFilter(
        interaction.fields.getTextInputValue("origin"),
        interaction.fields.getTextInputValue("domain"),
        interaction.fields.getTextInputValue("since"),
        interaction.fields.getTextInputValue("until")
      );
      if (!parsed.ok) {
        await interaction.reply({ embeds: [makeEmbed(parsed.error, COLORS.warn)], flags: 64 });
        return;
      }
      await interaction.deferUpdate();
      session.filter = parsed.filter;
      session.view = "list";
      session.listPage = 0;
      session.scan = await this.scan(svc, session.filter);
      await interaction.editReply(await this.render(svc, token, session, {}, admin));
      return;
    }

    if (name === "mbatch") {
      const expected = session.scan?.matches.length ?? 0;
      const typed = interaction.fields.getTextInputValue("confirm").trim();
      if (typed !== `REMOVE ${expected}`) {
        await interaction.reply({
          embeds: [makeEmbed(`Nothing removed: type exactly \`REMOVE ${expected}\` to confirm.`, COLORS.warn)],
          flags: 64,
        });
        return;
      }
      await interaction.deferUpdate();
      const r = await svc.removeMatching(session.filter, discordActor(interaction), expected);
      session.scan = await this.scan(svc, session.filter);
      session.listPage = 0;
      session.view = "list";
      const notice = r.ok
        ? `Removed ${r.removed} of ${r.matched} matching entries${r.failed ? ` (${r.failed} were not removed; run it again)` : ""}.${
            r.matched !== expected ? ` The list changed since the preview (${expected} then).` : ""
          }`
        : `Nothing removed: ${r.error}`;
      await interaction.editReply(await this.render(svc, token, session, { notice }, admin));
      return;
    }
  }

  private async scan(svc: EmailDeliverabilityService, filter: SuppressionFilter): Promise<SuppressionScan | null> {
    return svc.scanSuppressions(filter).catch(() => null);
  }

  private async sessionFor(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
    token: string | undefined
  ): Promise<Session | null> {
    const session = token ? this.sessions.get(token) : undefined;
    // Ephemeral replies are already private to their author; the user binding
    // is the belt for a token that leaks anyway.
    if (!session || Date.now() - session.at > TOKEN_TTL_MS || session.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [makeEmbed("This panel expired. Run /email again.", COLORS.warn)], flags: 64 });
      return null;
    }
    session.at = Date.now();
    return session;
  }

  private async requireAdmin(interaction: ButtonInteraction, admin: boolean): Promise<boolean> {
    if (admin) return true;
    await interaction.reply({ embeds: [makeEmbed("Administrator permission required.", COLORS.danger)], flags: 64 });
    return false;
  }

  // Same gate, for a press that has already been deferred.
  private async requireAdminEdit(
    interaction: ButtonInteraction,
    admin: boolean,
    svc: EmailDeliverabilityService,
    token: string,
    session: Session
  ): Promise<boolean> {
    if (admin) return true;
    await interaction.editReply(
      await this.render(svc, token, session, { notice: "Administrator permission required." }, false)
    );
    return false;
  }

  private mint(userId: string, email: string | null): string {
    if (this.sessions.size >= TOKEN_CAP) {
      const cutoff = Date.now() - TOKEN_TTL_MS;
      for (const [k, v] of this.sessions) if (v.at < cutoff) this.sessions.delete(k);
      if (this.sessions.size >= TOKEN_CAP) this.sessions.clear();
    }
    const token = randomBytes(9).toString("base64url");
    this.sessions.set(token, {
      userId,
      at: Date.now(),
      view: email ? "address" : "hub",
      email,
      logPage: 0,
      emailId: null,
      filter: { ...EMPTY_FILTER },
      scan: null,
      listPage: 0,
    });
    return token;
  }

  private async accountFor(email: string): Promise<PostizAccount | null> {
    const identity = this.postiz();
    if (!identity) return null;
    const account = await Promise.race([
      identity.resolve(email).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)),
    ]);
    // Only an account whose login IS this address speaks for it.
    return account && account.email?.toLowerCase() === email.toLowerCase() ? account : null;
  }

  private async render(
    svc: EmailDeliverabilityService,
    token: string,
    session: Session,
    opts: RenderOpts,
    admin: boolean
  ): Promise<Panel> {
    if (session.view === "list" && admin) return this.renderList(token, session, opts);
    if (session.view === "email" && session.emailId) return this.renderEmail(token, session, admin);
    if (session.view === "address" && session.email) return this.renderAddress(svc, token, session, opts);
    return this.renderHub(token, opts, admin);
  }

  private renderHub(token: string, opts: RenderOpts, admin: boolean): Panel {
    const log = this.deliveryLog();
    const embed = new EmbedBuilder()
      .setTitle("📧 Email delivery")
      .setColor(COLORS.brand)
      .setDescription(
        [
          opts.notice ?? null,
          "Look up an address to see whether Postiz mail reaches it: the suppression list, and every email Resend sent it (delivered, delayed, bounced, spam, suppressed).",
          log?.webhookRegistered()
            ? null
            : "_The delivery log is not collecting: an admin can register the webhook in /config → Integrations → Resend._",
          admin ? "**Admin:** browse the suppression list and remove entries in bulk." : null,
        ]
          .filter(Boolean)
          .join("\n\n")
      );
    const buttons = [
      new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}lookup:${token}`).setLabel("Look up address").setStyle(ButtonStyle.Primary),
    ];
    if (admin) {
      buttons.push(
        new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}list:${token}`).setLabel("Suppression list").setStyle(ButtonStyle.Secondary)
      );
    }
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] };
  }

  private async renderAddress(svc: EmailDeliverabilityService, token: string, session: Session, opts: RenderOpts): Promise<Panel> {
    const email = session.email!;
    const log = this.deliveryLog();
    const [status, account, history] = await Promise.all([
      svc.statusOf(email),
      this.accountFor(email),
      log ? log.historyFor(email, session.logPage, PAGE_SIZE).catch(() => null) : Promise.resolve(null),
    ]);
    const pages = history ? Math.max(1, Math.ceil(history.total / PAGE_SIZE)) : 1;
    const embed = new EmbedBuilder()
      .setTitle(`📧 ${email}`.slice(0, 256))
      .setColor(status.state === "suppressed" ? COLORS.danger : status.state === "clear" ? COLORS.success : COLORS.warn)
      .setDescription(
        [
          opts.notice ?? null,
          statusLine(status),
          opts.confirm
            ? "**Remove it from the suppression list?** Postiz mail (activation, password reset, notifications) will be sent to it again. If it still bounces or is reported as spam, Resend suppresses it again, and repeated bounces hurt delivery for every customer."
            : null,
        ]
          .filter(Boolean)
          .join("\n\n")
      )
      .addFields(
        {
          name: "Postiz account",
          value: account
            ? `${account.orgName ?? account.orgId} · ${account.userActivated === false ? "**not activated**" : account.userActivated ? "activated" : "activation unknown"}`
            : "none found for this exact address",
          inline: false,
        },
        {
          name: history ? `Delivery log (${history.total})${pages > 1 ? ` · page ${session.logPage + 1}/${pages}` : ""}` : "Delivery log",
          value: history
            ? history.rows.length
              ? history.rows.map(logLine).join("\n").slice(0, 1024)
              : "No email to this address in the last 180 days."
            : "unavailable",
          inline: false,
        }
      )
      .setTimestamp();

    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    if (history?.rows.length) {
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`${EMAIL_PREFIX}open:${token}`)
            .setPlaceholder("Open an email for its timeline")
            .addOptions(
              history.rows.map((r) => ({
                label: `${categoryLabel(r.category)}: ${eventLabel(r.lastEvent)}`.slice(0, 100),
                description: `${r.sentAt.toISOString().slice(0, 16).replace("T", " ")} UTC · ${r.subject ?? "(no subject)"}`.slice(0, 100),
                value: r.id,
              }))
            )
        )
      );
    }
    const buttons: ButtonBuilder[] = [];
    if (status.state === "suppressed") {
      buttons.push(
        opts.confirm
          ? new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}rmx:${token}`).setLabel("Yes, remove it").setStyle(ButtonStyle.Danger)
          : new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}rm:${token}`).setLabel("Remove from suppression list").setStyle(ButtonStyle.Danger)
      );
    }
    if (opts.offerActivation || (status.state === "clear" && account?.userActivated === false)) {
      buttons.push(
        new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}act:${token}`).setLabel("Resend activation email").setStyle(ButtonStyle.Primary)
      );
    }
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${EMAIL_PREFIX}refresh:${token}`)
        .setLabel(opts.confirm ? "Cancel" : "Refresh")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}hub:${token}`).setLabel("Hub").setStyle(ButtonStyle.Secondary)
    );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
    if (pages > 1) rows.push(pager("logp", token, session.logPage, pages));
    return { embeds: [embed], components: rows };
  }

  private async renderEmail(token: string, session: Session, admin: boolean): Promise<Panel> {
    const log = this.deliveryLog();
    const found = log ? await log.email(session.emailId!).catch(() => null) : null;
    const back = new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}addr:${token}`).setLabel("Back").setStyle(ButtonStyle.Secondary);
    if (!found) {
      return {
        embeds: [makeEmbed("That email is not in the delivery log anymore.", COLORS.warn)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(back)],
      };
    }
    const { email: m, events } = found;
    const embed = new EmbedBuilder()
      .setTitle(`✉️ ${m.subject ?? "(no subject)"}`.slice(0, 256))
      .setColor(PROBLEM_EVENTS.has(m.lastEvent) ? COLORS.danger : m.lastEvent === "delivered" ? COLORS.success : COLORS.brand)
      .addFields(
        { name: "To", value: m.recipient.slice(0, 1024), inline: true },
        { name: "Kind", value: categoryLabel(m.category), inline: true },
        { name: "Status", value: eventLabel(m.lastEvent), inline: true },
        { name: "Sent", value: `<t:${Math.floor(m.sentAt.getTime() / 1000)}:f>`, inline: true },
        ...(m.fromAddress ? [{ name: "From", value: m.fromAddress.slice(0, 1024), inline: true }] : []),
        ...(m.detail ? [{ name: "Reason", value: m.detail.slice(0, 1024), inline: false }] : []),
        {
          name: "Timeline",
          value: events.length
            ? events
                .map((e) => `<t:${Math.floor(e.occurredAt.getTime() / 1000)}:T> ${eventLabel(e.type)}${e.detail ? `: ${e.detail.slice(0, 120)}` : ""}`)
                .join("\n")
                .slice(0, 1024)
            : m.source === "backfill"
              ? "Imported from Resend's history: only the last status is known."
              : "No events stored.",
          inline: false,
        }
      )
      .setFooter({ text: `Resend id ${m.id}` });
    const buttons = [back];
    if (admin) {
      buttons.unshift(
        new ButtonBuilder()
          .setCustomId(`${EMAIL_PREFIX}share:${token}`)
          .setLabel(`Share link (${SHARE_TTL_LABEL})`)
          .setStyle(ButtonStyle.Primary)
      );
    }
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] };
  }

  private renderList(token: string, session: Session, opts: RenderOpts): Panel {
    const scan = session.scan;
    const total = scan?.matches.length ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(session.listPage, pages - 1);
    const slice = scan?.matches.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) ?? [];
    const embed = new EmbedBuilder()
      .setTitle("⛔ Resend suppression list")
      .setColor(COLORS.danger)
      .setDescription(
        [
          opts.notice ?? null,
          `**Filter:** ${describeFilter(session.filter)}`,
          scan
            ? `**${total}** matching of ${scan.scanned} scanned${scan.truncated ? " (the scan stopped early: narrow the filter)" : ""}${pages > 1 ? ` · page ${page + 1}/${pages}` : ""}`
            : "⚠️ Could not read the suppression list from Resend.",
          slice.length
            ? slice
                .map(
                  (s) =>
                    `\`${s.createdAt ? s.createdAt.toISOString().slice(0, 10) : "????-??-??"}\` ${s.email} · ${originLabel(s.origin)}`
                )
                .join("\n")
            : scan
              ? "_Nothing matches._"
              : null,
          opts.confirmBatch
            ? `**Remove all ${total} matching entries?** Postiz will mail these addresses again. Addresses that still bounce or complain are suppressed again, and a burst of bounces or spam complaints can get the Resend account paused, which stops ALL Postiz mail. Press Confirm and type \`REMOVE ${total}\`.`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4096)
      );
    const buttons: ButtonBuilder[] = [
      new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}filter:${token}`).setLabel("Filter").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}rescan:${token}`).setLabel("Rescan").setStyle(ButtonStyle.Secondary),
    ];
    if (opts.confirmBatch) {
      buttons.push(
        new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}bconfirm:${token}`).setLabel("Confirm").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}listp:${token}:${page}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
    } else if (total > 0) {
      buttons.push(
        new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}batch:${token}`).setLabel(`Remove all ${total}`).setStyle(ButtonStyle.Danger)
      );
    }
    buttons.push(new ButtonBuilder().setCustomId(`${EMAIL_PREFIX}hub:${token}`).setLabel("Hub").setStyle(ButtonStyle.Secondary));
    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
    ];
    if (pages > 1) rows.push(pager("listp", token, page, pages));
    return { embeds: [embed], components: rows };
  }
}

function discordActor(interaction: { user: { id: string; username: string } }) {
  return { surface: "discord" as const, id: interaction.user.id, name: interaction.user.username };
}

function pager(action: string, token: string, page: number, pages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${EMAIL_PREFIX}${action}:${token}:${page - 1}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${EMAIL_PREFIX}${action}:${token}:${page + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages - 1)
  );
}

// "`2026-09-12 14:02` Password reset · **Bounced**"
export function logLine(r: LoggedEmail): string {
  const when = r.sentAt.toISOString().slice(0, 16).replace("T", " ");
  const status = PROBLEM_EVENTS.has(r.lastEvent) ? `**${eventLabel(r.lastEvent)}**` : eventLabel(r.lastEvent);
  return `\`${when}\` ${categoryLabel(r.category)} · ${status}`;
}

function lookupModal(token: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${EMAIL_PREFIX}mlookup:${token}`)
    .setTitle("Look up an address")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("address")
          .setLabel("Email address")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(254)
          .setRequired(true)
      )
    );
}

function filterModal(token: string, f: SuppressionFilter): ModalBuilder {
  const input = (id: string, label: string, value: string, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder(placeholder)
        .setValue(value)
    );
  return new ModalBuilder()
    .setCustomId(`${EMAIL_PREFIX}mfilter:${token}`)
    .setTitle("Filter the suppression list")
    .addComponents(
      input("origin", "Origin: any, bounce, complaint or manual", f.origin, "any"),
      input("domain", "Recipient domain (blank = all)", f.domain ?? "", "gmail.com"),
      input("since", "Suppressed on or after (YYYY-MM-DD)", f.since ? f.since.toISOString().slice(0, 10) : "", "2026-09-01"),
      input("until", "Suppressed on or before (YYYY-MM-DD)", f.until ? f.until.toISOString().slice(0, 10) : "", "2026-09-30")
    );
}

function batchConfirmModal(token: string, count: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${EMAIL_PREFIX}mbatch:${token}`)
    .setTitle(`Remove ${count} suppressions`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("confirm")
          .setLabel(`Type REMOVE ${count} to confirm`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

export function parseFilter(
  originRaw: string,
  domainRaw: string,
  sinceRaw: string,
  untilRaw: string
): { ok: true; filter: SuppressionFilter } | { ok: false; error: string } {
  const origin = (originRaw.trim().toLowerCase() || "any") as SuppressionFilter["origin"];
  if (!["any", "bounce", "complaint", "manual"].includes(origin)) {
    return { ok: false, error: "Origin must be any, bounce, complaint or manual." };
  }
  const domain = domainRaw.trim().toLowerCase().replace(/^@/, "") || null;
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, error: "That is not a domain." };
  const day = (raw: string, endOfDay: boolean): Date | null | "bad" => {
    const v = raw.trim();
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "bad";
    const d = new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
    return Number.isFinite(d.getTime()) ? d : "bad";
  };
  const since = day(sinceRaw, false);
  const until = day(untilRaw, true);
  if (since === "bad" || until === "bad") return { ok: false, error: "Dates must be YYYY-MM-DD." };
  if (since && until && since > until) return { ok: false, error: "The start date is after the end date." };
  return { ok: true, filter: { origin, domain, since, until } };
}

function statusLine(status: DeliveryStatus): string {
  if (status.state === "suppressed") {
    const origin = originLabel(status.suppression.origin);
    return `⛔ **Suppressed**: ${describeSuppression(status.suppression, status.source)}. Postiz mail to this address is silently dropped${
      status.suppression.origin === "complaint" ? " (the recipient marked a Postiz email as spam)" : origin === "hard bounce" ? " (their mail server rejected it)" : ""
    }.`;
  }
  if (status.state === "clear") return "✅ **Deliverable**: not on the suppression list.";
  return `⚠️ **Unknown**: ${status.error}.`;
}
