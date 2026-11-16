import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDenied, expectNotApplied } from "./assertions";
import {
  anonClient,
  createUser,
  createWorld,
  must,
  newRunTag,
  serviceClient,
  Tracker,
  type TestUser,
  type World,
} from "./harness";
import { describeResult } from "./helpers";

/**
 * Counter and manager permissions through the REAL PostgREST API with REAL Supabase Auth JWTs.
 * Every denial is also checked by reading the row back as the service role, so a request that was
 * silently ignored cannot be mistaken for one that was blocked by accident.
 */

const tag = newRunTag();
const tracker = new Tracker();
const service = serviceClient();
let manager: TestUser;
let counter: TestUser;
let world: World;

beforeAll(async () => {
  manager = await createUser(tag, "manager", tracker, {
    role: "manager",
    displayName: `IT manager ${tag}`,
  });
  counter = await createUser(tag, "counter", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  world = await createWorld(tag, tracker);
});
afterAll(async () => {
  await tracker.cleanup();
});

const orderRow = async (orderId: string) =>
  must(
    await service
      .from("orders")
      .select("status, payment_status, total_paise, order_number")
      .eq("id", orderId)
      .single(),
    "read order",
  );
const itemRow = async (id: string) =>
  must(
    await service
      .from("menu_items")
      .select("name, price_paise, is_active, is_available")
      .eq("id", id)
      .single(),
    "read item",
  );

// ---------------------------------------------------------------------------------------
describe("counter: what it can read", () => {
  it("reads orders, their items and the audit trail", async () => {
    const order = await world.makeOrder();
    const orders = must(
      await counter.client.from("orders").select("*").eq("id", order.orderId),
      "orders",
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: "NEW", payment_status: "PAID", total_paise: 47700 });

    const items = must(
      await counter.client.from("order_items").select("*").eq("order_id", order.orderId),
      "items",
    );
    expect(items).toHaveLength(2);
    const events = must(
      await counter.client.from("order_events").select("event_type").eq("order_id", order.orderId),
      "events",
    );
    expect(events.map((e) => e.event_type)).toEqual(["ORDER_PLACED"]);
  });

  it("reads payment references, but never the cart snapshot, idempotency key or token hash", async () => {
    const order = await world.makeOrder();
    const attempt = must(
      await counter.client
        .from("payment_attempts")
        .select("id, status, amount_paise, gateway_order_id, gateway_payment_id")
        .eq("id", order.attemptId),
      "attempt",
    );
    expect(attempt[0]).toMatchObject({ status: "PAID", amount_paise: 47700 });
    expect(attempt[0]!.gateway_payment_id).toMatch(/^pay_/);

    for (const column of ["cart_snapshot", "tracking_token_hash", "idempotency_key", "*"]) {
      expectDenied(
        `payment_attempts.${column}`,
        await counter.client.from("payment_attempts").select(column).eq("id", order.attemptId),
      );
    }
  });

  it("reads tables and the full settings row, but not the backend-only tables", async () => {
    expect(
      must(
        await counter.client.from("cafe_tables").select("code").eq("id", world.table.id),
        "tables",
      ),
    ).toEqual([{ code: world.table.code }]);
    expect(
      must(
        await counter.client.from("cafe_settings").select("timezone, order_number_prefix"),
        "settings",
      ),
    ).toHaveLength(1);
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      expectDenied(
        `counter select ${table}`,
        await counter.client.from(table).select("*").limit(1),
      );
    }
  });
});

describe("counter: running the kitchen", () => {
  it("moves an order through preparation, and the audit trail names the real Auth user", async () => {
    const order = await world.makeOrder();
    for (const next of ["ACCEPTED", "PREPARING", "READY", "SERVED"]) {
      const result = await counter.client
        .from("orders")
        .update({ status: next })
        .eq("id", order.orderId)
        .select("status");
      expect(result.data, describeResult(result)).toEqual([{ status: next }]);
    }
    const events = must(
      await counter.client
        .from("order_events")
        .select("to_value, actor_kind, actor_user_id")
        .eq("order_id", order.orderId)
        .eq("event_type", "STATUS_CHANGED")
        .order("id"),
      "audit events",
    );
    expect(events.map((e) => e.to_value)).toEqual(["ACCEPTED", "PREPARING", "READY", "SERVED"]);
    for (const event of events) {
      expect(event.actor_kind).toBe("staff");
      expect(event.actor_user_id, "auth.uid() must reach the trigger as the signed-in user").toBe(
        counter.id,
      );
    }
  });

  it("cannot skip a step", async () => {
    const order = await world.makeOrder();
    const result = await counter.client
      .from("orders")
      .update({ status: "SERVED" })
      .eq("id", order.orderId)
      .select("status");
    expect(result.error?.code, describeResult(result)).toBe("23514");
    expect((await orderRow(order.orderId)).status).toBe("NEW");
  });

  it("cannot cancel an order (manager only)", async () => {
    const order = await world.makeOrder();
    const result = await counter.client
      .from("orders")
      .update({ status: "CANCELLED", cancel_reason: "counter attempt" })
      .eq("id", order.orderId)
      .select("status");
    expectDenied("counter cancel", result);
    expect((await orderRow(order.orderId)).status).toBe("NEW");
  });

  it("cannot change payment status, totals or any other order column", async () => {
    const order = await world.makeOrder();
    const before = await orderRow(order.orderId);
    for (const patch of [
      { payment_status: "REFUNDED" },
      { payment_status: "REFUND_PENDING" },
      { total_paise: 1 },
      { order_number: "SE-999" },
      { customer_name: "x" },
    ]) {
      expectDenied(
        `counter update ${Object.keys(patch)[0]}`,
        await counter.client.from("orders").update(patch).eq("id", order.orderId).select(),
      );
    }
    expect(await orderRow(order.orderId)).toEqual(before);
  });

  it("cannot delete or forge orders, items, events or payment attempts", async () => {
    const order = await world.makeOrder();
    const attempts = [
      ["delete order", counter.client.from("orders").delete().eq("id", order.orderId).select()],
      [
        "delete items",
        counter.client.from("order_items").delete().eq("order_id", order.orderId).select(),
      ],
      [
        "delete events",
        counter.client.from("order_events").delete().eq("order_id", order.orderId).select(),
      ],
      [
        "delete attempt",
        counter.client.from("payment_attempts").delete().eq("id", order.attemptId).select(),
      ],
      [
        "forge event",
        counter.client
          .from("order_events")
          .insert({ order_id: order.orderId, event_type: "STATUS_CHANGED", actor_kind: "staff" }),
      ],
      [
        "edit item",
        counter.client
          .from("order_items")
          .update({ quantity: 9 })
          .eq("order_id", order.orderId)
          .select(),
      ],
      [
        "edit attempt",
        counter.client
          .from("payment_attempts")
          .update({ status: "FAILED" })
          .eq("id", order.attemptId)
          .select(),
      ],
    ] as const;
    for (const [what, request] of attempts) expectDenied(`counter ${what}`, await request);

    expect((await orderRow(order.orderId)).status).toBe("NEW");
    expect(
      must(
        await service.from("order_items").select("quantity").eq("order_id", order.orderId),
        "items",
      ),
    ).toHaveLength(2);
    expect(
      must(await service.from("order_events").select("id").eq("order_id", order.orderId), "events"),
    ).toHaveLength(1);
  });
});

describe("counter: the menu", () => {
  it("can mark an item or an option sold out and available again", async () => {
    const off = await counter.client
      .from("menu_items")
      .update({ is_available: false })
      .eq("id", world.menu.item.id)
      .select("is_available");
    expect(off.data, describeResult(off)).toEqual([{ is_available: false }]);
    expect((await itemRow(world.menu.item.id)).is_available).toBe(false);
    must(
      await counter.client
        .from("menu_items")
        .update({ is_available: true })
        .eq("id", world.menu.item.id)
        .select(),
      "restore",
    );

    const option = await counter.client
      .from("modifier_options")
      .update({ is_available: false })
      .eq("id", world.menu.optionCheese.id)
      .select("is_available");
    expect(option.data, describeResult(option)).toEqual([{ is_available: false }]);
    must(
      await counter.client
        .from("modifier_options")
        .update({ is_available: true })
        .eq("id", world.menu.optionCheese.id)
        .select(),
      "restore",
    );
  });

  it("cannot change prices, names, visibility or option prices", async () => {
    const before = await itemRow(world.menu.item.id);
    for (const patch of [
      { price_paise: 1 },
      { name: "Hacked" },
      { is_active: false },
      { price_paise: 1, is_available: false }, // a price change hidden inside an availability change
    ]) {
      expectDenied(
        `counter menu_items ${JSON.stringify(patch)}`,
        await counter.client.from("menu_items").update(patch).eq("id", world.menu.item.id).select(),
      );
    }
    expectDenied(
      "counter option price",
      await counter.client
        .from("modifier_options")
        .update({ price_delta_paise: 0 })
        .eq("id", world.menu.optionCheese.id)
        .select(),
    );
    expect(await itemRow(world.menu.item.id)).toEqual(before);
    const option = must(
      await service
        .from("modifier_options")
        .select("price_delta_paise")
        .eq("id", world.menu.optionCheese.id)
        .single(),
      "option",
    );
    expect(option.price_delta_paise).toBe(3000);
  });

  it("cannot create menu rows, tables or settings", async () => {
    // Every row the counter tries to create gets a marker no fixture slug can contain. (An earlier
    // version searched for `it-<tag>-c%`, which also matched the fixture's own `…-coffee` item and
    // reported a row the counter never created.) Read-backs below use exact keys, never a pattern.
    const marker = `it-${tag}-denied`;
    const attempted = {
      item: `${marker}-item`,
      category: `${marker}-category`,
      group: `${marker}-group`,
      table: `DN${tag.toUpperCase()}`,
    };
    const itemsIn = async () =>
      must(
        await service.from("menu_items").select("id").eq("category_id", world.menu.categoryId),
        "items in the fixture category",
      ).length;
    const itemsBefore = await itemsIn();
    const settingsBefore = must(await service.from("cafe_settings").select("id"), "settings");

    expectDenied(
      "insert item",
      await counter.client.from("menu_items").insert({
        category_id: world.menu.categoryId,
        slug: attempted.item,
        name: "Denied item",
        price_paise: 100,
      }),
    );
    expectDenied(
      "insert category",
      await counter.client
        .from("menu_categories")
        .insert({ slug: attempted.category, name: `Denied category ${tag}` }),
    );
    expectDenied(
      "insert group",
      await counter.client
        .from("modifier_groups")
        .insert({ slug: attempted.group, name: `Denied group ${tag}` }),
    );
    expectDenied(
      "insert table",
      await counter.client
        .from("cafe_tables")
        .insert({ code: attempted.table, label: "Denied table" }),
    );
    expectDenied(
      "insert settings row",
      await counter.client.from("cafe_settings").insert({ id: 2, cafe_name: "Denied" }),
    );

    // Read back as the trusted backend: exactly nothing was created, in every table.
    const exact = async (table: string, column: string, value: string) =>
      must(await service.from(table).select(column).eq(column, value), `${table} by ${column}`);
    expect(await exact("menu_items", "slug", attempted.item)).toEqual([]);
    expect(await exact("menu_categories", "slug", attempted.category)).toEqual([]);
    expect(await exact("modifier_groups", "slug", attempted.group)).toEqual([]);
    expect(await exact("cafe_tables", "code", attempted.table)).toEqual([]);
    // ...and nothing slipped in under any name: the same category still holds the same rows.
    expect(await itemsIn(), "item count in the fixture category").toBe(itemsBefore);
    expect(must(await service.from("cafe_settings").select("id"), "settings")).toEqual(
      settingsBefore,
    );
    // Nothing carrying the marker exists anywhere (a prefix no fixture slug can match).
    expect(
      must(await service.from("menu_items").select("slug").like("slug", `${marker}%`), "items"),
    ).toEqual([]);
  });

  it("cannot edit or delete categories, groups, tables or settings (hidden by RLS or refused)", async () => {
    const settingsBefore = must(
      await service.from("cafe_settings").select("orders_enabled, cafe_name").single(),
      "settings",
    );
    expectNotApplied(
      "rename category",
      await counter.client
        .from("menu_categories")
        .update({ name: "Hacked" })
        .eq("id", world.menu.categoryId)
        .select(),
    );
    expectNotApplied(
      "edit group",
      await counter.client
        .from("modifier_groups")
        .update({ max_select: 9 })
        .eq("id", world.menu.group.id)
        .select(),
    );
    expectNotApplied(
      "edit table",
      await counter.client
        .from("cafe_tables")
        .update({ is_active: false })
        .eq("id", world.table.id)
        .select(),
    );
    expectNotApplied(
      "delete table",
      await counter.client.from("cafe_tables").delete().eq("id", world.table.id).select(),
    );
    expectNotApplied(
      "delete item",
      await counter.client.from("menu_items").delete().eq("id", world.menu.item.id).select(),
    );
    expectNotApplied(
      "edit settings",
      await counter.client
        .from("cafe_settings")
        .update({ orders_enabled: false })
        .eq("id", 1)
        .select(),
    );

    expect(
      must(
        await service
          .from("menu_categories")
          .select("name")
          .eq("id", world.menu.categoryId)
          .single(),
        "category",
      ).name,
    ).toBe(world.menu.categoryName);
    expect(
      must(
        await service.from("cafe_tables").select("is_active").eq("id", world.table.id).single(),
        "table",
      ).is_active,
    ).toBe(true);
    expect(await itemRow(world.menu.item.id)).toMatchObject({ name: "Grilled Sandwich" });
    expect(
      must(
        await service.from("cafe_settings").select("orders_enabled, cafe_name").single(),
        "settings",
      ),
    ).toEqual(settingsBefore);
  });
});

describe("counter: staff administration and privileged functions", () => {
  it("cannot promote itself or anyone, change profiles, or add or remove staff", async () => {
    expectNotApplied(
      "promote self",
      await counter.client
        .from("staff_profiles")
        .update({ role: "manager" })
        .eq("user_id", counter.id)
        .select(),
    );
    expectNotApplied(
      "deactivate manager",
      await counter.client
        .from("staff_profiles")
        .update({ is_active: false })
        .eq("user_id", manager.id)
        .select(),
    );
    expectDenied(
      "insert profile",
      await counter.client
        .from("staff_profiles")
        .insert({ user_id: randomUUID(), display_name: "x", role: "counter" }),
    );
    expectNotApplied(
      "delete profile",
      await counter.client.from("staff_profiles").delete().eq("user_id", manager.id).select(),
    );

    const rows = must(
      await service
        .from("staff_profiles")
        .select("user_id, role, is_active")
        .in("user_id", [counter.id, manager.id]),
      "profiles",
    );
    expect(rows.find((r) => r.user_id === counter.id)).toMatchObject({
      role: "counter",
      is_active: true,
    });
    expect(rows.find((r) => r.user_id === manager.id)).toMatchObject({
      role: "manager",
      is_active: true,
    });
  });

  it("cannot call the service-role-only functions", async () => {
    expectDenied(
      "counter finalize_paid_order",
      await counter.client.rpc("finalize_paid_order", {
        p_attempt_id: randomUUID(),
        p_gateway_payment_id: "pay_x",
      }),
    );
    expectDenied(
      "counter check_rate_limit",
      await counter.client.rpc("check_rate_limit", {
        p_bucket: `it-${tag}`,
        p_limit: 5,
        p_window_seconds: 60,
      }),
    );
    expectDenied(
      "counter purge_expired_rate_limits",
      await counter.client.rpc("purge_expired_rate_limits"),
    );
  });
});

// ---------------------------------------------------------------------------------------
describe("manager: the menu, tables and settings", () => {
  it("changes prices and names, creates rows and deletes an unused item", async () => {
    const updated = await manager.client
      .from("menu_items")
      .update({ price_paise: 15900, name: "Grilled Sandwich v2" })
      .eq("id", world.menu.item.id)
      .select("price_paise");
    expect(updated.data, describeResult(updated)).toEqual([{ price_paise: 15900 }]);
    must(
      await manager.client
        .from("menu_items")
        .update({ price_paise: 14900, name: "Grilled Sandwich" })
        .eq("id", world.menu.item.id)
        .select(),
      "restore",
    );

    const category = must(
      await manager.client
        .from("menu_categories")
        .insert({ slug: `it-${tag}-m-cat`, name: `IT ${tag} Manager category` })
        .select("id")
        .single(),
      "category",
    );
    tracker.row("menu_categories", category.id);
    const item = must(
      await manager.client
        .from("menu_items")
        .insert({
          category_id: category.id,
          slug: `it-${tag}-m-item`,
          name: "Manager item",
          price_paise: 5000,
        })
        .select("id")
        .single(),
      "item",
    );
    const removed = await manager.client.from("menu_items").delete().eq("id", item.id).select("id");
    expect(removed.data, describeResult(removed)).toEqual([{ id: item.id }]);

    must(
      await manager.client
        .from("modifier_options")
        .update({ price_delta_paise: 3500 })
        .eq("id", world.menu.optionCheese.id)
        .select(),
      "option price",
    );
    must(
      await manager.client
        .from("modifier_options")
        .update({ price_delta_paise: 3000 })
        .eq("id", world.menu.optionCheese.id)
        .select(),
      "restore option price",
    );
    const option = must(
      await manager.client
        .from("modifier_options")
        .insert({ group_id: world.menu.group.id, name: "Jalapenos", price_delta_paise: 1500 })
        .select("id")
        .single(),
      "option",
    );
    tracker.row("modifier_options", option.id);
  });

  it("sees archived and sold-out rows that customers do not", async () => {
    expect(
      must(
        await manager.client.from("menu_items").select("id").eq("id", world.archivedItemId),
        "archived",
      ),
    ).toHaveLength(1);
    expect(
      must(
        await counter.client.from("menu_items").select("id").eq("id", world.archivedItemId),
        "archived",
      ),
    ).toHaveLength(1);
    expect(
      must(
        await anonClient().from("menu_items").select("id").eq("id", world.archivedItemId),
        "archived",
      ),
    ).toEqual([]);
  });

  it("creates, renames and deactivates tables", async () => {
    const created = must(
      await manager.client
        .from("cafe_tables")
        .insert({ code: `MG${tag.toUpperCase()}`, label: "Manager table" })
        .select("id")
        .single(),
      "table",
    );
    tracker.row("cafe_tables", created.id);
    const renamed = await manager.client
      .from("cafe_tables")
      .update({ label: "Renamed", is_active: false })
      .eq("id", created.id)
      .select("label, is_active");
    expect(renamed.data, describeResult(renamed)).toEqual([{ label: "Renamed", is_active: false }]);
  });

  it("edits cafe settings, which customers see immediately (then restores them)", async () => {
    const original = must(
      await service.from("cafe_settings").select("cafe_name, orders_enabled").single(),
      "settings",
    );
    try {
      const changed = await manager.client
        .from("cafe_settings")
        .update({ orders_enabled: false, cafe_name: `Sandwich Express IT ${tag}` })
        .eq("id", 1)
        .select("orders_enabled");
      expect(changed.data, describeResult(changed)).toEqual([{ orders_enabled: false }]);
      const publicView = must(
        await anonClient().from("cafe_settings").select("orders_enabled, cafe_name").single(),
        "public settings",
      );
      expect(publicView.orders_enabled).toBe(false);
    } finally {
      must(
        await service.from("cafe_settings").update(original).eq("id", 1).select(),
        "restore settings",
      );
    }
  });

  it("cannot change immutable settings columns", async () => {
    expectDenied(
      "currency",
      await manager.client.from("cafe_settings").update({ currency: "USD" }).eq("id", 1).select(),
    );
    expectDenied(
      "id",
      await manager.client.from("cafe_settings").update({ id: 2 }).eq("id", 1).select(),
    );
  });
});

describe("manager: orders", () => {
  it("cancels an order with a reason; the audit trail names the manager; payment stays PAID", async () => {
    const order = await world.makeOrder();
    const result = await manager.client
      .from("orders")
      .update({ status: "CANCELLED", cancel_reason: "Kitchen closed" })
      .eq("id", order.orderId)
      .select("status, payment_status");
    // Cancelling must not pretend a refund happened.
    expect(result.data, describeResult(result)).toEqual([
      { status: "CANCELLED", payment_status: "PAID" },
    ]);

    const event = must(
      await manager.client
        .from("order_events")
        .select("actor_kind, actor_user_id, metadata")
        .eq("order_id", order.orderId)
        .eq("to_value", "CANCELLED")
        .single(),
      "cancel event",
    );
    expect(event).toMatchObject({
      actor_kind: "staff",
      actor_user_id: manager.id,
      metadata: { cancel_reason: "Kitchen closed" },
    });
  });

  it("still cannot change payment status or totals", async () => {
    const order = await world.makeOrder();
    const before = await orderRow(order.orderId);
    for (const patch of [
      { payment_status: "REFUNDED" },
      { payment_status: "REFUND_PENDING" },
      { total_paise: 1 },
    ]) {
      expectDenied(
        `manager update ${Object.keys(patch)[0]}`,
        await manager.client.from("orders").update(patch).eq("id", order.orderId).select(),
      );
    }
    expect(await orderRow(order.orderId)).toEqual(before);
  });

  it("cannot delete orders or touch the backend-only tables", async () => {
    const order = await world.makeOrder();
    expectDenied(
      "manager delete order",
      await manager.client.from("orders").delete().eq("id", order.orderId).select(),
    );
    expect(await orderRow(order.orderId)).toMatchObject({ status: "NEW" });
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      expectDenied(
        `manager select ${table}`,
        await manager.client.from(table).select("*").limit(1),
      );
    }
  });

  it("cannot read cart snapshots or call the service-role-only functions", async () => {
    const order = await world.makeOrder();
    expectDenied(
      "manager cart_snapshot",
      await manager.client
        .from("payment_attempts")
        .select("cart_snapshot")
        .eq("id", order.attemptId),
    );
    expectDenied(
      "manager finalize_paid_order",
      await manager.client.rpc("finalize_paid_order", {
        p_attempt_id: order.attemptId,
        p_gateway_payment_id: "pay_by_manager",
      }),
    );
    expectDenied(
      "manager purge_expired_rate_limits",
      await manager.client.rpc("purge_expired_rate_limits"),
    );
  });
});

describe("manager: staff administration", () => {
  it("edits another user's display name, but cannot reassign, add or delete profiles", async () => {
    const renamed = await manager.client
      .from("staff_profiles")
      .update({ display_name: `IT counter ${tag} (renamed)` })
      .eq("user_id", counter.id)
      .select("display_name");
    expect(renamed.data, describeResult(renamed)).toEqual([
      { display_name: `IT counter ${tag} (renamed)` },
    ]);
    must(
      await manager.client
        .from("staff_profiles")
        .update({ display_name: `IT counter ${tag}` })
        .eq("user_id", counter.id)
        .select(),
      "restore",
    );

    expectDenied(
      "reassign profile",
      await manager.client
        .from("staff_profiles")
        .update({ user_id: randomUUID() })
        .eq("user_id", counter.id)
        .select(),
    );
    expectDenied(
      "insert profile",
      await manager.client
        .from("staff_profiles")
        .insert({ user_id: randomUUID(), display_name: "x", role: "counter" }),
    );
    expectDenied(
      "delete profile",
      await manager.client.from("staff_profiles").delete().eq("user_id", counter.id).select(),
    );
  });
});
