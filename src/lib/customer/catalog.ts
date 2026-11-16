/**
 * The customer-visible menu as plain, JSON-serialisable data. Built from rows the anonymous role
 * can read (row-level security already hides archived rows; the filters here are a second
 * safety net, not the boundary). Pure: no database or network access.
 */
import type { DietaryTag } from "@/lib/menu/validation";

export interface CatalogOption {
  id: string;
  name: string;
  priceDeltaPaise: number;
  isDefault: boolean;
  isAvailable: boolean;
}

export interface CatalogGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: CatalogOption[];
}

export interface CatalogItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  dietaryTags: DietaryTag[];
  pricePaise: number;
  /** Supabase Storage path. Image upload is not built yet, so this is normally null. */
  imagePath: string | null;
  isAvailable: boolean;
  groups: CatalogGroup[];
}

export interface CatalogCategory {
  id: string;
  name: string;
  description: string | null;
  items: CatalogItem[];
}

export interface Catalog {
  categories: CatalogCategory[];
}

export interface CafeSettings {
  cafeName: string;
  ordersEnabled: boolean;
  maxItemQuantity: number;
  maxItemsPerOrder: number;
}

export interface RawCatalogRows {
  categories: {
    id: string;
    name: string;
    description: string | null;
    sort_order: number;
    is_active: boolean;
  }[];
  items: {
    id: string;
    category_id: string;
    name: string;
    description: string | null;
    ingredients: string | null;
    dietary_tags: string[] | null;
    price_paise: number;
    image_path: string | null;
    sort_order: number;
    is_active: boolean;
    is_available: boolean;
  }[];
  groups: {
    id: string;
    name: string;
    min_select: number;
    max_select: number;
    sort_order: number;
    is_active: boolean;
  }[];
  options: {
    id: string;
    group_id: string;
    name: string;
    price_delta_paise: number;
    is_default: boolean;
    sort_order: number;
    is_active: boolean;
    is_available: boolean;
  }[];
  links: { item_id: string; group_id: string; sort_order: number }[];
}

const bySort = <T extends { sort_order: number; name?: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || (a.name ?? "").localeCompare(b.name ?? "");

export function buildCatalog(rows: RawCatalogRows): Catalog {
  const optionsByGroup = new Map<string, CatalogOption[]>();
  for (const option of [...rows.options].sort(bySort)) {
    if (!option.is_active) continue;
    const list = optionsByGroup.get(option.group_id) ?? [];
    list.push({
      id: option.id,
      name: option.name,
      priceDeltaPaise: option.price_delta_paise,
      isDefault: option.is_default,
      isAvailable: option.is_available,
    });
    optionsByGroup.set(option.group_id, list);
  }

  const groupsById = new Map<string, CatalogGroup>();
  for (const group of rows.groups) {
    if (!group.is_active) continue;
    groupsById.set(group.id, {
      id: group.id,
      name: group.name,
      minSelect: group.min_select,
      maxSelect: group.max_select,
      options: optionsByGroup.get(group.id) ?? [],
    });
  }

  const groupsByItem = new Map<string, CatalogGroup[]>();
  for (const link of [...rows.links].sort((a, b) => a.sort_order - b.sort_order)) {
    const group = groupsById.get(link.group_id);
    if (!group) continue;
    const list = groupsByItem.get(link.item_id) ?? [];
    list.push(group);
    groupsByItem.set(link.item_id, list);
  }

  const itemsByCategory = new Map<string, CatalogItem[]>();
  for (const item of [...rows.items].sort(bySort)) {
    if (!item.is_active) continue;
    const list = itemsByCategory.get(item.category_id) ?? [];
    list.push({
      id: item.id,
      categoryId: item.category_id,
      name: item.name,
      description: item.description,
      ingredients: item.ingredients,
      dietaryTags: (item.dietary_tags ?? []) as DietaryTag[],
      pricePaise: item.price_paise,
      imagePath: item.image_path,
      isAvailable: item.is_available,
      groups: groupsByItem.get(item.id) ?? [],
    });
    itemsByCategory.set(item.category_id, list);
  }

  return {
    categories: [...rows.categories]
      .sort(bySort)
      .filter((category) => category.is_active)
      .map((category) => ({
        id: category.id,
        name: category.name,
        description: category.description,
        items: itemsByCategory.get(category.id) ?? [],
      }))
      .filter((category) => category.items.length > 0),
  };
}

export function findItem(catalog: Catalog, itemId: string): CatalogItem | undefined {
  for (const category of catalog.categories) {
    const found = category.items.find((item) => item.id === itemId);
    if (found) return found;
  }
  return undefined;
}
