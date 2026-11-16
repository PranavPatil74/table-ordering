import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectNoRows } from "./assertions";
import {
  anonClient,
  claimsOf,
  createUser,
  createWorld,
  must,
  newRunTag,
  serviceClient,
  testEnv,
  Tracker,
  type TestUser,
  type World,
} from "./harness";
import { describeResult, generateTestPassword } from "./helpers";

/**
 * Supabase Auth identity -> staff profile -> role checks, against the real GoTrue and PostgREST.
 * (The plain-PostgreSQL tests can only inject JWT claims by hand; this proves real tokens work.)
 */

const tag = newRunTag();
const tracker = new Tracker();
let manager: TestUser;
let counter: TestUser;
let plain: TestUser;
let world: World;

beforeAll(async () => {
  manager = await createUser(tag, "manager", tracker, {
    role: "manager",
    displayName: `IT manager ${tag}`,
  });
  counter = await createUser(tag, "counter", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  plain = await createUser(tag, "plain", tracker); // signed in, but no staff profile
  world = await createWorld(tag, tracker);
});
afterAll(async () => {
  await tracker.cleanup();
});

describe("Auth users and sessions", () => {
  it("creates users with the admin API and issues real JWTs for them", () => {
    for (const user of [manager, counter, plain]) {
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
      const claims = claimsOf(user);
      expect(claims.sub).toBe(user.id);
      expect(claims.role).toBe("authenticated");
      expect(claims.aud).toBe("authenticated");
      expect(claims.exp as number).toBeGreaterThan(Date.now() / 1000);
    }
  });

  it("lets the Auth server confirm who a token belongs to", async () => {
    const result = await counter.client.auth.getUser(counter.accessToken);
    expect(result.error, result.error?.message).toBeNull();
    expect(result.data.user?.id).toBe(counter.id);
    expect(result.data.user?.email).toBe(counter.email);
  });

  it("rejects a forged token and a token with a tampered signature at the API", async () => {
    const [header, payload, signature] = counter.accessToken.split(".") as [string, string, string];
    const flipped = signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
    for (const token of ["garbage", `${header}.${payload}.${flipped}`]) {
      const response = await fetch(`${testEnv().url}/rest/v1/orders?select=id`, {
        headers: { apikey: testEnv().anonKey, Authorization: `Bearer ${token}` },
      });
      expect(response.status, "a bad token must be a 401, never data").toBe(401);
    }
  });

  it("has public sign-up disabled (staff are created by an administrator)", async () => {
    const email = `it-${tag}-signup@example.com`;
    const password = generateTestPassword();
    const signUp = await anonClient().auth.signUp({ email, password });
    expect(signUp.error, "sign-up must be refused").not.toBeNull();
    expect(signUp.data.session).toBeNull();
    const signIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signIn.error, "no account may have been created").not.toBeNull();
  });
});

describe("Auth user id -> staff profile", () => {
  it("maps each staff user to exactly their own profile and role", async () => {
    const mine = await manager.client
      .from("staff_profiles")
      .select("user_id, display_name, role, is_active")
      .eq("user_id", manager.id);
    expect(mine.data, describeResult(mine)).toEqual([
      { user_id: manager.id, display_name: `IT manager ${tag}`, role: "manager", is_active: true },
    ]);

    const theirs = await counter.client.from("staff_profiles").select("user_id, role");
    expect(theirs.data, describeResult(theirs)).toEqual([{ user_id: counter.id, role: "counter" }]);
  });

  it("lets a manager see every profile, and a counter user see only their own", async () => {
    const all = must(
      await manager.client.from("staff_profiles").select("user_id"),
      "manager reads profiles",
    );
    const ids = all.map((row) => row.user_id as string);
    expect(ids).toEqual(expect.arrayContaining([manager.id, counter.id]));
    expect(ids).not.toContain(plain.id); // has no profile

    const own = must(
      await counter.client.from("staff_profiles").select("user_id"),
      "counter reads profiles",
    );
    expect(own).toHaveLength(1);
  });

  it("gives a signed-in user with no staff profile no staff data", async () => {
    const order = await world.makeOrder();
    expectNoRows("profiles", await plain.client.from("staff_profiles").select("user_id"));
    expectNoRows("orders", await plain.client.from("orders").select("id").eq("id", order.orderId));
    expectNoRows(
      "order events",
      await plain.client.from("order_events").select("id").eq("order_id", order.orderId),
    );
    expectNoRows(
      "tables",
      await plain.client.from("cafe_tables").select("id").eq("id", world.table.id),
    );
    // ...while the public menu is still readable.
    const menu = must(
      await plain.client.from("menu_items").select("slug").eq("slug", `it-${tag}-sandwich`),
      "menu",
    );
    expect(menu).toHaveLength(1);
  });

  it("reads the role from the database on every request, not from the token", async () => {
    // Same token before and after: the role comes from staff_profiles, so a demotion or
    // deactivation takes effect immediately, without waiting for the token to expire.
    const service = serviceClient();
    const order = await world.makeOrder();
    const readOrder = () => counter.client.from("orders").select("id").eq("id", order.orderId);

    expect(must(await readOrder(), "counter reads order")).toHaveLength(1);

    must(
      await service
        .from("staff_profiles")
        .update({ is_active: false })
        .eq("user_id", counter.id)
        .select(),
      "deactivate",
    );
    expectNoRows("deactivated counter reads orders", await readOrder());

    must(
      await service
        .from("staff_profiles")
        .update({ is_active: true })
        .eq("user_id", counter.id)
        .select(),
      "reactivate",
    );
    expect(must(await readOrder(), "reactivated counter reads order")).toHaveLength(1);

    must(
      await service
        .from("staff_profiles")
        .update({ role: "manager" })
        .eq("user_id", counter.id)
        .select(),
      "promote",
    );
    const seesEveryone = must(
      await counter.client.from("staff_profiles").select("user_id"),
      "promoted reads profiles",
    );
    expect(seesEveryone.length).toBeGreaterThanOrEqual(2);
    must(
      await service
        .from("staff_profiles")
        .update({ role: "counter" })
        .eq("user_id", counter.id)
        .select(),
      "demote",
    );
    expect(
      must(await counter.client.from("staff_profiles").select("user_id"), "demoted reads profiles"),
    ).toHaveLength(1);
  });

  it("requires a profile to belong to a real Auth user (foreign key to auth.users)", async () => {
    const result = await serviceClient()
      .from("staff_profiles")
      .insert({ user_id: randomUUID(), display_name: "Ghost", role: "counter" });
    expect(result.error?.code, describeResult(result)).toBe("23503");
  });

  it("removes the staff profile when its Auth user is deleted", async () => {
    const service = serviceClient();
    const temp = await createUser(tag, "temp", tracker, {
      role: "counter",
      displayName: `IT temp ${tag}`,
    });
    const before = must(
      await service.from("staff_profiles").select("user_id").eq("user_id", temp.id),
      "profile exists",
    );
    expect(before).toHaveLength(1);

    const deleted = await service.auth.admin.deleteUser(temp.id);
    expect(deleted.error?.message).toBeUndefined();
    const after = must(
      await service.from("staff_profiles").select("user_id").eq("user_id", temp.id),
      "profile gone",
    );
    expect(after).toEqual([]);
  });
});
