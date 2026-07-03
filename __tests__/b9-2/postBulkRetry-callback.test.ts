/**
 * ES-B9.2 AC-B9.2-5/6 — postBulkRetry helper callback contract.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { postBulkRetry } from "@/app/sites/[id]/_helpers/bulk-retry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("postBulkRetry — onSourceRowOptimisticUpdate callback (AC-B9.2-5/6)", () => {
  it("fires callback exactly once on 2xx success (201)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ siteId: "new-1", accessToken: "tok-new" }),
    });
    const cb = vi.fn();
    const res = await postBulkRetry({
      siteId: "site-x",
      accessToken: "tok-abc",
      target: "retry-failed",
      onSourceRowOptimisticUpdate: cb,
    });
    expect(cb).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    expect(res.newSiteId).toBe("new-1");
    expect(res.newAccessToken).toBe("tok-new");
  });

  it("fires callback on 202 (regenerate bulk-aware success)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ siteId: "regen-1" }),
    });
    const cb = vi.fn();
    await postBulkRetry({
      siteId: "site-x",
      accessToken: "tok-abc",
      target: "regenerate",
      onSourceRowOptimisticUpdate: cb,
    });
    expect(cb).toHaveBeenCalledOnce();
  });

  it("does NOT fire callback on 4xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Original URL list missing — please re-upload via the landing page" }),
    });
    const cb = vi.fn();
    const res = await postBulkRetry({
      siteId: "site-x",
      accessToken: "tok-abc",
      target: "regenerate",
      onSourceRowOptimisticUpdate: cb,
    });
    expect(cb).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/Original URL list missing/);
    expect(res.newSiteId).toBeNull();
  });

  it("does NOT fire callback on 5xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "Failed to start re-audit. Please try again." }),
    });
    const cb = vi.fn();
    const res = await postBulkRetry({
      siteId: "site-x",
      accessToken: "tok-abc",
      target: "regenerate",
      onSourceRowOptimisticUpdate: cb,
    });
    expect(cb).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it("network error → ok:false + does NOT fire callback", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const cb = vi.fn();
    const res = await postBulkRetry({
      siteId: "site-x",
      accessToken: "tok-abc",
      target: "retry-failed",
      onSourceRowOptimisticUpdate: cb,
    });
    expect(cb).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("targets the correct URL based on target arg", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ siteId: "x" }) });
    await postBulkRetry({ siteId: "s1", accessToken: "t", target: "retry-failed" });
    expect(mockFetch.mock.calls[0][0]).toBe("/api/sites/s1/retry-failed");

    mockFetch.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ siteId: "y" }) });
    await postBulkRetry({ siteId: "s2", accessToken: "t", target: "regenerate" });
    expect(mockFetch.mock.calls[1][0]).toBe("/api/sites/s2/regenerate");
  });

  it("sends Bearer auth header + JSON body with optional urls", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) });
    await postBulkRetry({
      siteId: "s",
      accessToken: "tok",
      target: "retry-failed",
      urls: ["https://a.com", "https://b.com"],
    });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.body).toBe(JSON.stringify({ urls: ["https://a.com", "https://b.com"] }));
  });

  it("body is '{}' when urls omitted", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) });
    await postBulkRetry({ siteId: "s", accessToken: "tok", target: "regenerate" });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe("{}");
  });
});
