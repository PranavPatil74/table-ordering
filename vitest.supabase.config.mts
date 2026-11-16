import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration tests against a REAL local Supabase stack (Auth, PostgREST, Realtime).
 * Run with `pnpm test:supabase` while `supabase start` is running; see docs/database.md.
 *
 * Missing configuration is an error, never a silent pass. The only way to skip is the explicit
 * ALLOW_SUPABASE_TESTS_SKIP=1, which prints a warning and runs nothing.
 */
const skip = process.env.ALLOW_SUPABASE_TESTS_SKIP === "1" && !process.env.SUPABASE_URL;
if (skip) {
  console.warn(
    "[supabase tests] SKIPPED (ALLOW_SUPABASE_TESTS_SKIP=1, no SUPABASE_URL). " +
      "Nothing about Supabase Auth, PostgREST or Realtime was verified.",
  );
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: skip ? [] : ["src/supabase-it/**/*.supabase.test.ts"],
    passWithNoTests: skip,
    globalSetup: skip ? [] : ["./src/supabase-it/global-setup.ts"],
    // One shared stack: run files one after another so Realtime and rate behaviour stay predictable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
});
