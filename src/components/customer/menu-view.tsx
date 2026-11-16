"use client";

import Link from "next/link";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CafeSettings, Catalog, CatalogItem } from "@/lib/customer/catalog";
import { itemOrderability } from "@/lib/customer/rules";
import { DIETARY_TAG_LABELS } from "@/lib/menu/validation";
import { formatPaise } from "@/lib/money";

import { useCart } from "./cart-provider";
import { ItemImage } from "./item-image";
import { ItemSheet } from "./item-sheet";

export function MenuView({
  catalog,
  settings,
  tableCode,
}: {
  catalog: Catalog;
  settings: CafeSettings;
  tableCode: string;
}) {
  const cart = useCart();
  const [active, setActive] = React.useState<CatalogItem | null>(null);

  function quickAdd(item: CatalogItem) {
    const result = cart.add({ menuItemId: item.id, optionIds: [], quantity: 1 });
    cart.announce(result.ok ? `Added ${item.name} to your cart` : result.message);
  }

  if (catalog.categories.length === 0) {
    return (
      <section
        className="flex flex-col items-center gap-3 rounded-xl border bg-card p-8 text-center"
        data-testid="menu-empty"
      >
        <h1 className="text-2xl font-semibold">The menu is empty right now</h1>
        <p className="text-muted-foreground">
          We haven&apos;t put anything on the menu yet. Please check back soon or ask a member of
          staff.
        </p>
      </section>
    );
  }

  return (
    <>
      <h1 className="sr-only">Menu</h1>
      {!settings.ordersEnabled ? (
        <p
          role="status"
          className="rounded-lg border border-gold bg-card p-3 text-base"
          data-testid="orders-paused"
        >
          We&apos;re not taking orders right now. You can still look at the menu.
        </p>
      ) : null}

      <nav
        aria-label="Menu categories"
        className="sticky top-[4.25rem] z-10 -mx-4 flex gap-2 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
      >
        {catalog.categories.map((category) => (
          <a
            key={category.id}
            href={`#category-${category.id}`}
            className="inline-flex h-10 shrink-0 items-center rounded-full border border-input bg-card px-4 text-sm font-semibold hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
          >
            {category.name}
          </a>
        ))}
      </nav>

      {catalog.categories.map((category) => (
        <section
          key={category.id}
          id={`category-${category.id}`}
          aria-labelledby={`heading-${category.id}`}
          className="flex scroll-mt-32 flex-col gap-3"
        >
          <div>
            <h2 id={`heading-${category.id}`} className="text-2xl font-semibold">
              {category.name}
            </h2>
            {category.description ? (
              <p className="text-muted-foreground">{category.description}</p>
            ) : null}
          </div>
          <ul className="flex flex-col gap-3">
            {category.items.map((item) => {
              const orderable = itemOrderability(item);
              const customisable = item.groups.length > 0;
              return (
                <li
                  key={item.id}
                  data-testid={`menu-item-${item.id}`}
                  className="flex gap-3 rounded-xl border bg-card p-3 shadow-card"
                >
                  <ItemImage name={item.name} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-lg leading-snug font-semibold">{item.name}</h3>
                      <span className="shrink-0 font-semibold">{formatPaise(item.pricePaise)}</span>
                    </div>
                    {item.description ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {item.description}
                      </p>
                    ) : null}
                    {item.dietaryTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {item.dietaryTags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {DIETARY_TAG_LABELS[tag] ?? tag}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-1 flex items-center justify-between gap-2">
                      {orderable.ok ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={!settings.ordersEnabled}
                          aria-label={`${customisable ? "Customise and add" : "Add"} ${item.name}`}
                          onClick={() => (customisable ? setActive(item) : quickAdd(item))}
                        >
                          {customisable ? "Customise" : "Add"}
                        </Button>
                      ) : (
                        <Badge variant="secondary" data-testid="unavailable-badge">
                          {orderable.reason === "sold_out" ? "Sold out" : "Unavailable"}
                        </Badge>
                      )}
                      {!orderable.ok && orderable.reason === "unconfigurable" ? (
                        <span className="text-xs text-muted-foreground">{orderable.message}</span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <ItemSheet
        item={active}
        mode="add"
        maxQuantity={settings.maxItemQuantity}
        onClose={() => setActive(null)}
        onSubmit={({ optionIds, quantity }) => {
          if (!active) return null;
          const result = cart.add({ menuItemId: active.id, optionIds, quantity });
          if (!result.ok) return result.message;
          cart.announce(`Added ${active.name} to your cart`);
          setActive(null);
          return null;
        }}
      />

      <CartBar tableCode={tableCode} />
    </>
  );
}

/** Sticky "view cart" bar: the cart indicator that stays in reach while scrolling the menu. */
function CartBar({ tableCode }: { tableCode: string }) {
  const { count, hydrated } = useCart();
  if (!hydrated || count === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <Button asChild size="lg" className="w-full">
          <Link href={`/cart?table=${encodeURIComponent(tableCode)}`} data-testid="view-cart">
            View cart · {count} {count === 1 ? "item" : "items"}
          </Link>
        </Button>
      </div>
    </div>
  );
}
