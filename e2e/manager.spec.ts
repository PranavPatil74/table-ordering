import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { E2E_ACCOUNTS, E2E_PASSWORD, E2E_PUBLIC_PORT, FAKE_SUPABASE_PORT } from "./test-env";

/**
 * Phase 3 manager area, in a real browser against the production build and the TEST DOUBLE of
 * Supabase (e2e/fake-supabase.mjs, which imitates roles and constraints in memory). These prove
 * the app's behaviour. They do not prove real RLS or constraints: see `pnpm test:db` and
 * `pnpm test:supabase`.
 */

const PUBLIC = `http://localhost:${E2E_PUBLIC_PORT}`;

async function signIn(page: Page, email: string, base = "") {
  await page.goto(`${base}/staff/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/** Names unique per Playwright project, so the two projects can share one in-memory database. */
function names(projectName: string) {
  const id = `${projectName === "mobile" ? "M" : "D"}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return { id, code: `Z${id}`, word: `Test ${id}` };
}

async function dbRows(request: APIRequestContext, table: string) {
  const response = await request.get(
    `http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub/state?table=${table}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as Record<string, unknown>[];
}

test.describe("access control", () => {
  test("a signed-out visitor is sent to sign in, and gets 401 from the QR API", async ({
    page,
    request,
  }) => {
    await page.goto("/staff/manager/menu");
    await expect(page).toHaveURL(/\/staff\/login\?next=/);
    const api = await request.get("/api/staff/tables/10000000-0000-4000-8000-000000000003/qr");
    expect(api.status()).toBe(401);
  });

  test("a counter gets 404 for every manager page and 403 from the QR API", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    for (const path of [
      "/staff/manager",
      "/staff/manager/menu",
      "/staff/manager/menu/items/new",
      "/staff/manager/menu/modifiers",
      "/staff/manager/tables",
      "/staff/manager/tables/print",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    const api = await page.request.get("/api/staff/tables/10000000-0000-4000-8000-000000000003/qr");
    expect(api.status()).toBe(403);
    await page.goto("/staff");
    await expect(page.getByRole("link", { name: "Menu management" })).toHaveCount(0);
  });

  test("a manager sees the manager tools and navigation", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
    await expect(page.getByRole("link", { name: "Manager overview" })).toBeVisible();
    await page.getByRole("link", { name: "Menu management" }).click();
    await expect(page).toHaveURL(/\/staff\/manager\/menu$/);
    const nav = page.getByRole("navigation", { name: "Manager" });
    await expect(nav.getByRole("link", { name: "Menu management" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await nav.getByRole("link", { name: "Cafe tables and QR codes" }).click();
    await expect(
      page.getByRole("heading", { name: "Cafe tables and QR codes", level: 1 }),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByRole("heading", { name: "Manager overview" })).toBeVisible();
  });
});

test.describe("menu management", () => {
  test("add a category and an item; invalid price keeps the form; sold out, archive and delete", async ({
    page,
    request,
  }, testInfo) => {
    const n = names(testInfo.project.name);
    await signIn(page, E2E_ACCOUNTS.manager);

    // Category
    await page.goto("/staff/manager/menu/categories");
    const addCategory = page.getByRole("form", { name: "Add category" });
    await addCategory.getByLabel("Name").fill(`Cat ${n.id}`);
    await addCategory.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByText(`Added "Cat ${n.id}".`)).toBeVisible();
    await expect(page.getByRole("heading", { name: `Cat ${n.id}` })).toBeVisible();

    // Item: invalid price first
    await page.goto("/staff/manager/menu/items/new");
    const form = page.getByRole("form", { name: "Add item" });
    await form.getByLabel("Name").fill(`Item ${n.id}`);
    await form.getByLabel("Category").selectOption({ label: `Cat ${n.id}` });
    await form.getByLabel(/Price/).fill("12.345");
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(form.getByRole("alert")).toContainText("Please fix the highlighted fields");
    await expect(form.getByText(/whole paise|two decimals|up to two/i).first()).toBeVisible();
    await expect(form.getByLabel("Name")).toHaveValue(`Item ${n.id}`); // typed values survive an error

    // Valid price
    await form.getByLabel(/Price/).fill("249.50");
    await form.getByLabel("Vegetarian", { exact: true }).check();
    await form.getByRole("button", { name: "Add item" }).click();
    await expect(page).toHaveURL(/\/staff\/manager\/menu\/items\/[0-9a-f-]{36}\?created=1/);
    await expect(page.getByRole("heading", { name: `Item ${n.id}`, level: 1 })).toBeVisible();
    await expect(page.getByText("₹249.50").first()).toBeVisible();
    const stored = (await dbRows(request, "menu_items")).find((row) => row.name === `Item ${n.id}`);
    expect(stored).toMatchObject({ price_paise: 24950, dietary_tags: ["veg"] }); // integer paise

    // List actions
    await page.goto("/staff/manager/menu");
    const row = page.getByRole("listitem").filter({ hasText: `Item ${n.id}` });
    await row.getByRole("button", { name: `Mark sold out: Item ${n.id}` }).click();
    await expect(page.getByText("Marked sold out.")).toBeVisible();
    await expect(row.getByText("Sold out", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Archive Item ${n.id}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(row.getByText("Archived", { exact: true })).toHaveCount(0); // cancelled: nothing changed
    await row.getByRole("button", { name: `Archive Item ${n.id}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();
    await expect(row.getByText("Archived", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Delete Item ${n.id}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Item deleted.")).toBeVisible();
    await expect(page.getByRole("link", { name: `Item ${n.id}` })).toHaveCount(0);
  });

  test("a duplicate item name gets a clear error, not a database message", async ({
    page,
  }, testInfo) => {
    const n = names(testInfo.project.name);
    await signIn(page, E2E_ACCOUNTS.manager);
    for (const attempt of [1, 2]) {
      await page.goto("/staff/manager/menu/items/new");
      const form = page.getByRole("form", { name: "Add item" });
      await form.getByLabel("Name").fill(`Dup ${n.id}`);
      await form.getByLabel(/Price/).fill("10");
      await form.getByRole("button", { name: "Add item" }).click();
      if (attempt === 2) {
        await expect(form.getByRole("alert")).toBeVisible();
        await expect(form.getByRole("alert")).toContainText(/already exists/);
        await expect(page.locator("body")).not.toContainText(/violates|constraint|menu_items_/);
      } else {
        await expect(page).toHaveURL(/created=1/);
      }
    }
  });

  test("modifier group: options priced in rupees, rules enforced, attached to an item", async ({
    page,
    request,
  }, testInfo) => {
    const n = names(testInfo.project.name);
    await signIn(page, E2E_ACCOUNTS.manager);

    await page.goto("/staff/manager/menu/modifiers");
    const add = page.getByRole("form", { name: "Add modifier group" });
    await add.getByLabel("Name").fill(`Size ${n.id}`);
    await add.getByLabel("Minimum choices").fill("0");
    await add.getByLabel("Maximum choices").fill("0"); // invalid: at least 1
    await add.getByRole("button", { name: "Add group" }).click();
    await expect(add.getByRole("alert")).toBeVisible();
    await add.getByLabel("Maximum choices").fill("1");
    await add.getByRole("button", { name: "Add group" }).click();
    await expect(page).toHaveURL(/\/staff\/manager\/menu\/modifiers\/[0-9a-f-]{36}\?created=1/);

    const option = page.getByRole("form", { name: "Add option" });
    await option.getByLabel("Option name").fill("Large");
    await option.getByLabel(/Extra price/).fill("20");
    await option.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText('Added "Large".')).toBeVisible();
    await expect(page.getByRole("heading", { name: "Large" })).toBeVisible();
    const stored = (await dbRows(request, "modifier_options")).find(
      (row) => row.name === "Large" && row.price_delta_paise === 2000,
    );
    expect(stored).toBeDefined();

    // Over the limit is refused, with the price field flagged
    await option.getByLabel("Option name").fill("Huge");
    await option.getByLabel(/Extra price/).fill("10001");
    await option.getByRole("button", { name: "Add option" }).click();
    await expect(option.getByRole("alert")).toBeVisible();

    // Attach to the seeded item
    await page.goto("/staff/manager/menu/items/10000000-0000-4000-8000-000000000002");
    const choices = page.getByRole("form", { name: "Choices for this item" });
    await choices.getByLabel(new RegExp(`^Size ${n.id}`)).check();
    await choices.getByRole("button", { name: "Save choices" }).click();
    await expect(page.getByText("Choices saved.")).toBeVisible();
    const links = await dbRows(request, "menu_item_modifier_groups");
    expect(links.some((l) => l.item_id === "10000000-0000-4000-8000-000000000002")).toBe(true);
  });
});

test.describe("table management", () => {
  test("create, reject a bad or duplicate code, rename, deactivate and reactivate", async ({
    page,
  }, testInfo) => {
    const n = names(testInfo.project.name);
    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto("/staff/manager/tables");

    const form = page.getByRole("form", { name: "Add table" });
    await form.getByLabel("Code").fill("bad code!");
    await form.getByLabel("Name").fill("Nope");
    await form.getByRole("button", { name: "Add table" }).click();
    await expect(form.getByText(/capital letters, digits/)).toBeVisible();

    await form.getByLabel("Code").fill(n.code.toLowerCase()); // normalised to upper case
    await form.getByLabel("Name").fill(n.word);
    await form.getByRole("button", { name: "Add table" }).click();
    await expect(page.getByText(`Added table ${n.code}.`)).toBeVisible();
    await expect(page.getByRole("heading", { name: n.word })).toBeVisible();

    await form.getByLabel("Code").fill(n.code);
    await form.getByLabel("Name").fill("Same code");
    await form.getByRole("button", { name: "Add table" }).click();
    await expect(form.getByText("A table with this code already exists.")).toHaveCount(2); // summary and field
    await expect(form.getByRole("alert")).toContainText("A table with this code already exists.");

    const rename = page.getByRole("form", { name: `Rename table ${n.code}` });
    await rename.getByRole("textbox", { name: "Name" }).fill(`${n.word} (window)`);
    await rename.getByRole("button", { name: `Save name of table ${n.code}` }).click();
    await expect(page.getByText("Table renamed.")).toBeVisible();
    await expect(page.getByRole("heading", { name: `${n.word} (window)` })).toBeVisible();

    await page.getByRole("button", { name: `Deactivate table ${n.code}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText(/no longer takes orders/)).toBeVisible();
    await expect(page.getByRole("link", { name: `QR code for table ${n.code}` })).toHaveCount(0);

    await page.getByRole("button", { name: `Reactivate table ${n.code}` }).click();
    await expect(page.getByText(/works again/)).toBeVisible();
    await expect(page.getByRole("link", { name: `QR code for table ${n.code}` })).toBeVisible();
  });

  test("a deactivated table's QR page says it does not take orders", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto("/staff/manager/tables/10000000-0000-4000-8000-000000000004");
    await expect(page.getByRole("alert").filter({ hasText: "deactivated" })).toBeVisible();
    await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
    const api = await page.request.get("/api/staff/tables/10000000-0000-4000-8000-000000000004/qr");
    expect(api.status()).toBe(409);
  });
});

test.describe("QR codes", () => {
  const T01 = "10000000-0000-4000-8000-000000000003";

  test("with a localhost address in a production build: preview only, export refused", async ({
    page,
  }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto(`/staff/manager/tables/${T01}`);
    await expect(page.getByRole("img", { name: /QR code for Table 1/ })).toBeVisible();
    await expect(page.getByText(/\/menu\?table=T01/).first()).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "turned off" })).toContainText(
      "APP_BASE_URL",
    );
    await expect(page.getByRole("link", { name: "Download SVG" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Print this code" })).toHaveCount(0);

    for (const format of ["svg", "png"]) {
      const api = await page.request.get(`/api/staff/tables/${T01}/qr?format=${format}`);
      expect(api.status()).toBe(403);
      expect(await api.json()).toEqual({ error: "base_url_not_public" });
    }
    await page.goto("/staff/manager/tables/print");
    await expect(page.getByRole("alert").filter({ hasText: "turned off" })).toBeVisible();
    await expect(page.getByRole("list", { name: "QR codes to print" })).toHaveCount(0);
  });

  test("with a public https address: preview, SVG and PNG download, printable sheet", async ({
    page,
  }) => {
    await signIn(page, E2E_ACCOUNTS.manager, PUBLIC);
    await page.goto(`${PUBLIC}/staff/manager/tables/${T01}`);
    await expect(page.getByText("https://orders.example.com/menu?table=T01")).toBeVisible();
    await expect(page.getByText(/TEST ONLY/)).toHaveCount(0);

    const svg = await page.request.get(
      `${PUBLIC}/api/staff/tables/${T01}/qr?format=svg&download=1`,
    );
    expect(svg.status()).toBe(200);
    expect(svg.headers()["content-type"]).toContain("image/svg+xml");
    expect(svg.headers()["content-disposition"]).toBe('attachment; filename="table-t01-qr.svg"');
    expect(await svg.text()).toContain("<svg");

    const png = await page.request.get(
      `${PUBLIC}/api/staff/tables/${T01}/qr?format=png&download=1`,
    );
    expect(png.headers()["content-type"]).toBe("image/png");
    expect([...(await png.body()).subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);

    await expect(page.getByRole("link", { name: "Download SVG" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download PNG" })).toBeVisible();

    await page.goto(`${PUBLIC}/staff/manager/tables/print`);
    const sheet = page.getByRole("list", { name: "QR codes to print" });
    await expect(sheet.getByRole("heading", { name: "Table 1" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Table 2" })).toHaveCount(0); // deactivated
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("banner")).toBeHidden(); // staff header and navigation are not printed
    await expect(page.getByRole("navigation", { name: "Manager" })).toBeHidden();
  });
});

test.describe("accessibility", () => {
  for (const path of [
    "/staff/manager",
    "/staff/manager/menu",
    "/staff/manager/menu/categories",
    "/staff/manager/menu/items/new",
    "/staff/manager/menu/modifiers",
    "/staff/manager/tables",
    "/staff/manager/tables/10000000-0000-4000-8000-000000000003",
  ]) {
    test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
      await signIn(page, E2E_ACCOUNTS.manager);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // The error screen also has an h1, so check explicitly that the page really rendered.
      await expect(page.getByText("We couldn't load this page")).toHaveCount(0);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
        ),
      ).toEqual([]);
    });
  }
});
