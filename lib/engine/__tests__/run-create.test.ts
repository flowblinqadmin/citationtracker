import { describe, it, expect } from "vitest";
import { computeNextRunAt, currentPeriod } from "@/lib/engine/run-create";

describe("computeNextRunAt", () => {
  const now = new Date("2026-06-13T10:00:00.000Z");

  it("manual → null (never auto-runs)", () => {
    expect(computeNextRunAt("manual", now)).toBeNull();
  });
  it("weekly → +7 days (UTC)", () => {
    expect(computeNextRunAt("weekly", now)!.toISOString()).toBe("2026-06-20T10:00:00.000Z");
  });
  it("monthly → +1 calendar month (UTC)", () => {
    expect(computeNextRunAt("monthly", now)!.toISOString()).toBe("2026-07-13T10:00:00.000Z");
  });
  it("monthly rolls over the year boundary", () => {
    expect(computeNextRunAt("monthly", new Date("2026-12-15T00:00:00.000Z"))!.toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
  it("does not mutate the input date", () => {
    const d = new Date("2026-06-13T10:00:00.000Z");
    computeNextRunAt("weekly", d);
    expect(d.toISOString()).toBe("2026-06-13T10:00:00.000Z");
  });
});

describe("currentPeriod", () => {
  it("formats YYYY-MM in UTC, zero-padded", () => {
    expect(currentPeriod(new Date("2026-06-13T23:59:59.000Z"))).toBe("2026-06");
    expect(currentPeriod(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
    expect(currentPeriod(new Date("2026-12-31T12:00:00.000Z"))).toBe("2026-12");
  });
});
