import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const hit = vi.fn();
vi.mock("@/lib/privileged/rate-limit", () => ({ hitRateLimit: (...a: unknown[]) => hit(...a) }));

const resolve = vi.fn();
vi.mock("./table-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./table-resolver")>()),
  resolveTable: (...a: unknown[]) => resolve(...a),
}));

const loadMenuMock = vi.fn();
vi.mock("./menu-loader", () => ({ loadMenu: () => loadMenuMock() }));

const create = vi.fn();
const read = vi.fn();
vi.mock("@/lib/privileged/checkout-attempts", () => ({
  createCheckoutAttempt: (...a: unknown[]) => create(...a),
  readCheckoutAttempt: (...a: unknown[]) => read(...a),
}));

import { loadSavedCheckout, saveCheckout } from "./checkout";
import {
  checkoutReference,
  checkoutStage,
  summariseSnapshot,
  type SnapshotLike,
} from "./checkout-types";
import { catalog, ids, settings } from "./fixtures";

const TABLE = { id: "10000000-0000-4000-8000-000000000003", code: "T01", label: "Table 1" };
const SUBMISSION = "99999999-0000-4000-8000-000000000001";

const line = (menuItemId: string, optionIds: string[], quantity: number) => ({
  menuItemId,
  optionIds,
  quantity,
});
const request = (over: Record<string, unknown> = {}) => ({
  tableCode: "T01",
  submissionId: SUBMISSION,
  customerName: "  Asha ",
  specialInstructions: "No onions",
  lines: [line(ids.grilled, [ids.white, ids.cheese], 2), line(ids.cola, [], 1)],
  ...over,
});

const EXPECTED_TOTAL = (14900 + 2500) * 2 + 4000;

function storedAttempt(over: Record<string, unknown> = {}) {
  return {
    status: "PENDING" as const,
    amountPaise: EXPECTED_TOTAL,
    createdAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2099-11-05T10:30:00.000Z",
    orderCreated: false,
    snapshot: {
      version: 1 as const,
      table: TABLE,
      items: [
        {
          item_name: "Grilled Sandwich",
          unit_price_paise: 14900,
          quantity: 2,
          options: [{ option_name: "Extra cheese", price_delta_paise: 2500 }],
        },
        { item_name: "Cola", unit_price_paise: 4000, quantity: 1, options: [] },
      ],
      total_paise: EXPECTED_TOTAL,
    },
    ...over,
  };
}

beforeEach(() => {
  hit.mockReset().mockResolvedValue("allowed");
  resolve.mockReset().mockResolvedValue({ status: "ok", table: TABLE });
  loadMenuMock.mockReset().mockResolvedValue({ ok: true, catalog: catalog(), settings });
  create
    .mockReset()
    .mockImplementation(async () => ({ status: "created", attempt: storedAttempt() }));
  read.mockReset().mockResolvedValue({ status: "found", attempt: storedAttempt() });
});

describe("saveCheckout: persistence", () => {
  it("re-prices from the live menu and saves ONE attempt with a server-built snapshot", async () => {
    const r = await saveCheckout(request());
    expect(r).toMatchObject({
      status: "saved",
      replay: false,
      stage: "saved",
      payment: "not_configured",
      totalPaise: EXPECTED_TOTAL,
      table: { code: "T01", label: "Table 1" },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as {
      submissionId: string;
      tableId: string;
      amountPaise: number;
      snapshot: {
        total_paise: number;
        customer_name: string;
        table: { id: string };
        items: unknown[];
      };
    };
    expect(arg.submissionId).toBe(SUBMISSION);
    expect(arg.tableId).toBe(TABLE.id);
    expect(Number.isInteger(arg.amountPaise)).toBe(true);
    expect(arg.amountPaise).toBe(EXPECTED_TOTAL);
    expect(arg.snapshot.total_paise).toBe(EXPECTED_TOTAL);
    expect(arg.snapshot.table.id).toBe(TABLE.id);
    expect(arg.snapshot.customer_name).toBe("Asha");
    expect(arg.snapshot.items).toHaveLength(2);
  });

  it("stores historical names and per-line prices from the DATABASE, not from the request", async () => {
    await saveCheckout(request());
    const { snapshot } = create.mock.calls[0]![0] as {
      snapshot: {
        items: {
          item_name: string;
          unit_price_paise: number;
          options: { option_name: string; price_delta_paise: number }[];
        }[];
      };
    };
    expect(snapshot.items[0]).toMatchObject({
      item_name: "Grilled Sandwich",
      unit_price_paise: 14900,
    });
    expect(snapshot.items[0]!.options.map((o) => [o.option_name, o.price_delta_paise])).toEqual([
      ["White", 0],
      ["Extra cheese", 2500],
    ]);
  });

  it("ignores any price, total, name, status or table id the browser sends", async () => {
    const r = await saveCheckout(
      request({
        totalPaise: 1,
        amountPaise: 1,
        pricePaise: 1,
        paymentStatus: "PAID",
        status: "PAID",
        tableId: "00000000-0000-4000-8000-000000000000",
        lines: [
          { ...line(ids.cola, [], 1), pricePaise: 1, unit_price_paise: 1, name: "Free cola" },
        ],
      }),
    );
    expect(r.status).toBe("saved");
    const arg = create.mock.calls[0]![0] as {
      tableId: string;
      amountPaise: number;
      snapshot: { items: { item_name: string }[] };
    };
    expect(arg.tableId).toBe(TABLE.id);
    expect(arg.amountPaise).toBe(4000);
    expect(arg.snapshot.items[0]!.item_name).toBe("Cola");
    expect(JSON.stringify(arg.snapshot)).not.toContain("Free cola");
  });

  it("uses a changed live price, so a stale cart can never be charged an old price", async () => {
    const changed = catalog();
    changed.categories.forEach((c) =>
      c.items.forEach((i) => {
        if (i.id === ids.cola) i.pricePaise = 5500;
      }),
    );
    loadMenuMock.mockResolvedValue({ ok: true, catalog: changed, settings });
    await saveCheckout(request({ lines: [line(ids.cola, [], 2)] }));
    expect((create.mock.calls[0]![0] as { amountPaise: number }).amountPaise).toBe(11000);
  });

  it("reports a replay as such", async () => {
    create.mockResolvedValue({ status: "existing", attempt: storedAttempt() });
    expect(await saveCheckout(request())).toMatchObject({ status: "saved", replay: true });
  });

  it("returns only what the screen needs: no internal ids and no customer text", async () => {
    const r = await saveCheckout(request());
    const json = JSON.stringify(r);
    expect(json).not.toContain(TABLE.id);
    expect(json).not.toContain(SUBMISSION);
    expect(json).not.toMatch(/Asha|No onions|idempotency|tracking|gateway|cart_snapshot/i);
    expect(r).toMatchObject({ reference: checkoutReference(SUBMISSION) });
  });

  it("never reports success wording or an order for a saved checkout", async () => {
    const r = await saveCheckout(request());
    expect(r).toMatchObject({ stage: "saved", payment: "not_configured" });
    expect(JSON.stringify(r)).not.toMatch(/order_number|orderNumber|confirmed|paid"/i);
  });
});

describe("saveCheckout: rejections (nothing is saved)", () => {
  it.each([
    ["a missing submission id", { submissionId: undefined }],
    ["an empty submission id", { submissionId: "" }],
    ["a malformed submission id", { submissionId: "not-a-uuid" }],
    ["a non-string submission id", { submissionId: 12345 }],
    [
      "a time-based (v1) uuid, which is guessable",
      { submissionId: "c232ab00-9414-11ec-b3c8-9f6bdeced846" },
    ],
    ["the nil uuid", { submissionId: "00000000-0000-0000-0000-000000000000" }],
    ["quantity 0", { lines: [line(ids.cola, [], 0)] }],
    ["a fractional quantity", { lines: [line(ids.cola, [], 1.5)] }],
    ["quantity 100", { lines: [line(ids.cola, [], 100)] }],
    ["a non-uuid item id", { lines: [line("nope", [], 1)] }],
    ["a non-uuid option id", { lines: [line(ids.cola, ["x"], 1)] }],
    ["more than 50 lines", { lines: Array.from({ length: 51 }, () => line(ids.cola, [], 1)) }],
    ["lines that are not an array", { lines: "cola" }],
    ["a missing table code", { tableCode: undefined }],
    ["an over-long table code", { tableCode: "T".repeat(33) }],
    ["an over-long customer name", { customerName: "x".repeat(200) }],
  ])("rejects %s before touching the database", async (_label, over) => {
    const r = await saveCheckout(request(over));
    expect(r.status).toBe("invalid_input");
    expect(create).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "string", 42, []])("rejects a non-object request %j", async (input) => {
    expect((await saveCheckout(input)).status).toBe("invalid_input");
    expect(create).not.toHaveBeenCalled();
  });

  it("needs_attention for an empty cart", async () => {
    const r = await saveCheckout(request({ lines: [] }));
    expect(r.status).toBe("needs_attention");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["an archived item", [line(ids.hidden, [], 1)]],
    ["an unknown item", [line("20000000-0000-4000-8000-0000000000ff", [], 1)]],
    ["a sold-out item", [line(ids.soldOut, [], 1)]],
    ["an unavailable option", [line(ids.grilled, [ids.white, ids.jalapeno], 1)]],
    ["an archived option", [line(ids.grilled, [ids.white, ids.archivedOpt], 1)]],
    ["a missing mandatory option", [line(ids.grilled, [ids.cheese], 1)]],
    ["too many options in a group", [line(ids.grilled, [ids.white, ids.brown], 1)]],
    ["too many extras", [line(ids.grilled, [ids.white, ids.cheese, ids.mayo, ids.jalapeno], 1)]],
    ["an option that does not belong to the item", [line(ids.cola, [ids.cheese], 1)]],
    ["a quantity over the cafe limit", [line(ids.cola, [], 11)]],
  ])("needs_attention for %s", async (_label, lines) => {
    const r = await saveCheckout(request({ lines }));
    expect(r.status).toBe("needs_attention");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses when the cafe has paused orders", async () => {
    loadMenuMock.mockResolvedValue({
      ok: true,
      catalog: catalog(),
      settings: { ...settings, ordersEnabled: false },
    });
    expect((await saveCheckout(request())).status).toBe("needs_attention");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([[{ status: "invalid" }], [{ status: "inactive", label: "Table 1" }]])(
    "returns a table problem for %j without saving",
    async (resolution) => {
      resolve.mockResolvedValue(resolution);
      expect((await saveCheckout(request())).status).toBe("table_problem");
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([{ status: "rate_limited" }, { status: "unavailable" }])(
    "returns an error when the table lookup is %j",
    async (resolution) => {
      resolve.mockResolvedValue(resolution);
      expect((await saveCheckout(request())).status).toBe("error");
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the menu cannot be loaded", async () => {
    loadMenuMock.mockResolvedValue({ ok: false, message: "down" });
    expect((await saveCheckout(request())).status).toBe("error");
    expect(create).not.toHaveBeenCalled();
  });

  it("is rate limited under its own route and fails closed if the limiter is down", async () => {
    hit.mockResolvedValueOnce("limited");
    expect((await saveCheckout(request())).status).toBe("busy");
    hit.mockResolvedValueOnce("unavailable");
    expect((await saveCheckout(request())).status).toBe("error");
    expect(hit).toHaveBeenCalledWith("checkout-save", expect.any(Number), expect.any(Number));
    expect(create).not.toHaveBeenCalled();
  });
});

describe("saveCheckout: database outcomes", () => {
  it("maps a same-key-different-cart conflict to a safe message that reveals nothing", async () => {
    create.mockResolvedValue({ status: "conflict" });
    const r = await saveCheckout(request());
    expect(r.status).toBe("conflict");
    expect(JSON.stringify(r)).not.toMatch(/amount|snapshot|Grilled/i);
  });

  it("maps an inactive table found by the database to a table problem", async () => {
    create.mockResolvedValue({ status: "table_unavailable" });
    expect((await saveCheckout(request())).status).toBe("table_problem");
  });

  it("reports a database failure as an error that says nothing was charged", async () => {
    create.mockResolvedValue({ status: "error" });
    const r = await saveCheckout(request());
    expect(r).toMatchObject({ status: "error" });
    expect((r as { message: string }).message).toMatch(/haven't been charged/);
  });

  it("does not leak a thrown error's detail", async () => {
    create.mockResolvedValue({ status: "error" });
    expect(JSON.stringify(await saveCheckout(request()))).not.toMatch(/postgres|supabase|rpc/i);
  });
});

describe("loadSavedCheckout", () => {
  const input = { tableCode: "T01", submissionId: SUBMISSION };

  it("returns the saved checkout for the matching table", async () => {
    const r = await loadSavedCheckout(input);
    expect(r).toMatchObject({
      status: "saved",
      replay: true,
      stage: "saved",
      totalPaise: EXPECTED_TOTAL,
    });
    expect(read).toHaveBeenCalledWith(SUBMISSION);
    expect(hit).toHaveBeenCalledWith("checkout-lookup", expect.any(Number), expect.any(Number));
  });

  it("does not reveal a checkout from ANOTHER table (identical to unknown)", async () => {
    resolve.mockResolvedValue({
      status: "ok",
      table: { id: "10000000-0000-4000-8000-0000000000ee", code: "T02", label: "Table 2" },
    });
    expect(await loadSavedCheckout({ ...input, tableCode: "T02" })).toEqual({
      status: "not_found",
    });
  });

  it("answers not_found for an unknown id", async () => {
    read.mockResolvedValue({ status: "not_found" });
    expect(await loadSavedCheckout(input)).toEqual({ status: "not_found" });
  });

  it.each([{ submissionId: "guess" }, { submissionId: undefined }, { tableCode: undefined }])(
    "rejects malformed input %j without reading",
    async (over) => {
      expect((await loadSavedCheckout({ ...input, ...over })).status).toBe("invalid_input");
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("fails safe when limited, when the table is gone, or when the read fails", async () => {
    hit.mockResolvedValueOnce("limited");
    expect((await loadSavedCheckout(input)).status).toBe("busy");
    resolve.mockResolvedValueOnce({ status: "inactive", label: "Table 1" });
    expect((await loadSavedCheckout(input)).status).toBe("table_problem");
    read.mockResolvedValueOnce({ status: "error" });
    expect((await loadSavedCheckout(input)).status).toBe("error");
  });

  it("shows a PAID attempt as payment verified but not as an order", async () => {
    read.mockResolvedValue({ status: "found", attempt: storedAttempt({ status: "PAID" }) });
    expect(await loadSavedCheckout(input)).toMatchObject({ stage: "payment_verified" });
  });

  it("shows an order only when one really exists", async () => {
    read.mockResolvedValue({
      status: "found",
      attempt: storedAttempt({ status: "PAID", orderCreated: true }),
    });
    expect(await loadSavedCheckout(input)).toMatchObject({ stage: "order_created" });
  });
});

describe("checkout helpers", () => {
  it("builds a short reference from the submission id only", () => {
    expect(checkoutReference(SUBMISSION)).toBe("CK-99999999");
  });

  it("derives the stage: saved, expired, failed, paid, ordered", () => {
    const base = { orderCreated: false, expiresAt: "2026-11-05T10:30:00.000Z" };
    const before = Date.parse("2026-11-05T10:00:00.000Z");
    const after = Date.parse("2026-11-05T11:00:00.000Z");
    expect(checkoutStage({ ...base, status: "PENDING", now: before })).toBe("saved");
    expect(checkoutStage({ ...base, status: "PENDING", now: after })).toBe("closed");
    expect(checkoutStage({ ...base, status: "FAILED", now: before })).toBe("closed");
    expect(checkoutStage({ ...base, status: "PAID", now: before })).toBe("payment_verified");
    expect(checkoutStage({ ...base, status: "PAID", orderCreated: true, now: after })).toBe(
      "order_created",
    );
  });

  it("summarises a saved snapshot in integer paise", () => {
    const snapshot = storedAttempt().snapshot as SnapshotLike;
    const lines = summariseSnapshot(snapshot);
    expect(lines.map((l) => [l.name, l.quantity, l.eachPaise, l.totalPaise])).toEqual([
      ["Grilled Sandwich", 2, 17400, 34800],
      ["Cola", 1, 4000, 4000],
    ]);
    expect(lines[0]!.options).toEqual(["Extra cheese"]);
  });
});
