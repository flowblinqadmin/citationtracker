/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-1 token expiry on
 * POST /api/sites/[id]/competitor-discovery.
 *
 * ChangedSpec §b.2 step 3, 4th bullet — expiry check at :28+ (after equality).
 * HP-197 — NULL treated as expired.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/services/competitor-discovery", () => ({
  discoverCompetitors: vi.fn().mockResolvedValue([]),
}));

vi.mock("nanoid", () => ({ nanoid: () => "mock-nanoid" }));

import { POST } from "@/app/api/sites/[id]/competitor-discovery/route";
import { db } from "@/lib/db";

const SITE_ID = "site-es090-cd";
const VALID_TOKEN = "tok_es090_cd_valid";

function baseSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "cd.example.test",
    accessToken: VALID_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    teamId: "team-cd",
    userCompetitors: [],
    discoveredCompetitors: [],
    competitorBlocklist: [],
    ...overrides,
  };
}

function stubDb(site: ReturnType<typeof baseSite> | undefined, team?: { id: string; creditBalance: number }) {
  const selectMock = db.select as unknown as ReturnType<typeof vi.fn>;
  selectMock.mockReset();
  selectMock.mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        const calls = selectMock.mock.calls.length;
        if (calls === 1) return Promise.resolve(site ? [site] : []);
        return Promise.resolve(team ? [team] : []);
      }),
    })),
  }));
}

function buildReq(token: string | null): NextRequest {
  const url = token
    ? `https://app.test/api/sites/${SITE_ID}/competitor-discovery?token=${encodeURIComponent(token)}`
    : `https://app.test/api/sites/${SITE_ID}/competitor-discovery`;
  return new NextRequest(new URL(url), { method: "POST" });
}

const ctx = { params: Promise.resolve({ id: SITE_ID }) };

describe("ES-090 CRIT-1 / POST /api/sites/[id]/competitor-discovery — token expiry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is in the past", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1000) }), { id: "team-cd", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is NULL", async () => {
    stubDb(baseSite({ tokenExpiresAt: null }), { id: "team-cd", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("expiry check precedes credit debit (update not called)", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1) }));
    await POST(buildReq(VALID_TOKEN), ctx);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("wrong token returns plain 401 (no TOKEN_EXPIRED)", async () => {
    stubDb(baseSite());
    const res = await POST(buildReq("wrong"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it("returns 404 on missing site before expiry check", async () => {
    stubDb(undefined);
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(404);
  });

  it("happy path does not return 401 TOKEN_EXPIRED", async () => {
    stubDb(baseSite(), { id: "team-cd", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    if (res.status === 401) {
      const body = await res.json();
      expect(body.code).not.toBe("TOKEN_EXPIRED");
    }
  });
});
