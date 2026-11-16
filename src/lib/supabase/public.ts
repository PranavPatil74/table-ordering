import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getPublicEnv } from "@/lib/env/public";

/**
 * A cookie-less client acting as the ANONYMOUS role, for the public menu. It uses the publishable
 * key only and never reads or writes a session, so a customer's page can never act as, or leak,
 * a signed-in staff member. Row-level security (active rows only) and column grants decide what
 * it can read. Create one per request.
 */
export function createPublicSupabaseClient(): SupabaseClient {
  const env = getPublicEnv();
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}
