import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock Supabase updateSession — returns pass-through for all requests.
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (_req: NextRequest) => NextResponse.next()),
}));

import { middleware } from "../middleware";

const GOOD_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function makeRequest(
  path: string,
  opts?: { method?: string; ua?: string }
): NextRequest {
  const method = opts?.method ?? "GET";
  const ua = opts?.ua ?? GOOD_UA;
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "user-agent": ua },
    })
  );
}

describe("middleware — commerce audit routes are public", () => {
  it("POST /api/audit is accessible without auth", async () => {
    const req = makeRequest("/api/audit", { method: "POST" });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("POST /api/audit/abc123/verify is accessible without auth", async () => {
    const req = makeRequest("/api/audit/abc123/verify", { method: "POST" });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /api/audit/abc123 is accessible without auth", async () => {
    const req = makeRequest("/api/audit/abc123");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /audit/abc123 page is accessible without auth", async () => {
    const req = makeRequest("/audit/abc123");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /audit/abc123/verify page is accessible without auth", async () => {
    const req = makeRequest("/audit/abc123/verify");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe("middleware — payment-first subscription signup is public", () => {
  it("POST /api/subscription-signup/checkout is accessible without auth", async () => {
    // Regression guard: the route is unauthenticated by design (rate-limited in
    // the handler). If it's dropped from ALWAYS_ALLOWED, the live pricing CTA 403s.
    const req = makeRequest("/api/subscription-signup/checkout", { method: "POST" });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe("middleware — Firecrawl pipeline webhook is public", () => {
  it("POST /api/pipeline/crawl-webhook is accessible without auth", async () => {
    // Regression guard: Firecrawl webhook callbacks authenticate via the
    // x-webhook-secret (CRON_SECRET) header in the route handler, NOT middleware.
    // If dropped from ALWAYS_ALLOWED, callbacks 403 → crawl_chunks_done never
    // increments → merge-crawl never enqueues → audit-purchase polls into a 404 loop.
    const req = makeRequest("/api/pipeline/crawl-webhook", { method: "POST" });
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /api/pipeline/other-route is NOT auto-allowed by the webhook rule", async () => {
    // The allowlist entry is anchored to exactly /api/pipeline/crawl-webhook.
    const req = makeRequest("/api/pipeline/other-route");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });
});

describe("middleware — non-audit protected routes still require auth", () => {
  it("GET /api/sites/abc123 is allowed through middleware (auth enforced in route handler)", async () => {
    // /api/sites/[id] is in ALWAYS_ALLOWED — middleware passes it through,
    // but this test documents that it IS in the allowlist (route-level auth applies).
    const req = makeRequest("/api/sites/abc123");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /dashboard is allowed through middleware (Supabase middleware handles auth)", async () => {
    // /dashboard is in ALWAYS_ALLOWED — Supabase middleware handles the redirect.
    const req = makeRequest("/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /settings is blocked by middleware (not in allowlist)", async () => {
    const req = makeRequest("/settings");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("GET /admin is blocked by middleware (not in allowlist)", async () => {
    const req = makeRequest("/admin");
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });
});

describe("middleware — parts intel API is public", () => {
  it("GET /api/parts/intel is allowed through middleware", async () => {
    const req = makeRequest("/api/parts/intel");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /api/parts/intel?seller=demo is allowed through middleware", async () => {
    const req = makeRequest("/api/parts/intel?seller=demo");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("GET /parts-dashboard.html is allowed through middleware", async () => {
    const req = makeRequest("/parts-dashboard.html");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });
});

describe("middleware — commerce audit routes get security headers", () => {
  it("sets security headers on /api/audit responses", async () => {
    const req = makeRequest("/api/audit/abc123");
    const res = await middleware(req);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=/);
  });

  it("sets security headers on /audit/ page responses", async () => {
    const req = makeRequest("/audit/abc123");
    const res = await middleware(req);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
