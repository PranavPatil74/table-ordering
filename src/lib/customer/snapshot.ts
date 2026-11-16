/**
 * Builds the `cart_snapshot` v1 document the database defines for a payment attempt
 * (see `private.cart_snapshot_problem`). In Phase 4 this is only PREPARED and returned for
 * review: nothing is persisted, because creating a payment attempt belongs to the payment phase.
 * Building it here proves the cart maps onto the schema and keeps Phase 5 a thin step.
 */
import type { Pricing } from "./pricing";

export interface OrderSnapshot {
  version: 1;
  table: { id: string; code: string; label: string };
  customer_name: string | null;
  special_instructions: string | null;
  items: {
    menu_item_id: string;
    item_name: string;
    unit_price_paise: number;
    quantity: number;
    note: string | null;
    options: {
      group_id: string;
      group_name: string;
      option_id: string;
      option_name: string;
      price_delta_paise: number;
    }[];
  }[];
  total_paise: number;
}

export const CUSTOMER_NAME_MAX = 60;
export const SPECIAL_INSTRUCTIONS_MAX = 500;

const tidy = (value: string | null | undefined, max: number): string | null => {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, max);
};

export const cleanCustomerName = (value: string | null | undefined) =>
  tidy(value, CUSTOMER_NAME_MAX)?.replace(/\s*[\r\n]+\s*/g, " ") ?? null;
export const cleanInstructions = (value: string | null | undefined) =>
  tidy(value, SPECIAL_INSTRUCTIONS_MAX);

export function buildOrderSnapshot(
  table: { id: string; code: string; label: string },
  pricing: Pricing,
  extra: { customerName?: string | null; specialInstructions?: string | null } = {},
): OrderSnapshot {
  if (!pricing.canCheckout) {
    throw new Error("Cannot build a snapshot for a cart that is not ready to check out.");
  }
  return {
    version: 1,
    table: { id: table.id, code: table.code, label: table.label },
    customer_name: cleanCustomerName(extra.customerName),
    special_instructions: cleanInstructions(extra.specialInstructions),
    items: pricing.lines.map((line) => ({
      menu_item_id: line.menuItemId,
      item_name: line.item!.name,
      unit_price_paise: line.item!.pricePaise,
      quantity: line.quantity,
      note: null,
      options: line.chosen.map(({ group, option }) => ({
        group_id: group.id,
        group_name: group.name,
        option_id: option.id,
        option_name: option.name,
        price_delta_paise: option.priceDeltaPaise,
      })),
    })),
    total_paise: pricing.totalPaise,
  };
}
