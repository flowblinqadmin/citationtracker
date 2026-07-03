import { test, expect } from "@playwright/test";
test.describe("FI-027 — History tab (deltas timeline)", () => {
  test.fixme(true, "Requires ≥2 audits for the site (delta>0)");
  test("click History → timeline sorted newest first with deltas", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    await page.getByRole("tab", { name: /history/i }).click();
    // @scope-question FI-027: confirm delta arrow glyph + color mapping
  });
});
