import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static guard over .github/workflows/ci.yml. It cannot prove the workflow runs (only GitHub can)
 * but it stops the Supabase job from quietly losing its safety properties: never printing the
 * stack's keys, never touching a hosted project or repository secrets, and actually running the
 * API tests after the environment is exported.
 */

const workflow = readFileSync(path.resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

function jobText(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} must exist`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const supabaseJob = jobText("supabase-replay");

describe("supabase-replay job", () => {
  it("starts the stack, applies migrations and seed, then runs the API integration tests in that order", () => {
    const order = [
      "supabase start",
      "supabase db reset",
      "supabase status -o env",
      "pnpm test:supabase",
    ].map((marker) => supabaseJob.indexOf(marker));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("masks every key before exporting it, and exports through GITHUB_ENV only", () => {
    for (const value of ["$anon", "$service", "$DB_URL"]) {
      expect(supabaseJob).toContain(`::add-mask::${value}`);
    }
    const maskAt = supabaseJob.indexOf("::add-mask::$anon");
    const exportAt = supabaseJob.indexOf('>> "$GITHUB_ENV"');
    expect(maskAt).toBeGreaterThan(-1);
    expect(exportAt).toBeGreaterThan(maskAt);
  });

  it("never prints a key: no tracing, and no echo of a secret variable except the mask and env-file writes", () => {
    expect(supabaseJob).not.toMatch(/\bset\s+-\w*x|bash\s+-\w*x/);
    // The job has no legitimate use for cat/printenv/env dumps: any of them could print a key.
    expect(supabaseJob).not.toMatch(/\bcat\b|\bprintenv\b|^\s*env\s*$|\benv\s*\|/m);
    // `supabase status` output contains the keys, so it must always be redirected to a file.
    for (const line of supabaseJob.split("\n").filter((l) => /^\s*supabase status\b/.test(l))) {
      expect(line, "supabase status output must be redirected, never printed").toMatch(/>\s*"?\$/);
    }
    const echoes = supabaseJob
      .split("\n")
      .filter((line) => /\becho\b/.test(line))
      .filter((line) =>
        /\$\{?(anon|service|ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY|PUBLISHABLE_KEY|DB_URL|SUPABASE_\w*KEY)\b/.test(
          line,
        ),
      );
    for (const line of echoes) {
      // The WHOLE line must be one of the two allowed shapes, so a leak cannot ride along on a
      // line that also contains a legitimate mask (`echo "::add-mask::$x"; echo "$x"`).
      expect(line, "a key may only be echoed as a mask or into GITHUB_ENV").toMatch(
        /^\s*echo "::add-mask::\$\{?\w+\}?"\s*$|^\s*echo "SUPABASE_[A-Z_]+=\$\{?\w+\}?"\s*$/,
      );
    }
  });

  it("uses no repository secrets and never links, pushes to or talks to a hosted project", () => {
    expect(supabaseJob).not.toMatch(/\$\{\{\s*secrets\./);
    expect(supabaseJob).not.toMatch(
      /supabase\s+(link|login|db\s+push)|SUPABASE_ACCESS_TOKEN|supabase\.co/,
    );
  });

  it("dumps service logs only on failure", () => {
    const block = supabaseJob.slice(supabaseJob.indexOf("Service logs on failure"));
    expect(block).toMatch(/if:\s*failure\(\)/);
  });
});

describe("database job", () => {
  it("runs the plain-PostgreSQL suite on both the tested version and the one Supabase targets", () => {
    const job = jobText("database");
    expect(job).toMatch(/pg:\s*\["16",\s*"17"\]/);
    expect(job).toContain("pnpm test:db");
  });
});
