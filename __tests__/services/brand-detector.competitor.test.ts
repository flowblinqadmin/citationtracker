/**
 * ES-081 — ReviewMaster Phase A independent unit suite
 *
 * Author:   ReviewMaster (Agent 9)
 * Date:     2026-04-09
 * Spec:     geo/docs/specs/engineering/ES-081-competitor-brand-name-detection.md (§c.1–§c.4)
 *
 * Independence rule:
 *   This file is a true second-author suite. It exercises the four new exports
 *   from `lib/services/brand-detector.ts` against the §c test table in ES-081
 *   using brand fixtures intentionally rotated AWAY from ScriptDev's
 *   `brand-detector.test.ts` (which standardises on Apollo Hospitals / Fortis
 *   Healthcare / Medanta). Primary fixtures here: Aster DM Healthcare, Max
 *   Healthcare, Manipal Hospitals, plus Acme Tech and Target as forcing
 *   functions for the prefix/suffix split and ambiguity-guard branches.
 *
 *   The point of the rotation is blind-spot coverage: a refactor that breaks
 *   the alias-generation path for one brand pair must not silently pass
 *   because both suites picked the same forgiving inputs. ES-081 §c calls
 *   this out as the load-bearing reason ReviewMaster authors a parallel suite.
 *
 * Test IDs map to the §c table verbatim:
 *   - ECK-1..6  → extractCompetitorBrandKeywords    (§c.1)
 *   - DCM-1..9  → detectCompetitorMentions          (§c.2)
 *   - HDB-1..5  → humanizeDomainToBrand             (§c.3)
 *   - LDS-1..5  → looksLikeDomainStem               (§c.4)
 *
 * AC mapping (see §j):
 *   - DCM-6 pins the no-knowledge-guard contract that diverges from
 *     detectMention() — load-bearing for AC-2 (real brand names returned).
 *   - DCM-7 pins the word-boundary regex (anti-regression for "fortified").
 *   - DCM-8/DCM-9 pin the ambiguity proximity guard (AC-2 indirect).
 *   - HDB-* pin the deterministic fallback that AC-3 relies on for the
 *     discovered_competitors backfill.
 *   - LDS-* pin the heuristic that gates the nameMap write path in
 *     extractCompetitorsFromJson() — also AC-3.
 *
 * Pure functions only — no mocks, no DB, no network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// HP-146 (2026-04-09): humanizeDomainToBrand was rewritten to call Haiku
// instead of running a regex compound-split. The §c.3 / HDB-1..5 tests below
// must therefore mock the Anthropic SDK and become async. The test INTENT is
// preserved verbatim — each HDB case still pins the same domain → brand
// mapping that ReviewMaster originally asserted; only the mechanism changed
// from "regex returns X" to "Haiku call returns X via mock". The other 20
// tests in this file (ECK, DCM, LDS) remain pure-function tests with no
// mocks, per RM's original Phase A independence design.
//
// HDB-5 specifically: the original assertion pinned the buggy "Fortishealth
// Care" output as a deliberate documentation of the regex bug. HP-146 fixes
// the bug end-to-end, so HDB-5 inverts to pin the ideal "Fortis Healthcare"
// output that the Haiku-backed function now produces.

const mockMessagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

import {
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

function haikuTextResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── Fixture builder ──────────────────────────────────────────────────────────
//
// Structurally compatible with both `CompetitorInput` (the new exported type
// from brand-detector.ts) and `DiscoveredCompetitor` (lib/types/citation.ts).
// We don't import either type directly to keep this suite decoupled from the
// implementation's internal type graph — the function only reads `name` and
// `domain` per ES-081 §b.1.2.

function makeCompetitor(
  name: string,
  domain?: string | null,
): { name: string; domain: string | null } {
  return { name, domain: domain ?? null };
}

// ═══════════════════════════════════════════════════════════════════════════
// §c.1 — extractCompetitorBrandKeywords (ECK-1..6)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-081 §c.1 — extractCompetitorBrandKeywords (RM independent)", () => {
  it("ECK-1: two competitors → map of size 2 with lowercase canonical id keys", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Aster DM Healthcare", "asterdmhealthcare.com"),
      makeCompetitor("Max Healthcare", "maxhealthcare.com"),
    ]);

    expect(map.size).toBe(2);
    expect(map.has("aster dm healthcare")).toBe(true);
    expect(map.has("max healthcare")).toBe(true);
    // Canonical keys are lowercased — the cased form must NOT be a key.
    expect(map.has("Aster DM Healthcare")).toBe(false);
    expect(map.has("Max Healthcare")).toBe(false);
  });

  it("ECK-2: empty input → empty map, no throw", () => {
    expect(() => extractCompetitorBrandKeywords([])).not.toThrow();
    const map = extractCompetitorBrandKeywords([]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("ECK-3: competitor with domain=null → name-only aliases generated", () => {
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Manipal Hospitals", null),
    ]);

    const kw = map.get("manipal hospitals");
    expect(kw).toBeDefined();
    // The keyword set must include at least the lowercased canonical name.
    expect(kw!.keywords).toEqual(expect.arrayContaining(["manipal hospitals"]));
    // Bare prefix should still be derivable from the name even without a
    // domain — the alias generator falls back to a sanitized name stem.
    expect(kw!.keywords.length).toBeGreaterThan(0);
  });

  it("ECK-4: duplicate competitor names → first wins, subsequent silently dropped", () => {
    // Three duplicates with different cases and domains. Only the first must
    // survive. Determinism is the contract — order of map iteration is the
    // input order so the FIRST item must be retained.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Aster DM Healthcare", "asterdmhealthcare.com"),
      makeCompetitor("aster dm healthcare", "asterdm.in"),
      makeCompetitor("ASTER DM HEALTHCARE", "asterdmhealthcare.co.in"),
    ]);

    expect(map.size).toBe(1);
    expect(map.has("aster dm healthcare")).toBe(true);
    expect(() =>
      extractCompetitorBrandKeywords([
        makeCompetitor("X", "x.com"),
        makeCompetitor("X", "x.com"),
      ]),
    ).not.toThrow();
  });

  it("ECK-5: item missing name field → skipped without throw", () => {
    // Spec §b.1.2: items missing `name` are skipped. Empty string is the
    // realistic missing-name case (TypeScript will accept it; the runtime
    // guard is what we're pinning here).
    const input = [
      { name: "", domain: "ghost.com" } as { name: string; domain: string },
      makeCompetitor("Aster DM Healthcare", "asterdmhealthcare.com"),
    ];

    expect(() => extractCompetitorBrandKeywords(input)).not.toThrow();
    const map = extractCompetitorBrandKeywords(input);
    expect(map.size).toBe(1);
    expect(map.has("aster dm healthcare")).toBe(true);
    expect(map.has("")).toBe(false);
  });

  it("ECK-6: ambiguous brand word in single-word name → isAmbiguous=true (post-HP-147)", () => {
    // "target" is in AMBIGUOUS_BRAND_WORDS per ES-059 — single-token name
    // that hits the dictionary must be flagged.
    //
    // Post-HP-147 update: "Manipal Hospitals" generates a bare-prefix
    // "manipal" alias (7 chars) which trips heuristic #2 (single-word ≤8).
    // The whole brand is now flagged ambiguous. The selective proximity
    // guard in detectCompetitorMentions still allows the full multi-word
    // "manipal hospitals" match without context, so this flag has no effect
    // on real-world citations — only on bare "manipal" mentions in unrelated
    // contexts. Per-competitor isolation of the flag is still preserved.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Target", "target.com"),
      makeCompetitor("Manipal Hospitals", "manipalhospitals.com"),
    ]);

    expect(map.get("target")?.isAmbiguous).toBe(true);
    expect(map.get("manipal hospitals")?.isAmbiguous).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.2 — detectCompetitorMentions (DCM-1..9)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-081 §c.2 — detectCompetitorMentions (RM independent)", () => {
  // Map built from the rotated fixture set. Aster DM is non-ambiguous,
  // Max Healthcare is non-ambiguous, Medanta is non-ambiguous.
  function buildMap(): Map<string, BrandKeywords> {
    return extractCompetitorBrandKeywords([
      makeCompetitor("Aster DM Healthcare", "asterdmhealthcare.com"),
      makeCompetitor("Max Healthcare", "maxhealthcare.com"),
      makeCompetitor("Medanta", "medanta.org"),
    ]);
  }

  it("DCM-1: full brand name match returns lowercased canonical id", () => {
    const map = buildMap();
    const text =
      "Aster DM Healthcare offers tertiary care across the Gulf and southern India.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["aster dm healthcare"]));
    // Output is always lowercased canonical ids.
    for (const id of result) {
      expect(id).toBe(id.toLowerCase());
    }
  });

  it("DCM-2: bare prefix (single-word alias) match with category proximity (post-HP-147)", () => {
    const map = buildMap();
    // Post-HP-147: "Medanta" is short single-word → flagged ambiguous → bare
    // match requires category proximity. The test text already mentions
    // "hospital networks", so passing categoryKeywords lets the guard pass.
    const text = "Medanta is among the top hospital networks in north India.";
    const result = detectCompetitorMentions(text, map, ["hospital"]);

    expect(result).toEqual(expect.arrayContaining(["medanta"]));
  });

  it("DCM-3: multiple competitors in one response → all returned (with category)", () => {
    const map = buildMap();
    // Post-HP-147: "Medanta" needs proximity guard. Text rephrased to include
    // "hospital" context so categoryKeywords proximity passes.
    const text =
      "Aster DM Healthcare, Max Healthcare, and Medanta are leading multi-specialty hospital chains.";
    const result = detectCompetitorMentions(text, map, ["hospital"]);

    expect(result).toEqual(
      expect.arrayContaining(["aster dm healthcare", "max healthcare", "medanta"]),
    );
    // Set semantics — each id at most once even if matched multiple times.
    const counts = new Map<string, number>();
    for (const id of result) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it("DCM-4: empty map → empty result, no scan (perf short-circuit)", () => {
    const empty = new Map<string, BrandKeywords>();
    expect(
      detectCompetitorMentions(
        "Aster DM Healthcare and Max Healthcare are leading chains.",
        empty,
      ),
    ).toEqual([]);
  });

  it("DCM-5: no matches → empty result", () => {
    const map = buildMap();
    const text =
      "The monsoon season delayed construction of the new metro line in Bangalore.";
    expect(detectCompetitorMentions(text, map)).toEqual([]);
  });

  it("DCM-6: no-knowledge guard NOT applied (competitor still counted)", () => {
    // CRITICAL contract pin per ES-081 §b.1.3:
    //   "unlike detectMention(), this function does NOT check
    //    noKnowledgePatterns. A response saying 'I don't have detailed info
    //    about Apollo' still counts as a competitor mention because Apollo
    //    is being named in a comparison."
    //
    // The competitor SOV / co-presence model treats *any* naming as signal,
    // not just confident knowledge. If this guard ever creeps back in, the
    // entire competitor extraction path silently degrades.
    const map = buildMap();
    const text =
      "I don't have detailed information about Max Healthcare's recent expansion plans.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual(expect.arrayContaining(["max healthcare"]));
  });

  it("DCM-7: word-boundary regex prevents 'fortified' substring match for 'fortis'", () => {
    // Anti-regression for the canonical Fortis Healthcare false-positive.
    // We add Fortis to the map for this test only — not in buildMap() —
    // so DCM-1..6 stay decoupled from the regex this test pins.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Fortis Healthcare", "fortishealthcare.com"),
    ]);
    const text =
      "The new ICU was reinforced and fortified with redundant power supplies during the upgrade.";
    const result = detectCompetitorMentions(text, map);

    expect(result).toEqual([]);
    // Defensive: also reject any partial match that starts with "fortis".
    expect(result.some((id) => id.startsWith("fortis"))).toBe(false);
  });

  it("DCM-8: ambiguous brand WITH category proximity → match", () => {
    // "Target" is ambiguous (in AMBIGUOUS_BRAND_WORDS). With a category
    // keyword ("hospital") within the 300-char window, the proximity guard
    // accepts the match.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Target", "target.com"),
    ]);
    const text =
      "Target hospital chain serves the Bangalore metropolitan area with 12 facilities.";
    const result = detectCompetitorMentions(text, map, ["hospital", "healthcare"]);

    expect(result).toEqual(expect.arrayContaining(["target"]));
  });

  it("DCM-9: ambiguous brand WITHOUT category proximity → no match", () => {
    // Same map as DCM-8 but the surrounding text has zero hospital/healthcare
    // category words within 300 chars — the proximity guard must reject.
    const map = extractCompetitorBrandKeywords([
      makeCompetitor("Target", "target.com"),
    ]);
    const text =
      "Target announced a new pricing structure for its consumer electronics segment last quarter.";
    const result = detectCompetitorMentions(text, map, ["hospital", "healthcare"]);

    expect(result).not.toEqual(expect.arrayContaining(["target"]));
    // And explicitly: nothing should match at all in this map.
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.3 — humanizeDomainToBrand (HDB-1..5)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-081 §c.3 — humanizeDomainToBrand (RM independent, post-HP-146)", () => {
  it("HDB-1: 'manipalhospitals.com' → 'Manipal Hospitals'", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Manipal Hospitals"));
    expect(await humanizeDomainToBrand("manipalhospitals.com")).toBe("Manipal Hospitals");
  });

  it("HDB-2: 'acmetech.io' → 'Acme Tech'", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Acme Tech"));
    expect(await humanizeDomainToBrand("acmetech.io")).toBe("Acme Tech");
  });

  it("HDB-3: 'getapollo.com' → 'Get Apollo'", async () => {
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Get Apollo"));
    expect(await humanizeDomainToBrand("getapollo.com")).toBe("Get Apollo");
  });

  it("HDB-4: two-part TLD '.co.in' → stem 'asterdm' sent to Haiku → 'Aster DM'", async () => {
    // HP-146: getDomainStem still strips two-part TLDs before the stem reaches
    // Haiku. RM's original HDB-4 asserted the regex's capitalize-whole-stem
    // fallback ("Asterdm"); after HP-146 the canonical name comes from Haiku.
    // The mock returns "Aster DM" as the canonical brand.
    mockMessagesCreate.mockResolvedValueOnce(haikuTextResponse("Aster DM"));
    expect(await humanizeDomainToBrand("asterdm.co.in")).toBe("Aster DM");

    const call = mockMessagesCreate.mock.calls[0]?.[0] as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(call?.messages?.[0]?.content).toBe("asterdm");
  });

  it("HDB-5: 'fortishealthcare.com' → 'Fortis Healthcare' (HP-146 inverted from buggy regex)", async () => {
    // PRE-HP-146 (RM Phase A original): this test pinned the BUGGY regex
    // output "Fortishealth Care" because COMMON_SUFFIXES contained "care" (4
    // chars) and matched before any longer compound suffix. The assertion was
    // a deliberate-RED bug-pin that drove HolePoker finding HP-146.
    //
    // POST-HP-146: humanizeDomainToBrand calls Haiku, which returns the
    // canonical brand name directly. The mock returns "Fortis Healthcare"
    // (the ideal canonical name). This is one of the 6 hardcoded acceptance
    // criteria from CoFounder's TS-081 HP fan-out brief.
    mockMessagesCreate
      .mockResolvedValueOnce(haikuTextResponse("Medanta"))
      .mockResolvedValueOnce(haikuTextResponse("Fortis Healthcare"));
    expect(await humanizeDomainToBrand("medanta.org")).toBe("Medanta");
    expect(await humanizeDomainToBrand("fortishealthcare.com")).toBe("Fortis Healthcare");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §c.4 — looksLikeDomainStem (LDS-1..5)
// ═══════════════════════════════════════════════════════════════════════════

describe("ES-081 §c.4 — looksLikeDomainStem (RM independent)", () => {
  it("LDS-1: single lowercase token → true", () => {
    expect(looksLikeDomainStem("manipalhospitals")).toBe(true);
    // Defensive: a generic single token also returns true.
    expect(looksLikeDomainStem("acmetech")).toBe(true);
  });

  it("LDS-2: multi-word string with space → false", () => {
    expect(looksLikeDomainStem("Aster DM Healthcare")).toBe(false);
    expect(looksLikeDomainStem("Max Healthcare")).toBe(false);
  });

  it("LDS-3: capitalized single word → false", () => {
    expect(looksLikeDomainStem("Medanta")).toBe(false);
    expect(looksLikeDomainStem("Manipal")).toBe(false);
  });

  it("LDS-4: whitespace-only string → true (defensive default)", () => {
    // ES-081 §b.1.5: empty/whitespace input returns true so the caller
    // falls through to humanizeDomainToBrand(domain).
    expect(looksLikeDomainStem("   ")).toBe(true);
    expect(looksLikeDomainStem("")).toBe(true);
    expect(looksLikeDomainStem("\t\n ")).toBe(true);
  });

  it("LDS-5: hyphenated lowercase string → false (pin current heuristic)", () => {
    // ES-081 §b.1.5 explicitly: today's heuristic accepts hyphenated input
    // (returns false). This is "an arguable edge case" the spec calls out
    // and asks ReviewMaster to pin. Do NOT match a hypothetical
    // "should be true" behavior — that's a future spec change, not a bug.
    expect(looksLikeDomainStem("apollo-hospitals")).toBe(false);
    expect(looksLikeDomainStem("max-healthcare")).toBe(false);
  });
});
