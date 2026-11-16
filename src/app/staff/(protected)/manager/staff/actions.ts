"use server";

import { z } from "zod";

import { managerAction } from "@/lib/auth/manager-action";
import { fail, ok } from "@/lib/forms";
import { parse } from "@/lib/menu/validation";
import { setStaffActive } from "@/lib/staff/repository";

/**
 * Staff management Server Action. Manager-only (re-verified on the server for every call),
 * validated, and run as the manager's own database session so row-level security and the
 * last-manager trigger apply. The target comes from the argument; the ACTOR always comes from the
 * verified session, never from anything the browser sent.
 */
export async function setStaffActiveAction(userId: string, active: boolean) {
  if (!parse(z.object({ userId: z.uuid(), active: z.boolean() }), { userId, active }).ok) {
    return fail("That request is not valid.");
  }
  return managerAction(async (supabase, staff) => {
    const result = await setStaffActive(supabase, staff.userId, userId, active);
    return result.ok ? ok(result.message) : fail(result.message);
  });
}
