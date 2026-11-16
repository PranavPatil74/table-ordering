import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response.
 *
 * A Content-Security-Policy is intentionally NOT set here yet. Razorpay Checkout
 * and Supabase (REST + Realtime websockets) need carefully scoped allow-lists, and a
 * wrong CSP would silently break payments. It is scheduled for Phase 9 (hardening),
 * where it is tested against the real payment flow.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  // Normally `.next`. The E2E workflow (`pnpm e2e`) builds into `.next-e2e` instead, so a build made
  // for the test double can never replace, or be mistaken for, the build made from your real
  // `.env.local`. See e2e/env.mjs.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Cache Components / partial prefetching are deliberately OFF. This app is
  // request-dynamic almost everywhere (Supabase session cookies, live orders), so the
  // extra Suspense-boundary requirements would add friction without a real benefit.
  // See "Architecture decisions" in README.md.
  cacheComponents: false,
  partialPrefetching: false,
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Signed-in pages and APIs: never cached by the browser, a CDN or a shared proxy, and never
      // indexed. (Later rules win for the same header, so these override nothing above.)
      {
        source: "/staff/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/api/staff/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
