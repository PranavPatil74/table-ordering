import { randomBytes } from "node:crypto";
import { Client, Pool, type QueryResult, type QueryResultRow } from "pg";
import { inject } from "vitest";

import { withDatabase } from "./global-setup";

export type Actor =
  | { role: "postgres" } // superuser: migrations / SQL editor (bypasses RLS)
  | { role: "service_role" } // trusted backend
  | { role: "anon" } // unauthenticated customer
  | { role: "authenticated"; userId: string }; // signed-in user (staff)

export interface TestDb {
  name: string;
  url: string;
  pool: Pool;
  /** Run one statement as `actor` in its own transaction (rolled back unless `commit`). */
  query: <R extends QueryResultRow = QueryResultRow>(
    actor: Actor,
    sql: string,
    params?: unknown[],
    options?: { commit?: boolean },
  ) => Promise<QueryResult<R>>;
  /** Run several statements as `actor` in ONE transaction. */
  transaction: <T>(
    actor: Actor,
    fn: (client: import("pg").PoolClient) => Promise<T>,
    options?: { commit?: boolean },
  ) => Promise<T>;
  close: () => Promise<void>;
}

export function dbTestsAvailable(): boolean {
  return inject("pgAdminUrl") !== "";
}

async function applyActor(client: import("pg").PoolClient, actor: Actor) {
  if (actor.role === "postgres") return;
  await client.query(`set local role ${actor.role}`);
  const claims =
    actor.role === "authenticated"
      ? { sub: actor.userId, role: "authenticated" }
      : { role: actor.role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

/** Creates an isolated database for one test file, cloned from the migrated template. */
export async function createTestDb(): Promise<TestDb> {
  const adminUrl = inject("pgAdminUrl");
  const template = inject("pgTemplateDb");
  if (!adminUrl) throw new Error("Database tests are not available in this run");

  const name = `sbx_test_${randomBytes(5).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database "${name}" template "${template}"`);
  await admin.end();

  const url = withDatabase(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: 20 });

  const transaction: TestDb["transaction"] = async (actor, fn, options = {}) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await applyActor(client, actor);
      const result = await fn(client);
      await client.query(options.commit ? "commit" : "rollback");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const query: TestDb["query"] = (actor, sql, params = [], options = {}) =>
    transaction(actor, (client) => client.query(sql, params), options) as Promise<
      QueryResult<never>
    >;

  const close = async () => {
    await pool.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`drop database if exists "${name}" with (force)`);
    await cleanup.end();
  };

  return { name, url, pool, query, transaction, close };
}

/** Postgres SQLSTATE codes used in assertions. */
export const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  insufficientPrivilege: "42501",
  restrictViolation: "23001",
  objectNotInPrerequisiteState: "55000",
  noDataFound: "P0002",
  invalidParameter: "22023",
  invalidTextRepresentation: "22P02",
} as const;

/**
 * Awaits `promise`, which MUST reject with a Postgres error, and returns it. Fails the test if
 * the statement unexpectedly succeeds, so a missing constraint cannot pass silently.
 */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  }
  throw new Error("Expected the statement to fail, but it succeeded");
}

/** Superuser helper for arranging fixtures (always committed). */
export function admin(db: TestDb) {
  return {
    one: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      const result = await db.query<R>({ role: "postgres" }, sql, params, { commit: true });
      return result.rows[0] as R;
    },
    all: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      const result = await db.query<R>({ role: "postgres" }, sql, params, { commit: true });
      return result.rows;
    },
    exec: async (sql: string, params: unknown[] = []) => {
      await db.query({ role: "postgres" }, sql, params, { commit: true });
    },
  };
}
