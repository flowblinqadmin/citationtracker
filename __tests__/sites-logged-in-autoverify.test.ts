/**
 * POST /api/sites — logged-in auto-verify hardening.
 *
 * Regression cover for the silent OTP dead-end: a logged-in, entitled user
 * whose request lacks the middleware-stamped `x-user-email` header (but
 * carries a valid Supabase auth cookie) must still skip OTP and auto-start
 * the audit via the verified server-side getUser() fallback.
 *
 * Also asserts the guard: anonymous submissions (no auth cookie) never pay
 * for the getUser() round-trip and keep the existing OTP free-audit flow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({ nanoid: vi.fn().mockReturnValue("mock-id") }));

const mockSendVerificationEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/email", () => ({
  generateVerificationCode: vi.fn().mockReturnValue("123456"),
  hashCode: vi.fn().mockReturnValue("hashed"),
  sendVerificationEmail: (...a: unknown[]) => mockSendVerificationEmail(...a),
  sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined),
  sendInternalSignupAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() + 60000 }),
}));

const mockEnqueueStage = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/qstash", () => ({ enqueueStage: (...a: unknown[]) => mockEnqueueStage(...a) }));

vi.mock("@/lib/services/page-accounting", () => ({
  resolveCrawlBudget: vi.fn(),
  resolveFirstAuditMaxPages: vi.fn().mockReturnValue({
    maxPages: 100,
    creditsToReserve: 0,
    subscriptionPages: 100,
    creditPages: 0,
    creditsRequired: 0,
    creditsToDeduct: 0,
    denied: false,
  }),
}));

// Verified server-side session fallback.
const mockGetUser = vi.fn();
const mockCreateClient = vi.fn(async () => ({ auth: { getUser: mockGetUser } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

// ─── Imports after mocks ───────────────────────────────────────────────────────

import { POST as postSites } from "@/app/api/sites/route";
import { db } from "@/lib/db";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function selectChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(rows), limit: vi.fn().mockReturnThis() };
}
function insertChain() {
  // .values() must be awaitable, expose .catch (teamDomains insert), and
  // expose .returning() (regenerate-style inserts) — cover all three.
  return {
    values: vi.fn(() =>
      Object.assign(Promise.resolve([{ id: "mock-id" }]), {
        returning: vi.fn().mockResolvedValue([{ id: "mock-id" }]),
      }),
    ),
  };
}

function makeReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const PRO_TEAM = {
  id: "team-1",
  creditBalance: 478,
  subscriptionTier: "pro",
  subscriptionStatus: "active",
  monthlyPageAllowance: 500,
  monthlyPagesUsed: 0,
};

describe("POST /api/sites — logged-in auto-verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Per-tier site cap (slot-3 tier.sites + slot-5 countTeamSites) calls
    // db.selectDistinct(...).from(geoSites).where(...). Default it to 0 used
    // sites (< any cap) so the cap check passes and the request proceeds.
    (db.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue(selectChain([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain());
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) });
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue([]) })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      }),
    );
  });

  it("logged-in via cookie (no x-user-email header) auto-verifies and starts the audit", async () => {
    // session cookie present, header absent → getUser() fallback resolves the user
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1", email: "pro@company.com" } }, error: null });

    // select order: existing site → teamMembers → teams → completedForDomain
    const selects = [
      selectChain([]),                                                   // existing site (none)
      selectChain([{ id: "user-1", email: "pro@company.com", teamId: "team-1" }]), // teamMembers
      selectChain([PRO_TEAM]),                                           // teams
      selectChain([]),                                                   // completedForDomain (none)
    ];
    let i = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => selects[i++] ?? selectChain([]));

    const res = await postSites(
      makeReq({ url: "https://example.com", email: "pro@company.com" }, { cookie: "sb-proj-auth-token=abc" }),
    );

    expect(mockCreateClient).toHaveBeenCalled(); // verified fallback fired
    expect(res.status).toBe(201);
    const body = await res.json() as { skipVerify?: boolean; accessToken?: string };
    expect(body.skipVerify).toBe(true);               // OTP skipped
    expect(body.accessToken).toBeTruthy();            // token minted → no dead-end
    expect(mockEnqueueStage).toHaveBeenCalled();      // pipeline started
    expect(mockSendVerificationEmail).not.toHaveBeenCalled(); // no OTP email
  });

  it("anonymous submission (no auth cookie) skips getUser() and stays on the OTP path", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain([])); // no team, no existing

    const res = await postSites(makeReq({ url: "https://example.com", email: "anon@gmail.com" }));

    expect(mockCreateClient).not.toHaveBeenCalled();      // no round-trip for anon funnel
    expect(res.status).toBe(201);
    expect(mockSendVerificationEmail).toHaveBeenCalled(); // free-audit OTP still sent
  });
});
