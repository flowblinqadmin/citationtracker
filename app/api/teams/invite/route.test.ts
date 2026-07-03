import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// vi.hoisted() runs before vi.mock() factories
const { mockSendTeamInviteEmail } = vi.hoisted(() => ({
  mockSendTeamInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/supabase/authenticated-client", () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 9 })),
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
  nanoid: vi.fn(() => "test-nanoid-32chars"),
}));

vi.mock("@/lib/email", () => ({
  sendTeamInviteEmail: mockSendTeamInviteEmail,
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
    new Request("http://localhost/api/teams/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const OWNER_MEMBERSHIP = {
  id: "mem-1",
  teamId: "team-1",
  userId: "user-1",
  email: "alice@example.com",
  role: "owner",
  inviteToken: null,
  inviteAcceptedAt: null,
  createdAt: new Date(),
};

const MOCK_TEAM = { id: "team-1", name: "Alice's Team" };

function mockSelectSequence(...sequences: unknown[][]) {
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = sequences[call] ?? [];
    call++;
    return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows) } as unknown as ReturnType<typeof db.select>;
  });
}

function mockInsertResolving() {
  const chain = { values: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(db.insert).mockReturnValue(chain as unknown as ReturnType<typeof db.insert>);
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/teams/invite — authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no authenticated user", async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(null);

    const res = await POST(makeRequest({ email: "bob@example.com" }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Unauthorized");
  });
});

describe("POST /api/teams/invite — email validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 400 when email is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/email/i);
  });

  it("returns 400 when email is an empty string", async () => {
    const res = await POST(makeRequest({ email: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an obviously invalid email", async () => {
    const res = await POST(makeRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for email missing TLD (no second dot segment)", async () => {
    const res = await POST(makeRequest({ email: "user@nodot" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/teams/invite — authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
  });

  it("returns 403 when caller is not an owner", async () => {
    mockSelectSequence([]);

    const res = await POST(makeRequest({ email: "bob@example.com" }));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/owner/i);
  });
});

describe("POST /api/teams/invite — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthenticatedUser).mockResolvedValue(MOCK_USER);
    process.env.NEXT_PUBLIC_APP_URL = "https://geo.example.com";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("returns 200 with 'Invite sent' when owner sends a valid invite", async () => {
    // select sequence: 1) owner membership, 2) no existing invite, 3) team row
    mockSelectSequence([OWNER_MEMBERSHIP], [], [MOCK_TEAM]);
    mockInsertResolving();

    const res = await POST(makeRequest({ email: "bob@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("Invite sent");
  });

  it("returns 200 with 'Invite already sent' when a pending invite exists", async () => {
    const existingInvite = { ...OWNER_MEMBERSHIP, id: "mem-bob", email: "bob@example.com", role: "member", userId: null, inviteToken: null };
    mockSelectSequence([OWNER_MEMBERSHIP], [existingInvite]);

    const res = await POST(makeRequest({ email: "bob@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("Invite already sent");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("calls sendTeamInviteEmail with the correct email and team name", async () => {
    mockSelectSequence([OWNER_MEMBERSHIP], [], [MOCK_TEAM]);
    mockInsertResolving();

    await POST(makeRequest({ email: "bob@example.com" }));

    expect(mockSendTeamInviteEmail).toHaveBeenCalledTimes(1);
    const [emailArg, teamNameArg, inviterArg] = mockSendTeamInviteEmail.mock.calls[0] as [string, string, string];
    expect(emailArg).toBe("bob@example.com");
    expect(teamNameArg).toBe("Alice's Team");
    expect(inviterArg).toBe("alice@example.com");
  });

  it("inserts a pending teamMembers row with correct teamId and role", async () => {
    mockSelectSequence([OWNER_MEMBERSHIP], [], [MOCK_TEAM]);
    const insertChain = mockInsertResolving();

    await POST(makeRequest({ email: "bob@example.com" }));

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertedValues = insertChain.values.mock.calls[0][0] as {
      teamId: string;
      role: string;
      email: string;
      userId: null;
    };
    expect(insertedValues.teamId).toBe("team-1");
    expect(insertedValues.role).toBe("member");
    expect(insertedValues.email).toBe("bob@example.com");
    expect(insertedValues.userId).toBeNull();
  });

  it("normalizes email to lowercase before inserting", async () => {
    mockSelectSequence([OWNER_MEMBERSHIP], [], [MOCK_TEAM]);
    const insertChain = mockInsertResolving();

    await POST(makeRequest({ email: "BOB@EXAMPLE.COM" }));

    const insertedValues = insertChain.values.mock.calls[0][0] as { email: string };
    expect(insertedValues.email).toBe("bob@example.com");
  });

  it("returns 500 when email send fails", async () => {
    mockSelectSequence([OWNER_MEMBERSHIP], [], [MOCK_TEAM]);
    mockInsertResolving();
    mockSendTeamInviteEmail.mockRejectedValueOnce(new Error("SMTP error"));

    const res = await POST(makeRequest({ email: "bob@example.com" }));
    expect(res.status).toBe(500);
  });
});
