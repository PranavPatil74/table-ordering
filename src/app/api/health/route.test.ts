import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports ok and is never cached", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("exposes nothing about configuration", async () => {
    const body = JSON.stringify(await GET().json());
    expect(body).not.toMatch(/supabase|razorpay|secret|key|version/i);
  });
});
