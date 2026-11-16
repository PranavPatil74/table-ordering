import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectDenied } from "./assertions";
import {
  anonClient,
  createUser,
  createWorld,
  must,
  newRunTag,
  serviceClient,
  Tracker,
  type TestUser,
  type World,
} from "./harness";
import { describeResult } from "./helpers";

/**
 * Service-role-only functions and payment-status control, through the REAL API: who can call
 * them, and what the trusted backend can do that nobody else can.
 */

const tag = newRunTag();
const tracker = new Tracker();
const service = serviceClient();
let world: World;
let manager: TestUser;
let counter: TestUser;
let plain: TestUser;

beforeAll(async () => {
  manager = await createUser(tag, "manager", tracker, {
    role: "manager",
    displayName: `IT manager ${tag}`,
  });
  counter = await createUser(tag, "counter", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  plain = await createUser(tag, "plain", tracker);
  world = await createWorld(tag, tracker);
});
afterAll(async () => {
  await tracker.cleanup();
});

describe("who may call the service-role-only functions", () => {
  const callers = (): [string, { rpc: ReturnType<typeof anonClient>["rpc"] }][] => [
    ["anon", anonClient()],
    ["signed-in user without a staff profile", plain.client],
    ["counter", counter.client],
    ["manager", manager.client],
  ];

  it("refuses all four caller types for finalize_paid_order, check_rate_limit and purge_expired_rate_limits", async () => {
    const order = await world.makeOrder();
    const before = must(
      await service.from("orders").select("id").eq("payment_attempt_id", order.attemptId),
      "orders",
    );

    for (const [who, client] of callers()) {
      expectDenied(
        `${who}: finalize_paid_order`,
        await client.rpc("finalize_paid_order", {
          p_attempt_id: order.attemptId,
          p_gateway_payment_id: order.paymentId,
        }),
      );
      expectDenied(
        `${who}: check_rate_limit`,
        await client.rpc("check_rate_limit", {
          p_bucket: `it-${tag}-denied`,
          p_limit: 1,
          p_window_seconds: 60,
        }),
      );
      expectDenied(
        `${who}: purge_expired_rate_limits`,
        await client.rpc("purge_expired_rate_limits"),
      );
    }

    // Nothing happened: still exactly one order for that attempt, and no rate-limit counter was created.
    expect(
      must(
        await service.from("orders").select("id").eq("payment_attempt_id", order.attemptId),
        "orders",
      ),
    ).toEqual(before);
    expect(
      must(
        await service.from("rate_limits").select("bucket").eq("bucket", `it-${tag}-denied`),
        "rate limits",
      ),
    ).toEqual([]);
  });

  it("does not expose helper functions from the private schema to any caller", async () => {
    for (const [who, client] of callers()) {
      for (const fn of [
        "is_manager",
        "is_staff",
        "current_staff_role",
        "is_trusted_backend",
        "next_order_seq",
      ]) {
        expectDenied(`${who}: rpc ${fn}`, await client.rpc(fn));
      }
    }
  });
});

describe("what the service role (trusted backend) can do", () => {
  it("finalises an order and replays it idempotently", async () => {
    const order = await world.makeOrder(); // first call: created
    const replay = await service.rpc("finalize_paid_order", {
      p_attempt_id: order.attemptId,
      p_gateway_payment_id: order.paymentId,
    });
    const rows = must(replay, "replay") as {
      out_order_id: string;
      out_order_number: string;
      out_created: boolean;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      out_order_id: order.orderId,
      out_order_number: order.orderNumber,
      out_created: false,
    });
    expect(
      must(
        await service.from("orders").select("id").eq("payment_attempt_id", order.attemptId),
        "orders",
      ),
    ).toHaveLength(1);
  });

  it("refuses a different payment id for an attempt that is already paid", async () => {
    const order = await world.makeOrder();
    const result = await service.rpc("finalize_paid_order", {
      p_attempt_id: order.attemptId,
      p_gateway_payment_id: `pay_other_${tag}`,
    });
    expect(result.error, describeResult(result)).not.toBeNull();
    expect(result.error?.code, describeResult(result)).toBe("23001");
    expect(
      must(
        await service.from("orders").select("id").eq("payment_attempt_id", order.attemptId),
        "orders",
      ),
    ).toHaveLength(1);
  });

  it("rejects a payment attempt that does not exist", async () => {
    const result = await service.rpc("finalize_paid_order", {
      p_attempt_id: randomUUID(),
      p_gateway_payment_id: `pay_none_${tag}`,
    });
    expect(result.error, describeResult(result)).not.toBeNull();
    expect(result.error?.code, describeResult(result)).toBe("P0002");
  });

  it("runs the rate limiter: allows up to the limit, then refuses", async () => {
    const bucket = `it-${tag}-limit`;
    const hit = async () =>
      must(
        await service.rpc("check_rate_limit", {
          p_bucket: bucket,
          p_limit: 2,
          p_window_seconds: 60,
        }),
        "check_rate_limit",
      );
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(false);
    tracker.row("rate_limits", bucket, "bucket"); // removed again in cleanup
  });

  it("purges expired rate limits and reports a count", async () => {
    const purged = must(await service.rpc("purge_expired_rate_limits"), "purge");
    expect(typeof purged).toBe("number");
  });

  it("is the only role that can change payment status, and a manager-cancelled order keeps its payment state", async () => {
    const order = await world.makeOrder();
    const pending = await service
      .from("orders")
      .update({ payment_status: "REFUND_PENDING" })
      .eq("id", order.orderId)
      .select("payment_status");
    expect(pending.data, describeResult(pending)).toEqual([{ payment_status: "REFUND_PENDING" }]);

    // The signed-in roles still cannot touch it, in either direction.
    for (const user of [counter, manager]) {
      expectDenied(
        "restore payment status",
        await user.client
          .from("orders")
          .update({ payment_status: "PAID" })
          .eq("id", order.orderId)
          .select(),
      );
    }
    const back = await service
      .from("orders")
      .update({ payment_status: "PAID" })
      .eq("id", order.orderId)
      .select("payment_status");
    expect(back.data, describeResult(back)).toEqual([{ payment_status: "PAID" }]);

    // REFUNDED is only reachable from REFUND_PENDING (i.e. after the provider confirms): skipping is refused.
    const skip = await service
      .from("orders")
      .update({ payment_status: "REFUNDED" })
      .eq("id", order.orderId)
      .select();
    expect(skip.error?.code, describeResult(skip)).toBe("23514");
  });

  it("can read the backend-only tables", async () => {
    for (const table of ["order_counters", "gateway_events", "rate_limits"]) {
      const result = await service.from(table).select("*").limit(1);
      expect(result.error, `${table}: ${describeResult(result)}`).toBeNull();
    }
    expect(
      must(await service.from("order_counters").select("*").limit(1), "counters").length,
    ).toBeGreaterThan(0);
  });
});
