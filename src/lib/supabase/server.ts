import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getPublicEnv } from "@/lib/env/public";

import { authCookieOptions, isSupabaseAuthCookie } from "./cookies";

/**
 * A Supabase client bound to the CURRENT request's cookies, acting as the signed-in user (or as
 * anonymous). It uses the publishable key only: every query it makes is subject to Phase 1's
 * row-level security. The service-role key is deliberately not reachable from here.
 *
 * Create one per request; never cache or share it between requests.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  // Reading cookies FIRST opts the page into per-request rendering. Configuration is validated
  // after that, so `next build` (which has no secrets) never tries to prerender a staff page.
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookieOptions: authCookieOptions(env.appUrl),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. That is fine: proxy.ts refreshes the session
          // before rendering, and Server Actions / Route Handlers (which can write) do their own.
        }
      },
    },
  });
}

/** Removes every Supabase auth cookie, even if the Auth server could not be reached to sign out. */
export async function clearAuthCookies(): Promise<void> {
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (isSupabaseAuthCookie(name)) cookieStore.delete(name);
  }
}
