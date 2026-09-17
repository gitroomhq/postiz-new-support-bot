import { Pool } from "pg";
import { log } from "../util/logger";

const actLog = log.child("postiz-activity");

// Real product-usage facts about a Postiz organisation, for dispute evidence.
//
// SPLIT OF AUTHORITY, deliberate and narrow:
//   - The Post and Integration tables are read DIRECTLY, read-only, because
//     they are the source of truth for what the customer actually did and
//     because only the database can see SOFT-DELETED rows. A customer who
//     published for months and then deleted everything before disputing looks
//     inactive through any API, and that pattern is exactly what we need to be
//     able to describe.
//   - Everything else about the account comes from the platform's public API
//     (see PostizClient / PostizIdentityService). This module never reads any
//     other table, and the connection it opens is expected to be granted
//     SELECT on those two tables and nothing else.
//
// Absent connection string = every fact is null, which removes the paragraphs
// that would have cited it rather than weakening them.

export const POSTIZ_READ_URL_VAR = "POSTIZ_READ_DATABASE_URL";

// A channel the customer connected, live or since removed.
export interface PostizChannel {
  name: string;
  platform: string;
  connectedIso: string;
  deletedIso: string | null;
  disabled: boolean;
}

// A published post we can point an analyst at.
export interface PostizPostRef {
  publishedIso: string;
  platform: string;
  url: string;
}

export interface PostizActivity {
  organizationId: string;
  // Published, top-level posts that still exist.
  published: number;
  // Published, top-level posts the customer later deleted. Counted and reported
  // SEPARATELY rather than folded into the total: deletion after the fact is
  // evidence of use, but presenting a deleted post as a live one is the kind of
  // overstatement that loses a whole response.
  publishedDeleted: number;
  // Published after the disputed charge, which is the strongest single number
  // we have against "I never received this" and "I did not authorise this".
  // Published strictly BEFORE the charge: establishes the account was already
  // in use when the disputed payment was taken.
  publishedBeforeCharge: number;
  // Published between the charge and the day the dispute was opened. Bounded at
  // the dispute deliberately: "used it after paying, then disputed" is a claim
  // an analyst accepts without wondering what happened after we started
  // fighting the case.
  publishedSinceCharge: number;
  publishedDeletedSinceCharge: number;
  // Anything deleted AFTER the dispute was opened. Rare, and worth naming.
  deletedAfterDispute: number;
  firstPublishedIso: string | null;
  lastPublishedIso: string | null;
  perPlatform: Array<{ platform: string; count: number }>;
  perPlatformSinceCharge: Array<{ platform: string; count: number }>;
  channelsLive: number;
  channelsDeleted: number;
  // Channels that existed at any point between the charge and the dispute.
  channelsDuringPeriod: number;
  channels: PostizChannel[];
  // Public URLs of real, still-live published posts. A bank analyst can click
  // one, which makes this the most checkable evidence in the package. Only live
  // posts are quoted: a link that 404s is worse than no link at all.
  recentPosts: PostizPostRef[];
  recentPostsSinceCharge: PostizPostRef[];
  queued: number;
  drafts: number;
}

// How many live post URLs to quote. Enough to be convincing, few enough to stay
// readable inside one evidence field.
const MAX_POST_URLS = 5;
const MAX_CHANNELS = 12;
const QUERY_TIMEOUT_MS = 5_000;

export class PostizActivitySource {
  private pool: Pool | null = null;
  private failedAt: number | null = null;

  // Env-only by design. This is a second database's credentials: keeping it out
  // of BotSettings means it is never rendered in a panel, never migrated into
  // the vault alongside our own secrets, and cannot be changed from Discord.
  private url(): string | null {
    return (process.env[POSTIZ_READ_URL_VAR] ?? "").trim() || null;
  }

  configured(): boolean {
    return this.url() != null;
  }

  private connect(): Pool | null {
    const url = this.url();
    if (!url) return null;
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: url,
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
        // Belt and braces alongside the grant: nothing here may ever write.
        options: "-c default_transaction_read_only=on",
      });
      this.pool.on("error", (error) => {
        actLog.warn("postiz read pool error", { "error.message": String(error) });
      });
    }
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => {});
    this.pool = null;
  }

  // Cheap reachability probe for the /config panel, so an operator can tell
  // "not configured" from "configured but not working".
  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    if (!this.configured()) return { ok: false, detail: `${POSTIZ_READ_URL_VAR} is not set` };
    const pool = this.connect();
    if (!pool) return { ok: false, detail: "no connection" };
    try {
      const res = await pool.query('SELECT count(*)::int AS n FROM "Integration" LIMIT 1');
      return { ok: true, detail: `reachable, ${res.rows[0]?.n ?? 0} channel row(s) visible` };
    } catch (error) {
      return { ok: false, detail: String(error).slice(0, 200) };
    }
  }

  // Everything in one round trip per question, all scoped to one organisation.
  // Returns null when unconfigured or unreachable: a missing fact must remove a
  // paragraph, never weaken one.
  async forOrganization(orgId: string, chargeAt: Date, disputeAt: Date): Promise<PostizActivity | null> {
    const pool = this.connect();
    if (!pool) return null;
    // One failure parks the source briefly so a dispute burst cannot turn a
    // dead database into dozens of slow webhook timeouts.
    if (this.failedAt && Date.now() - this.failedAt < 60_000) return null;

    try {
      // $2 = charge time, $3 = dispute opened. The "after the charge" window is
      // [charge, dispute], closed at the dispute on purpose.
      const [totals, platforms, channelRows, recent, recentAfter, states] = await Promise.all([
        pool.query(
          `SELECT
             count(*) FILTER (WHERE "deletedAt" IS NULL)                                       AS published,
             count(*) FILTER (WHERE "deletedAt" IS NOT NULL)                                   AS published_deleted,
             count(*) FILTER (WHERE "deletedAt" IS NULL AND "publishDate" < $2)                 AS before_charge,
             count(*) FILTER (WHERE "deletedAt" IS NULL AND "publishDate" >= $2
                              AND "publishDate" <= $3)                                          AS since_charge,
             count(*) FILTER (WHERE "deletedAt" IS NOT NULL AND "publishDate" >= $2
                              AND "publishDate" <= $3)                                          AS since_charge_deleted,
             count(*) FILTER (WHERE "deletedAt" > $3)                                           AS deleted_after_dispute,
             min("publishDate") FILTER (WHERE "deletedAt" IS NULL)                              AS first_at,
             max("publishDate") FILTER (WHERE "deletedAt" IS NULL)                              AS last_at
           FROM "Post"
           WHERE "organizationId" = $1 AND state = 'PUBLISHED' AND "parentPostId" IS NULL`,
          [orgId, chargeAt, disputeAt]
        ),
        pool.query(
          `SELECT i."providerIdentifier" AS platform,
                  count(*)::int AS count,
                  count(*) FILTER (WHERE p."publishDate" >= $2 AND p."publishDate" <= $3)::int AS since_charge
             FROM "Post" p JOIN "Integration" i ON i.id = p."integrationId"
            WHERE p."organizationId" = $1 AND p.state = 'PUBLISHED'
              AND p."parentPostId" IS NULL AND p."deletedAt" IS NULL
            GROUP BY 1 ORDER BY 2 DESC, 1 ASC`,
          [orgId, chargeAt, disputeAt]
        ),
        pool.query(
          `SELECT name, "providerIdentifier" AS platform, "createdAt", "deletedAt", disabled
             FROM "Integration" WHERE "organizationId" = $1 ORDER BY "createdAt" ASC`,
          [orgId]
        ),
        pool.query(
          `SELECT p."publishDate", p."releaseURL", i."providerIdentifier" AS platform
             FROM "Post" p JOIN "Integration" i ON i.id = p."integrationId"
            WHERE p."organizationId" = $1 AND p.state = 'PUBLISHED' AND p."deletedAt" IS NULL
              AND p."releaseURL" IS NOT NULL AND p."releaseURL" <> ''
            ORDER BY p."publishDate" DESC LIMIT $2`,
          [orgId, MAX_POST_URLS]
        ),
        pool.query(
          `SELECT p."publishDate", p."releaseURL", i."providerIdentifier" AS platform
             FROM "Post" p JOIN "Integration" i ON i.id = p."integrationId"
            WHERE p."organizationId" = $1 AND p.state = 'PUBLISHED' AND p."deletedAt" IS NULL
              AND p."releaseURL" IS NOT NULL AND p."releaseURL" <> ''
              AND p."publishDate" >= $2 AND p."publishDate" <= $3
            ORDER BY p."publishDate" DESC LIMIT $4`,
          [orgId, chargeAt, disputeAt, MAX_POST_URLS]
        ),
        pool.query(
          `SELECT state, count(*)::int AS count FROM "Post"
            WHERE "organizationId" = $1 AND "parentPostId" IS NULL AND "deletedAt" IS NULL
              AND state IN ('QUEUE','DRAFT')
            GROUP BY 1`,
          [orgId]
        ),
      ]);

      const t = totals.rows[0] ?? {};
      const channels: PostizChannel[] = channelRows.rows.map((r) => ({
        name: String(r.name ?? ""),
        platform: String(r.platform ?? ""),
        connectedIso: r.createdAt ? new Date(r.createdAt).toISOString() : "",
        deletedIso: r.deletedAt ? new Date(r.deletedAt).toISOString() : null,
        disabled: Boolean(r.disabled),
      }));
      const postRef = (r: { publishDate: Date; releaseURL: string; platform: string }): PostizPostRef => ({
        publishedIso: new Date(r.publishDate).toISOString(),
        platform: String(r.platform ?? ""),
        url: String(r.releaseURL),
      });
      const stateCount = (s: string) => Number(states.rows.find((r) => r.state === s)?.count ?? 0);
      // Existed at some point in the window: connected on or before the dispute,
      // and not already removed before the charge.
      const duringPeriod = channels.filter(
        (c) =>
          c.connectedIso &&
          new Date(c.connectedIso) <= disputeAt &&
          (!c.deletedIso || new Date(c.deletedIso) >= chargeAt)
      ).length;

      this.failedAt = null;
      return {
        organizationId: orgId,
        published: Number(t.published ?? 0),
        publishedDeleted: Number(t.published_deleted ?? 0),
        publishedBeforeCharge: Number(t.before_charge ?? 0),
        publishedSinceCharge: Number(t.since_charge ?? 0),
        publishedDeletedSinceCharge: Number(t.since_charge_deleted ?? 0),
        deletedAfterDispute: Number(t.deleted_after_dispute ?? 0),
        firstPublishedIso: t.first_at ? new Date(t.first_at).toISOString() : null,
        lastPublishedIso: t.last_at ? new Date(t.last_at).toISOString() : null,
        perPlatform: platforms.rows.map((r) => ({ platform: String(r.platform ?? "unknown"), count: Number(r.count) })),
        perPlatformSinceCharge: platforms.rows
          .filter((r) => Number(r.since_charge) > 0)
          .map((r) => ({ platform: String(r.platform ?? "unknown"), count: Number(r.since_charge) }))
          .sort((a, b) => b.count - a.count),
        channelsLive: channels.filter((c) => !c.deletedIso && !c.disabled).length,
        channelsDeleted: channels.filter((c) => c.deletedIso).length,
        channelsDuringPeriod: duringPeriod,
        channels: channels.slice(0, MAX_CHANNELS),
        recentPosts: recent.rows.map(postRef),
        recentPostsSinceCharge: recentAfter.rows.map(postRef),
        queued: stateCount("QUEUE"),
        drafts: stateCount("DRAFT"),
      };
    } catch (error) {
      this.failedAt = Date.now();
      actLog.warn("postiz activity query failed", { "postiz.org_id": orgId, "error.message": String(error) });
      return null;
    }
  }
}
