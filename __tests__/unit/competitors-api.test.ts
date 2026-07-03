/**
 * ES-069 — User-Defined Competitors: Competitors API unit tests
 * U1–U15 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * Tests: POST /api/sites/[id]/competitors (add + remove actions)
 * Route file: geo/app/api/sites/[id]/competitors/route.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbWhere = vi.fn();

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
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
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
      execute: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  geoSites: { id: "id" },
  teams: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

// Import route handler AFTER mocks
import { POST } from "@/app/api/sites/[id]/competitors/route";

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

function makeUserComp(name: string, domain?: string): UserCompetitor {
  return { name, domain, addedAt: "2026-03-28T00:00:00Z" };
}

function makeDiscComp(name: string, domain?: string): DiscoveredCompetitor {
  return { name, domain, rank: 1, mentions: 3, category: "direct" };
}

const TOKEN = "test-token-123";

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    accessToken: TOKEN,
    teamId: "team-1",
    userCompetitors: [] as UserCompetitor[],
    discoveredCompetitors: [] as DiscoveredCompetitor[],
    competitorBlocklist: [] as string[],
    ...overrides,
  };
}

function makeRequest(siteId: string, body: Record<string, unknown>, token?: string) {
  return new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/competitors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbSelect.mockResolvedValue([makeSite()]);
  mockDbWhere.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// U1: Add competitor — success
// ---------------------------------------------------------------------------

describe("Add competitor (U1–U7)", () => {
  it("U1 — add competitor with 3 existing → 200, 4th entry added", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("Alpha"), makeUserComp("Beta"), makeUserComp("Gamma")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Apollo" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userCompetitors).toHaveLength(4);
    expect(body.userCompetitors.some((c: UserCompetitor) => c.name === "Apollo")).toBe(true);
    expect(body.totalCount).toBe(4);
    expect(body.slotsRemaining).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // U2: Add with domain
  // ---------------------------------------------------------------------------

  it("U2 — add with domain → entry has domain field", async () => {
    mockDbSelect.mockResolvedValue([makeSite()]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Apollo", domain: "apollo.io" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const apollo = body.userCompetitors.find((c: UserCompetitor) => c.name === "Apollo");
    expect(apollo).toBeDefined();
    expect(apollo.domain).toBe("apollo.io");
    expect(apollo.addedAt).toBeDefined(); // ISO 8601
  });

  // ---------------------------------------------------------------------------
  // U3: Add duplicate (case-insensitive)
  // ---------------------------------------------------------------------------

  it("U3 — add duplicate (case-insensitive) → 409", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("apollo")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Apollo" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("Competitor already exists");
  });

  it("U3b — add duplicate from discoveredCompetitors → 409", async () => {
    const site = makeSite({
      discoveredCompetitors: [makeDiscComp("TikTok")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "tiktok" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("Competitor already exists");
  });

  // ---------------------------------------------------------------------------
  // U4: Add when 6 already exist
  // ---------------------------------------------------------------------------

  it("U4 — add when 6 effective competitors → 400", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("A"), makeUserComp("B"), makeUserComp("C")],
      discoveredCompetitors: [makeDiscComp("D"), makeDiscComp("E"), makeDiscComp("F")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "G" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Maximum 6 competitors");
  });

  // ---------------------------------------------------------------------------
  // U5: Add empty name
  // ---------------------------------------------------------------------------

  it("U5 — add empty/whitespace name → 400", async () => {
    const res = await POST(
      makeRequest("site-1", { action: "add", name: "   " }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // U6: Add name > 100 chars
  // ---------------------------------------------------------------------------

  it("U6 — add name > 100 chars → 400", async () => {
    const longName = "A".repeat(101);
    const res = await POST(
      makeRequest("site-1", { action: "add", name: longName }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // U7: Add re-enables blocked name
  // ---------------------------------------------------------------------------

  it("U7 — add re-enables blocked name (removes from blocklist)", async () => {
    const site = makeSite({
      competitorBlocklist: ["apollo", "tiktok"],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Apollo" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blocklist).not.toContain("apollo");
    expect(body.blocklist).toContain("tiktok"); // other entries preserved
    expect(body.userCompetitors.some((c: UserCompetitor) => c.name === "Apollo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U8–U12: Remove competitor
// ---------------------------------------------------------------------------

describe("Remove competitor (U8–U12)", () => {
  it("U8 — remove user competitor → removed + added to blocklist", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("Apollo"), makeUserComp("Beta")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "remove", name: "Apollo" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userCompetitors.some((c: UserCompetitor) => c.name === "Apollo")).toBe(false);
    expect(body.blocklist).toContain("apollo");
  });

  it("U9 — remove discovered competitor → removed + added to blocklist", async () => {
    const site = makeSite({
      discoveredCompetitors: [makeDiscComp("TikTok"), makeDiscComp("Instagram")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "remove", name: "TikTok" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.discoveredCompetitors.some((c: DiscoveredCompetitor) => c.name === "TikTok")).toBe(false);
    expect(body.blocklist).toContain("tiktok");
  });

  it("U10 — remove nonexistent → 200 (idempotent), still adds to blocklist", async () => {
    const site = makeSite();
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "remove", name: "Nonexistent" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blocklist).toContain("nonexistent");
  });

  it("U11 — blocklist FIFO cap at 20 → oldest dropped", async () => {
    const blocklist = Array.from({ length: 20 }, (_, i) => `blocked-${i}`);
    const site = makeSite({ competitorBlocklist: blocklist });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "remove", name: "NewBlocked" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.blocklist).toHaveLength(20);
    expect(body.blocklist).toContain("newblocked");
    expect(body.blocklist).not.toContain("blocked-0"); // oldest dropped
    expect(body.blocklist).toContain("blocked-1"); // second oldest preserved
  });

  it("U12 — blocklist dedup → no duplicate entries", async () => {
    const site = makeSite({
      discoveredCompetitors: [makeDiscComp("Apollo")],
      competitorBlocklist: ["apollo"],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "remove", name: "Apollo" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const apolloCount = body.blocklist.filter((b: string) => b === "apollo").length;
    expect(apolloCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// U13–U15: Auth + site not found
// ---------------------------------------------------------------------------

describe("Auth & validation (U13–U15)", () => {
  it("U13 — unauthorized (no token) → 401", async () => {
    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Test" }),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(401);
  });

  it("U14 — unauthorized (wrong token) → 401", async () => {
    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Test" }, "wrong-token"),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(401);
  });

  it("U15 — site not found → 404", async () => {
    mockDbSelect.mockResolvedValue([]);

    const res = await POST(
      makeRequest("nonexistent", { action: "add", name: "Test" }, TOKEN),
      makeRouteContext("nonexistent")
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Response shape verification
// ---------------------------------------------------------------------------

describe("Response shape", () => {
  it("returns userCompetitors, discoveredCompetitors, blocklist, totalCount, slotsRemaining", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("Alpha")],
      discoveredCompetitors: [makeDiscComp("TikTok")],
    });
    mockDbSelect.mockResolvedValue([site]);

    const res = await POST(
      makeRequest("site-1", { action: "add", name: "Beta" }, TOKEN),
      makeRouteContext("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("userCompetitors");
    expect(body).toHaveProperty("discoveredCompetitors");
    expect(body).toHaveProperty("blocklist");
    expect(body).toHaveProperty("totalCount");
    expect(body).toHaveProperty("slotsRemaining");
    expect(body.totalCount).toBe(3); // Alpha + TikTok + Beta
    expect(body.slotsRemaining).toBe(3);
  });
});
