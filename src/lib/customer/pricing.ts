/**
 * Re-prices a cart against a freshly loaded catalog. This is the ONLY place a cart becomes money.
 * The browser uses it to show totals; the server uses the very same function to decide, so what the
 * customer sees and what would be charged cannot disagree, and a client-supplied price is never an
 * input (a cart line carries ids and a quantity, nothing else).
 */
import { sumPaise } from "@/lib/money";

import type { CafeSettings, Catalog, CatalogItem } from "./catalog";
import { findItem } from "./catalog";
import type { CartLine } from "./cart";
import {
  itemOrderability,
  orderSizeProblem,
  priceLine,
  quantityProblem,
  validateSelection,
  type ChosenOption,
  type LinePrice,
} from "./rules";

export type LineStatus = "ok" | "removed" | "sold_out" | "changed" | "invalid";

export interface PricedLine {
  key: string;
  menuItemId: string;
  optionIds: string[];
  quantity: number;
  status: LineStatus;
  /** Human-readable reasons the line cannot be ordered as it stands. Empty when ok. */
  problems: string[];
  item: CatalogItem | null;
  chosen: ChosenOption[];
  price: LinePrice | null;
}

export interface Pricing {
  lines: PricedLine[];
  /** Sum of the orderable lines only. */
  totalPaise: number;
  itemCount: number;
  /** Order-level problems (orders paused, too many items, empty cart). */
  blockers: string[];
  /** True only if every line is orderable and no blocker applies. */
  canCheckout: boolean;
}

export function priceCart(
  catalog: Catalog,
  settings: CafeSettings,
  lines: readonly CartLine[],
): Pricing {
  const priced: PricedLine[] = lines.map((line) => {
    const base = {
      key: line.key,
      menuItemId: line.menuItemId,
      optionIds: line.optionIds,
      quantity: line.quantity,
    };
    const item = findItem(catalog, line.menuItemId);
    if (!item) {
      return {
        ...base,
        status: "removed" as const,
        problems: ["This item is no longer on the menu."],
        item: null,
        chosen: [],
        price: null,
      };
    }

    const orderable = itemOrderability(item);
    if (!orderable.ok) {
      return {
        ...base,
        status: "sold_out" as const,
        problems: [orderable.message],
        item,
        chosen: [],
        price: null,
      };
    }

    const quantity = quantityProblem(line.quantity, settings);
    const selection = validateSelection(item, line.optionIds);
    if (!selection.ok) {
      const soldOut = selection.problems.some((p) => p.code === "option_unavailable");
      return {
        ...base,
        status: soldOut ? ("sold_out" as const) : ("changed" as const),
        problems: [...selection.problems.map((p) => p.message), ...(quantity ? [quantity] : [])],
        item,
        chosen: [],
        price: null,
      };
    }
    if (quantity) {
      return {
        ...base,
        status: "invalid" as const,
        problems: [quantity],
        item,
        chosen: selection.chosen,
        price: null,
      };
    }
    return {
      ...base,
      status: "ok" as const,
      problems: [],
      item,
      chosen: selection.chosen,
      price: priceLine(item, selection.chosen, line.quantity),
    };
  });

  const ok = priced.filter((line) => line.status === "ok");
  const blockers: string[] = [];
  if (!settings.ordersEnabled) {
    blockers.push("The cafe isn't taking orders right now.");
  }
  if (priced.length === 0) blockers.push("Your cart is empty.");
  const size = orderSizeProblem(
    priced.map((line) => line.quantity),
    settings,
  );
  if (size) blockers.push(size);
  if (priced.some((line) => line.status !== "ok")) {
    blockers.push("Some items in your cart need attention before you can continue.");
  }

  return {
    lines: priced,
    totalPaise: sumPaise(ok.map((line) => line.price?.totalPaise ?? 0)),
    itemCount: priced.reduce((sum, line) => sum + line.quantity, 0),
    blockers,
    canCheckout: blockers.length === 0,
  };
}
