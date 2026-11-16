/**
 * The customer's cart: pure functions over a list of lines. A line is a REFERENCE (menu item id +
 * chosen option ids + quantity). It deliberately holds no names or prices, so nothing stale or
 * browser-supplied can be mistaken for the truth: display values come from the freshly loaded
 * menu, and the server re-prices everything at checkout.
 */
import { z } from "zod";

import type { CafeSettings } from "./catalog";

export interface CartLine {
  /** Stable identity: the item plus its sorted option ids. Different choices = different lines. */
  key: string;
  menuItemId: string;
  optionIds: string[];
  quantity: number;
}

export type CartLimits = Pick<CafeSettings, "maxItemQuantity" | "maxItemsPerOrder">;
export type CartResult = { ok: true; lines: CartLine[] } | { ok: false; message: string };

const normalise = (optionIds: readonly string[]) => [...new Set(optionIds)].sort();

export function lineKey(menuItemId: string, optionIds: readonly string[]): string {
  return `${menuItemId}|${normalise(optionIds).join(",")}`;
}

export const cartCount = (lines: readonly CartLine[]) =>
  lines.reduce((sum, line) => sum + line.quantity, 0);

function check(lines: CartLine[], limits: CartLimits): CartResult {
  for (const line of lines) {
    if (line.quantity > limits.maxItemQuantity) {
      return { ok: false, message: `You can order at most ${limits.maxItemQuantity} of one item.` };
    }
  }
  if (cartCount(lines) > limits.maxItemsPerOrder) {
    return {
      ok: false,
      message: `One order can hold at most ${limits.maxItemsPerOrder} items.`,
    };
  }
  return { ok: true, lines };
}

export interface NewLine {
  menuItemId: string;
  optionIds: readonly string[];
  quantity: number;
}

/** Adds a line, or increases an existing line with exactly the same choices. */
export function addLine(
  lines: readonly CartLine[],
  input: NewLine,
  limits: CartLimits,
): CartResult {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, message: "Quantity must be at least 1." };
  }
  const optionIds = normalise(input.optionIds);
  const key = lineKey(input.menuItemId, optionIds);
  const existing = lines.find((line) => line.key === key);
  const next = existing
    ? lines.map((line) =>
        line.key === key ? { ...line, quantity: line.quantity + input.quantity } : line,
      )
    : [...lines, { key, menuItemId: input.menuItemId, optionIds, quantity: input.quantity }];
  return check(next, limits);
}

/** Sets a line's quantity. Zero (or less) removes it. */
export function setQuantity(
  lines: readonly CartLine[],
  key: string,
  quantity: number,
  limits: CartLimits,
): CartResult {
  if (quantity < 1) return { ok: true, lines: removeLine(lines, key) };
  return check(
    lines.map((line) => (line.key === key ? { ...line, quantity } : line)),
    limits,
  );
}

export const removeLine = (lines: readonly CartLine[], key: string): CartLine[] =>
  lines.filter((line) => line.key !== key);

/**
 * Edits a line (new choices and/or quantity). The edited line replaces the ORIGINAL at its
 * position; if the new choices equal another existing line the two are merged.
 */
export function replaceLine(
  lines: readonly CartLine[],
  oldKey: string,
  input: NewLine,
  limits: CartLimits,
): CartResult {
  const index = lines.findIndex((line) => line.key === oldKey);
  if (index === -1) return addLine(lines, input, limits);
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, message: "Quantity must be at least 1." };
  }
  const optionIds = normalise(input.optionIds);
  const key = lineKey(input.menuItemId, optionIds);
  const without = lines.filter((_, i) => i !== index);
  const twin = without.find((line) => line.key === key);
  let next: CartLine[];
  if (twin) {
    next = without.map((line) =>
      line.key === key ? { ...line, quantity: line.quantity + input.quantity } : line,
    );
  } else {
    next = [...without];
    next.splice(index, 0, {
      key,
      menuItemId: input.menuItemId,
      optionIds,
      quantity: input.quantity,
    });
  }
  return check(next, limits);
}

// ------------------------------------------------------------------ persistence

const storedSchema = z.object({
  version: z.literal(1),
  lines: z
    .array(
      z.object({
        menuItemId: z.uuid(),
        optionIds: z.array(z.uuid()).max(40),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .max(50),
});

export const emptyCart: CartLine[] = [];

export function serialiseCart(lines: readonly CartLine[]): string {
  return JSON.stringify({
    version: 1,
    lines: lines.map(({ menuItemId, optionIds, quantity }) => ({
      menuItemId,
      optionIds,
      quantity,
    })),
  });
}

/** Anything unreadable, tampered or from an older shape becomes an empty cart, never an error. */
export function parseStoredCart(raw: string | null): CartLine[] {
  if (!raw) return emptyCart;
  try {
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return emptyCart;
    const merged: CartLine[] = [];
    for (const line of parsed.data.lines) {
      const optionIds = normalise(line.optionIds);
      const key = lineKey(line.menuItemId, optionIds);
      const twin = merged.find((m) => m.key === key);
      if (twin) twin.quantity = Math.min(99, twin.quantity + line.quantity);
      else merged.push({ key, menuItemId: line.menuItemId, optionIds, quantity: line.quantity });
    }
    return merged;
  } catch {
    return emptyCart;
  }
}
