import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static checks over the migration SQL. They need no database, so they run in the default
 * `pnpm test` and in CI on every change. They are a safety net for review, NOT a substitute for
 * the integration tests in `*.db.test.ts`, which run the migrations on a real PostgreSQL.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sources = files.map((name) => ({
  name,
  sql: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
}));
const allSql = sources.map((s) => s.sql).join("\n");

/** Removes `-- line comments` so commented-out SQL can neither satisfy nor fail a check. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const code = stripComments(allSql);

describe("migration files", () => {
  it("exist and follow the <14-digit timestamp>_<snake_case>.sql convention", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) expect(file, file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("have unique, strictly increasing versions", () => {
    const versions = files.map((f) => f.slice(0, 14));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort());
  });

  it("contain no hard-coded secrets or credentials", () => {
    expect(code).not.toMatch(/rzp_(test|live)_[A-Za-z0-9]+/);
    expect(code).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // a JWT, e.g. a pasted service-role key
    expect(code).not.toMatch(/\bpassword\s*=\s*'[^']+'/i);
    expect(code).not.toMatch(/insert\s+into\s+auth\./i); // staff accounts come from Supabase Auth, not SQL
  });
});

describe("tables", () => {
  const created = [
    ...code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)/gi),
  ].map((m) => m[1]!);

  it("are found", () => {
    expect(created.length).toBe(15);
  });

  it.each(created)("public.%s has row level security enabled", (table) => {
    expect(code).toMatch(
      new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"),
    );
  });

  it("never disable row level security or use FORCE-less bypass hacks", () => {
    expect(code).not.toMatch(/disable\s+row\s+level\s+security/i);
  });

  it("never grant privileges on any public table to anon or PUBLIC", () => {
    // Column-limited SELECT for anon is allowed; anything else is not.
    for (const match of code.matchAll(
      /grant\s+([^;]+?)\s+on\s+(?:table\s+)?public\.[a-z_]+[^;]*?\s+to\s+([^;]+);/gi,
    )) {
      const [, privileges, grantees] = match;
      if (/\b(anon|public)\b/i.test(grantees!)) {
        expect(privileges, match[0]).toMatch(/^\s*select\s*\(/i);
      }
    }
  });

  it("revokes default and existing API-role privileges before granting anything", () => {
    expect(code).toMatch(
      /alter\s+default\s+privileges[^;]*revoke\s+all\s+on\s+tables\s+from\s+anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+public\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+all\s+functions\s+in\s+schema\s+private\s+from\s+public,\s*anon,\s*authenticated/i,
    );
  });
});

describe("money", () => {
  it("uses no floating point, numeric, decimal or money column types", () => {
    const tableBodies = [...code.matchAll(/create\s+table\s[^;]*?\(([\s\S]*?)\n\);/gi)].map(
      (m) => m[1]!,
    );
    expect(tableBodies.length).toBeGreaterThan(10);
    for (const body of tableBodies) {
      expect(body).not.toMatch(/\b(real|double\s+precision|numeric|decimal|money|float\d?)\b/i);
    }
  });

  it("names every price or amount column *_paise and types it integer", () => {
    const columns = [...code.matchAll(/^\s+([a-z_]*paise[a-z_]*)\s+([a-z]+)/gim)];
    expect(columns.length).toBeGreaterThanOrEqual(7);
    for (const [, name, type] of columns) expect(type, name).toBe("integer");
    expect(code).not.toMatch(/^\s+(price|amount|total|cost)\s+(integer|int|bigint|smallint)\b/im);
  });
});

describe("functions", () => {
  const functions = [
    ...code.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\bas\s+\$\$/gi,
    ),
  ].map((m) => ({ name: m[1]!, header: m[0] }));
  const definers = functions.filter((f) => /security\s+definer/i.test(f.header));

  it("are found", () => {
    expect(functions.length).toBeGreaterThanOrEqual(15);
    expect(definers.length).toBeGreaterThanOrEqual(8);
  });

  it("are always schema-qualified (no function lands on an unpredictable search_path)", () => {
    expect([
      ...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?![a-z_]+\.)/gi),
    ]).toHaveLength(0);
  });

  it.each(functions.map((f) => f.name))("%s pins an empty search_path", (name) => {
    const fn = functions.find((f) => f.name === name)!;
    expect(fn.header).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it("only exposes public-schema functions to service_role", () => {
    const publicFunctions = functions.filter((f) => f.name.startsWith("public."));
    expect(publicFunctions.map((f) => f.name).sort()).toEqual([
      "public.check_rate_limit",
      "public.create_checkout_attempt",
      "public.finalize_paid_order",
      "public.get_checkout_attempt",
      "public.purge_expired_rate_limits",
    ]);
    for (const fn of publicFunctions) {
      const grant = new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+${fn.name.replace(".", "\\.")}\\s*\\([^)]*\\)\\s+to\\s+service_role\\s*;`,
        "i",
      );
      expect(code, fn.name).toMatch(grant);
    }
    expect(code).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i,
    );
  });

  it("never grant execute on a SECURITY DEFINER function to anon", () => {
    for (const definer of definers) {
      const re = new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+${definer.name.replace(".", "\\.")}[^;]*\\bto\\s+[^;]*\\banon\\b`,
        "i",
      );
      expect(code, definer.name).not.toMatch(re);
    }
  });

  it("keep the payment finaliser transactional: it locks the attempt row", () => {
    expect(code).toMatch(/from\s+public\.payment_attempts[\s\S]*?for\s+update/i);
  });
});

describe("immutability and integrity are declared in the schema", () => {
  it("rejects updates and deletes on historical order data", () => {
    for (const table of ["order_items", "order_events"]) {
      expect(code, table).toMatch(
        new RegExp(
          `before\\s+update\\s+or\\s+delete\\s+on\\s+public\\.${table}[\\s\\S]*?reject_mutation`,
          "i",
        ),
      );
    }
    expect(code).toMatch(
      /before\s+delete\s+on\s+public\.orders[\s\S]*?(reject_mutation|orders_no_delete)/i,
    );
  });

  it("enforces unique order numbers per business date and unique payment associations", () => {
    expect(code).toMatch(/unique\s*\(\s*business_date\s*,\s*order_number\s*\)/i);
    expect(code).toMatch(/unique\s*\(\s*business_date\s*,\s*daily_seq\s*\)/i);
    expect(code).toMatch(/unique\s*\(\s*payment_attempt_id\s*\)|payment_attempt_id[^,\n]*unique/i);
    expect(code).toMatch(/unique\s*\(\s*gateway\s*,\s*event_id\s*\)/i);
  });

  it("stores tracking tokens only as 32-byte hashes", () => {
    expect(code).toMatch(/tracking_token_hash\s+bytea/i);
    expect(code).toMatch(/octet_length\(\s*tracking_token_hash\s*\)\s*=\s*32/i);
    expect(code).not.toMatch(/\btracking_token\s+(text|varchar|uuid|bytea)\b/i);
  });
});
