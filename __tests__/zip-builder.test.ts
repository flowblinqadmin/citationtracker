/**
 * Unit tests for lib/services/zip-builder.ts — ES-005 Task 3
 *
 * 8 test cases covering:
 *   - buildReportZip: returns a Buffer
 *   - ZIP contains aggregate-report.html at root
 *   - ZIP contains pages/ folder with per-page HTMLs
 *   - filename sanitization (slashes → underscores, strip unsafe chars)
 *   - malformed URL fallback filename
 *   - empty perPageResults (aggregate only)
 *   - filename length cap (100 chars)
 */

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildReportZip } from "@/lib/services/zip-builder";
import type { PerPageResult } from "@/lib/services/per-page-analyzer";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSite() {
  return {
    domain: "acme.io",
    geoScorecard: {
      overallScore: 67,
      pillars: [
        { pillarName: "Structured Data", score: 42, priority: "critical" },
      ],
      topThreeImprovements: ["Add schema", "Add FAQ", "Add author"],
    },
    executiveSummary: "Acme needs improvements.",
  };
}

function makePageResult(url: string, health: PerPageResult["overallPageHealth"] = "good"): PerPageResult {
  return {
    url,
    pageType: "page",
    title: "Test Page",
    vulnerabilities: [],
    overallPageHealth: health,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildReportZip()", () => {
  it("returns a Buffer", async () => {
    const buf = await buildReportZip(makeSite(), [makePageResult("https://acme.io/")]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("ZIP contains aggregate-report.html at root", async () => {
    const buf = await buildReportZip(makeSite(), []);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.files["aggregate-report.html"]).toBeDefined();
  });

  it("ZIP contains per-page HTML in pages/ folder for each result", async () => {
    const pages = [
      makePageResult("https://acme.io/about"),
      makePageResult("https://acme.io/pricing"),
    ];
    const buf = await buildReportZip(makeSite(), pages);
    const zip = await JSZip.loadAsync(buf);

    // Filter out directory entries (keys ending with "/") — JSZip lists them separately
    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles).toHaveLength(2);
  });

  it("sanitizes URL path to safe filename (slashes → underscores, strip unsafe chars)", async () => {
    const pages = [makePageResult("https://acme.io/blog/my-post-2024")];
    const buf = await buildReportZip(makeSite(), pages);
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles).toHaveLength(1);
    // Path-derived: "blog/my-post-2024" → "blog_my-post-2024"
    expect(pageFiles[0]).toBe("pages/blog_my-post-2024.html");
  });

  it("uses 'index.html' filename for root path URL", async () => {
    const pages = [makePageResult("https://acme.io/")];
    const buf = await buildReportZip(makeSite(), pages);
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles).toHaveLength(1);
    expect(pageFiles[0]).toBe("pages/index.html");
  });

  it("handles malformed URL with fallback filename (no crash)", async () => {
    const pages = [makePageResult("not-a-valid-url")];
    const buf = await buildReportZip(makeSite(), pages);
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    expect(pageFiles).toHaveLength(1);
    expect(pageFiles[0]).toMatch(/^pages\/page-/); // fallback prefix
  });

  it("caps filename at 100 characters (excluding extension)", async () => {
    const longPath = "a".repeat(200);
    const pages = [makePageResult(`https://acme.io/${longPath}`)];
    const buf = await buildReportZip(makeSite(), pages);
    const zip = await JSZip.loadAsync(buf);

    const pageFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("pages/") && !f.endsWith("/")
    );
    // "pages/" (6) + filename up to 100 chars + ".html" (5)
    expect(pageFiles[0].length).toBeLessThanOrEqual(6 + 100 + 5);
  });

  it("returns a compressed buffer (DEFLATE compression reduces size vs uncompressed)", async () => {
    // 50 identical pages — compression should make it much smaller than raw HTML
    const pages = Array.from({ length: 50 }, (_, i) =>
      makePageResult(`https://acme.io/page${i}`)
    );
    const buf = await buildReportZip(makeSite(), pages);
    // 50 pages × ~5KB = ~250KB uncompressed; compressed should be <100KB
    expect(buf.length).toBeLessThan(100_000);
  });
});
