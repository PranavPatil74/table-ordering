import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Menu Server Actions. They are public endpoints, so what matters here is that EVERY one of them
 * refuses signed-out and counter callers before touching the database, rejects malformed input,
 * and never leaks a raw error. The repository and the session guard are test doubles: these tests
 * prove the wiring and the refusal paths, not PostgREST behaviour (see the supabase tests).
 */

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

const requireStaffAction = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireStaffAction: (...args: unknown[]) => requireStaffAction(...args),
}));

const names = [
  "createCategory",
  "updateCategory",
  "setCategoryActive",
  "deleteCategory",
  "moveCategory",
  "createItem",
  "updateItem",
  "setItemFlag",
  "deleteItem",
  "moveItem",
  "setItemModifierGroups",
  "createGroup",
  "updateGroup",
  "setGroupActive",
  "deleteGroup",
  "moveGroup",
  "createOption",
  "updateOption",
  "setOptionFlag",
  "deleteOption",
  "moveOption",
] as const;
const repo = Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<
  (typeof names)[number],
  ReturnType<typeof vi.fn>
>;
vi.mock("@/lib/menu/repository", () => repo);

const actions = await import("./actions");

const ID = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const SUPABASE = { marker: "the caller's own client" };

const form = (fields: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
};

const asManager = () =>
  requireStaffAction.mockResolvedValue({
    ok: true,
    staff: { role: "manager" },
    supabase: SUPABASE,
  });

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(repo)) fn.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Every action, called with valid arguments, so the guard tests cover all of them. */
const everyAction: [string, () => Promise<unknown>][] = [
  [
    "saveCategoryAction",
    () => actions.saveCategoryAction(null, form({ id: "", name: "Drinks", description: "" })),
  ],
  ["setCategoryActiveAction", () => actions.setCategoryActiveAction(ID, false)],
  ["deleteCategoryAction", () => actions.deleteCategoryAction(ID)],
  ["moveCategoryAction", () => actions.moveCategoryAction(ID, "up")],
  [
    "saveItemAction",
    () =>
      actions.saveItemAction(
        null,
        form({
          id: "",
          name: "Tea",
          categoryId: CAT,
          price: "50",
          isActive: "on",
          isAvailable: "on",
        }),
      ),
  ],
  ["setItemFlagAction", () => actions.setItemFlagAction(ID, "is_available", false)],
  ["deleteItemAction", () => actions.deleteItemAction(ID)],
  ["moveItemAction", () => actions.moveItemAction(ID, "down")],
  [
    "saveItemGroupsAction",
    () => actions.saveItemGroupsAction(null, form({ itemId: ID, groupIds: [CAT] })),
  ],
  [
    "saveGroupAction",
    () =>
      actions.saveGroupAction(
        null,
        form({ id: "", name: "Size", minSelect: "0", maxSelect: "1", isActive: "on" }),
      ),
  ],
  ["setGroupActiveAction", () => actions.setGroupActiveAction(ID, true)],
  ["deleteGroupAction", () => actions.deleteGroupAction(ID)],
  ["moveGroupAction", () => actions.moveGroupAction(ID, "up")],
  [
    "saveOptionAction",
    () =>
      actions.saveOptionAction(
        null,
        form({
          id: "",
          groupId: ID,
          name: "Large",
          price: "20",
          isActive: "on",
          isAvailable: "on",
        }),
      ),
  ],
  ["setOptionFlagAction", () => actions.setOptionFlagAction(ID, "is_default", true)],
  ["deleteOptionAction", () => actions.deleteOptionAction(ID)],
  ["moveOptionAction", () => actions.moveOptionAction(ID, "down")],
];

const repoCalls = () => Object.values(repo).reduce((total, fn) => total + fn.mock.calls.length, 0);

describe("every menu action refuses callers who are not an active manager", () => {
  it.each(everyAction)("%s: signed-out visitor", async (_name, run) => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "Your session has expired. Sign in again to continue.",
    });
    const result = await run();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Sign in again") });
    expect(repoCalls()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(everyAction)("%s: counter staff", async (_name, run) => {
    requireStaffAction.mockResolvedValue({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(await run()).toMatchObject({
      ok: false,
      message: "You don't have permission to do that.",
    });
    expect(repoCalls()).toBe(0);
  });

  it.each(everyAction)("%s: asks for the MANAGER role specifically", async (_name, run) => {
    asManager();
    for (const fn of Object.values(repo)) fn.mockResolvedValue({ ok: true, data: { id: ID } });
    try {
      await run();
    } catch (error) {
      if (!(error instanceof Redirected)) throw error;
    }
    expect(requireStaffAction).toHaveBeenCalledWith("manager");
  });
});

describe("a manager's valid requests reach the repository with the caller's own client", () => {
  it("creates an item from typed rupees as integer paise, then redirects to its page", async () => {
    asManager();
    repo.createItem.mockResolvedValue({ ok: true, data: { id: ID } });
    await expect(
      actions.saveItemAction(
        null,
        form({
          id: "",
          name: " Club  Sandwich ",
          categoryId: CAT,
          price: "249.50",
          dietaryTags: ["non-veg"],
          isActive: "on",
          isAvailable: "on",
        }),
      ),
    ).rejects.toMatchObject({ to: `/staff/manager/menu/items/${ID}?created=1` });
    expect(repo.createItem).toHaveBeenCalledWith(
      SUPABASE,
      expect.objectContaining({
        name: "Club Sandwich",
        categoryId: CAT,
        pricePaise: 24950,
        dietaryTags: ["non-veg"],
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/staff/manager", "layout");
  });

  it("updates an existing item and reports success", async () => {
    asManager();
    repo.updateItem.mockResolvedValue({ ok: true, data: { id: ID } });
    const result = await actions.saveItemAction(
      null,
      form({ id: ID, name: "Tea", categoryId: CAT, price: "50", isActive: "on" }),
    );
    expect(result).toMatchObject({ ok: true, message: "Item saved." });
    expect(repo.updateItem).toHaveBeenCalledWith(
      SUPABASE,
      ID,
      expect.objectContaining({ pricePaise: 5000, isAvailable: false }),
    );
  });

  it("toggles sold out", async () => {
    asManager();
    repo.setItemFlag.mockResolvedValue({ ok: true, data: { id: ID } });
    expect(await actions.setItemFlagAction(ID, "is_available", false)).toMatchObject({
      ok: true,
      message: "Marked sold out.",
    });
    expect(repo.setItemFlag).toHaveBeenCalledWith(SUPABASE, ID, "is_available", false);
  });

  it("surfaces a rule violation from the repository as a field error and does not revalidate", async () => {
    asManager();
    repo.createOption.mockResolvedValue({
      ok: false,
      message: "An option with this name already exists.",
      kind: "duplicate",
      field: "name",
    });
    const result = await actions.saveOptionAction(
      null,
      form({ id: "", groupId: ID, name: "Large", price: "20", isActive: "on", isAvailable: "on" }),
    );
    expect(result).toEqual({
      ok: false,
      message: "An option with this name already exists.",
      fieldErrors: { name: "An option with this name already exists." },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("invalid input is rejected on the server, before any write", () => {
  beforeEach(asManager);

  it.each([
    ["a non-numeric price", { price: "abc" }, "price"],
    ["a negative price", { price: "-5" }, "price"],
    ["three decimals", { price: "12.345" }, "price"],
    ["a price above the database limit", { price: "100001" }, "price"],
    ["an empty name", { name: "   " }, "name"],
    ["a too-long name", { name: "x".repeat(81) }, "name"],
    ["a category id that is not a uuid", { categoryId: "not-a-uuid" }, "categoryId"],
    ["an unknown dietary tag", { dietaryTags: ["gluten-free-ish"] }, "dietaryTags"],
  ])("item with %s", async (_label, override, field) => {
    const base = {
      id: "",
      name: "Tea",
      categoryId: CAT,
      price: "50",
      isActive: "on",
      isAvailable: "on",
    };
    const result = await actions.saveItemAction(null, form({ ...base, ...override }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { fieldErrors?: Record<string, string> }).fieldErrors).toHaveProperty(field);
    expect(repoCalls()).toBe(0);
  });

  it.each([
    ["min above max", { minSelect: "3", maxSelect: "2" }],
    ["max above 20", { minSelect: "0", maxSelect: "21" }],
    ["max of zero", { minSelect: "0", maxSelect: "0" }],
    ["fractional counts", { minSelect: "1.5", maxSelect: "2" }],
  ])("modifier group with %s", async (_label, override) => {
    const result = await actions.saveGroupAction(
      null,
      form({ id: "", name: "Size", isActive: "on", ...override }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(repoCalls()).toBe(0);
  });

  it("option price delta above the limit or negative", async () => {
    for (const price of ["10001", "-1", "1e3"]) {
      const result = await actions.saveOptionAction(
        null,
        form({ id: "", groupId: ID, name: "Large", price, isActive: "on", isAvailable: "on" }),
      );
      expect(result).toMatchObject({ ok: false });
    }
    expect(repoCalls()).toBe(0);
  });

  it.each([
    [
      "setItemFlagAction",
      () => actions.setItemFlagAction("../../etc/passwd", "is_available", true),
    ],
    [
      "setItemFlagAction (unknown flag)",
      () => actions.setItemFlagAction(ID, "price_paise" as "is_active", true),
    ],
    ["deleteItemAction", () => actions.deleteItemAction("1; drop table menu_items")],
    ["moveItemAction (bad direction)", () => actions.moveItemAction(ID, "sideways" as "up")],
    [
      "setOptionFlagAction (unknown flag)",
      () => actions.setOptionFlagAction(ID, "is_admin" as "is_active", true),
    ],
    [
      "saveItemGroupsAction (bad id)",
      () => actions.saveItemGroupsAction(null, form({ itemId: ID, groupIds: ["nope"] })),
    ],
  ])("%s rejects malformed arguments", async (_name, run) => {
    expect(await run()).toMatchObject({ ok: false, message: "That request is not valid." });
    expect(repoCalls()).toBe(0);
  });
});

describe("errors are safe", () => {
  it("an unexpected exception becomes a generic message with no internals", async () => {
    asManager();
    repo.deleteItem.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
    );
    const result = await actions.deleteItemAction(ID);
    expect(result).toEqual({
      ok: false,
      message: "Something went wrong. Nothing was saved. Try again.",
    });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/ECONNREFUSED|hunter2/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
