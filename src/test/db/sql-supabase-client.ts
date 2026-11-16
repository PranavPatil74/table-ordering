import type { SupabaseClient } from "@supabase/supabase-js";

import type { TestDb } from "./db";

/**
 * A tiny stand-in for the slice of the Supabase client that `src/supabase-it/harness.ts` uses
 * (`from().insert/delete/update`, `rpc`, `auth.admin.deleteUser`), executed as `service_role` on the
 * plain-PostgreSQL test database. It lets the REAL `createWorld()` and `Tracker.cleanup()` run
 * against real triggers, foreign keys and `finalize_paid_order`, without a Supabase stack.
 * `failOn` makes chosen operations throw like a dropped connection, to test partial failures.
 * Test helper only: table and column names come from the harness constants, never from users.
 */
export interface SqlClientOptions {
  /** Throw (not return an error) for any operation whose label matches, e.g. "delete:cafe_tables". */
  failOn?: (label: string) => boolean;
}

const IDENT = /^[a-z_]+$/;
const ident = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`unexpected identifier ${name}`);
  return name;
};
const asError = (error: unknown) => ({
  code: (error as { code?: string }).code,
  message: String((error as { message?: string }).message ?? error),
});

export function createSqlClient(db: TestDb, options: SqlClientOptions = {}): SupabaseClient {
  const SERVICE = { role: "service_role" } as const;
  const guard = (label: string) => {
    if (options.failOn?.(label)) throw new Error(`simulated failure: ${label}`);
  };
  const run = (sql: string, params: unknown[]) => db.query(SERVICE, sql, params, { commit: true });

  const from = (table: string) => {
    ident(table);
    return {
      insert(row: Record<string, unknown>) {
        const columns = Object.keys(row).map(ident);
        const execute = async () => {
          try {
            guard(`insert:${table}`);
            const result = await run(
              `insert into public.${table} (${columns.join(", ")}) values (${columns
                .map((_, i) => `$${i + 1}`)
                .join(", ")}) returning *`,
              Object.values(row),
            );
            return { data: result.rows[0], error: null };
          } catch (error) {
            if ((error as Error).message.startsWith("simulated failure")) throw error;
            return { data: null, error: asError(error) };
          }
        };
        return {
          select: () => ({
            single: async () => {
              const result = await execute();
              return result.error
                ? result
                : { data: { id: (result.data as { id?: string }).id }, error: null };
            },
          }),
          // `await service.from(t).insert(row)` without .select()
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            execute().then(resolve, reject),
        };
      },
      delete: () => ({
        eq: async (column: string, value: unknown) => {
          guard(`delete:${table}`);
          try {
            await run(`delete from public.${table} where ${ident(column)} = $1`, [value]);
            return { error: null };
          } catch (error) {
            return { error: asError(error) };
          }
        },
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (column: string, value: unknown) => {
          guard(`update:${table}`);
          const columns = Object.keys(values).map(ident);
          try {
            await run(
              `update public.${table} set ${columns.map((c, i) => `${c} = $${i + 2}`).join(", ")} where ${ident(column)} = $1`,
              [value, ...Object.values(values)],
            );
            return { error: null };
          } catch (error) {
            return { error: asError(error) };
          }
        },
      }),
    };
  };

  return {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "finalize_paid_order") throw new Error(`unexpected rpc ${fn}`);
      try {
        const result = await run("select * from public.finalize_paid_order($1, $2)", [
          args.p_attempt_id,
          args.p_gateway_payment_id,
        ]);
        return { data: result.rows, error: null };
      } catch (error) {
        return { data: null, error: asError(error) };
      }
    },
    auth: { admin: { deleteUser: async () => ({ error: null }) } },
  } as unknown as SupabaseClient;
}
