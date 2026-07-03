/**
 * API tests for GET /api/sites/[id]/citation-history — ES-016
 * CHR-1 through CHR-11
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from "@/app/api/sites/[id]/citation-history/route";
import { db } from "@/lib/db";

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_ID = "site-123";
const VALID_TOKEN = "valid-token";

const MOCK_SITE = {
  id: SITE_ID,
  domain: "flowblinq.com",
  accessToken: VALID_TOKEN,
  teamId: "team-1",
};

const makeScoreRow = (id: string, visibility: number, date: Date) => ({
  checkId: id,
  siteId: SITE_ID,
  teamId: "team-1",
  domain: "flowblinq.com",
  overallVisibility: visibility,
  bestProvider: "openai",
  worstProvider: null,
  avgPosition: 1,
  sentimentScore: 50,
  providerResults: [],
  competitorVisibility: {},
  creditsUsed: 5,
  promptsUsed: [],
  createdAt: date,
});

const ROUTE_PARAMS = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGetRequest(token?: string, searchParams: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/sites/${SITE_ID}/citation-history`);
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(url.toString(), { method: "GET", headers });
}

/** Queue the site lookup result (always first select call). */
function mockSiteSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  } as unknown as ReturnType<typeof db.select>);
}

/** Queue the history rows result and count result (2nd and 3rd select calls). */
function mockHistorySelect(rows: unknown[], total: number, onLimit?: (n: number) => void) {
  const limitFn = vi.fn().mockImplementation((n: number) => {
    onLimit?.(n);
    return Promise.resolve(rows);
  });
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
    }),
  } as unknown as ReturnType<typeof db.select>);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ count: total }]),
  } as unknown as ReturnType<typeof db.select>);
}

// ─── CHR-1 & CHR-2: Auth ─────────────────────────────────────────────────────

describe("citation-history-route — auth", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("CHR-1 — no auth token → 401", async () => {
    const req = makeGetRequest(); // no token
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Unauthorized/i);
  });

  it("CHR-2 — wrong token → 401", async () => {
    mockSiteSelect([MOCK_SITE]);
    const req = makeGetRequest("wrong-token");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
  });
});

// ─── CHR-3: Site not found ────────────────────────────────────────────────────

describe("citation-history-route — site gate", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("CHR-3 — site not found → 404", async () => {
    mockSiteSelect([]);
    const req = makeGetRequest(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Site not found/i);
  });
});

// ─── CHR-4 through CHR-11: Valid requests ────────────────────────────────────

describe("citation-history-route — valid requests", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("CHR-4 — valid request, no history → 200 with empty array and total:0", async () => {
    mockSiteSelect([MOCK_SITE]);
    mockHistorySelect([], 0);
    const req = makeGetRequest(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("CHR-5 — valid request, 3 records → 200 with array of 3 and total:3", async () => {
    const rows = [
      makeScoreRow("c1", 80, new Date("2025-03-01")),
      makeScoreRow("c2", 60, new Date("2025-02-01")),
      makeScoreRow("c3", 40, new Date("2025-01-01")),
    ];
    mockSiteSelect([MOCK_SITE]);
    mockHistorySelect(rows, 3);
    const req = makeGetRequest(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it("CHR-6 — no ?limit= → db queried with limit=10", async () => {
    let capturedLimit = -1;
    mockSiteSelect([MOCK_SITE]);
    mockHistorySelect([], 0, n => { capturedLimit = n; });
    const req = makeGetRequest(VALID_TOKEN); // no limit param
    await GET(req, ROUTE_PARAMS);
    expect(capturedLimit).toBe(10);
  });

  it("CHR-7 — ?limit=5 → db queried with limit=5", async () => {
    let capturedLimit = -1;
    mockSiteSelect([MOCK_SITE]);
    mockHistorySelect([], 0, n => { capturedLimit = n; });
    const req = makeGetRequest(VALID_TOKEN, { limit: "5" });
    await GET(req, ROUTE_PARAMS);
    expect(capturedLimit).toBe(5);
  });

  it("CHR-8 — limit=0 → 400 with Invalid limit error", async () => {
    mockSiteSelect([MOCK_SITE]);
    const req = makeGetRequest(VALID_TOKEN, { limit: "0" });
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid limit/i);
  });

  it("CHR-9 — limit=51 → 400 with Invalid limit error", async () => {
    mockSiteSelect([MOCK_SITE]);
    const req = makeGetRequest(VALID_TOKEN, { limit: "51" });
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid limit/i);
  });

  it("CHR-10 — limit=abc → 400 (non-integer string)", async () => {
    mockSiteSelect([MOCK_SITE]);
    const req = makeGetRequest(VALID_TOKEN, { limit: "abc" });
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid limit/i);
  });

  it("CHR-11 — records returned in the same order as DB provides (most-recent first)", async () => {
    const rows = [
      makeScoreRow("c1", 90, new Date("2025-03-01")),
      makeScoreRow("c2", 70, new Date("2025-02-01")),
    ];
    mockSiteSelect([MOCK_SITE]);
    mockHistorySelect(rows, 2);
    const req = makeGetRequest(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    const body = await res.json();
    expect(body.history[0].checkId).toBe("c1");
    expect(body.history[1].checkId).toBe("c2");
  });
});
