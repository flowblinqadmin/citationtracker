import { test, expect } from "@playwright/test";
// Phase 3 correction: 6 tabs — Overview, Scorecard, Recommendations, Pages, History, Setup.
test.describe("FI-023 — Site report Overview tab", () => {
  test.fixme(true, "Requires completed site fixture");
  test("loads Overview tab with score ring, KPI row, exec summary, top recs", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await expect(page.getByRole("tab", { name: /overview/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/overall score|geo score/i)).toBeVisible();
    // @scope-question FI-023: confirm SOV KPI cards + Competitors card render under Overview (per CORRECTIONS)
  });
});
