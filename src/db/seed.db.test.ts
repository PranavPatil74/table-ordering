import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG, admin, createTestDb, pgError, type TestDb } from "@/test/db/db";

const SEED_SQL = readFileSync(path.resolve(process.cwd(), "supabase/seed.sql"), "utf8");

let db: TestDb;
let a: ReturnType<typeof admin>;

const SEEDED_TABLES = [
  "cafe_tables",
  "menu_categories",
  "menu_items",
  "modifier_groups",
  "modifier_options",
  "menu_item_modifier_groups",
] as const;

async function counts() {
  const result: Record<string, number> = {};
  for (const table of SEEDED_TABLES) {
    result[table] = (
      await a.one<{ n: number }>(`select count(*)::int as n from public.${table}`)
    ).n;
  }
  return result;
}

/** A stable fingerprint of all seeded content, to prove a re-run changes nothing. */
async function fingerprint() {
  const row = await a.one<{ h: string }>(
    `select md5(concat_ws('|',
       (select string_agg(concat_ws(',', slug, name, sort_order, is_active), ';' order by slug) from public.menu_categories),
       (select string_agg(concat_ws(',', slug, name, price_paise, is_available, array_to_string(dietary_tags, '/')), ';' order by slug) from public.menu_items),
       (select string_agg(concat_ws(',', slug, name, min_select, max_select), ';' order by slug) from public.modifier_groups),
       (select string_agg(concat_ws(',', g.slug, o.name, o.price_delta_paise, o.is_default), ';' order by g.slug, o.name)
          from public.modifier_options o join public.modifier_groups g on g.id = o.group_id),
       (select string_agg(code || ',' || label, ';' order by code) from public.cafe_tables)
     )) as h`,
  );
  return row.h;
}

beforeAll(async () => {
  db = await createTestDb();
  a = admin(db);
});
afterAll(async () => {
  await db.close();
});

describe("seed.sql", () => {
  it("applies to a freshly migrated database", async () => {
    expect(await counts()).toEqual({
      cafe_tables: 0,
      menu_categories: 0,
      menu_items: 0,
      modifier_groups: 0,
      modifier_options: 0,
      menu_item_modifier_groups: 0,
    });
    await a.exec(SEED_SQL);
    const after = await counts();
    expect(after.cafe_tables).toBe(5);
    expect(after.menu_categories).toBe(5);
    expect(after.menu_items).toBe(16);
    expect(after.modifier_groups).toBe(6);
    expect(after.modifier_options).toBe(19);
    expect(after.menu_item_modifier_groups).toBe(30);
    // Exactly one sample "sold out" item, so the sold-out display can be seen in development.
    const soldOut = await a.all<{ slug: string }>(
      "select slug from public.menu_items where not is_available",
    );
    expect(soldOut.map((r) => r.slug)).toEqual(["garlic-bread"]);
  });

  it("is repeatable: running it again changes no counts and no content", async () => {
    const before = { counts: await counts(), fingerprint: await fingerprint() };
    await a.exec(SEED_SQL);
    await a.exec(SEED_SQL);
    expect(await counts()).toEqual(before.counts);
    expect(await fingerprint()).toBe(before.fingerprint);
  });

  it("never overwrites edits a manager made after seeding", async () => {
    await a.exec(
      `update public.menu_items set price_paise = 15500, is_available = false, name = 'Veg Grilled Sandwich (large)'
        where slug = 'veg-grilled-sandwich'`,
    );
    await a.exec(
      "update public.cafe_tables set is_active = false, label = 'Window' where code = 'T02'",
    );
    await a.exec(
      "update public.modifier_options set price_delta_paise = 4000 where name = 'Extra cheese'",
    );
    await a.exec("update public.menu_items set is_available = true where slug = 'garlic-bread'");

    await a.exec(SEED_SQL);

    expect(
      await a.one(
        "select name, price_paise, is_available from public.menu_items where slug = 'veg-grilled-sandwich'",
      ),
    ).toEqual({ name: "Veg Grilled Sandwich (large)", price_paise: 15500, is_available: false });
    expect(
      await a.one("select label, is_active from public.cafe_tables where code = 'T02'"),
    ).toEqual({
      label: "Window",
      is_active: false,
    });
    expect(
      (
        await a.one<{ price_delta_paise: number }>(
          "select price_delta_paise from public.modifier_options where name = 'Extra cheese'",
        )
      ).price_delta_paise,
    ).toBe(4000);
    expect(
      (
        await a.one<{ is_available: boolean }>(
          "select is_available from public.menu_items where slug = 'garlic-bread'",
        )
      ).is_available,
    ).toBe(true);
    expect((await counts()).menu_items).toBe(16);
  });

  it("contains the required categories, in order", async () => {
    const rows = await a.all<{ name: string }>(
      "select name from public.menu_categories order by sort_order",
    );
    expect(rows.map((r) => r.name)).toEqual([
      "Classic Sandwiches",
      "Signature Sandwiches",
      "Sides",
      "Drinks",
      "Extras",
    ]);
  });

  it("contains the named items with their categories and sample prices", async () => {
    // Looked up by slug, the stable key: an earlier test renames one item as a manager would.
    const rows = await a.all<{ slug: string; category: string }>(
      `select i.slug, c.name as category
         from public.menu_items i join public.menu_categories c on c.id = i.category_id`,
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r.category]));
    for (const [slug, category] of [
      ["veg-grilled-sandwich", "Classic Sandwiches"],
      ["cheese-corn-sandwich", "Classic Sandwiches"],
      ["peri-peri-paneer-sandwich", "Signature Sandwiches"],
      ["french-fries", "Sides"],
      ["cold-coffee", "Drinks"],
    ] as const) {
      expect(bySlug.get(slug), slug).toBe(category);
    }
    // Every category has at least one item.
    const empty = await a.all(
      "select c.name from public.menu_categories c where not exists (select 1 from public.menu_items i where i.category_id = c.id)",
    );
    expect(empty).toEqual([]);
  });

  it("uses integer paise, includes a sold-out sample, and has no images or secrets", async () => {
    const rows = await a.all<{ price_paise: number; image_path: string | null }>(
      "select price_paise, image_path from public.menu_items",
    );
    for (const row of rows) {
      expect(Number.isInteger(row.price_paise)).toBe(true);
      expect(row.image_path).toBeNull();
    }
    expect(SEED_SQL).not.toMatch(/(secret|password|api[_-]?key|rzp_|service_role_key|eyJ)/i);
    expect(SEED_SQL).not.toMatch(/auth\.users|staff_profiles/i);
  });

  it("creates tables T01 to T05 with valid unique QR codes", async () => {
    const rows = await a.all<{ code: string; label: string; is_active: boolean }>(
      "select code, label, is_active from public.cafe_tables order by code",
    );
    expect(rows.map((r) => r.code)).toEqual(["T01", "T02", "T03", "T04", "T05"]);
    for (const row of rows) expect(row.code).toMatch(/^[A-Z][A-Z0-9_-]{1,15}$/);
    expect(new Set(rows.map((r) => r.code)).size).toBe(5);
  });

  it("sets up required and optional modifier groups consistently", async () => {
    const groups = await a.all<{
      slug: string;
      min_select: number;
      max_select: number;
      options: number;
      defaults: number;
    }>(
      `select g.slug, g.min_select, g.max_select, count(o.id)::int as options,
              count(o.id) filter (where o.is_default)::int as defaults
         from public.modifier_groups g left join public.modifier_options o on o.group_id = g.id
        group by g.id order by g.slug`,
    );
    for (const g of groups) {
      expect(g.options, g.slug).toBeGreaterThanOrEqual(g.max_select); // a required group is satisfiable
      if (g.min_select >= 1 && g.max_select === 1) expect(g.defaults, g.slug).toBe(1); // exactly one default
    }
    const spice = groups.find((g) => g.slug === "spice-level");
    expect(spice).toMatchObject({ min_select: 1, max_select: 1 });
    const sauces = groups.find((g) => g.slug === "sauces");
    expect(sauces).toMatchObject({ min_select: 0, max_select: 2 });
    // Every group is attached to at least one item.
    const unattached = await a.all(
      "select g.slug from public.modifier_groups g where not exists (select 1 from public.menu_item_modifier_groups m where m.group_id = g.id)",
    );
    expect(unattached).toEqual([]);
  });

  it("is visible to customers through anonymous access, with sold-out items marked", async () => {
    await a.exec("update public.menu_items set is_available = false where slug = 'garlic-bread'");
    const result = await db.query(
      { role: "anon" },
      `select i.name, i.is_available from public.menu_items i
         join public.menu_categories c on c.id = i.category_id where c.is_active order by i.name`,
    );
    expect(result.rows).toHaveLength(16);
    expect(result.rows.find((r) => r.name === "Garlic Bread")?.is_available).toBe(false);
    const tables = await pgError(db.query({ role: "anon" }, "select code from public.cafe_tables"));
    expect(tables.code).toBe(PG.insufficientPrivilege);
  });
});
