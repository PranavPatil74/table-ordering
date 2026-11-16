/**
 * Pure sign-in helpers: form validation, error mapping and safe redirects. No network, no
 * framework imports, so they are unit tested and shared by the client form and the server action.
 */
import { z } from "zod";

export interface LoginFieldErrors {
  email?: string;
  password?: string;
}

export type LoginValidation =
  | { ok: true; data: { email: string; password: string } }
  | { ok: false; fieldErrors: LoginFieldErrors };

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * Validates the sign-in fields. The password is NOT length-checked here: the Auth server owns the
 * password policy, and an existing password must always be allowed through to be verified.
 */
export function validateLogin(input: { email: unknown; password: unknown }): LoginValidation {
  const fieldErrors: LoginFieldErrors = {};

  const rawEmail = typeof input.email === "string" ? input.email.trim() : "";
  const email = emailSchema.safeParse(rawEmail);
  if (rawEmail === "") fieldErrors.email = "Enter your email address.";
  else if (!email.success)
    fieldErrors.email = "Enter a valid email address, like name@example.com.";

  const password = typeof input.password === "string" ? input.password : "";
  if (password === "") fieldErrors.password = "Enter your password.";
  else if (password.length > 1024) fieldErrors.password = "That password is too long.";

  if (Object.keys(fieldErrors).length > 0 || !email.success) return { ok: false, fieldErrors };
  return { ok: true, data: { email: email.data, password } };
}

export type SignInFailure =
  "invalid_credentials" | "rate_limited" | "not_allowed" | "unavailable" | "unknown";

export interface SignInErrorShape {
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
}

/** Messages are deliberately generic: they never say whether an email address exists. */
export const SIGN_IN_MESSAGES: Record<SignInFailure, string> = {
  invalid_credentials: "That email and password don't match. Check them and try again.",
  rate_limited: "Too many sign-in attempts. Wait a few minutes, then try again.",
  not_allowed: "This account can't sign in right now. Ask a manager for help.",
  unavailable: "We couldn't reach the sign-in service. Check your connection and try again.",
  unknown: "Something went wrong while signing in. Try again.",
};

/** Maps a Supabase Auth error (by code and status, never by message text) to a failure kind. */
export function classifySignInError(error: SignInErrorShape): SignInFailure {
  const code = error.code ?? "";
  if (code === "invalid_credentials" || code === "invalid_login_credentials") {
    return "invalid_credentials";
  }
  if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    error.status === 429
  ) {
    return "rate_limited";
  }
  if (code === "email_not_confirmed" || code === "user_banned") return "not_allowed";
  if (
    error.name === "AuthRetryableFetchError" ||
    error.status === 0 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "unavailable";
  }
  // A bare 400 from the password grant is a credential problem.
  if (error.status === 400 && code === "") return "invalid_credentials";
  return "unknown";
}

export const STAFF_HOME = "/staff";
export const STAFF_LOGIN = "/staff/login";

/**
 * Only same-site paths inside the staff area may be used as a post-login destination, so a crafted
 * `?next=` can never bounce someone to another site (open redirect). Anything else becomes /staff.
 */
export function safeStaffPath(next: unknown): string {
  if (typeof next !== "string" || next === "") return STAFF_HOME;
  // Reject control characters, backslashes (browsers treat them as slashes) and non-paths.
  if (/[\u0000-\u001f\u007f\\]/.test(next) || !next.startsWith("/") || next.startsWith("//")) {
    return STAFF_HOME;
  }
  if (!URL.canParse(next, "http://placeholder.invalid")) return STAFF_HOME;
  const url = new URL(next, "http://placeholder.invalid");
  if (url.origin !== "http://placeholder.invalid") return STAFF_HOME;
  const { pathname } = url;
  const inStaffArea = pathname === STAFF_HOME || pathname.startsWith(`${STAFF_HOME}/`);
  const isLogin = pathname === STAFF_LOGIN || pathname.startsWith(`${STAFF_LOGIN}/`);
  if (!inStaffArea || isLogin) return STAFF_HOME;
  return `${pathname}${url.search}`;
}
