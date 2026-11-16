import { NextResponse } from "next/server";

import { requireStaffApi } from "@/lib/auth/session";

/**
 * Who am I? Any ACTIVE staff member (counter or manager) gets their own id, display name and role,
 * read from `staff_profiles`. Everyone else gets 401 or 403. Never returns tokens or email.
 */
export async function GET() {
  const guard = await requireStaffApi();
  if (!guard.ok) return guard.response;

  const { userId, displayName, role } = guard.staff;
  return NextResponse.json(
    { userId, displayName, role },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
