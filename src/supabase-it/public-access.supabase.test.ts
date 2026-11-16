import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDenied } from "./assertions";
import {
  anonClient,
  createWorld,
  must,
  newRunTag,
  serviceClient,
  Tracker,
  type OrderRef,
  type World,
} from "./harness";
import { describeResult } from "./helpers";

/**
 * What an anonymous customer's browser (anon key only) can and cannot do through the REAL
 * PostgREST API. Menu browsing must work; everything private must be refused.
 */

const tag = newRunTag();
const tracker = new Tracker();
const anon = anonClient();
const service = serviceClient();
let world: World;
let order: OrderRef;

beforeAll(async () => {
  world = await createWorld(tag, tracker);
  order = await world.makeOrder();
});
afterAll(async () => {
  await tracker.cleanup();
});

const SEEDED_ITEMS = [
  "veg-grilled-sandwich",
  "cheese-corn-sandwich",
  "peri-peri-paneer-sandwich",
  "french-fries",
  "cold-coffee",
];

describe("public menu and settings (anon key)", () => {
  it("reads the seeded categories and items", async () => {
    const categories = must(
      await anon
        .from("menu_categories")
        .select("slug, name")
        .in("slug", ["classic-sandwiches", "signature-sandwiches", "sides", "drinks", "extras"]),
      "categories",
    );
    expect(categories.map((c) => c.name).sort()).toEqual([
      "Classic Sandwiches",
      "Drinks",
      "Extras",
      "Sides",
      "Signature Sandwiches",
    ]);

    const items = must(
      await anon.from("menu_items").select("slug, price_paise").in("slug", SEEDED_ITEMS),
      "items",
    );
    expect(items.map((i) => i.slug).sort()).toEqual([...SEEDED_ITEMS].sort());
    for (const item of items) expect(Number.isInteger(item.price_paise)).toBe(true);
  });

  it("shows active items, labels sold-out ones, and hides archived ones", async () => {
    const rows = must(
      await anon.from("menu_items").select("slug, is_available").like("slug", `it-${tag}-%`),
      "fixture items",
    );
    const bySlug = new Map(rows.map((r) => [r.slug as string, r.is_available as boolean]));
    expect(bySlug.get(`it-${tag}-sandwich`)).toBe(true);
    expect(bySlug.get(`it-${tag}-soldout`)).toBe(false); // visible, marked unavailable
    expect(bySlug.has(`it-${tag}-archived`)).toBe(false); // archived: invisible

    const byId = await anon.from("menu_items").select("id").eq("id", world.archivedItemId);
    expect(byId.data, "an archived item cannot even be probed by id").toEqual([]);
  });

  it("reads modifier groups, options and the item-to-group links, but not archived options", async () => {
    const options = must(
      await anon.from("modifier_options").select("name").eq("group_id", world.menu.group.id),
      "options",
    );
    expect(options.map((o) => o.name).sort()).toEqual(["Extra cheese", "Mint mayo"]);
    expect(
      must(await anon.from("modifier_groups").select("id").eq("id", world.menu.group.id), "group"),
    ).toHaveLength(1);
    expect(
      must(
        await anon
          .from("menu_item_modifier_groups")
          .select("item_id")
          .eq("group_id", world.menu.group.id),
        "links",
      ),
    ).toHaveLength(1);

    must(
      await service
        .from("modifier_options")
        .update({ is_active: false })
        .eq("id", world.menu.optionMayo.id)
        .select(),
      "archive option",
    );
    const after = must(
      await anon.from("modifier_options").select("name").eq("group_id", world.menu.group.id),
      "options",
    );
    expect(after.map((o) => o.name)).toEqual(["Extra cheese"]);
    must(
      await service
        .from("modifier_options")
        .update({ is_active: true })
        .eq("id", world.menu.optionMayo.id)
        .select(),
      "restore option",
    );
  });

  it("reads the public settings columns, but only when it names them", async () => {
    const settings = must(
      await anon
        .from("cafe_settings")
        .select("cafe_name, currency, orders_enabled, max_item_quantity, max_items_per_order"),
      "public settings",
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ currency: "INR" });
    expect(typeof settings[0]!.orders_enabled).toBe("boolean");

    expectDenied("select * from cafe_settings", await anon.from("cafe_settings").select("*"));
    expectDenied("settings.timezone", await anon.from("cafe_settings").select("timezone"));
    expectDenied(
      "settings.payment_attempt_ttl_minutes",
      await anon.from("cafe_settings").select("payment_attempt_ttl_minutes"),
    );
  });

  it("can read only the menu columns of an item", async () => {
    expectDenied(
      "menu_items.created_at",
      await anon.from("menu_items").select("created_at").limit(1),
    );
    expectDenied("select * from menu_items", await anon.from("menu_items").select("*").limit(1));
  });
});

describe("everything private is refused to anon", () => {
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
  ])("cannot read %s", async (table) => {
    expectDenied(`anon select ${table}`, await anon.from(table).select("*").limit(1));
  });

  it("cannot write to the menu, tables, settings, orders or staff profiles", async () => {
    const attempts: [
      string,
      PromiseLike<{
        error: { code?: string; message?: string } | null;
        status: number;
        data?: unknown;
      }>,
    ][] = [
      [
        "insert category",
        anon.from("menu_categories").insert({ slug: `it-${tag}-anon`, name: `Anon ${tag}` }),
      ],
      [
        "update item price",
        anon.from("menu_items").update({ price_paise: 1 }).eq("id", world.menu.item.id),
      ],
      ["delete item", anon.from("menu_items").delete().eq("id", world.menu.item.id)],
      ["update settings", anon.from("cafe_settings").update({ orders_enabled: false }).eq("id", 1)],
      [
        "insert table",
        anon.from("cafe_tables").insert({ code: `AN${tag.toUpperCase()}`, label: "Fake" }),
      ],
      [
        "update order status",
        anon.from("orders").update({ status: "SERVED" }).eq("id", order.orderId),
      ],
      [
        "insert order event",
        anon.from("order_events").insert({ order_id: order.orderId, event_type: "STATUS_CHANGED" }),
      ],
      [
        "insert staff profile",
        anon
          .from("staff_profiles")
          .insert({ user_id: randomUUID(), display_name: "x", role: "manager" }),
      ],
    ];
    for (const [what, request] of attempts) expectDenied(`anon ${what}`, await request);

    // Read the truth back as the trusted backend: nothing changed.
    const item = must(
      await service.from("menu_items").select("price_paise").eq("id", world.menu.item.id).single(),
      "item",
    );
    expect(item.price_paise).toBe(14900);
    const row = must(
      await service.from("orders").select("status").eq("id", order.orderId).single(),
      "order",
    );
    expect(row.status).toBe("NEW");
    const created = must(
      await service.from("menu_categories").select("id").eq("slug", `it-${tag}-anon`),
      "category",
    );
    expect(created).toEqual([]);
  });

  it("cannot create tables, so an arbitrary QR value never becomes a table", async () => {
    const code = `QR${tag.toUpperCase()}`;
    expectDenied(
      "anon insert table",
      await anon.from("cafe_tables").insert({ code, label: "Made up" }),
    );
    expect(must(await service.from("cafe_tables").select("id").eq("code", code), "tables")).toEqual(
      [],
    );
  });
});

describe("privileged functions are not callable by anon", () => {
  it("refuses finalize_paid_order, check_rate_limit and purge_expired_rate_limits", async () => {
    expectDenied(
      "anon finalize_paid_order",
      await anon.rpc("finalize_paid_order", {
        p_attempt_id: randomUUID(),
        p_gateway_payment_id: "pay_anon",
      }),
    );
    expectDenied(
      "anon check_rate_limit",
      await anon.rpc("check_rate_limit", {
        p_bucket: `it-${tag}`,
        p_limit: 5,
        p_window_seconds: 60,
      }),
    );
    expectDenied("anon purge_expired_rate_limits", await anon.rpc("purge_expired_rate_limits"));
  });

  it("cannot replay finalize_paid_order for a real attempt, and no second order appears", async () => {
    // The attempt exists and is already finalised, so a caller WITH the privilege would get the
    // existing order back (idempotent replay). A refusal here can therefore only be about privileges.
    const attemptOrder = await world.makeOrder(); // finalised via the service role
    const before = must(
      await service.from("orders").select("id").eq("payment_attempt_id", attemptOrder.attemptId),
      "orders",
    );
    const result = await anon.rpc("finalize_paid_order", {
      p_attempt_id: attemptOrder.attemptId,
      p_gateway_payment_id: "pay_replay_by_anon",
    });
    expectDenied("anon replay of finalize_paid_order", result);
    const after = must(
      await service.from("orders").select("id").eq("payment_attempt_id", attemptOrder.attemptId),
      "orders",
    );
    expect(after).toEqual(before);
  });

  it("does not expose helper functions from the private schema, or the schema itself", async () => {
    for (const fn of ["is_manager", "is_staff", "current_staff_role", "next_order_seq"]) {
      expectDenied(`anon rpc ${fn}`, await anon.rpc(fn));
    }
    const viaSchema = await anon
      .schema("private" as never)
      .from("order_counters")
      .select("*");
    expect(viaSchema.error, "the private schema must not be exposed by the API").not.toBeNull();
    expect(viaSchema.data, describeResult(viaSchema)).toBeNull();
  });
});
