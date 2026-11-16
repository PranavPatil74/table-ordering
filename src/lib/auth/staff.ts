/**
 * Staff identity and authorisation (Phase 2).
 *
 * The ONLY source of a staff member's role is their `public.staff_profiles` row, read through
 * their own session so that Phase 1's row-level security applies. Nothing here trusts the
 * browser, the user-editable metadata on the Auth user, or any client-supplied value: a signed-in Supabase user
 * with no active profile is a customer-grade nobody, not staff.
 *
 * This module has no `server-only` import so the real-Supabase integration tests can run the exact
 * same query and decision logic that the app uses. The server-only wrappers live in
 * `./session.ts`.
 */
import { isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const STAFF_ROLES = ["counter", "manager"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** A manager can do everything a counter can (mirrors the Phase 1 policies). */
const ROLE_RANK: Record<StaffRole, number> = { counter: 1, manager: 2 };

export function meetsRole(role: StaffRole, minimum: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export interface StaffMember {
  userId: string;
  displayName: string;
  role: StaffRole;
}

export type DenialReason = "no_profile" | "inactive" | "invalid_role" | "insufficient_role";

export type StaffAccess =
  | { status: "authorized"; staff: StaffMember }
  /** No valid session (never signed in, expired, revoked, or the user was deleted). */
  | { status: "unauthenticated" }
  /** Signed in, but not active staff. */
  | { status: "denied"; reason: Exclude<DenialReason, "insufficient_role"> }
  /** We could not find out (Auth or database unreachable). Callers must fail closed. */
  | { status: "unavailable" };

const profileRowSchema = z.object({
  user_id: z.uuid(),
  display_name: z.string().min(1),
  role: z.string(),
  is_active: z.boolean(),
});

export type ProfileLookup = { ok: true; row: unknown } | { ok: false };

/**
 * Pure decision: what may this signed-in user do? `row` is whatever the database returned for the
 * caller's own profile (or null when there is none).
 */
export function resolveStaffAccess(input: {
  userId: string | null;
  profile: ProfileLookup;
}): StaffAccess {
  if (!input.userId) return { status: "unauthenticated" };
  if (!input.profile.ok) return { status: "unavailable" };
  if (input.profile.row === null || input.profile.row === undefined) {
    return { status: "denied", reason: "no_profile" };
  }

  const parsed = profileRowSchema.safeParse(input.profile.row);
  if (!parsed.success) return { status: "denied", reason: "invalid_role" };
  const row = parsed.data;

  // Defence in depth: the row must belong to the user we authenticated, even if a query
  // somehow returned someone else's (managers can read every profile under RLS).
  if (row.user_id !== input.userId) return { status: "denied", reason: "no_profile" };

  const role = STAFF_ROLES.find((candidate) => candidate === row.role);
  if (!role) return { status: "denied", reason: "invalid_role" };
  if (!row.is_active) return { status: "denied", reason: "inactive" };

  return {
    status: "authorized",
    staff: { userId: row.user_id, displayName: row.display_name, role },
  };
}

/** Applies a minimum-role requirement to an access decision. */
export function authorizeStaff(
  access: StaffAccess,
  minimum: StaffRole = "counter",
): StaffAccess | { status: "denied"; reason: "insufficient_role"; staff: StaffMember } {
  if (access.status !== "authorized") return access;
  if (meetsRole(access.staff.role, minimum)) return access;
  return { status: "denied", reason: "insufficient_role", staff: access.staff };
}

/**
 * Reads the caller's OWN profile through their own session. The explicit `user_id` filter matters:
 * managers may read every profile under RLS, so without it a manager would get several rows.
 * Inactive staff can still read their own row (Phase 1 policy), which is how we tell "inactive"
 * from "no profile".
 */
export async function fetchOwnProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<ProfileLookup> {
  const { data, error } = await supabase
    .from("staff_profiles")
    .select("user_id, display_name, role, is_active")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, row: data };
}

/**
 * Full server-side check for one request: validate the session with the Auth server
 * (`getUser`, which also rejects revoked sessions and deleted users; the cookie alone is never
 * trusted), then look up the profile. Fails closed: any problem we cannot classify is
 * "unavailable", never "authorized".
 */
export async function loadStaffAccess(supabase: SupabaseClient): Promise<StaffAccess> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    // A retryable error means Auth could not be reached: we do not know, so we must not
    // pretend the person is merely signed out.
    if (error && isAuthRetryableFetchError(error)) return { status: "unavailable" };
    return { status: "unauthenticated" };
  }
  const profile = await fetchOwnProfile(supabase, data.user.id);
  return resolveStaffAccess({ userId: data.user.id, profile });
}
