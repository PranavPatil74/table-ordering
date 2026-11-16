import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badges carry short labels. The `status*` variants map one-to-one onto the order
 * preparation states (NEW, ACCEPTED, PREPARING, READY, SERVED, CANCELLED) so the counter
 * board and the customer tracker share one visual language. Colour is never the only
 * signal: always render the status text inside the badge.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border-input bg-card text-foreground",
        gold: "bg-gold text-gold-foreground",
        statusNew: "bg-status-new text-status-new-foreground",
        statusAccepted: "bg-status-accepted text-status-accepted-foreground",
        statusPreparing: "bg-status-preparing text-status-preparing-foreground",
        statusReady: "bg-status-ready text-status-ready-foreground",
        statusServed: "bg-status-served text-status-served-foreground",
        statusCancelled: "bg-status-cancelled text-status-cancelled-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
export type { BadgeProps };
