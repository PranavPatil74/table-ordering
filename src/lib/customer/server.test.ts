import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const hit = vi.fn();
vi.mock("@/lib/privileged/rate-limit", () => ({ hitRateLimit: (...a: unknown[]) => hit(...a) }));

const tableRow = vi.fn();
const from = vi.fn();
vi.mock("@/lib/privileged/service-client", () => ({
  createServiceRoleClient: () => ({ from }),
}));

const loadMenuMock = vi.fn();
vi.mock("./menu-loader", () => ({ loadMenu: () => loadMenuMock() }));

import { catalog, ids, settings } from "./fixtures";
import { previewOrder } from "./preview";
import { resolveTable, tableProblemCopy } from "./table-resolver";

const TABLE = {
  id: "10000000-0000-4000-8000-000000000003",
  code: "T01",
  label: "Table 1",
  is_active: true,
};
const SUBMISSION = "99999999-0000-4000-8000-000000000001";

function lookup(result: { data: unknown; error: unknown }) {
  tableRow.mockResolvedValue(result);
  from.mockReturnValue({
    select: () => ({ eq: () => ({ maybeSingle: () => tableRow() }) }),
  });
}

beforeEach(() => {
  hit.mockReset().mockResolvedValue("allowed");
  tableRow.mockReset();
  from.mockReset();
  loadMenuMock.mockReset().mockResolvedValue({ ok: true, catalog: catalog(), settings });
  lookup({ data: TABLE, error: null });
});

describe("resolveTable", () => {
  it("resolves an active table and normalises the code", async () => {
    expect(await resolveTable(" t01 ")).toEqual({
      status: "ok",
      table: { id: TABLE.id, code: "T01", label: "Table 1" },
    });
  });
  it("takes the first value of a repeated query parameter", async () => {
    expect(await resolveTable(["T01", "T02"])).toMatchObject({ status: "ok" });
  });
  it.each([
    undefined,
    null,
    5,
    "",
    "  ",
    "t",
    "1ABC",
    "T 01",
    "T01;DROP",
    "A".repeat(40),
    "t/../x",
  ])("rejects malformed input %j without touching the database", async (raw) => {
    expect(await resolveTable(raw)).toEqual({ status: "invalid" });
    expect(from).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
  });
  it("treats an unknown table exactly like a malformed one", async () => {
    lookup({ data: null, error: null });
    expect(await resolveTable("T99")).toEqual({ status: "invalid" });
  });
  it("refuses a deactivated table", async () => {
    lookup({ data: { ...TABLE, is_active: false }, error: null });
    expect(await resolveTable("T01")).toEqual({ status: "inactive", label: "Table 1" });
  });
  it("is rate limited, and fails closed if the limiter is down", async () => {
    hit.mockResolvedValueOnce("limited");
    expect(await resolveTable("T01")).toEqual({ status: "rate_limited" });
    hit.mockResolvedValueOnce("unavailable");
    expect(await resolveTable("T01")).toEqual({ status: "unavailable" });
    expect(from).not.toHaveBeenCalled();
  });
  it("reports a database failure as unavailable, not as an invalid table", async () => {
    lookup({ data: null, error: { message: "down" } });
    expect(await resolveTable("T01")).toEqual({ status: "unavailable" });
    from.mockImplementation(() => {
      throw new Error("network");
    });
    expect(await resolveTable("T01")).toEqual({ status: "unavailable" });
  });
  it("has helpful, non-leaky copy for every failure", () => {
    for (const r of [
      { status: "invalid" },
      { status: "inactive", label: "x" },
      { status: "rate_limited" },
      { status: "unavailable" },
    ] as const) {
      const copy = tableProblemCopy(r);
      expect(copy.title.length).toBeGreaterThan(5);
      expect(copy.body).not.toMatch(/supabase|postgres|error code|cafe_tables/i);
    }
  });
});

const line = (menuItemId: string, optionIds: string[], quantity: number) => ({
  menuItemId,
  optionIds,
  quantity,
});
const request = (over: Record<string, unknown> = {}) => ({
  tableCode: "T01",
  submissionId: SUBMISSION,
  lines: [line(ids.grilled, [ids.white, ids.cheese], 2), line(ids.cola, [], 1)],
  ...over,
});

describe("previewOrder", () => {
  it("re-prices from the live menu and returns a verified total", async () => {
    const r = await previewOrder(request());
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.totalPaise).toBe((14900 + 2500) * 2 + 4000);
    expect(r.payment).toBe("not_configured");
    expect(r.table).toEqual({ code: "T01", label: "Table 1" });
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores any price, total or table id the browser sends", async () => {
    const r = await previewOrder(
      request({
        totalPaise: 1,
        pricePaise: 1,
        tableId: "00000000-0000-4000-8000-000000000000",
        lines: [{ ...line(ids.cola, [], 1), pricePaise: 1, unit_price_paise: 1 }],
      }),
    );
    expect(r).toMatchObject({ status: "ready", totalPaise: 4000 });
  });
  it("gives the same fingerprint for the same cart and a different one when it changes", async () => {
    const a = await previewOrder(request());
    const b = await previewOrder(request());
    const c = await previewOrder(request({ customerName: "Asha" }));
    if (a.status !== "ready" || b.status !== "ready" || c.status !== "ready") throw new Error("x");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
  it("is free of side effects: only the table lookup and rate limiter are touched", async () => {
    await previewOrder(request());
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("cafe_tables");
  });
  it.each([
    ["not an object", "nope"],
    ["bad submission id", request({ submissionId: "abc" })],
    ["missing lines", { tableCode: "T01", submissionId: SUBMISSION }],
    ["zero quantity", request({ lines: [line(ids.cola, [], 0)] })],
    ["fractional quantity", request({ lines: [line(ids.cola, [], 1.5)] })],
    ["bad item id", request({ lines: [line("x", [], 1)] })],
    ["too many lines", request({ lines: Array.from({ length: 51 }, () => line(ids.cola, [], 1)) })],
    ["huge note", request({ specialInstructions: "x".repeat(5000) })],
  ])("rejects %s", async (_name, input) => {
    expect((await previewOrder(input)).status).toBe("invalid_input");
  });
  it("reports unavailable and removed items instead of pricing them", async () => {
    const r = await previewOrder(
      request({
        lines: [
          line(ids.soldOut, [], 1),
          line("20000000-0000-4000-8000-0000000000ff", [], 1),
          line(ids.cola, [], 1),
        ],
      }),
    );
    expect(r.status).toBe("needs_attention");
    if (r.status !== "needs_attention") return;
    expect(r.lines.map((l) => l.status)).toEqual(["sold_out", "removed", "ok"]);
    expect(r.totalPaise).toBe(4000);
  });
  it("refuses a selection that breaks the modifier rules", async () => {
    const r = await previewOrder(request({ lines: [line(ids.grilled, [], 1)] }));
    expect(r.status).toBe("needs_attention");
  });
  it("blocks checkout while orders are paused, and when the order is too big", async () => {
    loadMenuMock.mockResolvedValue({
      ok: true,
      catalog: catalog(),
      settings: { ...settings, ordersEnabled: false },
    });
    expect(await previewOrder(request())).toMatchObject({ status: "needs_attention" });
    loadMenuMock.mockResolvedValue({
      ok: true,
      catalog: catalog(),
      settings: { ...settings, maxItemQuantity: 1 },
    });
    expect(await previewOrder(request())).toMatchObject({ status: "needs_attention" });
  });
  it("refuses an invalid or deactivated table", async () => {
    lookup({ data: { ...TABLE, is_active: false }, error: null });
    expect(await previewOrder(request())).toMatchObject({ status: "table_problem" });
    lookup({ data: null, error: null });
    expect(await previewOrder(request())).toMatchObject({ status: "table_problem" });
    expect(await previewOrder(request({ tableCode: "!!" }))).toMatchObject({
      status: "table_problem",
    });
  });
  it("is rate limited and fails closed", async () => {
    hit.mockResolvedValueOnce("limited");
    expect((await previewOrder(request())).status).toBe("busy");
    hit.mockResolvedValueOnce("unavailable");
    expect((await previewOrder(request())).status).toBe("error");
    expect(from).not.toHaveBeenCalled();
  });
  it("reports a menu outage as an error", async () => {
    loadMenuMock.mockResolvedValue({ ok: false, message: "down" });
    expect((await previewOrder(request())).status).toBe("error");
  });
  it("merges duplicate lines sent by a misbehaving client", async () => {
    const r = await previewOrder(
      request({ lines: [line(ids.cola, [], 2), line(ids.cola, [], 3)] }),
    );
    expect(r).toMatchObject({ status: "ready", totalPaise: 20000 });
  });
});
