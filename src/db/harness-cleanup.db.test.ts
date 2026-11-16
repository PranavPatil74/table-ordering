import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectPlan } from "../../scripts/test-menu-cleanup/core.mjs";
import { Tracker, createWorld } from "../supabase-it/harness";
import { admin, createTestDb, type TestDb } from "@/test/db/db";
import { createSqlPort } from "@/test/db/menu-cleanup-port";
import { createSqlClient } from "@/test/db/sql-supabase-client";

/**
 * The real-Supabase harness (`createWorld` + `Tracker.cleanup`) run against REAL PostgreSQL 16 with
 * this project's migrations: real foreign keys, the delete guard trigger and `finalize_paid_order`.
 * Only the transport differs (SQL instead of PostgREST), see src/test/db/sql-supabase-client.ts.
 * What this proves: what the harness leaves behind after a successful run, after a run that fails
 * part-way, and when the cleanup's own calls fail; and that history is never touched.
 */

let db: TestDb;
let a: ReturnType<typeof admin>;

beforeAll(async () => {
  db = await createTestDb();
  a = admin(db);
});
afterAll(async () => {
  await db.close();
});

const tag = () => randomBytes(3).toString("hex");

async function historyFingerprint() {
  const out: Record<string, string> = {};
  for (const table of ["orders", "order_items", "payment_attempts", "order_events"]) {
    out[table] = (
      await a.one<{ h: string }>(
        `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from public.${table} t`,
      )
    ).h;
  }
  return out;
}

const tableRow = (code: string) =>
  a.all<{ is_active: boolean }>("select is_active from public.cafe_tables where code = $1", [code]);
const count = async (sql: string, params: unknown[]) => (await a.one<{ n: number }>(sql, params)).n;

describe("harness cleanup against real PostgreSQL", () => {
  it("after a successful run: undeletable test rows are deactivated, the rest is removed, history is untouched", async () => {
    const t = tag();
    const client = createSqlClient(db);
    const tracker = new Tracker(() => client);
    const world = await createWorld(t, tracker, client);
    await world.makeOrder();
    await world.makeOrder();
    const history = await historyFingerprint();

    const result = await tracker.cleanup();

    // The table, category and ordered items cannot be deleted: they stay, but deactivated.
    expect(await tableRow(`IT${t.toUpperCase()}`)).toEqual([{ is_active: false }]);
    expect(
      await a.all("select is_active from public.menu_categories where slug = $1", [`it-${t}-cat`]),
    ).toEqual([{ is_active: false }]);
    for (const suffix of ["sandwich", "coffee"]) {
      expect(
        await a.all("select is_active from public.menu_items where slug = $1", [
          `it-${t}-${suffix}`,
        ]),
      ).toEqual([{ is_active: false }]);
    }
    // Nothing references the others (archived/sold-out items, modifier group), so they are gone.
    expect(
      await count("select count(*)::int as n from public.menu_items where slug in ($1, $2)", [
        `it-${t}-archived`,
        `it-${t}-soldout`,
      ]),
    ).toBe(0);
    expect(
      await count("select count(*)::int as n from public.modifier_groups where slug = $1", [
        `it-${t}-extras`,
      ]),
    ).toBe(0);
    expect(result.archived).toBe(4); // table, category, two ordered items
    expect(result.kept).toBe(4);
    // History: byte-identical to right after the orders were placed.
    expect(await historyFingerprint()).toEqual(history);
    expect(
      await count(
        "select count(*)::int as n from public.orders o join public.cafe_tables c on c.id = o.table_id where c.code = $1",
        [`IT${t.toUpperCase()}`],
      ),
    ).toBe(2);

    // Running it again changes nothing and does not throw.
    await expect(tracker.cleanup()).resolves.toMatchObject({ removed: expect.any(Number) });
    expect(await historyFingerprint()).toEqual(history);

    // The standalone tool agrees there is nothing left for it to do for this run.
    const plan = await collectPlan(createSqlPort(db));
    expect(plan.tableCandidates.filter((c) => c.tag === t).map((c) => c.action)).toEqual([
      "already-inactive",
    ]);
    expect(
      plan.candidates.filter((c) => c.tag === t).flatMap((c) => c.items.map((i) => i.action)),
    ).not.toContain("archive");
  });

  it("a run that placed no orders leaves nothing behind", async () => {
    const t = tag();
    const client = createSqlClient(db);
    const tracker = new Tracker(() => client);
    await createWorld(t, tracker, client);
    const result = await tracker.cleanup();
    expect(result.kept).toBe(0);
    expect(await tableRow(`IT${t.toUpperCase()}`)).toEqual([]);
    expect(
      await count("select count(*)::int as n from public.menu_categories where slug = $1", [
        `it-${t}-cat`,
      ]),
    ).toBe(0);
  });

  it("after a run that fails part-way (setup throws), cleanup still removes what was created", async () => {
    const t = tag();
    const client = createSqlClient(db, { failOn: (label) => label === "insert:modifier_groups" });
    const tracker = new Tracker(() => createSqlClient(db));
    await expect(createWorld(t, tracker, client)).rejects.toThrow(/simulated failure/);
    // The table, category and items had been created when it failed.
    expect(await tableRow(`IT${t.toUpperCase()}`)).toHaveLength(1);
    await tracker.cleanup(); // vitest runs afterAll even when beforeAll fails
    expect(await tableRow(`IT${t.toUpperCase()}`)).toEqual([]);
    expect(
      await count("select count(*)::int as n from public.menu_items where slug like $1", [
        `it-${t}-%`,
      ]),
    ).toBe(0);
  });

  it("when the cleanup's own delete calls fail (dropped connection), the table is still deactivated and nothing throws", async () => {
    const t = tag();
    const setup = createSqlClient(db);
    const tracker = new Tracker(() =>
      createSqlClient(db, { failOn: (label) => label.startsWith("delete:") }),
    );
    const world = await createWorld(t, tracker, setup);
    await world.makeOrder();
    const history = await historyFingerprint();

    const result = await tracker.cleanup();
    expect(result.removed).toBe(0);
    expect(await tableRow(`IT${t.toUpperCase()}`)).toEqual([{ is_active: false }]);
    expect(await historyFingerprint()).toEqual(history);
  });

  it("when even the deactivation fails, cleanup does not throw and the tool can finish the job", async () => {
    const t = tag();
    const setup = createSqlClient(db);
    const tracker = new Tracker(() =>
      createSqlClient(db, {
        failOn: (label) => label.startsWith("delete:") || label.startsWith("update:"),
      }),
    );
    const world = await createWorld(t, tracker, setup);
    await world.makeOrder();
    await expect(tracker.cleanup()).resolves.toMatchObject({ archived: 0 });
    expect(await tableRow(`IT${t.toUpperCase()}`)).toEqual([{ is_active: true }]); // left for the tool
    const plan = await collectPlan(createSqlPort(db));
    expect(plan.tableCandidates.find((c) => c.tag === t)!.action).toBe("deactivate");
  });

  it("only touches rows this run created", async () => {
    const t = tag();
    const bystander = await a.one<{ id: string }>(
      "insert into public.cafe_tables (code, label) values ($1, 'Bystander') returning id",
      [`B${t.toUpperCase()}`],
    );
    const client = createSqlClient(db);
    const tracker = new Tracker(() => client);
    const world = await createWorld(t, tracker, client);
    await world.makeOrder();
    await tracker.cleanup();
    expect(
      await a.all("select is_active from public.cafe_tables where id = $1", [bystander.id]),
    ).toEqual([{ is_active: true }]);
  });
});
