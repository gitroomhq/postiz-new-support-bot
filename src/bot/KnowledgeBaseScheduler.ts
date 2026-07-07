import { spawn } from "child_process";
import path from "path";
import { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import { withTickSpan, wasCaptured } from "../util/instrument";

const schedLog = log.child("scheduler:kb-refresh");

const HOUR_MS = 60 * 60 * 1000;
// Re-check cadence, decoupled from the configured interval so a fresh boot pulls
// shortly after start rather than a full interval later. The due-check makes the
// steady-state ticks cheap in-memory no-ops.
const CHECK_INTERVAL_MS = 60 * 1000;

// The two repos the postinstall script clones into search/. The AI greps them to
// ground its answers, so keeping them current keeps the answers current.
const REPOS = ["postiz-app", "postiz-docs"];

// Periodically `git pull` the cloned Postiz source + docs so the AI answers
// against upstream, not the checkout captured at install time.
export class KnowledgeBaseScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly searchDir: string;
  // Guards a pull outlasting the 60s tick (a reset can take a moment on slow
  // disk/network) so two ticks never reset the same repo concurrently.
  private refreshing = false;

  constructor(
    private settings: SettingsStore,
    baseDir: string
  ) {
    this.searchDir = path.resolve(baseDir, "search");
  }

  start(): void {
    // Pull once right away: on first boot kbLastRefreshAt is null (due), and after
    // long downtime the clone may be stale.
    this.runTick();
    this.timer = setInterval(() => this.runTick(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private runTick(): void {
    this.tick().catch((err) => {
      if (!wasCaptured(err)) schedLog.error("tick failed", err);
    });
  }

  async tick(): Promise<void> {
    if (!this.settings.kbRefreshEnabled()) return;
    if (!this.isDue()) return;
    if (this.refreshing) return;
    await withTickSpan("kb-refresh", () => this.runRefresh());
  }

  private isDue(): boolean {
    const last = this.settings.kbLastRefreshAt();
    if (!last) return true;
    const intervalMs = Math.max(1, this.settings.kbRefreshIntervalHours()) * HOUR_MS;
    return Date.now() - last.getTime() >= intervalMs;
  }

  // Pull every repo; stamp kbLastRefreshAt only when at least one succeeded, so a
  // total failure keeps the old timestamp and simply retries next tick.
  private async runRefresh(): Promise<{ ok: number; failed: number }> {
    this.refreshing = true;
    let ok = 0;
    let failed = 0;
    try {
      for (const repo of REPOS) {
        if (await this.pullRepo(repo)) ok++;
        else failed++;
      }
      if (ok > 0) await this.settings.recordKbRefresh();
      schedLog.info("kb.refreshed", { "kb.repos_ok": ok, "kb.repos_failed": failed });
    } finally {
      this.refreshing = false;
    }
    return { ok, failed };
  }

  // Manual /config "Refresh now": bypasses the due-check but still respects the
  // in-flight guard so it can't collide with a scheduled tick.
  async refreshNow(): Promise<{ ok: number; failed: number }> {
    if (this.refreshing) return { ok: 0, failed: REPOS.length };
    return withTickSpan("kb-refresh-manual", () => this.runRefresh());
  }

  // Shallow update: fetch the tip and hard-reset the working tree to it. Matches
  // the --depth 1 clone from postinstall (no history to fast-forward). A failure
  // (network, or a missing clone) is logged and the stale checkout is kept —
  // answers still work, just against the previous snapshot.
  private async pullRepo(repo: string): Promise<boolean> {
    const dir = path.resolve(this.searchDir, repo);
    try {
      await this.git(["-C", dir, "fetch", "--depth", "1", "origin"]);
      await this.git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
      return true;
    } catch (err) {
      schedLog.warn("kb pull failed", {
        "kb.repo": repo,
        "error.message": err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private git(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim().slice(0, 200)}`));
      });
    });
  }
}
