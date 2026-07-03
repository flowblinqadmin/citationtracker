import { test, expect } from "@playwright/test";
test.describe("FI-040 — Block/unblock competitor", () => {
  test.fixme(true, "Requires ≥1 competitor");
  test("click X → blocklist updated → row removed", async ({ page }) => {
    await page.goto("/sites/SEEDED_ID?token=SEEDED_TOKEN");
    const firstComp = page.getByTestId("competitor-row").first();
    const name = await firstComp.textContent();
    await firstComp.getByRole("button", { name: /remove|block|x/i }).click();
    await expect(page.getByText(name ?? "")).toHaveCount(0);
  });
});
