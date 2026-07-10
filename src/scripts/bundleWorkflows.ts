import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { bundleWorkflowCode } from "@temporalio/worker";

// Build-time workflow bundling (runs as the last `pnpm build` step, against
// the COMPILED dist/ output — webpack never needs a TS loader). Produces
// dist/temporal/workflow-bundle.js, which the worker loads directly; ts-node
// dev falls back to runtime bundling from workflowsPath.
//
// This step doubles as the sandbox guardrail: any `node:*` (or app-module)
// import that sneaks into src/temporal/workflows/** fails the build loudly.

// Deterministic 6-hex-char digest of every compiled .js under dist/ (sorted
// relative paths + contents; includes the workflow bundle written above,
// excludes buildInfo.json by extension). The git-less build id: changes
// exactly when the shipped code changes.
function hashDist(distRoot: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && p.endsWith(".js")) files.push(p);
    }
  };
  walk(distRoot);
  files.sort();
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.relative(distRoot, f));
    h.update("\0");
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex").slice(0, 6);
}

async function main(): Promise<void> {
  const workflowsPath = path.join(__dirname, "..", "temporal", "workflows");
  const outPath = path.join(__dirname, "..", "temporal", "workflow-bundle.js");
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    workflowInterceptorModules: [path.join(workflowsPath, "interceptors")],
  });
  fs.writeFileSync(outPath, code);
  process.stdout.write(`workflow bundle written: ${path.relative(process.cwd(), outPath)} (${(code.length / 1024).toFixed(0)} KiB)\n`);

  // Stamp the worker build id at BUILD time — buildId.ts reads this file as
  // its FIRST choice (it describes the artifacts actually running, where
  // runtime git can misreport a checkout newer than the last build). Prefer
  // the git SHA; on a .git-less build machine (the deploy has no env access
  // either, so GIT_SHA can't patch it up) fall back to a content hash of
  // dist/ so every deploy still gets a unique, meaningful deployment version.
  let buildId: string | null = null;
  let source: "git" | "hash" = "git";
  try {
    buildId =
      execFileSync("git", ["rev-parse", "--short=6", "HEAD"], {
        cwd: path.join(__dirname, "..", ".."),
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || null;
  } catch {
    buildId = null;
  }
  if (!buildId) {
    source = "hash";
    buildId = hashDist(path.join(__dirname, ".."));
  }
  const infoPath = path.join(__dirname, "..", "temporal", "buildInfo.json");
  fs.writeFileSync(infoPath, JSON.stringify({ buildId, source }));
  process.stdout.write(`build id stamped: ${buildId} (${source})\n`);
}

main().catch((err) => {
  process.stderr.write(`workflow bundling failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
