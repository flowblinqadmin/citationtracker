import { describe, test, expect } from "vitest";
import { buildSystemPrompt } from "../system-prompt";
import type { RetrievedChunk } from "../retrieve";

describe("buildSystemPrompt", () => {
  const mockChunks: RetrievedChunk[] = [
    { content: "WordPress supports JSON-LD via plugins", source: "wordpress-docs:example.com", similarity: 0.52, category: "platform", platform: "wordpress" },
    { content: "GEO score measures AI visibility", source: "local:geo-portal-guide.md", similarity: 0.48, category: "geo-guide", platform: null },
  ];

  test("includes role and guardrails", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).toContain("Cleo");
    expect(prompt).toContain("PRODUCT KNOWLEDGE");
    expect(prompt).toContain("RULES");
  });

  test("includes product knowledge", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).toContain("PRODUCT KNOWLEDGE");
    expect(prompt).toContain("FlowBlinq GEO");
    expect(prompt).toContain("$10/month");
  });

  test("includes site context when provided", () => {
    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        overallScore: 65,
        executiveSummary: "Your site has moderate AI visibility",
        pillars: [{ pillarName: "Schema.org", score: 35, priority: "high" }],
        rankedRecommendations: [{ rank: 1, title: "Add JSON-LD", pillar: "Schema.org", priority: "HIGH" }],
        platformDetected: "wordpress",
        tier: "paid",
        credits: 50,
      },
      null,
      [],
      "refused",
    );
    expect(prompt).toContain("example.com");
    expect(prompt).toContain("65/100");
    expect(prompt).toContain("wordpress");
    expect(prompt).toContain("Schema.org: 35/100");
    expect(prompt).toContain("Add JSON-LD");
  });

  test("includes view context when provided", () => {
    const prompt = buildSystemPrompt(null, {
      page: "results",
      currentTab: "scorecard",
      domain: "example.com",
      expandedPillar: "Schema.org",
    }, [], "refused");
    expect(prompt).toContain("CURRENT VIEW CONTEXT");
    expect(prompt).toContain("results page");
    expect(prompt).toContain('"scorecard" tab');
    expect(prompt).toContain('"Schema.org" pillar expanded');
  });

  test("includes retrieved chunks with source tags", () => {
    const prompt = buildSystemPrompt(null, null, mockChunks, "full");
    expect(prompt).toContain("SOURCES");
    expect(prompt).toContain('<source id="1"');
    expect(prompt).toContain('<source id="2"');
    expect(prompt).toContain("WordPress supports JSON-LD");
    expect(prompt).toContain("wordpress-docs:example.com");
  });

  test("adds hedged preamble for marginal confidence", () => {
    const prompt = buildSystemPrompt(null, null, mockChunks, "hedged");
    expect(prompt).toContain("partially relevant");
  });

  test("truncates long executive summaries", () => {
    const longSummary = "A".repeat(600);
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 50, executiveSummary: longSummary, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(prompt).toContain("...");
    // Should not contain the full 600 chars
    expect(prompt.includes("A".repeat(600))).toBe(false);
  });

  test("includes all recommendations without capping", () => {
    const manyRecs = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1, title: `Rec ${i + 1}`, pillar: "Test", priority: "HIGH",
    }));
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 50, executiveSummary: null, pillars: [], rankedRecommendations: manyRecs, platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(prompt).toContain("Rec 5");
    expect(prompt).toContain("Rec 10");
  });

  // ── Additional coverage ───────────────────────────────────────────────

  test("omits SOURCES section when no chunks provided", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).not.toContain("## SOURCES");
  });

  test("omits CURRENT VIEW CONTEXT section when viewContext is null", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).not.toContain("## CURRENT VIEW CONTEXT");
  });

  test("omits USER'S SITE DATA section when siteContext is null", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).not.toContain("## USER'S SITE DATA");
  });

  test("includes USER'S SITE DATA heading when siteContext is provided", () => {
    const prompt = buildSystemPrompt(
      { domain: "mysite.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(prompt).toContain("USER'S SITE DATA");
  });

  test("does not add hedged preamble for full confidence", () => {
    const prompt = buildSystemPrompt(null, null, mockChunks, "full");
    expect(prompt).not.toContain("partially relevant");
  });

  test("does not add hedged preamble for refused confidence", () => {
    const prompt = buildSystemPrompt(null, null, mockChunks, "refused");
    expect(prompt).not.toContain("partially relevant");
  });

  test("source ids are 1-based in correct order", () => {
    const prompt = buildSystemPrompt(null, null, mockChunks, "full");
    const id1Pos = prompt.indexOf('id="1"');
    const id2Pos = prompt.indexOf('id="2"');
    expect(id1Pos).toBeLessThan(id2Pos);
  });

  test("executive summary at exactly 500 chars is not truncated", () => {
    const summary = "B".repeat(500);
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 70, executiveSummary: summary, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "paid" },
      null, [], "refused",
    );
    expect(prompt).toContain("B".repeat(500));
    expect(prompt).not.toContain("B".repeat(500) + "...");
  });

  test("executive summary at 501 chars is truncated to 500 + ellipsis", () => {
    const summary = "C".repeat(501);
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 70, executiveSummary: summary, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "paid" },
      null, [], "refused",
    );
    expect(prompt).toContain("C".repeat(500) + "...");
    expect(prompt).not.toContain("C".repeat(501));
  });

  test("includes credits in site context when provided", () => {
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 80, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "paid", credits: 42 },
      null, [], "refused",
    );
    expect(prompt).toContain("Credits: 42");
  });

  test("omits Credits line when credits is not provided", () => {
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: 80, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "paid" },
      null, [], "refused",
    );
    expect(prompt).not.toContain("Credits:");
  });

  test("includes tier in site context", () => {
    const freePrompt = buildSystemPrompt(
      { domain: "test.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(freePrompt).toContain("Tier: free");

    const paidPrompt = buildSystemPrompt(
      { domain: "test.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "paid" },
      null, [], "refused",
    );
    expect(paidPrompt).toContain("Tier: paid");
  });

  test("omits overall score line when overallScore is null", () => {
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(prompt).not.toContain("Overall GEO Score:");
  });

  test("omits platform detected line when platformDetected is null", () => {
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: null, tier: "free" },
      null, [], "refused",
    );
    expect(prompt).not.toContain("Platform detected:");
  });

  test("includes platform detected when provided", () => {
    const prompt = buildSystemPrompt(
      { domain: "test.com", overallScore: null, executiveSummary: null, pillars: [], rankedRecommendations: [], platformDetected: "shopify", tier: "free" },
      null, [], "refused",
    );
    expect(prompt).toContain("Platform detected: shopify");
  });

  test("view context includes expanded recommendation number", () => {
    const prompt = buildSystemPrompt(null, {
      page: "results",
      expandedRecommendation: 3,
    }, [], "refused");
    expect(prompt).toContain("recommendation #3 expanded");
  });

  test("view context includes visible pillar scores", () => {
    const prompt = buildSystemPrompt(null, {
      page: "results",
      visiblePillarScores: [
        { name: "Schema.org", score: 40, priority: "high" },
        { name: "Content Quality", score: 75, priority: "medium" },
      ],
    }, [], "refused");
    expect(prompt).toContain("Schema.org: 40/100 (high)");
    expect(prompt).toContain("Content Quality: 75/100 (medium)");
  });

  test("view context includes visible recommendations", () => {
    const prompt = buildSystemPrompt(null, {
      page: "dashboard",
      visibleRecommendations: [
        { rank: 1, title: "Add JSON-LD", priority: "HIGH" },
        { rank: 2, title: "Fix robots.txt", priority: "MED" },
      ],
    }, [], "refused");
    expect(prompt).toContain("#1 Add JSON-LD (HIGH)");
    expect(prompt).toContain("#2 Fix robots.txt (MED)");
  });

  test("view context omits tab line when currentTab is not set", () => {
    const prompt = buildSystemPrompt(null, { page: "dashboard" }, [], "refused");
    expect(prompt).not.toContain("They are viewing the");
  });

  // ── Phase 1: strict-grounding rules + anti-example block ────────────────

  test("Phase 1: rules 12, 13, 14 are present in the prompt", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).toMatch(/12\.\s*NEVER name a UI element/i);
    expect(prompt).toMatch(/13\.\s*NEVER name a file, plugin/i);
    expect(prompt).toMatch(/14\.\s*The Setup tab/i);
  });

  test("Phase 1: rule 12 lists the real tabs and disclaims fabricated UI", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).toContain("overview, scorecard, recommendations, pages, history, setup");
    expect(prompt).toMatch(/no\s+["']?settings tab/i);
    expect(prompt).toMatch(/no\s+["']?credits dashboard/i);
    expect(prompt).toMatch(/no\s+["']?get integration instructions/i);
  });

  test("Phase 1: rule 2 forbids filling integration steps from training data", () => {
    const prompt = buildSystemPrompt(null, null, [], "refused");
    expect(prompt).toMatch(/answer only from/i);
    expect(prompt).toMatch(/do not use general training knowledge/i);
  });

  test("examples block renders on every tier with positive + anti examples", () => {
    for (const tier of ["full", "hedged", "refused"] as const) {
      const prompt = buildSystemPrompt(null, null, [], tier);
      expect(prompt).toMatch(/EXAMPLES.*how to write platform answers/i);
      expect(prompt).toMatch(/POSITIVE EXAMPLES/);
      expect(prompt).toMatch(/ANTI-EXAMPLES/);
    }
  });

  test("examples block names the verbatim terms gpt-4o-mini drops", () => {
    const prompt = buildSystemPrompt(null, null, [], "full");
    expect(prompt).toContain("Cloudflare Worker");
    expect(prompt).toContain("theme.liquid");
    expect(prompt).toContain("vercel.json");
    expect(prompt).toMatch(/Webflow's reverse proxy/);
    expect(prompt).toMatch(/Get Integration Instructions/);
  });

  // ── Phase 3: {{SLUG}} substitution at SOURCES build time ─────────────────

  test("Phase 3: {{SLUG}} in retrieved chunks is substituted with siteContext.slug", () => {
    const chunkWithSlug: RetrievedChunk = {
      content: "Run: curl https://geo.flowblinq.com/api/serve/{{SLUG}}/llms.txt",
      source: "platform/wix.md",
      similarity: 0.7,
      category: "platform",
      platform: "wix",
    };
    const prompt = buildSystemPrompt(
      { domain: "test.com", slug: "acme-co", tier: "free" },
      null,
      [chunkWithSlug],
      "full",
    );
    expect(prompt).toContain("geo.flowblinq.com/api/serve/acme-co/llms.txt");
    expect(prompt).not.toContain("{{SLUG}}");
  });

  test("Phase 3: missing slug falls back to YOUR-SLUG placeholder", () => {
    const chunkWithSlug: RetrievedChunk = {
      content: "Add: <img src=\"/api/t/{{SLUG}}\" />",
      source: "platform/shopify.md",
      similarity: 0.65,
      category: "platform",
      platform: "shopify",
    };
    const prompt = buildSystemPrompt(null, null, [chunkWithSlug], "full");
    expect(prompt).toContain("/api/t/YOUR-SLUG");
    expect(prompt).not.toContain("{{SLUG}}");
  });

  test("recommendation specificAction is included (truncated at 150 chars)", () => {
    const longAction = "Do this specific thing: " + "Z".repeat(200);
    const prompt = buildSystemPrompt(
      {
        domain: "test.com",
        overallScore: 60,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [{ rank: 1, title: "Big Fix", pillar: "Schema", priority: "HIGH", specificAction: longAction }],
        platformDetected: null,
        tier: "paid",
      },
      null, [], "refused",
    );
    // specificAction is sliced at 150 chars — the Z's start at position 24 so 150-24 = 126 Z's max
    expect(prompt).not.toContain("Z".repeat(200));
    expect(prompt).toContain("Z".repeat(126));
  });

  // ── Integration State Tests ───────────────────────────────────────────

  test("includes INTEGRATION STATE block when integrationLive is present", () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        slug: "example-com",
        overallScore: 75,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [],
        platformDetected: null,
        tier: "paid",
        integrationLive: {
          llmsTxt: { ok: true, method: "direct (GPTBot/1.1)", checkedAt: now },
          schemaJson: { ok: true, checkedAt: now },
          trackingPixel: { lastSeenAt: fiveMinutesAgo },
          generatedArtifactsReady: { llmsTxt: true, schemaBlocks: 3, businessJson: true },
        },
      },
      null,
      [],
      "refused",
    );

    expect(prompt).toContain("Integration State:");
    expect(prompt).toContain("example.com/llms.txt");
    expect(prompt).toContain("OK");
    expect(prompt).toContain("schema.json");
    expect(prompt).toContain("3 schema blocks");
    expect(prompt).toContain("llms.txt ready");
    expect(prompt).toContain("business.json ready");
  });

  test("does NOT include INTEGRATION STATE block when integrationLive is absent", () => {
    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        overallScore: 75,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [],
        platformDetected: null,
        tier: "paid",
      },
      null,
      [],
      "refused",
    );

    expect(prompt).not.toContain("Integration State:");
  });

  test("includes action footer when llmsTxt.ok is false", () => {
    const now = new Date();

    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        slug: "example-com",
        overallScore: 75,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [],
        platformDetected: null,
        tier: "paid",
        integrationLive: {
          llmsTxt: { ok: false, method: "direct (GPTBot/1.1)", checkedAt: now },
          schemaJson: { ok: true, checkedAt: now },
          trackingPixel: { lastSeenAt: now },
          generatedArtifactsReady: { llmsTxt: false, schemaBlocks: 0, businessJson: false },
        },
      },
      null,
      [],
      "refused",
    );

    expect(prompt).toContain("NOT REACHABLE");
    expect(prompt).toContain("Setup tab");
    expect(prompt).toContain("Test Connection");
  });

  test("includes action footer when tracking pixel is older than 7 days", () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        slug: "example-com",
        overallScore: 75,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [],
        platformDetected: null,
        tier: "paid",
        integrationLive: {
          llmsTxt: { ok: true, method: "direct", checkedAt: now },
          schemaJson: { ok: true, checkedAt: now },
          trackingPixel: { lastSeenAt: eightDaysAgo },
          generatedArtifactsReady: { llmsTxt: true, schemaBlocks: 1, businessJson: true },
        },
      },
      null,
      [],
      "refused",
    );

    expect(prompt).toContain("Setup tab");
    expect(prompt).toContain("Test Connection");
  });

  test("does not include action footer when integration is fully operational", () => {
    const now = new Date();

    const prompt = buildSystemPrompt(
      {
        domain: "example.com",
        slug: "example-com",
        overallScore: 75,
        executiveSummary: null,
        pillars: [],
        rankedRecommendations: [],
        platformDetected: null,
        tier: "paid",
        integrationLive: {
          llmsTxt: { ok: true, method: "direct", checkedAt: now },
          schemaJson: { ok: true, checkedAt: now },
          trackingPixel: { lastSeenAt: now },
          generatedArtifactsReady: { llmsTxt: true, schemaBlocks: 2, businessJson: true },
        },
      },
      null,
      [],
      "refused",
    );

    expect(prompt).not.toContain("Action: ");
  });
});
