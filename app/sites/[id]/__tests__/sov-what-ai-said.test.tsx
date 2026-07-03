/**
 * Phase 9A — "What AI actually said" panel logic tests
 */

import { describe, it, expect } from "vitest";

// Unit test for the "What AI actually said" panel visibility logic
describe("What AI actually said panel logic", () => {
  function hasAnySamples(providerResults: Array<{ samples?: Array<unknown> }>): boolean {
    return providerResults.some(p => (p.samples?.length ?? 0) > 0);
  }

  it("returns true when any provider has samples", () => {
    const results = [
      { provider: "openai", samples: [{ question: "q1", answer: "a1" }] },
    ];
    expect(hasAnySamples(results)).toBe(true);
  });

  it("returns false when no providers have samples", () => {
    const results = [{ provider: "openai", samples: [] }];
    expect(hasAnySamples(results)).toBe(false);
  });

  it("returns false when providerResults is empty", () => {
    expect(hasAnySamples([])).toBe(false);
  });
});
