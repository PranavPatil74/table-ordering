"use server";

import { redirect } from "next/navigation";

import {
  classifySignInError,
  safeStaffPath,
  SIGN_IN_MESSAGES,
  validateLogin,
} from "@/lib/auth/login";
import { loadStaffAccess } from "@/lib/auth/staff";
import { clearAuthCookies, createSupabaseServerClient } from "@/lib/supabase/server";

import type { LoginState } from "./state";

/**
 * Email + password sign-in. Runs only on the server; the password is never logged, never stored
 * and never returned to the browser.
 *
 * Signing in as a Supabase user is not enough: the account must also be ACTIVE STAFF in
 * `staff_profiles`. Anyone else is signed straight back out, so no session for a non-staff
 * account survives this action.
 */
export async function signInAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const checked = validateLogin({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!checked.ok) {
    const email = formData.get("email");
    return {
      status: "error",
      fieldErrors: checked.fieldErrors,
      ...(typeof email === "string" ? { email: email.trim() } : {}),
    };
  }
  const { email, password } = checked.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const failure = classifySignInError(error);
    // Log the failure KIND only: never the email, the password or the raw error object.
    if (failure === "unknown" || failure === "unavailable") {
      console.error(`[staff sign-in] ${failure} (status ${error.status ?? "n/a"})`);
    }
    return { status: "error", message: SIGN_IN_MESSAGES[failure], email };
  }

  const access = await loadStaffAccess(supabase);
  if (access.status !== "authorized") {
    await supabase.auth.signOut({ scope: "local" });
    await clearAuthCookies();
    if (access.status === "unavailable") {
      return { status: "error", message: SIGN_IN_MESSAGES.unavailable, email };
    }
    return {
      status: "error",
      message: "This account doesn't have staff access. Ask a manager to set you up.",
      email,
    };
  }

  const next = formData.get("next");
  redirect(safeStaffPath(typeof next === "string" ? next : undefined));
}
