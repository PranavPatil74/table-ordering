import { NextResponse, type NextRequest } from "next/server";

import { STAFF_LOGIN } from "@/lib/auth/login";
import { hasSupabaseAuthCookie } from "@/lib/supabase/cookies";
import { refreshSession } from "@/lib/supabase/proxy-session";

/**
 * Staff session proxy (Next.js 16's replacement for middleware).
 *
 * Two jobs, and only these:
 *  1. Keep the Supabase session fresh (see refreshSession).
 *  2. Bounce visitors with no session away from staff PAGES, early and cheaply.
 *
 * It is NOT the security boundary. Proxy checks are optimistic; every staff page, Server Action
 * and API route re-checks on the server against the Auth server and `staff_profiles`
 * (src/lib/auth/session.ts). Never remove those checks because this file exists.
 */

function isStaffPage(pathname: string): boolean {
  const inArea = pathname === "/staff" || pathname.startsWith("/staff/");
  const isLogin = pathname === STAFF_LOGIN || pathname.startsWith(`${STAFF_LOGIN}/`);
  return inArea && !isLogin;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  const wanted = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = STAFF_LOGIN;
  url.search = "";
  if (wanted !== "/staff") url.searchParams.set("next", wanted);
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const page = isStaffPage(pathname);

  // No session cookie at all: nothing to refresh, and no reason to call the Auth server.
  if (!hasSupabaseAuthCookie(request.cookies.getAll())) {
    return page ? redirectToLogin(request) : NextResponse.next();
  }

  const session = await refreshSession(request);

  if (page && !session.signedIn && !session.unknown) {
    const redirect = redirectToLogin(request);
    // Carry over any cookie changes (for example the clearing of a dead session).
    for (const cookie of session.response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const [key, value] of session.response.headers) {
      if (key.toLowerCase() === "cache-control") redirect.headers.set(key, value);
    }
    return redirect;
  }

  // API routes answer 401/403 themselves; the login page handles its own redirects.
  return session.response;
}

export const config = {
  // Must be static strings: Next.js analyses this at build time.
  matcher: ["/staff/:path*", "/api/staff/:path*"],
};
