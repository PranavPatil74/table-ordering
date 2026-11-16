import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static guards for Phase 4. They read source text, so they cannot prove runtime behaviour, but
 * they stop the easy regressions: the privileged key leaking out of its few reviewed modules, a
 * customer page that writes to the database or starts a payment, and a client component importing
 * server code.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const exists = (file: string) => {
  try {
    return statSync(path.join(root, file)).isFile();
  } catch {
    return false;
  }
};
function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((name) => {
    const rel = path.join(dir, name);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}
const isSource = (file: string) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file);
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const sourceFiles = walk("src").filter(isSource);

/** The complete list of modules allowed to touch the service-role key or client. */
const PRIVILEGED_ALLOWED = new Set([
  "src/lib/privileged/service-client.ts",
  "src/lib/privileged/rate-limit.ts",
  "src/lib/privileged/staff-emails.ts",
  "src/lib/privileged/checkout-attempts.ts",
  "src/lib/customer/table-resolver.ts",
  "src/lib/env/schema.ts",
  "src/lib/env/server.ts",
  "src/supabase-it/helpers.ts",
]);

describe("the service-role key stays in a short, reviewed list of modules", () => {
  it("is referenced only from the allow-list", () => {
    const offenders = sourceFiles.filter((file) => {
      const source = stripComments(read(file));
      return (
        /SERVICE_ROLE|supabaseServiceRoleKey|createServiceRoleClient/.test(source) &&
        !PRIVILEGED_ALLOWED.has(file.split(path.sep).join("/"))
      );
    });
    expect(offenders).toEqual([]);
  });

  it("privileged modules are server-only", () => {
    for (const file of walk("src/lib/privileged").filter(isSource)) {
      expect(read(file), file).toMatch(/^import "server-only";/m);
    }
  });

  it("no client component imports a privileged or server-only module", () => {
    const clientFiles = sourceFiles.filter((file) =>
      read(file).trimStart().startsWith('"use client"'),
    );
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const file of clientFiles) {
      expect(read(file), file).not.toMatch(
        /lib\/privileged|lib\/env\/server|lib\/customer\/(table-resolver|menu-loader|preview|checkout|page-data)["']|lib\/supabase\/(server|public)|server-only/,
      );
    }
  });
});

describe("the customer area (/menu, /cart, /checkout)", () => {
  const customerFiles = [
    ...walk("src/lib/customer"),
    ...walk("src/components/customer"),
    ...walk("src/app/menu"),
    ...walk("src/app/cart"),
    ...walk("src/app/checkout"),
  ].filter(isSource);

  it("has files to check", () => {
    expect(customerFiles.length).toBeGreaterThan(15);
  });

  it("never writes to the database or touches orders and payments directly (saving goes through the one privileged module)", () => {
    for (const file of customerFiles) {
      const source = stripComments(read(file));
      // No Supabase writes (the cart's Map.delete and the hash's .update are not database calls).
      expect(source, file).not.toMatch(/\.from\([^)]*\)\s*\.(insert|update|upsert|delete)\(/);
      expect(source, file).not.toMatch(/\.(insert|upsert)\(/);
      for (const call of source.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)) {
        expect(call[1], file).toBe("check_rate_limit");
      }
      expect(source, file).not.toMatch(
        /payment_attempts|finalize_paid_order|gateway_events|["']orders["']/,
      );
      expect(source, file).not.toMatch(/razorpay/i);
    }
  });

  it("the privileged checkout module only calls the two checkout functions, never orders or the finaliser", () => {
    const source = stripComments(read("src/lib/privileged/checkout-attempts.ts"));
    expect(source).toMatch(/^import "server-only";/m);
    const calls = [...source.matchAll(/\.rpc\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(["create_checkout_attempt", "get_checkout_attempt"]);
    expect(source).not.toMatch(/finalize_paid_order|gateway_events|["']orders["']|razorpay/i);
    expect(source).not.toMatch(/\.from\(|\.(insert|update|upsert|delete)\(/);
    // Only the token HASH is sent to the database.
    expect(source).toMatch(/hashTrackingToken/);
  });

  it("only the privileged module and the customer checkout module may call the checkout functions", () => {
    const allowed = new Set(["src/lib/privileged/checkout-attempts.ts"]);
    const offenders = sourceFiles.filter((file) => {
      const f = file.split(path.sep).join("/");
      return (
        /create_checkout_attempt|get_checkout_attempt/.test(stripComments(read(file))) &&
        !allowed.has(f) &&
        !f.includes(".test.") &&
        !f.startsWith("src/supabase-it/") &&
        !f.startsWith("src/db/") &&
        !f.startsWith("src/test/")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("does not use staff authentication or the cookie-bound client", () => {
    for (const file of customerFiles) {
      const source = stripComments(read(file));
      expect(source, file).not.toMatch(/lib\/auth|createSupabaseServerClient|staff_profiles/);
    }
  });

  it("the menu is read with the anonymous, cookie-less client only", () => {
    const loader = stripComments(read("src/lib/customer/menu-loader.ts"));
    expect(loader).toMatch(/createPublicSupabaseClient/);
    expect(loader).not.toMatch(/createServiceRoleClient|SERVICE_ROLE/);
    const publicClient = stripComments(read("src/lib/supabase/public.ts"));
    expect(publicClient).toContain("supabasePublishableKey");
    expect(publicClient).not.toMatch(/cookies|SERVICE_ROLE|serviceRole/);
  });

  it("the checkout action is a 'use server' file exporting only async functions", () => {
    const source = read("src/app/checkout/actions.ts");
    expect(source.trimStart().startsWith('"use server"')).toBe(true);
    expect(source).not.toMatch(/export (const|let|class|type|interface)\b/);
    expect(source).toMatch(/export async function previewOrderAction/);
    expect(source).toMatch(/export async function saveCheckoutAction/);
    expect(source).toMatch(/export async function loadSavedCheckoutAction/);
  });

  it("the cart never persists prices or names", () => {
    const provider = stripComments(read("src/components/customer/cart-provider.tsx"));
    expect(provider).not.toMatch(/pricePaise|price_paise|totalPaise|\.name\b/);
  });

  it("table lookups are rate limited", () => {
    expect(read("src/lib/customer/table-resolver.ts")).toMatch(/hitRateLimit\(/);
    expect(read("src/lib/customer/preview.ts")).toMatch(/hitRateLimit\(/);
  });

  it("the server never takes a price, total or table id from the request", () => {
    const schema = stripComments(read("src/lib/customer/preview.ts"));
    const input = /previewInputSchema = z\.object\(\{[\s\S]*?\n\}\);/.exec(schema)?.[0] ?? "";
    expect(input).toBeTruthy();
    expect(input).not.toMatch(/price|total|paise|tableId|table_id|status/i);
  });
});

describe("the staff management screen", () => {
  it("exists and is manager-guarded", () => {
    const page = "src/app/staff/(protected)/manager/staff/page.tsx";
    expect(exists(page)).toBe(true);
    expect(read(page)).toMatch(/await requireStaffPage\("manager"\)/);
  });

  it("e-mail lookup re-checks the caller's role before using the privileged key", () => {
    const source = read("src/lib/privileged/staff-emails.ts");
    expect(source).toMatch(/meetsRole\(caller\.role, "manager"\)/);
    expect(source).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(source).not.toMatch(
      /listUsers|updateUserById|deleteUser|createUser|generateLink|inviteUserByEmail/,
    );
  });

  it("the staff repository can only change is_active (no create, delete or role change)", () => {
    const source = stripComments(read("src/lib/staff/repository.ts"));
    expect(source).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(source.match(/\.update\(/g)).toHaveLength(1);
    expect(source).toMatch(/\.update\(\{ is_active: active \}\)/);
  });

  it("the Staff link is in the manager navigation", () => {
    expect(read("src/components/admin/manager-nav.tsx")).toContain('"/staff/manager/staff"');
  });
});
