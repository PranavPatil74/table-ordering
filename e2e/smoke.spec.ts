import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("home page", () => {
  test("explains the QR ordering flow", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/Sandwich Express/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your table is the counter.");
    await expect(page.getByRole("heading", { level: 2, name: "How it works" })).toBeVisible();

    const steps = page.getByRole("list").getByRole("listitem");
    await expect(steps).toHaveCount(3);
  });

  test("has no horizontal scrolling at this viewport", async ({ page }) => {
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("passes automated accessibility checks (WCAG 2.x A/AA)", async ({ page }) => {
    await page.goto("/");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("loads the brand fonts from our own origin, not a third party", async ({ page }) => {
    const requestedHosts = new Set<string>();
    page.on("request", (request) => requestedHosts.add(new URL(request.url()).hostname));
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    expect([...requestedHosts]).toEqual(["localhost"]);
  });
});

test.describe("platform basics", () => {
  test("health endpoint answers and is not cacheable", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("responses carry baseline security headers and hide the framework", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("unknown routes return 404", async ({ request }) => {
    const response = await request.get("/this-route-does-not-exist");
    expect(response.status()).toBe(404);
  });

  test("does not leak secrets or the service role key into served pages", async ({ request }) => {
    const html = await (await request.get("/")).text();
    expect(html).not.toContain("e2e-fixture-service-role-key");
  });
});
