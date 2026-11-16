import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as menu from "@/lib/menu/repository";
import {
  categorySchema,
  groupSchema,
  itemSchema,
  optionSchema,
  parse,
} from "@/lib/menu/validation";
import * as tables from "@/lib/tables/repository";

import { expectDenied } from "./assertions";
import {
  anonClient,
  createUser,
  must,
  newRunTag,
  serviceClient,
  Tracker,
  type TestUser,
} from "./harness";

/**
 * Phase 3 against the REAL local Supabase stack (PostgREST + Auth + RLS): the exact repository
 * functions the manager screens use, run as a real signed-in manager, a real counter, a signed-in
 * user with no staff profile, and an anonymous visitor. Needs `supabase start` + `supabase db
 * reset`; run with `pnpm test:supabase`. Data is tagged with the run id and cleaned up best-effort.
 */

const tag = newRunTag();
const upper = tag.toUpperCase();
const tracker = new Tracker();
const service = serviceClient();
const anon = anonClient();
let manager: TestUser;
let counter: TestUser;
let plain: TestUser;

beforeAll(async () => {
  manager = await createUser(tag, "mgr", tracker, {
    role: "manager",
    displayName: `IT manager ${tag}`,
  });
  counter = await createUser(tag, "cnt", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  plain = await createUser(tag, "plain", tracker);
});
afterAll(async () => {
  await tracker.cleanup();
});

const okData = <T>(result: menu.RepoResult<T>, what: string): T => {
  if (!result.ok) throw new Error(`${what} failed: ${result.kind}: ${result.message}`);
  return result.data;
};
const inputOf = <T>(schema: Parameters<typeof parse>[0], raw: unknown): T => {
  const parsed = parse(schema, raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${JSON.stringify(parsed.errors)}`);
  return parsed.data as T;
};

describe("manager: menu CRUD with the real database", () => {
  const ids: { category?: string; item?: string; group?: string; option?: string } = {};

  it("creates a category and an item; the price is stored as integer paise and anon sees it", async () => {
    const category = okData(
      await menu.createCategory(
        manager.client,
        inputOf(categorySchema, { name: `IT Cat ${tag}`, description: "" }),
      ),
      "createCategory",
    );
    tracker.row("menu_categories", category.id);
    ids.category = category.id;
    expect(category.slug).toBe(`it-cat-${tag}`);

    const item = okData(
      await menu.createItem(
        manager.client,
        inputOf(itemSchema, {
          name: `IT Item ${tag}`,
          categoryId: category.id,
          description: "",
          ingredients: "",
          dietaryTags: ["veg"],
          pricePaise: "249.50",
          isActive: true,
          isAvailable: true,
        }),
      ),
      "createItem",
    );
    tracker.row("menu_items", item.id);
    ids.item = item.id;
    expect(item.price_paise).toBe(24950);

    const seen = must(
      await anon.from("menu_items").select("price_paise, name").eq("id", item.id),
      "anon read",
    );
    expect(seen).toEqual([{ price_paise: 24950, name: `IT Item ${tag}` }]);
  });

  it("rejects a duplicate name in the same category with a friendly message", async () => {
    const again = await menu.createItem(
      manager.client,
      inputOf(itemSchema, {
        name: `it item ${tag}`,
        categoryId: ids.category,
        description: "",
        ingredients: "",
        dietaryTags: [],
        pricePaise: "10",
        isActive: true,
        isAvailable: true,
      }),
    );
    expect(again).toMatchObject({ ok: false });
    expect(again.ok ? "" : again.message).not.toMatch(/violates|constraint|menu_items/i);
  });

  it("updates the price and toggles sold out / archived; archived items vanish for anon", async () => {
    const id = ids.item!;
    okData(
      await menu.updateItem(
        manager.client,
        id,
        inputOf(itemSchema, {
          name: `IT Item ${tag}`,
          categoryId: ids.category,
          description: "",
          ingredients: "",
          dietaryTags: ["veg"],
          pricePaise: "260",
          isActive: true,
          isAvailable: true,
        }),
      ),
      "updateItem",
    );
    expect(
      must(await service.from("menu_items").select("price_paise").eq("id", id).single(), "row")
        .price_paise,
    ).toBe(26000);

    okData(await menu.setItemFlag(manager.client, id, "is_available", false), "sold out");
    expect(
      must(await anon.from("menu_items").select("is_available").eq("id", id), "anon")[0],
    ).toEqual({ is_available: false });

    okData(await menu.setItemFlag(manager.client, id, "is_active", false), "archive");
    expect(
      must(await anon.from("menu_items").select("id").eq("id", id), "anon after archive"),
    ).toEqual([]);

    okData(await menu.setItemFlag(manager.client, id, "is_active", true), "restore");
    expect(
      must(await anon.from("menu_items").select("id").eq("id", id), "anon after restore"),
    ).toHaveLength(1);
  });

  it("modifier groups: rules, options with integer price deltas, and attaching to the item", async () => {
    // A brand-new group cannot require options it does not have yet.
    const required = await menu.createGroup(
      manager.client,
      inputOf(groupSchema, {
        name: `IT Req ${tag}`,
        minSelect: "1",
        maxSelect: "1",
        isActive: true,
      }),
    );
    expect(required).toMatchObject({ ok: false, kind: "rule" });

    const group = okData(
      await menu.createGroup(
        manager.client,
        inputOf(groupSchema, {
          name: `IT Group ${tag}`,
          minSelect: "0",
          maxSelect: "2",
          isActive: true,
        }),
      ),
      "createGroup",
    );
    tracker.row("modifier_groups", group.id);
    ids.group = group.id;

    const option = okData(
      await menu.createOption(
        manager.client,
        group.id,
        inputOf(optionSchema, {
          name: "Extra cheese",
          priceDeltaPaise: "20",
          isDefault: false,
          isActive: true,
          isAvailable: true,
        }),
      ),
      "createOption",
    );
    ids.option = option.id;
    expect(option.price_delta_paise).toBe(2000);

    // Making the group required is now possible; archiving every option of a required group is not.
    okData(
      await menu.updateGroup(
        manager.client,
        group.id,
        inputOf(groupSchema, {
          name: `IT Group ${tag}`,
          minSelect: "1",
          maxSelect: "2",
          isActive: true,
        }),
      ),
      "make required",
    );
    const archived = await menu.setOptionFlag(manager.client, option.id, "is_active", false);
    expect(archived).toMatchObject({ ok: false, kind: "rule" });

    okData(await menu.setItemModifierGroups(manager.client, ids.item!, [group.id]), "attach");
    const links = must(
      await anon.from("menu_item_modifier_groups").select("group_id").eq("item_id", ids.item!),
      "anon links",
    );
    expect(links).toEqual([{ group_id: group.id }]);
    okData(await menu.setItemModifierGroups(manager.client, ids.item!, []), "detach");
    expect(
      must(
        await anon.from("menu_item_modifier_groups").select("group_id").eq("item_id", ids.item!),
        "anon links",
      ),
    ).toEqual([]);
  });

  it("an out-of-range price is refused by the database even if the form check is bypassed", async () => {
    const result = await manager.client
      .from("menu_items")
      .update({ price_paise: 10_000_001 })
      .eq("id", ids.item!);
    expect(result.error?.code).toBe("23514");
    expect(
      must(
        await service.from("menu_items").select("price_paise").eq("id", ids.item!).single(),
        "row",
      ).price_paise,
    ).toBe(26000);
  });

  it("deletes a never-ordered item and an empty category", async () => {
    okData(await menu.deleteItem(manager.client, ids.item!), "deleteItem");
    okData(await menu.deleteCategory(manager.client, ids.category!), "deleteCategory");
    expect(must(await service.from("menu_items").select("id").eq("id", ids.item!), "gone")).toEqual(
      [],
    );
  });
});

describe("manager: table management with the real database", () => {
  let tableId = "";
  const code = `Z${upper}`; // 4 chars: starts with a letter, matches the code format

  it("creates a table, rejects a duplicate code, renames it, deactivates and reactivates it", async () => {
    const created = okData(
      await tables.createTable(manager.client, { code, label: `IT table ${tag}` }),
      "createTable",
    );
    tracker.row("cafe_tables", created.id);
    tableId = created.id;
    expect(created).toMatchObject({ code, is_active: true });

    const duplicate = await tables.createTable(manager.client, { code, label: "Again" });
    expect(duplicate).toMatchObject({ ok: false, kind: "duplicate", field: "code" });

    expect(
      okData(await tables.renameTable(manager.client, tableId, { label: "Window seat" }), "rename"),
    ).toMatchObject({ label: "Window seat", code });
    expect(
      okData(await tables.setTableActive(manager.client, tableId, false), "deactivate").is_active,
    ).toBe(false);
    expect(
      okData(await tables.setTableActive(manager.client, tableId, true), "reactivate").is_active,
    ).toBe(true);
  });

  it("customers (anon) can never read the table list: Phase 4 resolves codes on the server", async () => {
    expectDenied("anon reads cafe_tables", await anon.from("cafe_tables").select("code"));
  });

  it("the code cannot be changed through the rename path", async () => {
    await tables.renameTable(manager.client, tableId, { label: "Renamed again" });
    expect(
      must(await service.from("cafe_tables").select("code").eq("id", tableId).single(), "row").code,
    ).toBe(code);
  });
});

describe("counter, no-profile user and anonymous visitor are refused", () => {
  const actors: [string, () => ReturnType<typeof anonClient>][] = [
    ["counter", () => counter.client],
    ["signed-in user without a staff profile", () => plain.client],
    ["anonymous visitor", () => anon],
  ];

  it.each(actors)("%s cannot create categories or tables", async (_name, client) => {
    const category = await menu.createCategory(
      client(),
      inputOf(categorySchema, { name: `IT Deny ${tag}`, description: "" }),
    );
    expect(category).toMatchObject({ ok: false });
    const table = await tables.createTable(client(), { code: `D${upper}`, label: "Denied" });
    expect(table).toMatchObject({ ok: false });
    expect(
      must(
        await service.from("menu_categories").select("id").eq("slug", `it-deny-${tag}`),
        "none created",
      ),
    ).toEqual([]);
    expect(
      must(await service.from("cafe_tables").select("id").eq("code", `D${upper}`), "none created"),
    ).toEqual([]);
  });

  it("a counter can mark a seeded item sold out and available again, but not archive it or change its price", async () => {
    const seeded = must(
      await service
        .from("menu_items")
        .select("id, price_paise, is_active, is_available")
        .eq("is_active", true)
        .limit(1),
      "a seeded item",
    )[0]!;
    okData(
      await menu.setItemFlag(counter.client, seeded.id, "is_available", false),
      "counter sold out",
    );
    okData(
      await menu.setItemFlag(counter.client, seeded.id, "is_available", seeded.is_available),
      "counter restore",
    );

    const archive = await menu.setItemFlag(counter.client, seeded.id, "is_active", false);
    expect(archive).toMatchObject({ ok: false });
    const price = await counter.client
      .from("menu_items")
      .update({ price_paise: 1 })
      .eq("id", seeded.id)
      .select("id");
    expect(price.error !== null || price.data?.length === 0).toBe(true);

    const after = must(
      await service
        .from("menu_items")
        .select("price_paise, is_active, is_available")
        .eq("id", seeded.id)
        .single(),
      "unchanged",
    );
    expect(after).toEqual({
      price_paise: seeded.price_paise,
      is_active: seeded.is_active,
      is_available: seeded.is_available,
    });
  });

  it("a counter cannot rename or deactivate a table", async () => {
    const seeded = must(
      await service.from("cafe_tables").select("id, label, is_active").limit(1),
      "a table",
    )[0]!;
    const rename = await tables.renameTable(counter.client, seeded.id, { label: "hacked" });
    const deactivate = await tables.setTableActive(counter.client, seeded.id, false);
    expect(rename.ok).toBe(false);
    expect(deactivate.ok).toBe(false);
    const after = must(
      await service.from("cafe_tables").select("label, is_active").eq("id", seeded.id).single(),
      "unchanged",
    );
    expect(after).toEqual({ label: seeded.label, is_active: seeded.is_active });
  });
});
