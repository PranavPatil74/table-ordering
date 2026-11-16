/**
 * Harness for the Supabase integration tests. Everything here talks to the REAL local stack
 * (GoTrue/Auth, PostgREST, Realtime) over HTTP using the public client library. It is only
 * meaningful when `supabase start` is running; `global-setup.ts` verifies that first.
 *
 * Safety rules:
 *  - Local stack only (readSupabaseEnv refuses non-loopback URLs).
 *  - Every row and user is tagged with a per-run random tag, and cleanup deletes ONLY the ids
 *    this run created. It never deletes by pattern, so unrelated data is never touched.
 *  - Keys are never logged. Error text comes from describeResult (code, status, short message).
 */
import { createHash, randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { buildSnapshot, itemLine, type MenuFixture } from "../test/snapshot";
import {
  decodeJwtPayload,
  archiveColumnFor,
  describeResult,
  generateTestPassword,
  isPermissionDenied,
  readSupabaseEnv,
  toByteaHex,
  type ApiResultLike,
  type SupabaseTestEnv,
} from "./helpers";

let cachedEnv: SupabaseTestEnv | undefined;
export function testEnv(): SupabaseTestEnv {
  cachedEnv ??= readSupabaseEnv(process.env);
  return cachedEnv;
}

const CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/** An unauthenticated browser: the anon/publishable key only. */
export const anonClient = (): SupabaseClient =>
  createClient(testEnv().url, testEnv().anonKey, CLIENT_OPTIONS);

/** The trusted backend. Tests use it to arrange data and to read back the truth. */
export const serviceClient = (): SupabaseClient =>
  createClient(testEnv().url, testEnv().serviceKey, CLIENT_OPTIONS);

// ---------------------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------------------

/** Returns `data`, or throws a secret-free error. For arranging data, not for assertions. */
export function must<D>(result: ApiResultLike & { data: D }, what: string): NonNullable<D> {
  if (result.error || result.data === null || result.data === undefined) {
    throw new Error(`${what} failed: ${describeResult(result)}`);
  }
  return result.data as NonNullable<D>;
}

/** Message for `expect(isPermissionDenied(r), denialMessage(r))`. */
export const denialMessage = (what: string, result: ApiResultLike) =>
  `${what} should be denied, got ${describeResult(result)}`;

export { isPermissionDenied };

export async function eventually<T>(
  fn: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1000));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${options.what}${detail}`);
}

// ---------------------------------------------------------------------------------------
// Created-data tracking and cleanup
// ---------------------------------------------------------------------------------------

type Tracked = { table: string; column: string; id: string };

export class Tracker {
  private rows: Tracked[] = [];
  private userIds: string[] = [];

  /** `service` is injectable so the cleanup logic can be tested against a real PostgreSQL. */
  constructor(private readonly service: () => SupabaseClient = serviceClient) {}

  row(table: string, id: string, column = "id") {
    this.rows.push({ table, column, id });
  }
  user(id: string) {
    this.userIds.push(id);
  }

  /**
   * Best-effort removal of what THIS run created, newest first. Some rows cannot be removed by
   * design (orders are immutable; an ordered menu item or table is protected; the last active
   * manager cannot be deleted). Those stay behind, tagged with the run id; menu items, categories,
   * tables and modifier groups among them are DEACTIVATED/ARCHIVED (is_active = false) so they do
   * not show up in the manager dashboard, on the customer menu or as a table customers can order
   * at, and `pnpm cleanup:test-data` or a `supabase db reset` clears them. Orders, order items,
   * payment attempts and every other history row are never touched.
   *
   * It is safe to call after a failed or partial run: every tracked row is attempted
   * independently, a thrown error (network, server) is handled like a refused delete, and nothing
   * here throws. Failures are counted, never fatal. Nothing is ever deleted or archived by
   * pattern: only the ids this run created.
   */
  async cleanup(): Promise<{ removed: number; kept: number; archived: number }> {
    const service = this.service();
    let removed = 0;
    let kept = 0;
    let archived = 0;
    for (const row of [...this.rows].reverse()) {
      let deleted = false;
      try {
        const { error } = await service.from(row.table).delete().eq(row.column, row.id);
        deleted = !error;
      } catch {
        deleted = false;
      }
      if (deleted) {
        removed += 1;
        continue;
      }
      kept += 1;
      const archive = archiveColumnFor(row.table);
      if (!archive) continue;
      try {
        // Best effort: the row stays, but hidden. Never affects the test result.
        const result = await service
          .from(row.table)
          .update({ [archive]: false })
          .eq(row.column, row.id);
        if (!result.error) archived += 1;
      } catch {
        // Leave it for `pnpm cleanup:test-data`.
      }
    }
    for (const id of [...this.userIds].reverse()) {
      try {
        const { error } = await service.auth.admin.deleteUser(id);
        if (error) kept += 1;
        else removed += 1;
      } catch {
        kept += 1;
      }
    }
    return { removed, kept, archived };
  }
}

export const newRunTag = () => randomBytes(3).toString("hex");

// ---------------------------------------------------------------------------------------
// Users (real Supabase Auth)
// ---------------------------------------------------------------------------------------

export interface TestUser {
  id: string;
  email: string;
  /** A client signed in as this user: PostgREST and Realtime calls carry their real JWT. */
  client: SupabaseClient;
  accessToken: string;
}

export interface StaffSpec {
  role: "manager" | "counter";
  displayName: string;
  isActive?: boolean;
}

/**
 * Creates a user with the Auth admin API, optionally gives them a staff profile (through the
 * service role: nobody else can create profiles), then signs in with the password grant to obtain
 * a real session. The random password never leaves this function.
 */
export async function createUser(
  tag: string,
  label: string,
  tracker: Tracker,
  staff?: StaffSpec,
): Promise<TestUser> {
  const service = serviceClient();
  const email = `it-${tag}-${label}@example.com`;
  const password = generateTestPassword(); // satisfies the local Auth password policy

  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`Auth admin createUser failed: ${created.error?.message ?? "no user"}`);
  }
  const id = created.data.user.id;
  tracker.user(id);

  if (staff) {
    const profile = await service.from("staff_profiles").insert({
      user_id: id,
      display_name: staff.displayName,
      role: staff.role,
      is_active: staff.isActive ?? true,
    });
    if (profile.error) throw new Error(`staff profile insert failed: ${describeResult(profile)}`);
  }

  const client = createClient(testEnv().url, testEnv().anonKey, CLIENT_OPTIONS);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    throw new Error(`Auth sign-in failed: ${signedIn.error?.message ?? "no session"}`);
  }
  return { id, email, client, accessToken: signedIn.data.session.access_token };
}

export function claimsOf(user: TestUser) {
  const claims = decodeJwtPayload(user.accessToken);
  if (!claims) throw new Error("Access token is not a JWT");
  return claims;
}

// ---------------------------------------------------------------------------------------
// Disposable menu / table / order data
// ---------------------------------------------------------------------------------------

export interface OrderRef {
  orderId: string;
  attemptId: string;
  orderNumber: string;
  paymentId: string;
}

export interface World {
  tag: string;
  table: { id: string; code: string; label: string };
  menu: MenuFixture;
  /** An archived item (is_active = false): staff can see it, customers cannot. */
  archivedItemId: string;
  /** A sold-out item (is_available = false): customers see it, marked unavailable. */
  soldOutItemId: string;
  /** Creates one more paid order, exactly as the backend does after verifying a payment. */
  makeOrder: () => Promise<OrderRef>;
}

/**
 * Menu, table and a paid-order factory, all tagged with `tag`. Built through the service role,
 * the way the backend will. Orders are created by inserting a payment attempt and calling
 * `finalize_paid_order`, so the real function runs over the real API.
 */
export async function createWorld(
  tag: string,
  tracker: Tracker,
  service: SupabaseClient = serviceClient(),
): Promise<World> {
  const insertOne = async (table: string, row: Record<string, unknown>) => {
    const result = await service.from(table).insert(row).select("id").single();
    const data = must(result, `insert into ${table}`) as { id: string };
    tracker.row(table, data.id);
    return data.id;
  };

  const tableCode = `IT${tag.toUpperCase()}`; // matches ^[A-Z][A-Z0-9_-]{1,15}$
  const tableId = await insertOne("cafe_tables", { code: tableCode, label: `IT table ${tag}` });

  const categoryName = `IT ${tag} Category`;
  const categoryId = await insertOne("menu_categories", {
    slug: `it-${tag}-cat`,
    name: categoryName,
  });
  const itemId = await insertOne("menu_items", {
    category_id: categoryId,
    slug: `it-${tag}-sandwich`,
    name: "Grilled Sandwich",
    price_paise: 14900,
  });
  const drinkId = await insertOne("menu_items", {
    category_id: categoryId,
    slug: `it-${tag}-coffee`,
    name: "Cold Coffee",
    price_paise: 11900,
  });
  const archivedItemId = await insertOne("menu_items", {
    category_id: categoryId,
    slug: `it-${tag}-archived`,
    name: "Archived item",
    price_paise: 100,
    is_active: false,
  });
  const soldOutItemId = await insertOne("menu_items", {
    category_id: categoryId,
    slug: `it-${tag}-soldout`,
    name: "Sold out item",
    price_paise: 100,
    is_available: false,
  });

  const groupName = `IT ${tag} Extras`;
  const groupId = await insertOne("modifier_groups", {
    slug: `it-${tag}-extras`,
    name: groupName,
    max_select: 3,
  });
  const cheeseId = await insertOne("modifier_options", {
    group_id: groupId,
    name: "Extra cheese",
    price_delta_paise: 3000,
  });
  const mayoId = await insertOne("modifier_options", {
    group_id: groupId,
    name: "Mint mayo",
    price_delta_paise: 0,
  });
  const attach = await service
    .from("menu_item_modifier_groups")
    .insert({ item_id: itemId, group_id: groupId });
  if (attach.error) throw new Error(`attach modifier group failed: ${describeResult(attach)}`);
  tracker.row("menu_item_modifier_groups", itemId, "item_id");

  const menu: MenuFixture = {
    categoryId,
    categoryName,
    item: { id: itemId, name: "Grilled Sandwich", pricePaise: 14900 },
    drink: { id: drinkId, name: "Cold Coffee", pricePaise: 11900 },
    group: { id: groupId, name: groupName },
    optionCheese: { id: cheeseId, name: "Extra cheese", deltaPaise: 3000 },
    optionMayo: { id: mayoId, name: "Mint mayo", deltaPaise: 0 },
  };
  const table = { id: tableId, code: tableCode, label: `IT table ${tag}` };

  const makeOrder = async (): Promise<OrderRef> => {
    const snapshot = buildSnapshot(table, [
      itemLine(menu, "item", 2, true),
      itemLine(menu, "drink", 1),
    ]);
    const tokenHash = createHash("sha256").update(randomBytes(16)).digest(); // only a hash is ever stored
    const attempt = await service
      .from("payment_attempts")
      .insert({
        idempotency_key: randomBytes(16).toString("hex"),
        table_id: table.id,
        amount_paise: snapshot.total_paise,
        gateway_order_id: `order_it${randomBytes(6).toString("hex")}`,
        tracking_token_hash: toByteaHex(tokenHash),
        cart_snapshot: snapshot,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    const attemptId = (must(attempt, "insert payment attempt") as { id: string }).id;

    const paymentId = `pay_it${randomBytes(6).toString("hex")}`;
    const finalized = await service.rpc("finalize_paid_order", {
      p_attempt_id: attemptId,
      p_gateway_payment_id: paymentId,
    });
    const rows = must(finalized, "finalize_paid_order") as {
      out_order_id: string;
      out_order_number: string;
      out_created: boolean;
    }[];
    const row = rows[0];
    if (!row?.out_created) throw new Error("finalize_paid_order did not create an order");
    return { orderId: row.out_order_id, attemptId, orderNumber: row.out_order_number, paymentId };
  };

  return { tag, table, menu, archivedItemId, soldOutItemId, makeOrder };
}
