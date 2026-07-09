import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { bundleWorkflowCode } from "@temporalio/worker";

// Build-time workflow bundling (runs as the last `pnpm build` step, against
// the COMPILED dist/ output — webpack never needs a TS loader). Produces
// dist/temporal/workflow-bundle.js, which the worker loads directly; ts-node
// dev falls back to runtime bundling from workflowsPath.
//
// This step doubles as the sandbox guardrail: any `node:*` (or app-module)
// import that sneaks into src/temporal/workflows/** fails the build loudly.

async function main(): Promise<void> {
  const workflowsPath = path.join(__dirname, "..", "temporal", "workflows");
  const outPath = path.join(__dirname, "..", "temporal", "workflow-bundle.js");
  const { code } = await bundleWorkflowCode({
    workflowsPath,
    workflowInterceptorModules: [path.join(workflowsPath, "interceptors")],
  });
  fs.writeFileSync(outPath, code);
  process.stdout.write(`workflow bundle written: ${path.relative(process.cwd(), outPath)} (${(code.length / 1024).toFixed(0)} KiB)\n`);

  // Stamp the git SHA at BUILD time (the build always runs in the checkout,
  // per README) so a dist-only deploy without .git still gets a real worker
  // build id — buildId.ts reads this file as its second fallback.
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=6", "HEAD"], {
      cwd: path.join(__dirname, "..", ".."),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) {
      const infoPath = path.join(__dirname, "..", "temporal", "buildInfo.json");
      fs.writeFileSync(infoPath, JSON.stringify({ gitSha: sha }));
      process.stdout.write(`build id stamped: ${sha}\n`);
    }
  } catch {
    process.stdout.write("build id stamp skipped (no git available at build time)\n");
  }
}

main().catch((err) => {
  process.stderr.write(`workflow bundling failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
