import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../util/embeds";

// Stateless UI helpers for the /intercom module (billing ui.ts pattern).

export function btn(customId: string, label: string, style: ButtonStyle, disabled = false): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
}

export function buttonRow(...buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons);
}

export function selectRow(select: StringSelectMenuBuilder): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

export function backRow(target = "icadmin_root", label = "Back"): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return buttonRow(btn(target, label, ButtonStyle.Secondary));
}

export function textInput(
  customId: string,
  label: string,
  opts: { required: boolean; placeholder?: string; value?: string; style?: TextInputStyle; maxLength?: number } = {
    required: false,
  }
): TextInputBuilder {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label.slice(0, 45))
    .setStyle(opts.style ?? TextInputStyle.Short)
    .setRequired(opts.required);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder.slice(0, 100));
  if (opts.value) input.setValue(opts.value.slice(0, opts.maxLength ?? 4000));
  if (opts.maxLength) input.setMaxLength(opts.maxLength);
  return input;
}

export function errorEmbed(error: unknown): EmbedBuilder {
  const msg = error instanceof Error ? error.message : String(error);
  return makeEmbed(`Error: ${msg.slice(0, 500)}`, COLORS.danger);
}

export function panelEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setColor(0x5865f2).setDescription(description.slice(0, 4096));
}
