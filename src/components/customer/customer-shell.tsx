"use client";

import Link from "next/link";
import * as React from "react";

import { LogoMark } from "@/components/brand/logo-mark";
import type { CartLimits } from "@/lib/customer/cart";

import { CartProvider, useCart } from "./cart-provider";

function CartLink({ tableCode }: { tableCode: string }) {
  const { count, hydrated } = useCart();
  return (
    <Link
      href={`/cart?table=${encodeURIComponent(tableCode)}`}
      className="inline-flex h-11 items-center gap-2 rounded-lg border border-input bg-card px-3 text-base font-semibold hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
      data-testid="cart-link"
    >
      <span>Cart</span>
      <span
        aria-label={
          hydrated ? `${count} ${count === 1 ? "item" : "items"} in cart` : "Loading cart"
        }
        data-testid="cart-count"
        className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-sm text-primary-foreground"
      >
        {hydrated ? count : "·"}
      </span>
    </Link>
  );
}

/** Branding, the table the customer is ordering for, and the cart indicator. */
export function CustomerShell({
  cafeName,
  tableCode,
  tableLabel,
  limits,
  children,
}: {
  cafeName: string;
  tableCode: string;
  tableLabel: string;
  limits: CartLimits;
  children: React.ReactNode;
}) {
  return (
    <CartProvider tableCode={tableCode} limits={limits}>
      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
        <header className="sticky top-0 z-20 -mx-4 flex items-center justify-between gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <Link
            href={`/menu?table=${encodeURIComponent(tableCode)}`}
            className="flex min-w-0 items-center gap-3 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
          >
            <LogoMark className="size-9" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-display text-lg font-semibold">{cafeName}</span>
              <span className="text-sm text-muted-foreground" data-testid="table-chip">
                Ordering for {tableLabel}
              </span>
            </span>
          </Link>
          <CartLink tableCode={tableCode} />
        </header>
        <main className="flex flex-1 flex-col gap-6 py-5 pb-28">{children}</main>
      </div>
    </CartProvider>
  );
}
