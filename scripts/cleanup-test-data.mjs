// @ts-check
/**
 * Preview and (after explicit confirmation) clean up menu and table fixtures left behind by
 * `pnpm test:supabase` in your LOCAL development database. See docs/test-data-cleanup.md.
 *
 *   pnpm cleanup:test-data                              read-only preview (default)
 *   pnpm cleanup:test-data --json                       the same, machine-readable
 *   pnpm cleanup:test-data --apply --confirm <token>    apply exactly what the preview showed
 *   add --delete-unreferenced to also DELETE menu fixtures nothing references (default: archive
 *   only; tables are only ever deactivated)
 *
 * `pnpm cleanup:test-menu` is kept as an alias (scripts/cleanup-test-menu.mjs).
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the local stack, the same variables as
 * `pnpm test:supabase` (see `pnpm exec supabase status -o env`). Refuses any non-loopback URL.
 * Never prints a key.
 */
import { createPostgrestPort } from "./test-menu-cleanup/postgrest-port.mjs";
import {
  applyPlan,
  collectPlan,
  formatPlan,
  hostOf,
  isLoopbackUrl,
  parseArgs,
} from "./test-menu-cleanup/core.mjs";

const USAGE = `Usage: pnpm cleanup:test-data [--json] [--delete-unreferenced] [--apply --confirm <token>]

  (no flags)              Read-only preview of the test fixtures (menu items, categories and
                          tables) that would be cleaned up.
  --apply --confirm TOKEN Apply the previewed plan. TOKEN is printed by the preview.
  --delete-unreferenced   Also delete fixture items/categories that nothing references
                          (default: archive only, keeping history intact). Tables are never
                          deleted, only deactivated.
  --json                  Machine-readable preview.

Environment: SUPABASE_URL (local only) and SUPABASE_SERVICE_ROLE_KEY.`;

function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
}
if (options.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const url = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
if (missing.length > 0) {
  fail(
    `Missing environment variables: ${missing.join(", ")}.\n` +
      "Set them from your local stack (see docs/test-data-cleanup.md); values are never printed.",
  );
}
if (!isLoopbackUrl(url)) {
  fail(
    `Refusing to run: SUPABASE_URL points at ${hostOf(url)}, which is not a local (loopback) address. ` +
      "This tool only cleans a local development database.",
  );
}

const port = createPostgrestPort(url, key);
const where = hostOf(url);

try {
  if (!options.apply) {
    const plan = await collectPlan(port, { deleteUnreferenced: options.deleteUnreferenced });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatPlan(plan, where)}\n`);
      if (plan.candidates.length > 0) {
        const extra = options.deleteUnreferenced ? " --delete-unreferenced" : "";
        process.stdout.write(
          `\nNothing was changed. To apply exactly this plan:\n  pnpm cleanup:test-data${extra} --apply --confirm ${plan.token}\n`,
        );
      }
    }
  } else {
    const outcome = await applyPlan(port, options);
    process.stdout.write(`${formatPlan(outcome.plan, where)}\n\nApplied:\n`);
    for (const r of outcome.results) {
      process.stdout.write(
        `  ${r.ok ? "ok    " : "FAILED"} ${r.what}${r.error ? `  (${r.error})` : ""}\n`,
      );
    }
    process.stdout.write(
      `\nHistory row counts before -> after: ${Object.keys(outcome.before)
        .map((k) => `${k} ${outcome.before[k]} -> ${outcome.after[k]}`)
        .join(", ")}\n`,
    );
    const failed = outcome.results.filter((r) => !r.ok).length;
    const stillActive =
      outcome.remaining.candidates.flatMap((c) => c.items).filter((i) => i.isActive).length +
      outcome.remaining.tableCandidates.filter((t) => t.action === "deactivate").length;
    process.stdout.write(
      `Verification: history ${outcome.historyUnchanged ? "UNCHANGED" : "CHANGED (investigate!)"}; ` +
        `${failed} failed step(s); ${stillActive} fixture item(s)/table(s) still active.\n`,
    );
    if (failed > 0 || !outcome.historyUnchanged || stillActive > 0) process.exit(2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
