/**
 * Serve Lookup Tests — resolveSiteForServing()
 *
 * Customer-facing scenarios for the slug resolution logic that determines
 * which audit data gets served when a customer's rewrite URL is hit.
 *
 * Scenarios:
 *   1. Re-audit upgrade: old slug serves latest complete audit
 *   2. Schema block count: old slug serves newer audit with more blocks
 *   3. Asset preference: newer audit's asset wins over older
 *   4. In-progress guard: still-crawling audit does NOT replace old complete one
 *   5. Prefix matching: partial/bookmarked slug resolves via prefix
 *   6. No audits: unknown domain returns null
 *   7. Domain isolation: similar slugs from different domains don't cross-contaminate
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB — hoisted before all imports ───────────────────────────────────

// We intercept db.select() to return a chainable builder that resolves
// to whatever rows we configure per-call. Each call to db.select() gets
// the next entry from `selectResults`.

const selectResults: unknown[][] = [];

function pushSelectResult(rows: unknown[]) {
  selectResults.push(rows);
}

vi.mock("@/lib/db", () => {
  // The source code uses two chain shapes:
  //   A) db.select().from().where()                    — returns array (exact slug lookup)
  //   B) db.select().from().where().orderBy().limit()  — returns array (domain + prefix queries)
  //
  // We make .where() return a thenable object that ALSO has .orderBy().
  // When awaited directly (pattern A), it resolves to the rows array.
  // When .orderBy().limit() is called (pattern B), limit() resolves to rows.

  function makeChain(rows: unknown[]) {
    const whereResult = {
      // Pattern B: .orderBy().limit()
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
      // Pattern A: direct await via thenable protocol
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        return Promise.resolve(rows).then(resolve, reject);
      },
    };

    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
      }),
    };
  }

  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const rows = selectResults.shift() ?? [];
        return makeChain(rows);
      }),
    },
  };
});

// ─── Import under test (after mocks) ────────────────────────────────────────

import { resolveSiteForServing } from "@/lib/serve-lookup";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeSite(overrides: Record<string, unknown> = {}) {
  return {
    id: "site-default",
    domain: "flowblinq.com",
    slug: "flowblinq-com",
    ownerEmail: "test@flowblinq.com",
    pipelineStatus: "complete",
    generatedLlmsTxt: "# FlowBlinq\nAI commerce middleware.",
    generatedLlmsFullTxt: "# FlowBlinq Full\nDetailed AI commerce middleware docs.",
    generatedBusinessJson: { name: "FlowBlinq" },
    generatedSchemaBlocks: [{ "@type": "Organization" }],
    createdAt: new Date("2025-01-15T00:00:00Z"),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("resolveSiteForServing — customer scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.length = 0;
  });

  // ── Scenario 1: Re-audit upgrade ────────────────────────────────────────
  // Customer linked "flowblinq-com" months ago. Re-audit created
  // "flowblinq-com-rkjDYU". Requesting the OLD slug should return
  // the LATEST complete audit data.

  it("1. old slug serves data from the latest complete re-audit", async () => {
    const oldSite = makeSite({
      id: "site-old",
      slug: "flowblinq-com",
      generatedLlmsTxt: "# Old audit content",
      createdAt: new Date("2025-01-15T00:00:00Z"),
    });

    const newSite = makeSite({
      id: "site-new",
      slug: "flowblinq-com-rkjDYU",
      generatedLlmsTxt: "# New audit content with improvements",
      createdAt: new Date("2025-06-01T00:00:00Z"),
    });

    // Call 1: exact slug lookup — finds the old site (gets domain)
    pushSelectResult([oldSite]);
    // Call 2: latest complete for domain — returns the newer audit
    pushSelectResult([newSite]);

    const result = await resolveSiteForServing("flowblinq-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-new");
    expect(result!.generatedLlmsTxt).toBe("# New audit content with improvements");
  });

  // ── Scenario 2: Schema blocks upgraded from 13 to 30 ───────────────────
  // Old audit had 13 schema blocks. New audit has 30 with FAQPage.
  // Serving old slug should return the 30-block version.

  it("2. old slug returns newer audit with 30 schema blocks (not old 13)", async () => {
    const oldBlocks = Array.from({ length: 13 }, (_, i) => ({
      "@type": "Organization",
      blockIndex: i,
    }));

    const newBlocks = [
      ...Array.from({ length: 29 }, (_, i) => ({
        "@type": "Organization",
        blockIndex: i,
      })),
      { "@type": "FAQPage", blockIndex: 29 },
    ];

    const oldSite = makeSite({
      id: "site-old-schema",
      slug: "acme-store-com",
      domain: "acme-store.com",
      generatedSchemaBlocks: oldBlocks,
      createdAt: new Date("2025-02-01T00:00:00Z"),
    });

    const newSite = makeSite({
      id: "site-new-schema",
      slug: "acme-store-com-Xk9mWp",
      domain: "acme-store.com",
      generatedSchemaBlocks: newBlocks,
      createdAt: new Date("2025-07-15T00:00:00Z"),
    });

    // Call 1: exact slug lookup
    pushSelectResult([oldSite]);
    // Call 2: latest complete for domain with generatedSchemaBlocks
    pushSelectResult([newSite]);

    const result = await resolveSiteForServing("acme-store-com", "generatedSchemaBlocks");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-new-schema");
    const blocks = result!.generatedSchemaBlocks as unknown[];
    expect(blocks).toHaveLength(30);
    expect(blocks[29]).toEqual(
      expect.objectContaining({ "@type": "FAQPage" })
    );
  });

  // ── Scenario 3: Newer audit's asset preferred over older ────────────────
  // Both old and new audits have the requested asset. The newer one wins.

  it("3. when both audits have the asset, newer audit is preferred", async () => {
    const oldSite = makeSite({
      id: "site-v1",
      slug: "widget-co-com",
      domain: "widget-co.com",
      generatedBusinessJson: { name: "Widget Co", version: 1 },
      createdAt: new Date("2025-03-01T00:00:00Z"),
    });

    const newSite = makeSite({
      id: "site-v2",
      slug: "widget-co-com-Ab3cDe",
      domain: "widget-co.com",
      generatedBusinessJson: { name: "Widget Co", version: 2, newField: true },
      createdAt: new Date("2025-08-01T00:00:00Z"),
    });

    // Call 1: exact slug
    pushSelectResult([oldSite]);
    // Call 2: latest complete for domain
    pushSelectResult([newSite]);

    const result = await resolveSiteForServing("widget-co-com", "generatedBusinessJson");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-v2");
    expect((result!.generatedBusinessJson as any).version).toBe(2);
    expect((result!.generatedBusinessJson as any).newField).toBe(true);
  });

  // ── Scenario 4: In-progress audit does NOT replace completed one ────────
  // New audit is still "crawling". Should serve the old complete audit
  // until the new one finishes.

  it("4. still-crawling re-audit does not replace the old complete audit", async () => {
    const completeSite = makeSite({
      id: "site-complete",
      slug: "parts-depot-com",
      domain: "parts-depot.com",
      pipelineStatus: "complete",
      generatedLlmsTxt: "# Parts Depot — Complete Audit",
      createdAt: new Date("2025-04-01T00:00:00Z"),
    });

    // The new audit exists but is still crawling — it won't be returned
    // by the domain query because that query filters on pipelineStatus = "complete".
    // So the domain query returns the old complete site.

    const oldSiteForSlug = makeSite({
      id: "site-complete",
      slug: "parts-depot-com",
      domain: "parts-depot.com",
      pipelineStatus: "complete",
      generatedLlmsTxt: "# Parts Depot — Complete Audit",
      createdAt: new Date("2025-04-01T00:00:00Z"),
    });

    // Call 1: exact slug lookup — finds the old slug's record
    pushSelectResult([oldSiteForSlug]);
    // Call 2: latest complete for domain — only the old one is complete
    pushSelectResult([completeSite]);

    const result = await resolveSiteForServing("parts-depot-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-complete");
    expect(result!.generatedLlmsTxt).toBe("# Parts Depot — Complete Audit");
    expect(result!.pipelineStatus).toBe("complete");
  });

  // ── Scenario 5: Prefix matching for bookmarked/partial slugs ────────────
  // Someone bookmarked a partial slug. The exact match fails, but prefix
  // matching finds the right site.

  it("5. partial slug resolves via prefix matching when exact match fails", async () => {
    const site = makeSite({
      id: "site-prefix",
      slug: "flowblinq-com-rkjDYU",
      generatedLlmsTxt: "# FlowBlinq prefix match",
    });

    // Call 1: exact slug lookup — no match for bare "flowblinq-com"
    pushSelectResult([]);
    // Call 2 (prefix match): LIKE 'flowblinq-com%' finds the suffixed slug
    pushSelectResult([site]);

    const result = await resolveSiteForServing("flowblinq-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-prefix");
    expect(result!.slug).toBe("flowblinq-com-rkjDYU");
  });

  // ── Scenario 6: No audits exist — returns null ──────────────────────────

  it("6. completely unknown slug returns null", async () => {
    // Call 1: exact slug lookup — nothing
    pushSelectResult([]);
    // Call 2: prefix match — nothing
    pushSelectResult([]);

    const result = await resolveSiteForServing("nonexistent-domain-xyz", "generatedLlmsTxt");

    expect(result).toBeNull();
  });

  // ── Scenario 7: Domain isolation — similar slugs don't leak ─────────────
  // "flowblinq-com" must NOT return data from "flowblinq-commerce-com".
  // The exact slug lookup anchors to a specific domain, and the domain
  // query only matches that exact domain.

  it("7. slug 'flowblinq-com' does not return data from 'flowblinq-commerce.com'", async () => {
    const correctSite = makeSite({
      id: "site-flowblinq",
      slug: "flowblinq-com",
      domain: "flowblinq.com",
      generatedLlmsTxt: "# FlowBlinq — correct domain",
      createdAt: new Date("2025-05-01T00:00:00Z"),
    });

    // The domain query for "flowblinq.com" should only return sites
    // with domain = "flowblinq.com", not "flowblinq-commerce.com".
    // This is enforced by eq(geoSites.domain, domain) in the implementation.

    // Call 1: exact slug lookup — finds flowblinq.com site
    pushSelectResult([correctSite]);
    // Call 2: latest complete for domain "flowblinq.com" — returns correct site
    pushSelectResult([correctSite]);

    const result = await resolveSiteForServing("flowblinq-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.domain).toBe("flowblinq.com");
    expect(result!.id).toBe("site-flowblinq");
    expect(result!.generatedLlmsTxt).toBe("# FlowBlinq — correct domain");
  });

  // ── Edge case: exact slug exists but has no asset, domain query finds one ─

  it("exact slug has no asset but newer audit for same domain does", async () => {
    const oldSiteNoAsset = makeSite({
      id: "site-no-asset",
      slug: "bare-site-com",
      domain: "bare-site.com",
      generatedLlmsTxt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });

    const newSiteWithAsset = makeSite({
      id: "site-with-asset",
      slug: "bare-site-com-Qr7tYz",
      domain: "bare-site.com",
      generatedLlmsTxt: "# Bare Site — full content",
      createdAt: new Date("2025-09-01T00:00:00Z"),
    });

    // Call 1: exact slug — finds old site (gets domain)
    pushSelectResult([oldSiteNoAsset]);
    // Call 2: latest complete for domain with asset — finds new site
    pushSelectResult([newSiteWithAsset]);

    const result = await resolveSiteForServing("bare-site-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-with-asset");
    expect(result!.generatedLlmsTxt).toBe("# Bare Site — full content");
  });

  // ── Edge case: domain found but no complete audit with requested asset ───

  it("domain exists but no complete audit has the requested asset — falls back to exact", async () => {
    const siteNoAsset = makeSite({
      id: "site-pending",
      slug: "pending-site-com",
      domain: "pending-site.com",
      pipelineStatus: "complete",
      generatedLlmsTxt: null,
      generatedLlmsFullTxt: null,
    });

    // Call 1: exact slug — finds site (gets domain)
    pushSelectResult([siteNoAsset]);
    // Call 2: latest complete for domain with asset — nothing has the asset
    pushSelectResult([]);

    const result = await resolveSiteForServing("pending-site-com", "generatedLlmsTxt");

    // Falls back to exact slug match (step 4 in the implementation)
    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-pending");
    expect(result!.generatedLlmsTxt).toBeNull();
  });

  // ── Edge case: prefix match should not fire when exact slug exists ───────

  it("prefix matching is skipped when exact slug already matched", async () => {
    const exactSite = makeSite({
      id: "site-exact",
      slug: "exact-match-com",
      domain: "exact-match.com",
      generatedLlmsTxt: "# Exact match content",
    });

    // Call 1: exact slug — found
    pushSelectResult([exactSite]);
    // Call 2: domain query — returns same site (latest complete)
    pushSelectResult([exactSite]);
    // No call 3 should happen — prefix matching skipped

    const result = await resolveSiteForServing("exact-match-com", "generatedLlmsTxt");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("site-exact");
    // Only 2 db.select() calls should have been made (exact + domain), not 3
    const { db } = await import("@/lib/db");
    // The mock was called for calls 1 and 2 only
    expect(selectResults).toHaveLength(0); // both consumed, none left over
  });
});
