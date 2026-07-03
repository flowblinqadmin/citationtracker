import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: { strings, values } })),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-nanoid"),
}));

import { POST } from "./route";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";
import { PAGES_PER_CREDIT, PAID_MAX_PAGES } from "@/lib/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = "secret-access-token";

function makeRequest(siteId: string, options: { authHeader?: string; queryToken?: string } = {}): NextRequest {
  const url = new URL(`http://localhost/api/sites/${siteId}/regenerate`);
  if (options.queryToken) {
    url.searchParams.set("token", options.queryToken);
  }
  const headers: Record<string, string> = {};
  if (options.authHeader !== undefined) {
    headers["authorization"] = options.authHeader;
  }
  return new NextRequest(new Request(url.toString(), { method: "POST", headers }));
}

const ROUTE_CONTEXT = (id: string) => ({ params: Promise.resolve({ id }) });

// A complete, anonymous (no teamId) site
const ANON_SITE = {
  id: "site-1",
  domain: "example.com",
  slug: "example-com",
  ownerEmail: "alice@example.com",
  teamId: null,
  userId: null,
  accessToken: ACCESS_TOKEN,
  tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),  pipelineStatus: "failed",
  pipelineError: "Crawl error",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// A team-owned site
const TEAM_SITE = {
  ...ANON_SITE,
  teamId: "team-1",
  pipelineStatus: "failed",
};

const TEAM = {
  id: "team-1",
  name: "alice",
  ownerUserId: "user-1",
  creditBalance: 25,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockSiteSelect(site: (Partial<Omit<typeof ANON_SITE, "teamId">> & { teamId?: string | null }) | null) {
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(site ? [site] : []) };
  vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);
}

function mockTeamSelect(team: typeof TEAM | null) {
  const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(team ? [team] : []) };
  vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);
}

function mockTransaction() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(db.transaction).mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
    // Provide a minimal tx object — all methods return promise-resolving stubs
    const setChain = { where: vi.fn().mockResolvedValue(undefined) };
    const updateChain = { set: vi.fn().mockReturnValue(setChain) };
    const insertChain = { values: vi.fn().mockResolvedValue(undefined) };
    // tx.select returns a chain that supports .for("update") (SELECT FOR UPDATE)
    const lockedTeamData = [{ creditBalance: TEAM.creditBalance }];
    const whereResult = Object.assign(Promise.resolve(lockedTeamData), {
      for: vi.fn().mockResolvedValue(lockedTeamData),
    });
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue(whereResult),
      }),
      update: vi.fn().mockReturnValue(updateChain),
      insert: vi.fn().mockReturnValue(insertChain),
    };
    await fn(tx);
    return undefined;
  });
}

function mockUpdate() {
  const setChain = { where: vi.fn().mockResolvedValue(undefined) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  vi.mocked(db.update).mockReturnValue(chain as unknown as ReturnType<typeof db.update>);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/sites/[id]/regenerate — authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when no token provided (no header, no query param)", async () => {
    const res = await POST(makeRequest("site-1"), ROUTE_CONTEXT("site-1"));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when site does not exist for the given token", async () => {
    mockSiteSelect(null); // site not found
    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token does not match site accessToken", async () => {
    mockSiteSelect(ANON_SITE); // site found but token will mismatch
    // The route checks site.accessToken !== token; ANON_SITE.accessToken = "secret-access-token"
    const res = await POST(
      makeRequest("site-1", { authHeader: "Bearer wrong-token" }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(401);
  });

  it("accepts token from query string as well as Authorization header", async () => {
    mockSiteSelect(ANON_SITE);
    mockUpdate();

    const res = await POST(
      makeRequest("site-1", { queryToken: ACCESS_TOKEN }),
      ROUTE_CONTEXT("site-1")
    );
    // Should proceed past auth — either 202 or 402, not 401
    expect(res.status).not.toBe(401);
  });
});

describe("POST /api/sites/[id]/regenerate — pipeline already running", () => {
  beforeEach(() => vi.clearAllMocks());

  const RUNNING_STATUSES = ["queued", "discovery", "crawling", "processing", "researching", "analyzing", "generating", "assembling"];

  for (const status of RUNNING_STATUSES) {
    it(`returns 409 when pipelineStatus is '${status}'`, async () => {
      const runningSite = { ...ANON_SITE, pipelineStatus: status };
      mockSiteSelect(runningSite);

      const res = await POST(
        makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
        ROUTE_CONTEXT("site-1")
      );
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/running/i);
    });
  }
});

describe("POST /api/sites/[id]/regenerate — anonymous free path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 402 with upgradeUrl when free audit is already complete", async () => {
    const completeSite = { ...ANON_SITE, teamId: null, pipelineStatus: "complete" };
    mockSiteSelect(completeSite);

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; upgradeUrl: string };
    expect(body.error).toMatch(/free audit|purchase/i);
    expect(body.upgradeUrl).toContain("pricing");
  });

  it("allows re-run when pipeline previously failed (non-complete status)", async () => {
    mockSiteSelect(ANON_SITE); // status = "failed"
    mockUpdate();

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("enqueues stage='discover' with FREE_MAX_PAGES for anonymous sites", async () => {
    mockSiteSelect(ANON_SITE);
    mockUpdate();

    await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", domain: "example.com", stage: "discover", maxPages: 20 })
    );
  });

  it("updates pipelineStatus to 'discovery' before starting the crawl", async () => {
    mockSiteSelect(ANON_SITE);
    const updateChain = mockUpdate();

    await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );

    const setArgs = updateChain.set.mock.calls[0][0] as { pipelineStatus: string; pipelineError: null };
    expect(setArgs.pipelineStatus).toBe("discovery");
    expect(setArgs.pipelineError).toBeNull();
  });
});

describe("POST /api/sites/[id]/regenerate — team credit path (per-page pricing)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 402 when team has 0 credits", async () => {
    const zeroCreditTeam = { ...TEAM, creditBalance: 0 };
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(zeroCreditTeam);

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/insufficient credits/i);
  });

  it("returns 404 when team row no longer exists", async () => {
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(null); // team deleted

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(404);
  });

  it("reserves credits proportional to maxPages (per-page pricing)", async () => {
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(TEAM); // balance = 25
    mockTransaction();

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(202);
    expect(db.transaction).toHaveBeenCalledTimes(1);

    // balance=25 → maxPages=min(25*10,100)=100 → creditsToReserve=ceil(100/10)=10
    const body = await res.json() as { creditsReserved: number; maxPages: number; creditsRemaining: number };
    expect(body.creditsReserved).toBe(10);
    expect(body.maxPages).toBe(100);
    expect(body.creditsRemaining).toBe(15); // 25 - 10
  });

  it("scales maxPages down for low balance (1 credit = 10 pages)", async () => {
    const lowCreditTeam = { ...TEAM, creditBalance: 3 };
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(lowCreditTeam);
    mockTransaction();

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(202);

    // balance=3 → maxPages=min(3*10,100)=30 → creditsToReserve=ceil(30/10)=3
    const body = await res.json() as { creditsReserved: number; maxPages: number; creditsRemaining: number };
    expect(body.creditsReserved).toBe(3);
    expect(body.maxPages).toBe(30);
    expect(body.creditsRemaining).toBe(0);
  });

  it("caps maxPages at PAID_MAX_PAGES for large balances", async () => {
    const richTeam = { ...TEAM, creditBalance: 200 };
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(richTeam);
    mockTransaction();

    const res = await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );
    expect(res.status).toBe(202);

    // balance=200 → maxPages=min(200*10,100)=100 → creditsToReserve=ceil(100/10)=10
    const body = await res.json() as { creditsReserved: number; maxPages: number; creditsRemaining: number };
    expect(body.creditsReserved).toBe(10);
    expect(body.maxPages).toBe(PAID_MAX_PAGES);
    expect(body.creditsRemaining).toBe(190); // 200 - 10
  });

  it("enqueues stage='discover' with computed maxPages", async () => {
    mockSiteSelect(TEAM_SITE);
    mockTeamSelect(TEAM); // balance = 25
    mockTransaction();

    await POST(
      makeRequest("site-1", { authHeader: `Bearer ${ACCESS_TOKEN}` }),
      ROUTE_CONTEXT("site-1")
    );

    // balance=25 → maxPages=min(250,100)=100
    expect(vi.mocked(enqueueStage)).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1", domain: "example.com", stage: "discover", maxPages: 100 })
    );
  });
});
