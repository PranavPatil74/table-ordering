import { cn } from "@/lib/utils";

/**
 * Sandwich Express mark: stacked bread, filling and tomato layers on a forest tile.
 * Purely decorative (the wordmark next to it carries the accessible name).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 40 40"
      className={cn("size-10 shrink-0", className)}
    >
      <rect width="40" height="40" rx="10" fill="var(--primary)" />
      <rect x="8" y="10" width="24" height="5" rx="2.5" fill="var(--background)" />
      <rect x="8" y="17.5" width="24" height="4" rx="2" fill="var(--gold)" />
      <rect x="8" y="23.5" width="24" height="4" rx="2" fill="var(--accent)" />
      <rect x="8" y="29.5" width="24" height="5" rx="2.5" fill="var(--background)" />
    </svg>
  );
}
