import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks declared before any imports that touch them ---
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

// Drizzle operator stubs — the route imports eq() but in tests these are
// never evaluated by a real DB engine; we just need them to not throw.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _eq: [_col, _val] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((_col: unknown) => ({ _isNull: _col })),
  sql: vi.fn(),
}));

import { GET } from "./route";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-1", email: "alice@example.com", token: "tok", tokenExpiry: null };

function makeRequest(): NextRequest {
  return new NextRequest(new Request("http://localhost/api/teams/me"));
}

/** Build a mock Drizzle fluent select chain that resolves to `rows`. */
function mockSelectResolving(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
    innerJoin: vi.fn().mockReturnThis(),
  };
  vi.mocked(db.select).mockReturnValue(chain as unknown as ReturnType<typeof db.select>);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/teams/me — authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no authenticated user", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});

describe("GET /api/teams/me — team membership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 404 when user has no team membership", async () => {
    // First select (teamMembers) → empty
    mockSelectResolving([]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("No team found");
  });

  it("returns 404 when membership exists but team row is missing", async () => {
    const membership = {
      id: "mem-1",
      teamId: "team-1",
      userId: "user-1",
      email: "alice@example.com",
      role: "owner",
      inviteToken: null,
      inviteAcceptedAt: null,
      createdAt: new Date(),
    };

    // Sequence of select calls: membership → team → members
    const chain1 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership]) };
    const chain2 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }; // no team
    vi.mocked(db.select)
      .mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain2 as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Team not found");
  });

  it("returns team, role and members list on success", async () => {
    const membership = {
      id: "mem-1",
      teamId: "team-1",
      userId: "user-1",
      email: "alice@example.com",
      role: "owner",
      inviteToken: null,
      inviteAcceptedAt: new Date("2024-01-02"),
      createdAt: new Date("2024-01-01"),
    };
    const team = {
      id: "team-1",
      name: "alice",
      creditBalance: 80,
      ownerUserId: "user-1",
      stripeCustomerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const pendingMember = {
      id: "mem-2",
      teamId: "team-1",
      userId: null, // pending — no userId yet
      email: "bob@example.com",
      role: "member",
      inviteToken: "tok-abc",
      inviteAcceptedAt: null,
      createdAt: new Date("2024-01-03"),
    };

    const chain1 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership]) };
    const chain2 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([team]) };
    const chain3 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership, pendingMember]) };

    vi.mocked(db.select)
      .mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain2 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain3 as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json() as {
      team: { id: string; name: string; creditBalance: number };
      role: string;
      members: Array<{ email: string; role: string; pending: boolean }>;
    };

    expect(body.team).toEqual({ id: "team-1", name: "alice", creditBalance: 80 });
    expect(body.role).toBe("owner");
    expect(body.members).toHaveLength(2);
  });

  it("marks pending members (no userId) with pending: true", async () => {
    const membership = {
      id: "mem-1",
      teamId: "team-1",
      userId: "user-1",
      email: "alice@example.com",
      role: "owner",
      inviteToken: null,
      inviteAcceptedAt: new Date(),
      createdAt: new Date(),
    };
    const team = { id: "team-1", name: "alice", creditBalance: 20, ownerUserId: "user-1", createdAt: new Date(), updatedAt: new Date() };
    const pendingMember = {
      id: "mem-2",
      teamId: "team-1",
      userId: null,
      email: "pending@example.com",
      role: "member",
      inviteToken: "tok-xyz",
      inviteAcceptedAt: null,
      createdAt: new Date(),
    };

    const chain1 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership]) };
    const chain2 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([team]) };
    const chain3 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership, pendingMember]) };

    vi.mocked(db.select)
      .mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain2 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain3 as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    const body = await res.json() as {
      members: Array<{ email: string; pending: boolean }>;
    };

    const alice = body.members.find((m) => m.email === "alice@example.com");
    const pending = body.members.find((m) => m.email === "pending@example.com");

    expect(alice?.pending).toBe(false);
    expect(pending?.pending).toBe(true);
  });

  it("uses inviteAcceptedAt as joinedAt when present, otherwise createdAt", async () => {
    const acceptedAt = new Date("2024-06-15T10:00:00Z");
    const createdAt = new Date("2024-06-01T00:00:00Z");

    const membership = {
      id: "mem-1",
      teamId: "team-1",
      userId: "user-1",
      email: "alice@example.com",
      role: "owner",
      inviteToken: null,
      inviteAcceptedAt: acceptedAt,
      createdAt,
    };
    const team = { id: "team-1", name: "alice", creditBalance: 20, ownerUserId: "user-1", createdAt: new Date(), updatedAt: new Date() };

    const chain1 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership]) };
    const chain2 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([team]) };
    const chain3 = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([membership]) };

    vi.mocked(db.select)
      .mockReturnValueOnce(chain1 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain2 as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce(chain3 as unknown as ReturnType<typeof db.select>);

    const res = await GET(makeRequest());
    const body = await res.json() as { members: Array<{ joinedAt: string }> };

    expect(new Date(body.members[0].joinedAt).toISOString()).toBe(acceptedAt.toISOString());
  });
});
