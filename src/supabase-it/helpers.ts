/**
 * Pure helpers for the Supabase integration tests (no network, no database), so they can be unit
 * tested in the default `pnpm test` run even where the Supabase stack cannot start.
 */

import { randomBytes } from "node:crypto";

/**
 * A throwaway password for a TEST user that always satisfies the local Auth policy
 * (supabase/config.toml: `minimum_password_length = 12`, `password_requirements =
 * "lower_upper_letters_digits"`). A purely random base64url string only USUALLY contains a
 * lowercase letter, an uppercase letter and a digit (about 2-3% of them miss one), which made
 * user creation fail at random. The guaranteed suffix removes that; the random part keeps it
 * unguessable (144 bits). Never reuse it outside tests and never log it.
 */
export function generateTestPassword(): string {
  return `${randomBytes(18).toString("base64url")}aA1`;
}

export interface SupabaseTestEnv {
  /** API gateway URL of the LOCAL stack, e.g. http://127.0.0.1:54321 */
  url: string;
  /** Anonymous / publishable key of the local stack. Public by design. */
  anonKey: string;
  /** Service-role / secret key of the local stack. Never log it. */
  serviceKey: string;
  /** Direct Postgres URL of the local stack. Optional; enables catalog checks. */
  dbUrl: string | undefined;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/** True only for loopback hosts. The suite refuses to run against anything else. */
export function isLocalUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  return LOCAL_HOSTS.has(new URL(raw).hostname);
}

export class SupabaseEnvError extends Error {}

/**
 * Reads the test environment. Error messages name variables only, never values.
 * The suite deliberately refuses non-local URLs: it creates users and data, and must never be
 * pointed at a hosted or production project.
 */
export function readSupabaseEnv(source: Record<string, string | undefined>): SupabaseTestEnv {
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (name) => !source[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new SupabaseEnvError(`Missing environment variables: ${missing.join(", ")}`);
  }
  const url = source.SUPABASE_URL!.trim().replace(/\/+$/, "");
  if (!isLocalUrl(url)) {
    throw new SupabaseEnvError(
      "SUPABASE_URL is not a loopback address. These tests create users and data and only run " +
        "against a local Supabase stack (supabase start). Refusing to continue.",
    );
  }
  const dbUrl = source.SUPABASE_DB_URL?.trim() || undefined;
  if (dbUrl && URL.canParse(dbUrl) && !isLocalUrl(dbUrl)) {
    throw new SupabaseEnvError("SUPABASE_DB_URL is not a loopback address. Refusing to continue.");
  }
  return {
    url,
    anonKey: source.SUPABASE_ANON_KEY!.trim(),
    serviceKey: source.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    dbUrl,
  };
}

/** Decodes the payload of a JWT without verifying it. Returns null if it is not JWT-shaped. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** PostgREST accepts bytea as a `\x`-prefixed hex string in JSON. */
export function toByteaHex(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString("hex")}`;
}

export interface ApiResultLike {
  error: { code?: string; message?: string } | null;
  status?: number;
}

/**
 * Error codes that mean "the database or API refused this role":
 *  - 42501  insufficient_privilege (missing GRANT, RLS WITH CHECK failure, or a guard trigger)
 *  - PGRST205 / PGRST202  the table or function is not visible to the role in the schema cache
 * Everything else (a bad key, an expired token, a constraint failure, a 5xx) is NOT a denial, so a
 * misconfigured test run cannot pass a "must be denied" test by accident.
 */
const DENIED_CODES = new Set(["42501", "PGRST205", "PGRST202"]);
const CREDENTIAL_PROBLEM = /invalid api key|invalid jwt|jwt expired|no api key|unauthorized/i;

export function isPermissionDenied(result: ApiResultLike): boolean {
  const { error } = result;
  if (!error) return false;
  if (CREDENTIAL_PROBLEM.test(error.message ?? "")) return false;
  return DENIED_CODES.has(error.code ?? "");
}

/** Short, secret-free description of an API result for assertion messages. */
export function describeResult(result: ApiResultLike): string {
  if (!result.error) return `ok (HTTP ${result.status ?? "?"})`;
  return `error ${result.error.code ?? "?"} (HTTP ${result.status ?? "?"}): ${(result.error.message ?? "").slice(0, 160)}`;
}

/**
 * Test rows that cannot be deleted by design (an ordered menu item, a table with orders, a category
 * that still holds such items) are ARCHIVED instead, so a run never leaves visible "IT <tag> ..."
 * entries in the manager dashboard or on the customer menu. Only tables listed here, and only the
 * rows this run created (ids tracked by the harness), are ever archived. Returns the boolean column
 * to switch off, or undefined when the table has no archive concept.
 */
export function archiveColumnFor(table: string): "is_active" | undefined {
  return ["menu_items", "menu_categories", "cafe_tables", "modifier_groups"].includes(table)
    ? "is_active"
    : undefined;
}
