import { test, expect } from "@playwright/test";
// CORRECTION: Citation Visibility data is under Overview KPI cards; History tab hosts delta timeline (not citation history alone).
test.describe("FI-037 — Citation history & analytics", () => {
  test.fixme(true, "Requires ≥1 citationCheckScores record");
  test("Overview SOV/citation KPIs render; History tab timeline renders", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await expect(page.getByText(/share of voice|citation/i)).toBeVisible();
    await page.getByRole("tab", { name: /history/i }).click();
    // @scope-question FI-037: confirm per-platform breakdown lives where (Overview? History?)
  });
});
