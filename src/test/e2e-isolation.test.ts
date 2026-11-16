import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  E2E_DIST_DIR,
  E2E_ENV,
  E2E_PUBLIC_ENV,
  FAKE_SUPABASE_PORT,
  MARKER_FILE,
  MARKER_KIND,
  declaredEnvNames,
  isolatedEnv,
} from "../../e2e/env.mjs";
import { staticProblems } from "../../e2e/preflight.mjs";

/**
 * Guards the E2E workflow against the failure that made 124 of 192 browser tests fail: a
 * production build compiled against the real local Supabase (from `.env.local` or the shell)
 * while the tests seeded the test double. All values below are fake.
 */

const REAL_LOCAL = "http://127.0.0.1:54321";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "se-e2e-iso-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("isolatedEnv", () => {
  const shell = {
    PATH: "/usr/bin",
    NODE_ENV: "development",
    NEXT_PUBLIC_SUPABASE_URL: REAL_LOCAL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "decoy-real-publishable",
    SUPABASE_URL: REAL_LOCAL,
    SUPABASE_SERVICE_ROLE_KEY: "decoy-real-service-role",
    APP_BASE_URL: "https://real.example.com",
    RAZORPAY_KEY_ID: "rzp_test_decoy",
    TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/opt/chrome",
  };

  it("replaces every backend/app setting with the fixture or a blank, and keeps unrelated variables", () => {
    writeFileSync(join(root, ".env.local"), "MY_DECLARED_SETTING=secret-from-file\n");
    const env = isolatedEnv(E2E_ENV, { base: { ...shell, MY_DECLARED_SETTING: "x" }, root });

    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(`http://127.0.0.1:${FAKE_SUPABASE_PORT}`);
    expect(env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe("e2e-fixture-publishable-key");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("e2e-fixture-service-role-key");
    expect(env.SUPABASE_URL).toBe("");
    expect(env.RAZORPAY_KEY_ID).toBe(""); // payments stay "not configured" in E2E
    expect(env.TEST_DATABASE_URL).toBe("");
    expect(env.MY_DECLARED_SETTING).toBe(""); // anything a .env file declares is blanked too
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).toBe("/opt/chrome");
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.NEXT_DIST_DIR).toBe(E2E_DIST_DIR);
    expect(JSON.stringify(env)).not.toMatch(/54321|decoy|real\.example|secret-from-file/);
  });

  it("blanks names declared in .env files even when the shell does not define them", () => {
    writeFileSync(join(root, ".env.local"), "export FROM_FILE_ONLY=abc\n# NOT_A_SETTING\n");
    const env = isolatedEnv({}, { base: { PATH: "/bin" }, root });
    expect(env.FROM_FILE_ONLY).toBe("");
    expect(declaredEnvNames(root)).toEqual(new Set(["FROM_FILE_ONLY"]));
  });

  it("lets the public-HTTPS server keep its own QR origin on top of the same isolation", () => {
    const env = isolatedEnv(E2E_PUBLIC_ENV, { base: shell, root });
    expect(env.APP_BASE_URL).toBe("https://orders.example.com");
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(E2E_ENV.NEXT_PUBLIC_SUPABASE_URL);
  });

  it("never points the fixture at a real Supabase", () => {
    expect(E2E_ENV.NEXT_PUBLIC_SUPABASE_URL).not.toContain(":54321");
    expect(FAKE_SUPABASE_PORT).not.toBe(54321);
  });
});

describe("staticProblems (is the compiled app wired to the test double?)", () => {
  function writeBuild(options: { serverCode: string; marker?: object | null }) {
    const dist = join(root, E2E_DIST_DIR);
    mkdirSync(join(dist, "server"), { recursive: true });
    mkdirSync(join(dist, "static"), { recursive: true });
    writeFileSync(join(dist, "server", "chunk.js"), options.serverCode);
    if (options.marker !== null) {
      writeFileSync(
        join(dist, MARKER_FILE),
        JSON.stringify(
          options.marker ?? { kind: MARKER_KIND, supabaseUrl: E2E_ENV.NEXT_PUBLIC_SUPABASE_URL },
        ),
      );
    }
  }
  const good = `fetch("http://127.0.0.1:${FAKE_SUPABASE_PORT}/rest/v1/menu")`;

  it("accepts a build made for the test double", () => {
    writeBuild({ serverCode: good });
    expect(staticProblems(root)).toEqual([]);
  });

  it("ignores supabase-js merely mentioning its own domain", () => {
    writeBuild({ serverCode: `${good};const d=".supabase.co";` });
    expect(staticProblems(root)).toEqual([]);
  });

  it("reports a missing build with the command to fix it", () => {
    expect(staticProblems(root).join(" ")).toMatch(/pnpm e2e/);
  });

  it("rejects a build compiled against the real local Supabase", () => {
    writeBuild({ serverCode: `${good};fetch("${REAL_LOCAL}/rest/v1/menu")` });
    expect(staticProblems(root).join(" ")).toMatch(/127\.0\.0\.1:54321/);
  });

  it("rejects a build compiled against a hosted project", () => {
    writeBuild({
      serverCode: `${good};fetch("https://abcdefghijklmnopqrst.supabase.co/rest/v1/x")`,
    });
    expect(staticProblems(root).join(" ")).toMatch(/hosted/);
  });

  it("rejects a build that does not contain the test double address", () => {
    writeBuild({ serverCode: `fetch("${REAL_LOCAL}/x")` });
    const text = staticProblems(root).join(" ");
    expect(text).toMatch(/does not contain the test double address/);
  });

  it("rejects a marker recorded for another backend, naming only host:port", () => {
    writeBuild({ serverCode: good, marker: { kind: MARKER_KIND, supabaseUrl: REAL_LOCAL } });
    const text = staticProblems(root).join(" ");
    expect(text).toMatch(/127\.0\.0\.1:54321/);
    expect(text).not.toMatch(/http:\/\//);
  });
});

describe("the E2E workflow wiring", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

  it("`pnpm e2e` builds in isolation first; plain `pnpm build` is unchanged for real use", () => {
    expect(scripts.e2e).toBe("node e2e/run.mjs");
    expect(scripts["e2e:build"]).toBe("node e2e/run.mjs --build-only");
    expect(scripts.build).toBe("next build");
  });

  it("Playwright serves the isolated build with the isolated env and runs the preflight", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain("isolatedEnv(E2E_ENV)");
    expect(config).toContain("isolatedEnv(E2E_PUBLIC_ENV)");
    expect(config).toContain('globalSetup: "./e2e/global-setup.ts"');
    expect(config).not.toMatch(/env: E2E_(PUBLIC_)?ENV,/);
  });

  it("builds into its own directory, which is ignored by git, prettier, eslint and tsc", () => {
    expect(read("next.config.ts")).toContain("process.env.NEXT_DIST_DIR");
    for (const file of [".gitignore", ".prettierignore", "eslint.config.mjs", "tsconfig.json"]) {
      expect(read(file), file).toContain(".next-e2e");
    }
  });
});
