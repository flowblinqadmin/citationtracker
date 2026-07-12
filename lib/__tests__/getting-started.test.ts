import { describe, it, expect } from "vitest";
import {
  checklistItems,
  dismissKey,
  type ChecklistInput,
} from "@/lib/onboarding-checklist";

// Baseline: everything except the always-done "brand" row is incomplete.
const bare: ChecklistInput = {
  brandId: "brand_1",
  hasCompetitors: false,
  hasTrackedUrls: false,
  hasRuns: false,
  runFrequency: "manual",
};

describe("dismissKey", () => {
  it("derives a per-brand localStorage key", () => {
    expect(dismissKey("brand_1")).toBe("cite-gs-dismissed-brand_1");
    expect(dismissKey("abc")).toBe("cite-gs-dismissed-abc");
  });
});

describe("checklistItems", () => {
  it("returns all five rows for a fresh brand, in order", () => {
    const items = checklistItems(bare);
    expect(items.map((i) => i.key)).toEqual([
      "brand",
      "competitors",
      "tracked-urls",
      "first-run",
      "schedule",
    ]);
  });

  it("always marks the brand row done regardless of input", () => {
    const brand = checklistItems(bare).find((i) => i.key === "brand")!;
    expect(brand.done).toBe(true);
    // The always-done row has no navigation target.
    expect(brand.href).toBeUndefined();
  });

  it("marks competitors done only when competitors exist", () => {
    expect(checklistItems(bare).find((i) => i.key === "competitors")!.done).toBe(false);
    expect(
      checklistItems({ ...bare, hasCompetitors: true }).find((i) => i.key === "competitors")!.done,
    ).toBe(true);
  });

  it("marks tracked-urls done only when tracked URLs exist", () => {
    expect(checklistItems(bare).find((i) => i.key === "tracked-urls")!.done).toBe(false);
    expect(
      checklistItems({ ...bare, hasTrackedUrls: true }).find((i) => i.key === "tracked-urls")!.done,
    ).toBe(true);
  });

  it("marks first-run done only when at least one run exists", () => {
    expect(checklistItems(bare).find((i) => i.key === "first-run")!.done).toBe(false);
    expect(
      checklistItems({ ...bare, hasRuns: true }).find((i) => i.key === "first-run")!.done,
    ).toBe(true);
  });

  it("marks schedule done for any non-manual frequency, not for manual", () => {
    expect(checklistItems(bare).find((i) => i.key === "schedule")!.done).toBe(false);
    expect(
      checklistItems({ ...bare, runFrequency: "weekly" }).find((i) => i.key === "schedule")!.done,
    ).toBe(true);
    expect(
      checklistItems({ ...bare, runFrequency: "monthly" }).find((i) => i.key === "schedule")!.done,
    ).toBe(true);
  });

  it("gives every incomplete row an href to navigate to", () => {
    for (const item of checklistItems(bare)) {
      if (!item.done) expect(item.href, `${item.key} needs an href`).toBeTruthy();
    }
  });

  it("points competitors and tracked-urls at the overview tab", () => {
    const items = checklistItems(bare);
    expect(items.find((i) => i.key === "competitors")!.href).toBe("/brands/brand_1?tab=overview");
    expect(items.find((i) => i.key === "tracked-urls")!.href).toBe("/brands/brand_1?tab=overview");
  });

  it("points first-run at the prompts tab and schedule at /onboarding", () => {
    const items = checklistItems(bare);
    expect(items.find((i) => i.key === "first-run")!.href).toBe("/brands/brand_1?tab=prompts");
    expect(items.find((i) => i.key === "schedule")!.href).toBe("/onboarding");
  });

  it("returns an empty array when every item is complete (card auto-hides)", () => {
    expect(
      checklistItems({
        brandId: "brand_1",
        hasCompetitors: true,
        hasTrackedUrls: true,
        hasRuns: true,
        runFrequency: "monthly",
      }),
    ).toEqual([]);
  });

  it("still returns rows when only one item remains incomplete", () => {
    const oneLeft = checklistItems({
      brandId: "brand_1",
      hasCompetitors: true,
      hasTrackedUrls: true,
      hasRuns: true,
      runFrequency: "manual", // schedule still unset
    });
    expect(oneLeft).not.toEqual([]);
    expect(oneLeft.find((i) => i.key === "schedule")!.done).toBe(false);
  });
});
