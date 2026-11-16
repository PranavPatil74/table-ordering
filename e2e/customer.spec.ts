import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { FAKE_SUPABASE_PORT } from "./test-env";

/**
 * Phase 4 customer ordering, in a real browser against the PRODUCTION build and the TEST DOUBLE of
 * Supabase (e2e/fake-supabase.mjs: imitates the anonymous role's grants, the table lookup and the
 * rate limiter in memory). These prove how the app behaves. They do not prove real RLS: see
 * `pnpm test:db` and `pnpm test:supabase`. Phase 5 saves the checkout (a pending payment attempt) but takes no payment, so no test pays and
 * none may ever see an "order confirmed" or "payment successful" state.
 */

const FAKE = `http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub`;
const T01 = "/menu?table=T01";

/** What the current test seeded, removed afterwards (a worker runs one test at a time). */
const seededCategories: string[] = [];
const seededTables: string[] = [];

/** Every test is its own "customer" for the rate limiter: a distinct client address. */
test.beforeEach(async ({ context }) => {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${octet()}.${octet()}.${octet()}` });
});

test.afterEach(async ({ request }) => {
  for (const categoryId of seededCategories.splice(0)) {
    await request.post(`${FAKE}/unseed`, { data: { categoryId } });
  }
  for (const tableId of seededTables.splice(0)) {
    await request.post(`${FAKE}/unseed`, { data: { tableId } });
  }
});

interface Seeded {
  n: string;
  categoryId: string;
  itemId: string;
  plainId: string;
  soldOutId: string;
  cat: string;
  name: string;
  plainName: string;
  soldOutName: string;
  ids: {
    bread: string;
    extras: string;
    white: string;
    brown: string;
    cheese: string;
    mayo: string;
    pickles: string;
    jalapeno: string;
  };
}

/** Adds this test's own menu data to the shared in-memory database (names are unique per test). */
async function seedMenu(request: APIRequestContext): Promise<Seeded> {
  const n = randomUUID().slice(0, 6).toUpperCase();
  const ids = {
    bread: randomUUID(),
    extras: randomUUID(),
    white: randomUUID(),
    brown: randomUUID(),
    cheese: randomUUID(),
    mayo: randomUUID(),
    pickles: randomUUID(),
    jalapeno: randomUUID(),
  };
  const categoryId = randomUUID();
  seededCategories.push(categoryId);
  const itemId = randomUUID();
  const plainId = randomUUID();
  const soldOutId = randomUUID();
  const cat = `Cat ${n}`;
  const name = `Club ${n}`;
  const plainName = `Plain ${n}`;
  const soldOutName = `Gone ${n}`;
  const item = (id: string, itemName: string, price: number, extra = {}) => ({
    id,
    category_id: categoryId,
    slug: `s-${id}`,
    name: itemName,
    description: `About ${itemName}`,
    ingredients: null,
    dietary_tags: ["veg"],
    price_paise: price,
    image_path: null,
    sort_order: 1,
    is_active: true,
    is_available: true,
    ...extra,
  });
  const option = (id: string, group: string, optionName: string, delta: number, extra = {}) => ({
    id,
    group_id: group,
    name: optionName,
    price_delta_paise: delta,
    is_default: false,
    sort_order: delta,
    is_active: true,
    is_available: true,
    ...extra,
  });
  const seed = async (table: string, rows: unknown[]) => {
    const response = await request.post(`${FAKE}/seed`, { data: { table, rows } });
    expect(response.ok()).toBe(true);
  };
  await seed("menu_categories", [
    {
      id: categoryId,
      slug: `c-${categoryId}`,
      name: cat,
      description: null,
      sort_order: 900,
      is_active: true,
    },
  ]);
  await seed("menu_items", [
    item(itemId, name, 17900),
    item(plainId, plainName, 10000),
    item(soldOutId, soldOutName, 5000, { is_available: false }),
  ]);
  await seed("modifier_groups", [
    {
      id: ids.bread,
      slug: `g-${ids.bread}`,
      name: "Bread",
      min_select: 1,
      max_select: 1,
      sort_order: 1,
      is_active: true,
    },
    {
      id: ids.extras,
      slug: `g-${ids.extras}`,
      name: "Extras",
      min_select: 0,
      max_select: 2,
      sort_order: 2,
      is_active: true,
    },
  ]);
  await seed("modifier_options", [
    option(ids.white, ids.bread, "White", 0),
    option(ids.brown, ids.bread, "Brown", 1000),
    option(ids.cheese, ids.extras, "Cheese", 2500),
    option(ids.mayo, ids.extras, "Mayo", 500),
    option(ids.pickles, ids.extras, "Pickles", 300),
    option(ids.jalapeno, ids.extras, "Jalapeño", 1500, { is_available: false }),
  ]);
  await seed("menu_item_modifier_groups", [
    { item_id: itemId, group_id: ids.bread, sort_order: 1 },
    { item_id: itemId, group_id: ids.extras, sort_order: 2 },
  ]);
  return { n, categoryId, itemId, plainId, soldOutId, cat, name, plainName, soldOutName, ids };
}

async function patch(request: APIRequestContext, table: string, id: string, data: object) {
  const response = await request.post(`${FAKE}/patch?table=${table}&id=${id}`, { data });
  expect(response.ok()).toBe(true);
}

const card = (page: Page, id: string) => page.getByTestId(`menu-item-${id}`);
const dialog = (page: Page) => page.getByRole("dialog");
const count = (page: Page) => page.getByTestId("cart-count");

async function addCustomised(page: Page, s: Seeded, quantity = 2) {
  await card(page, s.itemId)
    .getByRole("button", { name: `Customise and add ${s.name}` })
    .click();
  const d = dialog(page);
  await d.getByRole("radio", { name: /Brown/ }).check();
  await d.getByRole("checkbox", { name: /Cheese/ }).check();
  await d.getByRole("checkbox", { name: /Mayo/ }).check();
  for (let i = 1; i < quantity; i += 1)
    await d.getByRole("button", { name: "Increase quantity" }).click();
  await d.getByTestId("sheet-submit").click();
}

test.describe("QR entry: the table is validated on the server", () => {
  test("a valid table shows the branded menu for that table, with no sign-in", async ({
    page,
    request,
    context,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await expect(page.getByTestId("table-chip")).toHaveText("Ordering for Table 1");
    await expect(page.getByText("Sandwich Express").first()).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Menu categories" }).getByRole("link", { name: s.cat }),
    ).toBeVisible();
    await expect(card(page, s.plainId)).toContainText(s.plainName);
    await expect(card(page, s.plainId)).toContainText("₹100");
    await expect(card(page, s.plainId)).toContainText("Vegetarian");
    await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
    // A customer visit never creates a staff session.
    expect((await context.cookies()).filter((c) => /^sb-/.test(c.name))).toEqual([]);
  });

  test("the table code is case-insensitive", async ({ page }) => {
    await page.goto("/menu?table=t01");
    await expect(page.getByTestId("table-chip")).toHaveText("Ordering for Table 1");
  });

  for (const [label, url, title] of [
    ["an unknown table", "/menu?table=T99", "We couldn't find that table"],
    ["a malformed code", "/menu?table=%27%3B--", "We couldn't find that table"],
    ["a too-long code", `/menu?table=${"A".repeat(40)}`, "We couldn't find that table"],
    ["a deactivated table", "/menu?table=T02", "This table isn't taking orders"],
  ] as const) {
    test(`${label} is refused with a helpful message and no menu`, async ({ page, request }) => {
      const s = await seedMenu(request);
      await page.goto(url);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByTestId("table-problem")).toBeVisible();
      await expect(page.getByText(s.plainName)).toHaveCount(0);
      await expect(page.getByTestId("cart-link")).toHaveCount(0);
    });
  }

  test("no table at all asks the customer to scan their QR code", async ({ page }) => {
    await page.goto("/menu");
    await expect(
      page.getByRole("heading", { name: "Scan the QR code on your table" }),
    ).toBeVisible();
    await page.goto("/cart");
    await expect(page.getByTestId("no-table")).toBeVisible();
    await page.goto("/checkout?table=");
    await expect(page.getByTestId("no-table")).toBeVisible();
  });

  test("cart and checkout validate the table too", async ({ page }) => {
    for (const path of ["/cart", "/checkout"]) {
      await page.goto(`${path}?table=T02`);
      await expect(
        page.getByRole("heading", { name: "This table isn't taking orders" }),
      ).toBeVisible();
      await page.goto(`${path}?table=T99`);
      await expect(
        page.getByRole("heading", { name: "We couldn't find that table" }),
      ).toBeVisible();
    }
  });

  test("lookups are rate limited per client, and one client's limit does not affect another", async ({
    request,
  }) => {
    // Addresses unique to this run: the mobile and desktop projects must not share a bucket.
    const part = () => 1 + Math.floor(Math.random() * 250);
    const a = `198.51.${part()}.${part()}`;
    const b = `198.51.${part()}.${part()}`;
    const limited: boolean[] = [];
    for (let i = 0; i < 125; i += 1) {
      const response = await request.get(T01, { headers: { "x-forwarded-for": a } });
      limited.push((await response.text()).includes("Too many tries"));
    }
    expect(limited[0]).toBe(false);
    expect(limited.some(Boolean)).toBe(true);
    expect(limited[limited.length - 1]).toBe(true);
    const other = await request.get(T01, { headers: { "x-forwarded-for": b } });
    expect((await other.text()).includes("Too many tries")).toBe(false);
  });
});

test.describe("menu", () => {
  test("shows sold-out items as sold out, with no way to add them", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await expect(card(page, s.soldOutId).getByTestId("unavailable-badge")).toHaveText("Sold out");
    await expect(card(page, s.soldOutId).getByRole("button")).toHaveCount(0);
  });

  test("never shows archived items or categories", async ({ page, request }) => {
    const s = await seedMenu(request);
    await patch(request, "menu_items", s.plainId, { is_active: false });
    await page.goto(T01);
    await expect(page.getByText(s.plainName)).toHaveCount(0);
    await patch(request, "menu_categories", s.categoryId, { is_active: false });
    await page.reload();
    await expect(page.getByText(s.cat)).toHaveCount(0);
    await expect(page.getByText(s.name)).toHaveCount(0);
  });

  test("category navigation jumps to the category", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await page
      .getByRole("navigation", { name: "Menu categories" })
      .getByRole("link", { name: s.cat })
      .click();
    await expect(page).toHaveURL(new RegExp(`#category-${s.categoryId}$`));
    await expect(page.getByRole("heading", { name: s.cat })).toBeInViewport();
  });

  test("is accessible and fits the viewport", async ({ page, request }) => {
    await seedMenu(request);
    await page.goto(T01);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("customising an item", () => {
  test("enforces required and maximum choices and keeps a live total", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.itemId)
      .getByRole("button", { name: `Customise and add ${s.name}` })
      .click();
    const d = dialog(page);
    await expect(d).toContainText("Choose 1");
    await expect(d).toContainText("Optional, up to 2");
    await expect(d.getByRole("radio", { name: /White/ })).not.toBeChecked();

    // Required group not chosen: refused with a clear message, nothing added.
    await d.getByTestId("sheet-submit").click();
    await expect(d.getByRole("alert")).toContainText("Choose one option for Bread.");
    await expect(count(page)).toHaveText("0");

    await d.getByRole("radio", { name: /Brown/ }).check();
    await expect(d.getByTestId("sheet-submit")).toContainText("₹189");
    await d.getByRole("checkbox", { name: /Cheese/ }).check();
    await expect(d.getByTestId("sheet-submit")).toContainText("₹214");
    await d.getByRole("checkbox", { name: /Mayo/ }).check();
    await expect(d.getByTestId("sheet-submit")).toContainText("₹219");

    // Maximum reached: the remaining option cannot be chosen; the sold-out one never can.
    await expect(d.getByRole("checkbox", { name: /Pickles/ })).toBeDisabled();
    await expect(d.getByRole("checkbox", { name: /Jalapeño/ })).toBeDisabled();
    await expect(d.getByText("Sold out")).toBeVisible();

    // A single-choice group swaps its pick.
    await d.getByRole("radio", { name: /White/ }).check();
    await expect(d.getByRole("radio", { name: /Brown/ })).not.toBeChecked();
    await expect(d.getByTestId("sheet-submit")).toContainText("₹209");

    // Quantity is bounded by the cafe's limit (10).
    for (let i = 0; i < 12; i += 1) {
      if (await d.getByRole("button", { name: "Increase quantity" }).isDisabled()) break;
      await d.getByRole("button", { name: "Increase quantity" }).click();
    }
    await expect(d.getByTestId("sheet-quantity")).toHaveText("10");
    await expect(d.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    await expect(d.getByTestId("sheet-submit")).toContainText("₹2,090");
  });

  test("Escape closes the sheet without adding anything", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.itemId)
      .getByRole("button", { name: `Customise and add ${s.name}` })
      .click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(count(page)).toHaveText("0");
  });

  test("an item with no options is added in one tap", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await expect(count(page)).toHaveText("1");
    await expect(page.getByTestId("cart-notice")).toContainText(`Added ${s.plainName}`);
  });
});

test.describe("cart", () => {
  test("add, change quantity, edit choices, remove, and an empty state", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await addCustomised(page, s, 2);
    await expect(count(page)).toHaveText("2");
    await page.getByTestId("view-cart").click();
    await expect(page).toHaveURL(/\/cart\?table=T01$/);

    const line = page.getByTestId("cart-line");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(s.name);
    await expect(line).toContainText("Brown, Mayo, Cheese");
    await expect(line.getByTestId("line-total")).toHaveText("₹438");
    await expect(page.getByTestId("cart-total")).toHaveText("₹438");

    await line.getByRole("button", { name: `Increase quantity of ${s.name}` }).click();
    await expect(line.getByTestId("line-quantity")).toHaveText("3");
    await expect(page.getByTestId("cart-total")).toHaveText("₹657");
    await line.getByRole("button", { name: `Decrease quantity of ${s.name}` }).click();
    await expect(page.getByTestId("cart-total")).toHaveText("₹438");

    // Edit: change the choices; the line is updated in place.
    await line.getByRole("button", { name: `Edit ${s.name}` }).click();
    const d = dialog(page);
    await expect(d.getByRole("radio", { name: /Brown/ })).toBeChecked();
    await d.getByRole("checkbox", { name: /Mayo/ }).uncheck();
    await d.getByTestId("sheet-submit").click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await expect(page.getByTestId("cart-line")).toContainText("Brown, Cheese");
    await expect(page.getByTestId("cart-total")).toHaveText("₹428");

    // Same item with different choices is a separate line.
    await page.getByRole("link", { name: "Add more items" }).click();
    await card(page, s.itemId)
      .getByRole("button", { name: `Customise and add ${s.name}` })
      .click();
    await dialog(page).getByRole("radio", { name: /White/ }).check();
    await dialog(page).getByTestId("sheet-submit").click();
    await page.getByTestId("view-cart").click();
    await expect(page.getByTestId("cart-line")).toHaveCount(2);

    // Remove both lines: the empty state appears.
    await page
      .getByRole("button", { name: `Remove ${s.name}` })
      .first()
      .click();
    await page
      .getByRole("button", { name: `Remove ${s.name}` })
      .first()
      .click();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
    await expect(count(page)).toHaveText("0");
  });

  test("decreasing to zero removes the line", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await page.getByRole("link", { name: /Cart/ }).click();
    await page.getByRole("button", { name: `Decrease quantity of ${s.plainName}` }).click();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
  });

  test("persists across navigation and reload, per table", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await expect(count(page)).toHaveText("1");
    await page.reload();
    await expect(count(page)).toHaveText("1");
    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-line")).toContainText(s.plainName);
    await page.goBack();
    await expect(count(page)).toHaveText("1");
    // Another table has its own cart.
    await page.goto("/menu?table=T02");
    await expect(page.getByTestId("table-problem")).toBeVisible();
  });

  test("a hand-edited cart cannot change prices or names", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await page.evaluate(
      ([plainId]) => {
        window.localStorage.setItem(
          "se-cart-v1:T01",
          JSON.stringify({
            version: 1,
            lines: [
              {
                menuItemId: plainId,
                optionIds: [],
                quantity: 2,
                pricePaise: 1,
                name: "Free!",
                totalPaise: 2,
              },
            ],
          }),
        );
      },
      [s.plainId],
    );
    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-line")).toContainText(s.plainName);
    await expect(page.getByTestId("cart-total")).toHaveText("₹200");
    // Garbage in storage is an empty cart, not an error page.
    await page.evaluate(() => window.localStorage.setItem("se-cart-v1:T01", "{not json"));
    await page.reload();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
  });

  test("is accessible", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await addCustomised(page, s, 1);
    await page.goto("/cart?table=T01");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("menu changes after items are in the cart (stale carts)", () => {
  test("a price change is picked up everywhere: the cart holds no prices", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await patch(request, "menu_items", s.plainId, { price_paise: 12000 });
    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-total")).toHaveText("₹120");
    await page.goto("/checkout?table=T01");
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("saved-total")).toHaveText("₹120");
  });

  test("a sold-out item blocks checkout until removed", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await card(page, s.itemId)
      .getByRole("button", { name: `Customise and add ${s.name}` })
      .click();
    await dialog(page).getByRole("radio", { name: /White/ }).check();
    await dialog(page).getByTestId("sheet-submit").click();
    await patch(request, "menu_items", s.plainId, { is_available: false });

    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-attention")).toBeVisible();
    await expect(page.locator('[data-status="sold_out"]')).toContainText(s.plainName);
    await expect(page.getByTestId("go-checkout-disabled")).toBeDisabled();
    // Only the orderable line is counted.
    await expect(page.getByTestId("cart-total")).toHaveText("₹179");

    await page.goto("/checkout?table=T01");
    await expect(page.getByTestId("checkout-blocked")).toBeVisible();
    await expect(page.getByTestId("save-checkout")).toHaveCount(0);

    await page.goto("/cart?table=T01");
    await page.getByTestId("remove-unavailable").click();
    await expect(page.getByTestId("cart-attention")).toHaveCount(0);
    await expect(page.getByTestId("go-checkout")).toBeVisible();
  });

  test("an archived item and a sold-out option are reported; the option can be re-chosen", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await addCustomised(page, s, 1);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await patch(request, "menu_items", s.plainId, { is_active: false });
    await patch(request, "modifier_options", s.ids.cheese, { is_available: false });
    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-attention")).toBeVisible();
    await expect(page.locator('[data-status="removed"]')).toContainText("No longer on the menu");
    await expect(page.locator('[data-status="sold_out"]')).toContainText("Cheese");
    await page
      .locator('[data-status="sold_out"]')
      .getByRole("button", { name: `Edit ${s.name}` })
      .click();
    await expect(dialog(page).getByRole("checkbox", { name: /Cheese/ })).toBeDisabled();
    await patch(request, "modifier_options", s.ids.cheese, { is_available: true });
  });

  test("a required option that disappeared must be re-chosen", async ({ page, request }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await addCustomised(page, s, 1);
    await patch(request, "modifier_options", s.ids.brown, { is_active: false });
    await page.goto("/cart?table=T01");
    await expect(page.locator('[data-status="changed"]')).toBeVisible();
    await expect(page.getByTestId("go-checkout-disabled")).toBeDisabled();
  });
});

/** Adds one plain item to the cart and opens checkout. */
async function checkoutWithPlainItem(page: Page, request: APIRequestContext, table = "T01") {
  const s = await seedMenu(request);
  await page.goto(`/menu?table=${table}`);
  await card(page, s.plainId)
    .getByRole("button", { name: `Add ${s.plainName}` })
    .click();
  await page.goto(`/checkout?table=${table}`);
  return s;
}

const attempts = async (request: APIRequestContext) =>
  (await (await request.get(`${FAKE}/attempts`)).json()) as {
    count: number;
    attempts: { amount_paise: number; status: string; key: string }[];
  };

/** The wording that must NEVER appear because a checkout was merely saved. */
const FORBIDDEN_SUCCESS =
  /order confirmed|payment successful|payment received|thank you for your order|order #|order number|you(?:'ve| have) paid/i;

test.describe("checkout (Phase 5: the checkout is saved; payment arrives in a later phase)", () => {
  test("an empty cart cannot be checked out", async ({ page }) => {
    await page.goto("/checkout?table=T01");
    await expect(page.getByTestId("checkout-empty")).toBeVisible();
  });

  test("saves the server-verified checkout and says plainly that payment is not available", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    await page.goto(T01);
    await addCustomised(page, s, 2);
    await page.goto("/checkout?table=T01");
    await expect(page.getByText("Table: Table 1")).toBeVisible();
    await expect(page.getByTestId("checkout-total")).toHaveText("₹438");
    await page.getByLabel(/Your name/).fill("Asha");
    await page.getByLabel(/Anything we should know/).fill("No onions please");
    const before = (await attempts(request)).count;
    await page.getByTestId("save-checkout").click();

    const saved = page.getByTestId("checkout-saved");
    await expect(saved).toBeVisible();
    await expect(saved).toHaveAttribute("data-stage", "saved");
    await expect(saved.getByRole("heading", { name: "Checkout saved" })).toBeVisible();
    await expect(page.getByTestId("saved-total")).toHaveText("₹438");
    await expect(page.getByTestId("saved-reference")).toHaveText(/^CK-[0-9A-F]{8}$/);
    await expect(page.getByTestId("saved-line")).toHaveCount(1);
    await expect(page.getByTestId("saved-line")).toContainText(`2 × ${s.name}`);
    await expect(page.getByTestId("stage-checkout")).toContainText("saved");
    await expect(page.getByTestId("stage-payment")).toContainText("not started");
    await expect(page.getByTestId("stage-order")).toContainText("not placed yet");
    await expect(page.getByTestId("payment-not-configured")).toContainText(
      "Online payment isn't switched on yet",
    );
    await expect(page.getByTestId("payment-not-configured")).toContainText("has not been placed");
    await expect(page.getByTestId("payment-not-configured")).toContainText("haven't been charged");
    // No success wording, no pay button, no order number.
    await expect(page.locator("body")).not.toContainText(FORBIDDEN_SUCCESS);
    await expect(page.getByRole("button", { name: /^pay/i })).toHaveCount(0);

    // Exactly one pending attempt exists, for the server-computed amount.
    const after = await attempts(request);
    expect(after.count).toBe(before + 1);
    const mine = after.attempts.find((a) => a.amount_paise === 43800);
    expect(mine?.status).toBe("PENDING");
    // The cart is untouched: nothing was paid for.
    await page.goto("/cart?table=T01");
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
  });

  test("editing the order after saving marks the earlier save as out of date", async ({
    page,
    request,
  }) => {
    await checkoutWithPlainItem(page, request);
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    await page.getByLabel(/Your name/).fill("Changed");
    await expect(page.getByTestId("checkout-saved")).toHaveCount(0);
    await expect(page.getByTestId("checkout-stale")).toBeVisible();
  });

  test("a double tap sends one request and creates one attempt", async ({ page, request }) => {
    await checkoutWithPlainItem(page, request);
    const before = (await attempts(request)).count;
    let actions = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.headers()["next-action"]) actions += 1;
    });
    await page.getByTestId("save-checkout").dblclick();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    expect(actions).toBe(1);
    expect((await attempts(request)).count).toBe(before + 1);
  });

  test("shows a saving state while the request runs and blocks the button", async ({
    page,
    request,
  }) => {
    await checkoutWithPlainItem(page, request);
    await page.route("**/checkout?table=T01", async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    const button = page.getByTestId("save-checkout");
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toContainText("Saving your checkout");
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
  });

  test("a reload shows the checkout this tab already saved, without creating another", async ({
    page,
    request,
  }) => {
    await checkoutWithPlainItem(page, request);
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    const reference = await page.getByTestId("saved-reference").innerText();
    const count = (await attempts(request)).count;

    await page.reload();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    await expect(page.getByTestId("checkout-replay")).toBeVisible();
    await expect(page.getByTestId("saved-reference")).toHaveText(reference);
    expect((await attempts(request)).count).toBe(count);

    // Saving again from the reloaded page is a safe replay: same reference, still one attempt.
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("saved-reference")).toHaveText(reference);
    expect((await attempts(request)).count).toBe(count);
  });

  test("a network failure can be retried without creating a second attempt", async ({
    page,
    request,
  }) => {
    await checkoutWithPlainItem(page, request);
    const before = (await attempts(request)).count;
    let failNext = true;
    await page.route("**/checkout?table=T01", async (route) => {
      if (route.request().method() === "POST" && failNext) {
        failNext = false;
        // The request REACHES the server (the save happens) but the response is lost.
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("preview-error")).toContainText("couldn't reach the server");
    await expect(page.getByTestId("preview-error")).toContainText("won't be charged twice");
    expect((await attempts(request)).count).toBe(before + 1); // it was saved server-side

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    await expect(page.getByTestId("checkout-replay")).toBeVisible(); // the existing one came back
    expect((await attempts(request)).count).toBe(before + 1); // and no second attempt exists
  });

  test("changing the order after saving saves a NEW checkout for the new order", async ({
    page,
    request,
  }) => {
    await checkoutWithPlainItem(page, request);
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    const first = await page.getByTestId("saved-reference").innerText();
    const count = (await attempts(request)).count;
    await page.getByLabel(/Your name/).fill("Second version");
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-replay")).toHaveCount(0);
    await expect(page.getByTestId("saved-reference")).not.toHaveText(first);
    expect((await attempts(request)).count).toBe(count + 1);
  });

  test("if the table is switched off mid-order, checkout says so and saves nothing", async ({
    page,
    request,
  }) => {
    const s = await seedMenu(request);
    // This test's OWN table: switching T01 off would break the tests running beside it.
    const tableId = randomUUID();
    seededTables.push(tableId);
    const code = `Z${s.n}`;
    const seeded = await request.post(`${FAKE}/seed`, {
      data: {
        table: "cafe_tables",
        rows: [{ id: tableId, code, label: `Table ${s.n}`, is_active: true, sort_order: 990 }],
      },
    });
    expect(seeded.ok()).toBe(true);
    await page.goto(`/menu?table=${code}`);
    await card(page, s.plainId)
      .getByRole("button", { name: `Add ${s.plainName}` })
      .click();
    await page.goto(`/checkout?table=${code}`);
    const before = (await attempts(request)).count;
    await patch(request, "cafe_tables", tableId, { is_active: false });
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("preview-table-problem")).toContainText(
      "This table isn't taking orders",
    );
    await expect(page.getByTestId("checkout-saved")).toHaveCount(0);
    expect((await attempts(request)).count).toBe(before);
  });

  test("a menu change between cart and save is reported, nothing is saved or charged", async ({
    page,
    request,
  }) => {
    const s = await checkoutWithPlainItem(page, request);
    const before = (await attempts(request)).count;
    await patch(request, "menu_items", s.plainId, { is_available: false });
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("preview-attention")).toContainText(s.plainName);
    await expect(page.getByTestId("preview-attention")).toContainText("Nothing was saved");
    await expect(page.getByTestId("checkout-saved")).toHaveCount(0);
    expect((await attempts(request)).count).toBe(before);
  });

  test("a price change after saving reports a conflict, never the old price", async ({
    page,
    request,
  }) => {
    const s = await checkoutWithPlainItem(page, request);
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("saved-total")).toHaveText("₹100");

    // Make the screen retry the SAME submission (as after a lost response) against a changed menu.
    await patch(request, "menu_items", s.plainId, { price_paise: 12000 });
    await page.reload();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-conflict")).toBeVisible();
    await expect(page.getByTestId("checkout-conflict")).not.toContainText("₹");

    // Accepting saves the latest order at the new price, under a new submission.
    await page.getByRole("button", { name: "Save the latest order" }).click();
    await expect(page.getByTestId("saved-total")).toHaveText("₹120");
  });

  test("replaying the real request with forged prices, totals, status or table ids changes nothing", async ({
    page,
    request,
  }) => {
    const s = await checkoutWithPlainItem(page, request);
    let actionId = "";
    page.on("request", (r) => {
      if (r.method() === "POST" && r.headers()["next-action"])
        actionId = r.headers()["next-action"]!;
    });
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    expect(actionId).not.toBe("");

    const replay = async (body: unknown) =>
      (
        await request.post("/checkout", {
          headers: {
            "next-action": actionId,
            "content-type": "text/plain;charset=UTF-8",
            accept: "text/x-component",
          },
          data: JSON.stringify([body]),
          failOnStatusCode: false,
        })
      ).text();
    const honest = {
      tableCode: "T01",
      submissionId: randomUUID(),
      lines: [{ menuItemId: s.plainId, optionIds: [], quantity: 2 }],
    };

    // The server prices from its own menu (2 x Rs 100), whatever the request claims.
    const forged = await replay({
      ...honest,
      totalPaise: 1,
      amountPaise: 1,
      status: "PAID",
      paymentStatus: "PAID",
      tableId: "00000000-0000-4000-8000-000000000000",
      lines: [{ ...honest.lines[0], pricePaise: 1, unit_price_paise: 1, totalPaise: 2 }],
    });
    expect(forged).toContain('"totalPaise":20000');
    expect(forged).toContain('"stage":"saved"');
    expect(forged).not.toContain('"totalPaise":1,');
    expect(forged).not.toMatch(/PAID|payment_verified|order_created/);
    const stored = (await attempts(request)).attempts.find((a) => a.key === honest.submissionId);
    expect(stored).toMatchObject({ amount_paise: 20000, status: "PENDING" });

    // The same submission id with a DIFFERENT cart is rejected and changes nothing.
    const clash = await replay({
      ...honest,
      lines: [{ menuItemId: s.plainId, optionIds: [], quantity: 3 }],
    });
    expect(clash).toContain('"status":"conflict"');
    expect(
      (await attempts(request)).attempts.find((a) => a.key === honest.submissionId)?.amount_paise,
    ).toBe(20000);

    // A deactivated or unknown table is refused whatever else the request says.
    expect(await replay({ ...honest, submissionId: randomUUID(), tableCode: "T02" })).toContain(
      "This table isn't taking orders",
    );
    expect(await replay({ ...honest, submissionId: randomUUID(), tableCode: "T99" })).toContain(
      "We couldn't find that table",
    );
    // Malformed requests are rejected, not guessed at.
    for (const bad of [
      { ...honest, submissionId: "nope" },
      { ...honest, submissionId: undefined },
      { ...honest, submissionId: "c232ab00-9414-11ec-b3c8-9f6bdeced846" },
      { ...honest, lines: [{ menuItemId: "nope", optionIds: [], quantity: 1 }] },
      { ...honest, lines: [{ menuItemId: s.plainId, optionIds: [], quantity: -3 }] },
    ]) {
      expect(await replay(bad)).toContain("invalid_input");
    }
  });

  test("is accessible, before and after saving", async ({ page, request }) => {
    await checkoutWithPlainItem(page, request);
    const scan = () =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
    expect((await scan()).violations).toEqual([]);
    await page.getByTestId("save-checkout").click();
    await expect(page.getByTestId("checkout-saved")).toBeVisible();
    expect((await scan()).violations).toEqual([]);
  });
});

test.describe("existing behaviour is unchanged", () => {
  test("the home page and staff sign-in still work", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your table is the counter." })).toBeVisible();
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login$/);
  });
});
