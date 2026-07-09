import { execFileSync } from "node:child_process";
import * as path from "node:path";

// The worker deployment build id AND the Sentry release, so a Temporal
// deployment version maps 1:1 to Sentry issues. Resolution order:
//   1. `git rev-parse --short=6 HEAD` — when deployed from a git checkout
//   2. dist/temporal/buildInfo.json — stamped by the build step, survives
//      dist-only deploys without a .git directory
//   3. GIT_SHA env (CI/deploy tooling fallback)
//   4. package.json version (last resort; NOT unique per deploy — worker
//      versioning degenerates when this is hit)
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
    cached = execFileSync("git", ["rev-parse", "--short=6", "HEAD"], {
      cwd: repoRoot(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (cached) return cached;
  } catch {
    // fall through to the build-time stamp / env / package.json
  }
  try {
    // Written by dist/scripts/bundleWorkflows.js during `pnpm build`; lives
    // next to this file in dist/temporal/.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const info = require("./buildInfo.json") as { gitSha?: string };
    if (info.gitSha) {
      cached = info.gitSha;
      return cached;
    }
  } catch {
    // no stamp (ts-node dev before first build) — keep falling through
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

// Test seam: reset the memoized value (unit tests exercise the fallback chain).
export function resetBuildIdCacheForTests(): void {
  cached = null;
}
