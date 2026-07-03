/**
 * ES-083 ScriptDev Phase 1 unit tests for lib/services/auto-discover-brand-pages.ts
 *
 * Coverage:
 *   - canonicalizeUrl 5-step normalization (AC-4 — IDENTICAL to ES-085 AC-3)
 *   - detectInputOrigin (AC-1)
 *   - probeUrl: GET semantics, Range header, redirect chain, hop limit (AC-3)
 *   - autoDiscoverBrandPages: dedup, cap, fail-soft (AC-1, AC-5, AC-11)
 *
 * Phase 1 (Mandatory orchestration rule). RM Phase A may extend this surface
 * with rotated fixtures + additional coverage in their pass.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalizeUrl,
  detectInputOrigin,
  probeUrl,
  autoDiscoverBrandPages,
} from "@/lib/services/auto-discover-brand-pages";

// ─── canonicalizeUrl (AC-4) ──────────────────────────────────────────────────

describe("canonicalizeUrl — 5-step normalization (AC-4)", () => {
  it("U1: homepage `/` is preserved as-is", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("U2: trailing slash stripped on non-root paths", () => {
    expect(canonicalizeUrl("https://www.example.com/about-us/")).toBe("https://www.example.com/about-us");
  });

  it("U3: query string dropped", () => {
    expect(canonicalizeUrl("https://example.com/about-us?utm_source=email")).toBe("https://example.com/about-us");
  });

  it("U4: fragment dropped", () => {
    expect(canonicalizeUrl("https://example.com/contact#form")).toBe("https://example.com/contact");
  });

  it("U5: index.html collapsed to /", () => {
    expect(canonicalizeUrl("https://example.com/about/index.html")).toBe("https://example.com/about");
  });

  it("U5b: index.htm collapsed to /", () => {
    expect(canonicalizeUrl("https://example.com/services/index.htm")).toBe("https://example.com/services");
  });

  it("U6: double-slash collapsed", () => {
    expect(canonicalizeUrl("https://example.com//about-us//")).toBe("https://example.com/about-us");
  });

  it("U7: origin lowercased", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/About-Us/")).toBe("https://example.com/about-us");
  });

  it("U7b: combined query + fragment + trailing slash", () => {
    expect(canonicalizeUrl("https://example.com/about-us/?utm=launch#leadership"))
      .toBe("https://example.com/about-us");
  });
});

// ─── detectInputOrigin (AC-1) ────────────────────────────────────────────────

describe("detectInputOrigin (AC-1)", () => {
  it("U8: returns lowercased origin from first valid URL", () => {
    expect(detectInputOrigin([
      "https://manipalhospitals.com/bangalore/",
      "https://other.com/page",
    ])).toBe("https://manipalhospitals.com");
  });

  it("U9: skips invalid URLs and returns first parseable origin", () => {
    expect(detectInputOrigin(["not-a-url", "https://valid.com/page"])).toBe("https://valid.com");
  });

  it("U10: returns null when all URLs invalid", () => {
    expect(detectInputOrigin(["not-a-url", "also-not-a-url"])).toBeNull();
  });

  it("U11: returns null on empty input", () => {
    expect(detectInputOrigin([])).toBeNull();
  });

  it("U12: lowercases mixed-case origin", () => {
    expect(detectInputOrigin(["https://EXAMPLE.com/page"])).toBe("https://example.com");
  });
});

// ─── probeUrl (AC-3) ─────────────────────────────────────────────────────────

describe("probeUrl (AC-3 — GET + Range + redirect chain)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(impl: (url: string) => Promise<Response>) {
    global.fetch = vi.fn(impl) as unknown as typeof fetch;
  }

  function mkRes(status: number, location?: string): Response {
    const headers = new Headers();
    if (location) headers.set("location", location);
    return new Response(null, { status, headers });
  }

  it("U13: 200 → returns the URL", async () => {
    mockFetch(async () => mkRes(200));
    expect(await probeUrl("https://example.com/about-us")).toBe("https://example.com/about-us");
  });

  it("U14: 206 Partial Content → returns the URL", async () => {
    mockFetch(async () => mkRes(206));
    expect(await probeUrl("https://example.com/about-us")).toBe("https://example.com/about-us");
  });

  it("U15: 404 → returns null", async () => {
    mockFetch(async () => mkRes(404));
    expect(await probeUrl("https://example.com/missing")).toBeNull();
  });

  it("U16: 500 → returns null", async () => {
    mockFetch(async () => mkRes(500));
    expect(await probeUrl("https://example.com/oops")).toBeNull();
  });

  it("U17: 405 → returns null (HEAD-rejecting server fallback)", async () => {
    mockFetch(async () => mkRes(405));
    expect(await probeUrl("https://example.com/strict")).toBeNull();
  });

  it("U18: 301 → 200 single hop → final URL returned", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls === 1) return mkRes(301, "/about-us/");
      return mkRes(200);
    });
    const result = await probeUrl("https://example.com/about");
    expect(result).toBe("https://example.com/about-us/");
  });

  it("U19: redirect loop → null at hop limit", async () => {
    mockFetch(async () => mkRes(301, "/loop"));
    expect(await probeUrl("https://example.com/loop")).toBeNull();
  });

  it("U20: 5-hop chain ending in 200 → returns final URL", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls < 5) return mkRes(302, `/hop-${calls}`);
      return mkRes(200);
    });
    const result = await probeUrl("https://example.com/start");
    expect(result).toContain("/hop-");
  });

  it("U21: network error → null", async () => {
    mockFetch(async () => { throw new Error("ECONNRESET"); });
    expect(await probeUrl("https://example.com/down")).toBeNull();
  });

  it("U22: sends GET method (NOT HEAD) per HP-173", async () => {
    const captured: { method?: string; headers?: Headers } = {};
    global.fetch = vi.fn(async (_url: string, opts?: RequestInit) => {
      captured.method = opts?.method;
      captured.headers = new Headers(opts?.headers);
      return mkRes(200);
    }) as unknown as typeof fetch;
    await probeUrl("https://example.com/about-us");
    expect(captured.method).toBe("GET");
  });

  it("U23: sends Range: bytes=0-0 header", async () => {
    const captured: { rangeHeader?: string | null } = {};
    global.fetch = vi.fn(async (_url: string, opts?: RequestInit) => {
      const h = new Headers(opts?.headers);
      captured.rangeHeader = h.get("Range");
      return mkRes(200);
    }) as unknown as typeof fetch;
    await probeUrl("https://example.com/about-us");
    expect(captured.rangeHeader).toBe("bytes=0-0");
  });
});

// ─── autoDiscoverBrandPages (AC-1, AC-5, AC-11) ──────────────────────────────

describe("autoDiscoverBrandPages (AC-1, AC-5, AC-11)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  function mockAllProbes(status: number) {
    global.fetch = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
  }

  it("U24: empty bulkUrls → returns []", async () => {
    expect(await autoDiscoverBrandPages([])).toEqual([]);
  });

  it("U25: all-invalid bulkUrls → returns []", async () => {
    expect(await autoDiscoverBrandPages(["not-a-url"])).toEqual([]);
  });

  it("U26: all probes 404 → returns []", async () => {
    mockAllProbes(404);
    const result = await autoDiscoverBrandPages(["https://example.com/page-1"]);
    expect(result).toEqual([]);
  });

  it("U27: all probes 200 → returns capped at MAX_AUTO_DISCOVERED (12)", async () => {
    mockAllProbes(200);
    const result = await autoDiscoverBrandPages(["https://example.com/page-1"]);
    // Cap is 12; PROBE_PATTERNS has more, but dedup-via-canonicalize collapses
    // trailing-slash variants of the same path. The cap floor is 12 only when
    // the patterns are unique post-canonicalization.
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.length).toBeGreaterThan(0);
  });

  it("U28: dedupes against customer input via canonicalization", async () => {
    mockAllProbes(200);
    // Customer already has homepage in their list
    const result = await autoDiscoverBrandPages(["https://example.com/"]);
    // Homepage should NOT be in the discovered list (deduped)
    expect(result.some((u) => u === "https://example.com/")).toBe(false);
  });

  it("U29: dedupes within probe results (collapses trailing-slash variants)", async () => {
    mockAllProbes(200);
    const result = await autoDiscoverBrandPages(["https://example.com/page-1"]);
    // For each unique canonical, we expect at most one entry
    const canonicals = new Set(result.map(canonicalizeUrl));
    expect(canonicals.size).toBe(result.length);
  });

  it("U30: fail-soft on probe throw — returns [] not throws", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const result = await autoDiscoverBrandPages(["https://example.com/page-1"]);
    expect(result).toEqual([]);
  });
});
