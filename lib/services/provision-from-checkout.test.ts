/**
 * Tests for provisionUserAndTeamFromEmail (lib/services/provision-from-checkout.ts)
 *
 *   - new user → creates user, mints magic link, provisions team → succeeded
 *   - existing user (createUser collision) → found via listUsers → succeeded
 *   - collision but listUsers miss → not succeeded
 *   - Supabase admin unavailable → not succeeded (never throws)
 *   - empty email → not succeeded
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSupabaseAdmin, mockEnsureTeam } = vi.hoisted(() => ({
  mockGetSupabaseAdmin: vi.fn(),
  mockEnsureTeam: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }));
vi.mock("@/lib/services/provision-team", () => {
  // Defined inside the factory (vi.mock is hoisted above top-level declarations,
  // so a class declared outside would hit the TDZ). The SUT and this test both
  // import ProvisionError from the mocked module, so instanceof matches.
  class ProvisionError extends Error {
    constructor(public readonly reason: string, message?: string) {
      super(message ?? reason);
      this.name = "ProvisionError";
    }
  }
  return { ensureTeamForUser: mockEnsureTeam, ProvisionError };
});

import { provisionUserAndTeamFromEmail } from "@/lib/services/provision-from-checkout";
import { ProvisionError } from "@/lib/services/provision-team";

function makeAdmin(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      admin: {
        createUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_new" } }, error: null }),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
        generateLink: vi.fn().mockResolvedValue({
          data: { properties: { action_link: "https://geo.flowblinq.com/magic?token=abc" }, user: { id: "user_new" } },
          error: null,
        }),
        ...overrides,
      },
    },
  };
}

describe("provisionUserAndTeamFromEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureTeam.mockResolvedValue({ teamId: "team_1", isNewTeam: true });
  });

  it("provisions a brand-new user + team and returns the magic link", async () => {
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin());
    const res = await provisionUserAndTeamFromEmail("Buyer@Example.com");
    expect(res.succeeded).toBe(true);
    expect(res.supaUserId).toBe("user_new");
    expect(res.teamId).toBe("team_1");
    expect(res.magicLink).toContain("magic?token=");
    // email normalized to lowercase for team provisioning
    expect(mockEnsureTeam).toHaveBeenCalledWith("user_new", "buyer@example.com", { skipBonus: true });
  });

  it("finds an existing user via listUsers on createUser collision", async () => {
    const admin = makeAdmin({
      createUser: vi.fn().mockResolvedValue({ data: null, error: { message: "email already been registered" } }),
      listUsers: vi.fn().mockResolvedValue({ data: { users: [{ id: "user_existing", email: "buyer@example.com" }], nextPage: null } }),
    });
    mockGetSupabaseAdmin.mockReturnValue(admin);
    const res = await provisionUserAndTeamFromEmail("buyer@example.com");
    expect(res.succeeded).toBe(true);
    expect(res.supaUserId).toBe("user_existing");
    expect(mockEnsureTeam).toHaveBeenCalledWith("user_existing", "buyer@example.com", { skipBonus: true });
  });

  it("fails (not throws) when collision but listUsers finds no match and generateLink has no user", async () => {
    const admin = makeAdmin({
      createUser: vi.fn().mockResolvedValue({ data: null, error: { message: "already registered" } }),
      listUsers: vi.fn().mockResolvedValue({ data: { users: [], nextPage: null } }),
      generateLink: vi.fn().mockResolvedValue({ data: { properties: { action_link: "x" } }, error: null }),
    });
    mockGetSupabaseAdmin.mockReturnValue(admin);
    const res = await provisionUserAndTeamFromEmail("buyer@example.com");
    expect(res.succeeded).toBe(false);
    expect(mockEnsureTeam).not.toHaveBeenCalled();
  });

  it("returns not-succeeded (reason user_not_found) when Supabase admin is unavailable", async () => {
    mockGetSupabaseAdmin.mockReturnValue(null);
    const res = await provisionUserAndTeamFromEmail("buyer@example.com");
    expect(res.succeeded).toBe(false);
    expect(res.reason).toBe("user_not_found");
  });

  it("returns not-succeeded on empty email without calling Supabase", async () => {
    const res = await provisionUserAndTeamFromEmail("");
    expect(res.succeeded).toBe(false);
    expect(res.reason).toBe("user_not_found");
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("FIX-016: classifies a thrown ProvisionError(link_failed) as reason link_failed", async () => {
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin());
    mockEnsureTeam.mockRejectedValue(new ProvisionError("link_failed"));
    const res = await provisionUserAndTeamFromEmail("buyer@example.com");
    expect(res.succeeded).toBe(false);
    expect(res.reason).toBe("link_failed");
  });

  it("FIX-016: classifies an unexpected thrown error as reason team_failed", async () => {
    mockGetSupabaseAdmin.mockReturnValue(makeAdmin());
    mockEnsureTeam.mockRejectedValue(new Error("connection reset"));
    const res = await provisionUserAndTeamFromEmail("buyer@example.com");
    expect(res.succeeded).toBe(false);
    expect(res.reason).toBe("team_failed");
  });
});
