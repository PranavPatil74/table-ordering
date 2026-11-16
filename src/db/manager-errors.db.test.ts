import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeDbError } from "@/lib/menu/errors";
import { PG, createTestDb, pgError, type Actor, type TestDb } from "@/test/db/db";
import { insertMenu, insertPaidOrder, insertStaff, insertTable } from "@/test/db/fixtures";

/**
 * Phase 3 manager operations against REAL PostgreSQL (plain Postgres plus the Supabase shim, not
 * PostgREST). Proves what Phase 3 relies on: a manager can run the admin writes, a counter cannot,
 * the database limits really exist, and `describeDbError` turns each real error into the right
 * friendly message without leaking constraint names.
 */

let db: TestDb;
let manager: Actor;
let counter: Actor;

const q = (actor: Actor, sql: string, params: unknown[] = []) =>
  db.query(actor, sql, params, { commit: true });

/** What PostgREST puts in the error: SQLSTATE in `code`, Postgres text in `message`. */
const friendly = async (
  promise: Promise<unknown>,
  subject: Parameters<typeof describeDbError>[1],
  action: "save" | "delete" = "save",
) => describeDbError(await pgError(promise), subject, action);

beforeAll(async () => {
  db = await createTestDb();
  manager = { role: "authenticated", userId: await insertStaff(db, "manager", "Manager") };
  counter = { role: "authenticated", userId: await insertStaff(db, "counter", "Counter") };
});
afterAll(async () => {
  await db.close();
});

describe("a manager can run every admin write", () => {
  it("creates, renames and deactivates a table; reactivates it", async () => {
    const created = await q(
      manager,
      "insert into public.cafe_tables (code, label, sort_order) values ('T91','Table 91',910) returning id",
    );
    const id = created.rows[0]!.id as string;
    expect(
      (
        await q(
          manager,
          "update public.cafe_tables set label='Window' where id=$1 returning label",
          [id],
        )
      ).rows[0]!.label,
    ).toBe("Window");
    expect(
      (
        await q(
          manager,
          "update public.cafe_tables set is_active=false where id=$1 returning is_active",
          [id],
        )
      ).rows[0]!.is_active,
    ).toBe(false);
    expect(
      (
        await q(
          manager,
          "update public.cafe_tables set is_active=true where id=$1 returning is_active",
          [id],
        )
      ).rows[0]!.is_active,
    ).toBe(true);
  });

  it("creates a category, item, modifier group, option and attaches the group", async () => {
    const cat = (
      await q(
        manager,
        "insert into public.menu_categories (slug,name,sort_order) values ('p3-cat','P3 Cat',900) returning id",
      )
    ).rows[0]!.id;
    const item = (
      await q(
        manager,
        "insert into public.menu_items (category_id,slug,name,price_paise,sort_order) values ($1,'p3-item','P3 Item',24950,10) returning id",
        [cat],
      )
    ).rows[0]!.id;
    const group = (
      await q(
        manager,
        "insert into public.modifier_groups (slug,name,min_select,max_select) values ('p3-group','P3 Group',0,2) returning id",
      )
    ).rows[0]!.id;
    await q(
      manager,
      "insert into public.modifier_options (group_id,name,price_delta_paise,sort_order) values ($1,'Extra cheese',2000,10)",
      [group],
    );
    await q(
      manager,
      "insert into public.menu_item_modifier_groups (item_id,group_id,sort_order) values ($1,$2,10)",
      [item, group],
    );
    const price = await q(
      manager,
      "update public.menu_items set price_paise=25000 where id=$1 returning price_paise",
      [item],
    );
    expect(price.rows[0]!.price_paise).toBe(25000);
    // a never-ordered item can be deleted
    await q(manager, "delete from public.menu_item_modifier_groups where item_id=$1", [item]);
    expect(
      (await q(manager, "delete from public.menu_items where id=$1 returning id", [item])).rowCount,
    ).toBe(1);
  });
});

describe("a counter cannot administer the menu or tables", () => {
  it("cannot insert a table or category, and the error maps to 'no permission'", async () => {
    const t = await friendly(
      q(counter, "insert into public.cafe_tables (code,label) values ('T92','x')"),
      "table",
    );
    expect(t).toMatchObject({
      kind: "forbidden",
      message: "You don't have permission to do that.",
    });
    const c = await friendly(
      q(counter, "insert into public.menu_categories (slug,name) values ('c-x','C X')"),
      "category",
    );
    expect(c.kind).toBe("forbidden");
  });

  it("cannot change a price, rename a table or delete an item", async () => {
    const menu = await insertMenu(db);
    const table = await insertTable(db, "T93", "Table 93");
    const price = await pgError(
      q(counter, "update public.menu_items set price_paise=1 where id=$1", [menu.item.id]),
    );
    expect(price.code).toBe(PG.insufficientPrivilege);
    // Row-level security hides the row from UPDATE/DELETE for a role that may not write it, so
    // these affect zero rows rather than raising: the data must be unchanged either way.
    await q(counter, "update public.cafe_tables set label='hacked' where id=$1", [table.id]).catch(
      () => undefined,
    );
    await q(counter, "delete from public.menu_items where id=$1", [menu.drink.id]).catch(
      () => undefined,
    );
    const after = await q(
      { role: "postgres" },
      "select (select label from public.cafe_tables where id=$1) as label, (select count(*)::int from public.menu_items where id=$2) as items",
      [table.id, menu.drink.id],
    );
    expect(after.rows[0]).toEqual({ label: "Table 93", items: 1 });
  });

  it("CAN toggle sold out (the one thing Phase 1 gives a counter)", async () => {
    const menu = await insertMenu(db);
    const res = await q(
      counter,
      "update public.menu_items set is_available=false where id=$1 returning is_available",
      [menu.item.id],
    );
    expect(res.rows[0]!.is_available).toBe(false);
  });
});

describe("real database errors map to friendly messages", () => {
  it("duplicate table code", async () => {
    await insertTable(db, "T94", "Table 94");
    const e = await friendly(
      q(manager, "insert into public.cafe_tables (code,label) values ('T94','Again')"),
      "table",
    );
    expect(e).toEqual({
      kind: "duplicate",
      message: "A table with this code already exists.",
      field: "code",
    });
  });

  it("invalid table code and label length", async () => {
    for (const sql of [
      "insert into public.cafe_tables (code,label) values ('t95','lower')",
      "insert into public.cafe_tables (code,label) values ('T','short')",
      "insert into public.cafe_tables (code,label) values ('T96','')",
      `insert into public.cafe_tables (code,label) values ('T97','${"x".repeat(41)}')`,
    ]) {
      expect((await friendly(q(manager, sql), "table")).kind, sql).toBe("invalid");
    }
  });

  it("duplicate category / group / option names, case-insensitively", async () => {
    await q(manager, "insert into public.menu_categories (slug,name) values ('dup-cat','Dup Cat')");
    const cat = await friendly(
      q(manager, "insert into public.menu_categories (slug,name) values ('dup-cat-2','dup cat')"),
      "category",
    );
    expect(cat).toMatchObject({ kind: "duplicate", field: "name" });

    const slug = await friendly(
      q(manager, "insert into public.menu_categories (slug,name) values ('dup-cat','Other')"),
      "category",
    );
    expect(slug).toMatchObject({ kind: "duplicate", field: "name" });

    const group = (
      await q(
        manager,
        "insert into public.modifier_groups (slug,name) values ('dup-g','Dup G') returning id",
      )
    ).rows[0]!.id;
    await q(manager, "insert into public.modifier_options (group_id,name) values ($1,'Large')", [
      group,
    ]);
    const option = await friendly(
      q(manager, "insert into public.modifier_options (group_id,name) values ($1,'LARGE')", [
        group,
      ]),
      "modifier option",
    );
    expect(option).toMatchObject({ kind: "duplicate", field: "name" });
  });

  it("price and option limits are enforced by the database", async () => {
    const menu = await insertMenu(db);
    for (const price of [-1, 10_000_001]) {
      const e = await friendly(
        q(manager, "update public.menu_items set price_paise=$2 where id=$1", [
          menu.item.id,
          price,
        ]),
        "item",
      );
      expect(e.kind, String(price)).toBe("invalid");
    }
    for (const delta of [-1, 1_000_001]) {
      const e = await friendly(
        q(
          manager,
          "insert into public.modifier_options (group_id,name,price_delta_paise) values ($1,$2,$3)",
          [menu.group.id, `bad${delta}`, delta],
        ),
        "modifier option",
      );
      expect(e.kind, String(delta)).toBe("invalid");
    }
    for (const [min, max] of [
      [3, 2],
      [0, 0],
      [0, 21],
    ]) {
      const e = await friendly(
        q(
          manager,
          "insert into public.modifier_groups (slug,name,min_select,max_select) values ($1,$2,$3,$4)",
          [`g${min}${max}`, `G ${min}${max}`, min, max],
        ),
        "modifier group",
      );
      expect(e.kind, `${min}-${max}`).toBe("invalid");
    }
  });

  it("an item that has been ordered cannot be deleted, and says to archive it", async () => {
    const paid = await insertPaidOrder(db);
    const e = await friendly(
      q(manager, "delete from public.menu_items where id=$1", [paid.menu.item.id]),
      "item",
      "delete",
    );
    expect(e.kind).toBe("in_use");
    expect(e.message).toMatch(/Archive it instead/);
    // ...but archiving it works, and the order keeps its history.
    const archived = await q(
      manager,
      "update public.menu_items set is_active=false where id=$1 returning is_active",
      [paid.menu.item.id],
    );
    expect(archived.rows[0]!.is_active).toBe(false);
  });

  it("a category with items cannot be deleted", async () => {
    const menu = await insertMenu(db);
    const e = await friendly(
      q(manager, "delete from public.menu_categories where id=$1", [menu.categoryId]),
      "category",
      "delete",
    );
    expect(e.kind).toBe("in_use");
  });

  it("never leaks constraint, table or column names", async () => {
    const samples = [
      await pgError(q(manager, "insert into public.cafe_tables (code,label) values ('T94','x')")),
      await pgError(q(manager, "insert into public.cafe_tables (code,label) values ('bad','x')")),
      await pgError(q(counter, "insert into public.cafe_tables (code,label) values ('T98','x')")),
    ];
    for (const sample of samples) {
      const shown = describeDbError(sample, "table").message;
      expect(shown).not.toMatch(/cafe_tables|constraint|violates|row-level|public\./i);
    }
  });
});
