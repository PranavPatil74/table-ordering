import type { LoginFieldErrors } from "@/lib/auth/login";

/** What the sign-in Server Action hands back to the form. It never contains the password. */
export interface LoginState {
  status: "idle" | "error";
  message?: string;
  fieldErrors?: LoginFieldErrors;
  /** Echoed so the form can keep what was typed after a failed attempt. */
  email?: string;
}

export const initialLoginState: LoginState = { status: "idle" };
