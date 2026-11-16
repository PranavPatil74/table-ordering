import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Database tests: run with `pnpm test:db`.
 *
 * These need a real PostgreSQL server. The global setup starts a throwaway local cluster (or
 * uses TEST_DATABASE_URL), applies supabase/migrations to a template database, and each test
 * file works in its own cloned database. Kept separate from `pnpm test` so the default unit
 * run stays fast and needs no server.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    globalSetup: ["./src/test/db/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
