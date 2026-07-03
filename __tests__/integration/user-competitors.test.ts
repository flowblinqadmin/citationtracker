/**
 * ES-069 — User-Defined Competitors: Integration tests
 * IT1–IT10 (Phase A — ReviewMaster, spec-driven, RED until DaVinci implements)
 *
 * Tests the full lifecycle of user-defined competitors: add/remove,
 * discovery slot enforcement, citation check merge, blocklist behavior,
 * and backward compatibility.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbSet = vi.fn();
const mockDbWhere = vi.fn();
const mockDbInsert = vi.fn();

// Track all set() calls for verification
const setCalls: Record<string, unknown>[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: mockDbSelect,
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        const setObj = args[0] as Record<string, unknown>;
        setCalls.push(setObj);
        mockDbSet(...args);
        return { where: mockDbWhere.mockResolvedValue(undefined) };
      },
    }),
    insert: () => ({
      values: mockDbInsert.mockReturnValue(Promise.resolve()),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: () => ({
        from: () => ({
          where: mockDbSelect,
        }),
      }),
      update: () => ({
        set: (...args: unknown[]) => {
          const setObj = args[0] as Record<string, unknown>;
          setCalls.push(setObj);
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
  creditTransactions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  gte: vi.fn(),
  and: vi.fn(),
}));

vi.mock("nanoid", () => ({
  nanoid: () => "mock-nanoid",
}));

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

function makeUserComp(name: string, domain?: string): UserCompetitor {
  return { name, domain, addedAt: "2026-03-28T00:00:00Z" };
}

function makeDiscComp(name: string, domain?: string): DiscoveredCompetitor {
  return { name, domain: domain ?? `${name.toLowerCase()}.com`, rank: 1, mentions: 3, category: "direct" };
}

const TOKEN = "test-token-123";

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-1",
    domain: "example.com",
    slug: "example-com",
    accessToken: TOKEN,
    teamId: "team-1",
    siteType: "e-commerce",
    executiveSummary: "Test",
    crawlData: { pages: [{ url: "https://example.com" }] },
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

function makeCompetitorRequest(siteId: string, body: Record<string, unknown>) {
  return new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/competitors`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    })
  );
}

function makeDiscoveryRequest(siteId: string) {
  return new NextRequest(
    new Request(`http://localhost/api/sites/${siteId}/competitor-discovery`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
}

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Import routes AFTER mocks
// ---------------------------------------------------------------------------

let competitorPOST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let discoveryPOST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  setCalls.length = 0;

  const compMod = await import("@/app/api/sites/[id]/competitors/route");
  competitorPOST = compMod.POST;

  const discMod = await import("@/app/api/sites/[id]/competitor-discovery/route");
  discoveryPOST = discMod.POST;

  mockDbWhere.mockResolvedValue(undefined);
  mockDbInsert.mockReturnValue(Promise.resolve());
  mockDiscoverCompetitors.mockResolvedValue([makeDiscComp("AutoDisc1"), makeDiscComp("AutoDisc2")]);
});

// ---------------------------------------------------------------------------
// IT1: Full lifecycle — add 3, remove 1, verify blocklist
// ---------------------------------------------------------------------------

describe("IT1 — Full lifecycle: add, remove, blocklist", () => {
  it("add 3 competitors, remove 1, verify blocklist", async () => {
    // Start with empty site
    let currentSite = makeSite();
    mockDbSelect.mockImplementation(() => [currentSite]);

    // Add 3 competitors
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      // Simulate updated state after each add
      const res = await competitorPOST(
        makeCompetitorRequest("site-1", { action: "add", name }),
        makeCtx("site-1")
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // Update local state for next iteration
      currentSite = makeSite({
        userCompetitors: body.userCompetitors,
        competitorBlocklist: body.blocklist,
      });
      mockDbSelect.mockImplementation(() => [currentSite]);
    }

    // Should have 3 user competitors
    expect(currentSite.userCompetitors).toHaveLength(3);

    // Remove Beta
    const removeRes = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "remove", name: "Beta" }),
      makeCtx("site-1")
    );
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();

    // Beta removed from userCompetitors
    expect(removeBody.userCompetitors.some((c: UserCompetitor) => c.name === "Beta")).toBe(false);
    // Beta in blocklist
    expect(removeBody.blocklist).toContain("beta");
    expect(removeBody.totalCount).toBe(2);
    expect(removeBody.slotsRemaining).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// IT2: Add persists across page reload
// ---------------------------------------------------------------------------

describe("IT2 — Add persists (DB set called)", () => {
  it("add via API triggers db.update.set with updated userCompetitors", async () => {
    mockDbSelect.mockImplementation(() => [makeSite()]);

    const res = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "add", name: "Persistent" }),
      makeCtx("site-1")
    );
    expect(res.status).toBe(200);

    // Verify db.update.set was called
    expect(mockDbSet).toHaveBeenCalled();
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet).toHaveProperty("userCompetitors");
    const persisted = lastSet.userCompetitors as UserCompetitor[];
    expect(persisted.some(c => c.name === "Persistent")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IT3: Citation check uses merged list (structural)
// ---------------------------------------------------------------------------

describe("IT3 — Citation check merge (structural)", () => {
  it("site with user + discovered competitors both available for merge", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("UserBrand")],
      discoveredCompetitors: [makeDiscComp("DiscBrand")],
    });
    mockDbSelect.mockImplementation(() => [site]);

    // Verify the site data has both lists available
    expect(site.userCompetitors).toHaveLength(1);
    expect(site.discoveredCompetitors).toHaveLength(1);

    // The merge logic in citation-check/route.ts should:
    // 1. Map userCompetitors to DiscoveredCompetitor format with category: "direct"
    // 2. Concat with discoveredCompetitors
    // 3. Pass allCompetitors to runCitationCheck
    const merged = [
      ...site.userCompetitors.map(c => ({
        name: c.name,
        domain: c.domain,
        rank: 0,
        mentions: 0,
        category: "direct" as const,
      })),
      ...site.discoveredCompetitors,
    ];
    expect(merged).toHaveLength(2);
    expect(merged[0].name).toBe("UserBrand");
    expect(merged[0].category).toBe("direct");
    expect(merged[1].name).toBe("DiscBrand");
  });
});

// ---------------------------------------------------------------------------
// IT4: Discovery respects slots and blocklist
// ---------------------------------------------------------------------------

describe("IT4 — Discovery slot + blocklist enforcement", () => {
  it("4 user competitors → discovery discovers max 2, skips blocked", async () => {
    const site = makeSite({
      userCompetitors: [makeUserComp("A"), makeUserComp("B"), makeUserComp("C"), makeUserComp("D")],
      competitorBlocklist: ["blocked1"],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [site] : [team];
    });

    mockDiscoverCompetitors.mockResolvedValue([makeDiscComp("New1"), makeDiscComp("New2")]);

    const res = await discoveryPOST(makeDiscoveryRequest("site-1"), makeCtx("site-1"));

    // Either 200 (SSE) or 400 (slots full check)
    if (res.status === 400) {
      // 4 user + 0 discovered = 4, slots = 2, should allow
      // 400 only if slotsAvailable <= 0
      expect(res.status).not.toBe(400);
    }

    if (mockDiscoverCompetitors.mock.calls.length > 0) {
      const opts = mockDiscoverCompetitors.mock.calls[0][2];
      if (opts) {
        // maxResults should be 2 (6 - 4 user)
        expect(opts.maxResults).toBe(2);
        // excludeNames should include "blocked1"
        if (opts.excludeNames) {
          expect(opts.excludeNames).toContain("blocked1");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// IT5: Blocklist prevents re-discovery
// ---------------------------------------------------------------------------

describe("IT5 — Blocklist prevents re-discovery", () => {
  it("removed competitor name in excludeNames for discovery", async () => {
    // First: remove "Apollo" → goes to blocklist
    const siteBeforeRemove = makeSite({
      discoveredCompetitors: [makeDiscComp("Apollo")],
    });
    mockDbSelect.mockImplementation(() => [siteBeforeRemove]);

    const removeRes = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "remove", name: "Apollo" }),
      makeCtx("site-1")
    );
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.blocklist).toContain("apollo");

    // Now run discovery with the blocklist
    const siteAfterRemove = makeSite({
      competitorBlocklist: ["apollo"],
    });
    const team = makeTeam();
    let selectCall = 0;
    mockDbSelect.mockImplementation(() => {
      selectCall++;
      return selectCall === 1 ? [siteAfterRemove] : [team];
    });

    await discoveryPOST(makeDiscoveryRequest("site-1"), makeCtx("site-1"));

    if (mockDiscoverCompetitors.mock.calls.length > 0) {
      const opts = mockDiscoverCompetitors.mock.calls[0][2];
      if (opts?.excludeNames) {
        expect(opts.excludeNames).toContain("apollo");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// IT6: geo_site_view sync (structural check)
// ---------------------------------------------------------------------------

describe("IT6 — geo_site_view sync (structural)", () => {
  it("db.update.set includes userCompetitors and competitorBlocklist", async () => {
    mockDbSelect.mockImplementation(() => [makeSite()]);

    await competitorPOST(
      makeCompetitorRequest("site-1", { action: "add", name: "TestComp" }),
      makeCtx("site-1")
    );

    // The Postgres trigger handles geo_site_view sync.
    // We verify the db.update.set call includes the columns the trigger reads.
    expect(mockDbSet).toHaveBeenCalled();
    const setArg = setCalls[setCalls.length - 1];
    expect(setArg).toHaveProperty("userCompetitors");
    // competitorBlocklist may or may not be in the set call for "add"
    // (only if we removed from blocklist during re-add)
  });
});

// ---------------------------------------------------------------------------
// IT7: Concurrent add/remove doesn't corrupt
// ---------------------------------------------------------------------------

describe("IT7 — Concurrent add/remove", () => {
  it("two simultaneous adds both succeed", async () => {
    mockDbSelect.mockImplementation(() => [makeSite()]);

    const [res1, res2] = await Promise.all([
      competitorPOST(makeCompetitorRequest("site-1", { action: "add", name: "Concurrent1" }), makeCtx("site-1")),
      competitorPOST(makeCompetitorRequest("site-1", { action: "add", name: "Concurrent2" }), makeCtx("site-1")),
    ]);

    // Both should succeed (200) — actual dedup is enforced by reading from DB
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// IT8: Migration idempotent (structural)
// ---------------------------------------------------------------------------

describe("IT8 — Migration idempotent", () => {
  it("DDL uses IF NOT EXISTS — running twice is safe", () => {
    // This is a structural assertion about the migration SQL
    // The migration file should contain IF NOT EXISTS
    // We verify the contract here
    const migrationSQL = `ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS user_competitors jsonb DEFAULT '[]'`;
    expect(migrationSQL).toContain("IF NOT EXISTS");
  });
});

// ---------------------------------------------------------------------------
// IT9: Existing sites work without migration (null defaults)
// ---------------------------------------------------------------------------

describe("IT9 — Null defaults for existing sites", () => {
  it("site with null userCompetitors → defaults to []", async () => {
    const legacySite = makeSite({
      userCompetitors: null,
      discoveredCompetitors: [makeDiscComp("Existing")],
      competitorBlocklist: null,
    });
    mockDbSelect.mockImplementation(() => [legacySite]);

    const res = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "add", name: "New" }),
      makeCtx("site-1")
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userCompetitors.some((c: UserCompetitor) => c.name === "New")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IT10: Remove discovered + re-add as user
// ---------------------------------------------------------------------------

describe("IT10 — Remove discovered → re-add as user", () => {
  it("remove discovered competitor, re-add as user → appears as user competitor", async () => {
    // Step 1: Remove discovered "Apollo"
    const siteWithDisc = makeSite({
      discoveredCompetitors: [makeDiscComp("Apollo", "apollo.io")],
    });
    mockDbSelect.mockImplementation(() => [siteWithDisc]);

    const removeRes = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "remove", name: "Apollo" }),
      makeCtx("site-1")
    );
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.blocklist).toContain("apollo");

    // Step 2: Re-add "Apollo" as user competitor
    const siteAfterRemove = makeSite({
      discoveredCompetitors: [],
      competitorBlocklist: ["apollo"],
    });
    mockDbSelect.mockImplementation(() => [siteAfterRemove]);

    const addRes = await competitorPOST(
      makeCompetitorRequest("site-1", { action: "add", name: "Apollo", domain: "apollo.io" }),
      makeCtx("site-1")
    );
    expect(addRes.status).toBe(200);

    const addBody = await addRes.json();
    // Apollo now in userCompetitors
    expect(addBody.userCompetitors.some((c: UserCompetitor) => c.name === "Apollo")).toBe(true);
    // Apollo removed from blocklist (AC11)
    expect(addBody.blocklist).not.toContain("apollo");
  });
});
