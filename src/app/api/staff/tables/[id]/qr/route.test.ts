import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireStaffApi = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireStaffApi: (...a: unknown[]) => requireStaffApi(...a),
}));

let table: { code: string; label: string; is_active: boolean } | null = null;
let dbError: unknown = null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: table, error: dbError }) }),
      }),
    }),
  }),
}));

let appUrl = "https://orders.example.com";
vi.mock("@/lib/env/app-url", () => ({
  getQrBaseUrl: () => ({ origin: appUrl, source: "APP_BASE_URL" }),
}));

const { GET } = await import("./route");

const ID = "11111111-1111-4111-8111-111111111111";
const call = (query = "", id = ID) =>
  GET(new NextRequest(`http://localhost/api/staff/tables/${id}/qr${query}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.unstubAllEnvs();
  appUrl = "https://orders.example.com";
  table = { code: "T06", label: "Table 6", is_active: true };
  dbError = null;
  requireStaffApi.mockResolvedValue({ ok: true, staff: { role: "manager" } });
});

describe("QR download route", () => {
  it("asks for a manager and returns the guard's refusal untouched", async () => {
    requireStaffApi.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const response = await call();
    expect(requireStaffApi).toHaveBeenCalledWith("manager");
    expect(response.status).toBe(403);
  });

  it("serves an SVG that encodes the table link, not marked test-only for a public https URL", async () => {
    const response = await call("?format=svg&download=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/image\/svg\+xml/);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="table-t06-qr.svg"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toMatch(/TEST ONLY/);
  });

  it("serves a PNG", async () => {
    const response = await call("?format=png");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(new Uint8Array(await response.arrayBuffer()).slice(1, 4)).toEqual(
      new Uint8Array([0x50, 0x4e, 0x47]),
    );
  });

  it("in development with a localhost URL, files are named and drawn TEST ONLY", async () => {
    vi.stubEnv("NODE_ENV", "development");
    appUrl = "http://localhost:3000";
    const response = await call("?format=svg");
    expect(response.headers.get("Content-Disposition")).toContain("table-t06-qr-TEST-ONLY.svg");
    expect(await response.text()).toMatch(/TEST ONLY/);
  });

  it("in a production build with a localhost URL, refuses to produce any QR file", async () => {
    vi.stubEnv("NODE_ENV", "production");
    appUrl = "http://localhost:3000";
    for (const format of ["svg", "png"]) {
      const response = await call(`?format=${format}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "base_url_not_public" });
    }
  });

  it("refuses a deactivated table, an unknown table and a malformed id", async () => {
    table = { code: "T06", label: "Table 6", is_active: false };
    expect((await call()).status).toBe(409);
    table = null;
    expect((await call()).status).toBe(404);
    expect((await call("", "not-a-uuid")).status).toBe(404);
  });

  it("rejects an unknown format and reports a database outage as 503 without details", async () => {
    expect((await call("?format=pdf")).status).toBe(400);
    dbError = { message: "relation secret_table does not exist" };
    const response = await call();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret_table/);
  });
});
