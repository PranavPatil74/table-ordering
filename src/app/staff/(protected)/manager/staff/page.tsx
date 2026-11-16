import Link from "next/link";

import { PageHeader } from "@/components/admin/page-header";
import { StaffDirectory } from "@/components/admin/staff-directory";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";
import { loadStaffEmails } from "@/lib/privileged/staff-emails";
import type { StaffRow } from "@/lib/staff/directory";
import { loadStaffProfiles } from "@/lib/staff/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata = { title: "Staff" };

/** Manager-only staff directory. Counter staff and signed-out visitors get a 404 / sign-in. */
export default async function StaffPage() {
  const me = await requireStaffPage("manager");
  const supabase = await createSupabaseServerClient();
  const loaded = await loadStaffProfiles(supabase);

  const header = (
    <PageHeader
      eyebrow={<Badge variant="gold">Manager</Badge>}
      title="Staff"
      description="Who can sign in to the staff area, and what they can do."
    />
  );

  if (!loaded.ok) {
    return (
      <>
        {header}
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-xl border border-destructive bg-card p-5"
          data-testid="staff-load-error"
        >
          <p className="font-semibold text-destructive">We couldn&apos;t load the staff list.</p>
          <p className="text-muted-foreground">
            Nothing was changed. Check your connection and try again.
          </p>
          <Button asChild variant="outline">
            <Link href="/staff/manager/staff">Try again</Link>
          </Button>
        </div>
      </>
    );
  }

  const emails = await loadStaffEmails(
    me,
    loaded.profiles.map((profile) => profile.userId),
  );
  const rows: StaffRow[] = loaded.profiles.map((profile) => ({
    ...profile,
    email: emails.get(profile.userId) ?? null,
  }));

  return (
    <>
      {header}
      <StaffDirectory rows={rows} currentUserId={me.userId} />
      <Card>
        <CardHeader>
          <CardTitle>Adding a new team member</CardTitle>
          <CardDescription>
            New accounts are not created from this screen on purpose: creating a sign-in needs
            privileged access that should never be reachable from a web form. The cafe owner or
            developer adds new people securely; the steps are in{" "}
            <code>docs/staff-management.md</code>. Once they exist, you manage them here.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
