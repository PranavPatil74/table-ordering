import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { Tracker } from "./harness";

/**
 * Tracker.cleanup() with a scripted client (no database): which calls it makes, in which order, and
 * that it never throws. The real-database behaviour is in src/db/harness-cleanup.db.test.ts.
 */

type Call = string;
function scripted(rules: {
  deleteFails?: (table: string) => "error" | "throw" | false;
  updateFails?: (table: string) => "error" | "throw" | false;
}) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      delete: () => ({
        eq: async (column: string, id: string) => {
          calls.push(`delete ${table}.${column}=${id}`);
          const fail = rules.deleteFails?.(table);
          if (fail === "throw") throw new Error("network down");
          return { error: fail ? { message: "refused" } : null };
        },
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (column: string, id: string) => {
          calls.push(`update ${table} ${JSON.stringify(values)} where ${column}=${id}`);
          const fail = rules.updateFails?.(table);
          if (fail === "throw") throw new Error("network down");
          return { error: fail ? { message: "refused" } : null };
        },
      }),
    }),
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          calls.push(`deleteUser ${id}`);
          return { error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const track = (tracker: Tracker) => {
  tracker.row("cafe_tables", "t1");
  tracker.row("menu_categories", "c1");
  tracker.row("menu_items", "i1");
  tracker.row("orders_like", "o1");
  tracker.user("u1");
};

describe("Tracker.cleanup", () => {
  it("deletes newest first, then users, and archives nothing when every delete works", async () => {
    const { client, calls } = scripted({});
    const tracker = new Tracker(() => client);
    track(tracker);
    expect(await tracker.cleanup()).toEqual({ removed: 5, kept: 0, archived: 0 });
    expect(calls).toEqual([
      "delete orders_like.id=o1",
      "delete menu_items.id=i1",
      "delete menu_categories.id=c1",
      "delete cafe_tables.id=t1",
      "deleteUser u1",
    ]);
  });

  it("deactivates (never deletes harder) what cannot be deleted, only for tables that have an archive flag", async () => {
    const { client, calls } = scripted({ deleteFails: () => "error" });
    const tracker = new Tracker(() => client);
    track(tracker);
    const result = await tracker.cleanup();
    expect(result).toEqual({ removed: 1, kept: 4, archived: 3 });
    const updates = calls.filter((c) => c.startsWith("update"));
    expect(updates).toEqual([
      'update menu_items {"is_active":false} where id=i1',
      'update menu_categories {"is_active":false} where id=c1',
      'update cafe_tables {"is_active":false} where id=t1',
    ]);
    expect(calls.some((c) => c.includes("orders_like") && c.startsWith("update"))).toBe(false);
  });

  it("treats a thrown error like a refused delete, and still deactivates", async () => {
    const { client, calls } = scripted({
      deleteFails: (t) => (t === "cafe_tables" ? "throw" : false),
    });
    const tracker = new Tracker(() => client);
    track(tracker);
    const result = await tracker.cleanup();
    expect(result.archived).toBe(1);
    expect(calls).toContain('update cafe_tables {"is_active":false} where id=t1');
  });

  it("never throws, even when deleting and deactivating both blow up", async () => {
    const { client } = scripted({ deleteFails: () => "throw", updateFails: () => "throw" });
    const tracker = new Tracker(() => client);
    track(tracker);
    await expect(tracker.cleanup()).resolves.toEqual({ removed: 1, kept: 4, archived: 0 });
  });

  it("only ever touches the ids it was given (no pattern deletes)", async () => {
    const { client, calls } = scripted({ deleteFails: () => "error" });
    const tracker = new Tracker(() => client);
    tracker.row("cafe_tables", "only-this-one");
    await tracker.cleanup();
    expect(calls.every((c) => c.includes("only-this-one"))).toBe(true);
  });
});
