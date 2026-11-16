import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addLine } from "@/lib/customer/cart";
import { buildCatalog, findItem, type RawCatalogRows } from "@/lib/customer/catalog";
import { priceCart } from "@/lib/customer/pricing";
import { buildOrderSnapshot } from "@/lib/customer/snapshot";
import { PG, createTestDb, pgError, type Actor, type TestDb } from "@/test/db/db";
import { insertMenu, insertStaff, insertTable, type MenuFixture } from "@/test/db/fixtures";

/**
 * Phase 4 against REAL PostgreSQL (plain Postgres 16 + the Supabase shim, NOT PostgREST): what the
 * customer menu is allowed to read as the anonymous role, that cafe_tables is not one of those
 * things, and that the cart snapshot the checkout builds is accepted by the database's own
 * `cart_snapshot_problem` check (and a tampered one is not). Also the staff-management rules the
 * database enforces for the manager screen.
 */

let db: TestDb;
let menu: MenuFixture;
let table: { id: string; code: string; label: string };
const anon: Actor = { role: "anon" };
const service: Actor = { role: "service_role" };

const q = (actor: Actor, sql: string, params: unknown[] = [], commit = false) =>
  db.query(actor, sql, params, { commit });

/** The EXACT column lists src/lib/customer/menu-loader.ts selects. */
async function loadRaw(): Promise<RawCatalogRows> {
  const [categories, items, groups, options, links] = await Promise.all([
    q(anon, "select id, name, description, sort_order, is_active from public.menu_categories"),
    q(
      anon,
      `select id, category_id, name, description, ingredients, dietary_tags, price_paise, image_path,
              sort_order, is_active, is_available from public.menu_items`,
    ),
    q(
      anon,
      "select id, name, min_select, max_select, sort_order, is_active from public.modifier_groups",
    ),
    q(
      anon,
      `select id, group_id, name, price_delta_paise, is_default, sort_order, is_active, is_available
         from public.modifier_options`,
    ),
    q(anon, "select item_id, group_id, sort_order from public.menu_item_modifier_groups"),
  ]);
  return {
    categories: categories.rows,
    items: items.rows,
    groups: groups.rows,
    options: options.rows,
    links: links.rows,
  } as unknown as RawCatalogRows;
}

beforeAll(async () => {
  db = await createTestDb();
  menu = await insertMenu(db);
  table = await insertTable(db, "T41", "Table 41");
});
afterAll(async () => {
  await db.close();
});

describe("what the customer menu may read (anonymous role)", () => {
  it("reads the settings columns the loader selects", async () => {
    const r = await q(
      anon,
      "select cafe_name, orders_enabled, max_item_quantity, max_items_per_order from public.cafe_settings limit 1",
    );
    expect(r.rows[0]).toMatchObject({
      orders_enabled: true,
      max_item_quantity: 10,
      max_items_per_order: 30,
    });
  });

  it("sees the fixture menu and nothing archived", async () => {
    const admin = { role: "postgres" } as const;
    await q(
      admin,
      "update public.menu_items set is_active=false where id=$1",
      [menu.drink.id],
      true,
    );
    const catalog = buildCatalog(await loadRaw());
    expect(findItem(catalog, menu.item.id)?.name).toBe("Grilled Sandwich");
    expect(findItem(catalog, menu.drink.id)).toBeUndefined();
    await q(
      admin,
      "update public.menu_items set is_active=true where id=$1",
      [menu.drink.id],
      true,
    );
  });

  it("flags a sold-out item and a sold-out option instead of hiding them", async () => {
    const admin = { role: "postgres" } as const;
    await q(
      admin,
      "update public.menu_items set is_available=false where id=$1",
      [menu.drink.id],
      true,
    );
    await q(
      admin,
      "update public.modifier_options set is_available=false where id=$1",
      [menu.optionMayo.id],
      true,
    );
    const catalog = buildCatalog(await loadRaw());
    expect(findItem(catalog, menu.drink.id)?.isAvailable).toBe(false);
    const group = findItem(catalog, menu.item.id)!.groups[0]!;
    expect(group.options.find((o) => o.id === menu.optionMayo.id)?.isAvailable).toBe(false);
    await q(
      admin,
      "update public.menu_items set is_available=true where id=$1",
      [menu.drink.id],
      true,
    );
    await q(
      admin,
      "update public.modifier_options set is_available=true where id=$1",
      [menu.optionMayo.id],
      true,
    );
  });

  it("cannot read cafe_tables at all: table lookup must go through the service role", async () => {
    const error = await pgError(q(anon, "select id, code from public.cafe_tables"));
    expect(error.code).toBe(PG.insufficientPrivilege);
  });

  it("cannot write anything the customer area could be tempted to", async () => {
    for (const sql of [
      "insert into public.menu_items (category_id, slug, name, price_paise) values (gen_random_uuid(),'x','x',1)",
      "update public.menu_items set price_paise = 1",
      "update public.cafe_settings set orders_enabled = false",
      "select * from public.payment_attempts",
      "select * from public.orders",
    ]) {
      expect((await pgError(q(anon, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("the service role can look a table up by code (what the resolver does)", async () => {
    const r = await q(
      service,
      "select id, code, label, is_active from public.cafe_tables where code = $1",
      ["T41"],
    );
    expect(r.rows[0]).toMatchObject({ id: table.id, label: "Table 41", is_active: true });
    expect((await q(service, "select * from public.cafe_tables where code = 'T00'")).rowCount).toBe(
      0,
    );
  });

  it("the rate limiter allows up to the limit, then refuses", async () => {
    const bucket = `test-table-lookup:${Math.random()}`;
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(
        (await q(service, "select public.check_rate_limit($1, 3, 60) as ok", [bucket], true))
          .rows[0]!.ok,
      );
    }
    expect(results).toEqual([true, true, true, false]);
    expect((await pgError(q(anon, "select public.check_rate_limit('x', 1, 60)"))).code).toBe(
      PG.insufficientPrivilege,
    );
  });
});

describe("the checkout snapshot against the database's own validation", () => {
  async function snapshotFor(quantity: number, options: string[]) {
    const catalog = buildCatalog(await loadRaw());
    const settings = {
      cafeName: "x",
      ordersEnabled: true,
      maxItemQuantity: 10,
      maxItemsPerOrder: 30,
    };
    const cart = addLine([], { menuItemId: menu.item.id, optionIds: options, quantity }, settings);
    if (!cart.ok) throw new Error(cart.message);
    const pricing = priceCart(catalog, settings, cart.lines);
    expect(pricing.canCheckout).toBe(true);
    return buildOrderSnapshot(table, pricing, {
      customerName: "Asha",
      specialInstructions: "Extra napkins",
    });
  }
  const problem = async (snapshot: unknown, amount: number) =>
    (
      await q(service, "select private.cart_snapshot_problem($1::jsonb, $2) as p", [
        JSON.stringify(snapshot),
        amount,
      ])
    ).rows[0]!.p;

  it("is accepted for a plain item", async () => {
    const s = await snapshotFor(2, []);
    expect(s.total_paise).toBe(29800);
    expect(await problem(s, s.total_paise)).toBeNull();
  });
  it("is accepted with modifiers, and the totals agree to the paisa", async () => {
    const s = await snapshotFor(3, [menu.optionCheese.id, menu.optionMayo.id]);
    expect(s.total_paise).toBe((14900 + 3000) * 3);
    expect(await problem(s, s.total_paise)).toBeNull();
  });
  it("is rejected if the total or the amount is tampered with", async () => {
    const s = await snapshotFor(1, []);
    expect(await problem({ ...s, total_paise: s.total_paise - 1 }, s.total_paise - 1)).toMatch(
      /total_paise/,
    );
    expect(await problem(s, s.total_paise + 100)).toMatch(/payment amount/);
  });
});

describe("staff management rules enforced by the database", () => {
  let manager: Actor;
  let otherManager: string;
  let counterId: string;
  let counter: Actor;

  beforeAll(async () => {
    const managerId = await insertStaff(db, "manager", "Manager One");
    manager = { role: "authenticated", userId: managerId };
    otherManager = await insertStaff(db, "manager", "Manager Two");
    counterId = await insertStaff(db, "counter", "Counter One");
    counter = { role: "authenticated", userId: counterId };
  });

  it("a manager lists every profile; a counter sees only their own row", async () => {
    const all = await q(
      manager,
      "select user_id, display_name, role, is_active, created_at from public.staff_profiles",
    );
    expect(all.rowCount).toBeGreaterThanOrEqual(3);
    expect((await q(counter, "select user_id from public.staff_profiles")).rows).toEqual([
      { user_id: counterId },
    ]);
  });

  it("a manager deactivates and reactivates a counter, and only is_active is needed", async () => {
    const off = await q(
      manager,
      "update public.staff_profiles set is_active=false where user_id=$1 returning is_active",
      [counterId],
      true,
    );
    expect(off.rows[0]!.is_active).toBe(false);
    const on = await q(
      manager,
      "update public.staff_profiles set is_active=true where user_id=$1 and is_active=false returning is_active",
      [counterId],
      true,
    );
    expect(on.rows[0]!.is_active).toBe(true);
  });

  it("the conditional update used by the app changes nothing when the state already moved on", async () => {
    await q(
      manager,
      "update public.staff_profiles set is_active=false where user_id=$1",
      [counterId],
      true,
    );
    const stale = await q(
      manager,
      "update public.staff_profiles set is_active=false where user_id=$1 and is_active=true returning user_id",
      [counterId],
      true,
    );
    expect(stale.rowCount).toBe(0);
    await q(
      manager,
      "update public.staff_profiles set is_active=true where user_id=$1",
      [counterId],
      true,
    );
  });

  it("a counter cannot deactivate anyone, including themselves or a manager", async () => {
    for (const target of [counterId, otherManager]) {
      const r = await q(
        counter,
        "update public.staff_profiles set is_active=false where user_id=$1 returning user_id",
        [target],
      );
      expect(r.rowCount, target).toBe(0);
    }
    const state = await q(
      { role: "postgres" },
      "select is_active from public.staff_profiles where user_id=$1",
      [otherManager],
    );
    expect(state.rows[0]!.is_active).toBe(true);
  });

  it("a counter cannot promote themselves", async () => {
    const r = await q(
      counter,
      "update public.staff_profiles set role='manager' where user_id=$1 returning role",
      [counterId],
    );
    expect(r.rowCount).toBe(0);
  });

  it("nobody can create or delete profiles from a user session, or edit identity columns", async () => {
    const stray = await insertStaff(db, "counter", "Stray");
    expect(
      (
        await pgError(
          q(
            manager,
            "insert into public.staff_profiles (user_id, display_name, role) values (gen_random_uuid(),'x','counter')",
          ),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
    expect(
      (await pgError(q(manager, "delete from public.staff_profiles where user_id=$1", [stray])))
        .code,
    ).toBe(PG.insufficientPrivilege);
    expect(
      (
        await pgError(
          q(
            manager,
            "update public.staff_profiles set user_id=gen_random_uuid() where user_id=$1",
            [stray],
          ),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
  });

  it("the last active manager cannot be deactivated or demoted, by anyone", async () => {
    // Deactivate the second manager (allowed: the first remains), then the first is the last one.
    await q(
      manager,
      "update public.staff_profiles set is_active=false where user_id=$1",
      [otherManager],
      true,
    );
    const lastDeactivate = await pgError(
      q(
        manager,
        "update public.staff_profiles set is_active=false where user_id=$1",
        [manager.role === "authenticated" ? manager.userId : ""],
        true,
      ),
    );
    expect(lastDeactivate.code).toBe(PG.checkViolation);
    const lastDemote = await pgError(
      q(
        manager,
        "update public.staff_profiles set role='counter' where user_id=$1",
        [manager.role === "authenticated" ? manager.userId : ""],
        true,
      ),
    );
    expect(lastDemote.code).toBe(PG.checkViolation);
    await q(
      manager,
      "update public.staff_profiles set is_active=true where user_id=$1",
      [otherManager],
      true,
    );
  });

  it("two managers deactivating each other at the same time: exactly one succeeds", async () => {
    const a = manager.role === "authenticated" ? manager.userId : "";
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Force the two transactions to OVERLAP: the first holds its (uncommitted) change for 400ms
    // while the second starts, so the second really races it for the last-manager lock.
    const deactivate = (actor: Actor, target: string, hold: number) =>
      db
        .transaction(
          actor,
          async (client) => {
            const r = await client.query(
              "update public.staff_profiles set is_active=false where user_id=$1",
              [target],
            );
            await sleep(hold);
            return r.rowCount;
          },
          { commit: true },
        )
        .then(
          (rows) => (rows === 1 ? "ok" : "no-rows"),
          (e: { code?: string }) => e.code ?? "error",
        );
    const first = deactivate(manager, otherManager, 400);
    await sleep(100);
    const second = deactivate({ role: "authenticated", userId: otherManager }, a, 0);
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual(["ok", PG.checkViolation]);
    const active = await q(
      { role: "postgres" },
      "select count(*)::int as n from public.staff_profiles where role='manager' and is_active",
    );
    expect(active.rows[0]!.n).toBeGreaterThanOrEqual(1);
    await q(
      { role: "postgres" },
      "update public.staff_profiles set is_active=true where role='manager'",
      [],
      true,
    );
  });

  it("a deactivated manager immediately loses manager powers", async () => {
    const b = { role: "authenticated", userId: otherManager } as const;
    await q(
      { role: "postgres" },
      "update public.staff_profiles set is_active=false where user_id=$1",
      [otherManager],
      true,
    );
    expect((await q(b, "select private.is_manager() as m")).rows[0]!.m).toBe(false);
    const r = await q(
      b,
      "update public.staff_profiles set is_active=false where user_id=$1 returning user_id",
      [counterId],
    );
    expect(r.rowCount).toBe(0);
    expect((await q(b, "select user_id from public.staff_profiles")).rows).toEqual([
      { user_id: otherManager },
    ]);
    await q(
      { role: "postgres" },
      "update public.staff_profiles set is_active=true where user_id=$1",
      [otherManager],
      true,
    );
  });
});
