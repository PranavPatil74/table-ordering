/**
 * Starts (and stops) a throwaway PostgreSQL server for database tests.
 *
 * Resolution order:
 *   1. TEST_DATABASE_URL: use an existing server, e.g. the one from `pnpm db:start`
 *      (postgresql://postgres:postgres@127.0.0.1:54322/postgres). The role must be allowed to
 *      CREATE DATABASE. Every test run works in its own freshly created databases and drops
 *      them afterwards; it never touches the `postgres` database itself.
 *   2. Otherwise start a temporary cluster from locally installed PostgreSQL server binaries
 *      (PG_BIN_DIR, `pg_config --bindir`, or /usr/lib/postgresql/<version>/bin).
 *   3. Otherwise return null and the caller reports that DB tests could not run.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, chownSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunningPostgres {
  /** Superuser connection URL to the maintenance database. */
  adminUrl: string;
  /** Human-readable description, e.g. "PostgreSQL 16.15 (temporary local cluster)". */
  description: string;
  stop: () => void;
}

function findBinDir(): string | null {
  const candidates: string[] = [];
  if (process.env.PG_BIN_DIR) candidates.push(process.env.PG_BIN_DIR);

  const pgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (pgConfig.status === 0) candidates.push(pgConfig.stdout.trim());

  const root = "/usr/lib/postgresql";
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const version of versions) candidates.push(join(root, version, "bin"));
  }

  return (
    candidates.find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"))) ??
    null
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** PostgreSQL refuses to run as root, so when we are root run server commands as this user. */
function runAsUser(): string | null {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return isRoot ? (process.env.PG_RUN_AS ?? "postgres") : null;
}

function run(binDir: string, command: string, args: string[]) {
  const user = runAsUser();
  const [file, fileArgs] = user
    ? (["runuser", ["-u", user, "--", join(binDir, command), ...args]] as const)
    : ([join(binDir, command), args] as const);
  const result = spawnSync(file, fileArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (exit ${String(result.status)}): ${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return result.stdout;
}

export async function startPostgres(): Promise<RunningPostgres | null> {
  const existing = process.env.TEST_DATABASE_URL;
  if (existing) {
    return {
      adminUrl: existing,
      description: "existing server (TEST_DATABASE_URL)",
      stop: () => {},
    };
  }

  const binDir = findBinDir();
  if (!binDir) return null;

  const baseDir = mkdtempSync(join(tmpdir(), "sandwich-express-pg-"));
  const user = runAsUser();
  if (user) {
    // Let the unprivileged server user own its data directory.
    const uid = Number(spawnSync("id", ["-u", user], { encoding: "utf8" }).stdout.trim());
    const gid = Number(spawnSync("id", ["-g", user], { encoding: "utf8" }).stdout.trim());
    chownSync(baseDir, uid, gid);
  }
  chmodSync(baseDir, 0o700);

  const dataDir = join(baseDir, "data");
  const port = await freePort();

  const cleanup = () => rmSync(baseDir, { recursive: true, force: true });

  try {
    run(binDir, "initdb", [
      "-D",
      dataDir,
      "--auth=trust",
      "-U",
      "postgres",
      "--no-sync",
      "-E",
      "UTF8",
    ]);
    run(binDir, "pg_ctl", [
      "-D",
      dataDir,
      "-l",
      join(baseDir, "server.log"),
      "-o",
      [
        `-p ${port}`,
        "-c listen_addresses=127.0.0.1",
        `-c unix_socket_directories=${baseDir}`,
        "-c fsync=off",
        "-c synchronous_commit=off",
        "-c full_page_writes=off",
        "-c max_connections=200",
      ].join(" "),
      "-w",
      "start",
    ]);
  } catch (error) {
    cleanup();
    throw error;
  }

  const version = run(binDir, "postgres", ["--version"]).trim();

  return {
    adminUrl: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    description: `${version} (temporary local cluster)`,
    stop: () => {
      try {
        run(binDir, "pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
      } finally {
        cleanup();
      }
    },
  };
}
