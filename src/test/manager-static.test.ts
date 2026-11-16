import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 3. They read source text: they cannot prove runtime behaviour, but they
 * stop the easy regressions (an admin page or action added without a manager check, a write that
 * bypasses RLS with a privileged key, a client component reaching server code).
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}
const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file);

const MANAGER = "src/app/staff/(protected)/manager";
const managerFiles = walk(MANAGER).filter(isSource);
const pages = managerFiles.filter((f) => f.endsWith("page.tsx"));
const actionFiles = managerFiles.filter((f) => f.endsWith("actions.ts"));

describe("the manager area", () => {
  it("has pages and action files to check", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
    // menu, tables, and (Phase 4) staff. Each one is checked below.
    expect(actionFiles.length).toBe(3);
  });

  it.each([...pages, `${MANAGER}/layout.tsx`])('%s calls requireStaffPage("manager")', (file) => {
    expect(read(file)).toMatch(/await requireStaffPage\("manager"\)/);
  });

  it.each(actionFiles)(
    "%s is a 'use server' file where every export goes through managerAction",
    (file) => {
      const source = read(file);
      expect(source.trimStart().startsWith('"use server"')).toBe(true);
      const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
      expect(exported.length).toBeGreaterThanOrEqual(1);
      // Each function body must contain a managerAction( call. Split on exported function starts.
      const bodies = source.split(/export async function /).slice(1);
      for (const body of bodies) {
        expect(body, body.slice(0, 40)).toMatch(/managerAction\(/);
      }
      // Server Actions files may only export async functions (Next.js rule).
      expect(source).not.toMatch(/export (const|let|class)\b/);
    },
  );

  it("actions never use a privileged key or build their own client", () => {
    for (const file of [...actionFiles, "src/lib/auth/manager-action.ts"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/createClient|SERVICE_ROLE|serviceRole|env\/server/);
    }
  });

  it("the QR download route is manager-only", () => {
    expect(read("src/app/api/staff/tables/[id]/qr/route.ts")).toMatch(
      /await requireStaffApi\("manager"\)/,
    );
  });

  it("client components in the admin UI never import server-only modules", () => {
    for (const file of walk("src/components/admin").filter(isSource)) {
      const source = read(file);
      if (!source.trimStart().startsWith('"use client"')) continue;
      expect(source, file).not.toMatch(
        /lib\/auth\/session|lib\/supabase\/server|server-only|lib\/env\/server/,
      );
    }
  });

  it("server components never pass a render function to the form Field (it would crash at runtime)", () => {
    // `Field` takes a function as its child, which cannot cross the server/client boundary. Pages
    // and server-rendered forms must use TextField, TextAreaField, SelectField or CheckField.
    const files = [...walk("src/app/staff"), ...walk("src/components/admin")].filter(isSource);
    for (const file of files.filter((f) => !f.endsWith("action-form.tsx"))) {
      expect(read(file), file).not.toMatch(/<Field[\s>]/);
    }
  });

  it("QR codes can only be built from the table code (no ids, tokens or keys in the link)", () => {
    // Comments are allowed to say "no secrets"; only real code is checked.
    const qr = read("src/lib/tables/qr.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(qr).toMatch(/\?\$\{QR_PARAM\}=\$\{encodeURIComponent\(code\)\}/);
    expect(qr).not.toMatch(/token|secret|SERVICE|user_id|staff/i);
  });
});
