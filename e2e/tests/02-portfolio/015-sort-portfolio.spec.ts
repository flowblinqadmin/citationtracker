import { test, expect } from "@playwright/test";

test.describe("FI-015 — Sort portfolio table", () => {
  test.fixme(true, "Requires ≥2 domains with sortable values");
  test("click Domain header sorts A→Z; click again Z→A", async ({ page }) => {
    await page.goto("/dashboard");
    const header = page.getByRole("columnheader", { name: /domain/i });
    await header.click();
    // @scope-question FI-015: confirm aria-sort attribute or sort arrow glyph
    await header.click();
  });
});
