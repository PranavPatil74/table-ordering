import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 2's security promises. They read source text, so they cannot prove
 * runtime behaviour, but they stop the easy regressions: the sign-in code reaching for the
 * service-role key, a client component importing server code, or a staff route shipping without
 * an authorisation check.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function walk(dir: string): string[] {
  const abs = path.join(root, dir);
  return readdirSync(abs).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file);

const authFiles = [
  ...walk("src/lib/auth"),
  ...walk("src/lib/supabase"),
  ...walk("src/app/staff"),
  ...walk("src/app/api/staff"),
  "src/proxy.ts",
].filter(isSource);

describe("Phase 2 never touches privileged credentials", () => {
  it("has files to check", () => {
    expect(authFiles.length).toBeGreaterThan(10);
  });

  it.each(authFiles)("%s does not use the service-role key or the server env", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/SERVICE_ROLE|serviceRole|service_role/i);
    expect(source).not.toMatch(/getServerEnv|env\/server/);
    expect(source).not.toMatch(/RAZORPAY/i);
  });

  it("Supabase clients here are built from the publishable key only", () => {
    for (const file of ["src/lib/supabase/server.ts", "src/lib/supabase/proxy-session.ts"]) {
      expect(read(file)).toContain("supabasePublishableKey");
    }
  });

  it("no code in the staff area can create staff, set roles or write profiles", () => {
    for (const file of authFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/auth\.admin|signUp\(|\.insert\(|\.upsert\(|\.delete\(\)/);
      expect(source, file).not.toMatch(
        /from\(["']staff_profiles["']\)\s*\.(update|insert|upsert|delete)/,
      );
    }
  });

  it("never reads a role from user metadata", () => {
    for (const file of authFiles) {
      expect(read(file), file).not.toMatch(/user_metadata|app_metadata|raw_user_meta/);
    }
  });

  it("does not log passwords or whole error objects", () => {
    for (const file of authFiles) {
      for (const line of read(file)
        .split("\n")
        .filter((l) => /console\.(log|warn|error)/.test(l))) {
        expect(line, `${file}: ${line}`).not.toMatch(/password|\berror\b[,)]|formData/i);
      }
    }
  });
});

describe("every staff entry point has a server-side guard", () => {
  it.each(["src/app/staff/(protected)/layout.tsx", "src/app/staff/(protected)/page.tsx"])(
    "%s calls requireStaffPage",
    (file) => {
      expect(read(file)).toMatch(/await requireStaffPage\(/);
    },
  );

  it("the staff API route calls requireStaffApi", () => {
    expect(read("src/app/api/staff/me/route.ts")).toMatch(/await requireStaffApi\(/);
  });

  it("client components never import server-only auth modules", () => {
    for (const file of authFiles.filter((f) => read(f).trimStart().startsWith('"use client"'))) {
      expect(read(file), file).not.toMatch(/lib\/auth\/session|lib\/supabase\/server|server-only/);
    }
  });

  it("the sign-in and sign-out actions are Server Actions defined in 'use server' files", () => {
    for (const file of ["src/app/staff/login/actions.ts", "src/app/staff/actions.ts"]) {
      expect(read(file).trimStart().startsWith('"use server"'), file).toBe(true);
    }
  });

  it("there is no sign-up route or page anywhere in the app", () => {
    const appFiles = walk("src/app").join("\n").toLowerCase();
    expect(appFiles).not.toMatch(/sign-?up|register|invite/);
    for (const file of walk("src").filter(isSource)) {
      expect(read(file), file).not.toMatch(/auth\.signUp|signUp\(/);
    }
  });
});

describe("staff responses are not cacheable or indexable", () => {
  it("next.config sets no-store and noindex on staff pages and APIs", async () => {
    const config = (await import("../../next.config")).default;
    const rules = await config.headers!();
    for (const source of ["/staff/:path*", "/api/staff/:path*"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toBeDefined();
      const headers = Object.fromEntries(rule!.headers.map((h) => [h.key, h.value]));
      expect(headers["Cache-Control"]).toBe("private, no-store");
      expect(headers["X-Robots-Tag"]).toContain("noindex");
    }
  });
});
