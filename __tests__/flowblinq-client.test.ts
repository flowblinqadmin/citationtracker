/**
 * Unit tests for lib/flowblinq-client/ — FlowblinqClient class
 *
 * ES-021 Unit Test Plan (C-1 through C-14)
 *
 * Constructor:
 *   C-1  Missing clientId → throws Error
 *   C-2  Missing clientSecret → throws Error
 *
 * Token caching (ensureToken):
 *   C-3  getAccount() called twice → fetch for /api/oauth/token called once
 *   C-4  Cached token expires in <60s → token refreshed before request
 *   C-5  Cached token expires in >60s → cached token reused
 *
 * Timeout (rawFetch):
 *   C-6  fetch hangs beyond timeoutMs → rejects with FlowblinqApiError code='timeout'
 *
 * Error handling (handleApiResponse):
 *   C-7  401 response body { error: 'invalid_client' } → throws FlowblinqApiError status=401
 *   C-8  402 response → throws FlowblinqApiError status=402
 *
 * Poll state machine (pollAudit):
 *   C-9  First poll → pending, second poll → complete → resolves after 2 polls
 *   C-10 First poll → failed → rejects with code='pipeline_failed'
 *   C-11 Deadline exceeded before completion → rejects with code='poll_timeout'
 *
 * Mapping:
 *   C-12 mapAuditResponse: snake_case API response → camelCase AuditResponse (all fields)
 *
 * FlowblinqApiError:
 *   C-13 instanceof Error check passes; .name = 'FlowblinqApiError'; .status and .code set
 *
 * MCP manifest (no auth):
 *   C-14 getMcpManifest() calls /api/v1/mcp WITHOUT Authorization header
 *
 * Mocks: vi.stubGlobal('fetch', ...) — no real network calls
 * Timers: vi.useFakeTimers() for C-6, C-9, C-10, C-11
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FlowblinqClient, FlowblinqApiError } from "@/lib/flowblinq-client";
import type { TokenCache } from "@/lib/flowblinq-client";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLIENT_ID = "test-client-id-24chars";
const CLIENT_SECRET = "test-client-secret-32chars-nano";
const BASE_URL = "https://geo.flowblinq.com";

const TOKEN_BODY = {
  access_token: "eyJhbGciOiJIUzI1NiJ9.test-payload.test-sig",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "audit:read audit:write account:read",
};

const ACCOUNT_BODY = {
  team_id: "team-integration-test",
  credit_balance: 100,
  free_optimization_domains: 5,
  credits_purchase_url: "https://geo.flowblinq.com/pricing",
};

const AUDIT_SNAKE_BODY = {
  audit_id: "site-id-001",
  domain: "example.com",
  status: "complete",
  overall_score: 78,
  free_run_number: 1,
  scorecard: {
    overallScore: 78,
    pillars: [
      {
        pillar: "citations",
        pillarName: "Citations",
        score: 72,
        findings: "Low citation count",
        recommendation: "Build more backlinks",
        priority: "high",
      },
    ],
    topThreeImprovements: ["Add llms.txt", "Improve schema"],
  },
  recommendations: ["Add llms.txt"],
  executive_summary: "Score: 78/100",
  files: {
    llms_txt_url: "https://geo.flowblinq.com/api/serve/example-com/llms.txt",
    business_json_url: "https://geo.flowblinq.com/api/serve/example-com/business.json",
    schema_json_url: "https://geo.flowblinq.com/api/serve/example-com/schema.json",
  },
  created_at: "2026-03-01T00:00:00Z",
  completed_at: "2026-03-01T01:00:00Z",
};

const MCP_MANIFEST_BODY = {
  protocol: "mcp",
  version: "1.0",
  auth: {
    type: "oauth2",
    tokenUrl: "https://geo.flowblinq.com/api/oauth/token",
    grantType: "client_credentials",
    scopes: ["audit:read", "audit:write", "account:read"],
  },
  tools: [
    { name: "run_audit", description: "Submit a URL for audit", inputSchema: { type: "object" } },
    { name: "get_audit", description: "Get audit result", inputSchema: { type: "object" } },
    { name: "verify_optimization", description: "Trigger second run", inputSchema: { type: "object" } },
    { name: "get_account", description: "Get account info", inputSchema: { type: "object" } },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
  };
}

/** Returns a mock fetch that serves responses in sequence (last one repeats). */
function makeMockFetch(responses: Array<{ status: number; body: unknown }>) {
  let idx = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(idx++, responses.length - 1)];
    return mockResponse(r.status, r.body);
  });
}

/** Access private tokenCache via type cast (test-only). */
function getTokenCache(client: FlowblinqClient): TokenCache | null {
  return (client as unknown as { tokenCache: TokenCache | null }).tokenCache;
}

/** Inject a token cache entry directly. */
function setTokenCache(client: FlowblinqClient, cache: TokenCache | null): void {
  (client as unknown as { tokenCache: TokenCache | null }).tokenCache = cache;
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe("FlowblinqClient — constructor", () => {
  it("C-1: missing clientId → throws Error", () => {
    expect(
      () => new FlowblinqClient({ clientId: "", clientSecret: "secret" })
    ).toThrow(/clientId/i);
  });

  it("C-2: missing clientSecret → throws Error", () => {
    expect(
      () => new FlowblinqClient({ clientId: "cid", clientSecret: "" })
    ).toThrow(/clientSecret/i);
  });

  it("C-2b: undefined clientSecret → throws Error", () => {
    expect(
      () =>
        new FlowblinqClient({
          clientId: "cid",
          clientSecret: undefined as unknown as string,
        })
    ).toThrow();
  });
});

// ─── Token caching ────────────────────────────────────────────────────────────

describe("FlowblinqClient — token caching (ensureToken)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeMockFetch([
      { status: 200, body: TOKEN_BODY },   // token acquisition
      { status: 200, body: ACCOUNT_BODY }, // first getAccount
      { status: 200, body: ACCOUNT_BODY }, // second getAccount (no second token fetch)
    ]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("C-3: two getAccount() calls → /api/oauth/token fetched only once", async () => {
    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    await client.getAccount();
    await client.getAccount();

    const tokenCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url.includes("/api/oauth/token")
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("C-4: cached token expiring in <60s → token re-fetched before request", async () => {
    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    // Inject a nearly-expired token (expires in 30s — inside 60s buffer)
    setTokenCache(client, {
      value: "nearly-expired-token",
      expiresAt: Date.now() + 30_000,
    });

    // Reset fetch mock to capture the token re-fetch
    fetchMock = makeMockFetch([
      { status: 200, body: TOKEN_BODY },
      { status: 200, body: ACCOUNT_BODY },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await client.getAccount();

    const tokenCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url.includes("/api/oauth/token")
    );
    expect(tokenCalls).toHaveLength(1); // re-fetched
    expect(getTokenCache(client)?.value).toBe(TOKEN_BODY.access_token);
  });

  it("C-5: cached token expiring in >60s → cached token reused, no re-fetch", async () => {
    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    // Inject a fresh token (expires in 90s — outside 60s buffer)
    const freshToken = "fresh-valid-token";
    setTokenCache(client, {
      value: freshToken,
      expiresAt: Date.now() + 90_000,
    });

    fetchMock = makeMockFetch([
      { status: 200, body: ACCOUNT_BODY }, // only getAccount, no token fetch
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await client.getAccount();

    const tokenCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url.includes("/api/oauth/token")
    );
    expect(tokenCalls).toHaveLength(0); // no re-fetch
  });
});

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe("FlowblinqClient — rawFetch timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("C-6: fetch hangs beyond timeoutMs → rejects with FlowblinqApiError code='timeout'", async () => {
    vi.useFakeTimers();

    // fetch never resolves
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {}))
    );

    const client = new FlowblinqClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 100,
    });

    // getMcpManifest uses rawFetch directly (no auth — simpler to test)
    const reqPromise = client.getMcpManifest();

    await vi.advanceTimersByTimeAsync(200);

    await expect(reqPromise).rejects.toThrow(FlowblinqApiError);
    await expect(reqPromise).rejects.toMatchObject({
      code: "timeout",
      status: 0,
    });
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("FlowblinqClient — handleApiResponse error shapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("C-7: 401 response { error: 'invalid_client' } → FlowblinqApiError status=401", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch([
        { status: 401, body: { error: "invalid_client", message: "Invalid credentials" } },
      ])
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    await expect(client.getAccount()).rejects.toMatchObject({
      name: "FlowblinqApiError",
      status: 401,
    });
  });

  it("C-8: 402 response → FlowblinqApiError status=402", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch([
        { status: 200, body: TOKEN_BODY },
        { status: 402, body: { error: "free_tier_exhausted", message: "Free tier exhausted" } },
      ])
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    await expect(
      client.submitAudit({ url: "https://example.com" })
    ).rejects.toMatchObject({
      name: "FlowblinqApiError",
      status: 402,
    });
  });
});

// ─── pollAudit state machine ──────────────────────────────────────────────────

describe("FlowblinqClient — pollAudit", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("C-9: pending → pending → complete → resolves with complete response after 2 polls", async () => {
    vi.useFakeTimers();

    let auditCallIdx = 0;
    const auditResponses = [
      { status: "pending", overall_score: null },
      { status: "pending", overall_score: null },
      { status: "complete", overall_score: 78 },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/oauth/token")) {
          return mockResponse(200, TOKEN_BODY);
        }
        const body = {
          ...AUDIT_SNAKE_BODY,
          ...auditResponses[Math.min(auditCallIdx++, auditResponses.length - 1)],
        };
        return mockResponse(200, body);
      })
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const INTERVAL = 1_000;

    const pollPromise = client.pollAudit("site-id-001", { intervalMs: INTERVAL });

    // Advance through 3 poll intervals
    await vi.advanceTimersByTimeAsync(INTERVAL + 10);
    await vi.advanceTimersByTimeAsync(INTERVAL + 10);
    await vi.advanceTimersByTimeAsync(INTERVAL + 10);

    const result = await pollPromise;
    expect(result.status).toBe("complete");
    expect(result.overallScore).toBe(78);
  });

  it("C-10: first poll returns failed → rejects with code='pipeline_failed'", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/oauth/token")) {
          return mockResponse(200, TOKEN_BODY);
        }
        return mockResponse(200, { ...AUDIT_SNAKE_BODY, status: "failed" });
      })
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const pollPromise = client.pollAudit("site-id-001", { intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_100);

    await expect(pollPromise).rejects.toMatchObject({
      code: "pipeline_failed",
    });
  });

  it("C-11: deadline exceeded before completion → rejects with code='poll_timeout'", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/api/oauth/token")) {
          return mockResponse(200, TOKEN_BODY);
        }
        // Always pending
        return mockResponse(200, { ...AUDIT_SNAKE_BODY, status: "pending" });
      })
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const pollPromise = client.pollAudit("site-id-001", {
      intervalMs: 500,
      timeoutMs: 1_500,
    });

    // Advance past the deadline (1500ms)
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pollPromise).rejects.toMatchObject({
      code: "poll_timeout",
      status: 0,
    });
  });
});

// ─── mapAuditResponse ─────────────────────────────────────────────────────────

describe("FlowblinqClient — mapAuditResponse (via getAudit)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("C-12: snake_case API response → camelCase AuditResponse with all fields correct", async () => {
    vi.stubGlobal(
      "fetch",
      makeMockFetch([
        { status: 200, body: TOKEN_BODY },
        { status: 200, body: AUDIT_SNAKE_BODY },
      ])
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const audit = await client.getAudit("site-id-001");

    expect(audit.auditId).toBe("site-id-001");
    expect(audit.domain).toBe("example.com");
    expect(audit.status).toBe("complete");
    expect(audit.overallScore).toBe(78);
    expect(audit.freeRunNumber).toBe(1);
    expect(audit.scorecard).toBeDefined();
    expect(audit.scorecard?.pillars).toHaveLength(1);
    expect(audit.scorecard?.topThreeImprovements).toContain("Add llms.txt");
    expect(audit.recommendations).toEqual(["Add llms.txt"]);
    expect(audit.executiveSummary).toBe("Score: 78/100");
    expect(audit.files.llmsTxtUrl).toContain("example-com");
    expect(audit.files.businessJsonUrl).toContain("business.json");
    expect(audit.files.schemaJsonUrl).toContain("schema.json");
    expect(audit.createdAt).toBe("2026-03-01T00:00:00Z");
    expect(audit.completedAt).toBe("2026-03-01T01:00:00Z");
    // Verify snake_case keys are NOT present on the result
    expect((audit as Record<string, unknown>)["audit_id"]).toBeUndefined();
    expect((audit as Record<string, unknown>)["overall_score"]).toBeUndefined();
  });
});

// ─── FlowblinqApiError ────────────────────────────────────────────────────────

describe("FlowblinqApiError", () => {
  it("C-13: instanceof Error and instanceof FlowblinqApiError; name/status/code set", () => {
    const err = new FlowblinqApiError("Invalid credentials", 401, "invalid_client");

    expect(err instanceof Error).toBe(true);
    expect(err instanceof FlowblinqApiError).toBe(true);
    expect(err.name).toBe("FlowblinqApiError");
    expect(err.message).toBe("Invalid credentials");
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_client");
  });

  it("C-13b: error codes are preserved as-is", () => {
    const codes = [
      "auth_failed", "invalid_client", "client_revoked", "insufficient_scope",
      "free_tier_exhausted", "rate_limit_exceeded", "not_found",
      "pipeline_failed", "poll_timeout", "timeout", "api_error",
    ];
    for (const code of codes) {
      const err = new FlowblinqApiError("msg", 400, code);
      expect(err.code).toBe(code);
    }
  });
});

// ─── getMcpManifest — no auth ─────────────────────────────────────────────────

describe("FlowblinqClient — getMcpManifest (no auth)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("C-14: getMcpManifest calls /api/v1/mcp WITHOUT Authorization header", async () => {
    const capturedRequests: { url: string; init?: RequestInit }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedRequests.push({ url, init });
        return mockResponse(200, MCP_MANIFEST_BODY);
      })
    );

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const manifest = await client.getMcpManifest();

    expect(capturedRequests).toHaveLength(1);
    const [{ url, init }] = capturedRequests;

    // Correct endpoint
    expect(url).toContain("/api/v1/mcp");

    // No Authorization header
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();

    // Shape of returned manifest
    expect(manifest.protocol).toBe("mcp");
    expect(manifest.version).toBe("1.0");
    expect(manifest.tools).toHaveLength(4);
    expect(manifest.tools.map((t) => t.name)).toContain("run_audit");
    expect(manifest.tools.map((t) => t.name)).toContain("get_audit");
  });

  it("C-14b: no token fetch happens when calling getMcpManifest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, MCP_MANIFEST_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlowblinqClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await client.getMcpManifest();

    const tokenCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      url.includes("/api/oauth/token")
    );
    expect(tokenCalls).toHaveLength(0);
  });
});
