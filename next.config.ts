import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Multi-zone: geo.flowblinq.com rewrites /citations/* to this deployment.
  // NEXT_PUBLIC_BASE_PATH feeds lib/api-url.ts (raw client fetch() calls are
  // not auto-prefixed by Next).
  basePath: "/citations",
  env: { NEXT_PUBLIC_BASE_PATH: "/citations" },
  images: { unoptimized: true },
  async headers() {
    // Dev-only: webpack/turbopack dev runtimes execute modules via eval(),
    // which the strict prod CSP blocks (hydration dies with an EvalError —
    // caught by e2e in worktrees). Production output contains no eval; the
    // prod header must stay strict. NODE_ENV is read inside headers() so
    // tests can assert both variants.
    const dev = process.env.NODE_ENV === "development";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
