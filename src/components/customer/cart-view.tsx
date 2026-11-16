"use client";

import Link from "next/link";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CafeSettings, Catalog } from "@/lib/customer/catalog";
import { priceCart, type PricedLine } from "@/lib/customer/pricing";
import { formatPaise } from "@/lib/money";

import { useCart } from "./cart-provider";
import { ItemSheet } from "./item-sheet";

const STATUS_LABEL: Record<PricedLine["status"], string> = {
  ok: "",
  removed: "No longer on the menu",
  sold_out: "Sold out",
  changed: "Options changed",
  invalid: "Check quantity",
};

export function CartView({
  catalog,
  settings,
  tableCode,
}: {
  catalog: Catalog;
  settings: CafeSettings;
  tableCode: string;
}) {
  const cart = useCart();
  const [editing, setEditing] = React.useState<PricedLine | null>(null);
  const menuHref = `/menu?table=${encodeURIComponent(tableCode)}`;

  const pricing = React.useMemo(
    () => priceCart(catalog, settings, cart.lines),
    [catalog, settings, cart.lines],
  );

  if (!cart.hydrated) {
    return (
      <p role="status" className="text-muted-foreground" data-testid="cart-loading">
        Loading your cart…
      </p>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <section
        className="flex flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center"
        data-testid="cart-empty"
      >
        <h1 className="text-2xl font-semibold">Your cart is empty</h1>
        <p className="text-muted-foreground">Add something tasty from the menu to get started.</p>
        <Button asChild>
          <Link href={menuHref}>Browse the menu</Link>
        </Button>
      </section>
    );
  }

  const problemKeys = pricing.lines.filter((l) => l.status !== "ok").map((l) => l.key);

  return (
    <>
      <h1 className="text-3xl font-semibold">Your cart</h1>

      {problemKeys.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive bg-card p-4"
          data-testid="cart-attention"
        >
          <p className="font-semibold text-destructive">
            Some items can&apos;t be ordered right now.
          </p>
          <p className="text-sm text-muted-foreground">
            The menu changed since you added them. Remove them, or edit the ones with changed
            options, to continue.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => cart.removeMany(problemKeys)}
            data-testid="remove-unavailable"
          >
            Remove unavailable items
          </Button>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {pricing.lines.map((line) => (
          <li
            key={line.key}
            data-testid="cart-line"
            data-status={line.status}
            className="flex flex-col gap-2 rounded-xl border bg-card p-3 shadow-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg leading-snug font-semibold">
                  {line.item?.name ?? "Unavailable item"}
                </h2>
                {line.chosen.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {line.chosen.map((c) => c.option.name).join(", ")}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 font-semibold" data-testid="line-total">
                {line.price ? formatPaise(line.price.totalPaise) : "—"}
              </span>
            </div>

            {line.status !== "ok" ? (
              <div className="flex flex-col gap-1">
                <Badge variant="statusNew" className="self-start">
                  {STATUS_LABEL[line.status]}
                </Badge>
                {line.problems.map((p) => (
                  <p key={p} className="text-sm text-destructive">
                    {p}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Decrease quantity of ${line.item?.name ?? "item"}`}
                  onClick={() => cart.setQty(line.key, line.quantity - 1)}
                >
                  −
                </Button>
                <output
                  className="w-8 text-center text-lg font-semibold"
                  data-testid="line-quantity"
                >
                  {line.quantity}
                </output>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Increase quantity of ${line.item?.name ?? "item"}`}
                  disabled={line.quantity >= settings.maxItemQuantity}
                  onClick={() => {
                    const result = cart.setQty(line.key, line.quantity + 1);
                    if (!result.ok) cart.announce(result.message);
                  }}
                >
                  +
                </Button>
              </div>
              <div className="flex gap-2">
                {line.item && line.status !== "removed" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(line)}
                    aria-label={`Edit ${line.item.name}`}
                  >
                    Edit
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => cart.remove(line.key)}
                  aria-label={`Remove ${line.item?.name ?? "item"}`}
                >
                  Remove
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <section
        aria-label="Order total"
        className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-semibold">Total</span>
          <span className="text-2xl font-semibold" data-testid="cart-total">
            {formatPaise(pricing.totalPaise)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Prices are as shown on the menu. We confirm them again before you pay.
        </p>
        {pricing.blockers
          .filter((b) => !b.startsWith("Some items") && b !== "Your cart is empty.")
          .map((b) => (
            <p key={b} role="alert" className="text-sm text-destructive">
              {b}
            </p>
          ))}
        {pricing.canCheckout ? (
          <Button asChild size="lg">
            <Link
              href={`/checkout?table=${encodeURIComponent(tableCode)}`}
              data-testid="go-checkout"
            >
              Continue to checkout
            </Link>
          </Button>
        ) : (
          <Button size="lg" disabled data-testid="go-checkout-disabled">
            Continue to checkout
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={menuHref}>Add more items</Link>
        </Button>
      </section>

      <ItemSheet
        item={editing?.item ?? null}
        mode="edit"
        initialOptionIds={editing?.optionIds}
        initialQuantity={editing?.quantity}
        maxQuantity={settings.maxItemQuantity}
        onClose={() => setEditing(null)}
        onSubmit={({ optionIds, quantity }) => {
          if (!editing?.item) return null;
          const result = cart.replace(editing.key, {
            menuItemId: editing.item.id,
            optionIds,
            quantity,
          });
          if (!result.ok) return result.message;
          setEditing(null);
          return null;
        }}
      />
    </>
  );
}
