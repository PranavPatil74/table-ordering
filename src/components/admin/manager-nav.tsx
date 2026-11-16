"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export const MANAGER_LINKS = [
  { href: "/staff/manager", label: "Overview", exact: true },
  { href: "/staff/manager/menu", label: "Menu management", exact: false },
  { href: "/staff/manager/tables", label: "Cafe tables and QR codes", exact: false },
  { href: "/staff/manager/staff", label: "Staff", exact: false },
] as const;

/** Section navigation. Which link is current is shown with aria-current and a visible underline. */
export function ManagerNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Manager" className="print:hidden">
      <ul className="flex flex-wrap gap-x-1 gap-y-2 border-b">
        {MANAGER_LINKS.map((link) => {
          const current = link.exact ? pathname === link.href : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex min-h-11 items-center border-b-[3px] px-3 text-base font-semibold",
                  "focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none",
                  current
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
