/**
 * ES-090 Phase 1 (ScriptDev) — CRIT-1 token expiry on
 * POST /api/sites/[id]/regenerate.
 *
 * ChangedSpec §b.2 step 3 bullet 3 — expiry check at :29+. Note this route
 * collapses `!site || accessToken !== token` into a single 401 (line 29);
 * the expiry gate must come after this block, not before (so a missing site
 * still returns 401 via the existing code path).
 *
 * ChangedSpec §b.2 step 4 — regenerate ALSO rotates: new accessToken,
 * refreshed tokenExpiresAt = now+90d, tokenRotatedAt = now. That write-path
 * assertion lives in token-expiry-write-paths.spec.ts (U1/U2 scope).
 * This file tests the EXPIRY-GATE side only.
 *
 * Semantic: per §b.2 step 4 commentary, the old (expired) token may still
 * rotate itself — but the spec test plan U6 pins "expired-token holder
 * cannot regenerate" → 401. Treating the existing expired token as "invalid"
 * is the safer read (rotation = authenticated action; if you're holding an
 * expired token you're unauthenticated). That's what HP-197 "NULL/past =
 * expired" implies for every enforcement site — including regenerate.
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

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn().mockResolvedValue({ messageId: "mock-msg" }),
}));

vi.mock("nanoid", () => ({ nanoid: () => "mock-regen-token" }));

import { POST } from "@/app/api/sites/[id]/regenerate/route";
import { db } from "@/lib/db";

const SITE_ID = "site-es090-regen";
const VALID_TOKEN = "tok_es090_regen_valid";

function baseSite(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    domain: "regen.example.test",
    accessToken: VALID_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    teamId: "team-regen",
    auditMode: null,
    pipelineStatus: "complete",
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
    ? `https://app.test/api/sites/${SITE_ID}/regenerate?token=${encodeURIComponent(token)}`
    : `https://app.test/api/sites/${SITE_ID}/regenerate`;
  return new NextRequest(new URL(url), { method: "POST" });
}

const ctx = { params: Promise.resolve({ id: SITE_ID }) };

describe("ES-090 CRIT-1 / POST /api/sites/[id]/regenerate — token expiry (U6)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is in the past (U6)", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1000) }), { id: "team-regen", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("returns 401 TOKEN_EXPIRED when tokenExpiresAt is NULL (HP-197)", async () => {
    stubDb(baseSite({ tokenExpiresAt: null }), { id: "team-regen", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("expired token does NOT trigger rotation / QStash enqueue", async () => {
    stubDb(baseSite({ tokenExpiresAt: new Date(Date.now() - 1) }));
    const { enqueueStage } = await import("@/lib/qstash");
    await POST(buildReq(VALID_TOKEN), ctx);
    // Rotation work must not fire when the caller's token is expired.
    expect(enqueueStage).not.toHaveBeenCalled();
  });

  it("wrong token returns plain 401 (no TOKEN_EXPIRED) — site/token merged check", async () => {
    stubDb(baseSite());
    const res = await POST(buildReq("wrong"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it("missing site returns plain 401 (route collapses !site||mismatch → 401)", async () => {
    // Regenerate, unlike GET /sites/[id], does not distinguish 404 vs 401.
    stubDb(undefined);
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it("happy path does not return 401 TOKEN_EXPIRED", async () => {
    stubDb(baseSite(), { id: "team-regen", creditBalance: 100 });
    const res = await POST(buildReq(VALID_TOKEN), ctx);
    if (res.status === 401) {
      const body = await res.json();
      expect(body.code).not.toBe("TOKEN_EXPIRED");
    }
  });
});
