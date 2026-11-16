import "server-only";

import { parseServerEnv, requireRazorpay, type RazorpayEnv, type ServerEnv } from "./schema";

let cached: ServerEnv | undefined;

/**
 * Full configuration including secrets. The `server-only` import above makes the build fail
 * if any client component (directly or transitively) imports this module, so service-role and
 * Razorpay secrets cannot leak into browser bundles by accident.
 *
 * Validation is lazy (first call) and memoised.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env, { nodeEnv: process.env.NODE_ENV });
  return cached;
}

/** Razorpay settings, or a clear error if payments are not configured yet. */
export function getRazorpayEnv(): RazorpayEnv {
  return requireRazorpay(getServerEnv());
}
