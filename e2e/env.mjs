// @ts-check
/**
 * Single source of truth for the Playwright (E2E) environment, plain ESM so that BOTH the Node
 * scripts that build/run the tests (e2e/build.mjs, e2e/run.mjs) and the TypeScript side
 * (e2e/test-env.ts, playwright.config.ts) can use it without a TypeScript runner. Types live in
 * e2e/env.d.mts.
 *
 * EVERYTHING HERE IS A CLEARLY-FAKE TEST FIXTURE. No real credentials belong in this file.
 * Razorpay is intentionally left unset: payments are not exercised yet, and the app must report
 * "not configured" rather than fabricate a gateway.
 *
 * Supabase points at `e2e/fake-supabase.mjs`, a test double on its own port (NOT 54321, so it can
 * never collide with a real `supabase start`).
 *
 * WHY THIS FILE ALSO ISOLATES THE ENVIRONMENT
 * Next.js copies every NEXT_PUBLIC_* value into the compiled bundles during `next build`, server
 * bundles included, and a value that was set at build time can NOT be changed by the environment
 * of `next start`. A `.env.local` pointing at the real local Supabase (127.0.0.1:54321) therefore
 * made the production build talk to the real stack while the tests seeded the test double: menus
 * looked empty and staff sign-in never succeeded. `isolatedEnv()` is the one place that decides
 * what a build or a server for E2E is allowed to see, and it is used for both.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const E2E_PORT = 3100;
export const FAKE_SUPABASE_PORT = 54399;
/** A second production server whose public URL is a real-looking https origin (QR export allowed). */
export const E2E_PUBLIC_PORT = 3101;

/** Written into the E2E build directory by e2e/build.mjs and checked by e2e/preflight.mjs. */
export const MARKER_FILE = "e2e-build.json";
export const MARKER_KIND = "sandwich-express-e2e-build";

/** Where the E2E production build lives. Separate from `.next` so it never replaces your real build. */
export const E2E_DIST_DIR = ".next-e2e";

export const E2E_ENV = {
  NEXT_PUBLIC_APP_URL: `http://localhost:${E2E_PORT}`,
  // The QR origin is a RUNTIME, server-only setting (not frozen into the build like NEXT_PUBLIC_).
  APP_BASE_URL: `http://localhost:${E2E_PORT}`,
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_SUPABASE_PORT}`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-fixture-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "e2e-fixture-service-role-key",
};

/**
 * Same build, different runtime origin. NEXT_PUBLIC_APP_URL stays the address this server is really
 * reached at (it only drives cookies and is build-time anyway); APP_BASE_URL is what QR codes use.
 */
export const E2E_PUBLIC_ENV = {
  ...E2E_ENV,
  NEXT_PUBLIC_APP_URL: `http://localhost:${E2E_PUBLIC_PORT}`,
  APP_BASE_URL: "https://orders.example.com",
};

/** Fake accounts served by the test double (see e2e/fake-supabase.mjs). */
export const E2E_PASSWORD = "e2e-fixture-password";
export const E2E_ACCOUNTS = {
  counter: "counter@sandwich-express.test",
  manager: "manager@sandwich-express.test",
  inactive: "inactive@sandwich-express.test",
  noProfile: "noprofile@sandwich-express.test",
  limited: "limited@sandwich-express.test",
  outage: "outage@sandwich-express.test",
};

/**
 * The project root: the directory `pnpm` runs scripts in. (No `import.meta` here on purpose:
 * Playwright loads playwright.config.ts, and through it this file, as CommonJS.)
 */
export const PROJECT_ROOT = process.cwd();

/**
 * Variables that configure the app or a backend. None of them may come from the developer's shell
 * or from `.env*` files while building or serving for E2E: they are replaced by the fixtures above
 * or blanked. (Blank, not deleted: Next.js never lets a `.env.local` value override a variable that
 * already exists in the process environment, even an empty one, and the app treats blank as unset.)
 */
const ISOLATED_NAME =
  /^(NEXT_PUBLIC_|SUPABASE_|RAZORPAY_)|^(APP_BASE_URL|TEST_DATABASE_URL|DATABASE_URL)$/;

/** Names (never values) of the variables declared in the project's `.env*` files. */
export function declaredEnvNames(root = PROJECT_ROOT) {
  const names = new Set();
  for (const file of readdirSync(root)) {
    if (!/^\.env(\..+)?$/.test(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match) names.add(/** @type {string} */ (match[1]));
    }
  }
  return names;
}

/**
 * The environment for building or serving the app under test: the current environment with every
 * app/backend setting (and anything an `.env*` file declares) blanked, then `overrides` applied,
 * then the E2E build directory selected. Pure apart from reading `.env*` file NAMES.
 *
 * @param {Record<string, string>} overrides
 * @param {{ base?: Record<string, string | undefined>, root?: string }} [options]
 * @returns {Record<string, string>}
 */
export function isolatedEnv(overrides, options = {}) {
  const base = options.base ?? process.env;
  const declared = declaredEnvNames(options.root);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    env[name] = ISOLATED_NAME.test(name) || declared.has(name) ? "" : value;
  }
  for (const name of declared) env[name] = "";
  // NODE_ENV from a developer's shell ("development") breaks `next build`/`next start`; Next.js
  // chooses production itself for both, so never inherit it.
  delete env.NODE_ENV;
  return { ...env, ...overrides, NEXT_DIST_DIR: E2E_DIST_DIR };
}

/** Stops early, with a clear message, when a script is started outside the project folder. */
export function requireProjectRoot(root = PROJECT_ROOT) {
  if (!existsSync(join(root, "e2e", "env.mjs")) || !existsSync(join(root, "package.json"))) {
    throw new Error(
      `Run this from the project folder (current folder: ${root}). Use \`pnpm e2e\` or \`pnpm e2e:build\`.`,
    );
  }
}
