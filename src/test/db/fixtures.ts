import { randomBytes, randomUUID } from "node:crypto";

import { generateTrackingToken, hashTrackingToken } from "@/lib/security/tracking-token";

import { admin, type TestDb } from "./db";
import {
  buildSnapshot,
  itemLine,
  snapshotTotal,
  type CartSnapshot,
  type MenuFixture,
  type SnapshotItem,
  type SnapshotOption,
} from "../snapshot";

export { buildSnapshot, itemLine, snapshotTotal };
export type { CartSnapshot, MenuFixture, SnapshotItem, SnapshotOption };

export type StaffRole = "manager" | "counter";

export async function insertStaff(db: TestDb, role: StaffRole, name = `${role} user`) {
  const userId = randomUUID();
  await admin(db).exec("insert into auth.users (id, email) values ($1, $2)", [
    userId,
    `${userId}@example.test`,
  ]);
  await admin(db).exec(
    "insert into public.staff_profiles (user_id, display_name, role) values ($1, $2, $3)",
    [userId, name, role],
  );
  return userId;
}

/** An authenticated user WITHOUT a staff profile (e.g. a customer who somehow signed in). */
export async function insertPlainUser(db: TestDb) {
  const userId = randomUUID();
  await admin(db).exec("insert into auth.users (id, email) values ($1, $2)", [
    userId,
    `${userId}@example.test`,
  ]);
  return userId;
}

export async function insertTable(db: TestDb, code = "T01", label = "Table 1") {
  const row = await admin(db).one<{ id: string }>(
    "insert into public.cafe_tables (code, label) values ($1, $2) returning id",
    [code, label],
  );
  return { id: row.id, code, label };
}

/** A tiny but complete menu: one category, two items, one modifier group with two options. */
export async function insertMenu(db: TestDb): Promise<MenuFixture> {
  const a = admin(db);
  const unique = randomBytes(3).toString("hex");

  const category = await a.one<{ id: string }>(
    "insert into public.menu_categories (slug, name) values ($1, $2) returning id",
    [`fx-cat-${unique}`, `Fixture ${unique}`],
  );
  const item = await a.one<{ id: string }>(
    `insert into public.menu_items (category_id, slug, name, price_paise)
     values ($1, $2, 'Grilled Sandwich', 14900) returning id`,
    [category.id, `fx-item-${unique}`],
  );
  const drink = await a.one<{ id: string }>(
    `insert into public.menu_items (category_id, slug, name, price_paise)
     values ($1, $2, 'Cold Coffee', 11900) returning id`,
    [category.id, `fx-drink-${unique}`],
  );
  const groupName = `Extras ${unique}`;
  const group = await a.one<{ id: string }>(
    "insert into public.modifier_groups (slug, name, max_select) values ($1, $2, 3) returning id",
    [`fx-group-${unique}`, groupName],
  );
  const cheese = await a.one<{ id: string }>(
    `insert into public.modifier_options (group_id, name, price_delta_paise)
     values ($1, 'Extra cheese', 3000) returning id`,
    [group.id],
  );
  const mayo = await a.one<{ id: string }>(
    `insert into public.modifier_options (group_id, name, price_delta_paise)
     values ($1, 'Mint mayo', 0) returning id`,
    [group.id],
  );
  await a.exec("insert into public.menu_item_modifier_groups (item_id, group_id) values ($1, $2)", [
    item.id,
    group.id,
  ]);

  return {
    categoryId: category.id,
    categoryName: `Fixture ${unique}`,
    item: { id: item.id, name: "Grilled Sandwich", pricePaise: 14900 },
    drink: { id: drink.id, name: "Cold Coffee", pricePaise: 11900 },
    group: { id: group.id, name: groupName },
    optionCheese: { id: cheese.id, name: "Extra cheese", deltaPaise: 3000 },
    optionMayo: { id: mayo.id, name: "Mint mayo", deltaPaise: 0 },
  };
}

export interface AttemptFixture {
  attemptId: string;
  token: string;
  tokenHash: Buffer;
  gatewayOrderId: string;
  snapshot: CartSnapshot;
}

/** Inserts a PENDING payment attempt the way the checkout endpoint will (as service_role). */
export async function insertAttempt(
  db: TestDb,
  tableId: string,
  snapshot: CartSnapshot,
  overrides: { expiresInMinutes?: number } = {},
): Promise<AttemptFixture> {
  const token = generateTrackingToken();
  const tokenHash = hashTrackingToken(token);
  const gatewayOrderId = `order_fx${randomBytes(6).toString("hex")}`;
  const result = await db.query<{ id: string }>(
    { role: "service_role" },
    `insert into public.payment_attempts
       (idempotency_key, table_id, amount_paise, gateway_order_id, tracking_token_hash,
        cart_snapshot, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     returning id`,
    [
      randomBytes(16).toString("hex"),
      tableId,
      snapshot.total_paise,
      gatewayOrderId,
      tokenHash,
      JSON.stringify(snapshot),
      overrides.expiresInMinutes ?? 30,
    ],
    { commit: true },
  );
  return { attemptId: result.rows[0]!.id, token, tokenHash, gatewayOrderId, snapshot };
}

export interface FinalizeRow {
  out_order_id: string;
  out_order_number: string;
  out_business_date: string;
  out_created: boolean;
}

export async function finalize(db: TestDb, attemptId: string, gatewayPaymentId: string) {
  const result = await db.query<FinalizeRow>(
    { role: "service_role" },
    "select * from public.finalize_paid_order($1, $2)",
    [attemptId, gatewayPaymentId],
    { commit: true },
  );
  return result.rows[0]!;
}

/** Convenience: table + menu + attempt + finalised order, returning every id. */
export async function insertPaidOrder(db: TestDb, options: { cheese?: boolean } = {}) {
  const table = await insertTable(
    db,
    `T${randomBytes(2).toString("hex").toUpperCase()}`,
    "Fixture table",
  );
  const menu = await insertMenu(db);
  const snapshot = buildSnapshot(table, [
    itemLine(menu, "item", 2, options.cheese ?? true),
    itemLine(menu, "drink", 1),
  ]);
  const attempt = await insertAttempt(db, table.id, snapshot);
  const order = await finalize(db, attempt.attemptId, `pay_fx${randomBytes(6).toString("hex")}`);
  return { table, menu, snapshot, attempt, order };
}
