import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LogoMark } from "@/components/brand/logo-mark";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeStaffPath } from "@/lib/auth/login";
import { getStaffAccess } from "@/lib/auth/session";

import { signOutAction } from "../actions";
import { LoginForm } from "./login-form";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Staff sign-in",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function StaffLoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const access = await getStaffAccess();

  // Already signed in as active staff: nothing to do here.
  if (access.status === "authorized") redirect(safeStaffPath(first(params.next)));

  const next = first(params.next);
  const destination = next ? safeStaffPath(next) : undefined;
  const signedOut = first(params["signed-out"]) === "1";

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-10">
      <div className="flex items-center gap-3">
        <LogoMark />
        <span className="font-display text-2xl font-semibold tracking-tight">Sandwich Express</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Staff sign-in</CardTitle>
          <CardDescription>
            For cafe staff only. Customers don&apos;t need an account: scan the QR code on your
            table instead.
          </CardDescription>
        </CardHeader>

        {signedOut ? (
          <p role="status" className="rounded-lg bg-muted px-4 py-3 text-sm font-medium">
            You&apos;ve been signed out.
          </p>
        ) : null}

        {access.status === "denied" ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-destructive bg-card px-4 py-3"
          >
            <p className="text-sm font-medium text-destructive">
              {access.reason === "inactive"
                ? "This account has been deactivated. Ask a manager if you think that's a mistake."
                : "You're signed in, but this account doesn't have staff access. Ask a manager to set you up."}
            </p>
            <form action={signOutAction}>
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        ) : null}

        {access.status === "unavailable" ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive bg-card px-4 py-3 text-sm font-medium text-destructive"
          >
            We couldn&apos;t verify your session just now. Try signing in again in a moment.
          </p>
        ) : null}

        <LoginForm next={destination} />
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        Trouble signing in? Ask a manager.{" "}
        <Link className="underline underline-offset-4" href="/">
          Back to the home page
        </Link>
      </p>
    </div>
  );
}
