import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";

import { fail, type ActionResult } from "@/lib/forms";
import type { RepoResult } from "@/lib/menu/repository";

import type { StaffMember } from "./staff";
import { requireStaffAction } from "./session";

/**
 * Runs a manager-only Server Action body. Order matters and is the same for every action:
 *  1. verify, on the server, that the caller is an ACTIVE MANAGER (counter staff, signed-out
 *     users and inactive staff are refused here, whatever the form or URL said);
 *  2. run the body with the caller's own Supabase client (database RLS applies a second time);
 *  3. never leak an unexpected error: log its type only, tell the user nothing was saved.
 */
export async function managerAction(
  body: (supabase: SupabaseClient, staff: StaffMember) => Promise<ActionResult>,
): Promise<ActionResult> {
  const guard = await requireStaffAction("manager");
  if (!guard.ok) return fail(guard.message);

  let result: ActionResult;
  try {
    result = await body(guard.supabase, guard.staff);
  } catch (error) {
    console.error(`[manager action] unexpected ${error instanceof Error ? error.name : "error"}`);
    return fail("Something went wrong. Nothing was saved. Try again.");
  }
  // The staff area is dynamic, but the client-side router cache must not show stale lists.
  if (result.ok) revalidatePath("/staff/manager", "layout");
  return result;
}

/** Converts a repository outcome into what a form shows. */
export function toResult<T>(
  outcome: RepoResult<T>,
  successMessage: string,
  idOf?: (data: T) => string,
): ActionResult {
  if (outcome.ok) {
    const id = idOf?.(outcome.data);
    return id ? { ok: true, message: successMessage, id } : { ok: true, message: successMessage };
  }
  return fail(outcome.message, outcome.field ? { [outcome.field]: outcome.message } : undefined);
}
