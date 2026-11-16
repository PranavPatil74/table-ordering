// @ts-check
/**
 * Builds the production app for the E2E tests, in an isolated environment and its own directory.
 *
 *   pnpm e2e:build      (or just `pnpm e2e`, which runs this first; both go through e2e/run.mjs)
 *
 * - The build sees ONLY the fixture environment from e2e/env.mjs. Values from your shell or from
 *   `.env.local` (for example the real local Supabase on 127.0.0.1:54321) are blanked, because
 *   Next.js freezes NEXT_PUBLIC_* into the compiled code and `next start` cannot change them.
 * - The output goes to `.next-e2e`, so your normal `.next` (built from your real `.env.local`) is
 *   neither replaced nor mistaken for the test build.
 * - It does not touch your real Supabase database, or any database.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  E2E_DIST_DIR,
  E2E_ENV,
  MARKER_FILE,
  MARKER_KIND,
  PROJECT_ROOT,
  isolatedEnv,
  requireProjectRoot,
} from "./env.mjs";

export function buildForE2E() {
  requireProjectRoot();
  const nextBin = join(PROJECT_ROOT, "node_modules", "next", "dist", "bin", "next");
  const distDir = join(PROJECT_ROOT, E2E_DIST_DIR);
  // A stale build can hide failures, so always start clean.
  rmSync(distDir, { recursive: true, force: true });

  // `next build` rewrites this tracked file to point at the build directory it used.
  const nextEnvPath = join(PROJECT_ROOT, "next-env.d.ts");
  const nextEnvBefore = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;

  process.stdout.write(
    `[e2e] Building into ${E2E_DIST_DIR}/ against the test double at ${E2E_ENV.NEXT_PUBLIC_SUPABASE_URL} ` +
      "(your shell and .env.local values are ignored for this build).\n",
  );
  const result = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: PROJECT_ROOT,
    env: isolatedEnv(E2E_ENV),
    stdio: "inherit",
  });

  if (nextEnvBefore !== null && readFileSync(nextEnvPath, "utf8") !== nextEnvBefore) {
    writeFileSync(nextEnvPath, nextEnvBefore);
  }
  if (result.status !== 0) {
    throw new Error(`E2E build failed (exit ${String(result.status)}).`);
  }

  // Non-secret record of what the build was compiled against; checked by e2e/preflight.mjs.
  writeFileSync(
    join(distDir, MARKER_FILE),
    JSON.stringify(
      {
        kind: MARKER_KIND,
        supabaseUrl: E2E_ENV.NEXT_PUBLIC_SUPABASE_URL,
        appUrl: E2E_ENV.NEXT_PUBLIC_APP_URL,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
