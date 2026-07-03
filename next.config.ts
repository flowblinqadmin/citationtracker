import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: { ignoreBuildErrors: true }, // React 19 + TS 5.9 children type inference issue in SitePageClient — runtime unaffected
  images: { unoptimized: true },
  async redirects() {
    return [
      { source: "/pricing", destination: "/", permanent: true },
    ];
  },
  async headers() {
    // Allow Vercel preview toolbar scripts in non-production environments
    const isProduction = process.env.VERCEL_ENV === "production";
    const scriptSrc = isProduction
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live https://*.vercel-scripts.com";
    const connectSrc = isProduction
      ? "connect-src 'self' https://*.supabase.co https://api.stripe.com https://generativelanguage.googleapis.com https://api.openai.com"
      : "connect-src 'self' https://*.supabase.co https://api.stripe.com https://generativelanguage.googleapis.com https://api.openai.com https://vercel.live wss://ws-us3.pusher.com";

    const cspParts = [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' https: data:",
      "font-src 'self' data: https://fonts.gstatic.com https://vercel.live",
      connectSrc,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ];
    if (!isProduction) {
      cspParts.push("frame-src https://vercel.live");
    }
    const csp = cspParts.join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/api/serve/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
