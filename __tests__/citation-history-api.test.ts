/**
 * Unit tests for GET /api/sites/[id]/citation-history — ES-016
 * U-1 through U-12
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

const SITE_ID = "site-abc";
const VALID_TOKEN = "tok-valid";

const MOCK_SITE = {
  id: SITE_ID,
  domain: "example.com",
  accessToken: VALID_TOKEN,
};

const MOCK_SCORE = {
  checkId: "chk-1",
  siteId: SITE_ID,
  domain: "example.com",
  teamId: "team-1",
  overallVisibility: 70,
  bestProvider: "openai",
  worstProvider: null,
  avgPosition: 2,
  sentimentScore: 50,
  providerResults: [],
  competitorVisibility: {},
  creditsUsed: 5,
  promptsUsed: [],
  createdAt: new Date("2026-03-01"),
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: SITE_ID }) };

// ─── Chain builders ────────────────────────────────────────────────────────────

/** Chain that resolves at .where() */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function siteChain(rows: unknown[]): any {
  const c: Record<string, ReturnType<typeof vi.fn>> = {
    from: vi.fn(),
    where: vi.fn(),
  };
  c.from.mockReturnValue(c);
  c.where.mockResolvedValue(rows);
  return c;
}

/** Chain that resolves at .limit() after .where().orderBy() */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsChain(rows: unknown[]): any {
  const c: Record<string, ReturnType<typeof vi.fn>> = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };
  c.from.mockReturnValue(c);
  c.where.mockReturnValue(c);
  c.orderBy.mockReturnValue(c);
  c.limit.mockResolvedValue(rows);
  return c;
}

/** Chain that resolves at .where() (count query — no orderBy/limit) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countChain(count: number): any {
  const c: Record<string, ReturnType<typeof vi.fn>> = {
    from: vi.fn(),
    where: vi.fn(),
  };
  c.from.mockReturnValue(c);
  c.where.mockResolvedValue([{ count }]);
  return c;
}

function makeReq(token?: string, queryToken?: string, limit?: string): NextRequest {
  let url = `http://localhost/api/sites/${SITE_ID}/citation-history`;
  const qs: string[] = [];
  if (queryToken) qs.push(`token=${encodeURIComponent(queryToken)}`);
  if (limit !== undefined) qs.push(`limit=${limit}`);
  if (qs.length) url += `?${qs.join("&")}`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(url, { method: "GET", headers });
}

/**
 * The route makes 3 DB calls in this order:
 *   1. site lookup:  select().from(geoSites).where()             → resolves
 *   2. rows:         select().from(scores).where().orderBy().limit() → resolves
 *   3. count:        select({count}).from(scores).where()         → resolves
 */
function setupSuccess(historyRows: unknown[], count: number) {
  let n = 0;
  vi.mocked(db.select).mockImplementation(() => {
    n++;
    if (n === 1) return siteChain([MOCK_SITE]);
    if (n === 2) return rowsChain(historyRows);
    return countChain(count);
  });
}

// ─── Auth tests ───────────────────────────────────────────────────────────────

describe("citation-history-api — auth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("U-1 — no token → 401", async () => {
    const req = makeReq();
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("U-2 — wrong token → 401", async () => {
    vi.mocked(db.select).mockImplementation(() => siteChain([MOCK_SITE]));
    const req = makeReq("wrong-token");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("U-3 — site not found → 404", async () => {
    vi.mocked(db.select).mockImplementation(() => siteChain([]));
    const req = makeReq(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Site not found");
  });
});

// ─── Limit validation ─────────────────────────────────────────────────────────

describe("citation-history-api — limit validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only need site lookup for limit validation tests — 400 returned before DB history calls
    vi.mocked(db.select).mockImplementation(() => siteChain([MOCK_SITE]));
  });

  it("U-8 — limit=51 → 400", async () => {
    const req = makeReq(VALID_TOKEN, undefined, "51");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid limit. Must be 1–50.");
  });

  it("U-9 — limit=0 → 400", async () => {
    const req = makeReq(VALID_TOKEN, undefined, "0");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid limit. Must be 1–50.");
  });

  it("U-10 — limit=abc → 400", async () => {
    const req = makeReq(VALID_TOKEN, undefined, "abc");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid limit. Must be 1–50.");
  });
});

// ─── Success cases ────────────────────────────────────────────────────────────

describe("citation-history-api — success", () => {
  beforeEach(() => vi.clearAllMocks());

  it("U-4 — valid request, no checks → 200 { history: [], total: 0 }", async () => {
    setupSuccess([], 0);
    const req = makeReq(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("U-5 — valid request, 3 checks → 200 { history: [3 rows], total: 3 }", async () => {
    const rows = [MOCK_SCORE, { ...MOCK_SCORE, checkId: "chk-2" }, { ...MOCK_SCORE, checkId: "chk-3" }];
    setupSuccess(rows, 3);
    const req = makeReq(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it("U-6 — no ?limit → default limit=10 accepted → 200", async () => {
    setupSuccess([], 0);
    const req = makeReq(VALID_TOKEN);
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
  });

  it("U-7 — ?limit=5 accepted → 200", async () => {
    setupSuccess([], 0);
    const req = makeReq(VALID_TOKEN, undefined, "5");
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
  });

  it("U-11 — Bearer header auth → 200", async () => {
    setupSuccess([], 0);
    const req = makeReq(VALID_TOKEN); // uses Bearer header
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
  });

  it("U-12 — ?token= query auth → 200", async () => {
    setupSuccess([], 0);
    const req = makeReq(undefined, VALID_TOKEN); // uses ?token= param
    const res = await GET(req, ROUTE_PARAMS);
    expect(res.status).toBe(200);
  });
});
