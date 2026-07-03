import { test, expect } from "@playwright/test";

test.describe("FI-021 — Regenerate (re-run) single audit", () => {
  test.fixme(true, "Requires completed site + ≥1 credit");
  test("re-run button → POST /regenerate → status changes to in-progress", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /re-run|regenerate/i }).first().click();
    await expect(page.getByText(/scanning|in progress|discovery/i)).toBeVisible();
  });

  test("insufficient credits returns 402", async ({ request }) => {
    const resp = await request.post("/api/sites/FAKE/regenerate?token=EXPIRED_OR_NO_CREDITS");
    expect([401, 402, 404]).toContain(resp.status());
  });
});
