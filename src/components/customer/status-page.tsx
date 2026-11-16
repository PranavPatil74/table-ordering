import Link from "next/link";

import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";

/** Full-page message for the customer area: bad QR code, missing table, menu outage. */
export function CustomerStatusPage({
  title,
  body,
  testId,
  retryHref,
}: {
  title: string;
  body: string;
  testId: string;
  /** When set, shows a "Try again" link that reloads this address. */
  retryHref?: string;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-5 py-10 text-center">
      <LogoMark className="mx-auto size-14" />
      <main className="flex flex-col gap-3" data-testid={testId}>
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p className="text-lg text-muted-foreground" role="alert">
          {body}
        </p>
        {retryHref ? (
          <Button asChild className="mx-auto mt-2">
            <Link href={retryHref}>Try again</Link>
          </Button>
        ) : null}
      </main>
    </div>
  );
}
