import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyPlan,
  buildPlan,
  collectPlan,
  fixtureItems,
  formatPlan,
  isLoopbackUrl,
  parseArgs,
  type CleanupPort,
  type PlanInput,
} from "../../scripts/test-menu-cleanup/core.mjs";
import { isLocalUrl } from "../supabase-it/helpers";

/**
 * The pure rules of the test-menu cleanup tool (scripts/test-menu-cleanup/core.mjs): what counts as
 * a test fixture, what is never touched, and the preview/confirm safety. The same code runs against
 * real PostgreSQL in src/db/test-menu-cleanup.db.test.ts.
 */

const T = "0805fb";
const NOW = "2026-10-28T10:00:00.000Z";
const CAT = {
  id: "cat-1",
  slug: `it-${T}-cat`,
  name: `IT ${T} Category`,
  isActive: true,
  createdAt: NOW,
};
const TABLE = {
  id: "tab-1",
  code: `IT${T.toUpperCase()}`,
  label: `IT table ${T}`,
  isActive: true,
  createdAt: NOW,
};
const GROUP = { id: "grp-1", slug: `it-${T}-extras`, name: `IT ${T} Extras`, createdAt: NOW };

const items = (categoryId = CAT.id, tag = T) =>
  fixtureItems(tag).map((f, n) => ({
    id: `item-${tag}-${n}`,
    categoryId,
    slug: f.slug,
    name: f.name,
    pricePaise: f.pricePaise,
    isActive: n !== 2,
    isAvailable: n !== 3,
  }));

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  categories: [CAT],
  items: items(),
  tables: [TABLE],
  groups: [GROUP],
  orderRefs: { [`item-${T}-0`]: 2, [`item-${T}-1`]: 2 },
  attemptRefs: {},
  ...over,
});

describe("what counts as a test fixture", () => {
  it("matches the real harness fixture exactly (names, slugs, prices) and reports history per item", () => {
    const plan = buildPlan(input());
    expect(plan.candidates).toHaveLength(1);
    const c = plan.candidates[0]!;
    expect(c.category.name).toBe("IT 0805fb Category");
    const sandwich = c.items.find((i) => i.name === "Grilled Sandwich")!;
    expect(sandwich).toMatchObject({ pricePaise: 14900, orderRefs: 2, action: "archive" });
    expect(c.items.find((i) => i.name === "Cold Coffee")).toMatchObject({ pricePaise: 11900 });
    expect(c.items.find((i) => i.name === "Archived item")!.action).toBe("already-archived");
    expect(c.categoryAction).toBe("archive");
    expect(plan.totals).toMatchObject({ categories: 1, items: 4, itemsWithOrderHistory: 2 });
  });

  it("matches the fixtures that src/supabase-it/harness.ts really creates (kept in step with it)", () => {
    const harness = readFileSync("src/supabase-it/harness.ts", "utf8");
    expect(harness).toContain("slug: `it-${tag}-cat`");
    expect(harness).toContain("const categoryName = `IT ${tag} Category`");
    for (const f of fixtureItems("${tag}")) {
      expect(harness, f.slug).toContain(`slug: \`${f.slug}\``);
      expect(harness, f.name).toContain(`name: "${f.name}"`);
    }
    expect(harness).toContain("price_paise: 14900");
    expect(harness).toContain("price_paise: 11900");
  });

  it.each([
    [
      "a name that only starts with IT",
      { categories: [{ ...CAT, name: "IT Specials", slug: "it-specials" }] },
    ],
    [
      "a slug and name for different tags",
      { categories: [{ ...CAT, name: "IT 111111 Category" }] },
    ],
    [
      "an uppercase or wrong-length tag",
      { categories: [{ ...CAT, slug: "it-0805FB-cat", name: "IT 0805FB Category" }] },
    ],
  ])("never touches %s", (_label, over) => {
    const plan = buildPlan(input(over));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it("protects a category that holds anything a person added (different slug, name or price)", () => {
    for (const change of [
      { slug: "manager-wrap", name: "Chicken Wrap", pricePaise: 18900 },
      { pricePaise: 12000 }, // same item, edited price: no longer the fixture
      { name: "Grilled Sandwich (large)" },
    ]) {
      const list = items();
      list[0] = { ...list[0]!, ...change };
      const plan = buildPlan(input({ items: list }));
      expect(plan.candidates, JSON.stringify(change)).toEqual([]);
      expect(plan.skipped[0]!.reason).toMatch(/not one of this run's fixtures/);
    }
  });

  it("needs this run's own test table or modifier group, created at about the same time", () => {
    expect(buildPlan(input({ tables: [], groups: [] })).candidates).toEqual([]);
    const old = { ...TABLE, createdAt: "2026-01-01T00:00:00.000Z" };
    expect(buildPlan(input({ tables: [old], groups: [] })).candidates).toEqual([]);
    const wrongLabel = { ...TABLE, label: "Patio" };
    expect(buildPlan(input({ tables: [wrongLabel], groups: [] })).candidates).toEqual([]);
    expect(buildPlan(input({ tables: [], groups: [GROUP] })).candidates).toHaveLength(1);
  });

  it("never matches the real seed menu, which has a genuine Cold Coffee", () => {
    const seed = {
      categories: [{ ...CAT, id: "seed", slug: "drinks", name: "Drinks" }],
      items: [
        {
          id: "x",
          categoryId: "seed",
          slug: "cold-coffee",
          name: "Cold Coffee",
          pricePaise: 11900,
          isActive: true,
          isAvailable: true,
        },
      ],
    };
    expect(buildPlan(input(seed)).candidates).toEqual([]);
  });

  it("only deletes with the opt-in flag, and only items nothing references", () => {
    const refs = {
      orderRefs: { [`item-${T}-0`]: 1 },
      attemptRefs: { [`item-${T}-1`]: { pending: 1, other: 0 } },
    };
    const archiveOnly = buildPlan(input({ ...refs }));
    expect(archiveOnly.totals.itemsToDelete).toBe(0);
    const withDelete = buildPlan(input({ ...refs, deleteUnreferenced: true }));
    const actions = Object.fromEntries(
      withDelete.candidates[0]!.items.map((i) => [i.slug, i.action]),
    );
    expect(actions[`it-${T}-sandwich`]).toBe("archive"); // has order history
    expect(actions[`it-${T}-coffee`]).toBe("archive"); // in an unpaid checkout
    expect(actions[`it-${T}-soldout`]).toBe("delete"); // nothing references it
    expect(withDelete.candidates[0]!.categoryAction).toBe("archive"); // category keeps its items
  });

  it("gives a stable confirmation token that changes with the plan", () => {
    expect(buildPlan(input()).token).toBe(buildPlan(input()).token);
    expect(buildPlan(input()).token).toMatch(/^[0-9a-f]{10}$/);
    expect(buildPlan(input({ deleteUnreferenced: true, orderRefs: {} })).token).not.toBe(
      buildPlan(input()).token,
    );
  });
});

/** An in-memory port that records every write. */
function fakePort(data: PlanInput, failOn?: string) {
  const writes: string[] = [];
  const state = structuredClone(data);
  const port: CleanupPort = {
    listCategories: async () => structuredClone(state.categories),
    listItems: async () => structuredClone(state.items),
    listTables: async () => state.tables,
    listGroups: async () => state.groups,
    orderItemRefs: async () => state.orderRefs,
    attemptRefs: async () => state.attemptRefs,
    tableOrderRefs: async () => state.tableOrderRefs ?? {},
    tableAttemptRefs: async () => state.tableAttemptRefs ?? {},
    historyCounts: async () => ({
      orders: 2,
      order_items: 4,
      payment_attempts: 2,
      order_events: 2,
    }),
    setItemActive: async (id, active) => {
      if (id === failOn) throw Object.assign(new Error("boom"), { code: "XX000" });
      writes.push(`item ${id} active=${String(active)}`);
      const row = state.items.find((i) => i.id === id)!;
      row.isActive = active;
    },
    setCategoryActive: async (id, active) => {
      writes.push(`category ${id} active=${String(active)}`);
      state.categories.find((c) => c.id === id)!.isActive = active;
    },
    setTableActive: async (id, active) => {
      writes.push(`table ${id} active=${String(active)}`);
      state.tables.find((t) => t.id === id)!.isActive = active;
    },
    deleteItem: async (id) => void writes.push(`delete item ${id}`),
    deleteCategory: async (id) => void writes.push(`delete category ${id}`),
  };
  return { port, writes };
}

describe("preview and confirmation", () => {
  it("a preview writes nothing", async () => {
    const { port, writes } = fakePort(input());
    await collectPlan(port);
    expect(writes).toEqual([]);
  });

  it("apply refuses without the preview's token and with a wrong one, writing nothing", async () => {
    const { port, writes } = fakePort(input());
    await expect(applyPlan(port, { confirm: "" })).rejects.toThrow(/--confirm/);
    await expect(applyPlan(port, { confirm: "0000000000" })).rejects.toThrow(/does not match/);
    expect(writes).toEqual([]);
  });

  it("applies exactly the previewed steps: items first, then the category, never a delete by default", async () => {
    const { port, writes } = fakePort(input());
    const { token } = await collectPlan(port);
    const outcome = await applyPlan(port, { confirm: token });
    expect(outcome.results.every((r) => r.ok)).toBe(true);
    expect(outcome.historyUnchanged).toBe(true);
    expect(writes.filter((w) => w.startsWith("delete"))).toEqual([]);
    expect(writes).toContain(`category ${CAT.id} active=false`);
    expect(writes.at(-1)).toBe(`table ${TABLE.id} active=false`);
    expect(writes).toHaveLength(5); // three active items (one was already archived), the category and the table
    expect(outcome.remaining.totals.itemsToArchive).toBe(0);
  });

  it("records a failed step without stopping, and reports it with the database code only", async () => {
    const { port } = fakePort(input(), `item-${T}-0`);
    const { token } = await collectPlan(port);
    const outcome = await applyPlan(port, { confirm: token });
    const failed = outcome.results.filter((r) => !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe("XX000: boom");
    expect(outcome.results.filter((r) => r.ok).length).toBeGreaterThan(1);
  });

  it("the report shows ids, prices and counts, and says history is never modified", async () => {
    const { port } = fakePort(input());
    const text = formatPlan(await collectPlan(port), "127.0.0.1:54321");
    expect(text).toContain("IT 0805fb Category");
    expect(text).toContain("Grilled Sandwich ₹149");
    expect(text).toContain("Cold Coffee ₹119");
    expect(text).toContain("order history: 2 line(s)");
    expect(text).toMatch(/never modified/);
  });
});

describe("command line safety", () => {
  it("parses flags and rejects unknown ones", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, deleteUnreferenced: false });
    expect(parseArgs(["--apply", "--confirm", "abc", "--delete-unreferenced"])).toMatchObject({
      apply: true,
      confirm: "abc",
      deleteUnreferenced: true,
    });
    expect(parseArgs(["--confirm=xyz"]).confirm).toBe("xyz");
    expect(() => parseArgs(["--everything"])).toThrow(/Unknown argument/);
  });

  it("treats loopback exactly like the integration-test harness does", () => {
    for (const url of [
      "http://127.0.0.1:54321",
      "http://localhost:54321",
      "http://[::1]:54321",
      "http://host.docker.internal:54321",
      "https://abcdefgh.supabase.co",
      "http://127.0.0.1.evil.example:54321",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(isLocalUrl(url));
    }
  });

  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["scripts/cleanup-test-menu.mjs", ...args], {
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });

  it("refuses a hosted URL without echoing any key, and names missing variables", () => {
    const hosted = run({
      SUPABASE_URL: "https://abcdefgh.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "very-secret-value",
    });
    expect(hosted.status).toBe(1);
    expect(hosted.stderr).toMatch(/not a local/);
    expect(hosted.stdout + hosted.stderr).not.toContain("very-secret-value");

    const missing = run({});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("SUPABASE_URL");
    expect(missing.stderr).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("is read-only unless --apply is given, and --help works without a database", () => {
    expect(run({}, ["--help"]).status).toBe(0);
    const script = readFileSync("scripts/cleanup-test-data.mjs", "utf8");
    expect(script).toContain("if (!options.apply)");
  });

  it("keeps `pnpm cleanup:test-menu` as an alias of `pnpm cleanup:test-data`", () => {
    const scripts = (
      JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["cleanup:test-data"]).toBe("node scripts/cleanup-test-data.mjs");
    expect(scripts["cleanup:test-menu"]).toBe("node scripts/cleanup-test-menu.mjs");
    expect(readFileSync("scripts/cleanup-test-menu.mjs", "utf8")).toContain(
      'import "./cleanup-test-data.mjs"',
    );
    // Both entry points behave identically, including the refusal of a hosted URL.
    for (const script of ["cleanup-test-data.mjs", "cleanup-test-menu.mjs"]) {
      const result = spawnSync(process.execPath, [`scripts/${script}`], {
        env: {
          PATH: process.env.PATH ?? "",
          SUPABASE_URL: "https://abcdefgh.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "x",
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      expect(result.status, script).toBe(1);
      expect(result.stderr, script).toMatch(/not a local/);
    }
  });

  it("never writes to a history table", () => {
    const port = readFileSync("scripts/test-menu-cleanup/postgrest-port.mjs", "utf8");
    const writes = [...port.matchAll(/\.from\("(\w+)"\)\s*\.(?:update|delete|insert|upsert)/g)].map(
      (m) => m[1],
    );
    expect(new Set(writes)).toEqual(new Set(["menu_items", "menu_categories", "cafe_tables"]));
    expect(port).not.toMatch(/from\("cafe_tables"\)\s*\.delete/); // tables are never deleted
  });
});

/** Tables created by createWorld(): code IT<TAG>, label `IT table <tag>`. */
const table = (over: Partial<PlanInput["tables"][number]> = {}) => ({ ...TABLE, ...over });

describe("test tables", () => {
  it("accepts exactly the generator's table (code IT<TAG>, label IT table <tag>, same tag, same-run category)", () => {
    const plan = buildPlan(input());
    expect(plan.tableCandidates).toHaveLength(1);
    expect(plan.tableCandidates[0]).toMatchObject({
      tag: T,
      action: "deactivate",
      relatedCategory: true,
      relatedGroup: true,
    });
    expect(plan.skippedTables).toEqual([]);
  });

  it("matches the table createWorld() really inserts (kept in step with harness.ts)", () => {
    const harness = readFileSync("src/supabase-it/harness.ts", "utf8");
    expect(harness).toContain("const tableCode = `IT${tag.toUpperCase()}`");
    expect(harness).toContain("label: `IT table ${tag}`");
    expect(harness).toContain('insertOne("cafe_tables"');
  });

  it("does not accept a matching label with an unrelated code (the manager test's Z<TAG> table)", () => {
    const plan = buildPlan(input({ tables: [table({ code: `Z${T.toUpperCase()}` })] }));
    expect(plan.tableCandidates).toEqual([]);
    expect(plan.skippedTables[0]!.reason).toMatch(
      /label looks like a fixture.*code is not IT<TAG>/,
    );
  });

  it("does not accept a matching code with an unrelated label", () => {
    const plan = buildPlan(input({ tables: [table({ label: "Window seat" })] }));
    expect(plan.tableCandidates).toEqual([]);
    expect(plan.skippedTables[0]!.reason).toMatch(
      /code looks like a fixture.*label is not exactly/,
    );
  });

  it.each([
    ["different tags in code and label", { code: "IT111111", label: `IT table ${T}` }],
    ["an upper-case tag in the label", { label: `IT table ${T.toUpperCase()}` }],
    ["a code with the wrong length", { code: "IT0805F" }],
    ["a real table that merely starts with IT", { code: "ITALY", label: "IT corner" }],
  ])("protects %s", (_name, over) => {
    const plan = buildPlan(input({ tables: [table(over)] }));
    expect(plan.tableCandidates).toEqual([]);
    expect(plan.skippedTables).toHaveLength(1);
  });

  it("protects a hand-made table that looks perfect but has no same-run category or group", () => {
    const plan = buildPlan(input({ categories: [], items: [], groups: [] }));
    expect(plan.tableCandidates).toEqual([]);
    expect(plan.skippedTables[0]!.reason).toMatch(/cannot be told apart from a hand-made table/);
  });

  it("needs the same tag's category or group, created at about the same time", () => {
    const otherCategory = { ...CAT, slug: "it-111111-cat", name: "IT 111111 Category" };
    expect(buildPlan(input({ categories: [otherCategory], groups: [] })).tableCandidates).toEqual(
      [],
    );
    const old = { ...CAT, createdAt: "2026-01-01T00:00:00.000Z" };
    expect(buildPlan(input({ categories: [old], groups: [] })).tableCandidates).toEqual([]);
    expect(
      buildPlan(input({ categories: [], items: [], groups: [GROUP] })).tableCandidates,
    ).toHaveLength(1);
  });

  it("reports order history and other attempts, and still proposes deactivation (never deletion)", () => {
    const plan = buildPlan(
      input({
        tableOrderRefs: { [TABLE.id]: 3 },
        tableAttemptRefs: { [TABLE.id]: { pending: 0, other: 3 } },
      }),
    );
    expect(plan.tableCandidates[0]).toMatchObject({
      orderRefs: 3,
      otherAttempts: 3,
      action: "deactivate",
    });
    expect(plan.totals).toMatchObject({
      tables: 1,
      tablesWithOrderHistory: 1,
      tablesToDeactivate: 1,
    });
    expect(["deactivate", "already-inactive", "skip-unpaid-checkout"]).toContain(
      plan.tableCandidates[0]!.action, // there is no "delete" action for a table
    );
  });

  it("skips a table that an unpaid checkout references, and says so", async () => {
    const data = input({ tableAttemptRefs: { [TABLE.id]: { pending: 1, other: 0 } } });
    const plan = buildPlan(data);
    expect(plan.tableCandidates[0]!.action).toBe("skip-unpaid-checkout");
    expect(plan.totals.tablesSkippedUnpaidCheckout).toBe(1);
    expect(formatPlan(plan, "127.0.0.1:54321")).toMatch(/skipped: an unpaid checkout/);

    const { port, writes } = fakePort(data);
    const outcome = await applyPlan(port, { confirm: (await collectPlan(port)).token });
    expect(writes.some((w) => w.startsWith("table"))).toBe(false);
    expect(outcome.results.every((r) => r.ok)).toBe(true);
  });

  it("leaves an already inactive table alone", () => {
    const plan = buildPlan(input({ tables: [table({ isActive: false })] }));
    expect(plan.tableCandidates[0]!.action).toBe("already-inactive");
  });

  it("deactivates (never deletes) through the port, only the confirmed table, only with the right token", async () => {
    const stranger = table({ id: "tab-2", code: "T05", label: "Table 5" }); // a real table
    const lookalike = table({ id: "tab-3", code: "Z0805FB" });
    const { port, writes } = fakePort(input({ tables: [TABLE, stranger, lookalike] }));
    const plan = await collectPlan(port);
    expect(plan.tableCandidates.map((t) => t.table.id)).toEqual([TABLE.id]);

    await expect(applyPlan(port, { confirm: "0000000000" })).rejects.toThrow(/does not match/);
    expect(writes).toEqual([]);

    const outcome = await applyPlan(port, { confirm: plan.token, deleteUnreferenced: false });
    expect(writes.filter((w) => w.startsWith("table"))).toEqual([`table ${TABLE.id} active=false`]);
    expect(writes.some((w) => w.startsWith("delete"))).toBe(false);
    expect(outcome.remaining.tableCandidates[0]!.action).toBe("already-inactive");
  });

  it("changes the confirmation token when a table's situation changes", () => {
    const a = buildPlan(input()).token;
    const b = buildPlan(
      input({ tableAttemptRefs: { [TABLE.id]: { pending: 1, other: 0 } } }),
    ).token;
    expect(a).not.toBe(b);
  });

  it("a preview of tables writes nothing", async () => {
    const { port, writes } = fakePort(input());
    await collectPlan(port);
    expect(writes).toEqual([]);
  });
});
