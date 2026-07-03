import { test, expect } from "@playwright/test";
import path from "node:path";
test.describe("FI-051 — Bulk audit POST /api/sites", () => {
  test.fixme(true, "Requires authenticated paid user with credits");
  test("submit bulk → N rows added to dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /bulk|csv/i }).click();
    await page.setInputFiles("input[type=file]", path.resolve(__dirname, "../../fixtures/csv/sample-5-ecom.csv"));
    await page.getByRole("button", { name: /audit.*url|submit/i }).click();
    await expect(page.getByRole("row")).toHaveCount(6, { timeout: 15_000 }); // 5 + header
  });

  test(">501 URLs rejected with 400", async ({ request }) => {
    const urls = Array.from({ length: 502 }, (_, i) => `https://domain${i}.example.com`);
    const resp = await request.post("/api/sites", {
      data: { email: "adityanittoor+geotests@gmail.com", bulkUrls: urls },
    });
    expect(resp.status()).toBe(400);
  });
});
