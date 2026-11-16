// @ts-check
/**
 * Fails fast, with an actionable message, when the app under test is not wired to the E2E test
 * double. Runs before any of the browser tests (Playwright `globalSetup`, e2e/global-setup.ts) and, for its static part,
 * right after `pnpm e2e:build`.
 *
 * It prints only the non-secret host:port of each backend, never a key.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  E2E_DIST_DIR,
  E2E_ENV,
  E2E_PORT,
  E2E_PUBLIC_PORT,
  FAKE_SUPABASE_PORT,
  MARKER_FILE,
  MARKER_KIND,
  PROJECT_ROOT,
} from "./env.mjs";

const FAKE_HOST = `127.0.0.1:${FAKE_SUPABASE_PORT}`;
/**
 * Addresses that mean "a real Supabase": the local CLI default port, or a hosted project URL
 * (https://<20-character-ref>.supabase.co). Not the bare string ".supabase.co": supabase-js itself
 * mentions that domain in its own code.
 */
const FORBIDDEN = [
  {
    label: "127.0.0.1:54321 (local Supabase)",
    test: (/** @type {string} */ text) => /(?:127\.0\.0\.1|localhost):54321/.test(text),
  },
  {
    label: "a hosted *.supabase.co project",
    test: (/** @type {string} */ text) => /https?:\/\/[a-z0-9]{15,}\.supabase\.co/.test(text),
  },
];
const TEXT_FILE = /\.(js|mjs|cjs|json|html|rsc|txt|body|map)$/;

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (TEXT_FILE.test(name)) out.push(path);
  }
  return out;
}

/** Checks that need no running server: is the build one made for the test double? */
export function staticProblems(root = PROJECT_ROOT) {
  const dist = join(root, E2E_DIST_DIR);
  const markerPath = join(dist, MARKER_FILE);
  if (!existsSync(markerPath)) {
    return [
      `No E2E build found in ${E2E_DIST_DIR}/. Run \`pnpm e2e\` (it builds first) or \`pnpm e2e:build\`. ` +
        "A build made by plain `pnpm build` is not used by the E2E tests.",
    ];
  }
  /** @type {string[]} */
  const problems = [];
  /** @type {{ kind?: string, supabaseUrl?: string }} */
  let marker = {};
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    problems.push(`${E2E_DIST_DIR}/${MARKER_FILE} is unreadable. Re-run \`pnpm e2e:build\`.`);
  }
  if (marker.kind !== MARKER_KIND || marker.supabaseUrl !== E2E_ENV.NEXT_PUBLIC_SUPABASE_URL) {
    problems.push(
      `The E2E build was made for a different backend (${hostOf(marker.supabaseUrl)}, expected ${FAKE_HOST}). ` +
        "Re-run `pnpm e2e:build`.",
    );
  }

  let sawFake = false;
  /** @type {Set<string>} */
  const foundForbidden = new Set();
  for (const file of [...walk(join(dist, "server")), ...walk(join(dist, "static"))]) {
    const text = readFileSync(file, "utf8");
    if (text.includes(FAKE_HOST)) sawFake = true;
    for (const rule of FORBIDDEN) if (rule.test(text)) foundForbidden.add(rule.label);
  }
  if (!sawFake) {
    problems.push(
      `The compiled app in ${E2E_DIST_DIR}/ does not contain the test double address (${FAKE_HOST}). ` +
        "Re-run `pnpm e2e:build`.",
    );
  }
  if (foundForbidden.size > 0) {
    problems.push(
      `The compiled app in ${E2E_DIST_DIR}/ contains a real-Supabase address (${[...foundForbidden].join(", ")}). ` +
        "It was built with NEXT_PUBLIC_SUPABASE_URL from your shell or .env.local. Run `pnpm e2e`, " +
        "which rebuilds with an isolated environment.",
    );
  }
  return problems;
}

/** @param {string | undefined} url */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return "unknown";
  }
}

async function fakeRequestCount() {
  const response = await fetch(`http://${FAKE_HOST}/__stub/traffic`);
  const body = /** @type {{ requests: number }} */ (await response.json());
  return body.requests;
}

/** Does the running app really talk to the test double? Asks a page that reads Supabase. */
export async function liveProblems() {
  /** @type {string[]} */
  const problems = [];
  try {
    await fakeRequestCount();
  } catch {
    return [
      `The E2E test double is not reachable at ${FAKE_HOST}. Is something else using port ${FAKE_SUPABASE_PORT}?`,
    ];
  }
  for (const port of [E2E_PORT, E2E_PUBLIC_PORT]) {
    const before = await fakeRequestCount();
    try {
      await fetch(`http://localhost:${port}/menu?table=T01`, {
        headers: { "x-forwarded-for": "10.255.255.254" },
      });
    } catch {
      problems.push(
        `The app on port ${port} did not answer. Is another program using port ${port}?`,
      );
      continue;
    }
    if ((await fakeRequestCount()) <= before) {
      problems.push(
        `The app on port ${port} read data without contacting the test double (${FAKE_HOST}). It is using ` +
          "a different backend (a build made with NEXT_PUBLIC_SUPABASE_URL from your shell or .env.local) or " +
          `it is a stale server left on port ${port}. Stop whatever uses ports ${E2E_PORT}/${E2E_PUBLIC_PORT}, ` +
          "then run `pnpm e2e`.",
      );
    }
  }
  return problems;
}

/** Both checks, formatted for humans; empty when everything is wired correctly. */
export async function configurationReport() {
  const problems = [...staticProblems(), ...(await liveProblems())];
  return problems.length === 0
    ? ""
    : "\n\nE2E configuration check failed. No tests were run.\n\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n";
}
