import { test, expect } from "@playwright/test";
test.describe("FI-055 — Bulk vs single rate limits", () => {
  test.fixme(true, "Requires free-tier user for 402 assertion");
  test("free-tier bulk POST → 402 (pro required)", async ({ request }) => {
    const resp = await request.post("/api/sites", {
      data: {
        email: "adityanittoor+geotests@gmail.com",
        bulkUrls: ["https://a.example.com", "https://b.example.com"],
      },
    });
    expect([402, 403]).toContain(resp.status());
  });
});
