/**
 * Runs once before the Supabase integration tests: validates the environment, then waits until
 * the real local services answer. "Started" is not "ready": after `supabase db reset` PostgREST
 * reloads its schema cache and GoTrue restarts, so the first requests can briefly fail.
 *
 * Never prints keys: only variable names, URLs without credentials, and HTTP statuses.
 */
import { decodeJwtPayload, readSupabaseEnv, type SupabaseTestEnv } from "./helpers";

// Generous by default: after `supabase db reset` PostgREST and Auth restart. Overridable so the
// "stack is not running" failure path can be exercised quickly.
const READY_TIMEOUT_MS = Number(process.env.SUPABASE_TESTS_READY_TIMEOUT_MS) || 120_000;

function headers(key: string): Record<string, string> {
  // Legacy keys are JWTs and also go in Authorization. New-style keys (sb_publishable_ / sb_secret_)
  // are opaque and are sent as `apikey` only.
  return decodeJwtPayload(key) ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

async function probe(env: SupabaseTestEnv): Promise<string | undefined> {
  const attempts: [string, string, (body: unknown) => boolean][] = [
    ["Auth health", `${env.url}/auth/v1/health`, () => true],
    [
      "PostgREST sees the migrated schema (public settings via anon key)",
      `${env.url}/rest/v1/cafe_settings?select=id,orders_enabled`,
      (body) => Array.isArray(body) && body.length === 1,
    ],
    [
      "service key is accepted by PostgREST",
      `${env.url}/rest/v1/staff_profiles?select=user_id&limit=1`,
      (body) => Array.isArray(body),
    ],
  ];
  for (const [label, url, ok] of attempts) {
    const key = label.startsWith("service") ? env.serviceKey : env.anonKey;
    let response: Response;
    try {
      response = await fetch(url, { headers: headers(key), signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      return `${label}: ${(error as Error).name}`;
    }
    if (!response.ok) return `${label}: HTTP ${response.status}`;
    const body: unknown = await response.json().catch(() => undefined);
    if (!ok(body)) return `${label}: unexpected response`;
  }
  return undefined;
}

export default async function setup() {
  const env = readSupabaseEnv(process.env);
  if (process.env.GITHUB_ACTIONS === "true" && !env.dbUrl) {
    // CI must never silently skip the catalog check on the Realtime publication.
    throw new Error(
      "SUPABASE_DB_URL is required in CI (it enables the supabase_realtime publication check).",
    );
  }

  if (!env.dbUrl) {
    // Locally the publication test is skipped without SUPABASE_DB_URL. Say so loudly, so a
    // "1 skipped" in the summary is never a mystery (CI already refuses to run without it).
    console.warn(
      "[supabase tests] SUPABASE_DB_URL is not set: the 'supabase_realtime publication' catalog " +
        "test will be SKIPPED. Set it from `supabase status -o env` (DB_URL) to run it. The " +
        "Realtime delivery tests still prove that public.orders is published.",
    );
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let problem: string | undefined;
  while (Date.now() < deadline) {
    problem = await probe(env);
    if (!problem) {
      // eslint-disable-next-line no-console -- one deliberate readiness line; never prints keys
      console.log(`[supabase tests] local stack at ${env.url} is ready`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `The local Supabase stack at ${env.url} was not ready after ${READY_TIMEOUT_MS / 1000}s ` +
      `(last problem: ${problem}). Is \`supabase start\` running and have the migrations been applied (\`supabase db reset\`)?`,
  );
}
