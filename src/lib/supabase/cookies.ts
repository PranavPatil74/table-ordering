/**
 * Cookie rules for the Supabase session. Pure, so they can be unit tested.
 *
 * The session lives ONLY in cookies set by the server. They are HttpOnly because Phase 2 has no
 * browser-side Supabase client: page scripts never need the tokens, so an XSS bug cannot read
 * them. (Phase 7 will need to hand Realtime a token another way; revisit then, do not just flip
 * this flag.)
 */
export interface AuthCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
}

/** `Secure` whenever the app's public origin is https (always, in production). */
export function authCookieOptions(appUrl: string): AuthCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: URL.canParse(appUrl) && new URL(appUrl).protocol === "https:",
    path: "/",
  };
}

/** Supabase names its cookies `sb-<project>-auth-token` (plus `.0`, `.1` chunks and a verifier). */
export function isSupabaseAuthCookie(name: string): boolean {
  return /^sb-.+-auth-token(\.\d+)?$/.test(name) || /^sb-.+-auth-token-code-verifier$/.test(name);
}

export function hasSupabaseAuthCookie(cookies: readonly { name: string }[]): boolean {
  return cookies.some((cookie) => isSupabaseAuthCookie(cookie.name));
}
