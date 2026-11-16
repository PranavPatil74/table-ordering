"use client";

import { Button } from "@/components/ui/button";

/** Shown when staff access could not be verified (Auth or database unreachable). Fails closed. */
export default function StaffError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center gap-4 px-5">
      <h1 className="text-3xl font-semibold">We couldn&apos;t check your access</h1>
      <p className="text-lg text-muted-foreground">
        The sign-in service didn&apos;t respond. Nothing was changed. Try again in a moment.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
