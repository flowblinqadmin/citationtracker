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

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-nanoid"),
}));

import { POST } from "./route";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-1", email: "alice@example.com", token: "tok", tokenExpiry: null };

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/teams/domains/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const UNCLAIMED_SITE = {
  id: "site-1",
  domain: "example.com",
  slug: "example-com",
  ownerEmail: "alice@example.com",
  teamId: null, // unclaimed
  userId: null,
  accessToken: "valid-access-token",
  pipelineStatus: "complete",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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

function mockSelectSequence(sequences: unknown[][]) {
  sequences.forEach((rows) => {
    const chain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) };
    vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);
  });
}

function mockUpdateChain() {
  const setChain = { where: vi.fn().mockResolvedValue(undefined) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  vi.mocked(db.update).mockReturnValue(chain as unknown as ReturnType<typeof db.update>);
  return chain;
}

function mockInsertChain() {
  const chain = { values: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(db.insert).mockReturnValue(chain as unknown as ReturnType<typeof db.insert>);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/teams/domains/claim — authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when no authenticated user", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    const res = await POST(makeRequest({ siteId: "site-1", accessToken: "tok" }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});

describe("POST /api/teams/domains/claim — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 400 when siteId is missing", async () => {
    const res = await POST(makeRequest({ accessToken: "valid-access-token" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when accessToken is missing", async () => {
    const res = await POST(makeRequest({ siteId: "site-1" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/teams/domains/claim — site lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 404 when siteId does not exist or accessToken is wrong", async () => {
    // Site lookup → nothing found (wrong id or bad token)
    mockSelectSequence([[]]);

    const res = await POST(makeRequest({ siteId: "wrong-site", accessToken: "wrong-token" }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found|invalid/i);
  });

  it("returns 409 when site is already claimed by a team", async () => {
    const claimedSite = { ...UNCLAIMED_SITE, teamId: "some-other-team" };
    mockSelectSequence([[claimedSite]]);

    const res = await POST(makeRequest({ siteId: "site-1", accessToken: "valid-access-token" }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already claimed/i);
  });

  it("returns 404 when authenticated user has no team membership", async () => {
    // Site found, but user has no membership
    mockSelectSequence([[UNCLAIMED_SITE], []]);

    const res = await POST(makeRequest({ siteId: "site-1", accessToken: "valid-access-token" }));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no team/i);
  });
});

describe("POST /api/teams/domains/claim — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 200 with claimed domain on success", async () => {
    mockSelectSequence([[UNCLAIMED_SITE], [MEMBERSHIP]]);
    mockUpdateChain();
    mockInsertChain();

    const res = await POST(makeRequest({ siteId: "site-1", accessToken: "valid-access-token" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { message: string; domain: string };
    expect(body.message).toMatch(/claimed/i);
    expect(body.domain).toBe("example.com");
  });

  it("updates geoSites with teamId and userId", async () => {
    mockSelectSequence([[UNCLAIMED_SITE], [MEMBERSHIP]]);
    const updateChain = mockUpdateChain();
    mockInsertChain();

    await POST(makeRequest({ siteId: "site-1", accessToken: "valid-access-token" }));

    expect(db.update).toHaveBeenCalledTimes(1);
    const setArgs = updateChain.set.mock.calls[0][0] as { teamId: string; userId: string };
    expect(setArgs.teamId).toBe("team-1");
    expect(setArgs.userId).toBe("user-1");
  });

  it("inserts a teamDomains row with correct siteId and domain", async () => {
    mockSelectSequence([[UNCLAIMED_SITE], [MEMBERSHIP]]);
    mockUpdateChain();
    const insertChain = mockInsertChain();

    await POST(makeRequest({ siteId: "site-1", accessToken: "valid-access-token" }));

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = insertChain.values.mock.calls[0][0] as {
      teamId: string;
      siteId: string;
      domain: string;
      addedByUserId: string;
    };
    expect(insertedValues.teamId).toBe("team-1");
    expect(insertedValues.siteId).toBe("site-1");
    expect(insertedValues.domain).toBe("example.com");
    expect(insertedValues.addedByUserId).toBe("user-1");
  });
});
