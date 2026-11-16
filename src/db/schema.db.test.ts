import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG, admin, createTestDb, pgError, type TestDb } from "@/test/db/db";
import { insertMenu, insertPaidOrder, insertTable } from "@/test/db/fixtures";

let db: TestDb;
let a: ReturnType<typeof admin>;
const POSTGRES = { role: "postgres" } as const;

beforeAll(async () => {
  db = await createTestDb();
  a = admin(db);
});
afterAll(async () => {
  await db.close();
});

describe("money is stored as integer paise", () => {
  it("has no floating-point, numeric or money-typed column anywhere in public", async () => {
    const rows = await a.all<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('real', 'double precision', 'numeric', 'money')`,
    );
    expect(rows).toEqual([]);
  });

  it("uses integer for every *_paise column", async () => {
    const rows = await a.all<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public' and column_name like '%paise%'
        order by 1, 2`,
    );
    // Exact list: adding a money column forces whoever adds it to confirm it is integer paise.
    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "menu_items.price_paise",
      "modifier_options.price_delta_paise",
      "order_items.line_total_paise",
      "order_items.options_unit_paise",
      "order_items.unit_price_paise",
      "orders.total_paise",
      "payment_attempts.amount_paise",
    ]);
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe("integer");
    }
  });

  it("rejects negative and absurd prices", async () => {
    const { categoryId } = await insertMenu(db);
    for (const price of [-1, 10_000_001]) {
      const error = await pgError(
        db.query(
          POSTGRES,
          `insert into public.menu_items (category_id, slug, name, price_paise)
           values ($1, 'bad-price', 'Bad', $2)`,
          [categoryId, price],
        ),
      );
      expect(error.code).toBe(PG.checkViolation);
    }
  });

  it("accepts a zero price (e.g. a free add-on) and the maximum price", async () => {
    const { categoryId } = await insertMenu(db);
    await a.exec(
      `insert into public.menu_items (category_id, slug, name, price_paise)
       values ($1, 'free-water', 'Water', 0), ($1, 'max-price', 'Feast', 10000000)`,
      [categoryId],
    );
  });

  it("refuses non-numeric text for a paise column", async () => {
    const { categoryId } = await insertMenu(db);
    const error = await pgError(
      db.query(
        POSTGRES,
        `insert into public.menu_items (category_id, slug, name, price_paise)
         values ($1, 'text-price', 'T', '149.5')`,
        [categoryId],
      ),
    );
    expect(error.code).toBe(PG.invalidTextRepresentation);
  });

  it("rejects negative modifier price deltas", async () => {
    const { group } = await insertMenu(db);
    const error = await pgError(
      db.query(
        POSTGRES,
        "insert into public.modifier_options (group_id, name, price_delta_paise) values ($1, 'Discount', -500)",
        [group.id],
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });
});

describe("unique constraints and formats", () => {
  it("rejects a duplicate table code", async () => {
    await insertTable(db, "U01", "Unique 1");
    const error = await pgError(insertTable(db, "U01", "Another"));
    expect(error.code).toBe(PG.uniqueViolation);
  });

  it.each(["t05", "T 5", "5T", "T", "T".repeat(17), "T05!", ""])(
    "rejects the malformed table code %j",
    async (code) => {
      const error = await pgError(
        db.query(POSTGRES, "insert into public.cafe_tables (code, label) values ($1, 'x')", [code]),
      );
      expect(error.code).toBe(PG.checkViolation);
    },
  );

  it.each(["T05", "WINDOW-2", "PATIO_1"])("accepts the table code %j", async (code) => {
    await a.exec("insert into public.cafe_tables (code, label) values ($1, 'ok')", [code]);
  });

  it("treats category and item names as case-insensitively unique", async () => {
    const menu = await insertMenu(db);
    const dupCategory = await pgError(
      db.query(
        POSTGRES,
        "insert into public.menu_categories (slug, name) values ('other-slug', $1)",
        [menu.categoryName.toUpperCase()],
      ),
    );
    expect(dupCategory.code).toBe(PG.uniqueViolation);

    const dupItem = await pgError(
      db.query(
        POSTGRES,
        `insert into public.menu_items (category_id, slug, name, price_paise)
         values ($1, 'dup-item-slug', 'GRILLED SANDWICH', 100)`,
        [menu.categoryId],
      ),
    );
    expect(dupItem.code).toBe(PG.uniqueViolation);
  });

  it("rejects slugs that are not lowercase-kebab", async () => {
    for (const slug of ["Has Caps", "under_score", "-leading", "trailing-", "double--dash", ""]) {
      const error = await pgError(
        db.query(POSTGRES, "insert into public.menu_categories (slug, name) values ($1, $2)", [
          slug,
          `Name ${slug}`,
        ]),
      );
      expect(error.code, slug).toBe(PG.checkViolation);
    }
  });

  it("allows the same option name in different groups but not twice in one group", async () => {
    const { group } = await insertMenu(db);
    const other = await a.one<{ id: string }>(
      "insert into public.modifier_groups (slug, name) values ('second-group', 'Second') returning id",
    );
    await a.exec("insert into public.modifier_options (group_id, name) values ($1, 'Mint mayo')", [
      other.id,
    ]);
    const error = await pgError(
      db.query(
        POSTGRES,
        "insert into public.modifier_options (group_id, name) values ($1, 'MINT MAYO')",
        [group.id],
      ),
    );
    expect(error.code).toBe(PG.uniqueViolation);
  });

  it("rejects unknown dietary tags and accepts known ones", async () => {
    const { categoryId } = await insertMenu(db);
    const bad = await pgError(
      db.query(
        POSTGRES,
        `insert into public.menu_items (category_id, slug, name, price_paise, dietary_tags)
         values ($1, 'bad-tag', 'Bad tag', 100, array['veg','keto'])`,
        [categoryId],
      ),
    );
    expect(bad.code).toBe(PG.checkViolation);
    await a.exec(
      `insert into public.menu_items (category_id, slug, name, price_paise, dietary_tags)
       values ($1, 'good-tag', 'Good tag', 100, array['veg','spicy','contains-dairy'])`,
      [categoryId],
    );
  });

  it("validates modifier group selection bounds", async () => {
    for (const [min, max] of [
      [2, 1],
      [0, 0],
      [-1, 1],
      [0, 21],
    ]) {
      const error = await pgError(
        db.query(
          POSTGRES,
          "insert into public.modifier_groups (slug, name, min_select, max_select) values ($1, $1, $2, $3)",
          [`g-${min}-${max}`.replace("-", "n"), min, max],
        ),
      );
      expect(error.code, `${min}/${max}`).toBe(PG.checkViolation);
    }
    await a.exec(
      "insert into public.modifier_groups (slug, name, min_select, max_select) values ('required-one', 'Required one', 1, 1)",
    );
  });
});

describe("referential integrity", () => {
  it("rejects an item in a non-existent category", async () => {
    const error = await pgError(
      db.query(
        POSTGRES,
        `insert into public.menu_items (category_id, slug, name, price_paise)
         values (gen_random_uuid(), 'orphan', 'Orphan', 100)`,
      ),
    );
    expect(error.code).toBe(PG.foreignKeyViolation);
  });

  it("refuses to delete a category that still has items", async () => {
    const { categoryId } = await insertMenu(db);
    const error = await pgError(
      db.query(POSTGRES, "delete from public.menu_categories where id = $1", [categoryId]),
    );
    expect(error.code).toBe(PG.foreignKeyViolation);
  });

  it("cascades option deletion with its group but keeps groups attached to items", async () => {
    const { group, item } = await insertMenu(db);
    const detach = await pgError(
      db.query(POSTGRES, "delete from public.modifier_groups where id = $1", [group.id]),
    );
    expect(detach.code).toBe(PG.foreignKeyViolation); // still attached to an item (RESTRICT)

    await a.exec("delete from public.menu_item_modifier_groups where item_id = $1", [item.id]);
    await a.exec("delete from public.modifier_groups where id = $1", [group.id]);
    const left = await a.all("select 1 from public.modifier_options where group_id = $1", [
      group.id,
    ]);
    expect(left).toHaveLength(0);
  });

  it("protects tables and menu items that appear in orders from deletion", async () => {
    const { table, menu } = await insertPaidOrder(db);
    const tableDelete = await pgError(
      db.query(POSTGRES, "delete from public.cafe_tables where id = $1", [table.id]),
    );
    expect(tableDelete.code).toBe(PG.foreignKeyViolation);

    const itemDelete = await pgError(
      db.query(POSTGRES, "delete from public.menu_items where id = $1", [menu.item.id]),
    );
    expect(itemDelete.code).toBe(PG.foreignKeyViolation);
  });

  it("indexes every foreign key column (so deletes and joins do not scan)", async () => {
    const rows = await a.all<{ table_name: string; constraint_name: string }>(
      `select c.conrelid::regclass::text as table_name, c.conname as constraint_name
         from pg_constraint c
        where c.contype = 'f'
          and c.connamespace = 'public'::regnamespace
          and not exists (
            select 1 from pg_index i
             where i.indrelid = c.conrelid
               and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
          )`,
    );
    // staff_profiles.user_id is the primary key itself, so it is covered by the PK index.
    expect(rows).toEqual([]);
  });
});

describe("cafe settings", () => {
  it("has exactly one default row after migration", async () => {
    const rows = await a.all<Record<string, unknown>>("select * from public.cafe_settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 1,
      cafe_name: "Sandwich Express",
      currency: "INR",
      timezone: "Asia/Kolkata",
      order_number_prefix: "SE",
      orders_enabled: true,
    });
  });

  it("cannot hold a second row", async () => {
    const error = await pgError(
      db.query(POSTGRES, "insert into public.cafe_settings (id) values (2)"),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("rejects an invalid time zone, prefix and currency", async () => {
    for (const [column, value] of [
      ["timezone", "Not/AZone"],
      ["order_number_prefix", "se"],
      ["order_number_prefix", "TOOLONG"],
      ["currency", "USD"],
    ] as const) {
      const error = await pgError(
        db.query(POSTGRES, `update public.cafe_settings set ${column} = $1`, [value]),
      );
      expect(error.code, `${column}=${value}`).toBeDefined();
    }
  });
});

describe("timestamps", () => {
  it("bumps updated_at when a row changes", async () => {
    const { item } = await insertMenu(db);
    const before = await a.one<{ updated_at: Date }>(
      "select updated_at from public.menu_items where id = $1",
      [item.id],
    );
    await a.exec("select pg_sleep(0.05)");
    await a.exec("update public.menu_items set price_paise = 15900 where id = $1", [item.id]);
    const after = await a.one<{ updated_at: Date }>(
      "select updated_at from public.menu_items where id = $1",
      [item.id],
    );
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});
