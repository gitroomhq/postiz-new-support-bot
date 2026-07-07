import { BotConfig } from "../config";
import { log } from "../util/logger";

// Read-only client for Postiz's public REST API v1. Authenticated with the
// ticket customer's own `pos_` OAuth token (the same token that scopes the
// hosted Postiz MCP), so every call is confined to that customer's org. Used to
// PRE-FETCH account facts into the /ai context instead of spending agent turns
// on the MCP — richer context, and faster because the model stops digging.
//
// Everything here is best-effort: any non-2xx (a churned token returns 401
// "No subscription found") or timeout resolves to null so the /ai run degrades
// to "no snapshot" exactly like the Postiz MCP simply not connecting.

const postizLog = log.child("postiz-client");

const FETCH_TIMEOUT_MS = 5_000;

export interface PostizChannel {
  id: string;
  name: string;
  /** providerIdentifier, e.g. "linkedin", "x", "mastodon". */
  provider: string;
  /** A disabled channel is the #1 cause of "my posts aren't going out". */
  disabled: boolean;
}

export interface PostizPost {
  id: string;
  /** QUEUE | PUBLISHED | ERROR | DRAFT */
  state: string;
  publishDate: string;
  provider: string | null;
  channelName: string | null;
  releaseURL: string | null;
}

export interface PostizAccountSnapshot {
  channels: PostizChannel[];
  posts: PostizPost[];
}

export class PostizClient {
  constructor(private config: BotConfig) {}

  private base(): string | null {
    return this.config.postiz.apiUrl?.replace(/\/+$/, "") || null;
  }

  private async get(path: string, token: string): Promise<unknown> {
    const base = this.base();
    if (!base) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/public/v1${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 401 = churned/expired token; any non-2xx → treat as no data.
        postizLog.debug("public api non-2xx", { path, status: res.status });
        return null;
      }
      return await res.json();
    } catch (err) {
      postizLog.debug("public api fetch failed", { path, error: String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async listIntegrations(token: string): Promise<PostizChannel[] | null> {
    const data = await this.get("/integrations", token);
    if (!Array.isArray(data)) return null;
    return data.map((c: any) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      provider: String(c.identifier ?? ""),
      disabled: Boolean(c.disabled),
    }));
  }

  async listRecentPosts(token: string, fromISO: string, toISO: string): Promise<PostizPost[] | null> {
    const params = new URLSearchParams({ startDate: fromISO, endDate: toISO });
    const data = await this.get(`/posts?${params.toString()}`, token);
    const posts = (data as any)?.posts;
    if (!Array.isArray(posts)) return null;
    return posts.map((p: any) => ({
      id: String(p.id ?? ""),
      state: String(p.state ?? ""),
      publishDate:
        typeof p.publishDate === "string"
          ? p.publishDate
          : p.publishDate
            ? new Date(p.publishDate).toISOString()
            : "",
      provider: p.integration?.providerIdentifier ?? null,
      channelName: p.integration?.name ?? null,
      releaseURL: p.releaseURL ?? null,
    }));
  }

  // Combined best-effort snapshot for the /ai context block. Runs the two reads
  // in parallel; returns null only when BOTH fail (no token / API down) so the
  // caller can omit the section entirely.
  async fetchAccountSnapshot(token: string): Promise<PostizAccountSnapshot | null> {
    if (!token) return null;
    const now = Date.now();
    const fromISO = new Date(now - 30 * 24 * 3_600 * 1_000).toISOString();
    const toISO = new Date(now + 7 * 24 * 3_600 * 1_000).toISOString();
    const [channels, posts] = await Promise.all([
      this.listIntegrations(token),
      this.listRecentPosts(token, fromISO, toISO),
    ]);
    if (channels === null && posts === null) return null;
    return { channels: channels ?? [], posts: posts ?? [] };
  }
}
