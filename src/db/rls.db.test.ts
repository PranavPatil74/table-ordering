import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG, admin, createTestDb, pgError, type Actor, type TestDb } from "@/test/db/db";
import {
  buildSnapshot,
  insertAttempt,
  insertMenu,
  insertPaidOrder,
  insertPlainUser,
  insertStaff,
  insertTable,
  itemLine,
  type MenuFixture,
} from "@/test/db/fixtures";

let db: TestDb;
let a: ReturnType<typeof admin>;

const ANON: Actor = { role: "anon" };
const SERVICE: Actor = { role: "service_role" };
let manager: Actor;
let counter: Actor;
let plain: Actor; // signed in, but has no staff profile
let ids: { manager: string; manager2: string; counter: string; plain: string };

const q = (actor: Actor, sql: string, params: unknown[] = [], commit = false) =>
  db.query(actor, sql, params, { commit });

/** Tables that exist in `public`, for catalog-wide assertions. */
const PUBLIC_TABLES = [
  "cafe_settings",
  "cafe_tables",
  "gateway_events",
  "menu_categories",
  "menu_item_modifier_groups",
  "menu_items",
  "modifier_groups",
  "modifier_options",
  "order_counters",
  "order_events",
  "order_items",
  "orders",
  "payment_attempts",
  "rate_limits",
  "staff_profiles",
];

beforeAll(async () => {
  db = await createTestDb();
  a = admin(db);
  ids = {
    manager: await insertStaff(db, "manager", "Manager One"),
    manager2: await insertStaff(db, "manager", "Manager Two"),
    counter: await insertStaff(db, "counter", "Counter One"),
    plain: await insertPlainUser(db),
  };
  manager = { role: "authenticated", userId: ids.manager };
  counter = { role: "authenticated", userId: ids.counter };
  plain = { role: "authenticated", userId: ids.plain };
});
afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------------------
describe("catalog: RLS and grants as actually installed", () => {
  it("has Row Level Security enabled on every table in public", async () => {
    const rows = await a.all<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(PUBLIC_TABLES);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("gives anon SELECT on the public menu tables only, and no write access anywhere", async () => {
    const readable = new Set([
      "cafe_settings",
      "menu_categories",
      "menu_items",
      "modifier_groups",
      "modifier_options",
      "menu_item_modifier_groups",
    ]);
    for (const table of PUBLIC_TABLES) {
      const row = await a.one<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>(
        `select has_any_column_privilege('anon', $1, 'select') as sel,
                has_table_privilege('anon', $1, 'insert') as ins,
                has_any_column_privilege('anon', $1, 'update') as upd,
                has_table_privilege('anon', $1, 'delete') as del`,
        [`public.${table}`],
      );
      expect(row.sel, `anon select ${table}`).toBe(readable.has(table));
      expect(row.ins, `anon insert ${table}`).toBe(false);
      expect(row.upd, `anon update ${table}`).toBe(false);
      expect(row.del, `anon delete ${table}`).toBe(false);
    }
  });

  it("never lets signed-in users INSERT or DELETE orders, items, events, attempts or counters", async () => {
    for (const table of [
      "orders",
      "order_items",
      "order_events",
      "payment_attempts",
      "order_counters",
      "gateway_events",
      "rate_limits",
      "staff_profiles",
    ]) {
      for (const priv of ["insert", "delete"]) {
        const row = await a.one<{ ok: boolean }>(
          "select has_table_privilege('authenticated', $1, $2) as ok",
          [`public.${table}`, priv],
        );
        expect(row.ok, `authenticated ${priv} ${table}`).toBe(false);
      }
    }
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      const row = await a.one<{ ok: boolean }>(
        "select has_any_column_privilege('authenticated', $1, 'select') as ok",
        [`public.${table}`],
      );
      expect(row.ok, `authenticated select ${table}`).toBe(false);
    }
  });

  it("lets signed-in users update only status and cancel_reason on orders", async () => {
    const rows = await a.all<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'orders' and privilege_type = 'UPDATE'
        order by 1`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["cancel_reason", "status"]);
  });

  it("hides the cart snapshot, idempotency key and token hash from staff clients", async () => {
    const rows = await a.all<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'payment_attempts' and privilege_type = 'SELECT'`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).toContain("gateway_payment_id");
    for (const hidden of ["cart_snapshot", "tracking_token_hash", "idempotency_key"]) {
      expect(columns, hidden).not.toContain(hidden);
    }
  });

  it("restricts the payment RPC functions to service_role", async () => {
    for (const fn of [
      "public.finalize_paid_order(uuid, text)",
      "public.check_rate_limit(text, integer, integer)",
      "public.purge_expired_rate_limits()",
      "public.create_checkout_attempt(text, uuid, integer, jsonb, bytea, integer)",
      "public.get_checkout_attempt(text)",
    ]) {
      const row = await a.one<{ anon: boolean; authed: boolean; service: boolean; pub: boolean }>(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authed,
                has_function_privilege('service_role', $1, 'execute') as service,
                has_function_privilege('public', $1, 'execute') as pub`,
        [fn],
      );
      expect(row, fn).toEqual({ anon: false, authed: false, service: true, pub: false });
    }
  });

  it("exposes nothing but the five reviewed functions from the public schema", async () => {
    const rows = await a.all<{ proname: string }>(
      "select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1",
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "check_rate_limit",
      "create_checkout_attempt",
      "finalize_paid_order",
      "get_checkout_attempt",
      "purge_expired_rate_limits",
    ]);
  });

  it("denies anon the whole private schema", async () => {
    const row = await a.one<{ usage: boolean }>(
      "select has_schema_privilege('anon', 'private', 'usage') as usage",
    );
    expect(row.usage).toBe(false);
    const fns = await a.all<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'private'::regnamespace
          and has_function_privilege('anon', oid, 'execute')`,
    );
    expect(fns).toEqual([]);
  });

  it("sets a safe search_path on every SECURITY DEFINER function", async () => {
    const rows = await a.all<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc
        where prosecdef and pronamespace in ('public'::regnamespace, 'private'::regnamespace)`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      expect(row.proconfig, row.proname).toContain('search_path=""');
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("anonymous visitors (customers)", () => {
  let visible: MenuFixture;
  let hiddenItemId: string;
  beforeAll(async () => {
    visible = await insertMenu(db);
    // An archived item, a sold-out item, an archived option and an archived group.
    const archived = await a.one<{ id: string }>(
      "insert into public.menu_items (category_id, slug, name, price_paise, is_active) values ($1, 'archived-item', 'Archived item', 100, false) returning id",
      [visible.categoryId],
    );
    hiddenItemId = archived.id;
    await a.exec(
      "insert into public.menu_items (category_id, slug, name, price_paise, is_available) values ($1, 'sold-out-item', 'Sold out item', 100, false)",
      [visible.categoryId],
    );
    await a.exec("update public.modifier_options set is_active = false where id = $1", [
      visible.optionMayo.id,
    ]);
  });

  it("sees active items, including sold-out ones (so the UI can label them)", async () => {
    const rows = await q(ANON, "select name, is_available from public.menu_items order by name");
    const names = rows.rows.map((r) => r.name);
    expect(names).toContain("Grilled Sandwich");
    expect(names).toContain("Sold out item");
    expect(names).not.toContain("Archived item");
  });

  it("cannot see items of an archived category, nor archived options or groups", async () => {
    const cat = await a.one<{ id: string }>(
      "insert into public.menu_categories (slug, name, is_active) values ('hidden-cat', 'Hidden category', false) returning id",
    );
    await a.exec(
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, 'in-hidden-cat', 'In hidden category', 100)",
      [cat.id],
    );
    const items = await q(
      ANON,
      "select name from public.menu_items where name = 'In hidden category'",
    );
    expect(items.rows).toHaveLength(0);
    const categories = await q(
      ANON,
      "select name from public.menu_categories where name = 'Hidden category'",
    );
    expect(categories.rows).toHaveLength(0);

    const options = await q(ANON, "select name from public.modifier_options where group_id = $1", [
      visible.group.id,
    ]);
    expect(options.rows.map((r) => r.name)).toEqual(["Extra cheese"]); // 'Mint mayo' was archived

    await a.exec("update public.modifier_groups set is_active = false where id = $1", [
      visible.group.id,
    ]);
    expect(
      (
        await q(ANON, "select 1 from public.modifier_options where group_id = $1", [
          visible.group.id,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (await q(ANON, "select 1 from public.modifier_groups where id = $1", [visible.group.id]))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await q(ANON, "select 1 from public.menu_item_modifier_groups where group_id = $1", [
          visible.group.id,
        ])
      ).rows,
    ).toHaveLength(0);
    await a.exec("update public.modifier_groups set is_active = true where id = $1", [
      visible.group.id,
    ]);
  });

  it("sees the attachment between an active item and an active group", async () => {
    const rows = await q(
      ANON,
      "select item_id from public.menu_item_modifier_groups where group_id = $1",
      [visible.group.id],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("can read prices (they are public) but only the menu columns", async () => {
    const ok = await q(
      ANON,
      "select id, name, price_paise, image_path, dietary_tags from public.menu_items limit 1",
    );
    expect(ok.rows).toHaveLength(1);
    const denied = await pgError(q(ANON, "select created_at from public.menu_items limit 1"));
    expect(denied.code).toBe(PG.insufficientPrivilege);
  });

  it("can read only the public settings columns, and must name them", async () => {
    const ok = await q(
      ANON,
      "select cafe_name, orders_enabled, currency, max_item_quantity from public.cafe_settings",
    );
    expect(ok.rows).toHaveLength(1);
    for (const sql of [
      "select * from public.cafe_settings",
      "select timezone from public.cafe_settings",
      "select order_number_prefix, payment_attempt_ttl_minutes from public.cafe_settings",
    ]) {
      expect((await pgError(q(ANON, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it.each([
    "orders",
    "order_items",
    "order_events",
    "payment_attempts",
    "staff_profiles",
    "cafe_tables",
    "order_counters",
    "gateway_events",
    "rate_limits",
  ])("is denied all access to %s", async (table) => {
    const error = await pgError(q(ANON, `select * from public.${table}`));
    expect(error.code).toBe(PG.insufficientPrivilege);
  });

  it("cannot write to the menu, tables, settings or orders", async () => {
    for (const sql of [
      "update public.menu_items set price_paise = 1",
      "delete from public.menu_items",
      "insert into public.menu_categories (slug, name) values ('x', 'x')",
      "update public.cafe_settings set orders_enabled = false",
      "insert into public.cafe_tables (code, label) values ('FAKE1', 'Fake table')",
      "update public.orders set status = 'SERVED'",
      "insert into public.staff_profiles (user_id, display_name, role) values (gen_random_uuid(), 'x', 'manager')",
    ]) {
      expect((await pgError(q(ANON, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("cannot create fake tables by any route, so arbitrary QR values never become tables", async () => {
    const before = await a.one<{ n: number }>("select count(*)::int as n from public.cafe_tables");
    await pgError(
      q(ANON, "insert into public.cafe_tables (code, label) values ('HACK', 'Hack')", [], true),
    );
    const after = await a.one<{ n: number }>("select count(*)::int as n from public.cafe_tables");
    expect(after.n).toBe(before.n);
  });

  it("cannot call the payment, rate-limit or purge functions", async () => {
    for (const sql of [
      "select public.finalize_paid_order(gen_random_uuid(), 'pay_x')",
      "select public.check_rate_limit('x', 5, 60)",
      "select public.purge_expired_rate_limits()",
    ]) {
      expect((await pgError(q(ANON, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("cannot reach private helpers or trigger functions", async () => {
    for (const sql of [
      "select private.is_manager()",
      "select private.next_order_seq(current_date)",
    ]) {
      expect((await pgError(q(ANON, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("cannot learn that an archived item exists by id", async () => {
    const rows = await q(ANON, "select id from public.menu_items where id = $1", [hiddenItemId]);
    expect(rows.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
describe("signed-in user without a staff profile", () => {
  let paid: Awaited<ReturnType<typeof insertPaidOrder>>;
  beforeAll(async () => {
    paid = await insertPaidOrder(db);
  });

  it("reads the public menu but no private rows", async () => {
    expect((await q(plain, "select 1 from public.menu_items")).rows.length).toBeGreaterThan(0);
    for (const table of [
      "orders",
      "order_items",
      "order_events",
      "payment_attempts",
      "staff_profiles",
      "cafe_tables",
    ]) {
      const rows = await q(plain, `select count(*)::int as n from public.${table}`).catch(
        () => null,
      );
      // payment_attempts has column-level SELECT only, so `count(*)` of its columns is still filtered by RLS.
      expect(rows?.rows[0]?.n ?? 0, table).toBe(0);
    }
    // Inactive menu rows are staff-only.
    await a.exec("update public.menu_items set is_active = false where id = $1", [
      paid.menu.drink.id,
    ]);
    expect(
      (await q(plain, "select 1 from public.menu_items where id = $1", [paid.menu.drink.id])).rows,
    ).toHaveLength(0);
    await a.exec("update public.menu_items set is_active = true where id = $1", [
      paid.menu.drink.id,
    ]);
  });

  it("cannot change orders, the menu or settings", async () => {
    const orders = await q(
      plain,
      "update public.orders set status = 'ACCEPTED' where id = $1 returning id",
      [paid.order.out_order_id],
      true,
    );
    expect(orders.rows).toHaveLength(0);
    const menu = await q(
      plain,
      "update public.menu_items set price_paise = 1 returning id",
      [],
      true,
    );
    expect(menu.rows).toHaveLength(0);
    const settings = await q(
      plain,
      "update public.cafe_settings set orders_enabled = false returning id",
      [],
      true,
    );
    expect(settings.rows).toHaveLength(0);
    const own = await q(
      plain,
      "update public.staff_profiles set role = 'manager' returning user_id",
      [],
      true,
    );
    expect(own.rows).toHaveLength(0);
    const order = await a.one<{ status: string }>(
      "select status from public.orders where id = $1",
      [paid.order.out_order_id],
    );
    expect(order.status).toBe("NEW");
  });

  it("cannot grant itself a role", async () => {
    const error = await pgError(
      q(
        plain,
        "insert into public.staff_profiles (user_id, display_name, role) values ($1, 'me', 'manager')",
        [ids.plain],
        true,
      ),
    );
    expect(error.code).toBe(PG.insufficientPrivilege);
  });

  it("is not treated as staff after being deactivated", async () => {
    const reader = await insertStaff(db, "counter", "Soon gone");
    const actor: Actor = { role: "authenticated", userId: reader };
    expect((await q(actor, "select 1 from public.orders")).rows.length).toBeGreaterThan(0);
    await a.exec("update public.staff_profiles set is_active = false where user_id = $1", [reader]);
    expect((await q(actor, "select 1 from public.orders")).rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
describe("counter staff", () => {
  let paid: Awaited<ReturnType<typeof insertPaidOrder>>;
  beforeAll(async () => {
    paid = await insertPaidOrder(db);
  });
  const orderId = () => paid.order.out_order_id;

  it("can read orders, items, audit events and payment references", async () => {
    expect(
      (await q(counter, "select * from public.orders where id = $1", [orderId()])).rows,
    ).toHaveLength(1);
    expect(
      (await q(counter, "select * from public.order_items where order_id = $1", [orderId()])).rows,
    ).toHaveLength(2);
    expect(
      (await q(counter, "select * from public.order_events where order_id = $1", [orderId()])).rows,
    ).toHaveLength(1);
    const ref = await q(
      counter,
      "select gateway_order_id, gateway_payment_id, status, amount_paise from public.payment_attempts where id = $1",
      [paid.attempt.attemptId],
    );
    expect(ref.rows[0]).toMatchObject({ status: "PAID", amount_paise: 47700 });
  });

  it("cannot read the cart snapshot or tracking token hash of a payment attempt", async () => {
    for (const column of ["cart_snapshot", "tracking_token_hash", "idempotency_key"]) {
      const error = await pgError(q(counter, `select ${column} from public.payment_attempts`));
      expect(error.code, column).toBe(PG.insufficientPrivilege);
    }
  });

  it("can see cafe tables, the full settings and its own profile only", async () => {
    expect((await q(counter, "select code from public.cafe_tables")).rows.length).toBeGreaterThan(
      0,
    );
    expect(
      (await q(counter, "select timezone, order_number_prefix from public.cafe_settings")).rows,
    ).toHaveLength(1);
    const profiles = await q(counter, "select user_id from public.staff_profiles");
    expect(profiles.rows.map((r) => r.user_id)).toEqual([ids.counter]);
  });

  it("moves an order through preparation and leaves a staff-attributed audit trail", async () => {
    for (const next of ["ACCEPTED", "PREPARING", "READY", "SERVED"]) {
      const result = await q(
        counter,
        "update public.orders set status = $2 where id = $1 returning status",
        [orderId(), next],
        true,
      );
      expect(result.rows[0]!.status).toBe(next);
    }
    const events = await a.all<{ to_value: string; actor_kind: string; actor_user_id: string }>(
      "select to_value, actor_kind, actor_user_id from public.order_events where order_id = $1 and event_type = 'STATUS_CHANGED' order by id",
      [orderId()],
    );
    expect(events.map((e) => e.to_value)).toEqual(["ACCEPTED", "PREPARING", "READY", "SERVED"]);
    for (const event of events) {
      expect(event.actor_kind).toBe("staff");
      expect(event.actor_user_id).toBe(ids.counter);
    }
  });

  it("cannot skip steps (the database enforces the state machine for staff too)", async () => {
    const fresh = await insertPaidOrder(db);
    const error = await pgError(
      q(
        counter,
        "update public.orders set status = 'SERVED' where id = $1",
        [fresh.order.out_order_id],
        true,
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("cannot cancel an order (manager only)", async () => {
    const fresh = await insertPaidOrder(db);
    const error = await pgError(
      q(
        counter,
        "update public.orders set status = 'CANCELLED', cancel_reason = 'nope' where id = $1",
        [fresh.order.out_order_id],
        true,
      ),
    );
    expect(error.code).toBe(PG.insufficientPrivilege);
    expect(
      (
        await a.one<{ status: string }>("select status from public.orders where id = $1", [
          fresh.order.out_order_id,
        ])
      ).status,
    ).toBe("NEW");
  });

  it("cannot change payment_status, totals or any other order column", async () => {
    const fresh = await insertPaidOrder(db);
    for (const sql of [
      "update public.orders set payment_status = 'REFUNDED' where id = $1",
      "update public.orders set payment_status = 'REFUND_PENDING' where id = $1",
      "update public.orders set total_paise = 1 where id = $1",
      "update public.orders set order_number = 'SE-999' where id = $1",
      "update public.orders set accepted_at = now() where id = $1",
      "update public.orders set customer_name = 'x' where id = $1",
    ]) {
      expect((await pgError(q(counter, sql, [fresh.order.out_order_id], true))).code, sql).toBe(
        PG.insufficientPrivilege,
      );
    }
  });

  it("cannot insert or delete orders, items, events or attempts", async () => {
    const fresh = await insertPaidOrder(db);
    for (const sql of [
      "delete from public.orders",
      "delete from public.order_items",
      "delete from public.order_events",
      "delete from public.payment_attempts",
      "insert into public.order_events (order_id, event_type, actor_kind) values ($1, 'STATUS_CHANGED', 'staff')",
      "update public.order_items set quantity = 9 where order_id = $1",
      "update public.payment_attempts set status = 'FAILED' where id = (select payment_attempt_id from public.orders where id = $1)",
    ]) {
      const params = sql.includes("$1") ? [fresh.order.out_order_id] : [];
      expect((await pgError(q(counter, sql, params, true))).code, sql).toBe(
        PG.insufficientPrivilege,
      );
    }
  });

  it("can mark a menu item or option sold out, and back", async () => {
    const menu = await insertMenu(db);
    const off = await q(
      counter,
      "update public.menu_items set is_available = false where id = $1 returning is_available",
      [menu.item.id],
      true,
    );
    expect(off.rows[0]!.is_available).toBe(false);
    await q(
      counter,
      "update public.menu_items set is_available = true where id = $1",
      [menu.item.id],
      true,
    );
    const opt = await q(
      counter,
      "update public.modifier_options set is_available = false where id = $1 returning is_available",
      [menu.optionCheese.id],
      true,
    );
    expect(opt.rows[0]!.is_available).toBe(false);
  });

  it("cannot change prices, names or anything else on the menu", async () => {
    const menu = await insertMenu(db);
    for (const sql of [
      "update public.menu_items set price_paise = 1 where id = $1",
      "update public.menu_items set name = 'Hacked' where id = $1",
      "update public.menu_items set is_active = false where id = $1",
      "update public.menu_items set price_paise = 1, is_available = false where id = $1", // mixed edit
      "update public.modifier_options set price_delta_paise = 0 where group_id = (select group_id from public.menu_item_modifier_groups where item_id = $1)",
    ]) {
      expect((await pgError(q(counter, sql, [menu.item.id], true))).code, sql).toBe(
        PG.insufficientPrivilege,
      );
    }
    const row = await a.one<{ price_paise: number; name: string }>(
      "select price_paise, name from public.menu_items where id = $1",
      [menu.item.id],
    );
    expect(row).toEqual({ price_paise: 14900, name: "Grilled Sandwich" });
  });

  it("cannot create or delete menu items, categories, groups, options or tables", async () => {
    const menu = await insertMenu(db);
    const inserts = [
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, 'c-item', 'C item', 100)",
      "insert into public.menu_categories (slug, name) values ('c-cat', 'C cat')",
      "insert into public.modifier_groups (slug, name) values ('c-group', 'C group')",
      "insert into public.cafe_tables (code, label) values ('CTAB', 'C table')",
    ];
    for (const sql of inserts) {
      const error = await pgError(
        q(counter, sql, sql.includes("$1") ? [menu.categoryId] : [], true),
      );
      expect(error.code, sql).toBe(PG.insufficientPrivilege); // "new row violates row-level security policy"
    }
    // Deletes and updates that RLS hides affect zero rows instead of raising.
    const hidden: [string, unknown[]][] = [
      ["delete from public.menu_items where id = $1 returning id", [menu.item.id]],
      [
        "update public.menu_categories set name = 'Hacked' where id = $1 returning id",
        [menu.categoryId],
      ],
      [
        "update public.modifier_groups set max_select = 9 where id = $1 returning id",
        [menu.group.id],
      ],
      ["update public.cafe_tables set is_active = false returning id", []],
      ["update public.cafe_settings set orders_enabled = false returning id", []],
    ];
    for (const [sql, params] of hidden) {
      const result = await q(counter, sql, params, true);
      expect(result.rows, sql).toHaveLength(0);
    }
    const settings = await a.one<{ orders_enabled: boolean }>(
      "select orders_enabled from public.cafe_settings",
    );
    expect(settings.orders_enabled).toBe(true);
  });

  it("cannot promote itself or anyone else, or change profiles at all", async () => {
    for (const sql of [
      "update public.staff_profiles set role = 'manager' returning user_id",
      "update public.staff_profiles set is_active = false returning user_id",
      "update public.staff_profiles set display_name = 'x' returning user_id",
    ]) {
      expect((await q(counter, sql, [], true)).rows, sql).toHaveLength(0);
    }
    const profile = await a.one<{ role: string }>(
      "select role from public.staff_profiles where user_id = $1",
      [ids.counter],
    );
    expect(profile.role).toBe("counter");
    expect(
      (
        await pgError(
          q(
            counter,
            "insert into public.staff_profiles (user_id, display_name, role) values (gen_random_uuid(), 'x', 'counter')",
            [],
            true,
          ),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
  });

  it("cannot call the payment functions", async () => {
    for (const sql of [
      "select public.finalize_paid_order(gen_random_uuid(), 'pay_x')",
      "select public.check_rate_limit('x', 5, 60)",
    ]) {
      expect((await pgError(q(counter, sql))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("managers", () => {
  it("can change prices, names and availability, and create and delete unused menu rows", async () => {
    const menu = await insertMenu(db);
    const updated = await q(
      manager,
      "update public.menu_items set price_paise = 15900, name = 'Grilled Sandwich v2' where id = $1 returning price_paise",
      [menu.item.id],
      true,
    );
    expect(updated.rows[0]!.price_paise).toBe(15900);

    await q(
      manager,
      "insert into public.menu_categories (slug, name) values ('m-cat', 'Manager category')",
      [],
      true,
    );
    const created = await q(
      manager,
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, 'm-item', 'Manager item', 5000) returning id",
      [menu.categoryId],
      true,
    );
    const removed = await q(
      manager,
      "delete from public.menu_items where id = $1 returning id",
      [created.rows[0]!.id],
      true,
    );
    expect(removed.rows).toHaveLength(1);

    await q(
      manager,
      "update public.modifier_options set price_delta_paise = 5000 where id = $1",
      [menu.optionCheese.id],
      true,
    );
    await q(
      manager,
      "insert into public.modifier_options (group_id, name, price_delta_paise) values ($1, 'Jalapenos', 1500)",
      [menu.group.id],
      true,
    );
  });

  it("can see archived and unavailable rows", async () => {
    const menu = await insertMenu(db);
    await a.exec("update public.menu_items set is_active = false where id = $1", [menu.item.id]);
    expect(
      (await q(manager, "select 1 from public.menu_items where id = $1", [menu.item.id])).rows,
    ).toHaveLength(1);
    expect(
      (await q(counter, "select 1 from public.menu_items where id = $1", [menu.item.id])).rows,
    ).toHaveLength(1);
    expect(
      (await q(ANON, "select 1 from public.menu_items where id = $1", [menu.item.id])).rows,
    ).toHaveLength(0);
  });

  it("can create, rename and deactivate tables, and edit settings", async () => {
    const created = await q(
      manager,
      "insert into public.cafe_tables (code, label) values ('MGR1', 'Manager table') returning id",
      [],
      true,
    );
    await q(
      manager,
      "update public.cafe_tables set label = 'Renamed', is_active = false where id = $1",
      [created.rows[0]!.id],
      true,
    );
    const settings = await q(
      manager,
      "update public.cafe_settings set orders_enabled = false, cafe_name = 'Sandwich Express HQ' returning orders_enabled",
      [],
      true,
    );
    expect(settings.rows[0]!.orders_enabled).toBe(false);
    expect(
      (await q(ANON, "select orders_enabled from public.cafe_settings")).rows[0]!.orders_enabled,
    ).toBe(false);
    await q(
      manager,
      "update public.cafe_settings set orders_enabled = true, cafe_name = 'Sandwich Express'",
      [],
      true,
    );
  });

  it("cannot change the immutable settings columns (id, currency)", async () => {
    for (const sql of [
      "update public.cafe_settings set id = 2",
      "update public.cafe_settings set currency = 'USD'",
    ]) {
      expect((await pgError(q(manager, sql, [], true))).code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("can cancel an order with a reason, attributed to the manager", async () => {
    const paid = await insertPaidOrder(db);
    const result = await q(
      manager,
      "update public.orders set status = 'CANCELLED', cancel_reason = 'Kitchen closed' where id = $1 returning status, payment_status",
      [paid.order.out_order_id],
      true,
    );
    // Cancelling does not claim a refund happened.
    expect(result.rows[0]).toEqual({ status: "CANCELLED", payment_status: "PAID" });
    const event = await a.one<{
      actor_user_id: string;
      actor_kind: string;
      metadata: { cancel_reason: string };
    }>(
      "select actor_user_id, actor_kind, metadata from public.order_events where order_id = $1 and to_value = 'CANCELLED'",
      [paid.order.out_order_id],
    );
    expect(event).toMatchObject({
      actor_user_id: ids.manager,
      actor_kind: "staff",
      metadata: { cancel_reason: "Kitchen closed" },
    });
  });

  it("still cannot set payment_status or edit totals, even though it is a manager", async () => {
    const paid = await insertPaidOrder(db);
    for (const sql of [
      "update public.orders set payment_status = 'REFUNDED' where id = $1",
      "update public.orders set payment_status = 'REFUND_PENDING' where id = $1",
      "update public.orders set total_paise = 1 where id = $1",
    ]) {
      expect((await pgError(q(manager, sql, [paid.order.out_order_id], true))).code, sql).toBe(
        PG.insufficientPrivilege,
      );
    }
  });

  it("cannot call the payment functions or touch backend-only tables", async () => {
    expect(
      (await pgError(q(manager, "select public.finalize_paid_order(gen_random_uuid(), 'pay_x')")))
        .code,
    ).toBe(PG.insufficientPrivilege);
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      expect((await pgError(q(manager, `select * from public.${table}`))).code, table).toBe(
        PG.insufficientPrivilege,
      );
    }
  });

  it("sees every staff profile and can change role and active state of others", async () => {
    const profiles = await q(manager, "select user_id from public.staff_profiles");
    expect(profiles.rows.length).toBeGreaterThanOrEqual(3);

    const temp = await insertStaff(db, "counter", "Temp");
    await q(
      manager,
      "update public.staff_profiles set role = 'manager', display_name = 'Temp Manager' where user_id = $1",
      [temp],
      true,
    );
    await q(
      manager,
      "update public.staff_profiles set is_active = false where user_id = $1",
      [temp],
      true,
    );
    expect(
      await a.one<{ role: string; is_active: boolean }>(
        "select role, is_active from public.staff_profiles where user_id = $1",
        [temp],
      ),
    ).toEqual({ role: "manager", is_active: false });
  });

  it("cannot reassign a profile to another auth user, nor add or delete profiles", async () => {
    expect(
      (
        await pgError(
          q(
            manager,
            "update public.staff_profiles set user_id = gen_random_uuid() where user_id = $1",
            [ids.counter],
            true,
          ),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
    expect(
      (
        await pgError(
          q(
            manager,
            "insert into public.staff_profiles (user_id, display_name, role) values (gen_random_uuid(), 'x', 'counter')",
            [],
            true,
          ),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
    expect(
      (
        await pgError(
          q(manager, "delete from public.staff_profiles where user_id = $1", [ids.counter], true),
        )
      ).code,
    ).toBe(PG.insufficientPrivilege);
  });
});

// ---------------------------------------------------------------------------------------
describe("the cafe is never left without a manager", () => {
  let local: TestDb;
  let m1: Actor;
  let m2: Actor;
  let id1: string;
  let id2: string;
  beforeAll(async () => {
    local = await createTestDb();
    id1 = await insertStaff(local, "manager", "Only manager");
    id2 = "";
    m1 = { role: "authenticated", userId: id1 };
  });
  afterAll(async () => {
    await local.close();
  });
  const lq = (actor: Actor, sql: string, params: unknown[] = []) =>
    local.query(actor, sql, params, { commit: true });

  it("refuses to demote or deactivate the only active manager", async () => {
    for (const sql of [
      "update public.staff_profiles set role = 'counter' where user_id = $1",
      "update public.staff_profiles set is_active = false where user_id = $1",
    ]) {
      const error = await pgError(lq(m1, sql, [id1]));
      expect(error.code, sql).toBe(PG.checkViolation);
    }
    // Not even an administrator or the backend can delete the last manager's profile.
    const deleted = await pgError(
      local.query(
        { role: "service_role" },
        "delete from public.staff_profiles where user_id = $1",
        [id1],
        { commit: true },
      ),
    );
    expect(deleted.code).toBe(PG.checkViolation);
  });

  it("serialises two managers demoting each other, so one always remains", async () => {
    id2 = await insertStaff(local, "manager", "Second manager");
    m2 = { role: "authenticated", userId: id2 };

    // Deterministic interleaving: transaction 1 demotes manager 2 and stays OPEN while
    // transaction 2 (manager 2 demoting manager 1) starts. Without the advisory lock, both would
    // see "the other manager is still active" and both would commit.
    let second: Promise<unknown> | undefined;
    let secondSettled = false;
    await local.transaction(
      m1,
      async (client) => {
        await client.query("update public.staff_profiles set role = 'counter' where user_id = $1", [
          id2,
        ]);
        second = lq(m2, "update public.staff_profiles set role = 'counter' where user_id = $1", [
          id1,
        ]).finally(() => {
          secondSettled = true;
        });
        second.catch(() => {}); // observed below; avoid an unhandled-rejection warning meanwhile
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(secondSettled, "transaction 2 must be waiting on the guard lock").toBe(false);
      },
      { commit: true },
    );

    // Transaction 1 has committed; transaction 2 now sees that manager 2 is gone as a manager
    // and must be refused rather than demoting the last remaining one.
    const error = await pgError(second!);
    expect(error.code).toBe(PG.checkViolation);

    const managers = await admin(local).all<{ user_id: string }>(
      "select user_id from public.staff_profiles where role = 'manager' and is_active",
    );
    expect(managers.map((m) => m.user_id)).toEqual([id1]);
  });
});

// ---------------------------------------------------------------------------------------
describe("service_role (trusted backend)", () => {
  it("can run the full payment path that signed-in users cannot", async () => {
    const table = await insertTable(db, "SR01");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const result = await q(
      SERVICE,
      "select * from public.finalize_paid_order($1, 'pay_service_1')",
      [attempt.attemptId],
      true,
    );
    expect(result.rows[0]!.out_created).toBe(true);
    expect(
      (
        await q(SERVICE, "select 1 from public.orders where id = $1", [
          result.rows[0]!.out_order_id,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("can move an order to REFUND_PENDING (the only role that can change payment_status)", async () => {
    const paid = await insertPaidOrder(db);
    const result = await q(
      SERVICE,
      "update public.orders set payment_status = 'REFUND_PENDING' where id = $1 returning payment_status",
      [paid.order.out_order_id],
      true,
    );
    expect(result.rows[0]!.payment_status).toBe("REFUND_PENDING");
  });

  it("can read the backend-only tables", async () => {
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      await q(SERVICE, `select * from public.${table}`);
    }
  });
});
