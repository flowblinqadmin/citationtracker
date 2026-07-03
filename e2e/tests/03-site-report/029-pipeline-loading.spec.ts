import { test, expect } from "@playwright/test";
// HP-112: stage labels must not be renamed.
test.describe("FI-029 — Pipeline loading (in-progress)", () => {
  test.fixme(true, "Requires in-progress site (pipelineStatus ∈ discovery/crawling/…)");
  test("in-progress site shows PhaseAnimation with current stage label", async ({ page }) => {
    await page.goto("/sites/SEEDED_RUNNING_ID?token=SEEDED_TOKEN");
    await expect(page.getByText(/discover|crawl|extract|research|analyz|generat|assembl/i)).toBeVisible();
  });
});
