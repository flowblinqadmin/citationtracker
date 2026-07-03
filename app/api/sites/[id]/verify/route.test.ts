import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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
  gte: vi.fn((_col: unknown, _val: unknown) => ({ _gte: [_col, _val] })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-nanoid-32chars-000000000000"),
}));

vi.mock("@/lib/email", () => ({
  verifyCode: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  // ES-090 HP-239: split primitives. Route calls checkOtpLock +
  // incrementOtpAttempt; legacy wrapper kept for tests that reference it.
  checkOtpLock: vi.fn(),
  incrementOtpAttempt: vi.fn().mockResolvedValue({ lockedOut: false }),
  clearOtpAttempts: vi.fn(),
  checkAndIncrementOtpAttempt: vi.fn(),
}));

vi.mock("@/lib/qstash", () => ({
  enqueueStage: vi.fn(),
}));

const mockCreateUser = vi.fn();
const mockGenerateLink = vi.fn();
const mockAdmin = {
  auth: { admin: { createUser: mockCreateUser, generateLink: mockGenerateLink } },
};

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(() => mockAdmin),
}));

const mockEnsureTeamForUser = vi.fn();
vi.mock("@/lib/services/provision-team", () => ({
  ensureTeamForUser: (...args: unknown[]) => mockEnsureTeamForUser(...args),
}));

vi.mock("@/lib/services/exchange-code", () => ({
  generateExchangeCode: vi.fn().mockResolvedValue("mock-exchange-code"),
}));

// Mock global fetch for the GoTrue token exchange (only intercepts /auth/v1/verify calls)
const originalFetch = globalThis.fetch;
const mockGoTrueResponse = vi.fn();
const mockGoTrueFetch = vi.fn((...args: Parameters<typeof fetch>) => {
  const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
  if (url.includes("/auth/v1/verify")) {
    return Promise.resolve(mockGoTrueResponse());
  }
  return originalFetch(...args);
});

import { POST } from "./route";
import { db } from "@/lib/db";
import { verifyCode } from "@/lib/email";
import { checkAndIncrementOtpAttempt, checkOtpLock } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-123",
    domain: "example.com",
    ownerEmail: "user@example.com",
    emailVerified: false,
    verificationCode: "hashed-code",
    codeExpiresAt: new Date(Date.now() + 60_000),
    accessToken: null,
    teamId: null,
    userId: null,
    pipelineStatus: "pending",
    geoScorecard: null,
    auditMode: "single",
    bulkUrls: null,
    batchId: null,
    ...overrides,
  };
}

function makeReq(siteId: string, code: string) {
  return new NextRequest(`http://localhost/api/sites/${siteId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/**
 * Queue DB select results in order. Each element is the rows array for one select call.
 * Call once with ALL selects the route will hit (site lookup, teamMembers, teamDomains, teams).
 */
function mockSelectSequence(sequences: unknown[][]) {
  sequences.forEach((rows) => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);
  });
}

function mockInsert() {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const chain = { values: vi.fn().mockReturnValue({ onConflictDoNothing }) };
  vi.mocked(db.insert).mockReturnValue(chain as unknown as ReturnType<typeof db.insert>);
  return chain;
}

function mockUpdate() {
  // FIX-014: .where() is awaitable AND exposes .returning() (rows-affected guard)
  // resolving to one row so the guarded credit reserve treats it as applied.
  const whereResult = Object.assign(Promise.resolve(undefined), {
    returning: vi.fn().mockResolvedValue([{ id: "team-new" }]),
  });
  const setChain = { where: vi.fn().mockReturnValue(whereResult) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  vi.mocked(db.update).mockReturnValue(chain as unknown as ReturnType<typeof db.update>);
  return chain;
}

function setupHappyPath() {
  // HP-239: route now calls checkOtpLock (read-only) + incrementOtpAttempt.
  // Leave legacy mock in place for any test that still references it.
  vi.mocked(checkOtpLock).mockResolvedValue({ allowed: true });
  vi.mocked(checkAndIncrementOtpAttempt).mockResolvedValue({ allowed: true, attemptsLeft: 5 });
  vi.mocked(verifyCode).mockReturnValue(true);
}

const routeContext = { params: Promise.resolve({ id: "site-123" }) };

// ---------------------------------------------------------------------------
// Tests — Supabase auth integration
// ---------------------------------------------------------------------------

describe("POST /api/sites/[id]/verify — Supabase auth integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
    mockCreateUser.mockResolvedValue({ data: { user: { id: "supa-user-1" } }, error: null });
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: "magic-token-abc" }, user: { id: "supa-user-1" } },
      error: null,
    });
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-new", isNewTeam: true });
    // Mock GoTrue fetch for server-side token exchange
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    mockGoTrueResponse.mockReturnValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "at-123", refresh_token: "rt-456" }),
      text: () => Promise.resolve(""),
    });
    globalThis.fetch = mockGoTrueFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns authOtp and email on successful verify (new user)", async () => {
    // Select sequence: site, teamDomains check, consent check, teams credit check
    mockSelectSequence([
      [makeSite()],
      [],  // no existing teamDomains
      [{ id: "consent-exists" }],  // consent check → user has consented
      [{ id: "team-new", creditBalance: 20 }],  // teams credit check
    ]);
    mockUpdate();
    mockInsert();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(body.success).toBe(true);
    // authOtp is now a JSON string containing session tokens from server-side exchange
    const tokens = JSON.parse(body.authOtp);
    expect(tokens.access_token).toBe("at-123");
    expect(tokens.refresh_token).toBe("rt-456");
    expect(body.email).toBe("user@example.com");
    expect(body.accessToken).toBeDefined();
  });

  it("returns success WITHOUT authOtp when admin client is null (tests/build)", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null);

    // No admin → falls through to legacy path: site lookup, then teamMembers lookup (no match)
    mockSelectSequence([
      [makeSite()],
      [],  // legacy teamMembers lookup → no match, so no team link
    ]);
    mockUpdate();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.authOtp).toBeUndefined();
    expect(body.accessToken).toBeDefined();
  });

  it("still succeeds when createUser fails with non-registration error", async () => {
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: "Rate limit exceeded" },
    });
    // generateLink still returns user → ensureTeamForUser IS called (correct behavior)
    // Select sequence: site, teamDomains check, consent check, teams credit check
    mockSelectSequence([
      [makeSite()],
      [],  // teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-new", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(body.success).toBe(true);
    // generateLink returns user.id → ensureTeamForUser IS called
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith("supa-user-1", "user@example.com", { skipBonus: true });
  });

  it("handles 'already registered' by extracting user ID from generateLink response", async () => {
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: "A user with this email address has already been registered" },
    });
    // generateLink returns the existing user's ID
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: "token-existing" }, user: { id: "supa-existing" } },
      error: null,
    });

    // Select sequence: site, teamDomains check, consent check, teams credit check
    mockSelectSequence([
      [makeSite()],
      [],  // no existing teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-new", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockEnsureTeamForUser).toHaveBeenCalledWith("supa-existing", "user@example.com", { skipBonus: true });
  });

  it("returns success even if generateLink fails (non-fatal, no authOtp)", async () => {
    mockGenerateLink.mockResolvedValue({
      data: null,
      error: { message: "Token generation failed" },
    });

    // createUser succeeds (supaUserId set), generateLink fails (no authOtp)
    // ensureTeamForUser still runs because createUser gave us the userId
    // Select sequence: site, teamDomains check, consent check, teams credit check
    mockSelectSequence([
      [makeSite()],
      [],  // teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-new", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.authOtp).toBeUndefined();
    expect(body.accessToken).toBeDefined();
    // Team still provisioned even though generateLink failed
    expect(mockEnsureTeamForUser).toHaveBeenCalled();
  });

  it("returns success even if ensureTeamForUser throws for a FREE user (non-fatal)", async () => {
    mockEnsureTeamForUser.mockRejectedValue(new Error("DB timeout"));

    mockSelectSequence([
      [makeSite()],
      [], // FIX-015 billable check: owner email has no team membership → free user
    ]);
    mockUpdate();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    // Free flow: a provisioning blip is non-fatal — the free audit still runs.
    expect(body.success).toBe(true);
    expect(body.accessToken).toBeDefined();
  });

  it("FIX-015: returns 500 (retryable) when ensureTeamForUser throws for a PAID user", async () => {
    mockEnsureTeamForUser.mockRejectedValue(new Error("DB timeout"));

    mockSelectSequence([
      [makeSite()],
      [{ id: "m1", teamId: "team-paid", email: "user@example.com" }], // billable check: membership
      [{ id: "team-paid", creditBalance: 50, subscriptionTier: "free", subscriptionStatus: "inactive" }], // paid (credits)
    ]);
    mockUpdate();

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — data isolation
// ---------------------------------------------------------------------------

describe("POST /api/sites/[id]/verify — data isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
    mockCreateUser.mockResolvedValue({ data: { user: { id: "supa-user-1" } }, error: null });
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: "token-xyz" }, user: { id: "supa-user-1" } },
      error: null,
    });
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-1", isNewTeam: true });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    mockGoTrueResponse.mockReturnValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "at-xyz", refresh_token: "rt-xyz" }),
      text: () => Promise.resolve(""),
    });
    globalThis.fetch = mockGoTrueFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createUser is called with site.ownerEmail (not arbitrary email)", async () => {
    mockSelectSequence([
      [makeSite({ ownerEmail: "legitimate@example.com" })],
      [],  // teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-1", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    await POST(makeReq("site-123", "123456"), routeContext);

    expect(mockCreateUser).toHaveBeenCalledWith({
      email: "legitimate@example.com",
      email_confirm: true,
    });
  });

  it("ensureTeamForUser is called with correct userId + ownerEmail", async () => {
    mockCreateUser.mockResolvedValue({ data: { user: { id: "supa-user-specific" } }, error: null });

    mockSelectSequence([
      [makeSite({ ownerEmail: "specific@example.com" })],
      [],  // teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-1", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    await POST(makeReq("site-123", "123456"), routeContext);

    expect(mockEnsureTeamForUser).toHaveBeenCalledWith("supa-user-specific", "specific@example.com", { skipBonus: true });
  });

  it("does NOT re-link site to team if site already has a teamId", async () => {
    // Site already has teamId → no update to link it to the new team
    mockSelectSequence([
      [makeSite({ teamId: "team-already", userId: "user-already" })],
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-already", creditBalance: 20 }],  // credit check uses existing team
    ]);
    mockUpdate();
    mockInsert();

    await POST(makeReq("site-123", "123456"), routeContext);

    // ensureTeamForUser still runs (provisions user's team if needed)
    expect(mockEnsureTeamForUser).toHaveBeenCalled();
    // db.insert should only be called for credit transaction, NOT for teamDomains
    const insertCalls = vi.mocked(db.insert).mock.calls;
    const teamDomainInsert = insertCalls.find((args) => {
      // Round 3 TS fix (2026-04-10): was `args[0] as { [Symbol: string | symbol]: unknown }`
      // which is not valid TS syntax (Symbol isn't a valid index-signature key name
      // in TS — you need `[key: symbol]`). Cast to Record<symbol, unknown> instead.
      const table = args[0] as unknown as Record<symbol, unknown>;
      return String(table[Symbol.for("drizzle:Name")] ?? table[Symbol.for("drizzle:OriginalName")] ?? "").includes("team_domain");
    });
    expect(teamDomainInsert).toBeUndefined();
  });

  it("generateLink uses site.ownerEmail only", async () => {
    mockSelectSequence([
      [makeSite({ ownerEmail: "owner-only@example.com" })],
      [],  // teamDomains
      [{ id: "consent-exists" }],  // consent check
      [{ id: "team-1", creditBalance: 20 }],
    ]);
    mockUpdate();
    mockInsert();

    await POST(makeReq("site-123", "123456"), routeContext);

    expect(mockGenerateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "owner-only@example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — basic validation (non-happy)
// ---------------------------------------------------------------------------

describe("POST /api/sites/[id]/verify — basic validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid code format (too short)", async () => {
    const res = await POST(makeReq("site-123", "123"), routeContext);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid code format");
  });

  it("returns 404 for non-existent site", async () => {
    mockSelectSequence([[]]);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    expect(res.status).toBe(404);
  });

  // HP-237: rate-limit / expired-code / wrong-code ALL now return 401 generic
  // "Invalid or expired code" (shared assertOtpGate helper; no info leak).
  it("returns 401 generic when rate limited (HP-237 / HP-239)", async () => {
    // HP-239: route reads lock via checkOtpLock (read-only, no increment).
    vi.mocked(checkOtpLock).mockResolvedValue({ allowed: false });
    mockSelectSequence([[makeSite()]]);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired code");
  });

  it("returns 401 generic for expired code (HP-237 / HP-239)", async () => {
    vi.mocked(checkOtpLock).mockResolvedValue({ allowed: true });
    mockSelectSequence([[makeSite({ codeExpiresAt: new Date(Date.now() - 60_000) })]]);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired code");
  });

  it("returns 401 generic for wrong code (HP-237 / HP-239)", async () => {
    vi.mocked(checkOtpLock).mockResolvedValue({ allowed: true });
    vi.mocked(verifyCode).mockReturnValue(false);
    mockSelectSequence([[makeSite()]]);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid or expired code");
  });

  it("returns success for already-verified site (no authOtp, no re-auth)", async () => {
    // HP-224: re-login path now rotates on expired/NULL tokenExpiresAt.
    // HP-237: re-login path now requires valid OTP (fixture provides one).
    // HP-239: route calls checkOtpLock (read-only).
    vi.mocked(checkOtpLock).mockResolvedValue({ allowed: true });
    vi.mocked(verifyCode).mockReturnValue(true);
    mockSelectSequence([[makeSite({
      emailVerified: true,
      accessToken: "existing-token",
      tokenExpiresAt: new Date(Date.now() + 60 * 86_400_000),
      verificationCode: "hashed-123456",
      codeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })]]);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.accessToken).toBe("existing-token");
    expect(body.authOtp).toBeUndefined();
    // No Supabase admin calls for already-verified sites
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — bulk verify teamDomains insert
// ---------------------------------------------------------------------------

describe("POST /api/sites/[id]/verify — bulk verify teamDomains", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
    mockCreateUser.mockResolvedValue({ data: { user: { id: "supa-user-1" } }, error: null });
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: "token-bulk" }, user: { id: "supa-user-1" } },
      error: null,
    });
    mockEnsureTeamForUser.mockResolvedValue({ teamId: "team-bulk", isNewTeam: false });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
    mockGoTrueResponse.mockReturnValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "at-bulk", refresh_token: "rt-bulk" }),
      text: () => Promise.resolve(""),
    });
    globalThis.fetch = mockGoTrueFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("inserts a teamDomains row for every site in the batch (multi-site)", async () => {
    const primarySite = makeSite({
      auditMode: "bulk",
      teamId: "team-bulk",
      userId: null,
      batchId: "batch-xyz",
      bulkUrls: ["https://example.com/page1"],
    });
    const site2 = {
      ...primarySite,
      id: "site-456",
      domain: "example2.com",
      bulkUrls: ["https://example2.com/page1"],
    };

    // Select sequence: site, hasConsent, teams (bulk path), geoSites by batchId
    mockSelectSequence([
      [primarySite],
      [{ id: "consent-1" }],
      [{ id: "team-bulk", creditBalance: 10 }],
      [primarySite, site2],
    ]);

    mockUpdate();

    // Round 3 TS fix (2026-04-10): drizzle's db.transaction expects a callback
    // typed as `(tx: PgTransaction<...>) => Promise<...>`. The mock callback
    // doesn't use any real PgTransaction methods, so cast the whole
    // mockImplementation through `unknown` to satisfy vitest's mockImplementation
    // signature without reproducing drizzle's full PgTransaction type locally.
    vi.mocked(db.transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
      const mockTx = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(mockTx);
    }) as unknown as typeof db.transaction);

    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesChain = vi.fn().mockReturnValue({ onConflictDoNothing });
    vi.mocked(db.insert).mockReturnValue({ values: valuesChain } as unknown as ReturnType<typeof db.insert>);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // One batch teamDomains insert for all sites in the batch
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(valuesChain).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ siteId: primarySite.id, domain: "example.com", teamId: "team-bulk" }),
        expect.objectContaining({ siteId: site2.id, domain: "example2.com", teamId: "team-bulk" }),
      ])
    );
  });

  it("inserts a teamDomains row for a single-site batch (no batchId)", async () => {
    const primarySite = makeSite({
      auditMode: "bulk",
      teamId: "team-bulk",
      userId: null,
      batchId: null,
      bulkUrls: ["https://example.com/page1"],
    });

    // Select sequence: site, hasConsent, teams (no batchId → no geoSites by batchId select)
    mockSelectSequence([
      [primarySite],
      [{ id: "consent-1" }],
      [{ id: "team-bulk", creditBalance: 5 }],
    ]);

    mockUpdate();

    // Round 3 TS fix (2026-04-10): drizzle's db.transaction expects a callback
    // typed as `(tx: PgTransaction<...>) => Promise<...>`. The mock callback
    // doesn't use any real PgTransaction methods, so cast the whole
    // mockImplementation through `unknown` to satisfy vitest's mockImplementation
    // signature without reproducing drizzle's full PgTransaction type locally.
    vi.mocked(db.transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
      const mockTx = {
        update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(mockTx);
    }) as unknown as typeof db.transaction);

    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const valuesChain = vi.fn().mockReturnValue({ onConflictDoNothing });
    vi.mocked(db.insert).mockReturnValue({ values: valuesChain } as unknown as ReturnType<typeof db.insert>);

    const res = await POST(makeReq("site-123", "123456"), routeContext);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(valuesChain).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ siteId: primarySite.id, domain: "example.com", teamId: "team-bulk" }),
      ])
    );
  });
});
