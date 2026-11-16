import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import {
  anonClient,
  createUser,
  createWorld,
  eventually,
  newRunTag,
  serviceClient,
  testEnv,
  Tracker,
  type TestUser,
  type World,
} from "./harness";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Realtime: the `orders` table is in the supabase_realtime publication, and a change to an order
 * reaches a signed-in staff browser, but not an anonymous or non-staff one (RLS applies to
 * Realtime). Realtime is asynchronous, so delivery tests use generous timeouts, wait for the
 * channel to be SUBSCRIBED, use a control subscriber, and retry once on a fresh order.
 */

const tag = newRunTag();
const tracker = new Tracker();
const service = serviceClient();
let counter: TestUser;
let plain: TestUser;
let world: World;

beforeAll(async () => {
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

describe("supabase_realtime publication", () => {
  const dbUrl = testEnv().dbUrl;

  it.skipIf(!dbUrl)(
    "includes public.orders and nothing else from public (needs SUPABASE_DB_URL)",
    async () => {
      const db = new Client({ connectionString: dbUrl });
      await db.connect();
      try {
        const publication = await db.query(
          "select puballtables from pg_publication where pubname = 'supabase_realtime'",
        );
        expect(
          publication.rows,
          "the supabase_realtime publication must exist on Supabase",
        ).toHaveLength(1);
        expect(
          publication.rows[0].puballtables,
          "must not be FOR ALL TABLES (it would leak every table)",
        ).toBe(false);

        const tables = await db.query(
          "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1",
        );
        expect(tables.rows.map((r) => r.tablename)).toEqual(["orders"]);
      } finally {
        await db.end();
      }
    },
  );
});

interface Listener {
  events: { eventType: string; new: Record<string, unknown> }[];
  /** Resolves with the channel status once it settles; rejects only on timeout. */
  ready: Promise<string>;
  stop: () => Promise<void>;
}

/** Subscribes `client` to UPDATEs of one order. */
function listen(client: SupabaseClient, orderId: string, accessToken?: string): Listener {
  const events: Listener["events"] = [];
  const channel = client.channel(`it-${tag}-${orderId}-${Math.random().toString(36).slice(2, 8)}`);
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Realtime channel did not settle within 20s")),
      20_000,
    );
    void (async () => {
      if (accessToken) await client.realtime.setAuth(accessToken);
      channel
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "orders", filter: `id=eq.${orderId}` },
          (payload) => {
            events.push({
              eventType: payload.eventType,
              new: payload.new as Record<string, unknown>,
            });
          },
        )
        .subscribe((status) => {
          if (
            status === "SUBSCRIBED" ||
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            clearTimeout(timer);
            resolve(status);
          }
        });
    })();
  });
  return { events, ready, stop: async () => void (await client.removeChannel(channel)) };
}

const SETTLE_MS = 2_000; // postgres_changes becomes active shortly after SUBSCRIBED

describe("Realtime delivery of order changes", () => {
  it("delivers an order status change to a signed-in counter browser", { retry: 1 }, async () => {
    const order = await world.makeOrder();
    const staff = listen(counter.client, order.orderId, counter.accessToken);
    try {
      expect(await staff.ready, "counter channel must subscribe").toBe("SUBSCRIBED");
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      // The change comes from elsewhere (the backend), exactly like a payment arriving.
      const update = await service
        .from("orders")
        .update({ status: "ACCEPTED" })
        .eq("id", order.orderId)
        .select("status");
      expect(update.error?.message).toBeUndefined();

      const event = await eventually(async () => staff.events[0], {
        timeoutMs: 20_000,
        what: "the UPDATE event for the counter",
      });
      expect(event.eventType).toBe("UPDATE");
      expect(event.new).toMatchObject({
        id: order.orderId,
        status: "ACCEPTED",
        payment_status: "PAID",
      });
    } finally {
      await staff.stop();
    }
  });

  it(
    "does not deliver the change to an anonymous browser or a non-staff signed-in user",
    { retry: 1 },
    async () => {
      const order = await world.makeOrder();
      const anonBrowser = anonClient();
      const control = listen(counter.client, order.orderId, counter.accessToken);
      const anon = listen(anonBrowser, order.orderId);
      const outsider = listen(plain.client, order.orderId, plain.accessToken);
      try {
        expect(await control.ready, "control (counter) must subscribe").toBe("SUBSCRIBED");
        // anon / outsider may be refused at subscribe time (CHANNEL_ERROR) or subscribe and see nothing.
        await Promise.allSettled([anon.ready, outsider.ready]);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

        must(
          await service
            .from("orders")
            .update({ status: "ACCEPTED" })
            .eq("id", order.orderId)
            .select("status"),
        );

        // The control proves delivery works in this very run, which makes the absence below meaningful.
        await eventually(async () => control.events[0], {
          timeoutMs: 20_000,
          what: "the control event",
        });
        await new Promise((resolve) => setTimeout(resolve, 4_000));

        expect(anon.events, "an anonymous browser must never receive order data").toEqual([]);
        expect(outsider.events, "a signed-in non-staff user must never receive order data").toEqual(
          [],
        );
      } finally {
        await Promise.all([control.stop(), anon.stop(), outsider.stop()]);
      }
    },
  );
});

function must<T extends { error: { message?: string } | null }>(result: T): T {
  expect(result.error?.message).toBeUndefined();
  return result;
}
