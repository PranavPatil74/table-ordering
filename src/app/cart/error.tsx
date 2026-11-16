"use client";

import { Button } from "@/components/ui/button";

export default function CustomerError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-5 text-center"
      data-testid="customer-error"
    >
      <h1 className="text-3xl font-semibold">Something went wrong</h1>
      <p role="alert" className="text-lg text-muted-foreground">
        We couldn&apos;t show this page. Please try again.
      </p>
      <Button type="button" className="mx-auto" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
