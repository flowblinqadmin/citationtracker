/**
 * Tests for POST /api/sites/[id]/regenerate — bulk block — ES-005 Task 5
 *
 * Tests:
 *   - Bulk audit → 400 with clear error message
 *   - Single audit → proceeds normally (not blocked)
 *   - Missing token → 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/lib/pipeline/runner", () => ({
  startCrawl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: vi.fn((fn: () => Promise<void>) => fn()) };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import { POST } from "@/app/api/sites/[id]/regenerate/route";
import { db } from "@/lib/db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[] = []) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  };
}

function makeInsertChain() {
  return { values: vi.fn().mockResolvedValue([]) };
}

function makeRequest(siteId: string, token?: string): import("next/server").NextRequest {
  return new Request(`http://localhost/api/sites/${siteId}/regenerate`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as import("next/server").NextRequest;
}

function makeRouteContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SITE_ID = "site-regen-123";
const TOKEN = "valid-regen-token";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/sites/[id]/regenerate — bulk block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeUpdateChain());
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeInsertChain());
  });

  it("ES-B9.2 AC-B9.2-1: bulk audit with missing bulkUrls → 400 with new copy (the prior CSV-upload block is gone)", async () => {
    // Pre-B9.2: any bulk audit returned 400 with "Bulk audits cannot be
    // regenerated. Upload a new CSV on the landing page." Post-B9.2: bulk
    // audits are re-runnable; only a missing/empty bulkUrls list yields a
    // 400 with the new "Original URL list missing — please re-upload via
    // the landing page" copy.
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([
        {
          id: SITE_ID,
          accessToken: TOKEN,
          tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
          auditMode: "bulk",
          bulkUrls: null, // ← triggers the new B9.2 fallback
          domain: "acme.io",
          teamId: "team-1",
          manualRunsThisMonth: 0,
          pipelineStatus: "complete",
          paymentStatus: "active",
        },
      ])
    );

    const res = await POST(makeRequest(SITE_ID, TOKEN), makeRouteContext(SITE_ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Original URL list missing/i);
    expect(body.error).toMatch(/re-upload via the landing page/i);
    // Old copy must be GONE.
    expect(body.error).not.toMatch(/bulk audits cannot be regenerated/i);
  });

  it("does NOT block regeneration for single audits (auditMode='single')", async () => {
    let selectCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return makeSelectChain([
          {
            id: SITE_ID,
            accessToken: TOKEN,
            tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),            auditMode: "single",
            domain: "acme.io",
            teamId: null, // free tier
            manualRunsThisMonth: 0,
            pipelineStatus: "complete",
            paymentStatus: "pending",
          },
        ]);
      }
      return makeSelectChain([]); // no team
    });

    const res = await POST(makeRequest(SITE_ID, TOKEN), makeRouteContext(SITE_ID));
    // Should NOT return 400 bulk block — could be 200, 402, etc. depending on tier
    expect(res.status).not.toBe(400);
    // Ensure it didn't return the bulk error message
    const body = await res.json();
    expect(body.error ?? "").not.toMatch(/bulk audits cannot be regenerated/i);
  });

  it("returns 401 when authorization token is missing", async () => {
    const res = await POST(makeRequest(SITE_ID), makeRouteContext(SITE_ID));
    expect(res.status).toBe(401);
  });
});
