import { describe, expect, it } from "vitest";

import { describeDbError } from "./errors";
import { diffIds, nextSortOrder, planMove, slugCandidates } from "./plan";
import {
  categorySchema,
  checkGroupRules,
  groupSchema,
  itemSchema,
  optionSchema,
  parse,
  slugify,
} from "./validation";

const CAT = "11111111-1111-4111-8111-111111111111";

const validItem = {
  name: "  Club   Sandwich ",
  categoryId: CAT,
  description: "",
  ingredients: "  chicken, lettuce ",
  dietaryTags: ["non-veg", "non-veg", "spicy"],
  isActive: true,
  isAvailable: true,
};

// The schema reads the price from the `pricePaise` key as typed rupees ("249.50" -> 24950 paise).
const itemInput = (over: Record<string, unknown> = {}) => ({
  ...validItem,
  pricePaise: "249.50",
  ...over,
});

describe("item validation", () => {
  it("cleans text, converts rupees to integer paise and de-duplicates tags", () => {
    const result = parse(itemSchema, itemInput());
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        name: "Club Sandwich",
        description: null,
        ingredients: "chicken, lettuce",
        dietaryTags: ["non-veg", "spicy"],
        pricePaise: 24950,
      }),
    });
  });

  it.each([
    ["249", 24900],
    ["0", 0],
    ["0.5", 50],
    ["₹ 120", 12000],
    ["100000", 10_000_000],
    ["19.99", 1999],
  ])("price %j is %i paise exactly (no floating point)", (typed, paise) => {
    const result = parse(itemSchema, itemInput({ pricePaise: typed }));
    expect(result).toMatchObject({ ok: true, data: { pricePaise: paise } });
  });

  it.each(["", "  ", "abc", "-5", "12.345", "1e3", "1,200", "100000.01", "0x10", "٣"])(
    "rejects price %j with a message about the price",
    (typed) => {
      const result = parse(itemSchema, itemInput({ pricePaise: typed }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.pricePaise).toMatch(/Price/);
    },
  );

  it("requires a name, a real category id and only known dietary tags", () => {
    const result = parse(
      itemSchema,
      itemInput({ name: "   ", categoryId: "nope", dietaryTags: ["gluten-free"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["categoryId", "dietaryTags", "name"]);
    }
  });

  it("limits lengths like the database does", () => {
    for (const over of [
      { name: "x".repeat(81) },
      { description: "x".repeat(501) },
      { ingredients: "x".repeat(501) },
    ]) {
      expect(parse(itemSchema, itemInput(over)).ok, JSON.stringify(Object.keys(over))).toBe(false);
    }
    expect(parse(itemSchema, itemInput({ name: "x".repeat(80) })).ok).toBe(true);
  });

  it("never lets a non-string slip through as money", () => {
    for (const bad of [24950, null, undefined, {}, ["1"]]) {
      expect(parse(itemSchema, itemInput({ pricePaise: bad })).ok).toBe(false);
    }
  });
});

describe("category validation", () => {
  it("accepts a name and optional description", () => {
    expect(parse(categorySchema, { name: " Hot  drinks ", description: "" })).toEqual({
      ok: true,
      data: { name: "Hot drinks", description: null },
    });
  });
  it("rejects an empty or over-long name", () => {
    expect(parse(categorySchema, { name: " ", description: "" }).ok).toBe(false);
    expect(parse(categorySchema, { name: "x".repeat(81), description: "" }).ok).toBe(false);
  });
});

describe("modifier group validation", () => {
  const group = (over: Record<string, unknown> = {}) => ({
    name: "Bread",
    minSelect: "1",
    maxSelect: "1",
    isActive: true,
    ...over,
  });

  it("parses required single-choice and optional multi-choice groups", () => {
    expect(parse(groupSchema, group())).toMatchObject({
      ok: true,
      data: { minSelect: 1, maxSelect: 1 },
    });
    expect(parse(groupSchema, group({ minSelect: "0", maxSelect: "5" }))).toMatchObject({
      ok: true,
      data: { minSelect: 0, maxSelect: 5 },
    });
  });

  it.each([
    [{ minSelect: "2", maxSelect: "1" }, "maxSelect"],
    [{ maxSelect: "0" }, "maxSelect"],
    [{ maxSelect: "21" }, "maxSelect"],
    [{ minSelect: "-1" }, "minSelect"],
    [{ minSelect: "1.5" }, "minSelect"],
    [{ minSelect: "" }, "minSelect"],
    [{ maxSelect: "many" }, "maxSelect"],
  ])("rejects %j", (over, field) => {
    const result = parse(groupSchema, group(over));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveProperty(field);
  });
});

describe("modifier option validation", () => {
  const option = (over: Record<string, unknown> = {}) => ({
    name: "Extra cheese",
    priceDeltaPaise: "30",
    isDefault: false,
    isActive: true,
    isAvailable: true,
    ...over,
  });

  it("prices options in integer paise, free options allowed", () => {
    expect(parse(optionSchema, option())).toMatchObject({
      ok: true,
      data: { priceDeltaPaise: 3000 },
    });
    expect(parse(optionSchema, option({ priceDeltaPaise: "0" }))).toMatchObject({
      ok: true,
      data: { priceDeltaPaise: 0 },
    });
  });

  it("rejects negative, fractional-paise and over-limit extras", () => {
    for (const bad of ["-1", "0.001", "10000.01", "free"]) {
      expect(parse(optionSchema, option({ priceDeltaPaise: bad })).ok, bad).toBe(false);
    }
    expect(parse(optionSchema, option({ priceDeltaPaise: "10000" })).ok).toBe(true);
  });
});

describe("checkGroupRules (rules the database cannot express)", () => {
  it("a satisfiable group has no problems", () => {
    expect(
      checkGroupRules({ minSelect: 1, maxSelect: 1, activeOptions: 3, defaultOptions: 1 }),
    ).toEqual([]);
    expect(
      checkGroupRules({ minSelect: 0, maxSelect: 3, activeOptions: 0, defaultOptions: 0 }),
    ).toEqual([]);
  });

  it("a required group needs enough active options", () => {
    const [problem] = checkGroupRules({
      minSelect: 2,
      maxSelect: 3,
      activeOptions: 1,
      defaultOptions: 0,
    });
    expect(problem).toMatch(/at least 2 choices but would have only 1 active option\./);
  });

  it("defaults may not exceed the maximum", () => {
    const [problem] = checkGroupRules({
      minSelect: 0,
      maxSelect: 1,
      activeOptions: 3,
      defaultOptions: 2,
    });
    expect(problem).toMatch(/Only 1 option can be pre-selected/);
  });

  it("reports every problem", () => {
    expect(
      checkGroupRules({ minSelect: 3, maxSelect: 1, activeOptions: 1, defaultOptions: 2 }),
    ).toHaveLength(2);
  });
});

describe("slugify", () => {
  it.each([
    ["Club Sandwich", "club-sandwich"],
    ["  Café   Latte! ", "cafe-latte"],
    ["Veg & Cheese (Large)", "veg-cheese-large"],
    ["!!!", "item"],
    ["", "item"],
    ["நன்றி", "item"],
    ["A".repeat(100), "a".repeat(60)],
  ])("%j -> %j", (name, slug) => expect(slugify(name)).toBe(slug));

  it("always produces the database's slug format", () => {
    for (const name of ["x", "a--b", "-lead", "trail-", "Ünï Çödé", "1 2 3"]) {
      expect(slugify(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("planMove", () => {
  const rows = [
    { id: "a", sort_order: 10 },
    { id: "b", sort_order: 20 },
    { id: "c", sort_order: 30 },
  ];

  it("swaps with the neighbour", () => {
    expect(planMove(rows, "b", "up")).toEqual([
      { id: "b", sort_order: 10 },
      { id: "a", sort_order: 20 },
    ]);
    expect(planMove(rows, "b", "down")).toEqual([
      { id: "c", sort_order: 20 },
      { id: "b", sort_order: 30 },
    ]);
  });

  it("does nothing at the edges or for an unknown id", () => {
    expect(planMove(rows, "a", "up")).toEqual([]);
    expect(planMove(rows, "c", "down")).toEqual([]);
    expect(planMove(rows, "zzz", "up")).toEqual([]);
    expect(planMove([], "a", "up")).toEqual([]);
  });

  it("still moves rows that share a sort_order (new rows default to 0)", () => {
    const tied = [
      { id: "a", sort_order: 0 },
      { id: "b", sort_order: 0 },
      { id: "c", sort_order: 0 },
    ];
    expect(planMove(tied, "c", "up")).toEqual([
      { id: "a", sort_order: 10 },
      { id: "c", sort_order: 20 },
      { id: "b", sort_order: 30 },
    ]);
  });

  it("applying a plan and re-planning keeps a consistent order", () => {
    let current = rows;
    for (const [id, dir] of [
      ["a", "down"],
      ["a", "down"],
      ["c", "up"],
    ] as const) {
      const updates = new Map(planMove(current, id, dir).map((u) => [u.id, u.sort_order]));
      current = current
        .map((r) => ({ ...r, sort_order: updates.get(r.id) ?? r.sort_order }))
        .sort((x, y) => x.sort_order - y.sort_order);
    }
    expect(current.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(new Set(current.map((r) => r.sort_order)).size).toBe(3);
  });
});

describe("small planners", () => {
  it("nextSortOrder", () => {
    expect(nextSortOrder([])).toBe(10);
    expect(nextSortOrder([10, 50, 30])).toBe(60);
    expect(nextSortOrder([0, 0])).toBe(10);
  });
  it("slugCandidates", () => {
    expect(slugCandidates("club", 3)).toEqual(["club", "club-2", "club-3"]);
  });
  it("diffIds", () => {
    expect(diffIds(["a", "b"], ["b", "c", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(diffIds([], [])).toEqual({ add: [], remove: [] });
  });
});

describe("describeDbError", () => {
  it("duplicates name what already exists, per subject", () => {
    expect(
      describeDbError(
        {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "menu_items_category_name_lower_unique"',
        },
        "item",
      ),
    ).toMatchObject({
      kind: "duplicate",
      field: "name",
      message: expect.stringContaining("already exists in this category"),
    });
    expect(
      describeDbError(
        { code: "23505", message: 'violates unique constraint "cafe_tables_code_unique"' },
        "table",
      ),
    ).toMatchObject({ kind: "duplicate", field: "code" });
    expect(
      describeDbError(
        {
          code: "23505",
          message: 'violates unique constraint "menu_categories_name_lower_unique"',
        },
        "category",
      ).message,
    ).toBe("A category with this name already exists.");
  });

  it("explains deletes that relationships forbid, and how to proceed", () => {
    expect(describeDbError({ code: "23503" }, "item", "delete").message).toMatch(
      /Archive it instead/,
    );
    expect(describeDbError({ code: "23001" }, "item", "delete").message).toMatch(/unpaid checkout/);
    expect(describeDbError({ code: "23503" }, "category", "delete").message).toMatch(
      /still contains items/,
    );
    expect(describeDbError({ code: "23503" }, "modifier group", "delete").message).toMatch(
      /still used by menu items/,
    );
  });

  it("maps permission and not-found errors", () => {
    expect(describeDbError({ code: "42501" }, "item")).toMatchObject({ kind: "forbidden" });
    expect(describeDbError({ code: "PGRST116" }, "table")).toMatchObject({ kind: "not_found" });
  });

  it("treats network trouble as retryable and never echoes raw database text", () => {
    expect(describeDbError({ message: "TypeError: fetch failed" }, "item").kind).toBe(
      "unavailable",
    );
    const secret = 'relation "menu_items" column "price_paise" violates something internal';
    for (const code of ["XX000", "", "42P01", "23514", "22P02"]) {
      expect(describeDbError({ code, message: secret }, "item").message).not.toMatch(
        /menu_items|price_paise|relation/,
      );
    }
  });
});
