import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock DB
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
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-nanoid"),
}));

import { ensureTeamForUser, ProvisionError } from "./provision-team";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const chain = { values: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(db.insert).mockReturnValue(chain as unknown as ReturnType<typeof db.insert>);
  return chain;
}

function mockUpdate() {
  const setChain = { where: vi.fn().mockResolvedValue(undefined) };
  const chain = { set: vi.fn().mockReturnValue(setChain) };
  vi.mocked(db.update).mockReturnValue(chain as unknown as ReturnType<typeof db.update>);
  return chain;
}

/**
 * Mock db.transaction so the orphan-link loop (FIX-016) executes against a tx
 * whose update/insert calls are captured. `failOnInsert` simulates a mid-loop
 * teamDomains insert failure (→ ProvisionError("link_failed")).
 */
function mockTransaction(opts: { failOnInsert?: boolean } = {}) {
  const txUpdates: Record<string, unknown>[] = [];
  const txInserts: Record<string, unknown>[] = [];
  vi.mocked(db.transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn((d: Record<string, unknown>) => {
          txUpdates.push(d);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((d: Record<string, unknown>) => {
          txInserts.push(d);
          if (opts.failOnInsert) return Promise.reject(new Error("teamDomains insert failed"));
          return Promise.resolve(undefined);
        }),
      })),
    };
    return await fn(tx);
  }) as unknown as typeof db.transaction);
  return { txUpdates, txInserts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureTeamForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing team when user already has membership (no orphans → no writes)", async () => {
    mockSelectSequence([
      [{ id: "mem-1", teamId: "team-existing", userId: "user-1", email: "alice@example.com" }],
      [], // FIX-016: orphan re-link select on the existing-member path
    ]);

    const result = await ensureTeamForUser("user-1", "alice@example.com");

    expect(result).toEqual({ teamId: "team-existing", isNewTeam: false });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled(); // no orphans → no link tx
  });

  it("accepts pending invite when found by email", async () => {
    const pendingInvite = {
      id: "inv-1",
      teamId: "team-invited",
      userId: null,
      email: "bob@example.com",
      inviteAcceptedAt: null,
    };

    mockSelectSequence([
      [],              // no existing membership
      [pendingInvite], // pending invite found
      [],              // orphan re-link select
    ]);
    mockUpdate();

    const result = await ensureTeamForUser("user-bob", "bob@example.com");

    expect(result).toEqual({ teamId: "team-invited", isNewTeam: false });
    expect(db.update).toHaveBeenCalledTimes(1); // accept invite
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates team + membership + signup bonus on first login", async () => {
    mockSelectSequence([
      [], // no existing membership
      [], // no pending invite
      [], // no orphan sites
    ]);
    const insertChain = mockInsert();

    const result = await ensureTeamForUser("user-new", "charlie@example.com");

    expect(result.isNewTeam).toBe(true);
    expect(result.teamId).toBe("test-nanoid");
    expect(db.insert).toHaveBeenCalledTimes(3); // team, teamMember, creditTransaction

    const allInsertArgs = insertChain.values.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>
    );
    const teamRow = allInsertArgs.find((a) => a.creditBalance !== undefined);
    expect(teamRow?.creditBalance).toBe(20);
    expect(teamRow?.ownerUserId).toBe("user-new");
    const memberRow = allInsertArgs.find((a) => a.role !== undefined);
    expect(memberRow?.role).toBe("owner");
    expect(memberRow?.userId).toBe("user-new");
    expect(memberRow?.email).toBe("charlie@example.com");
    const bonusTx = allInsertArgs.find((a) => a.type === "signup_bonus");
    expect(bonusTx?.creditsChanged).toBe(20);
    expect(bonusTx?.balanceAfter).toBe(20);
  });

  it("skipBonus: creates team with 0 credits and no credit transaction", async () => {
    mockSelectSequence([[], [], []]);
    const insertChain = mockInsert();

    const result = await ensureTeamForUser("user-free", "free@example.com", { skipBonus: true });

    expect(result.isNewTeam).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(2); // team + member only

    const allInsertArgs = insertChain.values.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>
    );
    const teamRow = allInsertArgs.find((a) => a.creditBalance !== undefined);
    expect(teamRow?.creditBalance).toBe(0);
    expect(allInsertArgs.find((a) => a.type === "signup_bonus")).toBeUndefined();
  });

  it("auto-links orphan sites on first login (inside a transaction)", async () => {
    const orphanSite = {
      id: "site-orphan",
      domain: "orphan.com",
      ownerEmail: "dave@example.com",
      teamId: null,
    };

    mockSelectSequence([
      [],            // no existing membership
      [],            // no pending invite
      [orphanSite],  // one orphan site
    ]);
    mockInsert();
    const { txUpdates, txInserts } = mockTransaction();

    const result = await ensureTeamForUser("user-dave", "dave@example.com");

    expect(result.isNewTeam).toBe(true);
    // Team provisioning still 3 direct inserts (team, member, creditTx).
    expect(db.insert).toHaveBeenCalledTimes(3);
    // Orphan linking runs inside ONE transaction.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txUpdates).toHaveLength(1); // geoSites teamId/userId
    expect(txUpdates[0]).toMatchObject({ teamId: "test-nanoid", userId: "user-dave" });
    expect(txInserts).toHaveLength(1); // teamDomains
    expect(txInserts[0]).toMatchObject({ siteId: "site-orphan", domain: "orphan.com" });
  });

  it("FIX-016: re-links orphan sites on the existing-member path (self-heal)", async () => {
    const orphanSite = {
      id: "site-late",
      domain: "late.com",
      ownerEmail: "erin@example.com",
      teamId: null,
    };
    mockSelectSequence([
      [{ id: "mem-1", teamId: "team-erin", userId: "user-erin", email: "erin@example.com" }],
      [orphanSite], // orphan created after the team existed
    ]);
    const { txInserts } = mockTransaction();

    const result = await ensureTeamForUser("user-erin", "erin@example.com");

    expect(result).toEqual({ teamId: "team-erin", isNewTeam: false });
    expect(db.insert).not.toHaveBeenCalled(); // no new team
    expect(db.transaction).toHaveBeenCalledTimes(1); // but the orphan still links
    expect(txInserts[0]).toMatchObject({ siteId: "site-late", teamId: "team-erin" });
  });

  it("FIX-016: a linking failure surfaces as ProvisionError(link_failed)", async () => {
    const orphanSite = { id: "site-x", domain: "x.com", ownerEmail: "fail@example.com", teamId: null };
    mockSelectSequence([
      [], // no membership
      [], // no invite
      [orphanSite],
    ]);
    mockInsert();
    mockTransaction({ failOnInsert: true });

    const err = await ensureTeamForUser("user-fail", "fail@example.com").catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).reason).toBe("link_failed");
  });

  it("lowercases email for all lookups", async () => {
    mockSelectSequence([
      [{ id: "mem-1", teamId: "team-1", userId: "user-1" }],
      [], // orphan re-link select
    ]);

    await ensureTeamForUser("user-1", "Alice@EXAMPLE.COM");

    expect(db.select).toHaveBeenCalled();
  });

  it("does NOT link orphan sites belonging to a different email", async () => {
    mockSelectSequence([[], [], []]);
    mockInsert();

    const result = await ensureTeamForUser("user-charlie", "charlie@x.com");

    expect(result.isNewTeam).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(3); // team, member, creditTx — no teamDomains
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does NOT accept invite belonging to a different email", async () => {
    mockSelectSequence([[], [], []]);
    mockInsert();

    const result = await ensureTeamForUser("user-alice", "alice@y.com");

    expect(result.isNewTeam).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(3);
  });

  it("does NOT create duplicate team if called twice for same user", async () => {
    mockSelectSequence([[], [], []]);
    mockInsert();

    const first = await ensureTeamForUser("user-repeat", "repeat@x.com");
    expect(first.isNewTeam).toBe(true);

    vi.clearAllMocks();

    mockSelectSequence([
      [{ id: "mem-1", teamId: first.teamId, userId: "user-repeat" }],
      [], // orphan re-link select
    ]);

    const second = await ensureTeamForUser("user-repeat", "repeat@x.com");
    expect(second.isNewTeam).toBe(false);
    expect(second.teamId).toBe(first.teamId);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("propagates DB errors (not silenced)", async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error("DB connection failed")),
    };
    vi.mocked(db.select).mockReturnValueOnce(chain as unknown as ReturnType<typeof db.select>);

    await expect(ensureTeamForUser("user-err", "err@x.com")).rejects.toThrow("DB connection failed");
  });

  it("does NOT give signup bonus twice (idempotent via membership check)", async () => {
    mockSelectSequence([
      [{ id: "mem-1", teamId: "team-existing", userId: "user-1", email: "user@x.com" }],
      [], // orphan re-link select
    ]);

    const result = await ensureTeamForUser("user-1", "user@x.com");

    expect(result.isNewTeam).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("only links orphan sites with NULL teamId (already-assigned sites are not stolen)", async () => {
    mockSelectSequence([[], [], []]);
    mockInsert();

    const result = await ensureTeamForUser("user-new", "owner@x.com");

    expect(result.isNewTeam).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(3);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
