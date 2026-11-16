/**
 * Modifier and quantity rules, in ONE place used by both the customer's browser (to guide them)
 * and the server (to decide). They follow the database exactly: a group with `min_select >= 1` is
 * required, `max_select` is the cap, and archived / sold-out options can never be chosen.
 * Nothing here invents a rule the schema does not have.
 */
import { assertPaise, sumPaise } from "@/lib/money";

import type { CafeSettings, CatalogGroup, CatalogItem, CatalogOption } from "./catalog";

export type SelectionProblemCode =
  "unknown_option" | "duplicate_option" | "option_unavailable" | "too_few" | "too_many";

export interface SelectionProblem {
  code: SelectionProblemCode;
  groupId?: string;
  message: string;
}

export interface ChosenOption {
  group: CatalogGroup;
  option: CatalogOption;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Can this item be ordered at all right now? */
export type Orderability =
  { ok: true } | { ok: false; reason: "sold_out" | "unconfigurable"; message: string };

export function itemOrderability(item: CatalogItem): Orderability {
  if (!item.isAvailable) {
    return { ok: false, reason: "sold_out", message: "Sold out right now" };
  }
  for (const group of item.groups) {
    const available = group.options.filter((option) => option.isAvailable).length;
    if (available < group.minSelect) {
      return {
        ok: false,
        reason: "unconfigurable",
        message: `Temporarily unavailable: not enough "${group.name}" choices in stock`,
      };
    }
  }
  return { ok: true };
}

/** The pre-selected options, trimmed to each group's cap and skipping anything sold out. */
export function defaultSelection(item: CatalogItem): string[] {
  const chosen: string[] = [];
  for (const group of item.groups) {
    let count = 0;
    for (const option of group.options) {
      if (option.isDefault && option.isAvailable && count < group.maxSelect) {
        chosen.push(option.id);
        count += 1;
      }
    }
  }
  return chosen;
}

/** Checks a set of chosen option ids against the item's groups. */
export function validateSelection(
  item: CatalogItem,
  optionIds: readonly string[],
): { ok: true; chosen: ChosenOption[] } | { ok: false; problems: SelectionProblem[] } {
  const problems: SelectionProblem[] = [];
  const lookup = new Map<string, ChosenOption>();
  for (const group of item.groups) {
    for (const option of group.options) lookup.set(option.id, { group, option });
  }

  const seen = new Set<string>();
  const chosen: ChosenOption[] = [];
  for (const id of optionIds) {
    if (seen.has(id)) {
      problems.push({ code: "duplicate_option", message: "An option was chosen twice." });
      continue;
    }
    seen.add(id);
    const found = lookup.get(id);
    if (!found) {
      problems.push({
        code: "unknown_option",
        message: "One of the chosen options doesn't belong to this item any more.",
      });
      continue;
    }
    if (!found.option.isAvailable) {
      problems.push({
        code: "option_unavailable",
        groupId: found.group.id,
        message: `"${found.option.name}" is sold out.`,
      });
      continue;
    }
    chosen.push(found);
  }

  for (const group of item.groups) {
    const count = chosen.filter((c) => c.group.id === group.id).length;
    if (count < group.minSelect) {
      problems.push({
        code: "too_few",
        groupId: group.id,
        message:
          group.minSelect === 1
            ? `Choose one option for ${group.name}.`
            : `Choose at least ${plural(group.minSelect, "option", "options")} for ${group.name}.`,
      });
    }
    if (count > group.maxSelect) {
      problems.push({
        code: "too_many",
        groupId: group.id,
        message: `Choose at most ${plural(group.maxSelect, "option", "options")} for ${group.name}.`,
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  // Menu order (group, then option), whatever order the ids arrived in, so what the customer sees
  // and what the order snapshot records is stable and reads the way the menu does.
  const position = (c: ChosenOption) =>
    item.groups.indexOf(c.group) * 1000 + c.group.options.indexOf(c.option);
  return { ok: true, chosen: [...chosen].sort((a, b) => position(a) - position(b)) };
}

export interface LinePrice {
  unitPaise: number;
  optionsPaise: number;
  /** (unit + options) per piece. */
  eachPaise: number;
  totalPaise: number;
}

/** Integer-paise arithmetic only. */
export function priceLine(
  item: Pick<CatalogItem, "pricePaise">,
  chosen: readonly ChosenOption[],
  quantity: number,
): LinePrice {
  assertPaise(item.pricePaise, "item price");
  const optionsPaise = sumPaise(chosen.map((c) => c.option.priceDeltaPaise));
  const eachPaise = sumPaise([item.pricePaise, optionsPaise]);
  return {
    unitPaise: item.pricePaise,
    optionsPaise,
    eachPaise,
    totalPaise: sumPaise([eachPaise * quantity]),
  };
}

export function quantityProblem(
  quantity: unknown,
  settings: Pick<CafeSettings, "maxItemQuantity">,
): string | null {
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
    return "Quantity must be a whole number of at least 1.";
  }
  if (quantity > settings.maxItemQuantity) {
    return `You can order at most ${settings.maxItemQuantity} of one item.`;
  }
  return null;
}

export function orderSizeProblem(
  quantities: readonly number[],
  settings: Pick<CafeSettings, "maxItemsPerOrder">,
): string | null {
  const total = quantities.reduce((sum, q) => sum + q, 0);
  if (total > settings.maxItemsPerOrder) {
    return `One order can hold at most ${settings.maxItemsPerOrder} items. Please remove some.`;
  }
  return null;
}
