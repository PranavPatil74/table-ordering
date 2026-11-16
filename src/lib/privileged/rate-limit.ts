import "server-only";

import { createHmac } from "node:crypto";

import { headers } from "next/headers";

import { getServerEnv } from "@/lib/env/server";

import { createServiceRoleClient } from "./service-client";

/**
 * A stable, non-reversible identity for the caller. The raw address is never stored or logged:
 * it is keyed-hashed with a server secret, so the rate-limit table cannot be turned back into IPs.
 */
async function clientFingerprint(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || h.get("x-real-ip") || "unknown";
  return createHmac("sha256", getServerEnv().supabaseServiceRoleKey)
    .update(address)
    .digest("hex")
    .slice(0, 32);
}

export type RateLimitResult = "allowed" | "limited" | "unavailable";

/**
 * Counts one hit against `route` for this caller. Fails CLOSED: if the limiter itself cannot be
 * reached, public lookups are refused rather than allowed unmetered.
 */
export async function hitRateLimit(
  route: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const bucket = `${route}:${await clientFingerprint()}`;
    const { data, error } = await createServiceRoleClient().rpc("check_rate_limit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
