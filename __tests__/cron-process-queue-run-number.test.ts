/**
 * Unit tests — cron/process-queue runNumber pass-through (NEW-AI-01)
 *
 * Verifies that when process-queue re-enqueues stale in-progress sites, it
 * passes the site's currentRunNumber as `runNumber` in the StagePayload so
 * the stage handler's idempotency guard (POST() runNumber check) fires.
 *
 * RED on the un-patched codebase: the old code passes `{ siteId, domain, stage }`
 * with NO runNumber, so typeof runNumber === "undefined" and the guard is
 * completely bypassed. A stale cron re-enqueue on an "analyzing" or
 * "generating" site would re-run the stage against current state, resetting
 * generated data and potentially double-firing generate-chunk fan-outs.
 *
 * GREEN after the fix: runNumber is read from the SELECT result and included
 * in every enqueueStage call (both discover and non-discover branches).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockEnqueueStage } = vi.hoisted(() => ({
  mockEnqueueStage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: mockEnqueueStage,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  lt: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { GET } from "@/app/api/cron/process-queue/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://test.com/api/cron/process-queue";
const TEST_SECRET = "test-cron-secret-xyz-padded-to-32+chars-aaaaaaaa";

function makeRequest(): NextRequest {
  return new NextRequest(BASE_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${TEST_SECRET}` },
  });
}

function makeSelectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(rows);
  return chain;
}

function makeTeamSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(rows);
  return chain;
}

function makeUpdateChain(returningRows: unknown[] = [{ id: "updated" }]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockResolvedValue(returningRows);
  return chain;
}

type StaleRow = {
  id: string;
  domain: string;
  pipelineStatus: string;
  auditMode?: string;
  teamId?: string | null;
  crawlLimit?: number | null;
  currentRunNumber?: number | null;
};

function makeStale(overrides: Partial<StaleRow> = {}): StaleRow {
  return {
    id: "site-1",
    domain: "example.com",
    pipelineStatus: "analyzing",
    auditMode: "single",
    teamId: "team-1",
    crawlLimit: null,
    currentRunNumber: 3,
    ...overrides,
  };
}

function setupDb(opts: {
  inProgressRows?: unknown[];
  pendingRows?: unknown[];
  teamRows?: unknown[];
}) {
  let selectCall = 0;
  const teamRows = opts.teamRows ?? [];

  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
    if (selectCall === 0) {
      selectCall++;
      return makeSelectChain(opts.inProgressRows ?? []);
    }
    selectCall++;
    return makeTeamSelectChain(teamRows);
  });

  (db.selectDistinct as ReturnType<typeof vi.fn>).mockImplementation(() =>
    makeSelectChain(opts.pendingRows ?? [])
  );

  (db.update as ReturnType<typeof vi.fn>).mockImplementation(() =>
    makeUpdateChain([{ id: "updated" }])
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("process-queue: runNumber pass-through (NEW-AI-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueStage.mockReset();
    mockEnqueueStage.mockResolvedValue(undefined);
    process.env.CRON_SECRET = TEST_SECRET;
    setupDb({});
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  // ── Core assertion: runNumber is forwarded ────────────────────────────────

  it("re-enqueues non-discover stage WITH the site's currentRunNumber", async () => {
    const site = makeStale({
      id: "s1",
      domain: "analyzing.com",
      pipelineStatus: "analyzing",
      currentRunNumber: 7,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "s1",
        stage: "analyze",
        runNumber: 7,
      })
    );
  });

  it("re-enqueues discover stage WITH the site's currentRunNumber", async () => {
    const site = makeStale({
      id: "s2",
      domain: "discovery.com",
      pipelineStatus: "discovery",
      crawlLimit: 100,
      currentRunNumber: 4,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "s2",
        stage: "discover",
        maxPages: 100,
        runNumber: 4,
      })
    );
  });

  it("re-enqueues generate-fanout stage WITH runNumber (fan-out double-fire protection)", async () => {
    const site = makeStale({
      id: "s3",
      domain: "generating.com",
      pipelineStatus: "generating",
      currentRunNumber: 2,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledOnce();
    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "generate-fanout",
        runNumber: 2,
      })
    );
  });

  it("re-enqueues assemble stage WITH runNumber", async () => {
    const site = makeStale({
      id: "s4",
      domain: "assembling.com",
      pipelineStatus: "assembling",
      currentRunNumber: 5,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "assemble",
        runNumber: 5,
      })
    );
  });

  it("crawling status → crawl-fanout re-enqueue includes runNumber", async () => {
    const site = makeStale({
      id: "s5",
      domain: "crawling.com",
      pipelineStatus: "crawling",
      currentRunNumber: 11,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "crawl-fanout",
        runNumber: 11,
      })
    );
  });

  // ── Null/missing currentRunNumber → undefined (not a number literal 0) ────

  it("currentRunNumber = null → runNumber is undefined in payload (backward compat)", async () => {
    const site = makeStale({
      id: "s6",
      domain: "no-run-num.com",
      pipelineStatus: "analyzing",
      currentRunNumber: null,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    const call = mockEnqueueStage.mock.calls[0]?.[0] as Record<string, unknown>;
    // Should be undefined (not 0, not null) — undefined means guard bypassed
    // gracefully rather than always-mismatching on runNumber=0
    expect(call?.runNumber).toBeUndefined();
  });

  it("currentRunNumber = 1 (default) → runNumber = 1 in payload", async () => {
    const site = makeStale({
      id: "s7",
      domain: "runone.com",
      pipelineStatus: "researching",
      currentRunNumber: 1,
    });
    setupDb({ inProgressRows: [site] });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledWith(
      expect.objectContaining({ runNumber: 1 })
    );
  });

  // ── Multiple stale sites: each gets its own runNumber ─────────────────────

  it("multiple stale sites — each enqueue carries its own runNumber", async () => {
    const sites = [
      makeStale({ id: "a", domain: "a.com", pipelineStatus: "analyzing", currentRunNumber: 3 }),
      makeStale({ id: "b", domain: "b.com", pipelineStatus: "generating", currentRunNumber: 7 }),
      makeStale({ id: "c", domain: "c.com", pipelineStatus: "assembling", currentRunNumber: 1 }),
    ];
    setupDb({ inProgressRows: sites });

    await GET(makeRequest());

    expect(mockEnqueueStage).toHaveBeenCalledTimes(3);
    expect(mockEnqueueStage).toHaveBeenCalledWith(expect.objectContaining({ siteId: "a", runNumber: 3 }));
    expect(mockEnqueueStage).toHaveBeenCalledWith(expect.objectContaining({ siteId: "b", runNumber: 7 }));
    expect(mockEnqueueStage).toHaveBeenCalledWith(expect.objectContaining({ siteId: "c", runNumber: 1 }));
  });
});
