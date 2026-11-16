import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG, admin, createTestDb, pgError, type TestDb } from "@/test/db/db";
import {
  buildSnapshot,
  insertMenu,
  insertStaff,
  insertTable,
  itemLine,
  type CartSnapshot,
  type MenuFixture,
} from "@/test/db/fixtures";

/**
 * Phase 5 on a REAL PostgreSQL 16: create_checkout_attempt / get_checkout_attempt.
 * (Plain PostgreSQL plus the Supabase shim, not PostgREST; the PostgREST/GRANT path is covered
 * by src/supabase-it/checkout-attempts.supabase.test.ts, which needs the real local stack.)
 */

const SERVICE = { role: "service_role" } as const;
const ANON = { role: "anon" } as const;

interface Outcome {
  out_outcome: string;
  out_status: string | null;
  out_amount_paise: number | null;
  out_created_at: Date | null;
  out_expires_at: Date | null;
  out_order_created: boolean | null;
  out_cart_snapshot: CartSnapshot | null;
}

const newKey = () => randomUUID();
const newHash = () => randomBytes(32);

let db: TestDb;
let menu: MenuFixture;
let table: { id: string; code: string; label: string };
let other: { id: string; code: string; label: string };

beforeAll(async () => {
  db = await createTestDb();
  menu = await insertMenu(db);
  table = await insertTable(db, "P5A", "Table P5A");
  other = await insertTable(db, "P5B", "Table P5B");
});
afterAll(async () => {
  await db.close();
});

const cart = (qty = 1, t = table) => buildSnapshot(t, [itemLine(menu, "item", qty)]);

/** Calls the function as the trusted backend, committing (as the real server does). */
async function create(
  key: string,
  snapshot: CartSnapshot,
  options: { tableId?: string; amount?: number; hash?: Buffer; ttl?: number } = {},
): Promise<Outcome> {
  const result = await db.query<Outcome>(
    SERVICE,
    "select * from public.create_checkout_attempt($1, $2, $3, $4, $5, $6)",
    [
      key,
      options.tableId ?? snapshot.table.id,
      options.amount ?? snapshot.total_paise,
      JSON.stringify(snapshot),
      options.hash ?? newHash(),
      options.ttl ?? 30,
    ],
    { commit: true },
  );
  return result.rows[0]!;
}

const attemptsFor = (key: string) =>
  admin(db).all<{ id: string; status: string }>(
    "select id, status from public.payment_attempts where idempotency_key = $1",
    [key],
  );
const orderCount = async () =>
  (await admin(db).one<{ n: number }>("select count(*)::int as n from public.orders")).n;

describe("successful creation", () => {
  it("persists a PENDING attempt with the exact snapshot, amount, table and an expiry", async () => {
    const key = newKey();
    const snapshot = buildSnapshot(table, [itemLine(menu, "item", 2, true)], {
      customer_name: "Asha",
      special_instructions: "No onions",
    });
    const hash = newHash();
    const out = await create(key, snapshot, { hash });

    expect(out.out_outcome).toBe("created");
    expect(out.out_status).toBe("PENDING");
    expect(out.out_order_created).toBe(false);
    // Integer paise: (price + cheese delta) x 2.
    const expected = (menu.item.pricePaise + menu.optionCheese.deltaPaise) * 2;
    expect(out.out_amount_paise).toBe(expected);
    expect(Number.isInteger(out.out_amount_paise)).toBe(true);

    const row = await admin(db).one<{
      idempotency_key: string;
      table_id: string;
      amount_paise: number;
      currency: string;
      status: string;
      gateway_order_id: string | null;
      gateway_payment_id: string | null;
      paid_at: Date | null;
      tracking_token_hash: Buffer;
      cart_snapshot: CartSnapshot;
      created_at: Date;
      expires_at: Date;
    }>("select * from public.payment_attempts where idempotency_key = $1", [key]);
    expect(row.table_id).toBe(table.id);
    expect(row.amount_paise).toBe(expected);
    expect(row.currency).toBe("INR");
    expect(row.status).toBe("PENDING");
    expect(row.gateway_order_id).toBeNull();
    expect(row.gateway_payment_id).toBeNull();
    expect(row.paid_at).toBeNull();
    expect(Buffer.compare(row.tracking_token_hash, hash)).toBe(0);
    expect(row.cart_snapshot).toEqual(snapshot);
    expect(row.cart_snapshot.total_paise).toBe(expected);
    const minutes = (row.expires_at.getTime() - row.created_at.getTime()) / 60000;
    expect(minutes).toBeCloseTo(30, 0);
  });

  it("keeps historical item and option names and per-unit prices in the snapshot", async () => {
    const key = newKey();
    await create(key, buildSnapshot(table, [itemLine(menu, "item", 3, true)]));
    const row = await admin(db).one<{ cart_snapshot: CartSnapshot }>(
      "select cart_snapshot from public.payment_attempts where idempotency_key = $1",
      [key],
    );
    const line = row.cart_snapshot.items[0]!;
    expect(line.item_name).toBe(menu.item.name);
    expect(line.unit_price_paise).toBe(menu.item.pricePaise);
    expect(line.quantity).toBe(3);
    expect(line.options[0]).toMatchObject({
      option_name: menu.optionCheese.name,
      price_delta_paise: menu.optionCheese.deltaPaise,
    });
  });

  it("does not create an order, mark anything paid, or touch the gateway fields", async () => {
    const before = await orderCount();
    const key = newKey();
    const out = await create(key, cart());
    expect(out.out_outcome).toBe("created");
    expect(await orderCount()).toBe(before);
    const [row] = await attemptsFor(key);
    expect(row!.status).toBe("PENDING");
  });
});

describe("get_checkout_attempt", () => {
  it("returns the saved checkout, never an order, and nothing for an unknown key", async () => {
    const key = newKey();
    const snapshot = cart(2);
    await create(key, snapshot);
    const found = await db.query(SERVICE, "select * from public.get_checkout_attempt($1)", [key], {
      commit: true,
    });
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({
      out_status: "PENDING",
      out_amount_paise: snapshot.total_paise,
      out_order_created: false,
    });
    expect(found.rows[0]?.out_cart_snapshot).toEqual(snapshot);

    const none = await db.query(SERVICE, "select * from public.get_checkout_attempt($1)", [
      newKey(),
    ]);
    expect(none.rows).toHaveLength(0);
  });
});

describe("idempotency: sequential", () => {
  it("returns the existing attempt for a repeated identical submission and stores one row", async () => {
    const key = newKey();
    const snapshot = cart(2);
    const first = await create(key, snapshot);
    const second = await create(key, snapshot);
    const third = await create(key, snapshot, { hash: newHash() }); // a different token hash must not matter

    expect(first.out_outcome).toBe("created");
    expect(second.out_outcome).toBe("existing");
    expect(third.out_outcome).toBe("existing");
    expect(second.out_created_at).toEqual(first.out_created_at);
    expect(second.out_expires_at).toEqual(first.out_expires_at);
    expect(second.out_amount_paise).toBe(first.out_amount_paise);
    expect(await attemptsFor(key)).toHaveLength(1);
  });

  it("still answers a replay after the table has been switched off", async () => {
    const t = await insertTable(db, `R${randomBytes(2).toString("hex").toUpperCase()}`);
    const key = newKey();
    const snapshot = cart(1, t);
    expect((await create(key, snapshot)).out_outcome).toBe("created");
    await admin(db).exec("update public.cafe_tables set is_active = false where id = $1", [t.id]);
    expect((await create(key, snapshot)).out_outcome).toBe("existing");
    expect(await attemptsFor(key)).toHaveLength(1);
  });

  it("returns the settled status on a replay (FAILED stays FAILED, nothing is recreated)", async () => {
    const key = newKey();
    const snapshot = cart();
    await create(key, snapshot);
    await db.query(
      SERVICE,
      "update public.payment_attempts set status = 'FAILED', failure_reason = 'expired' where idempotency_key = $1",
      [key],
      { commit: true },
    );
    const replay = await create(key, snapshot);
    expect(replay.out_outcome).toBe("existing");
    expect(replay.out_status).toBe("FAILED");
    expect(await attemptsFor(key)).toHaveLength(1);
  });
});

describe("idempotency: concurrent", () => {
  it("20 simultaneous identical submissions produce exactly one attempt", async () => {
    const key = newKey();
    const snapshot = cart(2);
    const results = await Promise.all(Array.from({ length: 20 }, () => create(key, snapshot)));

    const outcomes = results.map((r) => r.out_outcome);
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "existing")).toHaveLength(19);
    expect(await attemptsFor(key)).toHaveLength(1);
    // Everyone is told about the same attempt.
    expect(new Set(results.map((r) => r.out_created_at?.toISOString())).size).toBe(1);
  });

  it("runs many independent keys in parallel without interference", async () => {
    const keys = Array.from({ length: 12 }, newKey);
    const results = await Promise.all(
      keys.flatMap((key) => [create(key, cart(1)), create(key, cart(1))]),
    );
    expect(results.filter((r) => r.out_outcome === "created")).toHaveLength(12);
    expect(results.filter((r) => r.out_outcome === "existing")).toHaveLength(12);
    for (const key of keys) expect(await attemptsFor(key)).toHaveLength(1);
  });

  it("concurrent submissions of DIFFERENT carts under one key: one winner, the rest rejected, stored cart is the winner's", async () => {
    const key = newKey();
    const carts = [cart(1), cart(2), cart(3), cart(4), cart(5), cart(6)];
    const results = await Promise.all(carts.map((snapshot) => create(key, snapshot)));

    expect(results.filter((r) => r.out_outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.out_outcome === "conflict")).toHaveLength(carts.length - 1);
    expect(await attemptsFor(key)).toHaveLength(1);

    const stored = await admin(db).one<{ cart_snapshot: CartSnapshot }>(
      "select cart_snapshot from public.payment_attempts where idempotency_key = $1",
      [key],
    );
    const winnerIndex = results.findIndex((r) => r.out_outcome === "created");
    expect(stored.cart_snapshot).toEqual(carts[winnerIndex]);
    // A loser never learns what the winning cart contained.
    for (const loser of results.filter((r) => r.out_outcome === "conflict")) {
      expect(loser.out_cart_snapshot).toBeNull();
      expect(loser.out_amount_paise).toBeNull();
    }
  });

  it("a caller that rolls back its insert does not block a waiting duplicate", async () => {
    const key = newKey();
    const snapshot = cart();
    // Transaction A inserts but is rolled back after B has started waiting on the same key.
    const a = db.transaction(SERVICE, async (client) => {
      await client.query("select * from public.create_checkout_attempt($1,$2,$3,$4,$5,30)", [
        key,
        table.id,
        snapshot.total_paise,
        JSON.stringify(snapshot),
        newHash(),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      // returning normally with commit:false rolls the transaction back
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = create(key, snapshot);
    const [, outcome] = await Promise.all([a, b]);
    expect(outcome.out_outcome).toBe("created"); // B inserted after A's rollback released the key
    expect(await attemptsFor(key)).toHaveLength(1);
  });
});

describe("same idempotency key, different cart", () => {
  it.each([
    ["a different quantity", () => cart(2)],
    ["different items", () => buildSnapshot(table, [itemLine(menu, "drink", 1)])],
    [
      "a different customer name",
      () => buildSnapshot(table, [itemLine(menu)], { customer_name: "Eve" }),
    ],
    [
      "different instructions",
      () => buildSnapshot(table, [itemLine(menu)], { special_instructions: "Extra hot" }),
    ],
    ["a different option", () => buildSnapshot(table, [itemLine(menu, "item", 1, true)])],
  ])("is rejected for %s and leaves the original untouched", async (_label, other) => {
    const key = newKey();
    const original = cart(1);
    await create(key, original);
    const clash = await create(key, other());
    expect(clash.out_outcome).toBe("conflict");
    expect(clash.out_cart_snapshot).toBeNull();
    const stored = await admin(db).one<{ cart_snapshot: CartSnapshot; amount_paise: number }>(
      "select cart_snapshot, amount_paise from public.payment_attempts where idempotency_key = $1",
      [key],
    );
    expect(stored.cart_snapshot).toEqual(original);
    expect(stored.amount_paise).toBe(original.total_paise);
    expect(await attemptsFor(key)).toHaveLength(1);
  });

  it("is rejected when the same cart is submitted for a DIFFERENT table", async () => {
    const key = newKey();
    await create(key, cart(1, table));
    const clash = await create(key, cart(1, other));
    expect(clash.out_outcome).toBe("conflict");
    const [row] = await admin(db).all<{ table_id: string }>(
      "select table_id from public.payment_attempts where idempotency_key = $1",
      [key],
    );
    expect(row!.table_id).toBe(table.id);
  });
});

describe("rejections and rollback", () => {
  it("rejects an inactive table and a table that does not exist without writing anything", async () => {
    const t = await insertTable(db, `I${randomBytes(2).toString("hex").toUpperCase()}`);
    await admin(db).exec("update public.cafe_tables set is_active = false where id = $1", [t.id]);
    const key = newKey();
    const inactive = await create(key, cart(1, t));
    expect(inactive.out_outcome).toBe("table_unavailable");
    expect(await attemptsFor(key)).toHaveLength(0);

    const ghost = { id: randomUUID(), code: "GHOST", label: "Ghost" };
    const key2 = newKey();
    const missing = await create(key2, cart(1, ghost));
    expect(missing.out_outcome).toBe("table_unavailable");
    expect(await attemptsFor(key2)).toHaveLength(0);
  });

  it("rejects a snapshot whose table is not the attempt's table", async () => {
    const key = newKey();
    const error = await pgError(create(key, cart(1, table), { tableId: other.id }));
    expect(error.code).toBe(PG.checkViolation);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it("rejects a total that does not equal the amount (a stale or tampered amount)", async () => {
    const key = newKey();
    const snapshot = cart(1);
    const error = await pgError(create(key, snapshot, { amount: snapshot.total_paise - 100 }));
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(/does not equal the payment amount/);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it.each<[string, (s: CartSnapshot) => unknown, RegExp]>([
    [
      "a total that is not the sum of the lines",
      (s) => ({ ...s, total_paise: s.total_paise + 1 }),
      /sum of the lines/,
    ],
    [
      "fractional paise",
      (s) => ({ ...s, items: [{ ...s.items[0], unit_price_paise: 10.5 }] }),
      /whole number of paise/,
    ],
    [
      "a negative option price",
      (s) => ({
        ...s,
        items: [
          {
            ...s.items[0],
            options: [
              {
                ...cart(1, table).items[0]!,
                group_id: randomUUID(),
                group_name: "G",
                option_id: randomUUID(),
                option_name: "O",
                price_delta_paise: -5,
              },
            ],
          },
        ],
      }),
      /./,
    ],
    ["zero quantity", (s) => ({ ...s, items: [{ ...s.items[0], quantity: 0 }] }), /quantity/],
    [
      "more than 99 of an item",
      (s) => ({ ...s, items: [{ ...s.items[0], quantity: 100 }] }),
      /quantity/,
    ],
    ["no items", (s) => ({ ...s, items: [], total_paise: 0 }), /items/],
    ["an unsupported version", (s) => ({ ...s, version: 2 }), /version/],
    [
      "an item id that is not a uuid",
      (s) => ({ ...s, items: [{ ...s.items[0], menu_item_id: "nope" }] }),
      /menu_item_id/,
    ],
    ["an items value that is not an array", (s) => ({ ...s, items: "x" }), /items/],
    ["a snapshot that is not an object", () => [1, 2, 3], /does not match the attempt table/],
  ])("the existing validator rejects %s and nothing is stored", async (_label, mutate, message) => {
    const key = newKey();
    const base = cart(1);
    const bad = mutate(base) as CartSnapshot;
    const error = await pgError(
      db.query(
        SERVICE,
        "select * from public.create_checkout_attempt($1,$2,$3,$4,$5,30)",
        [
          key,
          table.id,
          Number.isInteger(bad?.total_paise) ? bad.total_paise : base.total_paise,
          JSON.stringify(bad),
          newHash(),
        ],
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(message);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it.each([
    ["too short", "short-key"],
    ["too long", "k".repeat(129)],
  ])("rejects an idempotency key that is %s", async (_label, key) => {
    const error = await pgError(create(key, cart()));
    expect(error.code).toBe(PG.invalidParameter);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it("rejects an out-of-range lifetime and a wrong-size token hash", async () => {
    const snapshot = cart();
    expect((await pgError(create(newKey(), snapshot, { ttl: 1 }))).code).toBe(PG.invalidParameter);
    expect((await pgError(create(newKey(), snapshot, { ttl: 241 }))).code).toBe(
      PG.invalidParameter,
    );
    const key = newKey();
    const bad = await pgError(create(key, snapshot, { hash: randomBytes(16) }));
    expect(bad.code).toBe(PG.checkViolation);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it("rejects an amount outside the gateway range", async () => {
    const key = newKey();
    // Rs 0.50 total is below the 100-paise minimum.
    const tiny = buildSnapshot(table, [{ ...itemLine(menu), unit_price_paise: 50, options: [] }]);
    const error = await pgError(create(key, tiny));
    expect(error.code).toBe(PG.checkViolation);
    expect(await attemptsFor(key)).toHaveLength(0);
  });

  it("leaves no partial attempt when the surrounding transaction rolls back", async () => {
    const key = newKey();
    const snapshot = cart();
    await db.transaction(SERVICE, async (client) => {
      const r = await client.query(
        "select * from public.create_checkout_attempt($1,$2,$3,$4,$5,30)",
        [key, table.id, snapshot.total_paise, JSON.stringify(snapshot), newHash()],
      );
      expect(r.rows[0].out_outcome).toBe("created");
    }); // commit defaults to false: rolled back
    expect(await attemptsFor(key)).toHaveLength(0);
    // And the key is immediately usable again.
    expect((await create(key, snapshot)).out_outcome).toBe("created");
  });

  it("a failing statement after a successful create rolls the attempt back with it", async () => {
    const key = newKey();
    const snapshot = cart();
    const error = await pgError(
      db.transaction(
        SERVICE,
        async (client) => {
          await client.query("select * from public.create_checkout_attempt($1,$2,$3,$4,$5,30)", [
            key,
            table.id,
            snapshot.total_paise,
            JSON.stringify(snapshot),
            newHash(),
          ]);
          await client.query("select 1/0");
        },
        { commit: true },
      ),
    );
    expect(error.code).toBe("22012");
    expect(await attemptsFor(key)).toHaveLength(0);
  });
});

describe("immutability and state rules after creation", () => {
  async function fresh() {
    const key = newKey();
    const snapshot = cart(2);
    await create(key, snapshot);
    return { key, snapshot };
  }

  it.each([
    ["cart_snapshot", () => JSON.stringify(cart(5))],
    ["amount_paise", () => 100],
    ["table_id", () => other.id],
    ["idempotency_key", () => newKey()],
    ["tracking_token_hash", () => newHash()],
    ["expires_at", () => new Date(Date.now() + 86400000).toISOString()],
    ["currency", () => "USD"],
  ])("%s cannot be changed", async (column, value) => {
    const { key } = await fresh();
    const cast = column === "cart_snapshot" ? "::jsonb" : "";
    const error = await pgError(
      db.query(
        SERVICE,
        `update public.payment_attempts set ${column} = $1${cast} where idempotency_key = $2`,
        [value(), key],
        { commit: true },
      ),
    );
    expect(error.code, column).toBe(PG.restrictViolation);
  });

  it("cannot be marked PAID without a gateway payment id and paid_at", async () => {
    const { key } = await fresh();
    const error = await pgError(
      db.query(
        SERVICE,
        "update public.payment_attempts set status = 'PAID' where idempotency_key = $1",
        [key],
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("a settled attempt can never return to PENDING or change again", async () => {
    const { key } = await fresh();
    await db.query(
      SERVICE,
      "update public.payment_attempts set status = 'FAILED', failure_reason = 'abandoned' where idempotency_key = $1",
      [key],
      { commit: true },
    );
    for (const sql of [
      "update public.payment_attempts set status = 'PENDING', failure_reason = null where idempotency_key = $1",
      "update public.payment_attempts set status = 'PAID', gateway_payment_id = 'pay_x', paid_at = now(), failure_reason = null where idempotency_key = $1",
    ]) {
      const error = await pgError(db.query(SERVICE, sql, [key], { commit: true }));
      expect([PG.restrictViolation, PG.checkViolation]).toContain(error.code);
    }
    const [row] = await attemptsFor(key);
    expect(row!.status).toBe("FAILED");
  });

  it("a PENDING attempt cannot be inserted as PAID (the trigger forces PENDING)", async () => {
    const snapshot = cart();
    const error = await pgError(
      db.query(
        SERVICE,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, status, gateway_payment_id, paid_at,
            tracking_token_hash, cart_snapshot, expires_at)
         values ($1,$2,$3,'PAID','pay_x',now(),$4,$5, now() + interval '30 minutes')`,
        [newKey(), table.id, snapshot.total_paise, newHash(), JSON.stringify(snapshot)],
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("the unique idempotency key and token-hash indexes are still in force", async () => {
    const key = newKey();
    const hash = newHash();
    const snapshot = cart();
    await create(key, snapshot, { hash });
    const dupKey = await pgError(
      db.query(
        SERVICE,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, tracking_token_hash, cart_snapshot, expires_at)
         values ($1,$2,$3,$4,$5, now() + interval '30 minutes')`,
        [key, table.id, snapshot.total_paise, newHash(), JSON.stringify(snapshot)],
        { commit: true },
      ),
    );
    expect(dupKey.code).toBe(PG.uniqueViolation);
    const dupHash = await pgError(
      db.query(
        SERVICE,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, tracking_token_hash, cart_snapshot, expires_at)
         values ($1,$2,$3,$4,$5, now() + interval '30 minutes')`,
        [newKey(), table.id, snapshot.total_paise, hash, JSON.stringify(snapshot)],
        { commit: true },
      ),
    );
    expect(dupHash.code).toBe(PG.uniqueViolation);
  });
});

describe("no paid order without verified payment", () => {
  it("an order cannot be inserted for a PENDING attempt (the only path is finalize_paid_order)", async () => {
    const key = newKey();
    const snapshot = cart();
    await create(key, snapshot);
    const [row] = await attemptsFor(key);
    const error = await pgError(
      admin(db).exec(
        `insert into public.orders (business_date, daily_seq, order_number, payment_attempt_id,
           tracking_token_hash, table_id, table_code, table_label, total_paise, payment_status)
         select '2026-01-01', 1, 'SE-001', id, tracking_token_hash, table_id, 'P5A', 'Table P5A', amount_paise, 'PENDING'
           from public.payment_attempts where id = $1`,
        [row!.id],
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("creating, replaying and reading attempts never produces an order", async () => {
    const before = await orderCount();
    const key = newKey();
    const snapshot = cart(3);
    await create(key, snapshot);
    await create(key, snapshot);
    await db.query(SERVICE, "select * from public.get_checkout_attempt($1)", [key]);
    expect(await orderCount()).toBe(before);
  });
});

describe("unauthorised access", () => {
  it("anon and signed-in users cannot call either function", async () => {
    const managerId = await insertStaff(db, "manager");
    const snapshot = cart();
    for (const actor of [ANON, { role: "authenticated", userId: managerId } as const]) {
      const create1 = await pgError(
        db.query(actor, "select * from public.create_checkout_attempt($1,$2,$3,$4,$5,30)", [
          newKey(),
          table.id,
          snapshot.total_paise,
          JSON.stringify(snapshot),
          newHash(),
        ]),
      );
      expect(create1.code).toBe(PG.insufficientPrivilege);
      const read = await pgError(
        db.query(actor, "select * from public.get_checkout_attempt($1)", [newKey()]),
      );
      expect(read.code).toBe(PG.insufficientPrivilege);
    }
  });

  it("anon cannot read, insert into or update payment_attempts directly", async () => {
    const key = newKey();
    await create(key, cart());
    for (const sql of [
      "select id from public.payment_attempts",
      "select cart_snapshot from public.payment_attempts",
      "update public.payment_attempts set failure_reason = null",
      "delete from public.payment_attempts",
    ]) {
      const error = await pgError(db.query(ANON, sql));
      expect(error.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("staff cannot read another customer's snapshot or tracking hash, and cannot write attempts", async () => {
    const counterId = await insertStaff(db, "counter");
    const actor = { role: "authenticated", userId: counterId } as const;
    for (const sql of [
      "select cart_snapshot from public.payment_attempts",
      "select tracking_token_hash from public.payment_attempts",
      "select idempotency_key from public.payment_attempts",
      "update public.payment_attempts set status = 'FAILED'",
      "delete from public.payment_attempts",
    ]) {
      const error = await pgError(db.query(actor, sql));
      expect(error.code, sql).toBe(PG.insufficientPrivilege);
    }
  });

  it("the functions are not executable by PUBLIC", async () => {
    const rows = await admin(db).all<{
      proname: string;
      anon: boolean;
      auth: boolean;
      svc: boolean;
    }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute')          as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute')  as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('create_checkout_attempt', 'get_checkout_attempt')
        order by 1`,
    );
    expect(rows).toEqual([
      { proname: "create_checkout_attempt", anon: false, auth: false, svc: true },
      { proname: "get_checkout_attempt", anon: false, auth: false, svc: true },
    ]);
  });
});
