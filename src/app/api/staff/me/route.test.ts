import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

const requireStaffApi = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireStaffApi: (...a: unknown[]) => requireStaffApi(...a),
}));

const { GET } = await import("./route");

describe("GET /api/staff/me", () => {
  it("returns the verified staff member's id, name and role, and nothing else", async () => {
    requireStaffApi.mockResolvedValue({
      ok: true,
      staff: {
        userId: "u1",
        displayName: "Pat",
        role: "manager",
        extra: "secret",
        email: "p@x.co",
      },
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "u1", displayName: "Pat", role: "manager" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns the guard's refusal untouched", async () => {
    const refusal = NextResponse.json({ error: "forbidden" }, { status: 403 });
    requireStaffApi.mockResolvedValue({ ok: false, response: refusal });
    expect(await GET()).toBe(refusal);
  });
});
