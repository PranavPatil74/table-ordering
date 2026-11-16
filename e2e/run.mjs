// @ts-check
/**
 * `pnpm e2e`: the whole E2E workflow in the right order, identically on Windows, macOS and Linux.
 *
 *   1. build the production app in an isolated environment (e2e/build.mjs)  [skip: --skip-build;
 *      build only: --build-only, which is what `pnpm e2e:build` does]
 *   2. check that the build is wired to the test double (e2e/preflight.mjs)
 *   3. run Playwright, passing any further arguments through
 *
 * Examples:   pnpm e2e        pnpm e2e --project=desktop e2e/manager.spec.ts
 *             pnpm e2e --skip-build        (reuse the last E2E build)
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { buildForE2E } from "./build.mjs";
import { E2E_ENV, PROJECT_ROOT, isolatedEnv, requireProjectRoot } from "./env.mjs";
import { staticProblems } from "./preflight.mjs";

const args = process.argv.slice(2);
const buildOnly = args.includes("--build-only");
const skipBuild = args.includes("--skip-build") || process.env.E2E_SKIP_BUILD === "1";
const playwrightArgs = args.filter((arg) => arg !== "--skip-build" && arg !== "--build-only");

try {
  requireProjectRoot();
  if (!skipBuild || buildOnly) buildForE2E();
  const problems = staticProblems();
  if (problems.length > 0) {
    throw new Error(
      "E2E configuration check failed. No tests were run.\n\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
} catch (error) {
  console.error(`\n[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (buildOnly) process.exit(0);

const result = spawnSync(
  process.execPath,
  [join(PROJECT_ROOT, "node_modules", "@playwright", "test", "cli.js"), "test", ...playwrightArgs],
  { cwd: PROJECT_ROOT, env: isolatedEnv(E2E_ENV), stdio: "inherit" },
);
process.exit(result.status ?? 1);
