// @ts-check
/**
 * The cleanup port for a LOCAL Supabase stack, over PostgREST with the service-role key (the same
 * credentials `pnpm test:supabase` uses; the key is read from the environment and never printed).
 * Reads touch only the menu tables and read-only counts of the history tables. Writes are limited
 * to `is_active` on menu_items/menu_categories/cafe_tables and DELETE of one menu item or category
 * by id (tables are never deleted); the database's own guards (the ordered-item RESTRICT, the
 * unpaid-checkout trigger) still apply.
 */
import { createClient } from "@supabase/supabase-js";

const CHUNK = 100;
const PAGE = 1000;

async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

function ok(result, what) {
  if (result.error) {
    const error = new Error(`${what} failed: ${result.error.message}`);
    /** @type {any} */ (error).code = result.error.code;
    throw error;
  }
  return result.data ?? [];
}

export function createPostgrestPort(url, serviceKey) {
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  /** Reads every page of a query built by `make(from, to)`. */
  async function readAll(make, what) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const page = ok(await make(from, from + PAGE - 1), what);
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  return {
    async listCategories() {
      const select = "id, slug, name, is_active, created_at";
      // Two narrow reads (slug prefix, name prefix) so look-alikes can be REPORTED; the plan,
      // not this filter, decides what may be touched.
      const bySlug = await readAll(
        (a, b) => db.from("menu_categories").select(select).like("slug", "it-%").range(a, b),
        "read categories",
      );
      const byName = await readAll(
        (a, b) => db.from("menu_categories").select(select).like("name", "IT %").range(a, b),
        "read categories",
      );
      const seen = new Map();
      for (const row of [...bySlug, ...byName]) seen.set(row.id, row);
      return [...seen.values()].map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        isActive: r.is_active,
        createdAt: r.created_at,
      }));
    },
    async listItems(categoryIds) {
      const rows = await chunked(categoryIds, async (ids) =>
        readAll(
          (a, b) =>
            db
              .from("menu_items")
              .select("id, category_id, slug, name, price_paise, is_active, is_available")
              .in("category_id", ids)
              .range(a, b),
          "read items",
        ),
      );
      return rows.map((r) => ({
        id: r.id,
        categoryId: r.category_id,
        slug: r.slug,
        name: r.name,
        pricePaise: r.price_paise,
        isActive: r.is_active,
        isAvailable: r.is_available,
      }));
    },
    async listTables() {
      const select = "id, code, label, is_active, created_at";
      // Two narrow reads (code prefix, label prefix) so look-alikes can be REPORTED; the plan,
      // not these filters, decides what may be touched.
      const byCode = await readAll(
        (a, b) => db.from("cafe_tables").select(select).like("code", "IT%").range(a, b),
        "read tables",
      );
      const byLabel = await readAll(
        (a, b) => db.from("cafe_tables").select(select).like("label", "IT %").range(a, b),
        "read tables",
      );
      const seen = new Map();
      for (const row of [...byCode, ...byLabel]) seen.set(row.id, row);
      return [...seen.values()].map((r) => ({
        id: r.id,
        code: r.code,
        label: r.label,
        isActive: r.is_active,
        createdAt: r.created_at,
      }));
    },
    async listGroups() {
      const rows = await readAll(
        (a, b) =>
          db
            .from("modifier_groups")
            .select("id, slug, name, created_at")
            .like("slug", "it-%")
            .range(a, b),
        "read modifier groups",
      );
      return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, createdAt: r.created_at }));
    },
    async orderItemRefs(itemIds) {
      const rows = await chunked(itemIds, async (ids) =>
        readAll(
          (a, b) =>
            db.from("order_items").select("id, menu_item_id").in("menu_item_id", ids).range(a, b),
          "read order history",
        ),
      );
      /** @type {Record<string, number>} */
      const counts = {};
      for (const row of rows) counts[row.menu_item_id] = (counts[row.menu_item_id] ?? 0) + 1;
      return counts;
    },
    async attemptRefs(itemIds) {
      /** @type {Record<string, { pending: number, other: number }>} */
      const refs = {};
      for (const id of itemIds) {
        // jsonb containment: attempts whose snapshot lists this menu item. Status only; the
        // snapshot itself (which can hold a customer's name or note) is never selected.
        const rows = await readAll(
          (a, b) =>
            db
              .from("payment_attempts")
              .select("id, status")
              .contains("cart_snapshot", { items: [{ menu_item_id: id }] })
              .range(a, b),
          "read payment attempts",
        );
        if (rows.length === 0) continue;
        const pending = rows.filter((r) => r.status === "PENDING").length;
        refs[id] = { pending, other: rows.length - pending };
      }
      return refs;
    },
    async tableOrderRefs(tableIds) {
      const rows = await chunked(tableIds, async (ids) =>
        readAll(
          (a, b) => db.from("orders").select("id, table_id").in("table_id", ids).range(a, b),
          "read order history",
        ),
      );
      /** @type {Record<string, number>} */
      const counts = {};
      for (const row of rows) counts[row.table_id] = (counts[row.table_id] ?? 0) + 1;
      return counts;
    },
    async tableAttemptRefs(tableIds) {
      const rows = await chunked(tableIds, async (ids) =>
        readAll(
          // Status and table only: the snapshot (which can hold a customer's name) is never read.
          (a, b) =>
            db
              .from("payment_attempts")
              .select("id, table_id, status")
              .in("table_id", ids)
              .range(a, b),
          "read payment attempts",
        ),
      );
      /** @type {Record<string, { pending: number, other: number }>} */
      const refs = {};
      for (const row of rows) {
        const entry = (refs[row.table_id] ??= { pending: 0, other: 0 });
        if (row.status === "PENDING") entry.pending += 1;
        else entry.other += 1;
      }
      return refs;
    },
    async historyCounts() {
      /** @type {Record<string, number>} */
      const counts = {};
      for (const table of ["orders", "order_items", "payment_attempts", "order_events"]) {
        const result = await db.from(table).select("id", { count: "exact", head: true });
        if (result.error) throw new Error(`count ${table} failed: ${result.error.message}`);
        counts[table] = result.count ?? 0;
      }
      return counts;
    },
    async setItemActive(id, active) {
      const rows = ok(
        await db.from("menu_items").update({ is_active: active }).eq("id", id).select("id"),
        "archive item",
      );
      if (rows.length !== 1) throw new Error("archive item changed no row");
    },
    async setCategoryActive(id, active) {
      const rows = ok(
        await db.from("menu_categories").update({ is_active: active }).eq("id", id).select("id"),
        "archive category",
      );
      if (rows.length !== 1) throw new Error("archive category changed no row");
    },
    async setTableActive(id, active) {
      const rows = ok(
        await db.from("cafe_tables").update({ is_active: active }).eq("id", id).select("id"),
        "deactivate table",
      );
      if (rows.length !== 1) throw new Error("deactivate table changed no row");
    },
    async deleteItem(id) {
      ok(await db.from("menu_items").delete().eq("id", id), "delete item");
    },
    async deleteCategory(id) {
      ok(await db.from("menu_categories").delete().eq("id", id), "delete category");
    },
  };
}
