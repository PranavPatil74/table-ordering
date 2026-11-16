import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadStaffAccess } from "@/lib/auth/staff";
import { buildCatalog, findItem, type RawCatalogRows } from "@/lib/customer/catalog";
import { loadStaffProfiles, setStaffActive } from "@/lib/staff/repository";

import { expectDenied, expectNotApplied } from "./assertions";
import {
  anonClient,
  createUser,
  must,
  newRunTag,
  serviceClient,
  Tracker,
  type TestUser,
} from "./harness";

/**
 * Phase 4 against the REAL local Supabase stack (PostgREST + Auth + RLS): the anonymous menu read
 * the customer pages perform, the service-role-only table lookup and rate limiter, and the staff
 * management repository functions run as real signed-in managers and counters. Needs
 * `supabase start` + `supabase db reset`; run with `pnpm test:supabase`.
 *
 * NOT RUN in the environment that wrote it (no Docker/Supabase CLI): see the Phase 4 report.
 */

const tag = newRunTag();
const tracker = new Tracker();
const service = serviceClient();
const anon = anonClient();
let manager: TestUser;
let otherManager: TestUser;
let counter: TestUser;
let plain: TestUser;
const tableCode = `Q${tag.toUpperCase()}`.slice(0, 8);
let tableId = "";
const created: { category?: string; item?: string } = {};

beforeAll(async () => {
  manager = await createUser(tag, "mgr", tracker, {
    role: "manager",
    displayName: `IT mgr ${tag}`,
  });
  otherManager = await createUser(tag, "mgr2", tracker, {
    role: "manager",
    displayName: `IT mgr2 ${tag}`,
  });
  counter = await createUser(tag, "cnt", tracker, {
    role: "counter",
    displayName: `IT counter ${tag}`,
  });
  plain = await createUser(tag, "plain", tracker);

  const table = must(
    await service
      .from("cafe_tables")
      .insert({ code: tableCode, label: `IT ${tag}` })
      .select("id")
      .single(),
    "table insert",
  );
  tableId = table.id as string;
  // Tracked so the shared cleanup deactivates it if it cannot be deleted (it is deleted last).
  tracker.row("cafe_tables", tableId);
  const category = must(
    await service
      .from("menu_categories")
      .insert({ slug: `it-c-${tag}`, name: `IT cat ${tag}` })
      .select("id")
      .single(),
    "category insert",
  );
  created.category = category.id as string;
  const item = must(
    await service
      .from("menu_items")
      .insert({
        category_id: created.category,
        slug: `it-i-${tag}`,
        name: `IT item ${tag}`,
        price_paise: 12300,
      })
      .select("id")
      .single(),
    "item insert",
  );
  created.item = item.id as string;
});
afterAll(async () => {
  if (created.item) await service.from("menu_items").delete().eq("id", created.item);
  if (created.category) await service.from("menu_categories").delete().eq("id", created.category);
  await tracker.cleanup();
});

async function loadAnonCatalog() {
  const [settings, categories, items, groups, options, links] = await Promise.all([
    anon
      .from("cafe_settings")
      .select("cafe_name, orders_enabled, max_item_quantity, max_items_per_order")
      .limit(1)
      .maybeSingle(),
    anon.from("menu_categories").select("id, name, description, sort_order, is_active"),
    anon
      .from("menu_items")
      .select(
        "id, category_id, name, description, ingredients, dietary_tags, price_paise, image_path, sort_order, is_active, is_available",
      ),
    anon.from("modifier_groups").select("id, name, min_select, max_select, sort_order, is_active"),
    anon
      .from("modifier_options")
      .select(
        "id, group_id, name, price_delta_paise, is_default, sort_order, is_active, is_available",
      ),
    anon.from("menu_item_modifier_groups").select("item_id, group_id, sort_order"),
  ]);
  return {
    settings: must(settings, "settings"),
    catalog: buildCatalog({
      categories: must(categories, "categories"),
      items: must(items, "items"),
      groups: must(groups, "groups"),
      options: must(options, "options"),
      links: must(links, "links"),
    } as unknown as RawCatalogRows),
  };
}

describe("customer menu read as the anonymous role", () => {
  it("shows the active item with its integer price and ordering limits", async () => {
    const { catalog, settings } = await loadAnonCatalog();
    expect(findItem(catalog, created.item!)?.pricePaise).toBe(12300);
    expect(settings.max_item_quantity).toBeGreaterThan(0);
  });
  it("hides an archived item", async () => {
    await service.from("menu_items").update({ is_active: false }).eq("id", created.item!);
    expect(findItem((await loadAnonCatalog()).catalog, created.item!)).toBeUndefined();
    await service.from("menu_items").update({ is_active: true }).eq("id", created.item!);
  });
  it("cannot read tables, orders or payment attempts, and cannot write the menu", async () => {
    expectDenied("anon read cafe_tables", await anon.from("cafe_tables").select("id, code"));
    expectDenied("anon read orders", await anon.from("orders").select("id"));
    expectDenied("anon read payment_attempts", await anon.from("payment_attempts").select("id"));
    expectNotApplied(
      "anon price change",
      await anon.from("menu_items").update({ price_paise: 1 }).eq("id", created.item!).select("id"),
    );
    const row = must(
      await service.from("menu_items").select("price_paise").eq("id", created.item!).single(),
      "readback",
    );
    expect(row.price_paise).toBe(12300);
  });
});

describe("service-role-only helpers used by the customer pages", () => {
  it("looks a table up by code, and reports inactive tables", async () => {
    const found = must(
      await service
        .from("cafe_tables")
        .select("id, code, label, is_active")
        .eq("code", tableCode)
        .maybeSingle(),
      "lookup",
    );
    expect(found).toMatchObject({ id: tableId, is_active: true });
    await service.from("cafe_tables").update({ is_active: false }).eq("id", tableId);
    const off = must(
      await service.from("cafe_tables").select("is_active").eq("code", tableCode).maybeSingle(),
      "lookup",
    );
    expect(off.is_active).toBe(false);
    await service.from("cafe_tables").update({ is_active: true }).eq("id", tableId);
  });
  it("rate limiter is callable by the service role only", async () => {
    const bucket = `it-${tag}`;
    const hits: unknown[] = [];
    for (let i = 0; i < 3; i += 1)
      hits.push(
        must(
          await service.rpc("check_rate_limit", {
            p_bucket: bucket,
            p_limit: 2,
            p_window_seconds: 60,
          }),
          "rpc",
        ),
      );
    expect(hits).toEqual([true, true, false]);
    expectDenied(
      "anon rate limit",
      await anon.rpc("check_rate_limit", { p_bucket: bucket, p_limit: 2, p_window_seconds: 60 }),
    );
    expectDenied(
      "counter rate limit",
      await counter.client.rpc("check_rate_limit", {
        p_bucket: bucket,
        p_limit: 2,
        p_window_seconds: 60,
      }),
    );
  });
  it("the Auth admin API returns a staff member's e-mail to the service role (staff directory)", async () => {
    const result = await service.auth.admin.getUserById(counter.id);
    expect(result.data.user?.email).toBe(counter.email);
  });
});

describe("staff management as real signed-in users", () => {
  it("a manager lists all staff; a counter and a profile-less user cannot", async () => {
    const all = await loadStaffProfiles(manager.client);
    expect(all.ok && all.profiles.map((p) => p.userId)).toEqual(
      expect.arrayContaining([manager.id, otherManager.id, counter.id]),
    );
    const asCounter = await loadStaffProfiles(counter.client);
    expect(asCounter.ok && asCounter.profiles.map((p) => p.userId)).toEqual([counter.id]);
    const asPlain = await loadStaffProfiles(plain.client);
    expect(asPlain.ok && asPlain.profiles).toEqual([]);
  });

  it("deactivation removes access immediately, reactivation restores it", async () => {
    expect(await loadStaffAccess(counter.client)).toMatchObject({ status: "authorized" });
    const off = await setStaffActive(manager.client, manager.id, counter.id, false);
    expect(off.ok).toBe(true);
    expect(await loadStaffAccess(counter.client)).toMatchObject({
      status: "denied",
      reason: "inactive",
    });
    const on = await setStaffActive(manager.client, manager.id, counter.id, true);
    expect(on.ok).toBe(true);
    expect(await loadStaffAccess(counter.client)).toMatchObject({ status: "authorized" });
  });

  it("refuses self-deactivation and no-op/stale changes", async () => {
    expect(await setStaffActive(manager.client, manager.id, manager.id, false)).toMatchObject({
      ok: false,
      kind: "self",
    });
    expect(await setStaffActive(manager.client, manager.id, counter.id, true)).toMatchObject({
      ok: false,
      kind: "conflict",
    });
  });

  it("a counter cannot deactivate anyone; nothing changes", async () => {
    const r = await setStaffActive(counter.client, counter.id, otherManager.id, false);
    expect(r.ok).toBe(false);
    const row = must(
      await service
        .from("staff_profiles")
        .select("is_active")
        .eq("user_id", otherManager.id)
        .single(),
      "readback",
    );
    expect(row.is_active).toBe(true);
  });

  it("a counter cannot promote themselves", async () => {
    const result = await counter.client
      .from("staff_profiles")
      .update({ role: "manager" })
      .eq("user_id", counter.id)
      .select("user_id");
    expectNotApplied("self promotion", result);
    const row = must(
      await service.from("staff_profiles").select("role").eq("user_id", counter.id).single(),
      "readback",
    );
    expect(row.role).toBe("counter");
  });

  it("an unknown target is reported, not guessed", async () => {
    const r = await setStaffActive(
      manager.client,
      manager.id,
      "00000000-0000-4000-8000-0000000000ff",
      false,
    );
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });
});
