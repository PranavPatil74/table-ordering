"use server";

import { redirect } from "next/navigation";

import { STAFF_LOGIN } from "@/lib/auth/login";
import { clearAuthCookies, createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Ends THIS browser's session only (`scope: "local"`), so signing out of the counter tablet does
 * not sign the same person out of their phone. Anyone may call it: it can only ever clear the
 * caller's own cookies. Cookies are also removed directly in case the Auth server is unreachable.
 */
export async function signOutAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The Auth server may be unreachable. The browser's session is removed below regardless.
  }
  await clearAuthCookies();
  redirect(`${STAFF_LOGIN}?signed-out=1`);
}
