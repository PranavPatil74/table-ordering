"use client";

import { Button } from "@/components/ui/button";

/** Shown when a manager page's data could not be loaded. Nothing was changed. */
export default function ManagerError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-4 rounded-xl border border-destructive bg-card p-6"
    >
      <h1 className="text-2xl font-semibold">We couldn&apos;t load this page</h1>
      <p className="text-lg text-muted-foreground">
        The database didn&apos;t answer. Nothing was changed. Check your connection and try again.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
