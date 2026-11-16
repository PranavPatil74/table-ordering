import "server-only";

import { resolveQrBaseUrl, type QrBaseUrlSource } from "./schema";

/**
 * The origin table QR codes point to, read from the process environment on EVERY call.
 *
 * `APP_BASE_URL` is deliberately not NEXT_PUBLIC_: it is never inlined into the build, so the same
 * production build can run at different addresses (and tests can run two servers from one build).
 * Falls back to NEXT_PUBLIC_APP_URL for setups that only have that. Only call this from code that
 * runs per request (pages and route handlers that already read cookies), never at module load.
 */
export function getQrBaseUrl(): { origin: string; source: QrBaseUrlSource } {
  return resolveQrBaseUrl(
    {
      APP_BASE_URL: process.env.APP_BASE_URL,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    },
    { nodeEnv: process.env.NODE_ENV },
  );
}
