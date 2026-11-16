import type { Metadata } from "next";

import { LogoMark } from "@/components/brand/logo-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireStaffPage } from "@/lib/auth/session";

import { signOutAction } from "../actions";

export const metadata: Metadata = {
  title: "Staff",
  robots: { index: false, follow: false },
};

/**
 * The shell of the protected staff area. Layouts are not re-run on every client navigation, so
 * this guard is for the header only: every page below ALSO calls requireStaffPage() itself.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaffPage();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 sm:px-8">
      <header className="flex flex-wrap print:hidden items-center justify-between gap-x-4 gap-y-3 py-5">
        <div className="flex items-center gap-3">
          <LogoMark />
          <span className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            Sandwich Express
            <span className="sr-only"> staff area</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">{staff.displayName}</span>
          <Badge variant={staff.role === "manager" ? "gold" : "secondary"}>{staff.role}</Badge>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-8 pb-16">{children}</main>
    </div>
  );
}
