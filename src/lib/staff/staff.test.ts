import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  NO_FILTERS,
  activeManagerCount,
  deactivationBlock,
  filterStaff,
  isFiltered,
  sortStaff,
  type StaffRow,
} from "./directory";
import { loadStaffProfiles, setStaffActive } from "./repository";

const row = (over: Partial<StaffRow> & { userId: string }): StaffRow => ({
  displayName: "Person",
  email: null,
  role: "counter",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";

const rows = [
  row({ userId: A, displayName: "Asha Rao", email: "asha@cafe.test", role: "manager" }),
  row({ userId: B, displayName: "Bilal", email: "bilal@cafe.test" }),
  row({ userId: C, displayName: "Chitra", email: null, isActive: false }),
  row({
    userId: D,
    displayName: "Dev Manager",
    email: "dev@cafe.test",
    role: "manager",
    isActive: false,
  }),
];

describe("filterStaff", () => {
  it("returns everyone with no filters", () => {
    expect(filterStaff(rows, NO_FILTERS)).toHaveLength(4);
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });
  it("searches name and email case-insensitively", () => {
    expect(filterStaff(rows, { ...NO_FILTERS, query: "ASHA" }).map((r) => r.userId)).toEqual([A]);
    expect(filterStaff(rows, { ...NO_FILTERS, query: "bilal@" }).map((r) => r.userId)).toEqual([B]);
    expect(filterStaff(rows, { ...NO_FILTERS, query: "  nobody  " })).toEqual([]);
  });
  it("filters by role and status and combines them", () => {
    expect(filterStaff(rows, { ...NO_FILTERS, role: "manager" })).toHaveLength(2);
    expect(filterStaff(rows, { ...NO_FILTERS, status: "inactive" })).toHaveLength(2);
    expect(
      filterStaff(rows, { query: "", role: "manager", status: "active" }).map((r) => r.userId),
    ).toEqual([A]);
    expect(isFiltered({ ...NO_FILTERS, role: "counter" })).toBe(true);
  });
  it("does not match a missing email", () => {
    expect(filterStaff(rows, { ...NO_FILTERS, query: "null" })).toEqual([]);
  });
});

describe("sortStaff", () => {
  it("lists active managers, active counter, then inactive", () => {
    expect(sortStaff(rows).map((r) => r.userId)).toEqual([A, B, D, C]);
  });
});

describe("deactivationBlock", () => {
  it("blocks deactivating yourself", () => {
    expect(deactivationBlock(rows[0]!, A, rows)).toBe("self");
    expect(deactivationBlock(rows[1]!, B, rows)).toBe("self");
  });
  it("blocks the last active manager", () => {
    expect(activeManagerCount(rows)).toBe(1);
    expect(deactivationBlock(rows[0]!, B, rows)).toBe("last_manager");
  });
  it("allows others when another manager remains", () => {
    const more = [
      ...rows,
      row({ userId: "00000000-0000-4000-8000-00000000000e", role: "manager" }),
    ];
    expect(deactivationBlock(rows[0]!, B, more)).toBeNull();
    expect(deactivationBlock(rows[1]!, A, rows)).toBeNull();
  });
});

// ----------------------------------------------------------------------------- repository

interface FakeDb {
  profiles: Record<
    string,
    { user_id: string; display_name: string; role: string; is_active: boolean; created_at?: string }
  >;
  readError?: boolean;
  updateError?: { code?: string; message?: string };
  /** Simulates another manager changing the row between our read and our write. */
  raceFlip?: boolean;
  updates: unknown[];
}

function fakeClient(db: FakeDb): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "staff_profiles") throw new Error(`unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const builder = {
        select: () => builder,
        order: () =>
          Promise.resolve(
            db.readError
              ? { data: null, error: { message: "boom" } }
              : { data: Object.values(db.profiles), error: null },
          ),
        update(p: Record<string, unknown>) {
          patch = p;
          db.updates.push(p);
          return builder;
        },
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          const found = db.profiles[String(filters.user_id)];
          if (patch === null) {
            return Promise.resolve(
              db.readError
                ? { data: null, error: { message: "boom" } }
                : { data: found ?? null, error: null },
            );
          }
          if (db.updateError) return Promise.resolve({ data: null, error: db.updateError });
          if (db.raceFlip && found) found.is_active = !found.is_active;
          if (!found || found.is_active !== filters.is_active) {
            return Promise.resolve({ data: null, error: null });
          }
          Object.assign(found, patch);
          return Promise.resolve({ data: { user_id: found.user_id }, error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const db = (over: Partial<FakeDb> = {}): FakeDb => ({
  profiles: {
    [A]: {
      user_id: A,
      display_name: "Asha",
      role: "manager",
      is_active: true,
      created_at: "2026-01-01T00:00:00Z",
    },
    [B]: {
      user_id: B,
      display_name: "Bilal",
      role: "counter",
      is_active: true,
      created_at: "2026-01-02T00:00:00Z",
    },
    [C]: {
      user_id: C,
      display_name: "Chitra",
      role: "counter",
      is_active: false,
      created_at: "2026-01-03T00:00:00Z",
    },
  },
  updates: [],
  ...over,
});

describe("loadStaffProfiles", () => {
  it("maps rows and skips ones it does not understand", async () => {
    const d = db();
    d.profiles["x"] = {
      user_id: "not-a-uuid",
      display_name: "Bad",
      role: "owner",
      is_active: true,
    };
    const result = await loadStaffProfiles(fakeClient(d));
    expect(result.ok && result.profiles.map((p) => p.userId).sort()).toEqual([A, B, C].sort());
  });
  it("reports a load failure", async () => {
    expect(await loadStaffProfiles(fakeClient(db({ readError: true })))).toEqual({ ok: false });
  });
});

describe("setStaffActive", () => {
  it("deactivates and reactivates, sending ONLY is_active", async () => {
    const d = db();
    const off = await setStaffActive(fakeClient(d), A, B, false);
    expect(off).toMatchObject({ ok: true });
    expect(d.profiles[B]!.is_active).toBe(false);
    const on = await setStaffActive(fakeClient(d), A, C, true);
    expect(on).toMatchObject({ ok: true });
    expect(d.updates).toEqual([{ is_active: false }, { is_active: true }]);
  });
  it("refuses self-deactivation without touching the database", async () => {
    const d = db();
    expect(await setStaffActive(fakeClient(d), A, A, false)).toMatchObject({
      ok: false,
      kind: "self",
    });
    expect(d.updates).toEqual([]);
  });
  it("reports a missing account", async () => {
    const r = await setStaffActive(
      fakeClient(db()),
      A,
      "00000000-0000-4000-8000-0000000000ff",
      false,
    );
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });
  it("treats an already-applied change as a conflict, not a silent success", async () => {
    const r = await setStaffActive(fakeClient(db()), A, C, false);
    expect(r).toMatchObject({ ok: false, kind: "conflict" });
  });
  it("detects a concurrent change instead of overwriting it", async () => {
    const r = await setStaffActive(fakeClient(db({ raceFlip: true })), A, B, false);
    expect(r).toMatchObject({ ok: false, kind: "conflict" });
  });
  it("maps the database's last-manager refusal to a clear message", async () => {
    const r = await setStaffActive(
      fakeClient(
        db({ updateError: { code: "23514", message: "At least one active manager must remain" } }),
      ),
      B,
      A,
      false,
    );
    expect(r).toMatchObject({ ok: false, kind: "last_manager" });
  });
  it("never leaks raw database errors", async () => {
    const r = await setStaffActive(
      fakeClient(
        db({ updateError: { code: "XX000", message: "relation staff_profiles secret detail" } }),
      ),
      A,
      B,
      false,
    );
    expect(r).toMatchObject({ ok: false, kind: "error" });
    expect(JSON.stringify(r)).not.toMatch(/relation|secret detail/);
  });
});
