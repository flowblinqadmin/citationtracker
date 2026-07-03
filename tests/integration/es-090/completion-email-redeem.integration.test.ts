/**
 * ES-090 IT-REDEEM — createExchangeCode / redeemExchangeCode (HP-186 + HP-202).
 *
 * Moved from unit to integration per HP-209. Runs against @electric-sql/pglite
 * (in-process Postgres with real MVCC — same harness approach mandated for
 * U32 atomic OTP increment per HP-205).
 *
 * Covers:
 *   U51  — one-time redemption: second redeem fails with `already-redeemed`
 *          (HP-207 hyphen, not `already_consumed` underscore)
 *   U51a — HP-202 defuse chain: scanner consume → proof-mismatch CAS revert
 *          → real user can still redeem
 *   U51b — proof-of-email mismatch (wrong email) → proof-mismatch, code stays redeemable
 *   U51c — expired code path (HP-210): ttlSeconds=1, setTimeout(1100), `expired`
 *
 * Phase A (RED): @electric-sql/pglite + the DB-backed createExchangeCode /
 * redeemExchangeCode surface don't exist on main. Will GREEN once ScriptDev
 * lands §b.12 (exchange_codes table + the new API).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

// ── pglite fixture setup ─────────────────────────────────────────────────────
// Real Postgres semantics in-process. ScriptDev will land a shared
// tests/integration/_pglite-fixture.ts; until then, import inline.
type PGlite = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  close: () => Promise<void>;
};

let pg: PGlite | null = null;

beforeAll(async () => {
  try {
    const mod = await import("@electric-sql/pglite") as unknown as {
      PGlite: new () => PGlite;
    };
    pg = new mod.PGlite();
    // Apply the minimal schema the tests need from ChangedSpec §b.1.
    await pg.query(`
      CREATE TABLE IF NOT EXISTS exchange_codes (
        code text PRIMARY KEY,
        email text NOT NULL,
        site_id text,
        payload jsonb NOT NULL,
        created_at timestamp DEFAULT NOW() NOT NULL,
        expires_at timestamp NOT NULL,
        redeemed_at timestamp,
        redeemed_by_ip_hash text
      );
      CREATE INDEX IF NOT EXISTS exchange_codes_email_idx ON exchange_codes(email);
      CREATE INDEX IF NOT EXISTS exchange_codes_expires_idx ON exchange_codes(expires_at);
    `);
    // Point the lib's db client at pglite — ScriptDev's responsibility to wire
    // the test-override. Until that hook exists, the module's db import will
    // still point at the prod connection string; test will then fail with a
    // deliberate RED on the first call.
    process.env.ES090_PGLITE_DB = "1";
  } catch (err) {
    console.warn("[IT-REDEEM] pglite unavailable — tests will RED at first call:", err);
  }
});

afterAll(async () => {
  if (pg) await pg.close();
});

type Create = (opts: {
  email: string;
  siteId?: string;
  payload: Record<string, unknown>;
  ttlSeconds: number;
}) => Promise<{ code: string; expiresAt: Date }>;

type Redeem = (
  code: string,
  proof: { source: string; email: string } | null,
  ipHash: string | null,
) => Promise<
  | { ok: true; payload: Record<string, unknown>; email: string; siteId: string | null }
  | { ok: false; reason: "not-found" | "expired" | "already-redeemed" | "proof-mismatch" }
>;

async function loadApi(): Promise<{ create: Create; redeem: Redeem }> {
  const real = await import("@/lib/services/exchange-code");
  const create = (real as unknown as { createExchangeCode?: Create }).createExchangeCode;
  const redeem = (real as unknown as { redeemExchangeCode?: Redeem }).redeemExchangeCode;
  if (!create) throw new Error("createExchangeCode not exported — ES-090 §b.12 not landed");
  if (!redeem) throw new Error("redeemExchangeCode not exported — ES-090 §b.12 not landed");
  return { create, redeem };
}

describe("ES-090 §b.12 — createExchangeCode / redeemExchangeCode (IT, pglite)", () => {
  it("U51 (HP-207 fixed): one-time redemption — second redeem returns `already-redeemed` (hyphen)", async () => {
    const { create, redeem } = await loadApi();
    // HP-207: was missing `email` in the create payload; was asserting
    // underscore `already_consumed`. Both now corrected.
    const issued = await create({
      email: "u@x.test",
      siteId: "site-u51",
      payload: { accessToken: "raw" },
      ttlSeconds: 60,
    });
    const proof = { source: "active-otp", email: "u@x.test" };
    const r1 = await redeem(issued.code, proof, null);
    const r2 = await redeem(issued.code, proof, null);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("already-redeemed");
  });

  it("U51a (HP-202 defuse chain): scanner consume → proof-mismatch CAS revert → real user can still redeem", async () => {
    const { create, redeem } = await loadApi();
    const issued = await create({
      email: "owner@example.test",
      siteId: "site-hp202",
      payload: { accessToken: "raw" },
      ttlSeconds: 7 * 86_400,
    });

    // 1. Scanner: no proof of email → proof-mismatch, CAS revert.
    const scanner = await redeem(issued.code, null, "ip-hash-scanner");
    expect(scanner.ok).toBe(false);
    if (!scanner.ok) expect(scanner.reason).toBe("proof-mismatch");

    // 2. Real user (matching proof) → redeem succeeds.
    const user1 = await redeem(
      issued.code,
      { source: "active-otp", email: "owner@example.test" },
      "ip-hash-user",
    );
    expect(user1.ok).toBe(true);

    // 3. Second real-user click → already-redeemed (one-time).
    const user2 = await redeem(
      issued.code,
      { source: "active-otp", email: "owner@example.test" },
      "ip-hash-user",
    );
    expect(user2.ok).toBe(false);
    if (!user2.ok) expect(user2.reason).toBe("already-redeemed");
  });

  it("U51b (HP-186): wrong-email proof → proof-mismatch, code stays redeemable by correct email", async () => {
    const { create, redeem } = await loadApi();
    const issued = await create({
      email: "target@example.test",
      payload: {},
      ttlSeconds: 60,
    });
    const wrong = await redeem(
      issued.code,
      { source: "active-otp", email: "attacker@example.test" },
      null,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("proof-mismatch");

    const right = await redeem(
      issued.code,
      { source: "active-otp", email: "target@example.test" },
      null,
    );
    expect(right.ok).toBe(true);
  });

  it("U51c (HP-210): expired code path — ttlSeconds=1, wait 1.1s, `expired`", async () => {
    const { create, redeem } = await loadApi();
    const issued = await create({
      email: "exp@example.test",
      payload: {},
      ttlSeconds: 1,
    });
    await delay(1100);
    const out = await redeem(
      issued.code,
      { source: "active-otp", email: "exp@example.test" },
      null,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("expired");
  });
});
