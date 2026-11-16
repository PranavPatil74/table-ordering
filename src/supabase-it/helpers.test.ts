import { describe, expect, it } from "vitest";

import {
  SupabaseEnvError,
  archiveColumnFor,
  decodeJwtPayload,
  describeResult,
  generateTestPassword,
  isLocalUrl,
  isPermissionDenied,
  readSupabaseEnv,
  toByteaHex,
} from "./helpers";

const base = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "anon-key-value",
  SUPABASE_SERVICE_ROLE_KEY: "service-key-value",
};

describe("isLocalUrl", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://[::1]:54321",
    "http://host.docker.internal:54321",
  ])("accepts %s", (url) => expect(isLocalUrl(url)).toBe(true));

  it.each([
    "https://abcdefgh.supabase.co",
    "https://example.com",
    "http://127.0.0.1.evil.example:54321", // host merely starting with a loopback address
    "http://localhost.example.com",
    "not a url",
    "",
  ])("rejects %j", (url) => expect(isLocalUrl(url)).toBe(false));
});

describe("readSupabaseEnv", () => {
  it("reads a complete local environment and trims a trailing slash", () => {
    expect(readSupabaseEnv({ ...base, SUPABASE_URL: "http://localhost:54321/" })).toEqual({
      url: "http://localhost:54321",
      anonKey: "anon-key-value",
      serviceKey: "service-key-value",
      dbUrl: undefined,
    });
  });

  it("passes through a local database URL", () => {
    const env = readSupabaseEnv({
      ...base,
      SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    expect(env.dbUrl).toContain("127.0.0.1:54322");
  });

  it("names every missing variable but never prints values", () => {
    const error = (() => {
      try {
        readSupabaseEnv({ SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: " " });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(SupabaseEnvError);
    expect(error!.message).toContain("SUPABASE_ANON_KEY");
    expect(error!.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(error!.message).not.toContain("SUPABASE_URL,");
  });

  it("refuses a hosted project URL, so it can never be pointed at production", () => {
    const error = (() => {
      try {
        readSupabaseEnv({ ...base, SUPABASE_URL: "https://abcdefgh.supabase.co" });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(SupabaseEnvError);
    expect(error!.message).toMatch(/loopback/);
    expect(error!.message).not.toContain("abcdefgh");
  });

  it("refuses a non-local database URL", () => {
    expect(() =>
      readSupabaseEnv({
        ...base,
        SUPABASE_DB_URL: "postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres",
      }),
    ).toThrow(/loopback/);
  });
});

describe("decodeJwtPayload", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it("decodes the claims of a JWT-shaped token", () => {
    const token = `${encode({ alg: "HS256" })}.${encode({ sub: "user-1", role: "authenticated" })}.signature`;
    expect(decodeJwtPayload(token)).toEqual({ sub: "user-1", role: "authenticated" });
  });

  it.each([
    "",
    "sb_publishable_abc",
    "a.b",
    "a..c",
    `${"x"}.${"!!!"}.${"y"}`,
    `h.${Buffer.from("[1]").toString("base64url")}.s`,
  ])("returns null for %j", (token) => expect(decodeJwtPayload(token)).toBeNull());
});

describe("toByteaHex", () => {
  it("formats bytes the way PostgREST expects", () => {
    expect(toByteaHex(Buffer.from([0x00, 0xab, 0xff]))).toBe("\\x00abff");
    expect(toByteaHex(new Uint8Array(32))).toHaveLength(2 + 64);
  });
});

describe("isPermissionDenied", () => {
  it("accepts genuine privilege and visibility denials", () => {
    for (const code of ["42501", "PGRST205", "PGRST202"]) {
      expect(
        isPermissionDenied({
          error: { code, message: "permission denied for table orders" },
          status: 403,
        }),
      ).toBe(true);
    }
  });

  it("does not treat success as a denial", () => {
    expect(isPermissionDenied({ error: null, status: 200 })).toBe(false);
  });

  it("does not let a bad key or token masquerade as a denial", () => {
    expect(
      isPermissionDenied({ error: { code: "42501", message: "Invalid API key" }, status: 401 }),
    ).toBe(false);
    expect(
      isPermissionDenied({ error: { code: "PGRST301", message: "JWT expired" }, status: 401 }),
    ).toBe(false);
    expect(
      isPermissionDenied({ error: { code: "PGRST301", message: "No suitable key" }, status: 401 }),
    ).toBe(false);
  });

  it("does not treat constraint failures or server errors as denials", () => {
    expect(
      isPermissionDenied({ error: { code: "23514", message: "check violation" }, status: 400 }),
    ).toBe(false);
    expect(isPermissionDenied({ error: { code: "XX000", message: "boom" }, status: 500 })).toBe(
      false,
    );
    expect(isPermissionDenied({ error: { message: "no code" }, status: 401 })).toBe(false);
  });
});

describe("describeResult", () => {
  it("summarises without leaking anything but code, status and a truncated message", () => {
    expect(describeResult({ error: null, status: 200 })).toBe("ok (HTTP 200)");
    const text = describeResult({
      error: { code: "42501", message: "x".repeat(500) },
      status: 403,
    });
    expect(text.startsWith("error 42501 (HTTP 403): ")).toBe(true);
    expect(text.length).toBeLessThan(220);
  });
});

describe("generateTestPassword", () => {
  it("always satisfies the local Auth password policy (12+ chars, lower, upper, digit)", () => {
    for (let i = 0; i < 5000; i += 1) {
      const password = generateTestPassword();
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
    }
  });
  it("is random per call and uses only URL-safe characters", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTestPassword()));
    expect(seen.size).toBe(200);
    for (const password of seen) expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("matches the policy declared in supabase/config.toml", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync("supabase/config.toml", "utf8");
    expect(config).toMatch(/minimum_password_length\s*=\s*12/);
    expect(config).toMatch(/password_requirements\s*=\s*"lower_upper_letters_digits"/);
  });
});

describe("archiveColumnFor", () => {
  it("archives only menu/table data that cannot be deleted, never history or auth data", () => {
    for (const table of ["menu_items", "menu_categories", "cafe_tables", "modifier_groups"]) {
      expect(archiveColumnFor(table)).toBe("is_active");
    }
    for (const table of [
      "orders",
      "order_items",
      "payment_attempts",
      "order_events",
      "staff_profiles",
      "cafe_settings",
      "menu_item_modifier_groups",
    ]) {
      expect(archiveColumnFor(table), table).toBeUndefined();
    }
  });
});
