import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { COLORS, embed as makeEmbed } from "../util/embeds";
import {
  EMAIL_RE,
  describeSuppression,
  originLabel,
  type DeliveryStatus,
  type EmailDeliverabilityService,
} from "../resend/EmailDeliverabilityService";
import type { PostizIdentityService } from "../postiz/PostizIdentityService";
import type { PostizAccount } from "../postiz/PostizClient";

// /email <address>: is this address on Resend's suppression list, and take it
// off. The Discord twin of the Intercom sidebar's email section, for support
// staff who are not looking at a conversation.
//
// Authz is the support role or Administrator, checked at RUNTIME on the
// command and again on every button (registration shows the command to
// everyone who can see the channel, so it proves nothing). Replies are
// ephemeral. Buttons carry a short server-side token, bound to the user who
// ran the command, instead of the address itself: an email can be longer
// than a custom id may be, and a token cannot be edited into someone else's.

export const EMAIL_PREFIX = "emailcmd_";
const TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_CAP = 500;
const LOOKUP_TIMEOUT_MS = 3_000;

export const EMAIL_COMMAND = {
  name: "email",
  description: "Check an address against the Resend suppression list and remove it (support/admin only)",
  options: [
    {
      type: 3, // STRING
      name: "address",
      description: "The email address to check",
      required: true,
      max_length: 254,
    },
  ],
};

interface Pending {
  email: string;
  userId: string;
  at: number;
}

type Authorize = (interaction: ChatInputCommandInteraction | ButtonInteraction) => Promise<boolean>;

interface RenderOpts {
  confirm?: boolean;
  notice?: string;
  offerActivation?: boolean;
}

export class EmailCommand {
  private tokens = new Map<string, Pending>();

  constructor(
    private delivery: () => EmailDeliverabilityService | null,
    private postiz: () => PostizIdentityService | null,
    // Replies with the refusal itself when it says no.
    private authorize: Authorize
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
    const email = interaction.options.getString("address", true).trim();
    if (!EMAIL_RE.test(email)) {
      await interaction.reply({ embeds: [makeEmbed("That is not an email address.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferReply({ flags: 64 });
    await interaction.editReply(await this.render(svc, this.mint(email, interaction.user.id), email, {}));
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.authorize(interaction))) return;
    const [action, token] = interaction.customId.split(":");
    const pending = token ? this.tokens.get(token) : undefined;
    // Ephemeral replies are already private to their author; the user binding
    // is the belt for a token that leaks anyway.
    if (!pending || Date.now() - pending.at > TOKEN_TTL_MS || pending.userId !== interaction.user.id) {
      await interaction.reply({ embeds: [makeEmbed("This panel expired. Run /email again.", COLORS.warn)], flags: 64 });
      return;
    }
    const svc = this.delivery();
    if (!svc?.enabled()) {
      await interaction.reply({ embeds: [makeEmbed("Resend is no longer enabled.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferUpdate();
    const actor = { surface: "discord" as const, id: interaction.user.id, name: interaction.user.username };
    const email = pending.email;

    if (action === `${EMAIL_PREFIX}rm`) {
      await interaction.editReply(await this.render(svc, token, email, { confirm: true }));
      return;
    }
    if (action === `${EMAIL_PREFIX}rmx`) {
      const result = await svc.remove(email, actor);
      if (result.kind === "removed") {
        const account = await this.accountFor(email);
        const offer = account?.userActivated === false;
        await interaction.editReply(
          await this.render(svc, token, email, {
            notice: `Removed from the suppression list. New mail from Postiz will be delivered.${
              offer ? " The Postiz account is not activated yet: resend the activation email below." : ""
            }`,
            offerActivation: offer,
          })
        );
        return;
      }
      const notice =
        result.kind === "not_suppressed"
          ? "It was not on the suppression list; nothing was removed."
          : result.kind === "error" || result.kind === "invalid"
            ? result.error
            : "Resend is not enabled.";
      await interaction.editReply(await this.render(svc, token, email, { notice }));
      return;
    }
    if (action === `${EMAIL_PREFIX}act`) {
      const sent = await svc.resendActivation(email, actor);
      await interaction.editReply(
        await this.render(svc, token, email, {
          notice: sent.ok ? "Postiz is sending a new activation email." : sent.error,
        })
      );
      return;
    }
    // Refresh, Cancel, or anything stale: a plain re-read.
    await interaction.editReply(await this.render(svc, token, email, {}));
  }

  private mint(email: string, userId: string): string {
    if (this.tokens.size >= TOKEN_CAP) {
      const cutoff = Date.now() - TOKEN_TTL_MS;
      for (const [k, v] of this.tokens) if (v.at < cutoff) this.tokens.delete(k);
      if (this.tokens.size >= TOKEN_CAP) this.tokens.clear();
    }
    const token = randomBytes(9).toString("base64url");
    this.tokens.set(token, { email, userId, at: Date.now() });
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
    email: string,
    opts: RenderOpts
  ): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const [status, account] = await Promise.all([svc.statusOf(email), this.accountFor(email)]);
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
      .addFields({
        name: "Postiz account",
        value: account
          ? `${account.orgName ?? account.orgId} · ${account.userActivated === false ? "**not activated**" : account.userActivated ? "activated" : "activation unknown"}`
          : "none found for this exact address",
        inline: false,
      })
      .setTimestamp();

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
        .setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] };
  }
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
