/**
 * Unit tests for lib/db/api-clients.ts — DB query helpers for apiClients table
 *
 * ES-019 Unit Test Plan (D-1 through D-5)
 *
 *   D-1  createApiClient — valid input → row inserted, returns client_id + plaintext secret
 *   D-2  verifyApiClientSecret — correct secret → returns true
 *   D-3  verifyApiClientSecret — wrong secret → returns false
 *   D-4  revokeApiClient — valid call → revokedAt updated in DB
 *   D-5  listApiClientsForTeam — team with 2 clients → returns 2 rows
 *
 * Mocks: @/lib/db, bcryptjs, nanoid
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/db", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

// Mock bcryptjs — support both default and named import styles
vi.mock("bcryptjs", () => {
  const hash = vi.fn();
  const compare = vi.fn();
  return {
    default: { hash, compare },
    hash,
    compare,
  };
});

vi.mock("nanoid", () => ({
  nanoid: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  createApiClient,
  getApiClientByClientId,
  verifyApiClientSecret,
  touchApiClientLastUsed,
  listApiClientsForTeam,
  revokeApiClient,
} from "@/lib/db/api-clients";
import { db } from "@/lib/db";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInsertChain(returnedRow: unknown = null) {
  const chain = {
    values: vi.fn(),
    returning: vi.fn().mockResolvedValue(returnedRow ? [returnedRow] : []),
  };
  chain.values.mockReturnValue(chain);
  return chain;
}

function makeSelectChain(rows: unknown[] = []) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

const SAMPLE_CLIENT = {
  id: "row-uuid-1",
  teamId: "team-abc",
  clientId: "client-id-24chars-abcdef",
  clientSecretHash: "$2b$12$hashed.secret.value",
  name: "WordPress Plugin",
  scopes: ["audit:read", "audit:write"],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: new Date(),
};

// ─── createApiClient ──────────────────────────────────────────────────────────

describe("createApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // nanoid: first call → clientId (24 chars), second call → raw secret (32 chars)
    vi.mocked(nanoid)
      .mockReturnValueOnce("client-id-24chars-abcdef")
      .mockReturnValueOnce("raw-secret-32chars-nanoid-here-xx")
      .mockReturnValue("fallback-nanoid");

    vi.mocked(bcrypt.hash).mockResolvedValue("$2b$12$hashed.secret.value" as never);

    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(
      makeInsertChain(SAMPLE_CLIENT)
    );
  });

  it("D-1: valid input → inserts row and returns client_id + plaintext secret", async () => {
    const result = await createApiClient({
      teamId: "team-abc",
      name: "WordPress Plugin",
      scopes: ["audit:read", "audit:write"],
    });

    expect(result.client_id).toBeDefined();
    expect(result.client_secret).toBeDefined();
    expect(typeof result.client_id).toBe("string");
    expect(typeof result.client_secret).toBe("string");

    // DB insert must have been called once
    expect(db.insert).toHaveBeenCalledTimes(1);

    // bcrypt.hash called with salt rounds 12
    expect(vi.mocked(bcrypt.hash)).toHaveBeenCalledWith(expect.any(String), 12);
  });

  it("D-1b: plaintext secret returned is the raw nanoid (not the hash)", async () => {
    const result = await createApiClient({
      teamId: "team-abc",
      name: "Test App",
      scopes: [],
    });

    // Secret should not be the bcrypt hash
    expect(result.client_secret).not.toMatch(/^\$2b\$/);
    // It should be the raw nanoid value
    expect(result.client_secret).toBe("raw-secret-32chars-nanoid-here-xx");
  });

  it("D-1c: row inserted uses the hashed secret, not the plaintext", async () => {
    const capturedValues: Record<string, unknown>[] = [];
    const insertChain = {
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedValues.push(vals);
        return insertChain;
      }),
      returning: vi.fn().mockResolvedValue([SAMPLE_CLIENT]),
    };
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain);

    await createApiClient({
      teamId: "team-abc",
      name: "Test",
      scopes: ["audit:read"],
    });

    expect(capturedValues.length).toBeGreaterThan(0);
    const row = capturedValues[0];
    // Hash stored, not plaintext
    expect(row.clientSecretHash).toBe("$2b$12$hashed.secret.value");
    // Plaintext secret must NOT be stored
    expect(row).not.toHaveProperty("clientSecret");
  });
});

// ─── verifyApiClientSecret ────────────────────────────────────────────────────

describe("verifyApiClientSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("D-2: correct secret → returns true", async () => {
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await verifyApiClientSecret(SAMPLE_CLIENT, "correct-raw-secret");

    expect(result).toBe(true);
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledWith(
      "correct-raw-secret",
      SAMPLE_CLIENT.clientSecretHash
    );
  });

  it("D-3: wrong secret → returns false", async () => {
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    const result = await verifyApiClientSecret(SAMPLE_CLIENT, "wrong-secret");

    expect(result).toBe(false);
    expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledWith(
      "wrong-secret",
      SAMPLE_CLIENT.clientSecretHash
    );
  });
});

// ─── revokeApiClient ──────────────────────────────────────────────────────────

describe("revokeApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("D-4: valid call → db.update with revokedAt = current timestamp", async () => {
    const capturedSets: Record<string, unknown>[] = [];
    const updateChain = {
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedSets.push(vals);
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue([]),
    };
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

    const before = new Date();
    await revokeApiClient("client-id-24chars-abcdef", "team-abc");
    const after = new Date();

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(capturedSets.length).toBe(1);

    const { revokedAt } = capturedSets[0] as { revokedAt: Date };
    expect(revokedAt).toBeInstanceOf(Date);
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(revokedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ─── listApiClientsForTeam ────────────────────────────────────────────────────

describe("listApiClientsForTeam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("D-5: team with 2 non-revoked clients → returns 2 rows", async () => {
    const clients = [
      { ...SAMPLE_CLIENT, clientId: "client-id-one", name: "Plugin 1" },
      { ...SAMPLE_CLIENT, clientId: "client-id-two", name: "Plugin 2" },
    ];
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain(clients)
    );

    const result = await listApiClientsForTeam("team-abc");

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0].clientId).toBe("client-id-one");
    expect(result[1].clientId).toBe("client-id-two");
  });

  it("D-5b: team with no clients → returns empty array", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));

    const result = await listApiClientsForTeam("team-empty");

    expect(result).toEqual([]);
  });
});

// ─── getApiClientByClientId ───────────────────────────────────────────────────

describe("getApiClientByClientId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("existing clientId → returns client row", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSelectChain([SAMPLE_CLIENT])
    );

    const result = await getApiClientByClientId("client-id-24chars-abcdef");

    expect(result).not.toBeNull();
    expect(result?.clientId).toBe("client-id-24chars-abcdef");
  });

  it("unknown clientId → returns null", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(makeSelectChain([]));

    const result = await getApiClientByClientId("nonexistent-id");

    expect(result).toBeNull();
  });
});

// ─── touchApiClientLastUsed ───────────────────────────────────────────────────

describe("touchApiClientLastUsed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates lastUsedAt to current timestamp", async () => {
    const capturedSets: Record<string, unknown>[] = [];
    const updateChain = {
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedSets.push(vals);
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue([]),
    };
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(updateChain);

    const before = new Date();
    await touchApiClientLastUsed("client-id-24chars-abcdef");
    const after = new Date();

    expect(db.update).toHaveBeenCalledTimes(1);
    const { lastUsedAt } = capturedSets[0] as { lastUsedAt: Date };
    expect(lastUsedAt).toBeInstanceOf(Date);
    expect(lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lastUsedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
