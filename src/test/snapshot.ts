/**
 * Pure builders for the cart snapshot stored on a payment attempt (`cart_snapshot` v1) and the
 * menu-fixture shape they consume. No database or network access, so both the PostgreSQL tests
 * (src/test/db) and the Supabase API tests (src/supabase-it) share one definition.
 */

export interface MenuFixture {
  categoryId: string;
  categoryName: string;
  item: { id: string; name: string; pricePaise: number };
  drink: { id: string; name: string; pricePaise: number };
  group: { id: string; name: string };
  optionCheese: { id: string; name: string; deltaPaise: number };
  optionMayo: { id: string; name: string; deltaPaise: number };
}

export interface SnapshotOption {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta_paise: number;
}

export interface SnapshotItem {
  menu_item_id: string;
  item_name: string;
  unit_price_paise: number;
  quantity: number;
  note: string | null;
  options: SnapshotOption[];
}

export interface CartSnapshot {
  version: 1;
  table: { id: string; code: string; label: string };
  customer_name: string | null;
  special_instructions: string | null;
  items: SnapshotItem[];
  total_paise: number;
}

/** Integer-only total, exactly as the database computes it. */
export function snapshotTotal(items: SnapshotItem[]): number {
  return items.reduce((sum, item) => {
    const optionSum = item.options.reduce((s, o) => s + o.price_delta_paise, 0);
    return sum + (item.unit_price_paise + optionSum) * item.quantity;
  }, 0);
}

export function buildSnapshot(
  table: { id: string; code: string; label: string },
  items: SnapshotItem[],
  extra: Partial<Pick<CartSnapshot, "customer_name" | "special_instructions">> = {},
): CartSnapshot {
  return {
    version: 1,
    table,
    customer_name: extra.customer_name ?? null,
    special_instructions: extra.special_instructions ?? null,
    items,
    total_paise: snapshotTotal(items),
  };
}

export function itemLine(
  menu: MenuFixture,
  which: "item" | "drink" = "item",
  quantity = 1,
  withCheese = false,
): SnapshotItem {
  const base = menu[which];
  return {
    menu_item_id: base.id,
    item_name: base.name,
    unit_price_paise: base.pricePaise,
    quantity,
    note: null,
    options: withCheese
      ? [
          {
            group_id: menu.group.id,
            group_name: menu.group.name,
            option_id: menu.optionCheese.id,
            option_name: menu.optionCheese.name,
            price_delta_paise: menu.optionCheese.deltaPaise,
          },
        ]
      : [],
  };
}
