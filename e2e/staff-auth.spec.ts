import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { E2E_ACCOUNTS, E2E_ENV, E2E_PASSWORD, FAKE_SUPABASE_PORT } from "./test-env";

/**
 * Staff sign-in, against the real production build and a TEST DOUBLE of Supabase's Auth and
 * profile endpoints (e2e/fake-supabase.mjs). These prove how the APP behaves for each response
 * the real services can give. They do not prove real GoTrue/RLS behaviour: that is
 * `pnpm test:supabase` against a real local stack.
 */

async function signIn(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto("/staff/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function authCookies(context: BrowserContext) {
  return (await context.cookies()).filter((cookie) => /^sb-.+-auth-token/.test(cookie.name));
}

test.describe("unauthenticated visitors", () => {
  test("are redirected from /staff to the sign-in page", async ({ page }) => {
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login$/);
    await expect(page.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
  });

  test("keep their destination when sent to sign in", async ({ page }) => {
    await page.goto("/staff/orders");
    await expect(page).toHaveURL(/\/staff\/login\?next=%2Fstaff%2Forders$/);
    await expect(page.locator('input[name="next"]')).toHaveValue("/staff/orders");
  });

  test("get 401 from the staff API, with no caching", async ({ request }) => {
    const response = await request.get("/api/staff/me");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(response.headers()["cache-control"]).toContain("no-store");
  });

  test("cannot get in with a forged or tampered session cookie", async ({ page, context }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);

    const [cookie] = await authCookies(context);
    expect(cookie).toBeDefined();
    // Corrupt the signature of the access token inside the cookie.
    const session = JSON.parse(
      Buffer.from(cookie!.value.replace(/^base64-/, ""), "base64url").toString(),
    ) as { access_token: string };
    session.access_token = `${session.access_token.slice(0, -4)}AAAA`;
    await context.addCookies([
      {
        ...cookie!,
        value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
      },
    ]);

    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login/);
    expect((await page.request.get("/api/staff/me")).status()).toBe(401);
  });

  test("cannot get in with garbage in the session cookie", async ({ page, context }) => {
    await context.addCookies([
      { name: "sb-127-auth-token", value: "not-a-session", url: E2E_ENV.NEXT_PUBLIC_APP_URL! },
    ]);
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login/);
  });
});

test.describe("sign-in page", () => {
  test("passes automated accessibility checks", async ({ page }) => {
    await page.goto("/staff/login");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("fits the viewport without sideways scrolling", async ({ page }) => {
    await page.goto("/staff/login");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("is not cached, not indexed, and has the baseline security headers", async ({ request }) => {
    const response = await request.get("/staff/login");
    const headers = response.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("explains empty and malformed fields before sending anything", async ({ page }) => {
    await page.goto("/staff/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();

    await page.getByLabel("Email").fill("not-an-email");
    await page.getByLabel("Password", { exact: true }).fill("x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/Enter a valid email address/)).toBeVisible();
    await expect(page).toHaveURL(/\/staff\/login$/);
  });

  test("can show and hide the password", async ({ page }) => {
    await page.goto("/staff/login");
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("never follows a ?next= that leaves the staff area", async ({ page }) => {
    await page.goto("/staff/login?next=https%3A%2F%2Fevil.example%2Fsteal");
    await expect(page.locator('input[name="next"]')).toHaveValue("/staff");
    await page.goto("/staff/login?next=%2F%2Fevil.example");
    await expect(page.locator('input[name="next"]')).toHaveValue("/staff");

    await page.getByLabel("Email").fill(E2E_ACCOUNTS.counter);
    await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/staff$/);
    expect(new URL(page.url()).hostname).toBe("localhost");
  });
});

test.describe("sign-in failures", () => {
  test("wrong password: generic message, email kept, password cleared", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.counter, "definitely-the-wrong-password");
    await expect(page.locator("form").getByRole("alert")).toContainText("don't match");
    await expect(page).toHaveURL(/\/staff\/login$/);
    await expect(page.getByLabel("Email")).toHaveValue(E2E_ACCOUNTS.counter);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  });

  test("unknown email gets the SAME message as a wrong password", async ({ page }) => {
    await signIn(page, "nobody@sandwich-express.test");
    await expect(page.locator("form").getByRole("alert")).toContainText("don't match");
  });

  test("a rate-limited account is told to wait", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.limited);
    await expect(page.locator("form").getByRole("alert")).toContainText(
      "Too many sign-in attempts",
    );
  });

  test("an Auth outage is reported as an outage, not as a wrong password", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.outage);
    await expect(page.locator("form").getByRole("alert")).toContainText(
      "couldn't reach the sign-in service",
    );
  });

  for (const [label, email] of [
    ["has no staff profile", E2E_ACCOUNTS.noProfile],
    ["has an inactive staff profile", E2E_ACCOUNTS.inactive],
  ] as const) {
    test(`a valid Supabase user who ${label} is refused, and no session survives`, async ({
      page,
      context,
    }) => {
      await signIn(page, email);
      await expect(page.locator("form").getByRole("alert")).toContainText(
        "doesn't have staff access",
      );
      await expect(page).toHaveURL(/\/staff\/login$/);
      expect(await authCookies(context)).toEqual([]);

      await page.goto("/staff");
      await expect(page).toHaveURL(/\/staff\/login/);
      expect((await page.request.get("/api/staff/me")).status()).toBe(401);
    });
  }
});

test.describe("signed-in staff", () => {
  test("a counter lands on /staff with the role from the profile, not from user metadata", async ({
    page,
  }) => {
    // The fake gives this account `role: manager` in its (user-editable) metadata.
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Casey Counter");
    await expect(page.getByText("You're signed in as")).toContainText("counter");
    await expect(page.getByText("Activate or deactivate staff accounts")).toHaveCount(0);

    const me = await page.request.get("/api/staff/me");
    expect(me.status()).toBe(200);
    expect(await me.json()).toEqual({
      userId: "00000000-0000-4000-8000-000000000001",
      displayName: "Casey Counter",
      role: "counter",
    });
  });

  test("a manager sees the manager role", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Morgan Manager");
    await expect(page.getByText("Activate or deactivate staff accounts")).toBeVisible();
    expect((await (await page.request.get("/api/staff/me")).json()).role).toBe("manager");
  });

  test("a signed-in staff member is sent away from the sign-in page", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);
    await page.goto("/staff/login");
    await expect(page).toHaveURL(/\/staff$/);
  });

  test("the session cookie is HttpOnly and SameSite=Lax; scripts cannot read it", async ({
    page,
    context,
  }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);
    const cookies = await authCookies(context);
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      expect(cookie.path).toBe("/");
    }
    expect(await page.evaluate(() => document.cookie)).not.toContain("sb-");
  });

  test("pages and APIs never contain tokens, the password or the service-role key", async ({
    page,
    context,
  }) => {
    await signIn(page, E2E_ACCOUNTS.manager);
    await expect(page).toHaveURL(/\/staff$/);

    const [cookie] = await authCookies(context);
    const session = JSON.parse(
      Buffer.from(cookie!.value.replace(/^base64-/, ""), "base64url").toString(),
    ) as { access_token: string; refresh_token: string };

    const bodies = [
      await page.content(),
      await (await page.request.get("/staff")).text(),
      await (await page.request.get("/api/staff/me")).text(),
    ].join("\n");
    for (const secret of [
      session.access_token,
      session.refresh_token,
      E2E_PASSWORD,
      E2E_ENV.SUPABASE_SERVICE_ROLE_KEY!,
    ]) {
      expect(bodies).not.toContain(secret);
    }

    // Nor does the sign-in page, before or after a failed attempt.
    await context.clearCookies();
    await signIn(page, E2E_ACCOUNTS.counter, "wrong-password-value");
    expect(await page.content()).not.toContain("wrong-password-value");
  });

  test("signing out ends the session, clears the cookies and locks the staff area again", async ({
    page,
    context,
  }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/staff\/login\?signed-out=1$/);
    await expect(page.getByRole("status")).toContainText("signed out");
    expect(await authCookies(context)).toEqual([]);

    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login/);
    expect((await page.request.get("/api/staff/me")).status()).toBe(401);
  });

  test("signing out revokes the session at the Auth server, so a stolen cookie stops working", async ({
    browser,
    page,
    context,
  }) => {
    await signIn(page, E2E_ACCOUNTS.counter);
    await expect(page).toHaveURL(/\/staff$/);
    const stolen = await authCookies(context);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/staff\/login/);

    // Replay the pre-sign-out cookie in a fresh browser.
    const attacker = await browser.newContext();
    await attacker.addCookies(stolen);
    const attackerPage = await attacker.newPage();
    await attackerPage.goto(`${E2E_ENV.NEXT_PUBLIC_APP_URL}/staff`);
    await expect(attackerPage).toHaveURL(/\/staff\/login/);
    await attacker.close();
  });
});

test.describe("authorisation is enforced by the server on every request, not just at sign-in", () => {
  test("a role change and a deactivation in the database apply to an already signed-in session", async ({
    page,
  }, testInfo) => {
    const email = `toggle-${testInfo.project.name}@sandwich-express.test`;
    const edit = async (query: string) => {
      const response = await page.request.post(
        `http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub/profile?email=${email}&${query}`,
      );
      expect(response.ok()).toBe(true);
    };
    const me = async () => (await page.request.get("/api/staff/me")).status();

    await signIn(page, email);
    await expect(page).toHaveURL(/\/staff$/);
    await expect(page.getByText("Activate or deactivate staff accounts")).toBeVisible();
    expect(await me()).toBe(200);

    // Demoted in the database: the SAME session is now a counter.
    await edit("role=counter");
    await page.goto("/staff");
    await expect(page.getByText("You're signed in as")).toContainText("counter");
    await expect(page.getByText("Activate or deactivate staff accounts")).toHaveCount(0);
    expect((await (await page.request.get("/api/staff/me")).json()).role).toBe("counter");

    // Deactivated in the database: the valid session no longer opens the staff area.
    await edit("active=0");
    expect(await me()).toBe(403);
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff\/login$/);
    await expect(page.locator("main, div").getByText(/has been deactivated/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Reactivated: access returns without signing in again.
    await edit("active=1&role=manager");
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/staff$/);
  });
});

test.describe("session refresh", () => {
  test("a session about to expire is refreshed once by the proxy, saved to the browser, and never refreshed twice", async ({
    page,
    context,
  }, testInfo) => {
    const email = `refresh-${testInfo.project.name}@sandwich-express.test`;
    const stats = async () =>
      (await (
        await page.request.get(`http://127.0.0.1:${FAKE_SUPABASE_PORT}/__stub/stats`)
      ).json()) as Record<string, number>;
    const readSession = async () => {
      const [cookie] = await authCookies(context);
      return {
        cookie: cookie!,
        session: JSON.parse(
          Buffer.from(cookie!.value.replace(/^base64-/, ""), "base64url").toString(),
        ) as { expires_at: number; expires_in: number },
      };
    };

    await signIn(page, email);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Remy Refresh");

    // Make the stored session look like it expires in 10 seconds (inside supabase-js's 90 s
    // refresh margin). The access and refresh tokens themselves are untouched and still valid.
    const { cookie, session } = await readSession();
    session.expires_at = Math.floor(Date.now() / 1000) + 10;
    session.expires_in = 10;
    await context.addCookies([
      { ...cookie, value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` },
    ]);
    const before = await stats();
    const refreshesBefore = before[`refresh:${email}`] ?? 0;

    // This navigation must refresh exactly once, in the proxy, and the browser must keep the result.
    await page.goto("/staff");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Remy Refresh");
    const afterOne = await stats();
    expect((afterOne[`refresh:${email}`] ?? 0) - refreshesBefore).toBe(1);
    expect((await readSession()).session.expires_at).toBeGreaterThan(Date.now() / 1000 + 1800);

    // The saved session is fresh, so further requests must not refresh again, and no request may
    // ever present a refresh token that was already rotated away.
    for (let i = 0; i < 3; i += 1) {
      await page.goto("/staff");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Remy Refresh");
    }
    expect((await page.request.get("/api/staff/me")).status()).toBe(200);
    const end = await stats();
    expect(end[`refresh:${email}`] ?? 0).toBe(refreshesBefore + 1);
    expect(end[`stale-refresh:${email}`] ?? 0).toBe(0);
  });
});
