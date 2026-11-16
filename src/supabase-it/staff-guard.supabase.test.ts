import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifySignInError, SIGN_IN_MESSAGES } from "@/lib/auth/login";
import { fetchOwnProfile, loadStaffAccess } from "@/lib/auth/staff";

import { anonClient, createUser, newRunTag, serviceClient, testEnv, Tracker } from "./harness";
import { decodeJwtPayload, generateTestPassword } from "./helpers";

/**
 * Phase 2: the app's server-side staff check, run against REAL Supabase Auth and PostgREST.
 *
 * `loadStaffAccess` and `fetchOwnProfile` are the exact functions the Next.js app calls for every
 * protected page, action and API route (src/lib/auth/staff.ts). Here they receive a signed-in
 * supabase-js client instead of the cookie-backed SSR client; what differs is only where the
 * session is stored, not the Auth call, the profile query or the decision.
 *
 * NOT covered here: the cookie layer and Next.js proxy/redirects (Playwright tests, which use a
 * test double of Supabase) and a real browser against a real stack (not automated).
 */

const tag = newRunTag();
const tracker = new Tracker();

let counter: Awaited<ReturnType<typeof createUser>>; // counter profile; metadata CLAIMS manager
let manager: Awaited<ReturnType<typeof createUser>>;
let inactive: Awaited<ReturnType<typeof createUser>>;
let noProfile: Awaited<ReturnType<typeof createUser>>; // no profile; metadata CLAIMS manager
let changing: Awaited<ReturnType<typeof createUser>>; // profile edited mid-test

/** Users may edit their own `user_metadata` in real Supabase, so it can claim anything. */
async function claimManagerInMetadata(userId: string) {
  const { error } = await serviceClient().auth.admin.updateUserById(userId, {
    user_metadata: { role: "manager" },
    app_metadata: { role: "manager" },
  });
  if (error) throw new Error(`could not set metadata: ${error.status}`);
}

/** A fresh sign-in, so the JWT carries the metadata that was just written. */
async function signInFresh(email: string, password: string) {
  const client = createClient(testEnv().url, testEnv().anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error, data } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed: ${error?.status}`);
  return { client, session: data.session };
}

const passwords = new Map<string, string>();

beforeAll(async () => {
  const service = serviceClient();
  const make = async (label: string, staff?: Parameters<typeof createUser>[3]) => {
    // createUser generates a random password and signs in; to set metadata first we create the
    // account ourselves and sign in afterwards.
    const email = `it-${tag}-${label}@example.com`;
    const password = generateTestPassword();
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error("createUser failed");
    const id = created.data.user.id;
    tracker.user(id);
    passwords.set(email, password);
    if (staff) {
      const profile = await service.from("staff_profiles").insert({
        user_id: id,
        display_name: staff.displayName,
        role: staff.role,
        is_active: staff.isActive ?? true,
      });
      if (profile.error) throw new Error(`profile insert failed: ${profile.error.code}`);
    }
    await claimManagerInMetadata(id);
    const { client, session } = await signInFresh(email, password);
    return { id, email, client, accessToken: session.access_token };
  };

  counter = await make("g-counter", { role: "counter", displayName: `IT guard counter ${tag}` });
  manager = await make("g-manager", { role: "manager", displayName: `IT guard manager ${tag}` });
  inactive = await make("g-inactive", {
    role: "counter",
    displayName: `IT guard inactive ${tag}`,
    isActive: false,
  });
  noProfile = await make("g-noprofile");
  changing = await make("g-changing", { role: "counter", displayName: `IT guard changing ${tag}` });
});

afterAll(async () => {
  await tracker.cleanup();
});

describe("the metadata claim in these tests is real", () => {
  it("the issued JWTs really say role=manager in user and app metadata, for users who are not", () => {
    for (const user of [counter, noProfile]) {
      const claims = decodeJwtPayload(user.accessToken);
      expect(claims?.user_metadata).toMatchObject({ role: "manager" });
      expect(claims?.app_metadata).toMatchObject({ role: "manager" });
    }
  });
});

describe("loadStaffAccess, against real Auth and PostgREST", () => {
  it("an active counter is a counter, whatever their metadata claims", async () => {
    expect(await loadStaffAccess(counter.client)).toEqual({
      status: "authorized",
      staff: { userId: counter.id, displayName: `IT guard counter ${tag}`, role: "counter" },
    });
  });

  it("an active manager is a manager", async () => {
    expect(await loadStaffAccess(manager.client)).toMatchObject({
      status: "authorized",
      staff: { userId: manager.id, role: "manager" },
    });
  });

  it("a signed-in user with NO profile is denied, even with manager metadata", async () => {
    expect(await loadStaffAccess(noProfile.client)).toEqual({
      status: "denied",
      reason: "no_profile",
    });
  });

  it("an inactive staff profile is denied as 'inactive' (Phase 1 lets staff read their own row)", async () => {
    expect(await loadStaffAccess(inactive.client)).toEqual({
      status: "denied",
      reason: "inactive",
    });
  });

  it("nobody signed in is unauthenticated", async () => {
    expect(await loadStaffAccess(anonClient())).toEqual({ status: "unauthenticated" });
  });

  it("a forged access token is unauthenticated, not an error", async () => {
    const forged = createClient(testEnv().url, testEnv().anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const parts = counter.accessToken.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`;
    await forged.auth.setSession({
      access_token: tampered,
      refresh_token: "not-a-real-refresh-token",
    });
    expect(await loadStaffAccess(forged)).toEqual({ status: "unauthenticated" });
  });
});

describe("fetchOwnProfile", () => {
  it("returns ONLY the caller's own row for a manager, who can read every profile under RLS", async () => {
    const everyone = await manager.client.from("staff_profiles").select("user_id");
    expect(everyone.error).toBeNull();
    expect(everyone.data!.length).toBeGreaterThan(1); // the unfiltered query is genuinely multi-row

    const own = await fetchOwnProfile(manager.client, manager.id);
    expect(own).toMatchObject({ ok: true, row: { user_id: manager.id, role: "manager" } });
  });

  it("returns nothing for another user's id when asked by a counter (RLS), never their row", async () => {
    const result = await fetchOwnProfile(counter.client, manager.id);
    expect(result).toEqual({ ok: true, row: null });
  });

  it("exposes only the four columns the guard needs", async () => {
    const result = await fetchOwnProfile(counter.client, counter.id);
    expect(result.ok && result.row && Object.keys(result.row as object).sort()).toEqual([
      "display_name",
      "is_active",
      "role",
      "user_id",
    ]);
  });
});

describe("database changes take effect on the very next request, with no re-login", () => {
  it("deactivating a signed-in counter locks them out; reactivating lets them back in", async () => {
    const service = serviceClient();
    expect(await loadStaffAccess(changing.client)).toMatchObject({ status: "authorized" });

    let update = await service
      .from("staff_profiles")
      .update({ is_active: false })
      .eq("user_id", changing.id);
    expect(update.error).toBeNull();
    expect(await loadStaffAccess(changing.client)).toEqual({
      status: "denied",
      reason: "inactive",
    });

    update = await service
      .from("staff_profiles")
      .update({ is_active: true })
      .eq("user_id", changing.id);
    expect(update.error).toBeNull();
    expect(await loadStaffAccess(changing.client)).toMatchObject({ status: "authorized" });
  });

  it("a role change is picked up immediately (counter -> manager -> counter)", async () => {
    const service = serviceClient();
    await service.from("staff_profiles").update({ role: "manager" }).eq("user_id", changing.id);
    expect(await loadStaffAccess(changing.client)).toMatchObject({
      status: "authorized",
      staff: { role: "manager" },
    });
    await service.from("staff_profiles").update({ role: "counter" }).eq("user_id", changing.id);
    expect(await loadStaffAccess(changing.client)).toMatchObject({
      status: "authorized",
      staff: { role: "counter" },
    });
  });

  it("deleting the profile removes access", async () => {
    const service = serviceClient();
    const removed = await service.from("staff_profiles").delete().eq("user_id", changing.id);
    expect(removed.error).toBeNull();
    expect(await loadStaffAccess(changing.client)).toEqual({
      status: "denied",
      reason: "no_profile",
    });
  });
});

describe("sessions", () => {
  it("a signed-out session's access token is no longer accepted (GoTrue rejects it with session_not_found)", async () => {
    const { client, session } = await signInFresh(manager.email, passwords.get(manager.email)!);
    expect(await loadStaffAccess(client)).toMatchObject({ status: "authorized" });

    const out = await client.auth.signOut({ scope: "local" });
    expect(out.error).toBeNull();

    // Replay the old tokens in a brand-new client, as a stolen cookie would be.
    const replay = createClient(testEnv().url, testEnv().anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await replay.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    expect(await loadStaffAccess(replay)).toEqual({ status: "unauthenticated" });
  });

  it("deleting the Auth user ends access and removes the profile (cascade)", async () => {
    const service = serviceClient();
    const email = `it-${tag}-g-deleted@example.com`;
    const password = generateTestPassword();
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const id = created.data.user!.id;
    tracker.user(id);
    await service
      .from("staff_profiles")
      .insert({ user_id: id, display_name: `IT guard deleted ${tag}`, role: "counter" });
    const { client } = await signInFresh(email, password);
    expect(await loadStaffAccess(client)).toMatchObject({ status: "authorized" });

    expect((await service.auth.admin.deleteUser(id)).error).toBeNull();
    expect(await loadStaffAccess(client)).toEqual({ status: "unauthenticated" });
  });
});

describe("sign-in errors from real GoTrue", () => {
  it("a wrong password and an unknown email give the same classification and the same message", async () => {
    const wrong = await anonClient().auth.signInWithPassword({
      email: counter.email,
      password: "definitely-not-the-password",
    });
    const unknown = await anonClient().auth.signInWithPassword({
      email: `it-${tag}-nobody@example.com`,
      password: "definitely-not-the-password",
    });
    expect(wrong.error).not.toBeNull();
    expect(unknown.error).not.toBeNull();

    expect(classifySignInError(wrong.error!)).toBe("invalid_credentials");
    expect(classifySignInError(unknown.error!)).toBe("invalid_credentials");
    // GoTrue itself must not distinguish the two cases (no account enumeration).
    expect(wrong.error!.code).toBe(unknown.error!.code);
    expect(wrong.error!.status).toBe(unknown.error!.status);
    expect(SIGN_IN_MESSAGES.invalid_credentials).toBeTruthy();
  });
});
