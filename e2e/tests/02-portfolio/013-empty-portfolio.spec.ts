import { test, expect } from "@playwright/test";

test.describe("FI-013 — Empty portfolio view", () => {
  test.fixme(true, "Requires authenticated user with 0 teamDomains");
  test("0 audits → KPI zeros + empty state + audit form visible", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText(/no audits yet|get started/i)).toBeVisible();
    await expect(page.getByLabel(/domain|url/i)).toBeVisible();
  });
});
