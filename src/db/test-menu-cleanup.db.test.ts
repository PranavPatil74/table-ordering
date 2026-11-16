import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPlan, collectPlan } from "../../scripts/test-menu-cleanup/core.mjs";
import { PG, admin, createTestDb, pgError, type TestDb } from "@/test/db/db";
import { buildSnapshot, finalize, insertAttempt, insertTable, itemLine } from "@/test/db/fixtures";
import { createSqlPort } from "@/test/db/menu-cleanup-port";

/**
 * The test-menu cleanup tool, run against a REAL PostgreSQL database that has this project's
 * migrations (triggers, foreign keys, finalize_paid_order). The data mirrors what
 * `src/supabase-it/harness.ts` (createWorld) leaves behind after `pnpm test:supabase`: a tagged
 * category with four items, a test table and modifier group, and paid orders that make the two
 * real items undeletable. The tool talks to the database as `service_role`, like the real one.
 *
 * Plain PostgreSQL + the Supabase shim: this does not exercise PostgREST. The PostgREST adapter is
 * covered by the dry-run on a real stack (see docs/test-data-cleanup.md).
 */

let db: TestDb;
let a: ReturnType<typeof admin>;
const SERVICE = { role: "service_role" } as const;

const tag = () => randomBytes(3).toString("hex");

interface World {
  tag: string;
  categoryId: string;
  sandwichId: string;
  coffeeId: string;
  archivedId: string;
  soldOutId: string;
}

/** createWorld() from the real-Supabase harness, written as SQL. */
async function harnessWorld(
  t: string,
  options: { paidOrders?: number; pendingCheckout?: boolean; strangerItem?: boolean } = {},
): Promise<World> {
  const category = await a.one<{ id: string }>(
    "insert into public.menu_categories (slug, name) values ($1, $2) returning id",
    [`it-${t}-cat`, `IT ${t} Category`],
  );
  const item = async (suffix: string, name: string, price: number, extra = "") =>
    (
      await a.one<{ id: string }>(
        `insert into public.menu_items (category_id, slug, name, price_paise${extra ? ", " + extra.split("=")[0] : ""})
         values ($1, $2, $3, $4${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
        [category.id, `it-${t}-${suffix}`, name, price],
      )
    ).id;
  const sandwichId = await item("sandwich", "Grilled Sandwich", 14900);
  const coffeeId = await item("coffee", "Cold Coffee", 11900);
  const archivedId = await item("archived", "Archived item", 100, "is_active=false");
  const soldOutId = await item("soldout", "Sold out item", 100, "is_available=false");
  if (options.strangerItem) {
    await a.exec(
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, $2, 'Chicken Wrap', 18900)",
      [category.id, `manager-added-wrap-${t}`],
    );
  }

  const table = await insertTable(db, `IT${t.toUpperCase()}`, `IT table ${t}`);
  const group = await a.one<{ id: string }>(
    "insert into public.modifier_groups (slug, name, max_select) values ($1, $2, 3) returning id",
    [`it-${t}-extras`, `IT ${t} Extras`],
  );
  const cheese = await a.one<{ id: string }>(
    "insert into public.modifier_options (group_id, name, price_delta_paise) values ($1, 'Extra cheese', 3000) returning id",
    [group.id],
  );
  await a.exec("insert into public.menu_item_modifier_groups (item_id, group_id) values ($1, $2)", [
    sandwichId,
    group.id,
  ]);

  const menu = {
    categoryId: category.id,
    categoryName: `IT ${t} Category`,
    item: { id: sandwichId, name: "Grilled Sandwich", pricePaise: 14900 },
    drink: { id: coffeeId, name: "Cold Coffee", pricePaise: 11900 },
    group: { id: group.id, name: `IT ${t} Extras` },
    optionCheese: { id: cheese.id, name: "Extra cheese", deltaPaise: 3000 },
    optionMayo: { id: cheese.id, name: "Extra cheese", deltaPaise: 3000 },
  };
  const snapshot = buildSnapshot(table, [
    itemLine(menu, "item", 2, true),
    itemLine(menu, "drink", 1),
  ]);
  for (let i = 0; i < (options.paidOrders ?? 0); i += 1) {
    const attempt = await insertAttempt(db, table.id, snapshot);
    await finalize(db, attempt.attemptId, `pay_it${randomBytes(6).toString("hex")}`);
  }
  if (options.pendingCheckout) await insertAttempt(db, table.id, snapshot); // left PENDING

  return { tag: t, categoryId: category.id, sandwichId, coffeeId, archivedId, soldOutId };
}

const itemState = (id: string) =>
  a.all<{ is_active: boolean }>("select is_active from public.menu_items where id = $1", [id]);
const categoryState = (id: string) =>
  a.all<{ is_active: boolean }>("select is_active from public.menu_categories where id = $1", [id]);

/** A fingerprint of every history row: any change to any column changes it. */
async function historyFingerprint() {
  const out: Record<string, string> = {};
  for (const table of ["orders", "order_items", "payment_attempts", "order_events"]) {
    const row = await a.one<{ h: string }>(
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from public.${table} t`,
    );
    out[table] = row.h;
  }
  return out;
}

beforeAll(async () => {
  db = await createTestDb();
  a = admin(db);
});
afterAll(async () => {
  await db.close();
});

describe("cleanup of leftover test-menu fixtures (real PostgreSQL)", () => {
  it("explains why deletion is blocked: order history and unpaid checkouts reference the items", async () => {
    const w = await harnessWorld(tag(), { paidOrders: 2 });
    // The database's own guards, as a manager would hit through the app.
    const ordered = await pgError(
      db.query(SERVICE, "delete from public.menu_items where id = $1", [w.sandwichId], {
        commit: true,
      }),
    );
    expect(ordered.code).toBe(PG.foreignKeyViolation); // order_items.menu_item_id ... ON DELETE RESTRICT
    expect(ordered.message).toMatch(/order_items/);
    // An item referenced ONLY by an unpaid checkout is blocked by the trigger instead.
    const lone = tag();
    const t2 = await insertTable(db, `IT${lone.toUpperCase()}`, `IT table ${lone}`);
    const cat = await a.one<{ id: string }>(
      "insert into public.menu_categories (slug, name) values ($1, $2) returning id",
      [`it-${lone}-cat`, `IT ${lone} Category`],
    );
    const only = await a.one<{ id: string }>(
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, $2, 'Cold Coffee', 11900) returning id",
      [cat.id, `it-${lone}-coffee`],
    );
    await insertAttempt(
      db,
      t2.id,
      buildSnapshot(t2, [
        {
          menu_item_id: only.id,
          item_name: "Cold Coffee",
          unit_price_paise: 11900,
          quantity: 1,
          note: null,
          options: [],
        },
      ]),
    );
    const pending = await pgError(
      db.query(SERVICE, "delete from public.menu_items where id = $1", [only.id], { commit: true }),
    );
    expect(pending.code).toBe(PG.restrictViolation);
    expect(pending.message).toMatch(/unpaid checkout/);
  });

  it("the preview reports history per item and identifies only genuine fixtures", async () => {
    const ordered = await harnessWorld(tag(), { paidOrders: 2 });
    const strangerTag = tag();
    const withStranger = await harnessWorld(strangerTag, { strangerItem: true });
    // A hand-made category whose name merely starts with "IT ": it must be listed as untouched.
    const handMade = await a.one<{ id: string }>(
      "insert into public.menu_categories (slug, name) values ('it-specials', 'IT Specials') returning id",
    );
    await a.exec(
      "insert into public.menu_items (category_id, slug, name, price_paise) values ($1, 'special-coffee', 'Cold Coffee', 11900)",
      [handMade.id],
    );

    const plan = await collectPlan(createSqlPort(db));
    const mine = plan.candidates.find((c) => c.category.id === ordered.categoryId)!;
    expect(mine.evidence.length).toBeGreaterThan(0);
    const byName = Object.fromEntries(mine.items.map((i) => [i.name, i]));
    expect(byName["Grilled Sandwich"]).toMatchObject({
      orderRefs: 2,
      action: "archive",
      pricePaise: 14900,
    });
    expect(byName["Cold Coffee"]).toMatchObject({ orderRefs: 2, pricePaise: 11900 });
    expect(byName["Archived item"]).toMatchObject({ orderRefs: 0, action: "already-archived" });
    expect(byName["Sold out item"]).toMatchObject({ orderRefs: 0, action: "archive" });

    const skippedIds = plan.skipped.map((s) => s.id);
    expect(skippedIds).toContain(handMade.id);
    expect(skippedIds).toContain(withStranger.categoryId);
    expect(plan.candidates.map((c) => c.category.id)).not.toContain(handMade.id);
    expect(plan.candidates.map((c) => c.category.id)).not.toContain(withStranger.categoryId);

    // Preview is read-only.
    expect((await categoryState(ordered.categoryId))[0]!.is_active).toBe(true);
  });

  it("archives referenced fixtures, leaves everything else and all history untouched", async () => {
    const port = createSqlPort(db);
    const ordered = await harnessWorld(tag(), { paidOrders: 1 });
    const pending = await harnessWorld(tag(), { pendingCheckout: true });
    const unreferenced = await harnessWorld(tag());
    const stranger = await harnessWorld(tag(), { strangerItem: true });
    const handMade = await a.one<{ id: string }>(
      "select id from public.menu_categories where slug = 'it-specials'",
    );

    const fingerprintBefore = await historyFingerprint();
    const plan = await collectPlan(port);

    // Wrong or missing confirmation changes nothing.
    await expect(applyPlan(port, { confirm: "" })).rejects.toThrow(/--confirm/);
    await expect(applyPlan(port, { confirm: "deadbeef00" })).rejects.toThrow(/does not match/);
    expect((await itemState(ordered.sandwichId))[0]!.is_active).toBe(true);

    const outcome = await applyPlan(port, { confirm: plan.token });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(outcome.historyUnchanged).toBe(true);
    expect(await historyFingerprint()).toEqual(fingerprintBefore); // not one history column changed

    for (const w of [ordered, pending, unreferenced]) {
      expect((await categoryState(w.categoryId))[0]!.is_active).toBe(false);
      for (const id of [w.sandwichId, w.coffeeId, w.archivedId, w.soldOutId]) {
        expect((await itemState(id))[0]!.is_active).toBe(false);
      }
    }
    // Not fixtures: untouched.
    expect((await categoryState(stranger.categoryId))[0]!.is_active).toBe(true);
    expect((await itemState(stranger.sandwichId))[0]!.is_active).toBe(true);
    expect((await categoryState(handMade.id))[0]!.is_active).toBe(true);

    // Nothing is left to do, and running it again is a no-op.
    expect(outcome.remaining.totals.itemsToArchive).toBe(0);
    const again = await collectPlan(port);
    expect(again.totals.itemsToArchive + again.totals.categoriesToArchive).toBe(0);
  });

  it("refuses to apply when the data changed after the preview", async () => {
    const port = createSqlPort(db);
    const plan = await collectPlan(port);
    await harnessWorld(tag(), { paidOrders: 1 }); // a new fixture appears after the preview
    await expect(applyPlan(port, { confirm: plan.token })).rejects.toThrow(/does not match/);
  });

  it("with --delete-unreferenced deletes only what nothing references; history keeps its items", async () => {
    const port = createSqlPort(db);
    const ordered = await harnessWorld(tag(), { paidOrders: 1 });
    const pending = await harnessWorld(tag(), { pendingCheckout: true });
    const unreferenced = await harnessWorld(tag());

    const fingerprintBefore = await historyFingerprint();
    const plan = await collectPlan(port, { deleteUnreferenced: true });
    const planOf = (w: World) => plan.candidates.find((c) => c.category.id === w.categoryId)!;
    expect(planOf(unreferenced).categoryAction).toBe("delete");
    expect(planOf(ordered).categoryAction).toBe("archive");
    expect(planOf(pending).categoryAction).toBe("archive");

    const outcome = await applyPlan(port, { confirm: plan.token, deleteUnreferenced: true });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(await historyFingerprint()).toEqual(fingerprintBefore);

    expect(await categoryState(unreferenced.categoryId)).toEqual([]); // really gone
    expect(await itemState(unreferenced.sandwichId)).toEqual([]);
    // Referenced ones are archived, never deleted: their rows still exist.
    expect(await categoryState(ordered.categoryId)).toEqual([{ is_active: false }]);
    expect(await itemState(ordered.sandwichId)).toEqual([{ is_active: false }]);
    // Even "unreferenced" siblings of an ordered item are deleted only if nothing points at them.
    expect(await itemState(ordered.soldOutId)).toEqual([]);
    expect(await itemState(pending.coffeeId)).toEqual([{ is_active: false }]);
  });
});

describe("the read-only SQL diagnostic (scripts/test-menu-cleanup/diagnostic.sql)", () => {
  const sql = readFileSync("scripts/test-menu-cleanup/diagnostic.sql", "utf8");

  it("only reads", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|grant|create)\b/i);
    expect(code).not.toMatch(/cart_snapshot\s*(,|from|as\b)/i); // never selects the snapshot itself
  });

  it("reports order history, unpaid checkouts and the fixture checks per item, without changing anything", async () => {
    const t = tag();
    const w = await harnessWorld(t, { paidOrders: 2, pendingCheckout: true });
    const before = await historyFingerprint();
    const rows = (await db.query({ role: "postgres" }, sql)).rows as {
      category: string;
      item: string;
      price_paise: number;
      order_history_lines: string;
      unpaid_checkouts: string;
      other_attempts: string;
      is_fixture_item: boolean;
      has_test_table: boolean;
      item_id: string;
    }[];
    const mine = rows.filter((r) => r.category === `IT ${t} Category`);
    expect(mine.map((r) => r.item).sort()).toEqual([
      "Archived item",
      "Cold Coffee",
      "Grilled Sandwich",
      "Sold out item",
    ]);
    const sandwich = mine.find((r) => r.item === "Grilled Sandwich")!;
    expect(sandwich).toMatchObject({
      price_paise: 14900,
      order_history_lines: "2",
      unpaid_checkouts: "1",
      other_attempts: "2", // the two attempts that became paid orders
      is_fixture_item: true,
      has_test_table: true,
      item_id: w.sandwichId,
    });
    expect(mine.every((r) => r.is_fixture_item)).toBe(true);
    expect(await historyFingerprint()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Test tables
// ---------------------------------------------------------------------------------------------

const tableState = (id: string) =>
  a.all<{ is_active: boolean; code: string }>(
    "select is_active, code from public.cafe_tables where id = $1",
    [id],
  );
const tableIdOf = async (t: string) =>
  (
    await a.one<{ id: string }>("select id from public.cafe_tables where code = $1", [
      `IT${t.toUpperCase()}`,
    ])
  ).id;

describe("test tables (real PostgreSQL)", () => {
  it("identifies only the generator's tables and classifies every look-alike", async () => {
    const port = createSqlPort(db);
    const withOrders = await harnessWorld(tag(), { paidOrders: 2 });
    const t = tag();
    // Look-alikes: all created in the same transaction-time window as a real fixture.
    const managerStyle = await insertTable(db, `Z${t.toUpperCase()}`, `IT table ${t}`); // label only
    const codeOnly = await insertTable(db, `IT${tag().toUpperCase()}`, "Patio"); // code only
    const real = await insertTable(db, "T77", "Table 77"); // a real cafe table
    const handMade = await insertTable(db, "ITDEADBE", "IT table deadbe"); // perfect pattern, no same-run data
    const startsWithIt = await insertTable(db, "ITALY", "IT corner");

    const plan = await collectPlan(port);
    const confirmed = plan.tableCandidates.map((c) => c.table.id);
    expect(confirmed).toContain(await tableIdOf(withOrders.tag));
    for (const lookalike of [managerStyle, codeOnly, real, handMade, startsWithIt]) {
      expect(confirmed, lookalike.code).not.toContain(lookalike.id);
    }
    const skipped = Object.fromEntries(plan.skippedTables.map((s) => [s.code, s.reason]));
    expect(skipped[managerStyle.code]).toMatch(/code is not IT<TAG>/);
    expect(skipped[codeOnly.code]).toMatch(/label is not exactly/);
    expect(skipped["ITDEADBE"]).toMatch(/cannot be told apart from a hand-made table/);
    expect(skipped["ITALY"]).toBeDefined();
    expect(Object.keys(skipped)).not.toContain("T77"); // a plain real table is not even listed

    const mine = plan.tableCandidates.find(
      (c) => c.table.code === `IT${withOrders.tag.toUpperCase()}`,
    )!;
    expect(mine).toMatchObject({
      orderRefs: 2,
      pendingAttempts: 0,
      otherAttempts: 2,
      action: "deactivate",
    });
    expect(mine.relatedCategory && mine.relatedGroup).toBe(true);
  });

  it("deactivates tables with history, skips one with an unpaid checkout, and never touches look-alikes", async () => {
    const port = createSqlPort(db);
    const withOrders = await harnessWorld(tag(), { paidOrders: 2 });
    const unpaid = await harnessWorld(tag(), { pendingCheckout: true });
    const idle = await harnessWorld(tag());
    const t = tag();
    const managerStyle = await insertTable(db, `Z${t.toUpperCase()}`, `IT table ${t}`);
    const real = await insertTable(db, "T78", "Table 78");
    const handMade = await insertTable(db, "ITFEEDED", "IT table feeded");

    const before = await historyFingerprint();
    const plan = await collectPlan(port);
    const actionOf = (w: World) =>
      plan.tableCandidates.find((c) => c.table.code === `IT${w.tag.toUpperCase()}`)!.action;
    expect(actionOf(withOrders)).toBe("deactivate");
    expect(actionOf(unpaid)).toBe("skip-unpaid-checkout");
    expect(actionOf(idle)).toBe("deactivate");

    // Preview wrote nothing; a wrong token writes nothing.
    expect((await tableState(await tableIdOf(withOrders.tag)))[0]!.is_active).toBe(true);
    await expect(applyPlan(port, { confirm: "1234567890" })).rejects.toThrow(/does not match/);
    expect((await tableState(await tableIdOf(withOrders.tag)))[0]!.is_active).toBe(true);

    const outcome = await applyPlan(port, { confirm: plan.token });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(outcome.historyUnchanged).toBe(true);
    expect(await historyFingerprint()).toEqual(before); // orders, items, attempts, events: byte-identical

    // Rows still exist (never deleted); only is_active changed.
    expect(await tableState(await tableIdOf(withOrders.tag))).toEqual([
      { is_active: false, code: `IT${withOrders.tag.toUpperCase()}` },
    ]);
    expect((await tableState(await tableIdOf(idle.tag)))[0]!.is_active).toBe(false);
    // Unpaid checkout: skipped and still active; look-alikes and real tables untouched.
    expect((await tableState(await tableIdOf(unpaid.tag)))[0]!.is_active).toBe(true);
    for (const untouched of [managerStyle, real, handMade]) {
      expect((await tableState(untouched.id))[0]!.is_active, untouched.code).toBe(true);
    }
    // The orders still point at the (now inactive) table.
    const orders = await a.one<{ n: number }>(
      "select count(*)::int as n from public.orders where table_id = $1",
      [await tableIdOf(withOrders.tag)],
    );
    expect(orders.n).toBe(2);
  });

  it("deactivates the skipped table once its checkout is no longer unpaid", async () => {
    const port = createSqlPort(db);
    const unpaid = await harnessWorld(tag(), { pendingCheckout: true });
    const tableId = await tableIdOf(unpaid.tag);
    // The checkout ends (the attempt fails). Only a test database lets us do this by hand.
    await a.exec("update public.payment_attempts set status = 'FAILED' where table_id = $1", [
      tableId,
    ]);
    const plan = await collectPlan(port);
    expect(plan.tableCandidates.find((c) => c.table.id === tableId)!.action).toBe("deactivate");
    const outcome = await applyPlan(port, { confirm: plan.token });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect((await tableState(tableId))[0]!.is_active).toBe(false);
  });

  it("the database itself still refuses to delete a table that has history", async () => {
    const w = await harnessWorld(tag(), { paidOrders: 1 });
    const refused = await pgError(
      db.query(
        SERVICE,
        "delete from public.cafe_tables where code = $1",
        [`IT${w.tag.toUpperCase()}`],
        {
          commit: true,
        },
      ),
    );
    expect(refused.code).toBe(PG.foreignKeyViolation); // orders.table_id ... ON DELETE RESTRICT
  });
});

describe("the read-only table diagnostic (scripts/test-menu-cleanup/diagnostic-tables.sql)", () => {
  const sql = readFileSync("scripts/test-menu-cleanup/diagnostic-tables.sql", "utf8");

  it("only reads, and never selects snapshots or order contents", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|grant|create)\b/i);
    expect(code).not.toMatch(/cart_snapshot|customer_name|special_instructions/i);
  });

  it("separates confirmed fixtures from look-alikes and counts history, changing nothing", async () => {
    const w = await harnessWorld(tag(), { paidOrders: 2, pendingCheckout: true });
    const t = tag();
    await insertTable(db, `Z${t.toUpperCase()}`, `IT table ${t}`);
    const before = await historyFingerprint();
    const rows = (await db.query({ role: "postgres" }, sql)).rows as {
      code: string;
      matches_fixture_pattern: boolean;
      has_same_run_category: boolean;
      has_same_run_group: boolean;
      order_history: string;
      unpaid_checkouts: string;
      other_payment_attempts: string;
    }[];
    const mine = rows.find((r) => r.code === `IT${w.tag.toUpperCase()}`)!;
    expect(mine).toMatchObject({
      matches_fixture_pattern: true,
      has_same_run_category: true,
      has_same_run_group: true,
      order_history: "2",
      unpaid_checkouts: "1",
      other_payment_attempts: "2",
    });
    const lookalike = rows.find((r) => r.code === `Z${t.toUpperCase()}`)!;
    expect(lookalike.matches_fixture_pattern).toBe(false);
    expect(await historyFingerprint()).toEqual(before);
  });
});
