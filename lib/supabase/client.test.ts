/**
 * Tests for createProxyFetch — ES-007
 *
 * Suite 5: createProxyFetch intercept logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProxyFetch } from "./client";

const SUPABASE_URL = "https://test.supabase.co";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Suite 5: createProxyFetch intercept logic", () => {
  it("intercepts auth URL and calls proxy path", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(`${SUPABASE_URL}/auth/v1/user`);

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/proxy/user", undefined);
  });

  it("intercepts token endpoint with query string", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/proxy/token?grant_type=refresh_token",
      undefined
    );
  });

  it("does not intercept REST calls", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(`${SUPABASE_URL}/rest/v1/geo_sites`);

    expect(fetchMock).toHaveBeenCalledWith(`${SUPABASE_URL}/rest/v1/geo_sites`, undefined);
  });

  it("does not intercept realtime calls", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(`${SUPABASE_URL}/realtime/v1/websocket`);

    expect(fetchMock).toHaveBeenCalledWith(`${SUPABASE_URL}/realtime/v1/websocket`, undefined);
  });

  it("does not intercept a different Supabase instance", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    const otherUrl = "https://other.supabase.co/auth/v1/user";
    await proxyFetch(otherUrl);

    expect(fetchMock).toHaveBeenCalledWith(otherUrl, undefined);
  });

  it("passes init options through unchanged on proxied calls", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: "Bearer jwt" },
      body: JSON.stringify({ key: "value" }),
    };
    await proxyFetch(`${SUPABASE_URL}/auth/v1/user`, init);

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/proxy/user", init);
  });

  it("handles URL object input", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(new URL(`${SUPABASE_URL}/auth/v1/user`));

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/proxy/user", undefined);
  });

  it("handles Request object input", async () => {
    const proxyFetch = createProxyFetch(SUPABASE_URL);
    await proxyFetch(new Request(`${SUPABASE_URL}/auth/v1/user`));

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/proxy/user", undefined);
  });
});
