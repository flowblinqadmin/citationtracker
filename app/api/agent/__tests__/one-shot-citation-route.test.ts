// Integration tests for POST /api/agent/one-shot-citation — the full HTTP
// contract through the real route handler. Providers are supplied by the route's
// E2E_FAKE_PROVIDERS seam (deterministic fixtures, no network, no keys, no DB),
// so this suite runs unconditionally. The stateless contract means there is
// nothing to mock away — no tracker.* / public.* access exists to stub.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { POST } from "@/app/api/agent/one-shot-citation/route";
import { __resetAgentRateLimits, AGENT_RATE_LIMIT } from "@/lib/agent-rate-limit";

const TOKEN = "a".repeat(40); // ≥ MIN_LEN (32)
const JWT_SECRET = "j".repeat(64); // ≥ 32; geo's API_JWT_SECRET floor
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"];

const saved: Record<string, string | undefined> = {};
function snapshotEnv() {
  for (const k of [...PROVIDER_KEYS, "AGENT_SERVICE_TOKEN", "API_JWT_SECRET", "E2E_FAKE_PROVIDERS", "VERCEL"]) {
    saved[k] = process.env[k];
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// `auth === null` means "send no Authorization header". Omitting the arg sends
// the valid token. (Passing `undefined` would trigger the default — a JS gotcha.)
function call(body: unknown, auth: string | null = `Bearer ${TOKEN}`): Promise<Response> {
  return POST(
    new NextRequest("http://x/api/agent/one-shot-citation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/agent/one-shot-citation", () => {
  beforeEach(() => {
    snapshotEnv();
    __resetAgentRateLimits();
    process.env.AGENT_SERVICE_TOKEN = TOKEN;
    // E2E provider seam: deterministic fixtures, no keys/network required for exec.
    process.env.E2E_FAKE_PROVIDERS = "1";
    delete process.env.VERCEL;
    // At least one configured provider so partitionModels doesn't 503.
    for (const k of PROVIDER_KEYS) process.env[k] = "test-key";
  });
  afterEach(() => restoreEnv());

  // ── Auth ────────────────────────────────────────────────────────────────
  it("401 on missing token", async () => {
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, null);
    expect(res.status).toBe(401);
  });

  it("401 on wrong token", async () => {
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, `Bearer ${"b".repeat(40)}`);
    expect(res.status).toBe(401);
  });

  it("503 when AGENT_SERVICE_TOKEN is unset (service not provisioned)", async () => {
    delete process.env.AGENT_SERVICE_TOKEN;
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] });
    expect(res.status).toBe(503);
  });

  // ── Validation ──────────────────────────────────────────────────────────
  it("400 on non-JSON body", async () => {
    const res = await call("not json{{{");
    expect(res.status).toBe(400);
  });

  it("400 on missing brandDomain", async () => {
    const res = await call({ prompts: ["p"] });
    expect(res.status).toBe(400);
  });

  it("400 on empty prompts array", async () => {
    const res = await call({ brandDomain: "acme.com", prompts: [] });
    expect(res.status).toBe(400);
  });

  it("400 on an unknown model name", async () => {
    const res = await call({ brandDomain: "acme.com", prompts: ["p"], models: ["mistral"] });
    expect(res.status).toBe(400);
  });

  it("413 on too many prompts (>3)", async () => {
    const res = await call({ brandDomain: "acme.com", prompts: ["a", "b", "c", "d"] });
    expect(res.status).toBe(413);
  });

  it("413 on too many competitors (>5)", async () => {
    const res = await call({
      brandDomain: "acme.com",
      prompts: ["p"],
      competitors: Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, domain: `c${i}.com` })),
    });
    expect(res.status).toBe(413);
  });

  // ── 503: zero configured providers ────────────────────────────────────────
  it("503 when NO provider keys are configured", async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unconfigured_models).toEqual(["openai", "anthropic", "perplexity", "gemini"]);
  });

  // ── Happy path (fixture providers) ────────────────────────────────────────
  it("200 with results + summary + unconfigured_models", async () => {
    // Only openai + gemini configured → perplexity/anthropic land in unconfigured.
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // The fixture echoes the prompt into its response text; putting the brand
    // stem in the prompt makes isBrandMentioned fire on the echoed text.
    const res = await call({ brandDomain: "acme-e2e.com", prompts: ["Is acme-e2e any good?"] });
    expect(res.status).toBe(200);
    const body = await res.json();

    // 1 prompt × 2 configured models = 2 results.
    expect(body.results).toHaveLength(2);
    expect(body.summary.models_run.sort()).toEqual(["gemini", "openai"]);
    expect(body.unconfigured_models.sort()).toEqual(["anthropic", "perplexity"]);

    // The fixture cites acme-e2e.com (brand) → brand citation extracted per cell;
    // the echoed brand stem in the text → brand_mentioned true.
    for (const r of body.results) {
      expect(r.brand_mentioned).toBe(true);
      expect(r.citations.map((c: { url: string }) => c.url)).toContain(
        "https://acme-e2e.com/reviews/best-tools",
      );
    }
    expect(body.summary.mention_rate).toBe(1);
  });

  it("brand_mentioned is false when the text does not name the brand", async () => {
    const res = await call({ brandDomain: "acme-e2e.com", prompts: ["best tools?"], models: ["openai"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fixture text doesn't echo the brand stem for this prompt → no text mention,
    // even though the brand URL is cited.
    expect(body.results[0].brand_mentioned).toBe(false);
    expect(body.summary.mention_rate).toBe(0);
    expect(body.results[0].citations.map((c: { url: string }) => c.url)).toContain(
      "https://acme-e2e.com/reviews/best-tools",
    );
  });

  it("computes share_of_voice from the same responses (no extra calls)", async () => {
    const res = await call({
      brandDomain: "acme-e2e.com",
      prompts: ["best tools?"],
      models: ["openai"],
      competitors: [{ name: "ThirdParty", domain: "thirdparty.example" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fixture cites acme-e2e.com + thirdparty.example → 1 brand, 1 competitor.
    expect(body.summary.share_of_voice).toEqual({
      brand: 0.5,
      competitors: [{ domain: "thirdparty.example", share: 0.5 }],
    });
  });

  it("skips an unconfigured requested model instead of failing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await call({
      brandDomain: "acme-e2e.com",
      prompts: ["p"],
      models: ["openai", "anthropic"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.models_run).toEqual(["openai"]);
    expect(body.unconfigured_models).toEqual(["anthropic"]);
    expect(body.results).toHaveLength(1);
  });

  // ── Rate limit ────────────────────────────────────────────────────────────
  it("429 after AGENT_RATE_LIMIT requests on the same token", async () => {
    const good = { brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai"] };
    for (let i = 0; i < AGENT_RATE_LIMIT; i++) {
      const ok = await call(good);
      expect(ok.status).toBe(200);
    }
    const limited = await call(good);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  // ── Regression: service-token path unchanged in a billed-capable deployment ──
  // With BOTH secrets set, a service-token caller must still get the exact
  // unbilled body — no credits_charged / credits_remaining fields.
  it("service-token success body carries NO billing fields even when JWT billing is provisioned", async () => {
    process.env.API_JWT_SECRET = JWT_SECRET;
    const res = await call({ brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("credits_charged");
    expect(body).not.toHaveProperty("credits_remaining");
    expect(body.results).toHaveLength(1);
  });
});

// ── Billed mode (geo v1 customer JWT) ─────────────────────────────────────────
// JWT-auth mapping tests need no DB. The debit/refund/402/ledger assertions are
// DB-backed and gated on TEST_DATABASE_URL (skip otherwise), mirroring
// lib/__tests__/credits.test.ts.

/** Mint a geo-style v1 API JWT (HS256, sub/team_id/scopes, exp). */
async function mintJwt(opts: {
  secret?: string;
  teamId?: string;
  scopes?: string[];
  expiresIn?: string;
} = {}): Promise<string> {
  const key = new TextEncoder().encode(opts.secret ?? JWT_SECRET);
  return new SignJWT({ team_id: opts.teamId ?? "team_billed_test", scopes: opts.scopes ?? ["audit:write"] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("client_test")
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "1h")
    .sign(key);
}

describe("POST /api/agent/one-shot-citation — billed mode auth mapping", () => {
  beforeEach(() => {
    snapshotEnv();
    __resetAgentRateLimits();
    process.env.AGENT_SERVICE_TOKEN = TOKEN;
    process.env.API_JWT_SECRET = JWT_SECRET;
    process.env.E2E_FAKE_PROVIDERS = "1";
    delete process.env.VERCEL;
    for (const k of PROVIDER_KEYS) process.env[k] = "test-key";
  });
  afterEach(() => restoreEnv());

  it("401 on an expired JWT", async () => {
    const jwt = await mintJwt({ expiresIn: "-1h" });
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, `Bearer ${jwt}`);
    expect(res.status).toBe(401);
  });

  it("401 on a bad-signature JWT", async () => {
    const jwt = await mintJwt({ secret: "z".repeat(64) });
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, `Bearer ${jwt}`);
    expect(res.status).toBe(401);
  });

  it("403 when the JWT lacks audit:write", async () => {
    const jwt = await mintJwt({ scopes: ["audit:read"] });
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, `Bearer ${jwt}`);
    expect(res.status).toBe(403);
  });

  it("401 (not 503) when a non-service bearer is sent but billing is unprovisioned", async () => {
    delete process.env.API_JWT_SECRET;
    // Billing not configured: a wrong/unverifiable bearer must still be a plain
    // 401 — identical to the service-token-only contract, never leaking that
    // billing is off.
    const res = await call({ brandDomain: "acme.com", prompts: ["p"] }, `Bearer ${"x".repeat(120)}`);
    expect(res.status).toBe(401);
  });
});

// ── Billed mode: DB-backed billing (debit / 402 / refunds / ledger) ───────────
const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("POST /api/agent/one-shot-citation — billed mode ledger", () => {
  const TEAM = "team_osc_billed_test";

  beforeEach(async () => {
    snapshotEnv();
    __resetAgentRateLimits();
    process.env.AGENT_SERVICE_TOKEN = TOKEN;
    process.env.API_JWT_SECRET = JWT_SECRET;
    process.env.E2E_FAKE_PROVIDERS = "1";
    delete process.env.VERCEL;
    for (const k of PROVIDER_KEYS) process.env[k] = "test-key";

    const { db } = await import("@/lib/db");
    const { teams, creditTransactions } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(creditTransactions).where(eq(creditTransactions.teamId, TEAM));
    await db.delete(teams).where(eq(teams.id, TEAM));
    await db.insert(teams).values({
      id: TEAM, name: "OSC Billed Test", ownerUserId: "u_test", creditBalance: 100,
    });
  });
  afterEach(() => restoreEnv());

  async function balance(): Promise<number> {
    const { db } = await import("@/lib/db");
    const { teams } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const [t] = await db.select({ b: teams.creditBalance }).from(teams).where(eq(teams.id, TEAM));
    return t.b;
  }

  async function ledgerRows() {
    const { db } = await import("@/lib/db");
    const { creditTransactions } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    return db.select().from(creditTransactions).where(eq(creditTransactions.teamId, TEAM));
  }

  it("debits before execution and returns credits_charged + credits_remaining", async () => {
    // 1 prompt × 1 model × 2 = 2 credits.
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["best?"], models: ["openai"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(2);
    expect(body.credits_remaining).toBe(98);
    expect(await balance()).toBe(98);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("citation_run");
    expect(rows[0].creditsChanged).toBe(-2);
    expect(rows[0].siteId?.startsWith("osc_")).toBe(true);
  });

  it("charges prompts × models × 2 for a multi-cell request", async () => {
    // 2 prompts × 2 models × 2 = 8 credits.
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["a", "b"], models: ["openai", "gemini"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(8);
    expect(await balance()).toBe(92);
  });

  it("prices per-model: a Claude-included 4-model run costs 10, not 8", async () => {
    // 1 prompt × (openai 2 + anthropic 4 + perplexity 2 + gemini 2) = 10 credits.
    // The flat ×2 bug would have charged 1×4×2 = 8 — this is the regression guard.
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      {
        brandDomain: "acme-e2e.com",
        prompts: ["best?"],
        models: ["openai", "anthropic", "perplexity", "gemini"],
      },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(10);
    expect(await balance()).toBe(90);
  });

  it("prices Claude alone at 4 (the premium per-model rate), not the base 2", async () => {
    // 1 prompt × anthropic (4) = 4. Flat ×2 would have charged 2.
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["best?"], models: ["anthropic"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(4);
    expect(await balance()).toBe(96);
  });

  it("partial refund of a MISSING Claude refunds 4, not 2 (per-model refund)", async () => {
    // Request openai + anthropic, only openai configured → billed 1×(2+4)=6,
    // refund the missing Claude at its own price 1×4=4 (NOT a flat 1×2). Net 2.
    delete process.env.ANTHROPIC_API_KEY;
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai", "anthropic"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(2); // 6 debited − 4 refunded
    expect(body.unconfigured_models).toEqual(["anthropic"]);
    expect(await balance()).toBe(98);

    const rows = await ledgerRows();
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(["citation_run", "citation_run_refund"]);
    // The refund row is 4 credits, not 2.
    const refundRow = rows.find((r) => r.type === "citation_run_refund");
    expect(refundRow?.creditsChanged).toBe(4);
    expect(new Set(rows.map((r) => r.siteId)).size).toBe(1);
  });

  it("402 insufficient_credits with required + balance, and no debit side-effect", async () => {
    // Drain the team to 1 credit; a 1×1 run needs 2.
    const { db } = await import("@/lib/db");
    const { teams } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(teams).set({ creditBalance: 1 }).where(eq(teams.id, TEAM));

    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.required).toBe(2);
    expect(body.balance).toBe(1);
    expect(await balance()).toBe(1);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("partial refund: bills the full requested set, refunds unconfigured models", async () => {
    // Request 2 models, only openai configured → billed 2×1×2=4, refund 1×1×2=2.
    delete process.env.GEMINI_API_KEY;
    const jwt = await mintJwt({ teamId: TEAM });
    const res = await call(
      { brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai", "gemini"] },
      `Bearer ${jwt}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credits_charged).toBe(2); // 4 debited − 2 refunded
    expect(body.unconfigured_models).toEqual(["gemini"]);
    expect(await balance()).toBe(98);

    const rows = await ledgerRows();
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(["citation_run", "citation_run_refund"]);
    // Debit and refund share the SAME osc_ site_id (idempotency lineage).
    expect(new Set(rows.map((r) => r.siteId)).size).toBe(1);
  });

  it("rate-limits billed callers per team (30/hr)", async () => {
    const jwt = await mintJwt({ teamId: TEAM });
    const good = { brandDomain: "acme-e2e.com", prompts: ["p"], models: ["openai"] };
    // Give the team plenty of credits for the burst.
    const { db } = await import("@/lib/db");
    const { teams } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(teams).set({ creditBalance: 10_000 }).where(eq(teams.id, TEAM));

    for (let i = 0; i < AGENT_RATE_LIMIT; i++) {
      const ok = await call(good, `Bearer ${jwt}`);
      expect(ok.status).toBe(200);
    }
    const limited = await call(good, `Bearer ${jwt}`);
    expect(limited.status).toBe(429);
  });
});
