import { describe, expect, it } from "vitest";

import {
  addLine,
  cartCount,
  lineKey,
  parseStoredCart,
  removeLine,
  replaceLine,
  serialiseCart,
  setQuantity,
} from "./cart";
import { buildCatalog, findItem } from "./catalog";
import { catalog, ids, rows, settings } from "./fixtures";
import { priceCart } from "./pricing";
import {
  defaultSelection,
  itemOrderability,
  orderSizeProblem,
  priceLine,
  quantityProblem,
  validateSelection,
} from "./rules";
import { buildOrderSnapshot, cleanCustomerName, cleanInstructions } from "./snapshot";

const limits = { maxItemQuantity: 10, maxItemsPerOrder: 30 };
const table = { id: "10000000-0000-4000-8000-000000000003", code: "T01", label: "Table 1" };

describe("buildCatalog", () => {
  it("shows only active, non-empty categories and items in sort order", () => {
    const c = catalog();
    expect(c.categories.map((x) => x.name)).toEqual(["Sandwiches", "Drinks"]);
    expect(findItem(c, ids.hidden)).toBeUndefined();
    expect(findItem(c, ids.soldOut)?.isAvailable).toBe(false);
  });
  it("drops archived options and keeps sold-out ones flagged", () => {
    const grilled = findItem(catalog(), ids.grilled)!;
    const extras = grilled.groups.find((g) => g.id === ids.groupExtras)!;
    expect(extras.options.map((o) => o.name)).toEqual(["Extra cheese", "Mayo", "Jalapeño"]);
    expect(extras.options.at(-1)?.isAvailable).toBe(false);
  });
  it("ignores inactive groups", () => {
    const r = rows();
    r.groups[1]!.is_active = false;
    expect(findItem(buildCatalog(r), ids.grilled)!.groups).toHaveLength(1);
  });
});

describe("selection rules", () => {
  const grilled = () => findItem(catalog(), ids.grilled)!;
  it("pre-selects available defaults", () => {
    expect(defaultSelection(grilled())).toEqual([ids.white]);
  });
  it("requires a choice in a required group", () => {
    const r = validateSelection(grilled(), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatchObject({ code: "too_few", groupId: ids.groupBread });
  });
  it("enforces the maximum", () => {
    const r = validateSelection(grilled(), [ids.white, ids.brown]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.code === "too_many")).toBe(true);
  });
  it("rejects sold-out, unknown, archived and duplicate options", () => {
    for (const [pick, code] of [
      [[ids.white, ids.jalapeno], "option_unavailable"],
      [[ids.white, ids.archivedOpt], "unknown_option"],
      [[ids.white, "40000000-0000-4000-8000-0000000000ff"], "unknown_option"],
      [[ids.white, ids.mayo, ids.mayo], "duplicate_option"],
    ] as const) {
      const r = validateSelection(grilled(), pick);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.map((p) => p.code)).toContain(code);
    }
  });
  it("accepts a valid selection and prices it in integer paise", () => {
    const r = validateSelection(grilled(), [ids.brown, ids.cheese, ids.mayo]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(priceLine(grilled(), r.chosen, 2)).toEqual({
        unitPaise: 14900,
        optionsPaise: 4000,
        eachPaise: 18900,
        totalPaise: 37800,
      });
    }
  });
  it("returns chosen options in menu order, whatever order the ids arrive in", () => {
    const r = validateSelection(grilled(), [ids.mayo, ids.brown, ids.cheese]);
    expect(r.ok && r.chosen.map((c) => c.option.name)).toEqual(["Brown", "Extra cheese", "Mayo"]);
  });
  it("reports unorderable items", () => {
    expect(itemOrderability(findItem(catalog(), ids.soldOut)!)).toMatchObject({
      ok: false,
      reason: "sold_out",
    });
    const r = rows();
    r.options.forEach((o) => {
      if (o.group_id === ids.groupBread) o.is_available = false;
    });
    expect(itemOrderability(findItem(buildCatalog(r), ids.grilled)!)).toMatchObject({
      ok: false,
      reason: "unconfigurable",
    });
  });
  it("validates quantity and order size", () => {
    expect(quantityProblem(0, settings)).not.toBeNull();
    expect(quantityProblem(1.5, settings)).not.toBeNull();
    expect(quantityProblem("2", settings)).not.toBeNull();
    expect(quantityProblem(11, settings)).toMatch(/at most 10/);
    expect(quantityProblem(10, settings)).toBeNull();
    expect(orderSizeProblem([10, 10, 11], settings)).toMatch(/at most 30/);
    expect(orderSizeProblem([10, 10, 10], settings)).toBeNull();
  });
});

describe("cart operations", () => {
  it("keys lines by item + sorted options, so order of choices does not matter", () => {
    expect(lineKey(ids.grilled, [ids.mayo, ids.cheese])).toBe(
      lineKey(ids.grilled, [ids.cheese, ids.mayo]),
    );
    expect(lineKey(ids.grilled, [ids.cheese])).not.toBe(lineKey(ids.grilled, [ids.mayo]));
  });
  it("adds, merges identical lines and keeps different combos separate", () => {
    let lines = [] as ReturnType<typeof parseStoredCart>;
    for (const opts of [[ids.white], [ids.white], [ids.brown]]) {
      const r = addLine(lines, { menuItemId: ids.grilled, optionIds: opts, quantity: 1 }, limits);
      if (!r.ok) throw new Error(r.message);
      lines = r.lines;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]!.quantity).toBe(2);
    expect(cartCount(lines)).toBe(3);
  });
  it("enforces per-item and per-order limits", () => {
    const base = addLine([], { menuItemId: ids.cola, optionIds: [], quantity: 10 }, limits);
    if (!base.ok) throw new Error("x");
    expect(
      addLine(base.lines, { menuItemId: ids.cola, optionIds: [], quantity: 1 }, limits).ok,
    ).toBe(false);
    const small = { maxItemQuantity: 10, maxItemsPerOrder: 12 };
    const two = addLine(base.lines, { menuItemId: ids.hidden, optionIds: [], quantity: 3 }, small);
    expect(two.ok).toBe(false);
    expect(addLine([], { menuItemId: ids.cola, optionIds: [], quantity: 0 }, limits).ok).toBe(
      false,
    );
  });
  it("changes quantity, removes at zero, and removes lines", () => {
    const a = addLine([], { menuItemId: ids.cola, optionIds: [], quantity: 2 }, limits);
    if (!a.ok) throw new Error("x");
    const key = a.lines[0]!.key;
    const up = setQuantity(a.lines, key, 3, limits);
    expect(up.ok && up.lines[0]!.quantity).toBe(3);
    expect(setQuantity(a.lines, key, 11, limits).ok).toBe(false);
    const zero = setQuantity(a.lines, key, 0, limits);
    expect(zero.ok && zero.lines).toEqual([]);
    expect(removeLine(a.lines, key)).toEqual([]);
  });
  it("edits a line in place and merges into an existing twin", () => {
    let lines = [] as ReturnType<typeof parseStoredCart>;
    for (const opts of [[ids.white], [ids.brown]]) {
      const r = addLine(lines, { menuItemId: ids.grilled, optionIds: opts, quantity: 1 }, limits);
      if (!r.ok) throw new Error("x");
      lines = r.lines;
    }
    const edited = replaceLine(
      lines,
      lines[0]!.key,
      { menuItemId: ids.grilled, optionIds: [ids.white, ids.mayo], quantity: 2 },
      limits,
    );
    if (!edited.ok) throw new Error("x");
    expect(edited.lines.map((l) => l.optionIds.length)).toEqual([2, 1]);
    expect(edited.lines[0]!.quantity).toBe(2);
    const merged = replaceLine(
      lines,
      lines[0]!.key,
      { menuItemId: ids.grilled, optionIds: [ids.brown], quantity: 1 },
      limits,
    );
    expect(merged.ok && merged.lines).toHaveLength(1);
    expect(merged.ok && merged.lines[0]!.quantity).toBe(2);
  });
  it("round-trips through storage and treats anything else as an empty cart", () => {
    const a = addLine(
      [],
      { menuItemId: ids.grilled, optionIds: [ids.mayo, ids.white], quantity: 2 },
      limits,
    );
    if (!a.ok) throw new Error("x");
    expect(parseStoredCart(serialiseCart(a.lines))).toEqual(a.lines);
    for (const bad of [
      null,
      "",
      "{",
      "[]",
      '{"version":2,"lines":[]}',
      '{"version":1,"lines":[{"menuItemId":"x","optionIds":[],"quantity":1}]}',
      '{"version":1,"lines":[{"menuItemId":"' + ids.cola + '","optionIds":[],"quantity":0}]}',
    ]) {
      expect(parseStoredCart(bad)).toEqual([]);
    }
  });
  it("never stores prices or names", () => {
    const a = addLine([], { menuItemId: ids.cola, optionIds: [], quantity: 1 }, limits);
    if (!a.ok) throw new Error("x");
    expect(serialiseCart(a.lines)).not.toMatch(/price|name|paise|total/i);
  });
});

describe("priceCart (server-side authority)", () => {
  const line = (menuItemId: string, optionIds: string[], quantity: number) => {
    const r = addLine(
      [],
      { menuItemId, optionIds, quantity },
      { maxItemQuantity: 99, maxItemsPerOrder: 99 },
    );
    if (!r.ok) throw new Error(r.message);
    return r.lines[0]!;
  };
  it("totals valid lines from catalog prices", () => {
    const p = priceCart(catalog(), settings, [
      line(ids.grilled, [ids.brown, ids.cheese], 2),
      line(ids.cola, [], 1),
    ]);
    expect(p.canCheckout).toBe(true);
    expect(p.totalPaise).toBe((14900 + 1000 + 2500) * 2 + 4000);
    expect(p.itemCount).toBe(3);
  });
  it("blocks an empty cart", () => {
    const p = priceCart(catalog(), settings, []);
    expect(p.canCheckout).toBe(false);
    expect(p.blockers.join()).toMatch(/empty/);
  });
  it("flags removed, sold-out and changed items and excludes them from the total", () => {
    const p = priceCart(catalog(), settings, [
      line("20000000-0000-4000-8000-0000000000ff", [], 1),
      line(ids.soldOut, [], 1),
      line(ids.grilled, [ids.white, ids.jalapeno], 1),
      line(ids.grilled, [], 1),
      line(ids.cola, [], 2),
    ]);
    expect(p.lines.map((l) => l.status)).toEqual([
      "removed",
      "sold_out",
      "sold_out",
      "changed",
      "ok",
    ]);
    expect(p.totalPaise).toBe(8000);
    expect(p.canCheckout).toBe(false);
  });
  it("blocks when orders are paused or the order is too large", () => {
    const paused = priceCart(catalog(), { ...settings, ordersEnabled: false }, [
      line(ids.cola, [], 1),
    ]);
    expect(paused.canCheckout).toBe(false);
    expect(paused.blockers.join()).toMatch(/isn't taking orders/);
    const big = priceCart(catalog(), { ...settings, maxItemsPerOrder: 2 }, [line(ids.cola, [], 3)]);
    expect(big.canCheckout).toBe(false);
  });
  it("flags a quantity above the cafe maximum", () => {
    const p = priceCart(catalog(), settings, [line(ids.cola, [], 11)]);
    expect(p.lines[0]!.status).toBe("invalid");
  });
  it("uses current prices, not anything remembered by the cart", () => {
    const l = line(ids.cola, [], 1);
    const r = rows();
    r.items.find((i) => i.id === ids.cola)!.price_paise = 4500;
    expect(priceCart(buildCatalog(r), settings, [l]).totalPaise).toBe(4500);
  });
});

describe("order snapshot (cart_snapshot v1)", () => {
  const ready = () => {
    const r = addLine(
      [],
      { menuItemId: ids.grilled, optionIds: [ids.brown, ids.mayo], quantity: 2 },
      limits,
    );
    if (!r.ok) throw new Error("x");
    return priceCart(catalog(), settings, r.lines);
  };
  it("matches the schema shape and total", () => {
    const s = buildOrderSnapshot(table, ready(), {
      customerName: "  Asha  ",
      specialInstructions: "No onions",
    });
    expect(s.version).toBe(1);
    expect(s.customer_name).toBe("Asha");
    expect(s.items[0]).toMatchObject({ unit_price_paise: 14900, quantity: 2, note: null });
    expect(s.items[0]!.options).toHaveLength(2);
    expect(s.total_paise).toBe((14900 + 1000 + 500) * 2);
  });
  it("refuses to build for a cart that is not ready", () => {
    expect(() => buildOrderSnapshot(table, priceCart(catalog(), settings, []))).toThrow();
  });
  it("cleans and bounds free text", () => {
    expect(cleanCustomerName("  \n ")).toBeNull();
    expect(cleanCustomerName("A\nB")).toBe("A B");
    expect(cleanCustomerName("x".repeat(200))).toHaveLength(60);
    expect(cleanInstructions("a\u0000b")).toBe("ab");
    expect(cleanInstructions("y".repeat(900))).toHaveLength(500);
  });
});
