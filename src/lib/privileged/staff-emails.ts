import "server-only";

import { meetsRole, type StaffMember } from "@/lib/auth/staff";

import { createServiceRoleClient } from "./service-client";

/**
 * E-mail addresses live in Supabase Auth, which the manager's own session cannot read. This reads
 * ONLY the e-mail of the profiles the caller is already allowed to list, using the service role.
 *
 * The caller must pass the StaffMember returned by the manager guard; this re-checks the role so
 * the privileged key cannot be reached from a path that skipped authorisation. It returns
 * addresses only: no tokens, metadata or other account fields leave this function. A failure for
 * one person yields no address for them (shown as "unavailable"), never an error page.
 */
export async function loadStaffEmails(
  caller: StaffMember,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  if (!meetsRole(caller.role, "manager") || userIds.length === 0) return emails;

  const admin = createServiceRoleClient();
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const { data, error } = await admin.auth.admin.getUserById(id);
        if (!error && data.user?.email) emails.set(id, data.user.email);
      } catch {
        // Leave this person without an address.
      }
    }),
  );
  return emails;
}
