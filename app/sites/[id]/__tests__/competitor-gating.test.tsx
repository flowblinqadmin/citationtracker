/**
 * Phase 7B — Competitor Gating Tests
 *
 * Unit tests for competitor visibility gating logic.
 */

import { describe, it, expect } from "vitest";

function getVisibleCompetitors<T>(data: T[], max: number) {
  return { visible: data.slice(0, max), hidden: Math.max(0, data.length - max) };
}

describe("competitor visibility gating", () => {
  const competitors = [
    { name: "A", shareOfVoice: 50 },
    { name: "B", shareOfVoice: 40 },
    { name: "C", shareOfVoice: 30 },
    { name: "D", shareOfVoice: 20 },
    { name: "E", shareOfVoice: 10 },
  ];

  it("starter (max 2) shows 2 competitors", () => {
    const { visible, hidden } = getVisibleCompetitors(competitors, 2);
    expect(visible).toHaveLength(2);
    expect(hidden).toBe(3);
  });

  it("growth (max 5) shows all 5 when exactly 5", () => {
    const { visible, hidden } = getVisibleCompetitors(competitors, 5);
    expect(visible).toHaveLength(5);
    expect(hidden).toBe(0);
  });

  it("free (max 0) shows no competitors", () => {
    const { visible, hidden } = getVisibleCompetitors(competitors, 0);
    expect(visible).toHaveLength(0);
    expect(hidden).toBe(5);
  });

  it("pro (max 10) shows all when fewer than 10", () => {
    const { visible, hidden } = getVisibleCompetitors(competitors, 10);
    expect(visible).toHaveLength(5);
    expect(hidden).toBe(0);
  });
});
