/**
 * Phase 6A — Crawl Frequency Gating Tests
 *
 * Tests the helper function that returns available crawl frequency options
 * per subscription tier.
 */

import { describe, it, expect } from "vitest";

// ── Helper under test ──────────────────────────────────────────────────────────
// Extracted from ResultsDashboardLegacy.tsx crawl frequency select logic

export type FrequencyOption = "manual" | "monthly" | "weekly" | "daily";

export function getAvailableFrequencies(tier: string): FrequencyOption[] {
  const base: FrequencyOption[] = ["manual"];
  if (tier === "free") return base;
  // starter and above get monthly + weekly
  base.push("monthly");
  base.push("weekly");
  // growth and pro get daily
  if (tier === "growth" || tier === "pro") {
    base.push("daily");
  }
  return base;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getAvailableFrequencies — crawl tier gating", () => {
  it("free tier: only 'manual' option present; no Monthly/Weekly/Daily", () => {
    const opts = getAvailableFrequencies("free");
    expect(opts).toContain("manual");
    expect(opts).not.toContain("monthly");
    expect(opts).not.toContain("weekly");
    expect(opts).not.toContain("daily");
  });

  it("starter tier: Manual + Monthly + Weekly present; Daily absent", () => {
    const opts = getAvailableFrequencies("starter");
    expect(opts).toContain("manual");
    expect(opts).toContain("monthly");
    expect(opts).toContain("weekly");
    expect(opts).not.toContain("daily");
  });

  it("growth tier: Manual + Monthly + Weekly + Daily all present", () => {
    const opts = getAvailableFrequencies("growth");
    expect(opts).toContain("manual");
    expect(opts).toContain("monthly");
    expect(opts).toContain("weekly");
    expect(opts).toContain("daily");
  });

  it("pro tier: same as growth — all four options present", () => {
    const opts = getAvailableFrequencies("pro");
    expect(opts).toContain("manual");
    expect(opts).toContain("monthly");
    expect(opts).toContain("weekly");
    expect(opts).toContain("daily");
  });
});
