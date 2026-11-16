import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { admin, createTestDb, type TestDb } from "@/test/db/db";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe("migrations (smoke)", () => {
  it("creates the expected tables", async () => {
    const rows = await admin(db).all<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
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
    ]);
  });
});
