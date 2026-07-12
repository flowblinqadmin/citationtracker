// Integration tests for POST /api/agent/one-shot-citation — the full HTTP
// contract through the real route handler. Providers are supplied by the route's
// E2E_FAKE_PROVIDERS seam (deterministic fixtures, no network, no keys, no DB),
// so this suite runs unconditionally. The stateless contract means there is
// nothing to mock away — no tracker.* / public.* access exists to stub.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/agent/one-shot-citation/route";
import { __resetAgentRateLimits, AGENT_RATE_LIMIT } from "@/lib/agent-rate-limit";

const TOKEN = "a".repeat(40); // ≥ MIN_LEN (32)
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"];

const saved: Record<string, string | undefined> = {};
function snapshotEnv() {
  for (const k of [...PROVIDER_KEYS, "AGENT_SERVICE_TOKEN", "E2E_FAKE_PROVIDERS", "VERCEL"]) {
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
});
