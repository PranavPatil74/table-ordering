import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSnapshot, itemLine, type CartSnapshot } from "@/test/snapshot";

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
import { toByteaHex } from "./helpers";

/**
 * Phase 5 through the REAL local Supabase API (PostgREST + GRANTs + RLS): saving a checkout is a
 * service-role operation that is atomic and idempotent, and nobody else can call it or read the
 * attempts. Needs the local stack (`pnpm db:start`); see docs/testing.md. These attempts are
 * history rows and are never deleted: the harness archives the world's table and items instead.
 */

const tag = newRunTag();
const tracker = new Tracker();
const service = serviceClient();
let world: World;
let counter: TestUser;

beforeAll(async () => {
  counter = await createUser(tag, "counter", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  world = await createWorld(tag, tracker);
});
afterAll(async () => {
  await tracker.cleanup();
});

const cart = (qty = 1): CartSnapshot =>
  buildSnapshot(world.table, [itemLine(world.menu, "item", qty)]);

const args = (key: string, snapshot: CartSnapshot) => ({
  p_idempotency_key: key,
  p_table_id: world.table.id,
  p_amount_paise: snapshot.total_paise,
  p_cart_snapshot: snapshot,
  p_tracking_token_hash: toByteaHex(randomBytes(32)),
});

type Row = { out_outcome: string; out_status: string | null; out_amount_paise: number | null };
const create = async (key: string, snapshot: CartSnapshot) =>
  (must(await service.rpc("create_checkout_attempt", args(key, snapshot)), "create") as Row[])[0]!;

const attemptRows = async (key: string) =>
  must(
    await service.from("payment_attempts").select("id, status").eq("idempotency_key", key),
    "attempts",
  ) as { id: string; status: string }[];

describe("create_checkout_attempt over the real API", () => {
  it("creates one PENDING attempt, then returns it again for the same key", async () => {
    const key = randomUUID();
    const snapshot = cart(2);
    const first = await create(key, snapshot);
    expect(first).toMatchObject({
      out_outcome: "created",
      out_status: "PENDING",
      out_amount_paise: snapshot.total_paise,
    });
    expect((await create(key, snapshot)).out_outcome).toBe("existing");
    expect(await attemptRows(key)).toHaveLength(1);
  });

  it("20 simultaneous identical submissions produce exactly one attempt", async () => {
    const key = randomUUID();
    const snapshot = cart(3);
    const results = await Promise.all(Array.from({ length: 20 }, () => create(key, snapshot)));
    expect(results.filter((r) => r.out_outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.out_outcome === "existing")).toHaveLength(19);
    expect(await attemptRows(key)).toHaveLength(1);
  });

  it("rejects the same key with a different cart and leaves the first untouched", async () => {
    const key = randomUUID();
    await create(key, cart(1));
    expect((await create(key, cart(2))).out_outcome).toBe("conflict");
    const stored = must(
      await service.from("payment_attempts").select("amount_paise").eq("idempotency_key", key),
      "stored",
    ) as { amount_paise: number }[];
    expect(stored).toEqual([{ amount_paise: cart(1).total_paise }]);
  });

  it("rejects a snapshot whose total is not the amount and stores nothing", async () => {
    const key = randomUUID();
    const snapshot = cart(1);
    const result = await service.rpc("create_checkout_attempt", {
      ...args(key, snapshot),
      p_amount_paise: snapshot.total_paise + 100,
    });
    expect(result.error).not.toBeNull();
    expect(await attemptRows(key)).toHaveLength(0);
  });

  it("never creates an order", async () => {
    const key = randomUUID();
    await create(key, cart(1));
    const [row] = await attemptRows(key);
    const orders = must(
      await service.from("orders").select("id").eq("payment_attempt_id", row!.id),
      "orders",
    ) as unknown[];
    expect(orders).toHaveLength(0);
  });
});

describe("who may use the checkout functions and attempts", () => {
  it("anon and signed-in staff cannot call create_checkout_attempt or get_checkout_attempt", async () => {
    const snapshot = cart(1);
    for (const [who, client] of [
      ["anon", anonClient()],
      ["counter", counter.client],
    ] as const) {
      expectDenied(
        `${who}: create_checkout_attempt`,
        await client.rpc("create_checkout_attempt", args(randomUUID(), snapshot)),
      );
      expectDenied(
        `${who}: get_checkout_attempt`,
        await client.rpc("get_checkout_attempt", { p_idempotency_key: randomUUID() }),
      );
    }
  });

  it("anon cannot read, write or delete payment attempts", async () => {
    const anon = anonClient();
    expectDenied("anon select", await anon.from("payment_attempts").select("id"));
    expectDenied("anon insert", await anon.from("payment_attempts").insert({}));
    expectDenied("anon delete", await anon.from("payment_attempts").delete().not("id", "is", null));
  });

  it("staff cannot read another customer's snapshot or idempotency key", async () => {
    expectDenied(
      "counter select cart_snapshot",
      await counter.client.from("payment_attempts").select("cart_snapshot"),
    );
    expectDenied(
      "counter select idempotency_key",
      await counter.client.from("payment_attempts").select("idempotency_key"),
    );
  });
});
