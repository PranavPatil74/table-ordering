import { parsePublicEnv, type PublicEnv } from "./schema";

let cached: PublicEnv | undefined;

/**
 * Browser-safe configuration. Safe to import from client components.
 *
 * Each NEXT_PUBLIC_* variable is referenced with a literal `process.env.NAME` access because
 * Next.js inlines those at build time; passing `process.env` as a whole would NOT work in the
 * browser bundle. Validation is lazy (first call), so `next build` does not need secrets.
 */
export function getPublicEnv(): PublicEnv {
  cached ??= parsePublicEnv(
    {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    { nodeEnv: process.env.NODE_ENV },
  );
  return cached;
}
