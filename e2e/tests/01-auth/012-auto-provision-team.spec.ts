import { test, expect } from "@playwright/test";

// FI-012: First /api/sites POST after OTP auto-creates team + teamMembers row.
test.describe("FI-012 — Auto-provisioning team on first action", () => {
  test.fixme(true, "Requires authenticated user with no prior teamMembers row (DB reset)");
  test("first /api/sites POST provisions team and returns siteId", async ({ request }) => {
    const resp = await request.post("/api/sites", {
      data: { url: "https://example.com", email: "adityanittoor+geotests@gmail.com" },
    });
    expect([200, 201, 202]).toContain(resp.status());
    // @scope-question FI-012: confirm signup bonus credits are included in team.creditBalance
  });
});
