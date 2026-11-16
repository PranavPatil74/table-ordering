/**
 * Environment variable contract for Sandwich Express.
 *
 * This module is PURE: it only parses a plain object, never reads `process.env` and never
 * imports `server-only`. That keeps it unit-testable and lets `instrumentation.ts` validate
 * configuration at server start. Runtime accessors live in `./public.ts` (browser-safe) and
 * `./server.ts` (server-only, may expose secrets).
 *
 * Rules:
 *  - Variables prefixed NEXT_PUBLIC_ are inlined into browser JavaScript. They must NEVER hold
 *    a secret. Only the Supabase *publishable* key and public URLs belong there.
 *  - Secrets (service role key, Razorpay secret, webhook secret) are server-only.
 *  - Error messages name variables and problems but NEVER echo values.
 */
import { z } from "zod";

/** Every variable the app reads. `.env.example` must document each one (enforced by a test). */
export const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
] as const;

export const SERVER_ONLY_ENV_KEYS = [
  // Not a secret, but deliberately NOT NEXT_PUBLIC_: Next.js freezes NEXT_PUBLIC_ values into the
  // build, while this one is read at RUNTIME so one build can serve any origin (see getQrBaseUrl).
  "APP_BASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

export const ALL_ENV_KEYS = [...PUBLIC_ENV_KEYS, ...SERVER_ONLY_ENV_KEYS] as const;

export type RawEnv = Record<string, string | undefined>;

export interface ParseOptions {
  /** Usually `process.env.NODE_ENV`. Production is stricter (https, no placeholders). */
  nodeEnv?: string | undefined;
}

/** Blank values in a copied `.env.local` mean "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const requiredString = z.preprocess(
  blankToUndefined,
  z.string("Required").trim().min(1, "Required"),
);

const optionalString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());

/** Values copied from `.env.example` that must never reach a production deployment. */
const PLACEHOLDER = /^(your-|replace-me|changeme|<)/i;

const isLocalHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

const urlOrigin = () =>
  z
    .string("Required")
    .trim()
    // Zod runs every check even after one fails, so each follow-up check below must tolerate
    // input that is not a parseable URL (it passes in that case; "Must be a valid URL" already
    // reports it) instead of throwing from `new URL(...)`.
    .refine((value) => URL.canParse(value), "Must be a valid URL")
    .refine((value) => {
      if (!URL.canParse(value)) return true;
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    }, "Must start with http:// or https://")
    .refine((value) => {
      if (!URL.canParse(value)) return true;
      const url = new URL(value);
      return url.pathname === "/" && url.search === "" && url.hash === "";
    }, "Must be an origin only (no path, query or fragment), e.g. https://orders.example.com")
    .transform((value) => (URL.canParse(value) ? new URL(value).origin : value));

const publicShape = {
  // Blank is normalised to "unset" BEFORE optionality is applied, so `NEXT_PUBLIC_APP_URL=`
  // in a copied .env.local behaves exactly like the variable being absent.
  NEXT_PUBLIC_APP_URL: z.preprocess(blankToUndefined, urlOrigin().optional()),
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(blankToUndefined, urlOrigin()),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: requiredString,
};

const serverShape = {
  APP_BASE_URL: z.preprocess(blankToUndefined, urlOrigin().optional()),
  SUPABASE_SERVICE_ROLE_KEY: requiredString,
  RAZORPAY_KEY_ID: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "Must look like rzp_test_xxxx or rzp_live_xxxx")
      .optional(),
  ),
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
};

export type RazorpayMode = "test" | "live";

export interface RazorpayEnv {
  mode: RazorpayMode;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface PublicEnv {
  /** Public origin used to build table QR links. Defaults to http://localhost:3000 outside production. */
  appUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export interface ServerEnv extends PublicEnv {
  supabaseServiceRoleKey: string;
  /** `null` until all three Razorpay variables are configured. */
  razorpay: RazorpayEnv | null;
}

export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...problems.map((problem) => `  - ${problem}`),
        "See .env.example and the README (Environment variables) for what each variable means.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join(".") : "(environment)";
    return `${name}: ${issue.message}`;
  });
}

function pickKeys<K extends string>(
  raw: RawEnv,
  keys: readonly K[],
): Record<K, string | undefined> {
  const picked = {} as Record<K, string | undefined>;
  for (const key of keys) picked[key] = raw[key];
  return picked;
}

function resolveAppUrl(
  appUrl: string | undefined,
  nodeEnv: string | undefined,
  problems: string[],
  name = "NEXT_PUBLIC_APP_URL",
): string {
  if (!appUrl) {
    if (nodeEnv === "production") {
      problems.push(`${name}: Required in production (public origin used in table QR codes)`);
    }
    return "http://localhost:3000";
  }
  if (nodeEnv === "production") {
    const { protocol, hostname } = new URL(appUrl);
    if (protocol !== "https:" && !isLocalHost(hostname)) {
      problems.push(`${name}: Must use https:// in production`);
    }
  }
  return appUrl;
}

export type QrBaseUrlSource = "APP_BASE_URL" | "NEXT_PUBLIC_APP_URL" | "default";

/**
 * The origin that table QR codes point to, decided at RUNTIME from `APP_BASE_URL` (preferred) or
 * the older `NEXT_PUBLIC_APP_URL` (fallback). Pure: callers pass the raw values.
 *
 * Why two names: Next.js inlines every NEXT_PUBLIC_ variable into the production build, so a build
 * made with one value serves that value forever. `APP_BASE_URL` has no such prefix, is read from
 * the process environment each time, and therefore always reflects the server's current setting.
 * Production rules are unchanged: required, and https unless it is a local address (the QR export
 * policy separately refuses to print a local address in production).
 */
export function resolveQrBaseUrl(
  raw: RawEnv,
  options: ParseOptions = {},
): { origin: string; source: QrBaseUrlSource } {
  const parsed = z
    .object({
      APP_BASE_URL: serverShape.APP_BASE_URL,
      NEXT_PUBLIC_APP_URL: publicShape.NEXT_PUBLIC_APP_URL,
    })
    .safeParse(pickKeys(raw, ["APP_BASE_URL", "NEXT_PUBLIC_APP_URL"] as const));
  const problems = parsed.success ? [] : formatIssues(parsed.error);

  const preferred = parsed.success ? parsed.data.APP_BASE_URL : undefined;
  const legacy = parsed.success ? parsed.data.NEXT_PUBLIC_APP_URL : undefined;
  const source: QrBaseUrlSource = preferred
    ? "APP_BASE_URL"
    : legacy
      ? "NEXT_PUBLIC_APP_URL"
      : "default";
  const origin = resolveAppUrl(
    preferred ?? legacy,
    options.nodeEnv,
    problems,
    source === "NEXT_PUBLIC_APP_URL" ? "NEXT_PUBLIC_APP_URL" : "APP_BASE_URL",
  );
  if (problems.length > 0) throw new EnvValidationError(problems);
  return { origin, source };
}

function checkProductionPlaceholders(raw: RawEnv, keys: readonly string[], problems: string[]) {
  for (const key of keys) {
    const value = raw[key]?.trim();
    if (value && PLACEHOLDER.test(value)) {
      problems.push(`${key}: Still set to a placeholder from .env.example; set the real value`);
    }
  }
}

/** Parse the browser-safe variables (the only ones that may appear in client bundles). */
export function parsePublicEnv(raw: RawEnv, options: ParseOptions = {}): PublicEnv {
  const result = z.object(publicShape).safeParse(pickKeys(raw, PUBLIC_ENV_KEYS));
  const problems = result.success ? [] : formatIssues(result.error);

  const appUrl = resolveAppUrl(
    result.success ? result.data.NEXT_PUBLIC_APP_URL : undefined,
    options.nodeEnv,
    problems,
  );

  if (options.nodeEnv === "production") {
    checkProductionPlaceholders(raw, PUBLIC_ENV_KEYS, problems);
  }

  if (!result.success || problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  return {
    appUrl,
    supabaseUrl: result.data.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: result.data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

/** Parse everything, including secrets. Only call from server code. */
export function parseServerEnv(raw: RawEnv, options: ParseOptions = {}): ServerEnv {
  const result = z
    .object({ ...publicShape, ...serverShape })
    .safeParse(pickKeys(raw, ALL_ENV_KEYS));
  const problems = result.success ? [] : formatIssues(result.error);

  const appUrl = resolveAppUrl(
    result.success ? result.data.NEXT_PUBLIC_APP_URL : undefined,
    options.nodeEnv,
    problems,
  );

  if (result.success) {
    const data = result.data;

    if (data.APP_BASE_URL) {
      resolveAppUrl(data.APP_BASE_URL, options.nodeEnv, problems, "APP_BASE_URL");
    }

    // Guard against pasting the wrong Supabase key into the secret slot.
    if (
      data.SUPABASE_SERVICE_ROLE_KEY === data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      data.SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_publishable_")
    ) {
      problems.push(
        "SUPABASE_SERVICE_ROLE_KEY: Looks like the publishable/anon key. Use the service role (secret) key",
      );
    }

    // Razorpay is all-or-nothing: a half-configured gateway is a silent footgun.
    const razorpayValues = [
      data.RAZORPAY_KEY_ID,
      data.RAZORPAY_KEY_SECRET,
      data.RAZORPAY_WEBHOOK_SECRET,
    ];
    const razorpaySet = razorpayValues.filter((value) => value !== undefined).length;
    if (razorpaySet > 0 && razorpaySet < 3) {
      problems.push(
        "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET: Set all three or none",
      );
    }
  }

  if (options.nodeEnv === "production") {
    checkProductionPlaceholders(raw, ALL_ENV_KEYS, problems);
  }

  if (!result.success || problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  const data = result.data;
  const razorpay: RazorpayEnv | null =
    data.RAZORPAY_KEY_ID && data.RAZORPAY_KEY_SECRET && data.RAZORPAY_WEBHOOK_SECRET
      ? {
          mode: data.RAZORPAY_KEY_ID.startsWith("rzp_live_") ? "live" : "test",
          keyId: data.RAZORPAY_KEY_ID,
          keySecret: data.RAZORPAY_KEY_SECRET,
          webhookSecret: data.RAZORPAY_WEBHOOK_SECRET,
        }
      : null;

  return {
    appUrl,
    supabaseUrl: data.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    supabaseServiceRoleKey: data.SUPABASE_SERVICE_ROLE_KEY,
    razorpay,
  };
}

/** Payment code calls this so a missing gateway fails loudly instead of "working" fake. */
export function requireRazorpay(env: ServerEnv): RazorpayEnv {
  if (!env.razorpay) {
    throw new EnvValidationError([
      "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET: Payments are not configured; set all three (test-mode keys are fine)",
    ]);
  }
  return env.razorpay;
}
