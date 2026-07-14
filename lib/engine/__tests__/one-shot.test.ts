// Unit tests for the stateless one-shot citation engine. Providers are stubbed
// via the OneShotDeps seam (the same injection the runner uses), so these run
// with no provider keys, no network, and no DB.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runOneShot,
  computeShareOfVoice,
  partitionModels,
  isModelConfigured,
  ONE_SHOT_TIME_BUDGET_MS,
  type AgentModel,
  type OneShotDeps,
  type OneShotResult,
} from "@/lib/engine/one-shot";
import type { ProviderQueryResult } from "@/lib/engine/providers";

const ALL: AgentModel[] = ["openai", "anthropic", "perplexity", "gemini"];

/** A fixture provider that echoes the prompt and cites a fixed URL set. */
function fixture(text: string, citedUrls: string[] = []) {
  return async (): Promise<ProviderQueryResult> => ({ text, responseTimeMs: 3, citedUrls });
}

/** Deps that route every engine platform to the same fixture, no redirects. */
function fixtureDeps(text: string, citedUrls: string[] = []): OneShotDeps {
  const fn = fixture(text, citedUrls);
  return {
    queryFns: { openai: fn, anthropic: fn, perplexity: fn, google: fn },
    resolveRedirectsFn: async (u: string) => u,
  };
}

describe("partitionModels / isModelConfigured", () => {
  const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("treats a present, non-empty key as configured", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(isModelConfigured("openai")).toBe(true);
    expect(isModelConfigured("anthropic")).toBe(false);
  });

  it("treats whitespace-only as unconfigured", () => {
    process.env.GEMINI_API_KEY = "   ";
    expect(isModelConfigured("gemini")).toBe(false);
  });

  it("splits requested models into configured / unconfigured", () => {
    process.env.OPENAI_API_KEY = "sk-1";
    process.env.PERPLEXITY_API_KEY = "pk-1";
    const { configured, unconfigured } = partitionModels(ALL);
    expect(configured).toEqual(["openai", "perplexity"]);
    expect(unconfigured).toEqual(["anthropic", "gemini"]);
  });
});

describe("computeShareOfVoice", () => {
  const brand = "acme.com";
  const competitors = [
    { name: "Beta", domain: "beta.io" },
    { name: "Gamma", domain: "gamma.co" },
  ];

  function resultWith(citeDomains: string[]): OneShotResult {
    return {
      prompt: "p",
      model: "openai",
      response_excerpt: "",
      brand_mentioned: false,
      citations: citeDomains.map((d) => ({ url: `https://${d}/article` })),
    };
  }

  it("returns undefined when no citation matches brand or a competitor", () => {
    const sov = computeShareOfVoice([resultWith(["unrelated.com"])], brand, competitors);
    expect(sov).toBeUndefined();
  });

  it("splits share across brand + competitors by domain match", () => {
    // 2 brand cites, 1 beta, 1 gamma → total 4
    const results = [
      resultWith(["acme.com", "acme.com", "beta.io"]),
      resultWith(["gamma.co", "unrelated.com"]),
    ];
    const sov = computeShareOfVoice(results, brand, competitors)!;
    expect(sov.brand).toBeCloseTo(0.5);
    expect(sov.competitors).toEqual([
      { domain: "beta.io", share: 0.25 },
      { domain: "gamma.co", share: 0.25 },
    ]);
  });

  it("counts subdomains of the brand/competitor domain (domain LIKE %.d parity)", () => {
    const results = [resultWith(["blog.acme.com", "www.beta.io"])];
    const sov = computeShareOfVoice(results, brand, competitors)!;
    expect(sov.brand).toBeCloseTo(0.5);
    expect(sov.competitors.find((c) => c.domain === "beta.io")!.share).toBeCloseTo(0.5);
  });

  it("strips www from the brand domain before matching", () => {
    const sov = computeShareOfVoice([resultWith(["acme.com"])], "www.acme.com", [])!;
    expect(sov.brand).toBe(1);
  });
});

describe("runOneShot — happy path", () => {
  it("fans out prompt × model, extracts mention + citations", async () => {
    const deps = fixtureDeps(
      "Acme is a leading option. See acme.com for details.",
      ["https://acme.com/reviews", "https://thirdparty.example/roundup"],
    );
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["best tools?", "top vendors?"] },
      ["openai", "gemini"],
      deps,
    );

    // 2 prompts × 2 models = 4 results, prompt-major order.
    expect(out.results).toHaveLength(4);
    expect(out.results.map((r) => `${r.prompt}|${r.model}`)).toEqual([
      "best tools?|openai",
      "best tools?|gemini",
      "top vendors?|openai",
      "top vendors?|gemini",
    ]);

    // Brand mentioned in every response → mention_rate 1.
    expect(out.results.every((r) => r.brand_mentioned)).toBe(true);
    expect(out.summary.mention_rate).toBe(1);
    expect(out.summary.models_run).toEqual(["openai", "gemini"]);

    // Citations extracted + de-duped per result.
    expect(out.results[0].citations.map((c) => c.url)).toEqual([
      "https://acme.com/reviews",
      "https://thirdparty.example/roundup",
    ]);
  });

  it("truncates the excerpt to ~500 chars", async () => {
    const long = "x".repeat(2000);
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["p"] },
      ["openai"],
      fixtureDeps(long),
    );
    expect(out.results[0].response_excerpt).toHaveLength(500);
  });

  it("reports brand_mentioned=false when the brand is absent", async () => {
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["p"] },
      ["openai"],
      fixtureDeps("Some other companies: foo, bar, baz."),
    );
    expect(out.results[0].brand_mentioned).toBe(false);
    expect(out.summary.mention_rate).toBe(0);
  });

  it("attaches share_of_voice computed from the same responses", async () => {
    const out = await runOneShot(
      {
        brandDomain: "acme.com",
        prompts: ["p"],
        competitors: [{ name: "Beta", domain: "beta.io" }],
      },
      ["openai"],
      fixtureDeps("Acme and Beta.", ["https://acme.com/a", "https://beta.io/b"]),
    );
    expect(out.summary.share_of_voice).toEqual({
      brand: 0.5,
      competitors: [{ domain: "beta.io", share: 0.5 }],
    });
  });

  it("omits share_of_voice when no citation matches brand/competitors", async () => {
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["p"] },
      ["openai"],
      fixtureDeps("Acme.", ["https://unrelated.example/x"]),
    );
    expect(out.summary.share_of_voice).toBeUndefined();
  });

  it("a provider that throws yields an empty result, never fails the run", async () => {
    const deps: OneShotDeps = {
      queryFns: {
        openai: async () => { throw new Error("provider down"); },
        google: fixture("Acme is great. acme.com", ["https://acme.com/x"]),
      },
      resolveRedirectsFn: async (u) => u,
    };
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["p"] },
      ["openai", "gemini"],
      deps,
    );
    expect(out.results).toHaveLength(2);
    const openai = out.results.find((r) => r.model === "openai")!;
    expect(openai.response_excerpt).toBe("");
    expect(openai.brand_mentioned).toBe(false);
    expect(openai.citations).toEqual([]);
    // The healthy gemini cell still produced a mention.
    expect(out.results.find((r) => r.model === "gemini")!.brand_mentioned).toBe(true);
  });
});

describe("runOneShot — time budget", () => {
  it("fills un-run cells with empty results when the deadline has passed", async () => {
    // now() jumps past the deadline immediately → every cell short-circuits to a
    // timeout result without calling the provider.
    const queried = vi.fn(fixture("Acme", ["https://acme.com/x"]));
    const start = 1_000_000;
    const out = await runOneShot(
      { brandDomain: "acme.com", prompts: ["p1", "p2"] },
      ["openai"],
      {
        queryFns: { openai: queried },
        resolveRedirectsFn: async (u) => u,
        // First now() call establishes the deadline; subsequent calls are past it.
        now: (() => {
          let calls = 0;
          return () => (calls++ === 0 ? start : start + ONE_SHOT_TIME_BUDGET_MS + 1);
        })(),
      },
    );
    expect(out.results).toHaveLength(2);
    expect(out.results.every((r) => r.response_excerpt === "" && r.citations.length === 0)).toBe(true);
    expect(queried).not.toHaveBeenCalled();
  });
});
