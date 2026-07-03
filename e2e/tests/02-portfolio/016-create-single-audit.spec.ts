import { test, expect } from "@playwright/test";

test.describe("FI-016 — Create single-domain audit", () => {
  test.fixme(true, "Requires authenticated user with ≥1 free audit or credit");
  test("submit domain → POST /api/sites → redirect to /sites/[id]", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByLabel(/domain|url/i).fill("https://example.com");
    await page.getByRole("button", { name: /run audit|audit/i }).click();
    await expect(page).toHaveURL(/\/sites\/[a-z0-9-]+/);
  });

  test("private-IP URL blocked by SSRF guard (422/400)", async ({ request }) => {
    const resp = await request.post("/api/sites", {
      data: { url: "http://127.0.0.1", email: "adityanittoor+geotests@gmail.com" },
    });
    expect([400, 422]).toContain(resp.status());
  });
});
