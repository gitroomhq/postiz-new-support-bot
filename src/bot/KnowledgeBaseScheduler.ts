import path from "path";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { mkdir, readdir, rename, rm, stat } from "fs/promises";
import * as tar from "tar";
import { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import { withTickSpan } from "../util/instrument";

const schedLog = log.child("scheduler:kb-refresh");

const HOUR_MS = 60 * 60 * 1000;

// The two repos the postinstall script clones into search/. The AI greps them to
// ground its answers, so keeping them current keeps the answers current.
const REPOS = ["postiz-app", "postiz-docs"];
const GITHUB_OWNER = "gitroomhq";

const DOWNLOAD_TIMEOUT_MS = 120_000;
// After a refresh where EVERY repo failed, hold off before retrying so a
// persistent failure (egress blocked, upstream outage) doesn't churn each tick.
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
// Warn on the first failure and every Nth after; the failures in between log
// at debug so Sentry sees the problem without a drumbeat.
const WARN_EVERY_N_FAILURES = 6;

// Refresh the Postiz source + docs snapshots under search/ so the AI answers
// against upstream, not the checkout captured at install time. The runtime
// image has no git binary (postinstall clones at build time only), so each
// refresh downloads the default-branch tarball from codeload, extracts into a
// temp dir, and swaps it in with two same-filesystem renames — a concurrent
// /ai grep only ever sees a complete old or complete new tree. Driven by the
// kbRefreshWorkflow looper's 60s kbTick activity (tick() keeps the
// enabled/interval due-check itself).
export class KnowledgeBaseScheduler {
  private readonly searchDir: string;
  // Guards a refresh outlasting the 60s tick (downloads can take a while) so
  // two ticks never extract the same repo concurrently.
  private refreshing = false;
  // codeload ETag per repo — a 304 means the default branch didn't move, which
  // counts as a successful (no-op) refresh.
  private readonly etags = new Map<string, string>();
  private readonly consecutiveFailures = new Map<string, number>();
  private backoffUntil = 0;

  constructor(
    private settings: SettingsStore,
    baseDir: string
  ) {
    this.searchDir = path.resolve(baseDir, "search");
  }

  async tick(): Promise<void> {
    if (!this.settings.kbRefreshEnabled()) return;
    if (!this.isDue()) return;
    if (Date.now() < this.backoffUntil) return;
    if (this.refreshing) return;
    await withTickSpan("kb-refresh", () => this.runRefresh());
  }

  private isDue(): boolean {
    const last = this.settings.kbLastRefreshAt();
    if (!last) return true;
    const intervalMs = Math.max(1, this.settings.kbRefreshIntervalHours()) * HOUR_MS;
    return Date.now() - last.getTime() >= intervalMs;
  }

  // Refresh every repo; stamp kbLastRefreshAt only when at least one succeeded,
  // so a total failure keeps the old timestamp, backs off, and retries later.
  private async runRefresh(): Promise<{ ok: number; failed: number }> {
    this.refreshing = true;
    let ok = 0;
    let failed = 0;
    try {
      for (const repo of REPOS) {
        if (await this.refreshRepo(repo)) ok++;
        else failed++;
      }
      if (ok > 0) await this.settings.recordKbRefresh();
      if (ok === 0 && failed > 0) this.backoffUntil = Date.now() + FAILURE_BACKOFF_MS;
      schedLog.info("kb.refreshed", { "kb.repos_ok": ok, "kb.repos_failed": failed });
    } finally {
      this.refreshing = false;
    }
    return { ok, failed };
  }

  // Manual /config "Refresh now": bypasses the due-check and the failure
  // backoff but still respects the in-flight guard so it can't collide with a
  // scheduled tick.
  async refreshNow(): Promise<{ ok: number; failed: number }> {
    if (this.refreshing) return { ok: 0, failed: REPOS.length };
    this.backoffUntil = 0;
    return withTickSpan("kb-refresh-manual", () => this.runRefresh());
  }

  // Download the repo's default-branch tarball and swap it in. A failure
  // (network, upstream) keeps the stale snapshot — answers still work, just
  // against the previous tree.
  private async refreshRepo(repo: string): Promise<boolean> {
    const repoDir = path.resolve(this.searchDir, repo);
    const tmpDir = path.resolve(this.searchDir, `.${repo}.tmp`);
    const oldDir = path.resolve(this.searchDir, `.${repo}.old`);
    try {
      // Self-heal a crash between the two swap renames: the complete previous
      // tree is still in .old — put it back before doing anything else.
      if (!(await this.exists(repoDir)) && (await this.exists(oldDir))) {
        await rename(oldDir, repoDir);
      }
      await rm(tmpDir, { recursive: true, force: true });
      const outcome = await this.downloadAndExtract(repo, tmpDir);
      if (outcome === "updated") {
        await this.swapInto(repoDir, oldDir, tmpDir);
      }
      const hadFailures = (this.consecutiveFailures.get(repo) ?? 0) > 0;
      this.consecutiveFailures.set(repo, 0);
      if (hadFailures) schedLog.info("kb.refresh_recovered", { "kb.repo": repo });
      return true;
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      const failures = (this.consecutiveFailures.get(repo) ?? 0) + 1;
      this.consecutiveFailures.set(repo, failures);
      const fields = {
        "kb.repo": repo,
        "kb.consecutive_failures": failures,
        "error.message": err instanceof Error ? err.message : String(err),
      };
      if (failures === 1 || failures % WARN_EVERY_N_FAILURES === 0) {
        schedLog.warn("kb pull failed", fields);
      } else {
        schedLog.debug("kb pull failed", fields);
      }
      return false;
    }
  }

  private async downloadAndExtract(repo: string, tmpDir: string): Promise<"updated" | "not_modified"> {
    const url = `https://codeload.github.com/${GITHUB_OWNER}/${repo}/tar.gz/HEAD`;
    const etag = this.etags.get(repo);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: etag ? { "If-None-Match": etag } : {},
    });
    if (res.status === 304) return "not_modified";
    if (!res.ok || !res.body) throw new Error(`tarball download failed: HTTP ${res.status}`);
    await mkdir(tmpDir, { recursive: true });
    // Tarball root is "<repo>-<sha>/" — strip it so tmpDir IS the repo tree.
    await pipeline(
      Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>),
      createGunzip(),
      tar.x({ cwd: tmpDir, strip: 1 })
    );
    if ((await readdir(tmpDir)).length === 0) throw new Error("tarball was empty");
    const newTag = res.headers.get("etag");
    if (newTag) this.etags.set(repo, newTag);
    return "updated";
  }

  // Two same-filesystem renames: concurrent greps see the complete old tree or
  // the complete new one (worst case a momentary ENOENT between the renames).
  private async swapInto(repoDir: string, oldDir: string, tmpDir: string): Promise<void> {
    await rm(oldDir, { recursive: true, force: true });
    if (await this.exists(repoDir)) await rename(repoDir, oldDir);
    await rename(tmpDir, repoDir);
    await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private exists(p: string): Promise<boolean> {
    return stat(p).then(
      () => true,
      () => false
    );
  }
}
