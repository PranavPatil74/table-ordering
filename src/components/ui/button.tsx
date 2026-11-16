import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Buttons have a 44px minimum touch target on mobile (h-11) and a tactile "pressed" feel:
 * a solid lower edge that collapses by 1px on press. Motion is removed automatically for
 * users who prefer reduced motion (see globals.css).
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg",
    "text-base font-semibold transition-[transform,box-shadow,background-color] duration-100",
    "cursor-pointer select-none outline-none",
    "focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "active:translate-y-px active:shadow-none",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_2px_0_0_var(--primary-deep)] hover:bg-primary-deep",
        accent: "bg-accent text-accent-foreground shadow-[0_2px_0_0_#7e2a1c] hover:brightness-95",
        secondary:
          "bg-secondary text-secondary-foreground shadow-[0_2px_0_0_var(--border)] hover:bg-[#e6dac1]",
        outline:
          "border border-input bg-card text-foreground shadow-[0_2px_0_0_var(--border)] hover:bg-muted",
        ghost: "text-foreground hover:bg-muted active:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_2px_0_0_#6e1a12] hover:brightness-95",
        link: "text-primary underline-offset-4 hover:underline active:translate-y-0",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-3.5 text-sm",
        lg: "h-12 px-7 text-lg",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
