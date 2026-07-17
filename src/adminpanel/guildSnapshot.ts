import { ChannelType, Client } from "discord.js";
import { Opt } from "./renderer/contract";

// Discord channel/role "pickers" don't exist as web primitives, so the admin
// panel renders them as plain <select>/<datalist> options sourced from the
// bot's Discord cache (GUILDS intent keeps channels + roles warm — no REST call,
// no rate-limit risk). Memoized briefly so a burst of field renders reuses one
// read.

const TTL_MS = 30_000;
const TEXT_CHANNEL_TYPES = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

interface Snapshot {
  channels: Opt[];
  roles: Opt[];
  at: number;
}

export class GuildSnapshotProvider {
  private cache = new Map<string, Snapshot>();

  constructor(private getClient: () => Client | null) {}

  channels(guildId: string): Opt[] {
    return this.snapshot(guildId).channels;
  }

  roles(guildId: string): Opt[] {
    return this.snapshot(guildId).roles;
  }

  private snapshot(guildId: string): Snapshot {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached;

    const client = this.getClient();
    const guild = client?.guilds.cache.get(guildId) ?? null;
    const snap: Snapshot = { channels: [], roles: [], at: Date.now() };

    if (guild) {
      snap.channels = [...guild.channels.cache.values()]
        .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
        .sort((a, b) => ("rawPosition" in a && "rawPosition" in b ? a.rawPosition - b.rawPosition : 0))
        .map((c) => ({ value: c.id, label: `#${c.name}` }));

      snap.roles = [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id) // drop @everyone (its id equals the guild id)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ value: r.id, label: r.name }));
    }

    this.cache.set(guildId, snap);
    return snap;
  }
}
