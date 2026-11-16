/**
 * Data access for staff management. Runs AS THE SIGNED-IN MANAGER (publishable key + their
 * session): `staff_profiles` row-level security allows only managers to read everyone and to
 * update, the column grant limits updates to display_name / role / is_active, and the
 * `guard_last_active_manager` trigger refuses to leave the cafe without an active manager.
 *
 * Deliberately NOT here: creating staff, deleting staff, changing roles. See docs/staff-management.md.
 * No `server-only` import so the integration tests can call these exact functions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { STAFF_ROLES, type StaffRole } from "@/lib/auth/staff";

export interface ProfileRow {
  userId: string;
  displayName: string;
  role: StaffRole;
  isActive: boolean;
  createdAt: string;
}

const profileSchema = z.object({
  user_id: z.uuid(),
  display_name: z.string(),
  role: z.enum(STAFF_ROLES),
  is_active: z.boolean(),
  created_at: z.string(),
});

export type LoadProfiles = { ok: true; profiles: ProfileRow[] } | { ok: false };

export async function loadStaffProfiles(supabase: SupabaseClient): Promise<LoadProfiles> {
  const { data, error } = await supabase
    .from("staff_profiles")
    .select("user_id, display_name, role, is_active, created_at")
    .order("created_at", { ascending: true });
  if (error || !data) return { ok: false };
  const profiles: ProfileRow[] = [];
  for (const raw of data) {
    // A row we do not understand (unknown role, wrong shape) is skipped, never guessed at.
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    profiles.push({
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at,
    });
  }
  return { ok: true, profiles };
}

export type SetActiveResult =
  | { ok: true; message: string }
  | {
      ok: false;
      message: string;
      kind: "self" | "not_found" | "last_manager" | "conflict" | "error";
    };

const fail = (kind: Extract<SetActiveResult, { ok: false }>["kind"], message: string) =>
  ({ ok: false, kind, message }) as const;

/**
 * Activates or deactivates one staff account.
 *
 * Safe against races: the update only matches the row while it still has the state we read
 * (`is_active = <previous>`), so if another manager changed it in between, nothing is written and
 * the caller is told to refresh instead of silently flipping it back.
 */
export async function setStaffActive(
  supabase: SupabaseClient,
  actorUserId: string,
  targetUserId: string,
  active: boolean,
): Promise<SetActiveResult> {
  if (!active && targetUserId === actorUserId) {
    return fail(
      "self",
      "You can't deactivate your own account. Ask another manager to do it if it's needed.",
    );
  }

  const { data: target, error: readError } = await supabase
    .from("staff_profiles")
    .select("user_id, display_name, role, is_active")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (readError)
    return fail("error", "We couldn't check that account. Nothing was changed. Try again.");
  if (!target) return fail("not_found", "That staff account doesn't exist any more.");

  if (target.is_active === active) {
    return fail(
      "conflict",
      `${target.display_name} is already ${active ? "active" : "deactivated"}. The list has been refreshed.`,
    );
  }

  const { data: updated, error } = await supabase
    .from("staff_profiles")
    .update({ is_active: active })
    .eq("user_id", targetUserId)
    .eq("is_active", !active)
    .select("user_id")
    .maybeSingle();

  if (error) {
    if (error.code === "23514" || /active manager/i.test(error.message ?? "")) {
      return fail(
        "last_manager",
        "You can't deactivate the last active manager. Make another manager active first.",
      );
    }
    return fail("error", "We couldn't save that change. Nothing was changed. Try again.");
  }
  if (!updated) {
    return fail(
      "conflict",
      "Someone else changed this account at the same time. The list has been refreshed. Check it and try again.",
    );
  }
  return {
    ok: true,
    message: active
      ? `${target.display_name} is active again and can sign in.`
      : `${target.display_name} is deactivated and has lost access.`,
  };
}
