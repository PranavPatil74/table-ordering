import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env/server";

/**
 * The ONLY place the service-role key becomes a client. The key bypasses row-level security, so
 * this module is deliberately tiny, server-only (the import above makes a client-bundle import a
 * build error), and used by a short list of reviewed callers (see src/test/privileged-static.test.ts):
 *
 *   - customer table lookup        (cafe_tables is not readable by the anonymous role)
 *   - rate limiting                (check_rate_limit is service_role only)
 *   - the manager's staff directory (e-mail addresses live in auth.users)
 *
 * Callers must do their own authorisation BEFORE calling this; the key authorises everything.
 */
export function createServiceRoleClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}
