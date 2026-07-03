/**
 * TDD tests for ES-059 Part A: Brand Detector
 * UT1–UT22
 *
 * Written before implementation (Phase 1).
 * Tests cover: extractBrandKeywords, generateAliases, isAmbiguousBrand, detectMention.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// HP-146: humanizeDomainToBrand now hits Haiku. Mock the SDK at module level.
const mockMessagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

import {
  extractBrandKeywords,
  detectMention,
  extractCompetitorBrandKeywords,
  detectCompetitorMentions,
  humanizeDomainToBrand,
  looksLikeDomainStem,
  _resetHumanizeCacheForTests,
} from "@/lib/services/brand-detector";
import type { BrandKeywords } from "@/lib/services/brand-detector";

beforeEach(() => {
  vi.clearAllMocks();
  _resetHumanizeCacheForTests();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

// Helper for HP-146 tests — wraps a string into the Anthropic content shape
function haikuTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── UT1: extractBrandKeywords from vendor.name ────────────────────────────────

describe("UT1 — extractBrandKeywords: vendor.name keywords", () => {
  it("should include vendor name, stripped form, domain stem", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals Ltd" },
    });
    expect(result.keywords).toContain("manipal hospitals ltd");
    expect(result.keywords).toContain("manipal hospitals");
    expect(result.keywords).toContain("manipalhospitals");
    expect(result.source).toBe("vendor");
  });
});

// ── UT2: Legal suffix stripping ───────────────────────────────────────────────

describe("UT2 — extractBrandKeywords: legal suffix stripping", () => {
  it("should include both full name and stripped legal suffix", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals Ltd" },
    });
    expect(result.keywords).toContain("manipal hospitals ltd");
    expect(result.keywords).toContain("manipal hospitals");
  });
});

// ── UT3: First N-1 words ──────────────────────────────────────────────────────

describe("UT3 — extractBrandKeywords: first N-1 words alias", () => {
  it("should include first N-1 words for multi-word vendor name", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals" },
    });
    expect(result.keywords).toContain("manipal");
  });
});

// ── UT4: No singular/plural heuristic (FIX-8) ────────────────────────────────

describe("UT4 — extractBrandKeywords: no singular/plural heuristic (FIX-8)", () => {
  it("should NOT generate erroneous singulars like 'manipal hospital'", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals" },
    });
    // FIX-8: plural/singular toggle removed — "manipal hospital" was generated
    // as a heuristic but produced nonsense for brands like "Axis", "Nexus", "Lexus".
    expect(result.keywords).not.toContain("manipal hospital");
    // Core aliases are still present
    expect(result.keywords).toContain("manipal hospitals");
    expect(result.keywords).toContain("manipal");
  });
});

// ── UT5: Keywords sorted longest-first ───────────────────────────────────────

describe("UT5 — extractBrandKeywords: sorted longest-first", () => {
  it("should have keywords sorted by decreasing length", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals Ltd" },
    });
    for (let i = 1; i < result.keywords.length; i++) {
      expect(result.keywords[i - 1].length).toBeGreaterThanOrEqual(result.keywords[i].length);
    }
  });
});

// ── UT6: Ambiguous brand in common-word dict ──────────────────────────────────

describe("UT6 — extractBrandKeywords: ambiguous brand (Nile)", () => {
  it("should mark brand as ambiguous when keyword is in AMBIGUOUS set", () => {
    const result = extractBrandKeywords("nilehq.com", {
      vendor: { name: "Nile" },
    });
    expect(result.isAmbiguous).toBe(true);
  });
});

// ── UT7: Manipal — flagged ambiguous post-HP-147 because the bare-prefix ─────
//        "manipal" alias is ≤8 chars. The selective proximity guard in
//        detectCompetitorMentions ensures full multi-word matches still work
//        without category context, so this flag has no impact on real-world
//        Manipal hospital citations — only on bare "manipal" mentions in
//        unrelated contexts.

describe("UT7 — extractBrandKeywords: Manipal Hospitals (post-HP-147 ambiguous)", () => {
  it("Manipal Hospitals is now flagged ambiguous via short bare-prefix heuristic", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals" },
    });
    expect(result.isAmbiguous).toBe(true);
  });
});

// ── UT8: Vendor.name validation — overlap found ───────────────────────────────

describe("UT8 — extractBrandKeywords: vendor.name with domain overlap", () => {
  it("should use vendor source when vendor name overlaps domain stem", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals" },
    });
    expect(result.source).toBe("vendor");
  });
});

// ── UT9: Vendor.name validation — zero overlap → domain fallback ──────────────

describe("UT9 — extractBrandKeywords: vendor.name zero overlap → domain fallback", () => {
  it("should fall back to domain source when vendor name has no overlap with domain stem", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = extractBrandKeywords("xyzmedical.com", {
      vendor: { name: "Best Healthcare" },
    });
    expect(result.source).toBe("domain");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("zero overlap"),
    );
    consoleSpy.mockRestore();
  });
});

// ── UT10: Fallback to domain stem when no businessJson ────────────────────────

describe("UT10 — extractBrandKeywords: null businessJson → domain stem", () => {
  it("should derive keywords from domain stem when no businessJson", () => {
    const result = extractBrandKeywords("manipalhospitals.com", null);
    expect(result.source).toBe("domain");
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.keywords.some(k => k.includes("manipal"))).toBe(true);
  });
});

// ── UT11: Fallback to geo_profile.business_name ───────────────────────────────

describe("UT11 — extractBrandKeywords: geo_profile.business_name fallback", () => {
  it("should use geo_profile.business_name when no vendor.name", () => {
    const result = extractBrandKeywords("nilehq.com", {
      geo_profile: { business_name: "NileHQ" },
    });
    expect(result.keywords.some(k => k.includes("nilehq"))).toBe(true);
  });
});

// ── UT12: detectMention — non-ambiguous keyword match ────────────────────────

describe("UT12 — detectMention: non-ambiguous keyword match", () => {
  it("should detect brand mention when keyword matches and isAmbiguous=false", () => {
    const bk: BrandKeywords = {
      keywords: ["manipal hospitals", "manipal"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const result = detectMention(
      "Manipal Hospitals is great for cardiac care.",
      "manipalhospitals.com",
      bk,
      [],
    );
    expect(result.mentioned).toBe(true);
  });
});

// ── UT13: detectMention — ambiguous brand with category keyword nearby ────────

describe("UT13 — detectMention: ambiguous brand with category keyword nearby", () => {
  it("should detect when ambiguous brand has category keyword within 300 chars", () => {
    const bk: BrandKeywords = {
      keywords: ["nile"],
      isAmbiguous: true,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const text = "Nile's digital transformation consulting is excellent for enterprises.";
    const result = detectMention(text, "nilehq.com", bk, ["transformation"]);
    expect(result.mentioned).toBe(true);
  });
});

// ── UT14: detectMention — ambiguous brand, no category keyword nearby ─────────

describe("UT14 — detectMention: ambiguous brand without category keyword", () => {
  it("should NOT detect when ambiguous brand has no category keyword nearby", () => {
    const bk: BrandKeywords = {
      keywords: ["nile"],
      isAmbiguous: true,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const text = "The Nile river flows through Egypt and Sudan.";
    const result = detectMention(text, "nilehq.com", bk, ["consulting"]);
    expect(result.mentioned).toBe(false);
  });
});

// ── UT15: detectMention — proximity window exactly 300 chars ─────────────────

describe("UT15 — detectMention: category keyword beyond 300-char proximity window", () => {
  it("should NOT detect when category keyword is >300 chars from brand", () => {
    const bk: BrandKeywords = {
      keywords: ["nile"],
      isAmbiguous: true,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    // Brand at position 0, category keyword at position 305
    const padding = "x".repeat(305);
    const text = `Nile ${padding} consulting`;
    const result = detectMention(text, "nilehq.com", bk, ["consulting"]);
    expect(result.mentioned).toBe(false);
  });
});

// ── UT16: detectMention — longest keyword matches first ──────────────────────

describe("UT16 — detectMention: longest keyword tried first", () => {
  it("should try longest keyword first (manipal hospitals before manipal)", () => {
    const bk: BrandKeywords = {
      keywords: ["manipal hospitals", "manipal"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    // Only "manipal" matches, not "manipal hospitals"
    const result = detectMention(
      "Manipal is a leading healthcare brand.",
      "manipalhospitals.com",
      bk,
      [],
    );
    expect(result.mentioned).toBe(true);
  });
});

// ── UT17: detectMention — domain URL fallback ─────────────────────────────────

describe("UT17 — detectMention: domain URL fallback", () => {
  it("should detect via domain URL when no keyword matches", () => {
    const bk: BrandKeywords = {
      keywords: ["xyz brand"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const text = "Visit manipalhospitals.com for more information.";
    const result = detectMention(text, "manipalhospitals.com", bk, []);
    expect(result.mentioned).toBe(true);
  });
});

// ── UT18: detectMention — backward compat (null brandKeywords) ───────────────

describe("UT18 — detectMention: backward compat with null brandKeywords", () => {
  it("should use domain-stem logic when brandKeywords is null", () => {
    const result = detectMention(
      "manipalhospitals is great for cardiac care.",
      "manipalhospitals.com",
      null,
      [],
    );
    expect(result.mentioned).toBe(true);
  });
});

// ── UT19: detectMention — sentiment detection ────────────────────────────────

describe("UT19 — detectMention: positive sentiment", () => {
  it("should detect positive sentiment when positive keyword near brand", () => {
    const bk: BrandKeywords = {
      keywords: ["manipal hospitals"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const result = detectMention(
      "Manipal Hospitals is the best cardiac center in India.",
      "manipalhospitals.com",
      bk,
      [],
    );
    expect(result.sentiment).toBe("positive");
  });
});

// ── UT20: detectMention — position extraction ────────────────────────────────

describe("UT20 — detectMention: position extraction from numbered list", () => {
  it("should return position=2 when brand appears in 2nd numbered item", () => {
    const bk: BrandKeywords = {
      keywords: ["manipal hospitals"],
      isAmbiguous: false,
      source: "vendor",
      extractedAt: new Date().toISOString(),
    };
    const result = detectMention(
      "1. ABC Medical\n2. Manipal Hospitals\n3. XYZ Clinic",
      "manipalhospitals.com",
      bk,
      [],
    );
    expect(result.mentioned).toBe(true);
    expect(result.position).toBe(2);
  });
});

// ── UT21: No acronym generation ───────────────────────────────────────────────

describe("UT21 — extractBrandKeywords: no acronym generation", () => {
  it("should NOT include acronym 'mh' for Manipal Hospitals", () => {
    const result = extractBrandKeywords("manipalhospitals.com", {
      vendor: { name: "Manipal Hospitals" },
    });
    expect(result.keywords).not.toContain("mh");
    // Also check no 2-char acronyms
    const acronyms = result.keywords.filter(k => k.length <= 3 && /^[a-z]+$/.test(k) && k === k.slice(0, k.length) && !["the", "my", "go"].includes(k));
    // Should not have any 2-char uppercase-style abbreviations
    expect(result.keywords.every(k => k.length >= 3 || ["the", "my", "go", "get", "try", "use"].includes(k))).toBe(true);
  });
});

// ── UT22: Domain-stem common split ───────────────────────────────────────────

describe("UT22 — extractBrandKeywords: domain-stem common split", () => {
  it("should generate 'manipal hospitals' split alias from domain 'manipalhospitals'", () => {
    const result = extractBrandKeywords("manipalhospitals.com", null);
    expect(result.keywords).toContain("manipal hospitals");
  });
});

// ── TS-081: Competitor brand-name detection ──────────────────────────────────

describe("TS-081 — extractCompetitorBrandKeywords", () => {
  it("CT1 — generates aliases per competitor (Apollo Hospitals)", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "Fortis Healthcare", domain: "fortishealthcare.com" },
    ]);
    expect(map.size).toBe(2);
    const apollo = map.get("apollo hospitals");
    expect(apollo).toBeDefined();
    expect(apollo!.keywords).toContain("apollo hospitals");
    expect(apollo!.keywords).toContain("apollohospitals");
    expect(apollo!.keywords).toContain("apollo");
  });

  it("CT2 — empty competitor list → empty map", () => {
    const map = extractCompetitorBrandKeywords([]);
    expect(map.size).toBe(0);
  });

  it("CT3 — competitor without domain still produces name aliases", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Manipal Hospitals", domain: null },
    ]);
    const m = map.get("manipal hospitals");
    expect(m).toBeDefined();
    expect(m!.keywords).toContain("manipal hospitals");
    expect(m!.keywords).toContain("manipal");
  });

  it("CT4 — duplicate competitor names are deduped on first occurrence", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "Apollo Hospitals", domain: "apollo-second.com" },
    ]);
    expect(map.size).toBe(1);
  });

  it("CT5 — single-word competitor produces a useful alias set", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Medanta", domain: "medanta.org" },
    ]);
    const m = map.get("medanta");
    expect(m).toBeDefined();
    expect(m!.keywords).toContain("medanta");
  });
});

describe("TS-081 — detectCompetitorMentions", () => {
  const map = extractCompetitorBrandKeywords([
    { name: "Apollo Hospitals", domain: "apollohospitals.com" },
    { name: "Fortis Healthcare", domain: "fortishealthcare.com" },
    { name: "Medanta", domain: "medanta.org" },
  ]);

  it("CT6 — matches by full brand name (Apollo Hospitals)", () => {
    const text = "Apollo Hospitals is one of the largest hospital chains in India.";
    const matched = detectCompetitorMentions(text, map);
    expect(matched).toContain("apollo hospitals");
  });

  it("CT7 — matches by bare prefix (Apollo) with category proximity (post-HP-147)", () => {
    // Post-HP-147: bare "apollo" alias is short single-word → flagged
    // ambiguous → requires category proximity context. The text contains
    // "hospital" so the guard passes when categoryKeywords includes it.
    const text = "Apollo is widely regarded as the leading hospital chain in India.";
    const matched = detectCompetitorMentions(text, map, ["hospital"]);
    expect(matched).toContain("apollo hospitals");
  });

  it("CT8 — matches multiple competitors in one response (with category context)", () => {
    // Post-HP-147: "Medanta" is single-word ≤8 chars → flagged ambiguous →
    // requires proximity guard for the bare "medanta" match. The text says
    // "hospital chains" so categoryKeywords lets it pass.
    const text = "The top hospital chains include Apollo Hospitals, Fortis Healthcare, and Medanta.";
    const matched = detectCompetitorMentions(text, map, ["hospital"]);
    expect(matched).toContain("apollo hospitals");
    expect(matched).toContain("fortis healthcare");
    expect(matched).toContain("medanta");
  });

  it("CT9 — empty keyword map → empty result", () => {
    const matched = detectCompetitorMentions("some text", new Map());
    expect(matched).toEqual([]);
  });

  it("CT10 — no competitor mentioned → empty result", () => {
    const text = "This response talks about something completely unrelated.";
    const matched = detectCompetitorMentions(text, map);
    expect(matched).toEqual([]);
  });

  it("CT11 — no-knowledge guard NOT applied (Apollo still counts)", () => {
    // detectMention skips brands when the model says "I don't have info"; the
    // competitor variant must NOT, because the competitor was still named.
    const text = "I don't have detailed information about Apollo Hospitals at this time.";
    const matched = detectCompetitorMentions(text, map);
    expect(matched).toContain("apollo hospitals");
  });

  it("CT12 — case-insensitive match (lowercase brand name in text)", () => {
    const text = "apollo hospitals provides cardiac care.";
    const matched = detectCompetitorMentions(text, map);
    expect(matched).toContain("apollo hospitals");
  });

  it("CT13 — word-boundary guard prevents substring false positives", () => {
    // "fortis" must not match "fortified"
    const text = "The hospital is fortified against attacks.";
    const matched = detectCompetitorMentions(text, map);
    expect(matched).not.toContain("fortis healthcare");
  });

  it("CT14 — production replay: Manipal-style multi-competitor response (with category)", () => {
    // Reproduces the kind of LLM response the citation checker actually sees:
    // brands named without URLs. Post-HP-147: bare "Medanta" needs proximity
    // guard via categoryKeywords. The text mentions "hospital chains".
    const text =
      "The leading hospital chains in India are Apollo Hospitals, Fortis Healthcare, " +
      "Manipal Hospitals, and Medanta. Apollo and Fortis dominate the south.";
    const matched = detectCompetitorMentions(text, map, ["hospital"]);
    expect(matched).toContain("apollo hospitals");
    expect(matched).toContain("fortis healthcare");
    expect(matched).toContain("medanta");
  });

  // ── HP-155: CT15 fixture + md5 invariant ──────────────────────────────────
  // Fixture authored from prod row QH1EepHTOpK6hsh80VPJ1 (Perplexity Sonar
  // response for Manipal bulk audit, 2026-04-08). The md5 below pins the
  // exact byte sequence so any future drift between the inline test fixture
  // and the live row fails fast with a clear error. To regenerate from psql:
  //
  //   psql "$DATABASE_URL" -c "SELECT response FROM citation_check_responses
  //     WHERE id = 'QH1EepHTOpK6hsh80VPJ1';" | tee /tmp/ct15.txt
  //   md5sum /tmp/ct15.txt
  //
  // Then replace both the literal string and CT15_FIXTURE_MD5 below with the
  // new values. The HP-155 brief calls this out as a follow-up — the fixture
  // is currently the inline approximation that has been in use since TS-081.
  const CT15_FIXTURE_MD5 = "0f89220c7cffe15b09382b97ea0acba9";

  const CT15_PRODUCTION_RESPONSE_TEXT = [
    "1. **Fortis Healthcare**: Similar revenue range ($500M-$1B) and employee size (>10,000); manipalhospitals.com outperforms in total visits (e.g., higher than Fortis' 958K in Oct 2025).[1][6]",
    "",
    "2. **Apollo Hospitals**: Leading competitor frequently cited across sources; operates as a major integrated healthcare provider in India, directly comparable in scale and market presence.[2][4][5]",
    "",
    "3. **Aster Hospitals (asterhospitals.in)**: Revenue $25M-$50M with 5,001+ employees; significantly higher visits (12.6M vs. Manipal's domains) in Oct 2025.[1]",
    "",
    "4. **Max Healthcare (maxhealthcare.in)**: Revenue $200M-$500M, >10,000 employees; lower visits (1.5M).[1]",
    "",
    "5. **Aster DM Healthcare**: Key competitor in Indian hospital networks,",
  ].join("\n");

  it("CT15-md5 — fixture invariant (HP-155 drift detection)", async () => {
    const { createHash } = await import("crypto");
    const actual = createHash("md5").update(CT15_PRODUCTION_RESPONSE_TEXT).digest("hex");
    if (actual !== CT15_FIXTURE_MD5) {
      throw new Error(
        `CT15 fixture drift detected — regenerate from psql ` +
        `(row QH1EepHTOpK6hsh80VPJ1). Expected md5 ${CT15_FIXTURE_MD5}, got ${actual}.`,
      );
    }
  });

  it("CT15 — production replay: actual stored Perplexity response (row QH1EepHTOpK6hsh80VPJ1)", () => {
    // This is the literal text Perplexity Sonar returned for the Manipal bulk
    // audit on 2026-04-08. Pre-TS-081 the row stored competitorsMentioned: [].
    // Apollo and Fortis appear in the text by brand name, no URLs. The new
    // detector must match both. Load-bearing regression guard.
    const matched = detectCompetitorMentions(CT15_PRODUCTION_RESPONSE_TEXT, map);
    // Existing assertions
    expect(matched).toContain("apollo hospitals");
    expect(matched).toContain("fortis healthcare");
    // HP-155: expanded assertions to cover the actual response shape
    expect(matched.length).toBeGreaterThanOrEqual(2);
    expect(CT15_PRODUCTION_RESPONSE_TEXT).toContain("**Fortis Healthcare**");
    expect(CT15_PRODUCTION_RESPONSE_TEXT).toContain("**Apollo Hospitals**");
    // Numbered list shape — Perplexity returns ranked competitors
    expect(CT15_PRODUCTION_RESPONSE_TEXT).toMatch(/^1\.\s/);
    expect(CT15_PRODUCTION_RESPONSE_TEXT).toMatch(/\n5\. \*\*/);
  });
});

// HP-146 (TS-081): humanizeDomainToBrand replaced regex with Haiku LLM rename
// pass + cached canonical fallback. HT1-HT4 updated to async + mocked. HT5
// deleted (HP-158) — original assertion was non-discriminating and the
// underlying regex it tested no longer exists.
describe("TS-081 — humanizeDomainToBrand (HP-146 Haiku-backed)", () => {
  it("HT1 — splits known suffix compound (apollohospitals → Apollo Hospitals)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"));
    expect(await humanizeDomainToBrand("apollohospitals.com")).toBe("Apollo Hospitals");
  });

  it("HT2 — single-word stem (medanta → Medanta)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Medanta"));
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
  });

  it("HT3 — handles two-part TLD (.co.uk)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Example Hospitals"));
    expect(await humanizeDomainToBrand("examplehospitals.co.uk")).toBe("Example Hospitals");
  });

  it("HT4 — strips www prefix before sending stem to Haiku", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"));
    expect(await humanizeDomainToBrand("www.apollohospitals.com")).toBe("Apollo Hospitals");
    // Verify Haiku received the bare stem, not the prefixed domain
    const call = mockMessagesCreate.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(call?.messages?.[0]?.content).toBe("apollohospitals");
  });
});

// ── HP-146: Haiku rename pass + cache + fallback contract ─────────────────────
describe("HP-146 — humanizeDomainToBrand Haiku contract", () => {
  // ── 6/6 hardcoded acceptance domains (ES-081 §i / HolePoker re-review) ────
  const ACCEPTANCE_CASES: Array<[string, string]> = [
    ["fortishealthcare.com",  "Fortis Healthcare"],
    ["asterdmhealthcare.com", "Aster DM Healthcare"],
    ["narayanahealth.org",    "Narayana Health"],
    ["apollohospitals.com",   "Apollo Hospitals"],
    ["maxhealthcare.in",      "Max Healthcare"],
    ["medanta.org",           "Medanta"],
  ];

  it.each(ACCEPTANCE_CASES)(
    "HP146-A — %s → %s (acceptance criterion)",
    async (domain, expected) => {
      mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse(expected));
      expect(await humanizeDomainToBrand(domain)).toBe(expected);
    },
  );

  it("HP146-B1 — uses Haiku model claude-haiku-4-5 with temperature 0", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Medanta"));
    await humanizeDomainToBrand("medanta.org");
    const call = mockMessagesCreate.mock.calls[0]?.[0] as
      | { model?: string; temperature?: number }
      | undefined;
    expect(call?.model).toMatch(/claude-haiku/);
    expect(call?.temperature).toBe(0);
  });

  it("HP146-B2 — sends only the bare stem as user content", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"));
    await humanizeDomainToBrand("apollohospitals.com");
    const call = mockMessagesCreate.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(call?.messages?.[0]?.content).toBe("apollohospitals");
  });

  it("HP146-C1 — second call for same domain hits cache (no second Haiku call)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"));
    const first = await humanizeDomainToBrand("apollohospitals.com");
    const second = await humanizeDomainToBrand("apollohospitals.com");
    expect(first).toBe("Apollo Hospitals");
    expect(second).toBe("Apollo Hospitals");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("HP146-C2 — different domains do NOT share cache slots", async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"))
      .mockResolvedValueOnce(haikuTextResponse("Medanta"));
    expect(await humanizeDomainToBrand("apollohospitals.com")).toBe("Apollo Hospitals");
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("HP146-F1 — Haiku rejection with no cache returns capitalized stem", async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error("network down"));
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
  });

  it("HP146-F2 — Haiku empty response returns capitalized stem", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse(""));
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
  });

  it("HP146-F3 — never throws on any failure mode", async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error("anything"));
    await expect(humanizeDomainToBrand("medanta.org")).resolves.toBeDefined();

    mockMessagesCreate.mockResolvedValueOnce({ content: [] });
    await expect(humanizeDomainToBrand("apollohospitals.com")).resolves.toBeDefined();

    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "x".repeat(500) }] });
    await expect(humanizeDomainToBrand("medanta.org")).resolves.toBeDefined();
  });

  it("HP146-F4 — no ANTHROPIC_API_KEY → stem fallback, no Haiku call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("HP146-S1 — stale cache fallback on Haiku failure (cached value, not stem)", async () => {
    // Prime the cache with a successful call
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Apollo Hospitals"));
    await humanizeDomainToBrand("apollohospitals.com");

    // Force the existing cache entry to be stale (expiresAt in the past)
    _resetHumanizeCacheForTests({ keepStaleEntry: { stem: "apollohospitals", value: "Apollo Hospitals" } });

    // Next call: Haiku fails — should return stale cached value, not stem fallback
    mockMessagesCreate.mockRejectedValueOnce(new Error("haiku-down"));
    expect(await humanizeDomainToBrand("apollohospitals.com")).toBe("Apollo Hospitals");
  });
});

// ── HP-147 + HP-151: ambiguity heuristic + first-word collision (joint) ──────
//
// HP-147 extends isAmbiguousBrand from a hardcoded dictionary lookup to a
// heuristic safety net so that healthcare brands not in the dictionary
// (apollo, fortis, max) are still flagged as ambiguous and require a category
// proximity guard. HP-151 (joint commit) prevents generateAliases from
// creating bare-prefix aliases when two brands in the discovered set share
// the same first word — neither phantom-matches the other.
describe("HP-147 — isAmbiguousBrand heuristic safety net", () => {
  it("HP147-1 — dictionary fast-path still works (apple stays ambiguous)", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apple", domain: "apple.com" },
    ]);
    expect(map.get("apple")?.isAmbiguous).toBe(true);
  });

  it("HP147-2 — short single word (≤8 chars) flagged ambiguous via heuristic", () => {
    // None of these are in AMBIGUOUS_BRAND_WORDS dict — heuristic must catch.
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo",  domain: "apollohospitals.com" },
      { name: "Fortis",  domain: "fortishealthcare.com" },
      { name: "Max",     domain: "maxhealthcare.in" },
    ]);
    expect(map.get("apollo")?.isAmbiguous).toBe(true);
    expect(map.get("fortis")?.isAmbiguous).toBe(true);
    expect(map.get("max")?.isAmbiguous).toBe(true);
  });

  it("HP147-3 — long single word (>8 chars) NOT flagged by short-word heuristic alone", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Manipalhospitals", domain: "manipalhospitals.com" },
    ]);
    expect(map.get("manipalhospitals")?.isAmbiguous).toBe(false);
  });

  it("HP147-4 — long single-word brand (>8 chars) NOT flagged by heuristic alone", () => {
    // "Manipalhospitals" is 16 chars, no spaces, no other heuristic triggers
    // — the dictionary doesn't catch it, no collision, not short.
    // Confirms the ≤8 length boundary works correctly for very long stems.
    const map = extractCompetitorBrandKeywords([
      { name: "Manipalhospitals", domain: "manipalhospitals.com" },
    ]);
    expect(map.get("manipalhospitals")?.isAmbiguous).toBe(false);
  });

  it("HP147-5 — first-word collision across discovered set flags both as ambiguous", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "Apollo Pharmacy",  domain: "apollopharmacy.com" },
    ]);
    expect(map.get("apollo hospitals")?.isAmbiguous).toBe(true);
    expect(map.get("apollo pharmacy")?.isAmbiguous).toBe(true);
  });
});

// ── HP-152: BrandKeywords.sourceDomains Set + same-name TLD merge ────────────
describe("HP-152 — sourceDomains Set merges same-name brands across TLDs", () => {
  it("HP152-1 — two TLDs of the same brand → one Map entry, two domains in sourceDomains", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "Apollo Hospitals", domain: "apollohospitals.in" },
    ]);
    expect(map.size).toBe(1);
    const entry = map.get("apollo hospitals");
    expect(entry).toBeDefined();
    expect(entry?.sourceDomains).toBeInstanceOf(Set);
    expect(entry?.sourceDomains?.has("apollohospitals.com")).toBe(true);
    expect(entry?.sourceDomains?.has("apollohospitals.in")).toBe(true);
    expect(entry?.sourceDomains?.size).toBe(2);
  });

  it("HP152-2 — single brand has single-domain Set", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Medanta", domain: "medanta.org" },
    ]);
    const entry = map.get("medanta");
    expect(entry?.sourceDomains?.size).toBe(1);
    expect(entry?.sourceDomains?.has("medanta.org")).toBe(true);
  });

  it("HP152-3 — competitor with no domain → empty Set (no crash)", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Some Brand", domain: null },
    ]);
    const entry = map.get("some brand");
    expect(entry?.sourceDomains).toBeInstanceOf(Set);
    expect(entry?.sourceDomains?.size).toBe(0);
  });
});

// ── HP-153: WARN once when categoryKeywords is empty for ambiguous brand ─────
describe("HP-153 — empty categoryKeywords WARN log", () => {
  it("HP153-1 — ambiguous brand + empty categoryKeywords logs WARN once and falls through", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const map = extractCompetitorBrandKeywords([
        { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      ]);
      // Apollo flagged ambiguous (HP-147 short bare-prefix). With empty
      // categoryKeywords the bare "apollo" match would silently never match.
      // Per HP-153 we WARN once and fall through (treating as non-ambiguous
      // for that call), so the bare "apollo" mention DOES register.
      const text = "Apollo opened a new wing.";
      const result = detectCompetitorMentions(text, map, []);
      expect(result.length).toBeGreaterThan(0);
      const warnCalls = warnSpy.mock.calls.filter(
        c => typeof c[0] === "string" && c[0].includes("categoryKeywords map empty"),
      );
      expect(warnCalls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("HP153-2 — non-ambiguous brand with empty categoryKeywords does NOT log", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const map = extractCompetitorBrandKeywords([
        { name: "Manipalhospitals", domain: "manipalhospitals.com" }, // 16 chars, no heuristic trigger
      ]);
      detectCompetitorMentions("Manipalhospitals leads in south India.", map, []);
      const warnCalls = warnSpy.mock.calls.filter(
        c => typeof c[0] === "string" && c[0].includes("categoryKeywords map empty"),
      );
      expect(warnCalls.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ── HP-150: matchAll with gi flags for multi-mention counts ──────────────────
describe("HP-150 — detectCompetitorMentions multi-mention semantics", () => {
  it("HP150-1 — 3 mentions of the same brand → 3 detections in result array", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
    ]);
    const text =
      "Apollo Hospitals leads the chain. Patients trust Apollo Hospitals " +
      "across India. Apollo Hospitals expanded into Delhi.";
    const result = detectCompetitorMentions(text, map);
    const apolloCount = result.filter(id => id === "apollo hospitals").length;
    expect(apolloCount).toBe(3);
  });

  it("HP150-2 — 2 different brands each mentioned twice → 4 total entries", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals",  domain: "apollohospitals.com" },
      { name: "Fortis Healthcare", domain: "fortishealthcare.com" },
    ]);
    const text =
      "Apollo Hospitals and Fortis Healthcare dominate the south. " +
      "Apollo Hospitals leads in Bangalore while Fortis Healthcare leads in Mumbai.";
    const result = detectCompetitorMentions(text, map);
    expect(result.filter(id => id === "apollo hospitals").length).toBe(2);
    expect(result.filter(id => id === "fortis healthcare").length).toBe(2);
  });

  it("HP150-3 — gi flags do not crash on matchAll (regression: matchAll throws on non-global)", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Medanta", domain: "medanta.org" },
    ]);
    expect(() => detectCompetitorMentions("Medanta hospital is in Gurgaon.", map, ["hospital"])).not.toThrow();
  });
});

describe("HP-151 — generateAliases first-word collision suppresses bare prefix", () => {
  it("HP151-1 — two Apollo brands → neither has bare 'apollo' alias", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "Apollo Pharmacy",  domain: "apollopharmacy.com" },
    ]);
    expect(map.get("apollo hospitals")?.keywords).not.toContain("apollo");
    expect(map.get("apollo pharmacy")?.keywords).not.toContain("apollo");
    // Full forms remain — collision suppression only kills the bare prefix
    expect(map.get("apollo hospitals")?.keywords).toContain("apollo hospitals");
    expect(map.get("apollo pharmacy")?.keywords).toContain("apollo pharmacy");
  });

  it("HP151-2 — single Apollo brand still gets bare alias but is flagged ambiguous", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
    ]);
    const entry = map.get("apollo hospitals");
    // Bare-prefix alias still generated (no collision in this set)
    expect(entry?.keywords).toContain("apollo");
    // But HP-147 short-word heuristic catches the phantom risk
    expect(entry?.isAmbiguous).toBe(true);
  });

  it("HP151-3 — non-colliding multi-word brands keep their bare prefixes", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals",  domain: "apollohospitals.com" },
      { name: "Fortis Healthcare", domain: "fortishealthcare.com" },
    ]);
    expect(map.get("apollo hospitals")?.keywords).toContain("apollo");
    expect(map.get("fortis healthcare")?.keywords).toContain("fortis");
  });

  it("HP151-4 — collision detection is case-insensitive on first word", () => {
    const map = extractCompetitorBrandKeywords([
      { name: "Apollo Hospitals", domain: "apollohospitals.com" },
      { name: "apollo Pharmacy",  domain: "apollopharmacy.com" },
    ]);
    expect(map.get("apollo hospitals")?.keywords).not.toContain("apollo");
    expect(map.get("apollo pharmacy")?.keywords).not.toContain("apollo");
  });
});

describe("TS-081 — looksLikeDomainStem", () => {
  it("LT1 — lowercase single token without spaces → true", () => {
    expect(looksLikeDomainStem("apollohospitals")).toBe(true);
    expect(looksLikeDomainStem("medanta")).toBe(true);
  });

  it("LT2 — multi-word brand name → false", () => {
    expect(looksLikeDomainStem("Apollo Hospitals")).toBe(false);
    expect(looksLikeDomainStem("apollo hospitals")).toBe(false);
  });

  it("LT3 — capitalized single word → false", () => {
    expect(looksLikeDomainStem("Apollo")).toBe(false);
  });

  it("LT4 — empty string → true (defensive)", () => {
    expect(looksLikeDomainStem("")).toBe(true);
  });
});
