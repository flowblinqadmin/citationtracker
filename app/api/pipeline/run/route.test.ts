import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Mock runPipeline before importing the route so the mock is in place
vi.mock("@/lib/pipeline/runner", () => ({
  runPipeline: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocking
import { POST } from "./route";
import { runPipeline } from "@/lib/pipeline/runner";

const BASE_URL = "http://localhost/api/pipeline/run";
const TEST_SECRET = "test-cron-secret";
const SITE_PAYLOAD = { siteId: "site-abc", domain: "example.com" };

function makeRequest(
  body: Record<string, unknown>,
  options: { authHeader?: string } = {}
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.authHeader !== undefined) {
    headers["authorization"] = options.authHeader;
  }

  return new NextRequest(
    new Request(BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/pipeline/run — authentication", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = TEST_SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("returns 401 when no Authorization header", async () => {
    const req = makeRequest(SITE_PAYLOAD);
    const res = await POST(req);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("Unauthorized");
  });

  it("returns 401 when Authorization header has wrong secret", async () => {
    const req = makeRequest(SITE_PAYLOAD, {
      authHeader: "Bearer wrong-secret",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when CRON_SECRET env var is not set (fail closed)", async () => {
    delete process.env.CRON_SECRET;
    const req = makeRequest(SITE_PAYLOAD, {
      authHeader: `Bearer ${TEST_SECRET}`,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct secret in Authorization Bearer header", async () => {
    const req = makeRequest(SITE_PAYLOAD, {
      authHeader: `Bearer ${TEST_SECRET}`,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean };
    expect(json.success).toBe(true);
  });

  it("calls runPipeline with correct siteId and domain on success", async () => {
    const req = makeRequest(SITE_PAYLOAD, {
      authHeader: `Bearer ${TEST_SECRET}`,
    });
    await POST(req);
    expect(runPipeline).toHaveBeenCalledWith("site-abc", "example.com");
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

});

describe("POST /api/pipeline/run — request body validation", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = TEST_SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  const validAuth = { authHeader: `Bearer ${TEST_SECRET}` };

  it("returns 400 when siteId is missing", async () => {
    const req = makeRequest({ domain: "example.com" }, validAuth);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/siteId/i);
  });

  it("returns 400 when domain is missing", async () => {
    const req = makeRequest({ siteId: "site-abc" }, validAuth);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/domain/i);
  });

  it("returns 400 when both siteId and domain are missing", async () => {
    const req = makeRequest({}, validAuth);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("does NOT call runPipeline when body is invalid", async () => {
    const req = makeRequest({ domain: "example.com" }, validAuth);
    await POST(req);
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe("POST /api/pipeline/run — error handling", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = TEST_SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("returns 200 with success=false when runPipeline throws (errors saved to DB, not re-thrown)", async () => {
    vi.mocked(runPipeline).mockRejectedValueOnce(new Error("Pipeline exploded"));
    const req = makeRequest(SITE_PAYLOAD, {
      authHeader: `Bearer ${TEST_SECRET}`,
    });
    const res = await POST(req);
    // The route intentionally returns 200 even on pipeline failure to prevent
    // QStash from retrying (which would re-crawl the same site). Errors are
    // persisted to the DB by runPipeline() itself.
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });
});
