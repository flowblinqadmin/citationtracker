/**
 * TDD tests — app/sites/[id]/design-tokens.ts
 * PR-A monolith extraction: pure helper functions
 *
 * These tests are RED until design-tokens.ts is created.
 */
import { describe, it, expect } from "vitest";
import { scoreColor, scoreTier, formatDate } from "@/app/sites/[id]/design-tokens";

// ── Color constants (must match the copper system in SitePageClient.tsx) ────────
const GREEN  = "#34c759";
const ORANGE = "#ff9500";
const RED    = "#ff3b30";

// ── scoreColor ────────────────────────────────────────────────────────────────

describe("scoreColor", () => {
  it("returns GREEN (#34c759) when score >= 75", () => {
    expect(scoreColor(75)).toBe(GREEN);
    expect(scoreColor(80)).toBe(GREEN);
    expect(scoreColor(100)).toBe(GREEN);
  });

  it("returns ORANGE (#ff9500) when score >= 50 and < 75", () => {
    expect(scoreColor(50)).toBe(ORANGE);
    expect(scoreColor(72)).toBe(ORANGE);
    expect(scoreColor(74)).toBe(ORANGE);
  });

  it("returns RED (#ff3b30) when score < 50", () => {
    expect(scoreColor(49)).toBe(RED);
    expect(scoreColor(20)).toBe(RED);
    expect(scoreColor(0)).toBe(RED);
  });

  it("boundary: exactly 75 is GREEN, exactly 50 is ORANGE", () => {
    expect(scoreColor(75)).toBe(GREEN);
    expect(scoreColor(50)).toBe(ORANGE);
  });
});

// ── scoreTier ─────────────────────────────────────────────────────────────────

describe("scoreTier", () => {
  it("returns 'Good' when score >= 75", () => {
    expect(scoreTier(75)).toBe("Good");
    expect(scoreTier(80)).toBe("Good");
    expect(scoreTier(100)).toBe("Good");
  });

  it("returns 'Fair' when score >= 50 and < 75", () => {
    expect(scoreTier(50)).toBe("Fair");
    expect(scoreTier(55)).toBe("Fair");
    expect(scoreTier(74)).toBe("Fair");
  });

  it("returns 'Weak' when score >= 25 and < 50", () => {
    expect(scoreTier(25)).toBe("Weak");
    expect(scoreTier(37)).toBe("Weak");
    expect(scoreTier(49)).toBe("Weak");
  });

  it("returns 'Poor' when score < 25", () => {
    expect(scoreTier(0)).toBe("Poor");
    expect(scoreTier(20)).toBe("Poor");
    expect(scoreTier(24)).toBe("Poor");
  });

  it("boundary: exactly 75 is Good, exactly 50 is Fair, exactly 25 is Weak", () => {
    expect(scoreTier(75)).toBe("Good");
    expect(scoreTier(50)).toBe("Fair");
    expect(scoreTier(25)).toBe("Weak");
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("returns 'Never' for null input", () => {
    expect(formatDate(null)).toBe("Never");
  });

  it("returns 'Never' for empty string", () => {
    expect(formatDate("")).toBe("Never");
  });

  it("formats a valid ISO date as 'Mon D, YYYY'", () => {
    // 2026-03-20T00:00:00Z → "Mar 20, 2026" (en-US locale)
    const result = formatDate("2026-03-20T00:00:00Z");
    expect(result).toMatch(/Mar\s+\d+,\s+2026/);
    expect(result).toContain("2026");
    expect(result).toContain("Mar");
  });

  it("formats a date string with no time component", () => {
    const result = formatDate("2026-01-01");
    expect(result).toContain("2026");
  });

  it("formats another known date correctly", () => {
    // 2026-03-01T00:00:00Z → "Mar 1, 2026" (en-US short month)
    const result = formatDate("2026-03-01T00:00:00Z");
    expect(result).toMatch(/Mar\s+1,\s+2026/);
  });
});
