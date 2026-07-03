// Middleware route matrix — the complete access policy for this service.
//
// Policy: default-deny. Only static assets and /api/cron/* (route-level
// CRON_SECRET auth) skip the Supabase session. Every other path requires an
// authenticated session: pages redirect to geo's login, API routes get 401.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const updateSessionMock = vi.fn();
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: (req: NextRequest) => updateSessionMock(req),
}));

import { middleware } from "./middleware";

function req(path: string, ua = "Mozilla/5.0"): NextRequest {
  return new NextRequest(`https://geo.flowblinq.com${path}`, {
    headers: ua ? { "user-agent": ua } : {},
  });
}

function authedResponse(): NextResponse {
  const res = NextResponse.next();
  res.headers.set("x-user-id", "user_123");
  res.headers.set("x-user-email", "a@b.com");
  return res;
}

beforeEach(() => {
  updateSessionMock.mockReset();
});

describe("blocklists", () => {
  it("blocks scanner user agents with 403", async () => {
    const res = await middleware(req("/", "sqlmap/1.0"));
    expect(res.status).toBe(403);
  });

  it("blocks probe paths with 403", async () => {
    const res = await middleware(req("/wp-admin/setup.php"));
    expect(res.status).toBe(403);
  });
});

describe("anonymous-public paths (no session constructed)", () => {
  it.each(["/_next/static/chunk.js", "/favicon.ico", "/icon.svg"])(
    "%s passes without calling updateSession",
    async (path) => {
      const res = await middleware(req(path));
      expect(res.status).toBe(200);
      expect(updateSessionMock).not.toHaveBeenCalled();
    },
  );

  it("/api/cron/reconcile passes without session (auth is in the route)", async () => {
    const res = await middleware(req("/api/cron/reconcile"));
    expect(res.status).toBe(200);
    expect(updateSessionMock).not.toHaveBeenCalled();
  });
});

describe("session-gated paths — unauthenticated", () => {
  beforeEach(() => {
    updateSessionMock.mockResolvedValue(NextResponse.next()); // no x-user-id
  });

  it.each([
    "/api/brands",
    "/api/brands/cl_1/prompts",
    "/api/brands/cl_1/run",
    "/api/teams/me",
  ])("%s returns 401 JSON", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it.each(["/", "/brands/cl_1"])("page %s redirects to geo login", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/auth/login");
    expect(location).toContain(encodeURIComponent("/citations"));
  });
});

describe("session-gated paths — authenticated", () => {
  beforeEach(() => {
    updateSessionMock.mockResolvedValue(authedResponse());
  });

  it("passes API requests through with identity headers", async () => {
    const res = await middleware(req("/api/brands"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-user-id")).toBe("user_123");
  });

  it("passes pages through", async () => {
    const res = await middleware(req("/"));
    expect(res.status).toBe(200);
  });

  it("stamps security headers", async () => {
    const res = await middleware(req("/"));
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age");
  });
});
