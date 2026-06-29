import { EmbedBuilder } from "discord.js";

export const COLORS = {
  brand: 0x5865f2,
  success: 0x57f287,
  warn: 0xfaa61a,
  danger: 0xed4245,
  neutral: 0x2b2d31,
};

export function embed(description: string, color: number = COLORS.brand): EmbedBuilder {
  return new EmbedBuilder().setDescription(description).setColor(color);
}
