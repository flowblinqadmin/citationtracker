// Full-refund-on-throw contract for billed mode.
//
// The route catches per-cell provider errors inside the engine (runCell never
// throws), so the only way runOneShot throws is a defect below the fan-out. We
// force that by mocking the engine's runOneShot to reject, then assert the route:
//   - has already debited (debit-before-execute),
//   - fully refunds the debit,
//   - re-raises the error (no swallowed 500 → the platform's error boundary owns it),
//   - leaves the team balance net-zero and a debit+refund ledger pair on one id.
//
// DB-backed → gated on TEST_DATABASE_URL, like lib/__tests__/credits.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

// Mock ONLY runOneShot; keep the rest of the engine module (AGENT_MODELS,
// partitionModels, types) real so the route's model partitioning still works.
vi.mock("@/lib/engine/one-shot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/one-shot")>();
  return {
    ...actual,
    runOneShot: vi.fn(async () => {
      throw new Error("boom — engine defect");
    }),
  };
});

const TOKEN = "a".repeat(40);
const JWT_SECRET = "j".repeat(64);
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"];
const dbUrl = process.env.TEST_DATABASE_URL;

const saved: Record<string, string | undefined> = {};

async function mintJwt(teamId: string): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ team_id: teamId, scopes: ["audit:write"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("client_test")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

describe.skipIf(!dbUrl)("billed one-shot — full refund when the engine throws", () => {
  const TEAM = "team_osc_refund_test";

  beforeEach(async () => {
    for (const k of [...PROVIDER_KEYS, "AGENT_SERVICE_TOKEN", "API_JWT_SECRET", "E2E_FAKE_PROVIDERS", "VERCEL"]) {
      saved[k] = process.env[k];
    }
    process.env.AGENT_SERVICE_TOKEN = TOKEN;
    process.env.API_JWT_SECRET = JWT_SECRET;
    delete process.env.E2E_FAKE_PROVIDERS; // engine is mocked; seam irrelevant
    delete process.env.VERCEL;
    for (const k of PROVIDER_KEYS) process.env[k] = "test-key";

    const { db } = await import("@/lib/db");
    const { teams, creditTransactions } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(creditTransactions).where(eq(creditTransactions.teamId, TEAM));
    await db.delete(teams).where(eq(teams.id, TEAM));
    await db.insert(teams).values({
      id: TEAM, name: "OSC Refund Test", ownerUserId: "u_test", creditBalance: 50,
    });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.clearAllMocks();
  });

  it("debits, refunds the full amount, and re-raises", async () => {
    const { POST } = await import("@/app/api/agent/one-shot-citation/route");
    const { db } = await import("@/lib/db");
    const { teams, creditTransactions } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    const jwt = await mintJwt(TEAM);
    const req = new NextRequest("http://x/api/agent/one-shot-citation", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ brandDomain: "acme.com", prompts: ["p"], models: ["openai"] }),
    });

    await expect(POST(req)).rejects.toThrow(/boom/);

    const [t] = await db.select({ b: teams.creditBalance }).from(teams).where(eq(teams.id, TEAM));
    expect(t.b).toBe(50); // debited 2, refunded 2 → net zero

    const rows = await db.select().from(creditTransactions).where(eq(creditTransactions.teamId, TEAM));
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(["citation_run", "citation_run_refund"]);
    expect(new Set(rows.map((r) => r.siteId)).size).toBe(1); // same osc_ id
  });
});
