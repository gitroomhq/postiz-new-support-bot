import { execFileSync } from "node:child_process";
import * as path from "node:path";

// The worker deployment build id AND the Sentry release, so a Temporal
// deployment version maps 1:1 to Sentry issues. Resolution order:
//   1. dist/temporal/buildInfo.json — stamped by the build step (git SHA, or
//      a content hash of dist/ on a .git-less build machine). Preferred
//      because it describes the artifacts actually running; runtime git can
//      misreport when the checkout advanced past the last build. Absent under
//      ts-node dev (the stamp lives in dist/), so dev falls through to git.
//   2. `git rev-parse --short=6 HEAD` — ts-node dev in a checkout
//   3. GIT_SHA env (CI/deploy tooling fallback)
//   4. package.json version (last resort; NOT unique per deploy — worker
//      versioning degenerates when this is hit, and the panel flags it)
// Resolved once, synchronously, at first use. Deliberately dependency-free
// (no logger import): logger.ts calls this for the Sentry release.

let cached: string | null = null;

// dist/temporal/buildId.js → ../.. is the repo root; same depth under ts-node
// from src/temporal (mirrors the appRelease() trick in util/logger.ts).
function repoRoot(): string {
  return path.join(__dirname, "..", "..");
}

export function resolveBuildId(): string {
  if (cached) return cached;
  try {
    // Written by dist/scripts/bundleWorkflows.js during `pnpm build`; lives
    // next to this file in dist/temporal/. `gitSha` is the pre-rename field
    // read for one release so a mixed old-stamp/new-code dist still resolves.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const info = require("./buildInfo.json") as { buildId?: string; gitSha?: string };
    const stamped = info.buildId ?? info.gitSha;
    if (stamped) {
      cached = stamped;
      return cached;
    }
  } catch {
    // no stamp (ts-node dev before first build) — keep falling through
  }
  try {
    cached = execFileSync("git", ["rev-parse", "--short=6", "HEAD"], {
      cwd: repoRoot(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (cached) return cached;
  } catch {
    // fall through to env / package.json
  }
  const envSha = (process.env.GIT_SHA ?? "").trim();
  if (envSha) {
    cached = envSha.slice(0, 6);
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { version?: string };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}

// True when the resolver bottomed out at the package.json version — the id is
// shared across deploys, so deployment versioning/rollback is meaningless.
// Surfaced in the /config → Temporal panel.
export function buildIdIsDegenerate(id: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(id) || id === "unknown";
}

// Test seam: reset the memoized value (unit tests exercise the fallback chain).
export function resetBuildIdCacheForTests(): void {
  cached = null;
}
