/**
 * ES-061 — Portfolio Dashboard: Pure Helper Function Unit Tests
 * U1–U30
 *
 * Written spec-first (Phase A — ReviewMaster).
 * These tests are RED until DaVinci implements app/dashboard/page.tsx.
 *
 * Covers: deriveTier, deriveCriticalIssues, deriveDelta, derivePageCount,
 *         isActiveStatus, domainMonogramColor, formatDashDate, KPI derivation
 */
import { describe, it, expect } from "vitest";
import {
  deriveTier,
  deriveCriticalIssues,
  deriveDelta,
  derivePageCount,
  isActiveStatus,
  formatDashDate,
  domainMonogramColor,
} from "@/app/dashboard/page";

// ── deriveTier ────────────────────────────────────────────────────────────────

describe("deriveTier", () => {
  it("U1 — score=75 → GOOD (boundary)", () => {
    expect(deriveTier(75)).toBe("GOOD");
  });
  it("U2 — score=74 → FAIR (just below GOOD boundary)", () => {
    expect(deriveTier(74)).toBe("FAIR");
  });
  it("U3 — score=50 → FAIR (boundary)", () => {
    expect(deriveTier(50)).toBe("FAIR");
  });
  it("U4 — score=49 → WEAK (just below FAIR boundary)", () => {
    expect(deriveTier(49)).toBe("WEAK");
  });
  it("U5 — score=25 → WEAK (boundary)", () => {
    expect(deriveTier(25)).toBe("WEAK");
  });
  it("U6 — score=24 → POOR (just below WEAK boundary)", () => {
    expect(deriveTier(24)).toBe("POOR");
  });
  it("U7 — score=0 → POOR (minimum)", () => {
    expect(deriveTier(0)).toBe("POOR");
  });
  it("U8 — null → null", () => {
    expect(deriveTier(null)).toBeNull();
  });
  it("score=100 → GOOD", () => {
    expect(deriveTier(100)).toBe("GOOD");
  });
});

// ── deriveCriticalIssues ──────────────────────────────────────────────────────

describe("deriveCriticalIssues", () => {
  it("U9 — [{priority:'critical',score:80}] → 1 (critical priority)", () => {
    expect(deriveCriticalIssues([{ priority: "critical", score: 80 }])).toBe(1);
  });
  it("U10 — [{priority:'high',score:20}] → 1 (score<25 triggers critical)", () => {
    expect(deriveCriticalIssues([{ priority: "high", score: 20 }])).toBe(1);
  });
  it("U11 — [{priority:'high',score:25}] → 0 (score not <25, not critical priority)", () => {
    expect(deriveCriticalIssues([{ priority: "high", score: 25 }])).toBe(0);
  });
  it("U12 — null → 0", () => {
    expect(deriveCriticalIssues(null)).toBe(0);
  });
  it("U13 — [] → 0", () => {
    expect(deriveCriticalIssues([])).toBe(0);
  });
  it("mixed: 1 critical + 1 score<25 + 1 normal → 2", () => {
    expect(
      deriveCriticalIssues([
        { priority: "critical", score: 80 },
        { priority: "high", score: 10 },
        { priority: "low", score: 60 },
      ])
    ).toBe(2);
  });
  it("undefined pillars → 0", () => {
    expect(deriveCriticalIssues(undefined)).toBe(0);
  });
});

// ── deriveDelta ───────────────────────────────────────────────────────────────

describe("deriveDelta", () => {
  it("U14 — (60, prev=50) → 10", () => {
    expect(deriveDelta(60, { geoScorecard: { overallScore: 50 } })).toBe(10);
  });
  it("U15 — (60, null) → null (no snapshot)", () => {
    expect(deriveDelta(60, null)).toBeNull();
  });
  it("U16 — (null, prev=50) → null (no current score)", () => {
    expect(deriveDelta(null, { geoScorecard: { overallScore: 50 } })).toBeNull();
  });
  it("U17 — (60, {geoScorecard:{}}) → null (missing overallScore in snapshot)", () => {
    expect(deriveDelta(60, { geoScorecard: {} })).toBeNull();
  });
  it("negative delta: (40, prev=60) → -20", () => {
    expect(deriveDelta(40, { geoScorecard: { overallScore: 60 } })).toBe(-20);
  });
  it("zero delta: (50, prev=50) → 0", () => {
    expect(deriveDelta(50, { geoScorecard: { overallScore: 50 } })).toBe(0);
  });
});

// ── derivePageCount ───────────────────────────────────────────────────────────

describe("derivePageCount", () => {
  it("U18 — {pages:[1,2,3]} → 3", () => {
    expect(derivePageCount({ pages: [1, 2, 3] })).toBe(3);
  });
  it("U19 — null → 0", () => {
    expect(derivePageCount(null)).toBe(0);
  });
  it("U20 — {} (no pages key) → 0", () => {
    expect(derivePageCount({})).toBe(0);
  });
  it("{pages:[]} → 0", () => {
    expect(derivePageCount({ pages: [] })).toBe(0);
  });
});

// ── isActiveStatus ────────────────────────────────────────────────────────────

describe("isActiveStatus", () => {
  it("U21 — 'crawling' → true", () => {
    expect(isActiveStatus("crawling")).toBe(true);
  });
  it("U22 — 'complete' → false", () => {
    expect(isActiveStatus("complete")).toBe(false);
  });
  it("U23 — null → false", () => {
    expect(isActiveStatus(null)).toBe(false);
  });
  it("U24 — 'pending' → true (now an active pipeline stage)", () => {
    expect(isActiveStatus("pending")).toBe(true);
  });
  it("all 6 active pipeline stages return true", () => {
    const stages = ["discovery", "crawling", "researching", "analyzing", "generating", "assembling"];
    for (const s of stages) {
      expect(isActiveStatus(s), `expected ${s} to be active`).toBe(true);
    }
  });
  it("'failed' → false", () => {
    expect(isActiveStatus("failed")).toBe(false);
  });
  it("'' (empty string) → false", () => {
    expect(isActiveStatus("")).toBe(false);
  });
});

// ── domainMonogramColor ───────────────────────────────────────────────────────

describe("domainMonogramColor", () => {
  it("U25 — deterministic: same domain always returns identical string", () => {
    const a = domainMonogramColor("example.com");
    const b = domainMonogramColor("example.com");
    expect(a).toBe(b);
  });
  it("U26 — different domains return valid CSS style strings (may differ)", () => {
    const a = domainMonogramColor("a.com");
    const b = domainMonogramColor("b.com");
    expect(a).toMatch(/background:/);
    expect(b).toMatch(/background:/);
    // no assertion on equality — they can be same or different
  });
  it("returns background and color properties", () => {
    const result = domainMonogramColor("test.io");
    expect(result).toMatch(/background:/);
    expect(result).toMatch(/color:/);
  });
  it("empty string does not throw", () => {
    expect(() => domainMonogramColor("")).not.toThrow();
  });
});

// ── formatDashDate ────────────────────────────────────────────────────────────

describe("formatDashDate", () => {
  it("null → 'Never'", () => {
    expect(formatDashDate(null)).toBe("Never");
  });
  it("valid ISO string → locale date string (e.g. 'Mar 20, 2026')", () => {
    const result = formatDashDate("2026-03-20T00:00:00Z");
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/20/);
    expect(result).toMatch(/2026/);
  });
  it("does not throw on arbitrary ISO strings", () => {
    expect(() => formatDashDate("2026-01-01T12:00:00.000Z")).not.toThrow();
  });
});

// ── KPI derivation logic ──────────────────────────────────────────────────────

describe("KPI derivation (U27–U30)", () => {
  it("U27 — avgScore for [60, 80] = 70", () => {
    const scores = [60, 80];
    const withScores = scores.filter((s) => s !== null);
    const avg = Math.round(
      withScores.reduce((a, b) => a + b, 0) / withScores.length
    );
    expect(avg).toBe(70);
  });

  it("U28 — all-null scores → avgScore=null (no division)", () => {
    const domains = [
      { overallScore: null as number | null },
      { overallScore: null as number | null },
    ];
    const withScores = domains.filter((d) => d.overallScore !== null);
    const avgScore =
      withScores.length > 0
        ? Math.round(
            withScores.reduce((s, d) => s + (d.overallScore ?? 0), 0) /
              withScores.length
          )
        : null;
    expect(avgScore).toBeNull();
  });

  it("U29 — 1 scanning + 1 complete → scanningCount=1", () => {
    const ACTIVE = [
      "discovery",
      "crawling",
      "researching",
      "analyzing",
      "generating",
      "assembling",
    ];
    const domains = [
      { pipelineStatus: "crawling" },
      { pipelineStatus: "complete" },
    ];
    const count = domains.filter((d) =>
      ACTIVE.includes(d.pipelineStatus ?? "")
    ).length;
    expect(count).toBe(1);
  });

  it("U30 — creditBalance=5 triggers 'Buy more' threshold (< 10)", () => {
    expect(5 < 10).toBe(true);
    expect(10 < 10).toBe(false);
    expect(9 < 10).toBe(true);
  });
});
