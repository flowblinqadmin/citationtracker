/**
 * Tests for auth proxy route — ES-007
 *
 * Suites:
 *   1. Request forwarding
 *   2. Response handling
 *   3. OPTIONS preflight
 *   4. Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));

import { GET, POST, PUT, PATCH, DELETE, OPTIONS } from "./route";
import { checkRateLimit } from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: BodyInit
): NextRequest {
  return new NextRequest(url, { method, headers, body });
}

function makeParams(path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

function mockUpstreamResponse(
  status: number,
  body: string | ArrayBuffer | null = "",
  headers: Record<string, string> = {}
): Response {
  // 204/304 responses cannot have a body per the fetch spec
  const responseBody = status === 204 || status === 304 ? null : body;
  return new Response(responseBody, { status, headers: new Headers(headers) });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://geo.flowblinq.com";

  fetchMock = vi.fn().mockResolvedValue(mockUpstreamResponse(200, "{}"));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, remaining: 29, resetAt: Date.now() + 60000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

// ─── Suite 1: Request Forwarding ──────────────────────────────────────────────

describe("Suite 1: request forwarding", () => {
  it("forwards GET to correct upstream path", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    await GET(req, makeParams(["user"]));

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe("https://test.supabase.co/auth/v1/user");
  });

  it("forwards multi-segment path for allowed top-level paths", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/verify/otp");
    await GET(req, makeParams(["verify", "otp"]));

    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("/auth/v1/verify/otp");
  });

  it("forwards query string", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/token?grant_type=refresh_token");
    await GET(req, makeParams(["token"]));

    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("grant_type=refresh_token");
  });

  it("always sets apikey header", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    await GET(req, makeParams(["user"]));

    const calledHeaders: Headers = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders.get("apikey")).toBe("test-anon-key");
  });

  it("sets default Authorization when absent", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    await GET(req, makeParams(["user"]));

    const calledHeaders: Headers = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders.get("authorization")).toBe("Bearer test-anon-key");
  });

  it("preserves explicit Authorization from request", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      authorization: "Bearer user-jwt",
    });
    await GET(req, makeParams(["user"]));

    const calledHeaders: Headers = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders.get("authorization")).toBe("Bearer user-jwt");
  });

  it("strips host from forwarded headers", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      host: "geo.flowblinq.com",
    });
    await GET(req, makeParams(["user"]));

    const calledHeaders: Headers = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders.get("host")).toBeNull();
  });

  it("strips x-forwarded-for from forwarded headers", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      "x-forwarded-for": "1.2.3.4",
    });
    await GET(req, makeParams(["user"]));

    const calledHeaders: Headers = fetchMock.mock.calls[0][1].headers;
    expect(calledHeaders.get("x-forwarded-for")).toBeNull();
  });

  it("forwards POST body as ArrayBuffer", async () => {
    const bodyContent = JSON.stringify({ email: "test@test.com", password: "pass" });
    const req = new NextRequest("https://geo.flowblinq.com/api/auth/proxy/token", {
      method: "POST",
      body: bodyContent,
      headers: { "content-type": "application/json" },
    });
    await POST(req, makeParams(["token"]));

    const calledBody: ArrayBuffer = fetchMock.mock.calls[0][1].body;
    expect(calledBody).toBeInstanceOf(ArrayBuffer);
    const decoded = new TextDecoder().decode(calledBody);
    expect(decoded).toBe(bodyContent);
  });

  it("sends no body on GET", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    await GET(req, makeParams(["user"]));

    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});

// ─── Suite 2: Response Handling ───────────────────────────────────────────────

describe("Suite 2: response handling", () => {
  it("returns upstream status 200", async () => {
    fetchMock.mockResolvedValueOnce(mockUpstreamResponse(200, "{}"));
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(200);
  });

  it("returns upstream status 401", async () => {
    fetchMock.mockResolvedValueOnce(mockUpstreamResponse(401, '{"message":"invalid_token"}'));
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(401);
  });

  it("returns upstream status 204 (sign-out)", async () => {
    fetchMock.mockResolvedValueOnce(mockUpstreamResponse(204));
    const req = makeRequest("POST", "https://geo.flowblinq.com/api/auth/proxy/logout");
    const res = await POST(req, makeParams(["logout"]));
    expect(res.status).toBe(204);
  });

  it("strips content-encoding from response", async () => {
    fetchMock.mockResolvedValueOnce(
      mockUpstreamResponse(200, "{}", { "content-encoding": "gzip" })
    );
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("strips transfer-encoding from response", async () => {
    fetchMock.mockResolvedValueOnce(
      mockUpstreamResponse(200, "{}", { "transfer-encoding": "chunked" })
    );
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("transfer-encoding")).toBeNull();
  });

  it("strips set-cookie from forwarded response headers", async () => {
    fetchMock.mockResolvedValueOnce(
      mockUpstreamResponse(200, "{}", { "set-cookie": "session=abc; Secure" })
    );
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets CORS Allow-Origin for allowed origin", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "https://geo.flowblinq.com",
    });
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://geo.flowblinq.com");
  });

  it("does not set CORS headers when request has no Origin", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not set CORS headers for unknown origins", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "https://evil.com",
    });
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("sets Access-Control-Allow-Credentials to true for allowed origin", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "https://geo.flowblinq.com",
    });
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allows localhost origins in development", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "http://localhost:3000",
    });
    const res = await GET(req, makeParams(["user"]));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});

// ─── Suite 3: OPTIONS Preflight ───────────────────────────────────────────────

describe("Suite 3: OPTIONS preflight", () => {
  it("returns 204", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
  });

  it("includes all allowed methods", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await OPTIONS(req);
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
  });

  it("includes required headers in Allow-Headers", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await OPTIONS(req);
    const allowedHeaders = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("apikey");
    expect(allowedHeaders).toContain("content-type");
  });

  it("sets Max-Age to 86400", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await OPTIONS(req);
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("sets Allow-Origin for permitted origin in preflight", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "https://geo.flowblinq.com",
    });
    const res = await OPTIONS(req);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://geo.flowblinq.com");
  });

  it("does not set Allow-Origin for unknown origin in preflight", async () => {
    const req = makeRequest("OPTIONS", "https://geo.flowblinq.com/api/auth/proxy/user", {
      origin: "https://attacker.com",
    });
    const res = await OPTIONS(req);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ─── Suite 4: Error Handling ──────────────────────────────────────────────────

describe("Suite 4: error handling", () => {
  it("returns 502 when upstream fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Upstream unavailable");
  });

  it("returns 500 when SUPABASE_URL is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Proxy misconfigured");
  });

  it("returns 500 when SUPABASE_ANON_KEY is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "";
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Proxy misconfigured");
  });

  it("returns 404 for non-allowlisted path (admin/*)", async () => {
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/admin/users");
    const res = await GET(req, makeParams(["admin", "users"]));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 429 when IP is rate limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60000 });
    const req = makeRequest("GET", "https://geo.flowblinq.com/api/auth/proxy/user");
    const res = await GET(req, makeParams(["user"]));
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
