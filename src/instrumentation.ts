import { parseServerEnv } from "@/lib/env/schema";

/**
 * Runs once when the Next.js server starts. Validating configuration here makes a
 * mis-configured deployment fail immediately with a readable list of problems, instead of
 * failing later on a customer's first request.
 *
 * Skipped during `next build` so CI can build without production secrets.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  parseServerEnv(process.env, { nodeEnv: process.env.NODE_ENV });
}
