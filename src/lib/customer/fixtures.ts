/** Shared test fixtures for the customer domain (used by unit tests only). */
import { buildCatalog, type CafeSettings, type RawCatalogRows } from "./catalog";

export const ids = {
  catSandwich: "10000000-0000-4000-8000-0000000000a1",
  catDrinks: "10000000-0000-4000-8000-0000000000a2",
  catEmpty: "10000000-0000-4000-8000-0000000000a3",
  grilled: "20000000-0000-4000-8000-0000000000b1",
  cola: "20000000-0000-4000-8000-0000000000b2",
  hidden: "20000000-0000-4000-8000-0000000000b3",
  soldOut: "20000000-0000-4000-8000-0000000000b4",
  groupBread: "30000000-0000-4000-8000-0000000000c1",
  groupExtras: "30000000-0000-4000-8000-0000000000c2",
  white: "40000000-0000-4000-8000-0000000000d1",
  brown: "40000000-0000-4000-8000-0000000000d2",
  cheese: "40000000-0000-4000-8000-0000000000d3",
  mayo: "40000000-0000-4000-8000-0000000000d4",
  jalapeno: "40000000-0000-4000-8000-0000000000d5",
  archivedOpt: "40000000-0000-4000-8000-0000000000d6",
};

export const settings: CafeSettings = {
  cafeName: "Sandwich Express",
  ordersEnabled: true,
  maxItemQuantity: 10,
  maxItemsPerOrder: 30,
};

export function rows(overrides: Partial<RawCatalogRows> = {}): RawCatalogRows {
  const item = (
    id: string,
    category_id: string,
    name: string,
    price_paise: number,
    extra: Partial<RawCatalogRows["items"][number]> = {},
  ): RawCatalogRows["items"][number] => ({
    id,
    category_id,
    name,
    description: null,
    ingredients: null,
    dietary_tags: [],
    price_paise,
    image_path: null,
    sort_order: 0,
    is_active: true,
    is_available: true,
    ...extra,
  });
  const option = (
    id: string,
    group_id: string,
    name: string,
    price_delta_paise: number,
    extra: Partial<RawCatalogRows["options"][number]> = {},
  ): RawCatalogRows["options"][number] => ({
    id,
    group_id,
    name,
    price_delta_paise,
    is_default: false,
    sort_order: 0,
    is_active: true,
    is_available: true,
    ...extra,
  });
  return {
    categories: [
      { id: ids.catDrinks, name: "Drinks", description: null, sort_order: 2, is_active: true },
      {
        id: ids.catSandwich,
        name: "Sandwiches",
        description: null,
        sort_order: 1,
        is_active: true,
      },
      { id: ids.catEmpty, name: "Empty", description: null, sort_order: 3, is_active: true },
    ],
    items: [
      item(ids.grilled, ids.catSandwich, "Grilled Sandwich", 14900, { dietary_tags: ["veg"] }),
      item(ids.cola, ids.catDrinks, "Cola", 4000),
      item(ids.hidden, ids.catSandwich, "Archived thing", 9900, { is_active: false }),
      item(ids.soldOut, ids.catDrinks, "Sold out shake", 12000, { is_available: false }),
    ],
    groups: [
      {
        id: ids.groupBread,
        name: "Bread",
        min_select: 1,
        max_select: 1,
        sort_order: 1,
        is_active: true,
      },
      {
        id: ids.groupExtras,
        name: "Extras",
        min_select: 0,
        max_select: 2,
        sort_order: 2,
        is_active: true,
      },
    ],
    options: [
      option(ids.white, ids.groupBread, "White", 0, { is_default: true, sort_order: 1 }),
      option(ids.brown, ids.groupBread, "Brown", 1000, { sort_order: 2 }),
      option(ids.cheese, ids.groupExtras, "Extra cheese", 2500, { sort_order: 1 }),
      option(ids.mayo, ids.groupExtras, "Mayo", 500, { sort_order: 2 }),
      option(ids.jalapeno, ids.groupExtras, "Jalapeño", 1500, {
        sort_order: 3,
        is_available: false,
      }),
      option(ids.archivedOpt, ids.groupExtras, "Archived", 100, { is_active: false }),
    ],
    links: [
      { item_id: ids.grilled, group_id: ids.groupBread, sort_order: 1 },
      { item_id: ids.grilled, group_id: ids.groupExtras, sort_order: 2 },
    ],
    ...overrides,
  };
}

export const catalog = () => buildCatalog(rows());
