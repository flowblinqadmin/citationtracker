// POST /api/brands/suggest — auto-population backend.
// Auth via getTeamContext (401), zod domain validation (400), per-team rate
// limit (429), and provider degradation (always 200 with empty payload, never 5xx).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Identity arrives via middleware-stamped headers; mock the header store.
const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headerStore.get(k.toLowerCase()) ?? null }),
}));

// Mock the team context (route copies the brands route pattern).
const getTeamContextMock = vi.fn();
vi.mock("@/lib/team", () => ({
  getTeamContext: () => getTeamContextMock(),
}));

// Mock the rate limiter — default allow.
const checkRateLimitMock = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

// Mock the suggestion engine — the route must never call real providers.
const fetchBrandSuggestionsMock = vi.fn();
vi.mock("@/lib/suggest", () => ({
  fetchBrandSuggestions: (...args: unknown[]) => fetchBrandSuggestionsMock(...args),
}));

import { POST } from "@/app/api/brands/suggest/route";

const post = (body: unknown) =>
  POST(
    new NextRequest("http://x/api/brands/suggest", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );

beforeEach(() => {
  getTeamContextMock.mockReset();
  checkRateLimitMock.mockReset();
  fetchBrandSuggestionsMock.mockReset();
  getTeamContextMock.mockResolvedValue({ teamId: "tm_1", teamName: "T", userId: "u", email: null, creditBalance: 0 });
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: Date.now() + 1000 });
  fetchBrandSuggestionsMock.mockResolvedValue({
    name: "Acme",
    competitors: [{ name: "Globex", domain: "globex.com" }],
    prompts: ["best widgets"],
  });
});

describe("POST /api/brands/suggest", () => {
  it("200 with the suggestion payload on the happy path (normalized domain passed through)", async () => {
    const res = await post({ domain: "https://www.Acme.com/about" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      name: "Acme",
      competitors: [{ name: "Globex", domain: "globex.com" }],
      prompts: ["best widgets"],
    });
    // domain normalized before handing to the engine
    expect(fetchBrandSuggestionsMock).toHaveBeenCalledWith("acme.com");
  });

  it("200 with a degraded payload when the engine returns empties", async () => {
    fetchBrandSuggestionsMock.mockResolvedValueOnce({ name: null, competitors: [], prompts: [] });
    const res = await post({ domain: "acme.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null, competitors: [], prompts: [] });
  });

  it("200 (not 5xx) when the engine THROWS — route catches and degrades", async () => {
    fetchBrandSuggestionsMock.mockRejectedValueOnce(new Error("provider exploded"));
    const res = await post({ domain: "acme.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: null, competitors: [], prompts: [] });
  });

  it("400 on an invalid / missing domain", async () => {
    const bad = await post({ domain: "not a domain!!!" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid domain");

    const missing = await post({});
    expect(missing.status).toBe(400);

    // No engine call on a bad request.
    expect(fetchBrandSuggestionsMock).not.toHaveBeenCalled();
    // Validation runs BEFORE the rate limiter — a malformed request must not
    // burn a team's hourly suggest budget.
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("401 when there is no team for the user", async () => {
    getTeamContextMock.mockResolvedValueOnce(null);
    const res = await post({ domain: "acme.com" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("No team for this user");
    expect(fetchBrandSuggestionsMock).not.toHaveBeenCalled();
    // Auth runs BEFORE the rate limiter — an unauthenticated caller can't touch
    // (or exhaust) the per-team rate-limit key.
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("429 when the per-team rate limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 1000 });
    const res = await post({ domain: "acme.com" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Rate limit exceeded — try again later");
    expect(fetchBrandSuggestionsMock).not.toHaveBeenCalled();
  });

  it("rate-limits on the cite-suggest key scoped to the team (10/hour)", async () => {
    await post({ domain: "acme.com" });
    expect(checkRateLimitMock).toHaveBeenCalledWith("cite-suggest:tm_1", 10, 3600000);
  });
});
