import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
  sql: vi.fn(),
}));

import { GET } from "./route";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-1", email: "alice@example.com", token: "tok", tokenExpiry: null };

function makeRequest(): NextRequest {
  return new NextRequest(new Request("http://localhost/api/teams/domains"));
}

const MEMBERSHIP = {
  id: "mem-1",
  teamId: "team-1",
  userId: "user-1",
  email: "alice@example.com",
  role: "owner",
  inviteToken: null,
  inviteAcceptedAt: null,
  createdAt: new Date(),
};

// The domains route uses a select with specific columns + innerJoin, not a
// simple table-level select. We model the chain accordingly.
function mockDomainSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/teams/domains — authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when no authenticated user", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});

describe("GET /api/teams/domains — team membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 404 when user has no team membership", async () => {
    // First select (teamMembers) → empty
    const membershipChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    vi.mocked(db.select).mockReturnValueOnce(membershipChain as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("No team found");
  });
});

describe("GET /api/teams/domains — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns empty domains array when team has no claimed sites", async () => {
    const membershipChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([MEMBERSHIP]) };
    const domainsChain = mockDomainSelectChain([]);

    vi.mocked(db.select)
      .mockReturnValueOnce(membershipChain as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(domainsChain as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as { domains: unknown[] };
    expect(body.domains).toHaveLength(0);
  });

  it("returns domains list with overallScore extracted from geoScorecard JSON", async () => {
    const membershipChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([MEMBERSHIP]) };

    const domainRows = [
      {
        id: "td-1",
        domain: "example.com",
        siteId: "site-1",
        createdAt: new Date("2024-01-01"),
        pipelineStatus: "complete",
        lastCrawlAt: new Date("2024-06-01"),
        geoScorecard: { overallScore: 82 },
      },
      {
        id: "td-2",
        domain: "another.com",
        siteId: "site-2",
        createdAt: new Date("2024-02-01"),
        pipelineStatus: "discovery",
        lastCrawlAt: null,
        geoScorecard: null, // no scorecard yet
      },
    ];

    const domainsChain = mockDomainSelectChain(domainRows);

    vi.mocked(db.select)
      .mockReturnValueOnce(membershipChain as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(domainsChain as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      domains: Array<{
        id: string;
        domain: string;
        siteId: string;
        pipelineStatus: string;
        overallScore: number | null;
      }>;
    };

    expect(body.domains).toHaveLength(2);

    const example = body.domains.find((d) => d.domain === "example.com")!;
    expect(example.overallScore).toBe(82);
    expect(example.pipelineStatus).toBe("complete");

    const another = body.domains.find((d) => d.domain === "another.com")!;
    expect(another.overallScore).toBeNull(); // no scorecard → null
  });

  it("returns overallScore as null when geoScorecard exists but has no overallScore field", async () => {
    const membershipChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([MEMBERSHIP]) };

    const domainRows = [
      {
        id: "td-1",
        domain: "example.com",
        siteId: "site-1",
        createdAt: new Date(),
        pipelineStatus: "analyzing",
        lastCrawlAt: null,
        geoScorecard: { pillars: [] }, // exists but no overallScore key
      },
    ];

    const domainsChain = mockDomainSelectChain(domainRows);
    vi.mocked(db.select)
      .mockReturnValueOnce(membershipChain as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(domainsChain as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    const body = await res.json() as { domains: Array<{ overallScore: number | null }> };
    expect(body.domains[0].overallScore).toBeNull();
  });
});
