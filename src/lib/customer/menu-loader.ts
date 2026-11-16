import "server-only";

import { createPublicSupabaseClient } from "@/lib/supabase/public";

import { buildCatalog, type CafeSettings, type Catalog, type RawCatalogRows } from "./catalog";

export type MenuLoad =
  { ok: true; catalog: Catalog; settings: CafeSettings } | { ok: false; message: string };

/**
 * Loads the live menu and ordering limits as the anonymous role. Archived rows never arrive
 * (row-level security); sold-out ones do, flagged, so the page can say "Sold out" instead of
 * silently hiding them. Named columns only: the anonymous role has column-level grants.
 */
export async function loadMenu(): Promise<MenuLoad> {
  try {
    const db = createPublicSupabaseClient();
    const [settings, categories, items, groups, options, links] = await Promise.all([
      db
        .from("cafe_settings")
        .select("cafe_name, orders_enabled, max_item_quantity, max_items_per_order")
        .limit(1)
        .maybeSingle(),
      db.from("menu_categories").select("id, name, description, sort_order, is_active"),
      db
        .from("menu_items")
        .select(
          "id, category_id, name, description, ingredients, dietary_tags, price_paise, image_path, sort_order, is_active, is_available",
        ),
      db.from("modifier_groups").select("id, name, min_select, max_select, sort_order, is_active"),
      db
        .from("modifier_options")
        .select(
          "id, group_id, name, price_delta_paise, is_default, sort_order, is_active, is_available",
        ),
      db.from("menu_item_modifier_groups").select("item_id, group_id, sort_order"),
    ]);

    const failed = [settings, categories, items, groups, options, links].find((r) => r.error);
    if (failed || !settings.data) {
      return { ok: false, message: "The menu couldn't be loaded." };
    }

    const raw: RawCatalogRows = {
      categories: categories.data ?? [],
      items: items.data ?? [],
      groups: groups.data ?? [],
      options: options.data ?? [],
      links: links.data ?? [],
    };
    return {
      ok: true,
      catalog: buildCatalog(raw),
      settings: {
        cafeName: settings.data.cafe_name as string,
        ordersEnabled: settings.data.orders_enabled as boolean,
        maxItemQuantity: settings.data.max_item_quantity as number,
        maxItemsPerOrder: settings.data.max_items_per_order as number,
      },
    };
  } catch {
    return { ok: false, message: "The menu couldn't be loaded." };
  }
}
