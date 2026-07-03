import { test, expect } from "@playwright/test";

// FI-011: /api/teams/me returns team membership with creditBalance.
test.describe("FI-011 — Team membership lookup", () => {
  test.fixme(true, "Requires authenticated fetch with session cookie");
  test("GET /api/teams/me returns team with creditBalance", async ({ request }) => {
    const resp = await request.get("/api/teams/me");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty("team");
    expect(body.team).toHaveProperty("creditBalance");
  });
});
