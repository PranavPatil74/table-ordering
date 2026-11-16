import type { CleanupPort } from "../../../scripts/test-menu-cleanup/core.mjs";

import type { TestDb } from "./db";

/**
 * The same cleanup port as scripts/test-menu-cleanup/postgrest-port.mjs, but straight over SQL on
 * the plain-PostgreSQL test database, acting as `service_role` like the real tool does. It lets the
 * database tests drive the REAL planning/apply code against real triggers, foreign keys and the
 * real `finalize_paid_order` function. It is a test helper only.
 */
export function createSqlPort(db: TestDb): CleanupPort {
  const SERVICE = { role: "service_role" } as const;
  const read = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<R>(SERVICE, sql, params)).rows;
  const write = async (sql: string, params: unknown[]) => {
    const result = await db.query(SERVICE, sql, params, { commit: true });
    if (result.rowCount !== 1) throw new Error("expected exactly one row to change");
  };
  const iso = (value: unknown) => new Date(value as string | Date).toISOString();

  return {
    async listCategories() {
      const rows = await read<{
        id: string;
        slug: string;
        name: string;
        is_active: boolean;
        created_at: Date;
      }>(
        "select id, slug, name, is_active, created_at from public.menu_categories where slug like 'it-%' or name like 'IT %'",
      );
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        isActive: r.is_active,
        createdAt: iso(r.created_at),
      }));
    },
    async listItems(categoryIds) {
      const rows = await read<{
        id: string;
        category_id: string;
        slug: string;
        name: string;
        price_paise: number;
        is_active: boolean;
        is_available: boolean;
      }>(
        "select id, category_id, slug, name, price_paise, is_active, is_available from public.menu_items where category_id = any($1::uuid[])",
        [categoryIds],
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
      const rows = await read<{
        id: string;
        code: string;
        label: string;
        is_active: boolean;
        created_at: Date;
      }>(
        "select id, code, label, is_active, created_at from public.cafe_tables where code like 'IT%' or label like 'IT %'",
      );
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        label: r.label,
        isActive: r.is_active,
        createdAt: iso(r.created_at),
      }));
    },
    async listGroups() {
      const rows = await read<{ id: string; slug: string; name: string; created_at: Date }>(
        "select id, slug, name, created_at from public.modifier_groups where slug like 'it-%'",
      );
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        createdAt: iso(r.created_at),
      }));
    },
    async orderItemRefs(itemIds) {
      const rows = await read<{ menu_item_id: string; n: number }>(
        "select menu_item_id, count(*)::int as n from public.order_items where menu_item_id = any($1::uuid[]) group by 1",
        [itemIds],
      );
      return Object.fromEntries(rows.map((r) => [r.menu_item_id, r.n]));
    },
    async attemptRefs(itemIds) {
      const refs: Record<string, { pending: number; other: number }> = {};
      for (const id of itemIds) {
        const rows = await read<{ status: string; n: number }>(
          "select status::text as status, count(*)::int as n from public.payment_attempts where cart_snapshot @> $1::jsonb group by 1",
          [JSON.stringify({ items: [{ menu_item_id: id }] })],
        );
        if (rows.length === 0) continue;
        const pending = rows.filter((r) => r.status === "PENDING").reduce((s, r) => s + r.n, 0);
        const total = rows.reduce((s, r) => s + r.n, 0);
        refs[id] = { pending, other: total - pending };
      }
      return refs;
    },
    async tableOrderRefs(tableIds) {
      const rows = await read<{ table_id: string; n: number }>(
        "select table_id, count(*)::int as n from public.orders where table_id = any($1::uuid[]) group by 1",
        [tableIds],
      );
      return Object.fromEntries(rows.map((r) => [r.table_id, r.n]));
    },
    async tableAttemptRefs(tableIds) {
      const rows = await read<{ table_id: string; status: string; n: number }>(
        "select table_id, status::text as status, count(*)::int as n from public.payment_attempts where table_id = any($1::uuid[]) group by 1, 2",
        [tableIds],
      );
      const refs: Record<string, { pending: number; other: number }> = {};
      for (const r of rows) {
        const entry = (refs[r.table_id] ??= { pending: 0, other: 0 });
        if (r.status === "PENDING") entry.pending += r.n;
        else entry.other += r.n;
      }
      return refs;
    },
    async historyCounts() {
      const counts: Record<string, number> = {};
      for (const table of ["orders", "order_items", "payment_attempts", "order_events"]) {
        const rows = await read<{ n: number }>(`select count(*)::int as n from public.${table}`);
        counts[table] = rows[0]!.n;
      }
      return counts;
    },
    setItemActive: (id, active) =>
      write("update public.menu_items set is_active = $2 where id = $1", [id, active]),
    setCategoryActive: (id, active) =>
      write("update public.menu_categories set is_active = $2 where id = $1", [id, active]),
    setTableActive: (id, active) =>
      write("update public.cafe_tables set is_active = $2 where id = $1", [id, active]),
    deleteItem: (id) => write("delete from public.menu_items where id = $1", [id]),
    deleteCategory: (id) => write("delete from public.menu_categories where id = $1", [id]),
  };
}
