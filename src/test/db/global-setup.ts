import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

import { startPostgres } from "./postgres";

declare module "vitest" {
  export interface ProvidedContext {
    /** Superuser URL of the server used for DB tests ("" when no server is available). */
    pgAdminUrl: string;
    /** Name of the template database that already contains the shim + all migrations. */
    pgTemplateDb: string;
  }
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = join(root, "supabase", "migrations");
export const SHIM_PATH = join(root, "src", "test", "db", "supabase-shim.sql");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Runs one SQL file with the simple query protocol (so it may contain many statements). */
async function runFile(client: Client, path: string) {
  await client.query(readFileSync(path, "utf8"));
}

export default async function setup(project: TestProject) {
  const server = await startPostgres();

  if (!server) {
    if (process.env.ALLOW_DB_TESTS_SKIP === "1") {
      console.warn(
        "\n[db tests] NO PostgreSQL server available: database tests are being SKIPPED " +
          "(ALLOW_DB_TESTS_SKIP=1). Nothing in the database layer was verified.\n",
      );
      project.provide("pgAdminUrl", "");
      project.provide("pgTemplateDb", "");
      return;
    }
    throw new Error(
      "No PostgreSQL server available for database tests.\n" +
        "Install PostgreSQL server binaries (initdb/pg_ctl), set PG_BIN_DIR, or set " +
        "TEST_DATABASE_URL (e.g. the local Supabase database from `pnpm db:start`).\n" +
        "To knowingly skip these tests set ALLOW_DB_TESTS_SKIP=1.",
    );
  }

  const template = `sbx_template_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: server.adminUrl });
  await admin.connect();
  await admin.query(`create database "${template}"`);
  await admin.end();

  const templateClient = new Client({ connectionString: withDatabase(server.adminUrl, template) });
  await templateClient.connect();
  try {
    await runFile(templateClient, SHIM_PATH);
    for (const file of migrationFiles()) {
      try {
        await runFile(templateClient, join(MIGRATIONS_DIR, file));
      } catch (error) {
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await templateClient.end();
  }

  console.warn(`\n[db tests] Using ${server.description}\n`);
  project.provide("pgAdminUrl", server.adminUrl);
  project.provide("pgTemplateDb", template);

  return async () => {
    try {
      const cleanup = new Client({ connectionString: server.adminUrl });
      await cleanup.connect();
      await cleanup.query(`drop database if exists "${template}" with (force)`);
      await cleanup.end();
    } finally {
      server.stop();
    }
  };
}
