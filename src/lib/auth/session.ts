import "server-only";

import { cache } from "react";
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { STAFF_LOGIN } from "./login";
import {
  authorizeStaff,
  loadStaffAccess,
  type StaffAccess,
  type StaffMember,
  type StaffRole,
} from "./staff";

/**
 * Server-side staff guards: the real security boundary for Phase 2.
 *
 * Every protected page, Server Action and API route calls one of these. They validate the session
 * with the Auth server and read the caller's own `staff_profiles` row on every request. A cookie
 * is never trusted by itself, and a client-visible role (JWT metadata, form field, header) is never
 * consulted.
 *
 * Do not guard only in a layout: layouts are not re-rendered on every navigation, so each page and
 * each action must call a guard itself. The lookup is memoised per request, so repeating the call
 * costs nothing.
 */

/** One Auth + profile lookup per request, however many components ask. */
export const getStaffAccess = cache(async (): Promise<StaffAccess> => {
  const supabase = await createSupabaseServerClient();
  return loadStaffAccess(supabase);
});

/** Thrown when the Auth server or database cannot be reached. Renders the error boundary. */
export class StaffAuthUnavailableError extends Error {
  constructor() {
    super("Could not verify staff access right now.");
    this.name = "StaffAuthUnavailableError";
  }
}

/**
 * For pages. Returns the verified staff member, or redirects / renders not-found. Never returns
 * for anyone else.
 *  - not signed in, or signed in but not active staff: sent to the sign-in page, which explains.
 *  - active staff whose role is too low: 404, so role-restricted pages do not advertise themselves.
 */
export async function requireStaffPage(minimum: StaffRole = "counter"): Promise<StaffMember> {
  const decision = authorizeStaff(await getStaffAccess(), minimum);
  switch (decision.status) {
    case "authorized":
      return decision.staff;
    case "unavailable":
      throw new StaffAuthUnavailableError();
    case "denied":
      if (decision.reason === "insufficient_role") notFound();
      return redirect(STAFF_LOGIN);
    case "unauthenticated":
      return redirect(STAFF_LOGIN);
  }
}

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type ApiGuard = { ok: true; staff: StaffMember } | { ok: false; response: NextResponse };

/**
 * For Route Handlers and Server Actions that must return a status instead of redirecting:
 * 401 (no valid session), 403 (signed in but not active staff, or role too low), 503 (cannot verify).
 * Responses never say WHY a signed-in user is not staff.
 */
export async function requireStaffApi(minimum: StaffRole = "counter"): Promise<ApiGuard> {
  const decision = authorizeStaff(await getStaffAccess(), minimum);
  switch (decision.status) {
    case "authorized":
      return { ok: true, staff: decision.staff };
    case "unauthenticated":
      return {
        ok: false,
        response: NextResponse.json(
          { error: "unauthenticated" },
          { status: 401, headers: NO_STORE },
        ),
      };
    case "denied":
      return {
        ok: false,
        response: NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE }),
      };
    case "unavailable":
      return {
        ok: false,
        response: NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE }),
      };
  }
}

export type ActionGuard =
  { ok: true; staff: StaffMember; supabase: SupabaseClient } | { ok: false; message: string };

/**
 * For Server Actions. Server Actions are public HTTP endpoints: anyone can POST to one with any
 * arguments, so every action re-verifies the caller here and never relies on the page that
 * rendered the button. On success it also hands back the caller's own Supabase client, so the
 * database applies the same row-level security as for any other request from that person.
 */
export async function requireStaffAction(minimum: StaffRole = "counter"): Promise<ActionGuard> {
  const supabase = await createSupabaseServerClient();
  const decision = authorizeStaff(await loadStaffAccess(supabase), minimum);
  switch (decision.status) {
    case "authorized":
      return { ok: true, staff: decision.staff, supabase };
    case "unauthenticated":
      return { ok: false, message: "Your session has expired. Sign in again to continue." };
    case "denied":
      return { ok: false, message: "You don't have permission to do that." };
    case "unavailable":
      return {
        ok: false,
        message: "We couldn't verify your access. Nothing was changed. Try again.",
      };
  }
}
