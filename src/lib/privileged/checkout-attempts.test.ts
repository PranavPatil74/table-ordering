import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env/server", () => ({
  getServerEnv: () => ({ supabaseServiceRoleKey: "test-service-role-key-not-real" }),
}));

const rpc = vi.fn();
vi.mock("./service-client", () => ({ createServiceRoleClient: () => ({ rpc }) }));

import { deriveTrackingToken, hashTrackingToken } from "@/lib/security/tracking-token";

import { createCheckoutAttempt, readCheckoutAttempt } from "./checkout-attempts";

const SUBMISSION = "99999999-0000-4000-8000-000000000001";
const row = (over: Record<string, unknown> = {}) => ({
  out_outcome: "created",
  out_status: "PENDING",
  out_amount_paise: 4000,
  out_created_at: "2026-11-05T10:00:00+00:00",
  out_expires_at: "2026-11-05T10:30:00+00:00",
  out_order_created: false,
  out_cart_snapshot: {
    version: 1,
    table: { id: "t", code: "T01", label: "Table 1" },
    items: [{ item_name: "Cola", unit_price_paise: 4000, quantity: 1, options: [] }],
    total_paise: 4000,
  },
  ...over,
});
const input = { submissionId: SUBMISSION, tableId: "tid", amountPaise: 4000, snapshot: { v: 1 } };

beforeEach(() => rpc.mockReset());

describe("createCheckoutAttempt", () => {
  it("calls only create_checkout_attempt, with the submission id as the idempotency key", async () => {
    rpc.mockResolvedValue({ data: [row()], error: null });
    const result = await createCheckoutAttempt(input);
    expect(result).toMatchObject({
      status: "created",
      attempt: { status: "PENDING", amountPaise: 4000 },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("create_checkout_attempt");
    expect(args).toMatchObject({
      p_idempotency_key: SUBMISSION,
      p_table_id: "tid",
      p_amount_paise: 4000,
      p_cart_snapshot: { v: 1 },
    });
  });

  it("sends only the SHA-256 hash of the derived tracking token, never the token", async () => {
    rpc.mockResolvedValue({ data: [row()], error: null });
    await createCheckoutAttempt(input);
    const args = rpc.mock.calls[0]![1] as { p_tracking_token_hash: string };
    const token = deriveTrackingToken("test-service-role-key-not-real", SUBMISSION);
    const expected = `\\x${hashTrackingToken(token).toString("hex")}`;
    expect(args.p_tracking_token_hash).toBe(expected);
    expect(args.p_tracking_token_hash).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });

  it("maps every outcome and never throws", async () => {
    rpc.mockResolvedValueOnce({ data: [row({ out_outcome: "existing" })], error: null });
    expect(await createCheckoutAttempt(input)).toMatchObject({ status: "existing" });
    rpc.mockResolvedValueOnce({ data: [{ out_outcome: "conflict" }], error: null });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "conflict" });
    rpc.mockResolvedValueOnce({ data: [{ out_outcome: "table_unavailable" }], error: null });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "table_unavailable" });
    rpc.mockResolvedValueOnce({ data: [{ out_outcome: "mystery" }], error: null });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "error" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "error" });
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "error" });
    rpc.mockResolvedValueOnce({ data: [row({ out_status: "WEIRD" })], error: null });
    expect(await createCheckoutAttempt(input)).toEqual({ status: "error" });
    rpc.mockRejectedValueOnce(new Error("network"));
    expect(await createCheckoutAttempt(input)).toEqual({ status: "error" });
  });
});

describe("readCheckoutAttempt", () => {
  it("reads by idempotency key only", async () => {
    rpc.mockResolvedValue({ data: [row()], error: null });
    expect(await readCheckoutAttempt(SUBMISSION)).toMatchObject({ status: "found" });
    expect(rpc).toHaveBeenCalledWith("get_checkout_attempt", { p_idempotency_key: SUBMISSION });
  });
  it("distinguishes unknown from failure", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await readCheckoutAttempt(SUBMISSION)).toEqual({ status: "not_found" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    expect(await readCheckoutAttempt(SUBMISSION)).toEqual({ status: "error" });
    rpc.mockRejectedValueOnce(new Error("x"));
    expect(await readCheckoutAttempt(SUBMISSION)).toEqual({ status: "error" });
  });
});

describe("deriveTrackingToken", () => {
  it("is deterministic, well-formed, and depends on both the secret and the submission", () => {
    const a = deriveTrackingToken("secret-one", SUBMISSION);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(deriveTrackingToken("secret-one", SUBMISSION)).toBe(a);
    expect(deriveTrackingToken("secret-two", SUBMISSION)).not.toBe(a);
    expect(deriveTrackingToken("secret-one", "99999999-0000-4000-8000-000000000002")).not.toBe(a);
    expect(hashTrackingToken(a)).toHaveLength(32);
  });
  it("refuses an empty secret or submission", () => {
    expect(() => deriveTrackingToken("", SUBMISSION)).toThrow();
    expect(() => deriveTrackingToken("s", "")).toThrow();
  });
});
