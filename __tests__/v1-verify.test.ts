/**
 * Unit tests for app/api/v1/audit/[id]/verify/route.ts
 * — POST /api/v1/audit/{id}/verify
 *
 * ES-019 Unit Test Plan (V-1 through V-6)
 *
 *   V-1  Valid first run verify → 200, status=pending, free_run_number=2
 *   V-2  Already on run 2 (freeRunNumber=2) → 400
 *   V-3  Optimization already used (freeOptimizationUsed=true) → 400
 *   V-4  Audit not complete yet (pipelineStatus=pending|running) → 400
 *   V-5  Wrong team (ownership mismatch) → 403
 *   V-6  Valid verify → previousRunSnapshot saved with prior geoScorecard value
 *
 * Mocks: @/lib/api-auth, @/lib/db, @/lib/qstash
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  verifyApiToken: vi.fn(),
  requireScope: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { POST } from "@/app/api/v1/audit/[id]/verify/route";
import { verifyApiToken, requireScope } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { enqueueStage } from "@/lib/qstash";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(
  auditId: string,
  authHeader = "Bearer valid-token"
): [Request, { params: Promise<{ id: string }> }] {
  const req = new Request(
    `http://localhost/api/v1/audit/${auditId}/verify`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader,
      },
      body: JSON.stringify({}),
    }
  );
  const ctx = { params: Promise.resolve({ id: auditId }) };
  return [req, ctx];
}

const VALID_TOKEN_PAYLOAD = {
  sub: "client-id-xyz",
  team_id: "team-abc",
  scopes: ["audit:write"],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const VALID_SITE = {
  id: "audit-site-id-001",
  domain: "example.com",
  teamId: "team-abc",
  pipelineStatus: "complete",
  freeRunNumber: 1,
  freeOptimizationUsed: false,
  geoScorecard: { overallScore: 72, categories: { citations: 60, schema: 80 } },
};

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/audit/[id]/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(verifyApiToken).mockResolvedValue(VALID_TOKEN_PAYLOAD);
    vi.mocked(requireScope).mockReturnValue(undefined);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([VALID_SITE])
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    vi.mocked(enqueueStage).mockResolvedValue(undefined);
  });

  it("V-1: valid first run → 200, status=pending, free_run_number=2", async () => {
    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.audit_id).toBe("audit-site-id-001");
    expect(body.status).toBe("pending");
    expect(body.free_run_number).toBe(2);
  });

  it("V-1b: valid verify → enqueueStage called once to re-run pipeline", async () => {
    const [req, ctx] = makeRequest("audit-site-id-001");
    await POST(req, ctx);

    expect(vi.mocked(enqueueStage)).toHaveBeenCalledTimes(1);
  });

  it("V-2: freeRunNumber=2 → 400 (second run already used)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...VALID_SITE, freeRunNumber: 2 }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
  });

  it("V-3: freeOptimizationUsed=true → 400 (optimization already used)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...VALID_SITE, freeOptimizationUsed: true }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
  });

  it("V-4: pipelineStatus=pending → 400 (audit not complete yet)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...VALID_SITE, pipelineStatus: "pending" }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
  });

  it("V-4b: pipelineStatus=running → 400 (audit still running)", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...VALID_SITE, pipelineStatus: "running" }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
  });

  it("V-5: wrong team → 403", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([{ ...VALID_SITE, teamId: "team-other" }])
    );

    const [req, ctx] = makeRequest("audit-site-id-001");
    const res = await POST(req, ctx);

    expect(res.status).toBe(403);
  });

  it("V-6: valid verify → db.update called with previousRunSnapshot = prior geoScorecard", async () => {
    const capturedSets: Record<string, unknown>[] = [];
    const updateChain = {
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedSets.push(vals);
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue([]),
    };
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

    const [req, ctx] = makeRequest("audit-site-id-001");
    await POST(req, ctx);

    expect(capturedSets.length).toBeGreaterThan(0);
    const updateVals = capturedSets[0];
    // previousRunSnapshot should be the current geoScorecard before re-run
    expect(updateVals.previousRunSnapshot).toEqual(VALID_SITE.geoScorecard);
    // freeOptimizationUsed should be set to true
    expect(updateVals.freeOptimizationUsed).toBe(true);
    // freeRunNumber should be set to 2
    expect(updateVals.freeRunNumber).toBe(2);
    // pipelineStatus should be reset to pending
    expect(updateVals.pipelineStatus).toBe("pending");
  });
});
