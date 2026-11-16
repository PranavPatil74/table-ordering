import { defineConfig, devices } from "@playwright/test";

import {
  E2E_ENV,
  E2E_PORT,
  E2E_PUBLIC_ENV,
  E2E_PUBLIC_PORT,
  FAKE_SUPABASE_PORT,
  isolatedEnv,
} from "./e2e/test-env";

const baseURL = `http://localhost:${E2E_PORT}`;

/**
 * Some machines (including this project's sandboxed dev environment) ship a Chromium build
 * that does not match the Playwright version. Point at it explicitly instead of downloading:
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome pnpm e2e
 * Normal setups should run `pnpm e2e:install` and leave this unset.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // Customers order on phones, so mobile is the primary target.
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
  ],
  // Fails before any test when the app is not wired to the test double (see e2e/preflight.mjs).
  globalSetup: "./e2e/global-setup.ts",
  // Tests run against the PRODUCTION build made by `pnpm e2e` / `pnpm e2e:build` into .next-e2e,
  // compiled in an isolated environment. Never run against a build made from your real .env.local.
  webServer: [
    // A test double for the Supabase endpoints the staff sign-in flow uses. NOT Supabase: see
    // the header of e2e/fake-supabase.mjs.
    {
      command: "node e2e/fake-supabase.mjs",
      url: `http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { FAKE_SUPABASE_PORT: String(FAKE_SUPABASE_PORT) },
    },
    {
      command: `pnpm start -p ${E2E_PORT}`,
      url: `${baseURL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: isolatedEnv(E2E_ENV),
    },
    // The same production build, configured with a public https address, so the "QR download and
    // printing are allowed" path can be tested next to the "refused for localhost" path above.
    {
      command: `pnpm start -p ${E2E_PUBLIC_PORT}`,
      url: `http://localhost:${E2E_PUBLIC_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: isolatedEnv(E2E_PUBLIC_ENV),
    },
  ],
});
