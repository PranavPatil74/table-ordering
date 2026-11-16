import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeStaff,
  fetchOwnProfile,
  loadStaffAccess,
  meetsRole,
  resolveStaffAccess,
  type StaffAccess,
} from "./staff";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const row = (over: Record<string, unknown> = {}) => ({
  user_id: USER,
  display_name: "Casey",
  role: "counter",
  is_active: true,
  ...over,
});

describe("resolveStaffAccess", () => {
  it("authorises an active counter and an active manager, with the role from the row", () => {
    expect(resolveStaffAccess({ userId: USER, profile: { ok: true, row: row() } })).toEqual({
      status: "authorized",
      staff: { userId: USER, displayName: "Casey", role: "counter" },
    });
    expect(
      resolveStaffAccess({ userId: USER, profile: { ok: true, row: row({ role: "manager" }) } }),
    ).toMatchObject({ status: "authorized", staff: { role: "manager" } });
  });

  it("treats a missing session as unauthenticated, whatever the profile lookup says", () => {
    expect(resolveStaffAccess({ userId: null, profile: { ok: true, row: row() } })).toEqual({
      status: "unauthenticated",
    });
  });

  it("denies a signed-in user with no profile", () => {
    expect(resolveStaffAccess({ userId: USER, profile: { ok: true, row: null } })).toEqual({
      status: "denied",
      reason: "no_profile",
    });
  });

  it("denies an inactive profile, even a manager's", () => {
    for (const role of ["counter", "manager"]) {
      expect(
        resolveStaffAccess({
          userId: USER,
          profile: { ok: true, row: row({ role, is_active: false }) },
        }),
      ).toEqual({ status: "denied", reason: "inactive" });
    }
  });

  it("denies any role that is not counter or manager, and malformed rows", () => {
    for (const bad of ["owner", "admin", "Manager", "", null, 7]) {
      expect(
        resolveStaffAccess({ userId: USER, profile: { ok: true, row: row({ role: bad }) } }),
      ).toMatchObject({ status: "denied" });
    }
    for (const malformed of [{}, { role: "manager" }, row({ is_active: "true" }), "manager", 5]) {
      expect(
        resolveStaffAccess({ userId: USER, profile: { ok: true, row: malformed } }),
      ).toMatchObject({ status: "denied" });
    }
  });

  it("refuses a row that belongs to somebody else (managers can read every profile)", () => {
    expect(
      resolveStaffAccess({
        userId: USER,
        profile: { ok: true, row: row({ user_id: OTHER, role: "manager" }) },
      }),
    ).toEqual({ status: "denied", reason: "no_profile" });
  });

  it("fails closed when the profile could not be read", () => {
    expect(resolveStaffAccess({ userId: USER, profile: { ok: false } })).toEqual({
      status: "unavailable",
    });
  });
});

describe("role boundaries", () => {
  const counter: StaffAccess = {
    status: "authorized",
    staff: { userId: USER, displayName: "C", role: "counter" },
  };
  const manager: StaffAccess = {
    status: "authorized",
    staff: { userId: USER, displayName: "M", role: "manager" },
  };

  it("a manager meets both requirements; a counter meets only the counter one", () => {
    expect(meetsRole("manager", "counter")).toBe(true);
    expect(meetsRole("manager", "manager")).toBe(true);
    expect(meetsRole("counter", "counter")).toBe(true);
    expect(meetsRole("counter", "manager")).toBe(false);
  });

  it("authorizeStaff defaults to counter and rejects a counter for manager-only work", () => {
    expect(authorizeStaff(counter).status).toBe("authorized");
    expect(authorizeStaff(counter, "manager")).toMatchObject({
      status: "denied",
      reason: "insufficient_role",
    });
    expect(authorizeStaff(manager, "manager").status).toBe("authorized");
  });

  it("passes non-authorised outcomes through untouched", () => {
    for (const access of [
      { status: "unauthenticated" },
      { status: "unavailable" },
      { status: "denied", reason: "inactive" },
    ] as const) {
      expect(authorizeStaff(access, "manager")).toEqual(access);
    }
  });
});

/** A fake Supabase client that records the profile query and returns canned answers. */
function fakeClient(opts: {
  user?: { id: string } | null;
  userError?: unknown;
  profile?: { data: unknown; error: unknown };
}) {
  const calls = { select: [] as string[], eq: [] as [string, string][], table: [] as string[] };
  const builder = {
    select: (columns: string) => {
      calls.select.push(columns);
      return builder;
    },
    eq: (column: string, value: string) => {
      calls.eq.push([column, value]);
      return builder;
    },
    maybeSingle: async () => opts.profile ?? { data: null, error: null },
  };
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: opts.user ?? null },
        error: opts.userError ?? null,
      }),
    },
    from: (table: string) => {
      calls.table.push(table);
      return builder;
    },
  };
  return { client: client as never, calls };
}

describe("fetchOwnProfile", () => {
  it("reads only the four profile columns for the caller's own id", async () => {
    const { client, calls } = fakeClient({ profile: { data: row(), error: null } });
    await fetchOwnProfile(client, USER);
    expect(calls.table).toEqual(["staff_profiles"]);
    expect(calls.select).toEqual(["user_id, display_name, role, is_active"]);
    expect(calls.eq).toEqual([["user_id", USER]]);
  });

  it("reports a database error as 'could not read', never as 'no profile'", async () => {
    const { client } = fakeClient({ profile: { data: null, error: { code: "XX000" } } });
    expect(await fetchOwnProfile(client, USER)).toEqual({ ok: false });
  });
});

describe("loadStaffAccess", () => {
  it("authorises a valid session with an active profile", async () => {
    const { client } = fakeClient({ user: { id: USER }, profile: { data: row(), error: null } });
    expect(await loadStaffAccess(client)).toMatchObject({
      status: "authorized",
      staff: { role: "counter" },
    });
  });

  it("no session at all: unauthenticated, and the profile table is never touched", async () => {
    const { client, calls } = fakeClient({ userError: new AuthSessionMissingError() });
    expect(await loadStaffAccess(client)).toEqual({ status: "unauthenticated" });
    expect(calls.table).toEqual([]);
  });

  it("a rejected token (revoked, tampered, deleted user) is unauthenticated", async () => {
    const error = new AuthApiError("invalid JWT", 401, "bad_jwt");
    const { client } = fakeClient({ userError: error });
    expect(await loadStaffAccess(client)).toEqual({ status: "unauthenticated" });
  });

  it("an unreachable Auth server is 'unavailable', not 'signed out'", async () => {
    const { client } = fakeClient({ userError: new AuthRetryableFetchError("down", 503) });
    expect(await loadStaffAccess(client)).toEqual({ status: "unavailable" });
  });

  it("a valid user with no profile is denied; an unreadable profile fails closed", async () => {
    const none = fakeClient({ user: { id: USER }, profile: { data: null, error: null } });
    expect(await loadStaffAccess(none.client)).toEqual({ status: "denied", reason: "no_profile" });

    const broken = fakeClient({
      user: { id: USER },
      profile: { data: null, error: { code: "x" } },
    });
    expect(await loadStaffAccess(broken.client)).toEqual({ status: "unavailable" });
  });

  it("never consults user metadata: a user claiming to be a manager still needs a profile", async () => {
    const user = {
      id: USER,
      user_metadata: { role: "manager" },
      app_metadata: { role: "manager" },
    };
    const { client } = fakeClient({ user, profile: { data: null, error: null } });
    expect(await loadStaffAccess(client)).toEqual({ status: "denied", reason: "no_profile" });

    const asCounter = fakeClient({
      user,
      profile: { data: row({ role: "counter" }), error: null },
    });
    expect(await loadStaffAccess(asCounter.client)).toMatchObject({
      status: "authorized",
      staff: { role: "counter" },
    });
  });

  it("does not call the database when the session check throws nothing useful", async () => {
    const spy = vi.fn();
    const { client } = fakeClient({ userError: new AuthSessionMissingError() });
    (client as { from: unknown }).from = spy;
    await loadStaffAccess(client);
    expect(spy).not.toHaveBeenCalled();
  });
});
