import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  canTransitionOrder,
  canTransitionPayment,
} from "@/lib/orders/status";
import { hashTrackingToken } from "@/lib/security/tracking-token";
import { PG, admin, createTestDb, pgError, type TestDb } from "@/test/db/db";
import {
  buildSnapshot,
  finalize,
  insertAttempt,
  insertMenu,
  insertPaidOrder,
  insertTable,
  itemLine,
} from "@/test/db/fixtures";

const POSTGRES = { role: "postgres" } as const;
const SERVICE = { role: "service_role" } as const;

const opened: TestDb[] = [];
async function freshDb() {
  const db = await createTestDb();
  opened.push(db);
  return db;
}
/**
 * Closes (pool + database) every database opened so far. The describe blocks in this file run one
 * after another and never share a database, so each one calls this when it finishes. Without it
 * all 16 pools stay open until the end of the file, and the connections they hold (plus the ~20
 * the rate-limit burst opens) can exhaust `max_connections` on a shared server such as the local
 * Supabase database ("remaining connection slots are reserved for roles with the SUPERUSER
 * attribute").
 */
async function closeOpened() {
  await Promise.all(opened.splice(0).map((db) => db.close()));
}
afterAll(closeOpened); // safety net for a describe that failed before its own cleanup

const payId = () => `pay_fx${randomBytes(6).toString("hex")}`;

/** Counts rows with a given SQL condition, as a number. */
async function count(db: TestDb, from: string, where = "true", params: unknown[] = []) {
  const row = await admin(db).one<{ n: number }>(
    `select count(*)::int as n from ${from} where ${where}`,
    params,
  );
  return row.n;
}

describe("finalize_paid_order: happy path", () => {
  let db: TestDb;
  afterAll(closeOpened);
  let paid: Awaited<ReturnType<typeof insertPaidOrder>>;
  beforeAll(async () => {
    db = await freshDb();
    paid = await insertPaidOrder(db, { cheese: true });
  });

  it("creates a NEW, PAID order with a daily order number", async () => {
    const order = await admin(db).one<Record<string, unknown>>(
      "select * from public.orders where id = $1",
      [paid.order.out_order_id],
    );
    expect(order).toMatchObject({
      status: "NEW",
      payment_status: "PAID",
      order_number: "SE-001",
      daily_seq: 1,
      currency: "INR",
      table_code: paid.table.code,
      table_label: paid.table.label,
    });
    expect(paid.order.out_order_number).toBe("SE-001");
    expect(paid.order.out_created).toBe(true);
  });

  it("totals exactly what the snapshot priced, in integer paise", async () => {
    // 2 x (14900 + 3000 cheese) + 1 x 11900 = 47700
    expect(paid.snapshot.total_paise).toBe(47700);
    const order = await admin(db).one<{ total_paise: number }>(
      "select total_paise from public.orders where id = $1",
      [paid.order.out_order_id],
    );
    expect(order.total_paise).toBe(47700);
  });

  it("copies every line, option and price into order_items", async () => {
    const items = await admin(db).all<{
      line_no: number;
      item_name: string;
      unit_price_paise: number;
      options_unit_paise: number;
      quantity: number;
      line_total_paise: number;
      options: Array<{ option_name: string; price_delta_paise: number }>;
    }>("select * from public.order_items where order_id = $1 order by line_no", [
      paid.order.out_order_id,
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      line_no: 1,
      item_name: "Grilled Sandwich",
      unit_price_paise: 14900,
      options_unit_paise: 3000,
      quantity: 2,
      line_total_paise: 35800,
    });
    expect(items[0]!.options).toHaveLength(1);
    expect(items[0]!.options[0]).toMatchObject({
      option_name: "Extra cheese",
      price_delta_paise: 3000,
    });
    expect(items[1]).toMatchObject({
      line_no: 2,
      item_name: "Cold Coffee",
      line_total_paise: 11900,
    });
  });

  it("marks the attempt PAID with the gateway payment id and paid_at", async () => {
    const attempt = await admin(db).one<{
      status: string;
      gateway_payment_id: string;
      paid_at: Date;
    }>("select status, gateway_payment_id, paid_at from public.payment_attempts where id = $1", [
      paid.attempt.attemptId,
    ]);
    expect(attempt.status).toBe("PAID");
    expect(attempt.gateway_payment_id).toMatch(/^pay_fx/);
    expect(attempt.paid_at).toBeInstanceOf(Date);
  });

  it("records an ORDER_PLACED audit event", async () => {
    const events = await admin(db).all<{
      event_type: string;
      to_value: string;
      actor_kind: string;
    }>("select event_type, to_value, actor_kind from public.order_events where order_id = $1", [
      paid.order.out_order_id,
    ]);
    expect(events).toEqual([{ event_type: "ORDER_PLACED", to_value: "NEW", actor_kind: "system" }]);
  });

  it("stores only the SHA-256 hash of the tracking token, never the token", async () => {
    const row = await admin(db).one<{ stored: string; db_hash: string }>(
      `select encode(o.tracking_token_hash, 'hex') as stored,
              encode(sha256(convert_to($1, 'UTF8')), 'hex') as db_hash
         from public.orders o where o.id = $2`,
      [paid.attempt.token, paid.order.out_order_id],
    );
    expect(row.stored).toBe(row.db_hash); // the database computes the same hash
    expect(row.stored).toBe(hashTrackingToken(paid.attempt.token).toString("hex")); // and so does the app

    const leaks = await admin(db).one<{ n: number }>(
      `select count(*)::int as n from (
         select to_jsonb(o)::text as t from public.orders o
         union all select to_jsonb(pa)::text from public.payment_attempts pa
         union all select to_jsonb(oi)::text from public.order_items oi
         union all select to_jsonb(oe)::text from public.order_events oe
       ) x where t like '%' || $1 || '%'`,
      [paid.attempt.token],
    );
    expect(leaks.n).toBe(0);
  });
});

describe("finalize_paid_order: idempotency and duplicate protection", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });

  it("returns the same order for a repeated call (webhook retry / browser + webhook)", async () => {
    const table = await insertTable(db, "I01");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const payment = payId();

    const first = await finalize(db, attempt.attemptId, payment);
    const second = await finalize(db, attempt.attemptId, payment);
    const third = await finalize(db, attempt.attemptId, `  ${payment}  `); // whitespace is trimmed

    expect(first.out_created).toBe(true);
    expect(second.out_created).toBe(false);
    expect(third.out_created).toBe(false);
    expect(second.out_order_id).toBe(first.out_order_id);
    expect(third.out_order_id).toBe(first.out_order_id);
    expect(second.out_order_number).toBe(first.out_order_number);

    expect(await count(db, "public.orders", "payment_attempt_id = $1", [attempt.attemptId])).toBe(
      1,
    );
    expect(await count(db, "public.order_items", "order_id = $1", [first.out_order_id])).toBe(1);
    expect(await count(db, "public.order_events", "order_id = $1", [first.out_order_id])).toBe(1);
  });

  it("rejects a different payment id for an already-finalised attempt", async () => {
    const table = await insertTable(db, "I02");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    await finalize(db, attempt.attemptId, payId());

    const error = await pgError(finalize(db, attempt.attemptId, payId()));
    expect(error.code).toBe(PG.restrictViolation);
    expect(await count(db, "public.orders", "payment_attempt_id = $1", [attempt.attemptId])).toBe(
      1,
    );
  });

  it("never lets one gateway payment be linked to two attempts, and leaves no half-created order", async () => {
    const table = await insertTable(db, "I03");
    const menu = await insertMenu(db);
    const attemptA = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const attemptB = await insertAttempt(
      db,
      table.id,
      buildSnapshot(table, [itemLine(menu, "drink")]),
    );
    const shared = payId();

    const ordersBefore = await count(db, "public.orders");
    await finalize(db, attemptA.attemptId, shared);
    const error = await pgError(finalize(db, attemptB.attemptId, shared));
    expect(error.code).toBe(PG.uniqueViolation);

    // The failed call rolled back completely: no order, no items, attempt B still PENDING.
    expect(await count(db, "public.orders")).toBe(ordersBefore + 1);
    expect(await count(db, "public.orders", "payment_attempt_id = $1", [attemptB.attemptId])).toBe(
      0,
    );
    const b = await admin(db).one<{ status: string; gateway_payment_id: string | null }>(
      "select status, gateway_payment_id from public.payment_attempts where id = $1",
      [attemptB.attemptId],
    );
    expect(b).toEqual({ status: "PENDING", gateway_payment_id: null });
  });

  it("creates exactly one order when finalisation races with itself (8 parallel calls)", async () => {
    const table = await insertTable(db, "I04");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(
      db,
      table.id,
      buildSnapshot(table, [itemLine(menu, "item", 3)]),
    );
    const payment = payId();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => finalize(db, attempt.attemptId, payment)),
    );

    expect(new Set(results.map((r) => r.out_order_id)).size).toBe(1);
    expect(results.filter((r) => r.out_created)).toHaveLength(1);
    expect(await count(db, "public.orders", "payment_attempt_id = $1", [attempt.attemptId])).toBe(
      1,
    );
    expect(await count(db, "public.order_items", "order_id = $1", [results[0]!.out_order_id])).toBe(
      1,
    );
  });

  it("refuses attempts that are not payable, with a distinct error", async () => {
    const table = await insertTable(db, "I05");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    await db.query(
      SERVICE,
      "update public.payment_attempts set status = 'FAILED', failure_reason = 'expired' where id = $1",
      [attempt.attemptId],
      { commit: true },
    );
    const error = await pgError(finalize(db, attempt.attemptId, payId()));
    expect(error.code).toBe(PG.objectNotInPrerequisiteState);
    expect(await count(db, "public.orders", "payment_attempt_id = $1", [attempt.attemptId])).toBe(
      0,
    );
  });

  it("rejects unknown attempts and blank payment ids", async () => {
    const unknown = await pgError(finalize(db, "00000000-0000-4000-8000-000000000000", payId()));
    expect(unknown.code).toBe(PG.noDataFound);

    const table = await insertTable(db, "I06");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    for (const blank of ["", "   "]) {
      const error = await pgError(finalize(db, attempt.attemptId, blank));
      expect(error.code, JSON.stringify(blank)).toBe(PG.invalidParameter);
    }
  });
});

describe("order numbers", () => {
  afterEach(closeOpened); // each test here opens its own database
  it("are sequential and gapless, and exactly unique under 25 parallel finalisations", async () => {
    const db = await freshDb();
    const table = await insertTable(db, "N01");
    const menu = await insertMenu(db);
    const attempts = [];
    for (let i = 0; i < 25; i++) {
      attempts.push(await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)])));
    }

    const results = await Promise.all(attempts.map((a) => finalize(db, a.attemptId, payId())));

    const numbers = results.map((r) => r.out_order_number).sort();
    const expected = Array.from({ length: 25 }, (_, i) => `SE-${String(i + 1).padStart(3, "0")}`);
    expect(numbers).toEqual(expected);
    expect(await count(db, "public.orders")).toBe(25);

    const counter = await admin(db).one<{ last_seq: number }>(
      "select last_seq from public.order_counters",
    );
    expect(counter.last_seq).toBe(25);
  });

  it("leave no gap when a finalisation fails and rolls back", async () => {
    const db = await freshDb();
    const table = await insertTable(db, "N02");
    const menu = await insertMenu(db);
    const shared = payId();
    const a1 = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const a2 = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const a3 = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));

    expect((await finalize(db, a1.attemptId, shared)).out_order_number).toBe("SE-001");
    await pgError(finalize(db, a2.attemptId, shared)); // duplicate payment id -> rolls back
    expect((await finalize(db, a3.attemptId, payId())).out_order_number).toBe("SE-002");
  });

  it("do not truncate at 1000 (SQL lpad would turn 1000 into 100)", async () => {
    const db = await freshDb();
    const table = await insertTable(db, "N03");
    const menu = await insertMenu(db);
    await admin(db).exec(
      "insert into public.order_counters (business_date, last_seq) values ((now() at time zone 'Asia/Kolkata')::date, 998)",
    );
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
      numbers.push((await finalize(db, attempt.attemptId, payId())).out_order_number);
    }
    expect(numbers).toEqual(["SE-999", "SE-1000", "SE-1001"]);
  });

  it("restart every business day, and the day follows the configured time zone", async () => {
    const db = await freshDb();
    const table = await insertTable(db, "N04");
    const menu = await insertMenu(db);

    // UTC+14 and UTC-11 are 25 hours apart, so their calendar dates ALWAYS differ.
    const dates: Record<string, string> = {};
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await admin(db).exec("update public.cafe_settings set timezone = $1", [zone]);
      const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
      const result = await finalize(db, attempt.attemptId, payId());
      expect(result.out_order_number, zone).toBe("SE-001"); // each day starts again at 001
      const row = await admin(db).one<{ business_date: string; expected: string }>(
        `select to_char(o.business_date, 'YYYY-MM-DD') as business_date,
                to_char((now() at time zone $2)::date, 'YYYY-MM-DD') as expected
           from public.orders o where o.id = $1`,
        [result.out_order_id, zone],
      );
      expect(row.business_date, zone).toBe(row.expected);
      dates[zone] = row.business_date;
    }
    expect(dates["Pacific/Kiritimati"]).not.toBe(dates["Pacific/Pago_Pago"]);
  });

  it("are unique per (business_date, order_number) and (business_date, daily_seq) in the schema", async () => {
    const db = await freshDb();
    const rows = await admin(db).all<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.orders'::regclass and contype = 'u' order by 1`,
    );
    const defs = rows.map((r) => r.def);
    expect(defs).toContain("UNIQUE (business_date, order_number)");
    expect(defs).toContain("UNIQUE (business_date, daily_seq)");
    expect(defs).toContain("UNIQUE (payment_attempt_id)");
    expect(defs).toContain("UNIQUE (tracking_token_hash)");
  });
});

describe("cart snapshot validation (payment attempts)", () => {
  let db: TestDb;
  afterAll(closeOpened);
  let table: Awaited<ReturnType<typeof insertTable>>;
  let menu: Awaited<ReturnType<typeof insertMenu>>;
  beforeAll(async () => {
    db = await freshDb();
    table = await insertTable(db, "S01");
    menu = await insertMenu(db);
  });

  async function tryInsert(
    mutate: (snapshot: ReturnType<typeof buildSnapshot>) => unknown,
    amount?: number,
  ) {
    const snapshot = buildSnapshot(table, [itemLine(menu, "item", 2, true)]);
    const tampered = mutate(structuredClone(snapshot)) ?? snapshot;
    return pgError(
      insertAttempt(db, table.id, {
        ...(tampered as typeof snapshot),
        total_paise: amount ?? (tampered as typeof snapshot).total_paise,
      }),
    );
  }

  it("accepts an honest snapshot", async () => {
    await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu, "item", 2, true)]));
  });

  it("rejects a total that does not equal the sum of the lines", async () => {
    const error = await tryInsert(() => undefined, 100);
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(/total_paise does not equal the sum/);
  });

  it("rejects a payment amount that differs from the snapshot total", async () => {
    const snapshot = buildSnapshot(table, [itemLine(menu)]);
    const error = await pgError(
      db.query(
        SERVICE,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, tracking_token_hash, cart_snapshot, expires_at)
         values ($1, $2, $3, sha256('x'), $4, now() + interval '30 minutes')`,
        [
          randomBytes(16).toString("hex"),
          table.id,
          snapshot.total_paise + 1,
          JSON.stringify(snapshot),
        ],
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(/does not equal the payment amount/);
  });

  it.each([
    [
      "a fractional unit price (149.5 paise)",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.unit_price_paise = 149.5;
      },
    ],
    [
      "a fractional option price",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.options[0]!.price_delta_paise = 0.5;
      },
    ],
    [
      "a price given as a string",
      (s: ReturnType<typeof buildSnapshot>) => {
        (s.items[0] as unknown as Record<string, unknown>).unit_price_paise = "14900";
      },
    ],
    [
      "a negative price",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.unit_price_paise = -100;
      },
    ],
    [
      "a negative option price",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.options[0]!.price_delta_paise = -3000;
      },
    ],
    [
      "quantity 0",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.quantity = 0;
      },
    ],
    [
      "quantity 100",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.quantity = 100;
      },
    ],
    [
      "a fractional quantity",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.quantity = 1.5;
      },
    ],
    [
      "no items",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items = [];
      },
    ],
    [
      "an unknown version",
      (s: ReturnType<typeof buildSnapshot>) => {
        (s as unknown as Record<string, unknown>).version = 2;
      },
    ],
    [
      "a malformed menu_item_id",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.menu_item_id = "not-a-uuid";
      },
    ],
    [
      "an empty item name",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.items[0]!.item_name = "  ";
      },
    ],
    [
      "an over-long customer name",
      (s: ReturnType<typeof buildSnapshot>) => {
        s.customer_name = "x".repeat(61);
      },
    ],
    [
      "a missing table",
      (s: ReturnType<typeof buildSnapshot>) => {
        (s as unknown as Record<string, unknown>).table = null;
      },
    ],
  ])("rejects %s", async (_label, mutate) => {
    const snapshot = buildSnapshot(table, [itemLine(menu, "item", 2, true)]);
    mutate(snapshot);
    // Keep the arithmetic self-consistent where possible, so the rejection is for the
    // specific problem and not merely a total mismatch.
    const error = await pgError(insertAttempt(db, table.id, { ...snapshot, total_paise: 47700 }));
    expect(error.code).toBe(PG.checkViolation);
  });

  it("does not let the snapshot or amount be edited after creation", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    for (const [column, value] of [
      ["cart_snapshot", JSON.stringify({ tampered: true })],
      ["amount_paise", 100],
      ["table_id", (await insertTable(db, "S02")).id],
      ["tracking_token_hash", Buffer.alloc(32, 1)],
      ["idempotency_key", "x".repeat(32)],
    ] as const) {
      const error = await pgError(
        db.query(
          SERVICE,
          `update public.payment_attempts set ${column} = $1 where id = $2`,
          [value, attempt.attemptId],
          {
            commit: true,
          },
        ),
      );
      expect(error.code, column).toBe(PG.restrictViolation);
    }
  });
});

describe("payment attempt state rules", () => {
  let db: TestDb;
  afterAll(closeOpened);
  let table: Awaited<ReturnType<typeof insertTable>>;
  let menu: Awaited<ReturnType<typeof insertMenu>>;
  beforeAll(async () => {
    db = await freshDb();
    table = await insertTable(db, "P01");
    menu = await insertMenu(db);
  });
  const update = (sql: string, params: unknown[]) =>
    db.query(SERVICE, sql, params, { commit: true });

  it("makes gateway_order_id write-once", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const error = await pgError(
      update("update public.payment_attempts set gateway_order_id = 'order_other' where id = $1", [
        attempt.attemptId,
      ]),
    );
    expect(error.code).toBe(PG.restrictViolation);
  });

  it("allows only one attempt per gateway order id", async () => {
    const a1 = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const a2 = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    await update(
      "update public.payment_attempts set gateway_order_id = 'order_unique_1' where id = $1 and gateway_order_id is not null",
      [a1.attemptId],
    ).catch(() => {});
    const row = await admin(db).one<{ gateway_order_id: string }>(
      "select gateway_order_id from public.payment_attempts where id = $1",
      [a1.attemptId],
    );
    const error = await pgError(
      db.query(
        POSTGRES,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, gateway_order_id, tracking_token_hash, cart_snapshot, expires_at)
         values ($1, $2, $3, $4, sha256('y'), $5, now() + interval '30 minutes')`,
        [
          randomBytes(16).toString("hex"),
          table.id,
          a2.snapshot.total_paise,
          row.gateway_order_id,
          JSON.stringify(a2.snapshot),
        ],
      ),
    );
    expect(error.code).toBe(PG.uniqueViolation);
  });

  it("makes the idempotency key unique, so a double-submit cannot create two attempts", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const existing = await admin(db).one<{ idempotency_key: string }>(
      "select idempotency_key from public.payment_attempts where id = $1",
      [attempt.attemptId],
    );
    const error = await pgError(
      db.query(
        POSTGRES,
        `insert into public.payment_attempts
           (idempotency_key, table_id, amount_paise, tracking_token_hash, cart_snapshot, expires_at)
         values ($1, $2, $3, sha256('z'), $4, now() + interval '30 minutes')`,
        [
          existing.idempotency_key,
          table.id,
          attempt.snapshot.total_paise,
          JSON.stringify(attempt.snapshot),
        ],
      ),
    );
    expect(error.code).toBe(PG.uniqueViolation);
  });

  it("allows PENDING -> FAILED with a reason, and then nothing more", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    await update(
      "update public.payment_attempts set status = 'FAILED', failure_reason = 'expired' where id = $1",
      [attempt.attemptId],
    );
    const reopen = await pgError(
      update(
        "update public.payment_attempts set status = 'PENDING', failure_reason = null where id = $1",
        [attempt.attemptId],
      ),
    );
    expect(reopen.code).toBe(PG.restrictViolation);
  });

  it("cannot be marked PAID without a payment id and timestamp (the paid-consistency check)", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const error = await pgError(
      update("update public.payment_attempts set status = 'PAID' where id = $1", [
        attempt.attemptId,
      ]),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("freezes a PAID attempt", async () => {
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    await finalize(db, attempt.attemptId, payId());
    const error = await pgError(
      update(
        "update public.payment_attempts set failure_reason = null, gateway_payment_id = 'pay_swapped' where id = $1",
        [attempt.attemptId],
      ),
    );
    expect(error.code).toBe(PG.restrictViolation);
  });

  it("only accepts amounts the gateway can charge (at least 100 paise)", async () => {
    const tiny = buildSnapshot(table, [{ ...itemLine(menu, "drink"), unit_price_paise: 50 }]);
    const error = await pgError(insertAttempt(db, table.id, tiny));
    expect(error.code).toBe(PG.checkViolation);
  });
});

describe("unpaid orders cannot exist", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });

  async function orderInsert(overrides: Record<string, unknown>) {
    const table = await insertTable(db, `U${randomBytes(2).toString("hex").toUpperCase()}`);
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const cols = {
      business_date: "2026-01-01",
      daily_seq: 1,
      order_number: "SE-001",
      payment_attempt_id: attempt.attemptId,
      tracking_token_hash: attempt.tokenHash,
      table_id: table.id,
      table_code: table.code,
      table_label: table.label,
      total_paise: 14900,
      ...overrides,
    };
    const names = Object.keys(cols);
    return db.query(
      POSTGRES,
      `insert into public.orders (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(cols),
    );
  }

  it.each(["PENDING", "FAILED"])("rejects an order with payment_status %s", async (status) => {
    const error = await pgError(orderInsert({ payment_status: status }));
    expect(error.code).toBe(PG.checkViolation);
  });

  it("rejects an order that has no items at commit time", async () => {
    const error = await pgError(
      db.transaction(
        POSTGRES,
        (client) =>
          // Need the deferred constraint to fire: commit instead of rolling back.
          (async () => {
            await orderInsertWith(client);
          })(),
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(/has no items/);

    async function orderInsertWith(client: import("pg").PoolClient) {
      const table = await insertTable(db, "UNI1");
      const menu = await insertMenu(db);
      const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
      await client.query(
        `insert into public.orders (business_date, daily_seq, order_number, payment_attempt_id,
           tracking_token_hash, table_id, table_code, table_label, total_paise)
         values ('2026-01-01', 1, 'SE-001', $1, $2, $3, $4, $5, 14900)`,
        [attempt.attemptId, attempt.tokenHash, table.id, table.code, table.label],
      );
    }
  });

  it("rejects an order whose total differs from its lines at commit time", async () => {
    const table = await insertTable(db, "UNI2");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(db, table.id, buildSnapshot(table, [itemLine(menu)]));
    const error = await pgError(
      db.transaction(
        POSTGRES,
        async (client) => {
          const o = await client.query<{ id: string }>(
            `insert into public.orders (business_date, daily_seq, order_number, payment_attempt_id,
               tracking_token_hash, table_id, table_code, table_label, total_paise)
             values ('2026-01-01', 1, 'SE-001', $1, $2, $3, $4, $5, 999999) returning id`,
            [attempt.attemptId, attempt.tokenHash, table.id, table.code, table.label],
          );
          await client.query(
            `insert into public.order_items (order_id, line_no, menu_item_id, item_name,
               unit_price_paise, options_unit_paise, quantity, line_total_paise)
             values ($1, 1, $2, 'Grilled Sandwich', 14900, 0, 1, 14900)`,
            [o.rows[0]!.id, menu.item.id],
          );
        },
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
    expect(error.message).toMatch(/does not equal the sum of its lines/);
  });

  it("rejects an order item whose line total or option sum is wrong", async () => {
    const paid = await insertPaidOrder(db);
    const badLine = await pgError(
      db.query(
        POSTGRES,
        `insert into public.order_items (order_id, line_no, menu_item_id, item_name,
           unit_price_paise, options_unit_paise, quantity, line_total_paise)
         values ($1, 9, $2, 'X', 100, 0, 2, 100)`,
        [paid.order.out_order_id, paid.menu.item.id],
      ),
    );
    expect(badLine.code).toBe(PG.checkViolation);

    const badOptions = await pgError(
      db.query(
        POSTGRES,
        `insert into public.order_items (order_id, line_no, menu_item_id, item_name,
           unit_price_paise, options, options_unit_paise, quantity, line_total_paise)
         values ($1, 9, $2, 'X', 100, '[{"group_name":"g","option_name":"o","price_delta_paise":500}]', 0, 1, 100)`,
        [paid.order.out_order_id, paid.menu.item.id],
      ),
    );
    expect(badOptions.code).toBe(PG.checkViolation);
    expect(badOptions.message).toMatch(/options_unit_paise/);
  });
});

describe("historical snapshots are protected", () => {
  let db: TestDb;
  afterAll(closeOpened);
  let paid: Awaited<ReturnType<typeof insertPaidOrder>>;
  beforeAll(async () => {
    db = await freshDb();
    paid = await insertPaidOrder(db);
  });

  it("is unaffected when the menu item is renamed and re-priced", async () => {
    await admin(db).exec(
      "update public.menu_items set name = 'Renamed Sandwich', price_paise = 99900 where id = $1",
      [paid.menu.item.id],
    );
    await admin(db).exec(
      "update public.modifier_options set name = 'Renamed cheese', price_delta_paise = 9900 where id = $1",
      [paid.menu.optionCheese.id],
    );
    const items = await admin(db).all<{
      item_name: string;
      unit_price_paise: number;
      line_total_paise: number;
      options: Array<{ option_name: string; price_delta_paise: number }>;
    }>(
      "select item_name, unit_price_paise, line_total_paise, options from public.order_items where order_id = $1 order by line_no",
      [paid.order.out_order_id],
    );
    expect(items[0]).toMatchObject({
      item_name: "Grilled Sandwich",
      unit_price_paise: 14900,
      line_total_paise: 35800,
    });
    expect(items[0]!.options[0]).toMatchObject({
      option_name: "Extra cheese",
      price_delta_paise: 3000,
    });
    const order = await admin(db).one<{ total_paise: number }>(
      "select total_paise from public.orders where id = $1",
      [paid.order.out_order_id],
    );
    expect(order.total_paise).toBe(47700);
  });

  it("is unaffected when the table is renamed or deactivated", async () => {
    await admin(db).exec(
      "update public.cafe_tables set label = 'Renamed', is_active = false where id = $1",
      [paid.table.id],
    );
    const order = await admin(db).one<{ table_label: string }>(
      "select table_label from public.orders where id = $1",
      [paid.order.out_order_id],
    );
    expect(order.table_label).toBe(paid.table.label);
  });

  it("forbids editing or deleting order items, even for an administrator", async () => {
    for (const sql of [
      "update public.order_items set item_name = 'Hacked' where order_id = $1",
      "update public.order_items set unit_price_paise = 1, line_total_paise = 1 where order_id = $1",
      "delete from public.order_items where order_id = $1",
    ]) {
      const error = await pgError(
        db.query(POSTGRES, sql, [paid.order.out_order_id], { commit: true }),
      );
      expect(error.code, sql).toBe(PG.restrictViolation);
    }
  });

  it("forbids deleting orders", async () => {
    const error = await pgError(
      db.query(POSTGRES, "delete from public.orders where id = $1", [paid.order.out_order_id], {
        commit: true,
      }),
    );
    expect(error.code).toBe(PG.restrictViolation);
  });

  it("freezes order identity, table, total and token", async () => {
    for (const [column, value] of [
      ["order_number", "SE-999"],
      ["daily_seq", 999],
      ["business_date", "2020-01-01"],
      ["total_paise", 100],
      ["table_label", "Hacked"],
      ["table_code", "HACK"],
      ["customer_name", "Someone"],
      ["tracking_token_hash", Buffer.alloc(32, 7)],
      ["currency", "USD"],
    ] as const) {
      const error = await pgError(
        db.query(
          SERVICE,
          `update public.orders set ${column} = $1 where id = $2`,
          [value, paid.order.out_order_id],
          {
            commit: true,
          },
        ),
      );
      expect(error.code, column).toBe(PG.restrictViolation);
    }
  });

  it("refuses to delete a menu item that a customer is in the middle of paying for", async () => {
    const table = await insertTable(db, "H01");
    const menu = await insertMenu(db);
    const attempt = await insertAttempt(
      db,
      table.id,
      buildSnapshot(table, [itemLine(menu, "drink")]),
    );

    const blocked = await pgError(
      db.query(POSTGRES, "delete from public.menu_items where id = $1", [menu.drink.id], {
        commit: true,
      }),
    );
    expect(blocked.code).toBe(PG.restrictViolation);

    // Once that checkout is abandoned the item can be deleted again.
    await db.query(
      SERVICE,
      "update public.payment_attempts set status = 'FAILED', failure_reason = 'expired' where id = $1",
      [attempt.attemptId],
      { commit: true },
    );
    await admin(db).exec("delete from public.menu_items where id = $1", [menu.drink.id]);
  });
});

describe("state machines: database agrees with the TypeScript mirror", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });

  it("has exactly the enum labels the app expects", async () => {
    const row = await admin(db).one<{ o: string[]; p: string[] }>(
      `select enum_range(null::public.order_status)::text[] as o,
              enum_range(null::public.payment_status)::text[] as p`,
    );
    expect(row.o).toEqual([...ORDER_STATUSES]);
    expect(row.p).toEqual([...PAYMENT_STATUSES]);
  });

  it("allows exactly the order transitions in status.ts (all 36 pairs)", async () => {
    const rows = await admin(db).all<{ f: string; t: string; ok: boolean }>(
      `select f::text as f, t::text as t, private.order_status_transition_allowed(f, t) as ok
         from unnest(enum_range(null::public.order_status)) f,
              unnest(enum_range(null::public.order_status)) t`,
    );
    expect(rows).toHaveLength(36);
    for (const row of rows) {
      expect(row.ok, `${row.f} -> ${row.t}`).toBe(
        canTransitionOrder(
          row.f as (typeof ORDER_STATUSES)[number],
          row.t as (typeof ORDER_STATUSES)[number],
        ),
      );
    }
  });

  it("allows exactly the payment transitions in status.ts (all 25 pairs)", async () => {
    const rows = await admin(db).all<{ f: string; t: string; ok: boolean }>(
      `select f::text as f, t::text as t, private.payment_status_transition_allowed(f, t) as ok
         from unnest(enum_range(null::public.payment_status)) f,
              unnest(enum_range(null::public.payment_status)) t`,
    );
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      expect(row.ok, `${row.f} -> ${row.t}`).toBe(
        canTransitionPayment(
          row.f as (typeof PAYMENT_STATUSES)[number],
          row.t as (typeof PAYMENT_STATUSES)[number],
        ),
      );
    }
  });
});

describe("order status trigger (as the trusted backend)", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });

  const setStatus = (id: string, status: string, reason: string | null = null) =>
    db.query(
      SERVICE,
      "update public.orders set status = $2, cancel_reason = $3 where id = $1",
      [id, status, reason],
      { commit: true },
    );
  const row = (id: string) =>
    admin(db).one<Record<string, unknown>>("select * from public.orders where id = $1", [id]);

  it("walks NEW -> ACCEPTED -> PREPARING -> READY -> SERVED and stamps each time once", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    for (const next of ["ACCEPTED", "PREPARING", "READY", "SERVED"]) {
      await setStatus(id, next);
    }
    const final = await row(id);
    expect(final.status).toBe("SERVED");
    for (const column of ["accepted_at", "preparing_at", "ready_at", "served_at"]) {
      expect(final[column], column).toBeInstanceOf(Date);
    }
    expect(final.cancelled_at).toBeNull();
    expect(final.payment_status).toBe("PAID");
  });

  it("rejects skipping steps, going backwards and acting on finished orders", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    for (const bad of ["PREPARING", "READY", "SERVED"]) {
      expect((await pgError(setStatus(id, bad))).code, `NEW -> ${bad}`).toBe(PG.checkViolation);
    }
    await setStatus(id, "ACCEPTED");
    await setStatus(id, "PREPARING");
    expect((await pgError(setStatus(id, "ACCEPTED"))).code).toBe(PG.checkViolation);
    expect((await pgError(setStatus(id, "NEW"))).code).toBe(PG.checkViolation);
    await setStatus(id, "READY");
    await setStatus(id, "SERVED");
    expect((await pgError(setStatus(id, "CANCELLED", "too late"))).code).toBe(PG.checkViolation);
  });

  it("requires a reason to cancel, records it, and then freezes the order", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    const noReason = await pgError(setStatus(id, "CANCELLED"));
    expect(noReason.code).toBe(PG.checkViolation);

    await setStatus(id, "CANCELLED", "Customer left");
    const cancelled = await row(id);
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancel_reason: "Customer left" });
    expect(cancelled.cancelled_at).toBeInstanceOf(Date);
    // Cancelling does not touch payment_status: a refund is a separate, confirmed step.
    expect(cancelled.payment_status).toBe("PAID");
    expect((await pgError(setStatus(id, "ACCEPTED"))).code).toBe(PG.checkViolation);
  });

  it("only accepts cancel_reason while cancelling", async () => {
    const { order } = await insertPaidOrder(db);
    const error = await pgError(
      db.query(
        SERVICE,
        "update public.orders set cancel_reason = 'x' where id = $1",
        [order.out_order_id],
        { commit: true },
      ),
    );
    expect(error.code).toBe(PG.checkViolation);
  });

  it("ignores attempts to set or back-date the status timestamps", async () => {
    const { order } = await insertPaidOrder(db);
    await db.query(
      SERVICE,
      "update public.orders set accepted_at = '2000-01-01', served_at = '2000-01-01' where id = $1",
      [order.out_order_id],
      { commit: true },
    );
    const after = await row(order.out_order_id);
    expect(after.accepted_at).toBeNull();
    expect(after.served_at).toBeNull();

    await setStatus(order.out_order_id, "ACCEPTED");
    await db.query(
      SERVICE,
      "update public.orders set accepted_at = '2000-01-01' where id = $1",
      [order.out_order_id],
      {
        commit: true,
      },
    );
    const accepted = await row(order.out_order_id);
    expect((accepted.accepted_at as Date).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("writes an audit event for every status change, in order", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    await setStatus(id, "ACCEPTED");
    await setStatus(id, "PREPARING");
    await setStatus(id, "CANCELLED", "Out of bread");
    const events = await admin(db).all<{
      event_type: string;
      from_value: string | null;
      to_value: string;
      actor_kind: string;
      metadata: Record<string, unknown>;
    }>(
      "select event_type, from_value, to_value, actor_kind, metadata from public.order_events where order_id = $1 order by id",
      [id],
    );
    expect(events.map((e) => `${e.event_type}:${e.from_value ?? "-"}>${e.to_value}`)).toEqual([
      "ORDER_PLACED:->NEW",
      "STATUS_CHANGED:NEW>ACCEPTED",
      "STATUS_CHANGED:ACCEPTED>PREPARING",
      "STATUS_CHANGED:PREPARING>CANCELLED",
    ]);
    expect(events.at(-1)!.metadata).toEqual({ cancel_reason: "Out of bread" });
    expect(events.slice(1).every((e) => e.actor_kind === "system")).toBe(true); // no signed-in staff here
  });

  it("makes audit events append-only, even for an administrator", async () => {
    const { order } = await insertPaidOrder(db);
    for (const sql of [
      "update public.order_events set to_value = 'FORGED' where order_id = $1",
      "delete from public.order_events where order_id = $1",
    ]) {
      const error = await pgError(db.query(POSTGRES, sql, [order.out_order_id], { commit: true }));
      expect(error.code, sql).toBe(PG.restrictViolation);
    }
  });
});

describe("payment status and refunds", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });
  const setPayment = (id: string, status: string) =>
    db.query(SERVICE, "update public.orders set payment_status = $2 where id = $1", [id, status], {
      commit: true,
    });

  it("cannot jump from PAID straight to REFUNDED", async () => {
    const { order } = await insertPaidOrder(db);
    expect((await pgError(setPayment(order.out_order_id, "REFUNDED"))).code).toBe(
      PG.checkViolation,
    );
  });

  it("goes PAID -> REFUND_PENDING -> REFUNDED, with audit events, and REFUNDED is final", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    await setPayment(id, "REFUND_PENDING");
    await setPayment(id, "REFUNDED");
    expect((await pgError(setPayment(id, "PAID"))).code).toBe(PG.checkViolation);
    expect((await pgError(setPayment(id, "REFUND_PENDING"))).code).toBe(PG.checkViolation);

    const events = await admin(db).all<{ from_value: string; to_value: string }>(
      "select from_value, to_value from public.order_events where order_id = $1 and event_type = 'PAYMENT_STATUS_CHANGED' order by id",
      [id],
    );
    expect(events).toEqual([
      { from_value: "PAID", to_value: "REFUND_PENDING" },
      { from_value: "REFUND_PENDING", to_value: "REFUNDED" },
    ]);
  });

  it("lets a rejected refund fall back to PAID", async () => {
    const { order } = await insertPaidOrder(db);
    await setPayment(order.out_order_id, "REFUND_PENDING");
    await setPayment(order.out_order_id, "PAID");
  });

  it("never accepts PENDING or FAILED on an order", async () => {
    const { order } = await insertPaidOrder(db);
    for (const status of ["PENDING", "FAILED"]) {
      const error = await pgError(setPayment(order.out_order_id, status));
      expect(error.code, status).toBe(PG.checkViolation);
    }
  });

  it("stops preparation from advancing once a refund is pending, but still allows cancelling", async () => {
    const { order } = await insertPaidOrder(db);
    const id = order.out_order_id;
    await setPayment(id, "REFUND_PENDING");
    const advance = await pgError(
      db.query(SERVICE, "update public.orders set status = 'ACCEPTED' where id = $1", [id], {
        commit: true,
      }),
    );
    expect(advance.code).toBe(PG.checkViolation);
    expect(advance.message).toMatch(/payment_status is REFUND_PENDING/);

    await db.query(
      SERVICE,
      "update public.orders set status = 'CANCELLED', cancel_reason = 'Refunding' where id = $1",
      [id],
      { commit: true },
    );
  });
});

describe("gateway event inbox (webhook de-duplication)", () => {
  afterAll(closeOpened);
  it("reports a duplicate delivery of the same event id", async () => {
    const db = await freshDb();
    const insert = () =>
      db.query<{ id: string }>(
        SERVICE,
        `insert into public.gateway_events (event_id, event_type, payload)
         values ('evt_dup_1', 'payment.captured', '{}')
         on conflict (gateway, event_id) do nothing returning id`,
        [],
        { commit: true },
      );
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0); // duplicate: handler should skip processing

    const plain = await pgError(
      db.query(
        SERVICE,
        "insert into public.gateway_events (event_id, event_type, payload) values ('evt_dup_1', 'payment.captured', '{}')",
        [],
        { commit: true },
      ),
    );
    expect(plain.code).toBe(PG.uniqueViolation);
  });
});

describe("rate limiting", () => {
  let db: TestDb;
  afterAll(closeOpened);
  beforeAll(async () => {
    db = await freshDb();
  });
  const hit = async (bucket: string, limit: number, window: number) =>
    (
      await db.query<{ ok: boolean }>(
        SERVICE,
        "select public.check_rate_limit($1, $2, $3) as ok",
        [bucket, limit, window],
        { commit: true },
      )
    ).rows[0]!.ok;

  it("allows up to the limit and then blocks, per bucket", async () => {
    expect([await hit("a", 3, 3600), await hit("a", 3, 3600), await hit("a", 3, 3600)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await hit("a", 3, 3600)).toBe(false);
    expect(await hit("a", 3, 3600)).toBe(false);
    expect(await hit("b", 3, 3600)).toBe(true); // other buckets are unaffected
  });

  it("counts correctly under 30 parallel requests (exactly `limit` are allowed)", async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => hit("burst", 10, 3600)));
    expect(results.filter(Boolean)).toHaveLength(10);
  });

  it("starts a fresh window once the old one ends", async () => {
    expect(await hit("short", 1, 1)).toBe(true);
    expect(await hit("short", 1, 1)).toBe(false);
    await admin(db).exec("select pg_sleep(1.2)");
    expect(await hit("short", 1, 1)).toBe(true);
  });

  it("rejects nonsense parameters", async () => {
    const cases: [limit: number, window: number][] = [
      [0, 60],
      [5, 0],
      [5, 86401],
    ];
    for (const [limit, window] of cases) {
      const error = await pgError(hit("bad", limit, window));
      expect(error.code).toBe(PG.invalidParameter);
    }
  });

  it("purges only old windows", async () => {
    await hit("purge-me", 5, 60);
    await admin(db).exec(
      "insert into public.rate_limits (bucket, window_start, window_seconds, hits) values ('ancient', now() - interval '3 days', 60, 1)",
    );
    const deleted = await db.query<{ n: number }>(
      SERVICE,
      "select public.purge_expired_rate_limits() as n",
      [],
      { commit: true },
    );
    expect(deleted.rows[0]!.n).toBe(1);
    expect(await count(db, "public.rate_limits", "bucket = 'purge-me'")).toBe(1);
  });
});
