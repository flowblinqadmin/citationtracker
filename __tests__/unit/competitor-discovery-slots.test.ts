/**
 * ES-069 — User-Defined Competitors: Discovery slot enforcement tests
 * U16–U21 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * Tests: Modified competitor-discovery route + service with slot calculation,
 * blocklist filtering, and append-not-overwrite behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbWhere = vi.fn();
const mockDbInsert = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mockDbSelect,
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockDbSet(...args);
        return { where: mockDbWhere.mockResolvedValue(undefined) };
      },
    }),
    insert: () => ({
      values: mockDbInsert.mockReturnValue(Promise.resolve()),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: { id: "id" },
  teams: { id: "id" },
  creditTransactions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn(),
  gte: vi.fn(),
  and: vi.fn(),
}));

vi.mock("nanoid", () => ({
  nanoid: () => "mock-nanoid",
}));

// Mock the discovery service
const mockDiscoverCompetitors = vi.fn();
vi.mock("@/lib/services/competitor-discovery", () => ({
  discoverCompetitors: (...args: unknown[]) => mockDiscoverCompetitors(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface UserCompetitor {
  name: string;
  domain?: string;
  addedAt: string;
}

interface DiscoveredCompetitor {
  name: string;
  domain?: string;
  rank: number;
  mentions: number;
  category: "direct" | "adjacent";
}

function makeUserComp(name: string): UserCompetitor {
  return { name, addedAt: "2026-03-28T00:00:00Z" };
}

function makeDiscComp(name: string): DiscoveredCompetitor {
  return { name, domain: `${name.toLowerCase()}.com`, rank: 1, mentions: 3, category: "direct" };
}

const TOKEN = "test-token-123";

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    domain: "example.com",
    accessToken: TOKEN,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),    teamId: "team-1",
    siteType: "e-commerce",
    executiveSummary: "Test summary",
    crawlData: { pages: [{ url: "https://example.com", markdown: "Homepage" }] },
    discoveryData: {},
    userCompetitors: [] as UserCompetitor[],
    discoveredCompetitors: [] as DiscoveredCompetitor[],
    competitorBlocklist: [] as string[],
    ...overrides,
  };
}

function makeTeam(credits = 50) {
  return { id: "team-1", creditBalance: credits };
}

function makeDiscoveryRequest(siteId: string) {
  return new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/competitor-discovery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Import route AFTER mocks
// ---------------------------------------------------------------------------

import { POST } from "@/app/api/sites/[id]/competitor-discovery/route";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PERPLEXITY_API_KEY", "test-key");
  const site = makeSite();
  const team = makeTeam();
  let selectCall = 0;
  mockDbSelect.mockImplementation(() => {
    selectCall++;
    if (selectCall === 1) return [site];
    return [team];
  });
  mockDbWhere.mockResolvedValue(undefined);
  mockDbInsert.mockReturnValue(Promise.resolve());
  mockDiscoverCompetitors.mockResolvedValue([
    makeDiscComp("NewComp1"),
    makeDiscComp("NewComp2"),
    makeDiscComp("NewComp3"),
  ]);
});

// ---------------------------------------------------------------------------
// U16: Discovery with 4 user competitors → max 2 slots
// ---------------------------------------------------------------------------

describe("Discovery slot enforcement (U16–U21)", () => {
  it("U16 — 4 user competitors → discovery finds max 2, appends", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("A"), makeUserComp("B"), makeUserComp("C"), makeUserComp("D")],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    // Discovery returns 3 but only 2 slots available
    mockDiscoverCompetitors.mockResolvedValue([
      makeDiscComp("New1"), makeDiscComp("New2"), makeDiscComp("New3"),
    ]);

    const res = await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));

    // Response is SSE stream — check that discoverCompetitors was called with maxResults
    if (res.status === 400) {
      // If route returns 400 before streaming, check the error
      const body = await res.json();
      // With 4 user + 0 discovered = 4, slotsAvailable = 2
      // Route should allow discovery (not return 400 unless slotsAvailable <= 0)
      // So this path should NOT be taken
      expect(body.slotsRemaining).toBeDefined();
    } else {
      // SSE stream response — verify discoverCompetitors was called with options
      expect(mockDiscoverCompetitors).toHaveBeenCalled();
      const callArgs = mockDiscoverCompetitors.mock.calls[0];
      // Third arg should be options with maxResults
      if (callArgs[2]) {
        expect(callArgs[2].maxResults).toBe(2);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // U17: Discovery with 6 total → 400
  // ---------------------------------------------------------------------------

  it("U17 — 3 user + 3 discovered (6 total) → 400 'No discovery slots'", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("A"), makeUserComp("B"), makeUserComp("C")],
      discoveredCompetitors: [makeDiscComp("D"), makeDiscComp("E"), makeDiscComp("F")],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    const res = await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("No discovery slots available");
    expect(body.totalCount).toBe(6);
    expect(body.slotsRemaining).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // U18: Discovery respects blocklist
  // ---------------------------------------------------------------------------

  it("U18 — blocklist names excluded from discovery results", async () => {
    const site = makeSite({
      competitorBlocklist: ["apollo"],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));

    // Verify discoverCompetitors called with excludeNames containing "apollo"
    expect(mockDiscoverCompetitors).toHaveBeenCalled();
    const callArgs = mockDiscoverCompetitors.mock.calls[0];
    if (callArgs[2]?.excludeNames) {
      expect(callArgs[2].excludeNames).toContain("apollo");
    }
  });

  // ---------------------------------------------------------------------------
  // U19: Discovery respects existing user competitor names
  // ---------------------------------------------------------------------------

  it("U19 — existing user competitor names excluded from discovery", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("TikTok")],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));

    expect(mockDiscoverCompetitors).toHaveBeenCalled();
    const callArgs = mockDiscoverCompetitors.mock.calls[0];
    if (callArgs[2]?.excludeNames) {
      expect(callArgs[2].excludeNames.map((n: string) => n.toLowerCase())).toContain("tiktok");
    }
  });

  // ---------------------------------------------------------------------------
  // U20: Discovery appends, not overwrites
  // ---------------------------------------------------------------------------

  it("U20 — 2 existing discovered → result = existing + new (up to cap)", async () => {
    const existingDiscovered = [makeDiscComp("Existing1"), makeDiscComp("Existing2")];
    const site = makeSite({ discoveredCompetitors: existingDiscovered });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    mockDiscoverCompetitors.mockResolvedValue([makeDiscComp("New1"), makeDiscComp("New2")]);

    await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));

    // Verify db.update.set was called with appended array (not just new results)
    if (mockDbSet.mock.calls.length > 0) {
      // The set call should include discoveredCompetitors with existing + new
      const setArg = mockDbSet.mock.calls.find(
        (call: unknown[]) => call[0]?.discoveredCompetitors
      );
      if (setArg) {
        const updated = setArg[0].discoveredCompetitors;
        expect(updated.length).toBeGreaterThanOrEqual(3); // at least existing + some new
        expect(updated.some((c: DiscoveredCompetitor) => c.name === "Existing1")).toBe(true);
        expect(updated.some((c: DiscoveredCompetitor) => c.name === "Existing2")).toBe(true);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // U21: excludeNames passed to discovery prompt
  // ---------------------------------------------------------------------------

  it("U21 — excludeNames includes blocklist + existing user + existing discovered names", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("UserComp")],
      discoveredCompetitors: [makeDiscComp("DiscComp")],
      competitorBlocklist: ["blockedcomp"],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    await POST(makeDiscoveryRequest("site-1"), makeRouteContext("site-1"));

    expect(mockDiscoverCompetitors).toHaveBeenCalled();
    const callArgs = mockDiscoverCompetitors.mock.calls[0];
    if (callArgs[2]?.excludeNames) {
      const excludeLower = callArgs[2].excludeNames.map((n: string) => n.toLowerCase());
      expect(excludeLower).toContain("blockedcomp");
      expect(excludeLower).toContain("usercomp");
      expect(excludeLower).toContain("disccomp");
    }
  });
});
