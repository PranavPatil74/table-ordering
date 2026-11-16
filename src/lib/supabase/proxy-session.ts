import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { getPublicEnv } from "@/lib/env/public";

import { authCookieOptions } from "./cookies";

export interface RefreshedSession {
  /** Pass this (or copy its cookies onto a redirect) so refreshed tokens reach the browser. */
  response: NextResponse;
  /** True when a valid session exists after refreshing. */
  signedIn: boolean;
  /** True when Auth could not be reached, so the answer is unknown (not "signed out"). */
  unknown: boolean;
}

/**
 * Refreshes the Supabase session for this request (proxy.ts only).
 *
 * Server Components cannot write cookies, so an expired access token must be refreshed HERE,
 * before rendering, and the new tokens written both to the request (so the page sees them) and to
 * the response (so the browser keeps them). Refresh tokens rotate: refreshing twice with the same
 * token would sign the user out, which is why exactly one place does it.
 *
 * `getClaims()` validates the session and refreshes when needed. It is only an optimistic check:
 * the real authorisation decision is made later, per page, action and API route, by asking the
 * Auth server (`getUser`) and reading the staff profile.
 */
export async function refreshSession(request: NextRequest): Promise<RefreshedSession> {
  const env = getPublicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookieOptions: authCookieOptions(env.appUrl),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Responses that set auth cookies must never be cached by a CDN or shared proxy.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const unknown = Boolean(error && isAuthRetryableFetchError(error));
  return { response, signedIn: Boolean(data?.claims?.sub) && !error, unknown };
}
