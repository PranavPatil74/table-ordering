import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStaffPage } from "@/lib/auth/session";

const CAN_DO: Record<"counter" | "manager", readonly string[]> = {
  counter: [
    "See paid orders and move them through preparation",
    "Mark menu items and options sold out, and available again",
  ],
  manager: [
    "Everything the counter can do",
    "Cancel orders, and change prices, menu items, tables and cafe settings",
    "Activate or deactivate staff accounts",
  ],
};

/** Phase 2 landing page: proves sign-in works and shows the role the DATABASE says you have. */
export default async function StaffHome() {
  const staff = await requireStaffPage();

  return (
    <>
      <section aria-labelledby="welcome-title" className="flex flex-col gap-3 pt-2">
        <Badge variant="gold">Signed in</Badge>
        <h1 id="welcome-title" className="text-3xl font-semibold sm:text-4xl">
          Hello, {staff.displayName}
        </h1>
        <p className="text-lg text-muted-foreground">
          You&apos;re signed in as <strong className="text-foreground">{staff.role}</strong>.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What your role allows</CardTitle>
            <CardDescription>
              Enforced by the database, not by this page. Some of these tools arrive in later
              releases.
            </CardDescription>
          </CardHeader>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-base">
            {CAN_DO[staff.role].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Card>

        {staff.role === "manager" ? (
          <Card>
            <CardHeader>
              <CardTitle>Manager tools</CardTitle>
              <CardDescription>
                Set up what guests can order and the tables they scan from.
              </CardDescription>
            </CardHeader>
            <ul className="flex flex-col gap-2 text-base font-semibold">
              <li>
                <Link href="/staff/manager" className="underline underline-offset-4">
                  Manager overview
                </Link>
              </li>
              <li>
                <Link href="/staff/manager/menu" className="underline underline-offset-4">
                  Menu management
                </Link>
              </li>
              <li>
                <Link href="/staff/manager/tables" className="underline underline-offset-4">
                  Cafe tables and QR codes
                </Link>
              </li>
              <li>
                <Link href="/staff/manager/staff" className="underline underline-offset-4">
                  Staff
                </Link>
              </li>
            </ul>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Coming next</CardTitle>
              <CardDescription>
                The live order board is not built yet. For now this page only confirms that you can
                sign in.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </>
  );
}
