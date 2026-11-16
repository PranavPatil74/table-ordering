import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

import { E2E_ACCOUNTS, E2E_PASSWORD, FAKE_SUPABASE_PORT } from "./test-env";

/**
 * Phase 4 manager staff management, in a real browser against the PRODUCTION build and the TEST
 * DOUBLE of Supabase (e2e/fake-supabase.mjs). It proves the app's behaviour for each response the
 * real services can give; real RLS and the last-manager trigger are proven by `pnpm test:db` and
 * `pnpm test:supabase`.
 */

const STAFF = "/staff/manager/staff";
const FAKE = `http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub`;

async function signIn(page: Page, email: string) {
  await page.goto("/staff/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

/** One target account per Playwright project, so the two projects never touch each other's. */
const target = (project: string) => ({
  email: `target-${project}@sandwich-express.test`,
  name: project === "mobile" ? "Tara Mobile" : "Tara Desktop",
});
/** A different account for the race test, which runs in parallel with the test above. */
const racer = (project: string) => ({
  email: `race-${project}@sandwich-express.test`,
  name: project === "mobile" ? "Rhea Mobile" : "Rhea Desktop",
});

async function setProfile(page: Page, email: string, active: boolean) {
  const r = await page.request.post(`${FAKE}/profile?email=${email}&active=${active ? 1 : 0}`);
  expect(r.ok()).toBe(true);
}

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="staff-row"][data-name="${name}"]`);

async function signedInAs(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

test.describe("access control", () => {
  test("a signed-out visitor is sent to sign in", async ({ page }) => {
    await page.goto(STAFF);
    await expect(page).toHaveURL(/\/staff\/login\?next=/);
  });

  test("a counter gets 404 for the staff page and never sees the link", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    const response = await page.goto(STAFF);
    expect(response?.status()).toBe(404);
    await page.goto("/staff");
    await expect(page.getByRole("link", { name: "Staff", exact: true })).toHaveCount(0);
  });

  test("an inactive account and a user without a profile are turned away", async ({ page }) => {
    for (const email of [E2E_ACCOUNTS.inactive, E2E_ACCOUNTS.noProfile]) {
      await page.goto("/staff/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).not.toHaveURL(/\/staff$/);
      const response = await page.goto(STAFF);
      expect(response?.url()).toMatch(/\/staff\/login/);
    }
  });
});

test.describe("directory", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
  });

  test("is in the manager navigation and lists name, email, role, status and added date", async ({
    page,
  }) => {
    await page.getByRole("link", { name: "Manager overview" }).click();
    await page
      .getByRole("navigation", { name: "Manager" })
      .getByRole("link", { name: "Staff" })
      .click();
    await expect(page).toHaveURL(new RegExp(`${STAFF}$`));
    await expect(page.getByRole("heading", { name: "Staff", level: 1 })).toBeVisible();

    const ivy = row(page, "Ivy Inactive");
    await expect(ivy).toContainText("inactive@sandwich-express.test");
    await expect(ivy).toContainText("Counter");
    await expect(ivy).toContainText("Deactivated");
    await expect(ivy).toContainText("Added 15 Jan 2026");
    const morgan = row(page, "Morgan Manager");
    await expect(morgan).toContainText("manager@sandwich-express.test");
    await expect(morgan).toContainText("Manager");
    await expect(morgan).toContainText("Active");
    await expect(page.getByText(/Adding a new team member/)).toBeVisible();
  });

  test("an unreadable e-mail shows as unavailable instead of failing the page", async ({
    page,
  }) => {
    await page.goto(STAFF);
    await expect(row(page, "Gina Ghost")).toContainText("Email unavailable");
  });

  test("search, role and status filters, with a no-match state", async ({ page }) => {
    await page.goto(STAFF);
    const rows = page.getByTestId("staff-row");
    const total = await rows.count();
    expect(total).toBeGreaterThan(5);

    await page.getByLabel("Search name or email").fill("ivy");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ivy Inactive");
    await page.getByLabel("Search name or email").fill("MANAGER@sandwich");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Morgan Manager");

    await page.getByLabel("Search name or email").fill("");
    await page.getByLabel("Status").selectOption("inactive");
    await expect(row(page, "Ivy Inactive")).toBeVisible();
    await expect(row(page, "Casey Counter")).toHaveCount(0);
    await page.getByLabel("Status").selectOption("all");
    await page.getByLabel("Role").selectOption("manager");
    await expect(row(page, "Morgan Manager")).toBeVisible();
    await expect(row(page, "Casey Counter")).toHaveCount(0);

    await page.getByLabel("Search name or email").fill("zzz-nobody");
    await expect(page.getByTestId("staff-no-matches")).toBeVisible();
    await expect(page.getByTestId("staff-count")).toContainText("0 of");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(total);
  });

  test("you cannot deactivate yourself, and are told why", async ({ page }) => {
    await page.goto(STAFF);
    const me = row(page, "Morgan Manager");
    await expect(me).toContainText("You");
    await expect(me.getByRole("button", { name: "Deactivate Morgan Manager" })).toBeDisabled();
    await expect(me).toContainText("This is you");
  });

  test("is accessible and fits the viewport", async ({ page }) => {
    await page.goto(STAFF);
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

test.describe("deactivate and reactivate", () => {
  test("a confirmed deactivation removes the person's access straight away; reactivation restores it", async ({
    page,
    browser,
  }, info) => {
    const t = target(info.project.name);
    await setProfile(page, t.email, true);
    const staff = await signedInAs(browser, t.email);
    await staff.page.goto("/staff");
    await expect(
      staff.page.getByRole("heading", { name: new RegExp(`Hello, ${t.name}`) }),
    ).toBeVisible();

    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto(STAFF);
    const person = row(page, t.name);
    await expect(person).toContainText("Active");

    // Cancel: nothing changes.
    await person.getByRole("button", { name: `Deactivate ${t.name}` }).click();
    await expect(page.getByRole("dialog")).toContainText(`Deactivate ${t.name}?`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(person).toContainText("Active");

    // Confirm.
    await person.getByRole("button", { name: `Deactivate ${t.name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText(`${t.name} is deactivated and has lost access.`)).toBeVisible();
    await expect(person).toContainText("Deactivated");

    // Their existing signed-in session no longer works, on pages or the API.
    await staff.page.goto("/staff");
    await expect(staff.page).toHaveURL(/\/staff\/login/);
    const api = await staff.page.request.get("/api/staff/me");
    expect(api.status()).toBe(403);

    // Reactivate.
    await person.getByRole("button", { name: `Reactivate ${t.name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
    await expect(page.getByText(`${t.name} is active again and can sign in.`)).toBeVisible();
    await expect(person).toContainText("Active");
    // Their session is valid again straight away: no new sign-in is needed.
    await staff.page.goto("/staff");
    await expect(
      staff.page.getByRole("heading", { name: new RegExp(`Hello, ${t.name}`) }),
    ).toBeVisible();
    await staff.context.close();
  });

  test("a change made by someone else first is reported, and the list refreshes", async ({
    page,
  }, info) => {
    const t = racer(info.project.name);
    await setProfile(page, t.email, true);
    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto(STAFF);
    const person = row(page, t.name);
    await expect(person).toContainText("Active");

    // Another manager deactivates them while this page is still showing "Active".
    await setProfile(page, t.email, false);
    await person.getByRole("button", { name: `Deactivate ${t.name}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText(`${t.name} is already deactivated.`)).toBeVisible();
    await expect(person).toContainText("Deactivated");
    await setProfile(page, t.email, true);
  });
});

test.describe("direct Server Action calls (the staff 'API')", () => {
  const PROBES = {
    mobile: {
      id: "00000000-0000-4000-8000-000000000016",
      email: "probe-mobile@sandwich-express.test",
      name: "Pia Mobile",
    },
    desktop: {
      id: "00000000-0000-4000-8000-000000000017",
      email: "probe-desktop@sandwich-express.test",
      name: "Pia Desktop",
    },
  } as const;

  test("a counter or a signed-out client replaying the real request changes nothing", async ({
    page,
    browser,
    request,
  }, info) => {
    const probe = PROBES[info.project.name as "mobile" | "desktop"];
    const isActive = async () => {
      const r = await page.request.get(`${FAKE}/profiles`);
      return ((await r.json()) as Record<string, { is_active: boolean }>)[probe.email]?.is_active;
    };
    await setProfile(page, probe.email, true);

    // 1. As a manager, capture the real Server Action id the Deactivate button sends, WITHOUT
    //    letting that request run.
    await signIn(page, E2E_ACCOUNTS.manager);
    await page.goto(STAFF);
    let actionId = "";
    await page.route("**/staff/manager/staff", async (route) => {
      const id = route.request().headers()["next-action"];
      if (route.request().method() === "POST" && id) {
        actionId = id;
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await row(page, probe.name)
      .getByRole("button", { name: `Deactivate ${probe.name}` })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect.poll(() => actionId).not.toBe("");
    await page.unroute("**/staff/manager/staff");
    expect(await isActive()).toBe(true);

    const replay = (ctx: Page["request"], args: unknown[]) =>
      ctx.post(STAFF, {
        headers: {
          "next-action": actionId,
          "content-type": "text/plain;charset=UTF-8",
          accept: "text/x-component",
        },
        data: JSON.stringify(args),
        failOnStatusCode: false,
      });

    // 2. A signed-in COUNTER replays it, also with an escalated payload.
    const counter = await signedInAs(browser, E2E_ACCOUNTS.counter);
    for (const args of [
      [probe.id, false],
      [probe.id, false, { role: "manager" }],
    ]) {
      const response = await replay(counter.page.request, args);
      expect(await response.text()).toContain("You don't have permission to do that.");
      expect(await isActive()).toBe(true);
    }
    await counter.context.close();

    // 3. A signed-out client replays it.
    //    The proxy turns it away before the action runs (a redirect to sign-in); even if it did
    //    not, the action itself refuses ("session has expired"). Either way nothing changes.
    const anonymous = await request.post(STAFF, {
      headers: {
        "next-action": actionId,
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
      },
      data: JSON.stringify([probe.id, false]),
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(anonymous.status()).toBeGreaterThanOrEqual(300);
    expect(anonymous.status()).toBeLessThan(400);
    expect(anonymous.headers()["location"]).toMatch(/\/staff\/login/);
    expect(await anonymous.text()).not.toContain("deactivated");
    expect(await isActive()).toBe(true);

    // 4. Control: the real manager's session CAN do it, so the refusals above are not vacuous.
    const allowed = await replay(page.request, [probe.id, false]);
    expect(await allowed.text()).toContain("is deactivated and has lost access");
    expect(await isActive()).toBe(false);
    await setProfile(page, probe.email, true);
  });
});
